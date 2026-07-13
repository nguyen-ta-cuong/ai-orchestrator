import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_CONFIG, loadConfigWithProvenance, loopConfigFrom, type ConfigProvenance, type OrchestratorConfig, type RoleConfig } from "../src/core/config.js";
import { createPiRoutingPlan } from "../src/adapters/piCapabilityRouting.js";
import { enforceRoutingBudget, type RoutingBudgetSnapshot, type RoutingCostEstimate } from "../src/core/routingBudget.js";
import type { ModelSelectionIdentity, RoutingStage } from "../src/core/modelRouting.js";
import { coderPrompt, judgePrompt, plannerPrompt, replanPrompt } from "../src/core/prompts.js";
import { detectTestCommand } from "../src/core/tests.js";
import { createIdleState, nextPhase, type OrchestratorState, type Verdict } from "../src/core/loop.js";
import { currentRun, readState } from "../src/lifecycle/artifacts.js";
import { isReadOnlyLifecycleCommand } from "../src/lifecycle/readOnlyPolicy.js";

const STATE_TYPE = "ai-orchestrator";
const STATUS_KEY = "ai-orchestrator";
const WIDGET_KEY = "ai-orchestrator";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const JUDGE_TOOLS = [...READ_ONLY_TOOLS, "judge_verdict"];
const MUTATION_TOOLS = new Set(["edit", "write"]);
const PUBLICATION_COMMAND = /(?:^|[\s;&|])(?:git\s+(?:add|commit|push|tag)|gh\s+pr\s+create|(?:npm|pnpm|yarn)\s+publish)(?:\s|$)/i;

interface JudgeVerdictParams {
  verdict: Verdict;
  reasons: string;
  requiredFixes?: string;
}

interface RuntimeState extends OrchestratorState {
  runId?: string;
  cwd?: string;
  pendingVerdict?: JudgeVerdictParams;
  judgeReminderSent?: boolean;
  plannerReminderSent?: boolean;
  latestJudgeFeedback?: string;
  toolsBeforeRun?: string[];
  toolsBeforeJudge?: string[];
  modelSelections?: Array<{
    stage: "plan" | "build" | "fast-judge";
    provider: string;
    model: string;
    family?: string;
    thinking: OrchestratorConfig["roles"]["coder"]["thinking"];
    reason: string;
    engine: OrchestratorConfig["routing"]["engine"];
    policyVersion: string;
    taskFeaturesHash: string;
    fallbackCount: number;
    estimatedCostUsd?: number;
  }>;
}

interface RuntimeConfig {
  config: OrchestratorConfig;
  provenance: ConfigProvenance;
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
  let state: RuntimeState = createRuntimeState();
  let runtime: RuntimeConfig | undefined;
  let pendingSettlement: { runId?: string; messages: unknown[] } | undefined;
  let stopping = false;

  pi.registerFlag("orchestrate-yolo", {
    description: "Skip the plan approval gate for /orchestrate runs",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: "judge_verdict",
    label: "Judge Verdict",
    description: "Return the final structured verdict for an orchestrator judge phase.",
    promptSnippet: "Return an approve/reject verdict for the orchestrator judge phase",
    promptGuidelines: [
      "Use judge_verdict exactly once as the final action during an ai-orchestrator judge phase.",
      "After calling judge_verdict, do not emit another assistant response in the same turn.",
    ],
    parameters: Type.Object({
      verdict: StringEnum(["approve", "reject"] as const),
      reasons: Type.String({ description: "Concrete review findings supporting the verdict" }),
      requiredFixes: Type.Optional(Type.String({ description: "Required changes when rejecting" })),
    }),
    async execute(_toolCallId, params) {
      if (state.phase !== "judging") {
        throw new Error("judge_verdict is only valid during an ai-orchestrator judging phase");
      }

      state = {
        ...state,
        pendingVerdict: {
          verdict: params.verdict,
          reasons: params.reasons,
          requiredFixes: params.requiredFixes,
        },
      };
      persist();

      return {
        content: [{ type: "text", text: `Recorded judge verdict: ${params.verdict}` }],
        details: state.pendingVerdict,
        terminate: true,
      };
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Run a Plan → Code → Judge orchestration for a task",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await startRun(args, ctx);
    },
  });

  pi.registerCommand("orchestrate-stop", {
    description: "Stop the current orchestration and restore the original model",
    handler: async (_args, ctx) => {
      if (state.phase === "idle") {
        notifyUser(ctx, "No ai-orchestrator run is active.", "info");
        return;
      }
      await stopRun(ctx, "ai-orchestrator run stopped by user.");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    let latest = latestPersistedState(ctx);
    if (!latest) {
      if (isActiveRunPhase(state.phase) || isRestorePending(state)) {
        if (isRestorePending(state)) {
          await restorePendingSessionState(ctx, state);
        } else {
          deactivateJudgeVerdictTool();
        }
        state = createRuntimeState();
        runtime = undefined;
        persist();
        notifyUser(ctx, "Previous ai-orchestrator run belonged to another session; original model restored and state reset.", "warning");
      } else {
        deactivateJudgeVerdictTool();
      }
      updateUi(ctx);
      return;
    }

    if (isRestorePending(latest)) {
      latest = await restorePendingSessionState(ctx, latest);
    }

    if (isActiveRunPhase(latest.phase)) {
      state = createRuntimeState();
      persist();
      notifyUser(ctx, "Previous ai-orchestrator run was interrupted; state reset.", "warning");
    } else {
      state = latest.phase === "idle" ? latest : createRuntimeState();
    }
    deactivateJudgeVerdictTool();
    updateUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isActiveRunPhase(state.phase) && !isRestorePending(state)) {
      deactivateJudgeVerdictTool();
      clearUi(ctx);
      return;
    }

    if (isRestorePending(state)) {
      await restorePendingSessionState(ctx, state);
    } else {
      deactivateJudgeVerdictTool();
    }
    clearUi(ctx);
    state = createRuntimeState();
    runtime = undefined;
    persist();
  });

  pi.on("tool_call", async (event) => {
    const readOnlyPhase = state.phase === "planning" || state.phase === "replanning" || state.phase === "judging";
    if (readOnlyPhase && MUTATION_TOOLS.has(event.toolName)) {
      return { block: true, reason: `ai-orchestrator ${state.phase} phase is read-only; edit/write are blocked.` };
    }
    if (readOnlyPhase && event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      const testCommand = state.phase === "judging" && state.cwd && (runtime?.config.judge.runTests ?? true)
        ? detectTestCommand(state.cwd)
        : undefined;
      if (typeof command !== "string" || !isReadOnlyLifecycleCommand(command, testCommand)) {
        return { block: true, reason: `ai-orchestrator ${state.phase} phase blocked a non-read-only bash command.` };
      }
    }
    if (state.phase === "coding" && event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string" || PUBLICATION_COMMAND.test(command)) {
        return { block: true, reason: "ai-orchestrator coding cannot stage, commit, tag, push, open a PR, or publish; those actions require orchestrator-owned gates." };
      }
    }
  });

  pi.on("agent_end", async (event) => {
    if (isActiveRunPhase(state.phase)) {
      pendingSettlement = { runId: state.runId, messages: event.messages };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingSettlement || pendingSettlement.runId !== state.runId) return;
    const { messages } = pendingSettlement;
    pendingSettlement = undefined;
    try {
      if (isActiveRunPhase(state.phase)) {
        const stopReason = lastAssistantStopReason(messages);
        if (stopReason === "aborted") {
          await stopRun(ctx, "ai-orchestrator run was aborted by user; original model restored.");
          return;
        }
        if (stopReason === "error") {
          await stopRun(ctx, "ai-orchestrator run stopped because the phase ended with a model/provider error.");
          return;
        }
      }

      if (state.phase === "planning" || state.phase === "replanning") {
        await handlePlanProduced(ctx, extractLastAssistantText(messages));
        return;
      }

      if (state.phase === "coding") {
        await handleCodeProduced(ctx);
        return;
      }

      if (state.phase === "judging") {
        await handleJudgingEnded(ctx);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stopRun(ctx, `ai-orchestrator stopped after an internal error: ${message}`);
    }
  });

  async function startRun(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed") {
      notifyUser(ctx, "An ai-orchestrator run is already active. Use /orchestrate-stop first.", "error");
      return;
    }

    const parsed = parseCommandArgs(args);
    if (parsed.warning) {
      notifyUser(ctx, parsed.warning, "warning");
    }
    if (!parsed.task) {
      notifyUser(ctx, "Usage: /orchestrate [--yolo] <task>", "error");
      return;
    }

    let config: OrchestratorConfig;
    let provenance: ConfigProvenance;
    try {
      const resolved = loadPiResolvedConfig(ctx.cwd);
      config = resolved.config;
      provenance = resolved.provenance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyUser(ctx, `Invalid ai-orchestrator config: ${message}`, "error");
      return;
    }
    const lifecycle = currentRun(ctx.cwd, config.lifecycle.artifactsDir);
    const lifecycleState = lifecycle && readState(lifecycle.paths);
    if (lifecycleState && isActiveLifecyclePhase(lifecycleState.phase)) {
      notifyUser(ctx, `Lifecycle run ${lifecycleState.runId} is active at ${lifecycleState.phase}. Use /lifecycle-stop before /orchestrate.`, "error");
      return;
    }

    runtime = { config, provenance };

    const missingRole = config.routing.engine === "capability" ? undefined : findMissingRole(ctx, config);
    if (missingRole) {
      notifyUser(ctx, missingRole, "error");
      runtime = undefined;
      return;
    }

    const yolo = parsed.yolo || pi.getFlag("orchestrate-yolo") === true;
    const currentThinking = pi.getThinkingLevel();
    state = {
      ...(nextPhase(createIdleState(), { type: "start", task: parsed.task, yolo }, loopConfigFrom(config)) as RuntimeState),
      runId: createRunId(),
      cwd: ctx.cwd,
      originalModel: ctx.model
        ? { provider: String(ctx.model.provider), id: String(ctx.model.id), thinking: currentThinking }
        : undefined,
      toolsBeforeRun: pi.getActiveTools().filter((toolName) => toolName !== "judge_verdict"),
    };
    persist();

    const ok = await switchToRole("planner", ctx);
    if (!ok) return;

    activateReadOnlyTools();
    updateUi(ctx);
    pi.sendUserMessage(plannerPrompt(parsed.task));
  }

  async function handlePlanProduced(ctx: ExtensionContext, planText: string): Promise<void> {
    if (!planText.trim()) {
      if (!state.plannerReminderSent) {
        state = { ...state, plannerReminderSent: true };
        persist();
        pi.sendUserMessage(
          "You must finish the planning phase by writing a concrete implementation plan. Do not edit files yet.",
          { deliverAs: "followUp" },
        );
        return;
      }

      await stopRun(ctx, "ai-orchestrator stopped because the planner did not produce a plan after a reminder.");
      return;
    }

    const wasReplanning = state.phase === "replanning";
    state = {
      ...(nextPhase(state, { type: "plan_produced", plan: planText }, loopConfig()) as RuntimeState),
      judgeReminderSent: false,
      plannerReminderSent: false,
      latestJudgeFeedback: wasReplanning ? undefined : state.latestJudgeFeedback,
    };
    persist();
    updateUi(ctx);

    if (state.phase === "awaiting_approval") {
      await requestPlanApproval(ctx, wasReplanning);
      return;
    }

    if (state.phase === "coding") {
      await enterCoding(ctx);
    }
  }

  async function requestPlanApproval(ctx: ExtensionContext, wasReplanning: boolean): Promise<void> {
    const approvalRunId = state.runId;

    if (!ctx.hasUI) {
      await stopRun(
        ctx,
        "ai-orchestrator stopped: plan approval is required in non-interactive mode. Re-run with --yolo to skip approval explicitly.",
      );
      return;
    }

    const choice = await ctx.ui.select("Plan ready — proceed?", [
      "Approve and code",
      "Revise plan (give feedback)",
      "Cancel",
    ]);
    if (!isSameApprovalRun(approvalRunId)) return;

    if (choice === "Approve and code") {
      state = nextPhase(state, { type: "plan_approved" }, loopConfig()) as RuntimeState;
      persist();
      if (state.phase === "coding") {
        await enterCoding(ctx);
      }
      return;
    }

    if (choice === "Revise plan (give feedback)") {
      const feedback = await ctx.ui.editor("What should the planner revise?", "");
      if (!isSameApprovalRun(approvalRunId)) return;
      if (!feedback?.trim()) {
        await stopRun(ctx, "ai-orchestrator cancelled during plan revision.");
        return;
      }

      state = nextPhase(state, { type: "plan_rejected_by_user" }, loopConfig()) as RuntimeState;
      persist();
      if (state.phase !== "planning") return;
      const ok = await switchToRole("planner", ctx);
      if (!ok) return;
      updateUi(ctx);
      pi.sendUserMessage(
        plannerPrompt(state.task, undefined, feedback.trim()),
        { deliverAs: "followUp" },
      );
      return;
    }

    await stopRun(ctx, wasReplanning ? "ai-orchestrator cancelled after re-plan." : "ai-orchestrator cancelled.");
  }

  async function enterCoding(ctx: ExtensionContext): Promise<void> {
    if (state.phase !== "coding") return;

    activateBuildTools();
    const ok = await switchToRole("coder", ctx);
    if (!ok) return;

    updateUi(ctx);
    pi.sendUserMessage(coderPrompt(state.plan ?? "", state.latestJudgeFeedback), { deliverAs: "followUp" });
  }

  async function handleCodeProduced(ctx: ExtensionContext): Promise<void> {
    state = nextPhase(state, { type: "code_produced" }, loopConfig()) as RuntimeState;
    state.judgeReminderSent = false;
    state.pendingVerdict = undefined;
    persist();

    if (state.phase !== "judging") return;

    const ok = await switchToRole("judge", ctx);
    if (!ok) return;

    runtime = runtime ?? loadPiResolvedConfig(ctx.cwd);
    pi.setActiveTools(JUDGE_TOOLS);
    updateUi(ctx);

    const command = runtime.config.judge.runTests ? detectTestCommand(ctx.cwd) : undefined;
    pi.sendUserMessage(judgePrompt(state.task, state.plan ?? "", command), { deliverAs: "followUp" });
  }

  async function handleJudgingEnded(ctx: ExtensionContext): Promise<void> {
    if (!state.pendingVerdict) {
      if (!state.judgeReminderSent) {
        state = { ...state, judgeReminderSent: true };
        persist();
        pi.sendUserMessage(
          "You must finish the judge phase by calling the judge_verdict tool exactly once. Do not edit files.",
          { deliverAs: "followUp" },
        );
        return;
      }

      state.pendingVerdict = {
        verdict: "reject",
        reasons: "The judge did not produce a structured verdict; treat this attempt as unverified.",
        requiredFixes: "Re-verify the implementation against the plan, re-run the project's tests, and fix any failures.",
      };
    }

    const verdict = state.pendingVerdict;
    if (!verdict) {
      throw new Error("judge phase ended without a verdict");
    }

    const stateForTransition: OrchestratorState = { ...state };
    state = nextPhase(
      stateForTransition,
      {
        type: "verdict",
        verdict: verdict.verdict,
        reasons: verdict.reasons,
        requiredFixes: verdict.requiredFixes,
      },
      loopConfig(),
    ) as RuntimeState;
    state.pendingVerdict = undefined;
    state.judgeReminderSent = false;
    state.latestJudgeFeedback = formatJudgeFeedback(verdict);
    persist();
    restoreToolsAfterJudge();
    updateUi(ctx);

    if (state.phase === "coding") {
      await enterCoding(ctx);
      return;
    }

    if (state.phase === "replanning") {
      await enterReplanning(ctx);
      return;
    }

    if (state.phase === "done" || state.phase === "failed") {
      await finishRun(ctx);
    }
  }

  async function enterReplanning(ctx: ExtensionContext): Promise<void> {
    activateReadOnlyTools();
    const ok = await switchToRole("planner", ctx);
    if (!ok) return;

    const diffSummary = await getDiffSummary(ctx);
    updateUi(ctx);
    pi.sendUserMessage(replanPrompt(state.task, state.plan ?? "", diffSummary, state.judgeReports), {
      deliverAs: "followUp",
    });
  }

  async function getDiffSummary(ctx: ExtensionContext): Promise<string> {
    try {
      const [unstaged, staged] = await Promise.all([
        pi.exec("git", ["diff", "--stat"], { timeout: 5000, signal: ctx.signal }),
        pi.exec("git", ["diff", "--staged", "--stat"], { timeout: 5000, signal: ctx.signal }),
      ]);
      const combined = [
        unstaged.stdout.trim() ? `Unstaged diff stat:\n${unstaged.stdout.trim()}` : undefined,
        staged.stdout.trim() ? `Staged diff stat:\n${staged.stdout.trim()}` : undefined,
        unstaged.stderr.trim() ? `git diff stderr:\n${unstaged.stderr.trim()}` : undefined,
        staged.stderr.trim() ? `git diff --staged stderr:\n${staged.stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
      return combined || "No git diff stat was available.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Could not collect git diff summary: ${message}`;
    }
  }

  async function finishRun(ctx: ExtensionContext): Promise<void> {
    const summary = finalSummary(state);
    restoreRunTools(state);
    await restoreOriginalModel(ctx, state);
    clearUi(ctx);
    pi.sendMessage({ customType: STATE_TYPE, content: summary, display: true, details: state }, { triggerTurn: false });
    state = createRuntimeState();
    runtime = undefined;
    persist();
    deactivateJudgeVerdictTool();
  }

  async function stopRun(ctx: ExtensionContext, message: string): Promise<void> {
    if (stopping) return;
    stopping = true;

    const stoppedState = state;
    try {
      if (!ctx.isIdle()) {
        ctx.abort();
      }
      restoreRunTools(stoppedState);
      state = nextPhase(stoppedState, { type: "cancelled" }, loopConfig()) as RuntimeState;
      state.runId = undefined;
      persist();

      await restoreOriginalModel(ctx, stoppedState);
      clearUi(ctx);
      pi.sendMessage({ customType: STATE_TYPE, content: message, display: true, details: stoppedState }, { triggerTurn: false });
      state = createRuntimeState();
      runtime = undefined;
      persist();
      deactivateJudgeVerdictTool();
    } finally {
      stopping = false;
    }
  }

  async function switchToRole(role: keyof OrchestratorConfig["roles"], ctx: ExtensionContext): Promise<boolean> {
    const resolved = runtime ?? loadPiResolvedConfig(ctx.cwd);
    runtime = resolved;
    const stage = fastRoutingStage(role);
    const priorSelections: ModelSelectionIdentity[] = (state.modelSelections ?? []).map((selection) => ({
      stage: selection.stage,
      provider: selection.provider,
      model: selection.model,
      ...(selection.family ? { family: selection.family } : {}),
    }));
    const plan = createPiRoutingPlan({
      config: resolved.config,
      provenance: resolved.provenance,
      stage,
      role,
      available: ctx.modelRegistry.getAvailable(),
      evidence: { task: state.task, plan: state.plan, verdictCategory: state.latestJudgeFeedback },
      priorSelections,
    });
    const failed: string[] = [];
    for (const candidate of plan.candidates) {
      const estimate: RoutingCostEstimate = candidate.estimatedCostUsd === undefined
        ? { status: "unknown", reason: "candidate cost metadata unavailable" }
        : { status: "known", estimatedUsd: candidate.estimatedCostUsd };
      const budget = enforceRoutingBudget({
        stage,
        estimate,
        budgets: resolved.config.routing.budgets,
        snapshot: fastBudgetSnapshot(state),
        unattended: state.yolo || !ctx.hasUI,
      });
      if (budget.allowed !== true) {
        await abortForModelError(ctx, `${role} stopped by routing budget: ${budget.reason}`);
        return false;
      }
      const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
      if (!model) {
        failed.push(`${candidate.provider}/${candidate.model} (not found)`);
        continue;
      }
      const runId = state.runId;
      const phase = state.phase;
      if (!(await pi.setModel(model))) {
        failed.push(`${candidate.provider}/${candidate.model} (unavailable)`);
        continue;
      }
      if (state.runId !== runId || state.phase !== phase) return false;
      pi.setThinkingLevel(candidate.thinking);
      state = {
        ...state,
        modelSelections: [...(state.modelSelections ?? []), {
          stage,
          provider: candidate.provider,
          model: candidate.model,
          ...(candidate.family ? { family: candidate.family } : {}),
          thinking: candidate.thinking,
          reason: candidate.reason,
          engine: plan.engine,
          policyVersion: plan.policyVersion,
          taskFeaturesHash: plan.taskFeaturesHash,
          fallbackCount: failed.length,
          ...(candidate.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: candidate.estimatedCostUsd }),
        }],
      };
      persist();
      return true;
    }
    const exclusions = plan.decision?.excluded.map((item) => `${item.identity.provider}/${item.identity.model}: ${item.code}`) ?? [];
    await abortForModelError(ctx, `${role} has no eligible model (${[...failed, ...exclusions].join(", ") || "no candidates"})`);
    return false;
  }

  function fastBudgetSnapshot(current: RuntimeState): RoutingBudgetSnapshot {
    return {
      estimatedRunUsd: (current.modelSelections ?? []).reduce((sum, selection) => sum + (selection.estimatedCostUsd ?? 0), 0),
      observedRunUsd: 0,
      estimatedDayUsd: (current.modelSelections ?? []).reduce((sum, selection) => sum + (selection.estimatedCostUsd ?? 0), 0),
      observedDayUsd: 0,
      paidFallbacks: (current.modelSelections ?? []).reduce((sum, selection) => sum + selection.fallbackCount, 0),
      attemptsByStage: Object.fromEntries(
        (current.modelSelections ?? []).map((selection) => [
          selection.stage,
          (current.modelSelections ?? []).filter((item) => item.stage === selection.stage).length,
        ]),
      ) as Partial<Record<RoutingStage, number>>,
    };
  }

  async function abortForModelError(ctx: ExtensionContext, reason: string): Promise<void> {
    const configHint = `Fix role config in ~/.ai-orchestrator/config.json or ${ctx.cwd}/.ai-orchestrator.json.`;
    await stopRun(ctx, `ai-orchestrator aborted: ${reason}. ${configHint}`);
  }

  async function restoreOriginalModel(ctx: ExtensionContext, source: RuntimeState): Promise<void> {
    const original = source.originalModel;
    if (!original) return;

    const model = ctx.modelRegistry.find(original.provider, original.id);
    if (!model) {
      notifyUser(ctx, `Could not restore original model ${original.provider}/${original.id}: model not found.`, "warning");
    } else {
      const restored = await pi.setModel(model);
      if (!restored) {
        notifyUser(ctx, `Could not restore original model ${original.provider}/${original.id}: API key is unavailable.`, "warning");
      }
    }
    pi.setThinkingLevel(original.thinking);
  }

  async function restorePendingSessionState(ctx: ExtensionContext, persistedState: RuntimeState): Promise<RuntimeState> {
    state = persistedState;
    restoreRunTools(persistedState);
    await restoreOriginalModel(ctx, persistedState);
    state = { ...state, originalModel: undefined, toolsBeforeRun: undefined, toolsBeforeJudge: undefined };
    persist();
    return state;
  }

  function activateReadOnlyTools(): void {
    pi.setActiveTools(READ_ONLY_TOOLS);
  }

  function activateBuildTools(): void {
    pi.setActiveTools(state.toolsBeforeRun ?? pi.getActiveTools().filter((toolName) => toolName !== "judge_verdict"));
  }

  function restoreRunTools(source: RuntimeState): void {
    if (source.toolsBeforeRun) {
      pi.setActiveTools(source.toolsBeforeRun.filter((toolName) => toolName !== "judge_verdict"));
    } else if (source.toolsBeforeJudge) {
      pi.setActiveTools(source.toolsBeforeJudge.filter((toolName) => toolName !== "judge_verdict"));
    } else {
      deactivateJudgeVerdictTool();
    }
  }

  function restoreToolsAfterJudge(): void {
    if (state.phase === "coding") activateBuildTools();
    else deactivateJudgeVerdictTool();
  }

  function deactivateJudgeVerdictTool(): void {
    const activeTools = pi.getActiveTools();
    if (activeTools.includes("judge_verdict")) {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "judge_verdict"));
    }
  }

  function isSameApprovalRun(runId: string | undefined): boolean {
    return state.phase === "awaiting_approval" && state.runId === runId;
  }

  function persist(): void {
    pi.appendEntry(STATE_TYPE, state);
  }

  function loopConfig() {
    return loopConfigFrom(runtime?.config ?? DEFAULT_CONFIG);
  }

  function updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (state.phase === "idle") {
      clearUi(ctx);
      return;
    }

    const selection = state.modelSelections?.at(-1);
    const modelLabel = selection ? ` ${selection.provider}/${selection.model}` : "";
    ctx.ui.setStatus(STATUS_KEY, `orchestrator ${state.phase}${modelLabel}`);

    const latestReport = state.judgeReports.at(-1);
    const lines = [
      `AI Orchestrator: ${state.phase}`,
      `Task: ${truncate(state.task, 80)}`,
      `Coder iterations: ${state.coderIterations}`,
      `Consecutive rejections: ${state.consecutiveRejections}`,
      selection ? `Routing: ${selection.engine}; fallback ${selection.fallbackCount}` : undefined,
      latestReport ? `Last judge: ${latestReport.verdict} — ${truncate(latestReport.reasons, 80)}` : undefined,
    ].filter((line): line is string => Boolean(line));
    ctx.ui.setWidget(WIDGET_KEY, lines);
  }

  function clearUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function notifyUser(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
      return;
    }

    pi.sendMessage(
      { customType: STATE_TYPE, content: `[${level}] ${message}`, display: true, details: { level } },
      { triggerTurn: false },
    );
  }
}

function createRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return { ...(createIdleState(overrides) as RuntimeState), modelSelections: [], ...overrides };
}

function loadPiResolvedConfig(cwd: string) {
  return loadConfigWithProvenance(cwd, { ignoreMcpProviders: true });
}

function fastRoutingStage(role: keyof OrchestratorConfig["roles"]): Extract<RoutingStage, "plan" | "build" | "fast-judge"> {
  if (role === "planner") return "plan";
  if (role === "coder") return "build";
  if (role === "judge") return "fast-judge";
  throw new Error(`Role ${role} is not part of the fast workflow`);
}

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseCommandArgs(args: string): { yolo: boolean; task: string; warning?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  let yolo = false;
  while (parts[index] === "--yolo") {
    yolo = true;
    index += 1;
  }

  const taskParts = parts.slice(index);
  return {
    yolo,
    task: taskParts.join(" ").trim(),
    warning: taskParts.includes("--yolo")
      ? "Ignoring non-leading --yolo token in task text. Put --yolo before the task to skip plan approval."
      : undefined,
  };
}

function findMissingRole(ctx: ExtensionContext, config: OrchestratorConfig): string | undefined {
  for (const role of ["planner", "coder", "judge"] as const) {
    const roleConfig: RoleConfig = config.roles[role];
    if (!ctx.modelRegistry.find(roleConfig.provider, roleConfig.model)) {
      return `${role} model not found: ${roleConfig.provider}/${roleConfig.model}. Fix role config in ~/.ai-orchestrator/config.json or ${ctx.cwd}/.ai-orchestrator.json.`;
    }
  }
  return undefined;
}

function latestPersistedState(ctx: ExtensionContext): RuntimeState | undefined {
  const branch = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
  const entry = branch.filter((item) => item.type === "custom" && item.customType === STATE_TYPE).pop();
  return isRuntimeState(entry?.data) ? entry.data : undefined;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeState>;
  return typeof candidate.phase === "string" && typeof candidate.task === "string";
}

function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = extractText(message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

function lastAssistantStopReason(messages: unknown[]): string | undefined {
  const stopReason = findLastAssistant(messages)?.stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function isActiveLifecyclePhase(phase: string): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function isActiveRunPhase(phase: OrchestratorState["phase"]): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function isRestorePending(state: RuntimeState): boolean {
  return Boolean(state.originalModel || state.toolsBeforeJudge);
}

function findLastAssistant(messages: unknown[]): Record<string, unknown> | undefined {
  const reversed = [...messages].reverse();
  return reversed.find((message) => isRecord(message) && message.role === "assistant") as
    | Record<string, unknown>
    | undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatJudgeFeedback(verdict: JudgeVerdictParams): string {
  return [
    `Verdict: ${verdict.verdict}`,
    `Reasons: ${verdict.reasons}`,
    verdict.requiredFixes ? `Required fixes: ${verdict.requiredFixes}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function finalSummary(state: RuntimeState): string {
  const verdicts = state.judgeReports
    .map((report, index) => {
      const requiredFixes = report.requiredFixes ? `\n   Required fixes: ${report.requiredFixes}` : "";
      return `${index + 1}. ${report.verdict}: ${report.reasons}${requiredFixes}`;
    })
    .join("\n");

  return [
    state.phase === "done" ? "AI Orchestrator completed successfully." : "AI Orchestrator failed at the loop cap.",
    `Task: ${state.task}`,
    `Coder iterations: ${state.coderIterations}`,
    verdicts ? `Judge reports:\n${verdicts}` : "Judge reports: none",
    state.phase === "failed" ? "Working tree was left as-is for human review." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
