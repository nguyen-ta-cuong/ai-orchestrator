import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig, loopConfigFrom, type OrchestratorConfig, type RoleConfig, type ThinkingLevel } from "../src/core/config.js";
import { coderPrompt, judgePrompt, plannerPrompt, replanPrompt } from "../src/core/prompts.js";
import { detectTestCommand } from "../src/core/tests.js";
import { createIdleState, nextPhase, type JudgeReport, type OrchestratorState, type Verdict } from "../src/core/loop.js";

const STATE_TYPE = "ai-orchestrator";
const STATUS_KEY = "ai-orchestrator";
const WIDGET_KEY = "ai-orchestrator";
const JUDGE_TOOLS = ["read", "grep", "find", "ls", "bash", "judge_verdict"];
const MUTATION_TOOLS = new Set(["edit", "write"]);

interface JudgeVerdictParams {
  verdict: Verdict;
  reasons: string;
  requiredFixes?: string;
}

interface RuntimeState extends OrchestratorState {
  pendingVerdict?: JudgeVerdictParams;
  judgeReminderSent?: boolean;
  latestJudgeFeedback?: string;
}

interface RuntimeConfig {
  config: OrchestratorConfig;
  toolsBeforeJudge?: string[];
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
  let state: RuntimeState = createRuntimeState();
  let runtime: RuntimeConfig | undefined;

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
    const latest = latestPersistedState(ctx);
    if (!latest) {
      deactivateJudgeVerdictTool();
      updateUi(ctx);
      return;
    }

    if (latest.phase !== "idle" && latest.phase !== "done" && latest.phase !== "failed") {
      state = { ...latest, phase: "idle" };
      await restoreOriginalModel(ctx, latest);
      state = createRuntimeState();
      persist();
      notifyUser(ctx, "Previous ai-orchestrator run was interrupted; state reset.", "warning");
    } else {
      state = latest.phase === "idle" ? latest : createRuntimeState();
    }
    deactivateJudgeVerdictTool();
    updateUi(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (state.phase === "judging" && MUTATION_TOOLS.has(event.toolName)) {
      return { block: true, reason: "ai-orchestrator judge phase is read-only; edit/write are blocked." };
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      if (isActiveRunPhase(state.phase)) {
        const stopReason = lastAssistantStopReason(event.messages);
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
        await handlePlanProduced(ctx, extractLastAssistantText(event.messages));
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
    if (!parsed.task) {
      notifyUser(ctx, "Usage: /orchestrate [--yolo] <task>", "error");
      return;
    }

    const config = loadConfig(ctx.cwd);
    runtime = { config };

    const missingRole = findMissingRole(ctx, config);
    if (missingRole) {
      notifyUser(ctx, missingRole, "error");
      runtime = undefined;
      return;
    }

    const yolo = parsed.yolo || pi.getFlag("orchestrate-yolo") === true;
    const currentThinking = pi.getThinkingLevel();
    state = createRuntimeState({
      phase: "planning",
      task: parsed.task,
      yolo,
      originalModel: ctx.model
        ? { provider: String(ctx.model.provider), id: String(ctx.model.id), thinking: currentThinking }
        : undefined,
    });
    persist();

    const ok = await switchToRole("planner", ctx);
    if (!ok) return;

    deactivateJudgeVerdictTool();
    updateUi(ctx);
    pi.sendUserMessage(plannerPrompt(parsed.task));
  }

  async function handlePlanProduced(ctx: ExtensionContext, planText: string): Promise<void> {
    if (!planText.trim()) {
      await stopRun(ctx, "ai-orchestrator stopped because the planner did not produce a plan.");
      return;
    }

    const wasReplanning = state.phase === "replanning";
    state = {
      ...(nextPhase(state, { type: "plan_produced", plan: planText }, loopConfig(ctx)) as RuntimeState),
      judgeReminderSent: false,
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
    if (!ctx.hasUI) {
      state = nextPhase(state, { type: "plan_approved" }, loopConfig(ctx)) as RuntimeState;
      persist();
      await enterCoding(ctx);
      return;
    }

    const choice = await ctx.ui.select("Plan ready — proceed?", [
      "Approve and code",
      "Revise plan (give feedback)",
      "Cancel",
    ]);

    if (choice === "Approve and code") {
      state = nextPhase(state, { type: "plan_approved" }, loopConfig(ctx)) as RuntimeState;
      persist();
      await enterCoding(ctx);
      return;
    }

    if (choice === "Revise plan (give feedback)") {
      const feedback = await ctx.ui.editor("What should the planner revise?", "");
      if (!feedback?.trim()) {
        await stopRun(ctx, "ai-orchestrator cancelled during plan revision.");
        return;
      }

      state = nextPhase(state, { type: "plan_rejected_by_user" }, loopConfig(ctx)) as RuntimeState;
      persist();
      const ok = await switchToRole("planner", ctx);
      if (!ok) return;
      updateUi(ctx);
      pi.sendUserMessage(
        plannerPrompt(`${state.task}\n\nUser requested plan revision:\n${feedback.trim()}`),
        { deliverAs: "followUp" },
      );
      return;
    }

    await stopRun(ctx, wasReplanning ? "ai-orchestrator cancelled after re-plan." : "ai-orchestrator cancelled.");
  }

  async function enterCoding(ctx: ExtensionContext): Promise<void> {
    restoreToolsAfterJudge();
    const ok = await switchToRole("coder", ctx);
    if (!ok) return;

    updateUi(ctx);
    pi.sendUserMessage(coderPrompt(state.plan ?? "", state.latestJudgeFeedback), { deliverAs: "followUp" });
  }

  async function handleCodeProduced(ctx: ExtensionContext): Promise<void> {
    state = nextPhase(state, { type: "code_produced" }, loopConfig(ctx)) as RuntimeState;
    state.judgeReminderSent = false;
    state.pendingVerdict = undefined;
    persist();

    if (state.phase !== "judging") return;

    const ok = await switchToRole("judge", ctx);
    if (!ok) return;

    runtime = { ...(runtime ?? { config: loadConfig(ctx.cwd) }), toolsBeforeJudge: pi.getActiveTools() };
    pi.setActiveTools(uniqueToolNames(JUDGE_TOOLS));
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
        reasons: "Judge failed to return a structured verdict after a reminder.",
        requiredFixes: "Run the judge review again and return a judge_verdict tool call.",
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
      loopConfig(ctx),
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
    await restoreOriginalModel(ctx, state);
    clearUi(ctx);
    pi.sendMessage({ customType: STATE_TYPE, content: summary, display: true, details: state }, { triggerTurn: false });
    state = createRuntimeState();
    runtime = undefined;
    persist();
    deactivateJudgeVerdictTool();
  }

  async function stopRun(ctx: ExtensionContext, message: string): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.abort();
    }
    restoreToolsAfterJudge();
    await restoreOriginalModel(ctx, state);
    clearUi(ctx);
    pi.sendMessage({ customType: STATE_TYPE, content: message, display: true, details: state }, { triggerTurn: false });
    state = createRuntimeState();
    runtime = undefined;
    persist();
    deactivateJudgeVerdictTool();
  }

  async function switchToRole(role: keyof OrchestratorConfig["roles"], ctx: ExtensionContext): Promise<boolean> {
    const config = runtime?.config ?? loadConfig(ctx.cwd);
    const roleConfig = config.roles[role];
    const model = ctx.modelRegistry.find(roleConfig.provider, roleConfig.model);
    if (!model) {
      await abortForModelError(ctx, `${role} model not found: ${roleConfig.provider}/${roleConfig.model}`);
      return false;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      await abortForModelError(ctx, `${role} model has no configured API key: ${roleConfig.provider}/${roleConfig.model}`);
      return false;
    }

    pi.setThinkingLevel(roleConfig.thinking);
    return true;
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
    pi.setThinkingLevel(original.thinking as ThinkingLevel);
  }

  function restoreToolsAfterJudge(): void {
    if (runtime?.toolsBeforeJudge) {
      pi.setActiveTools(runtime.toolsBeforeJudge.filter((toolName) => toolName !== "judge_verdict"));
      runtime.toolsBeforeJudge = undefined;
    } else {
      deactivateJudgeVerdictTool();
    }
  }

  function deactivateJudgeVerdictTool(): void {
    const activeTools = pi.getActiveTools();
    if (activeTools.includes("judge_verdict")) {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "judge_verdict"));
    }
  }

  function persist(): void {
    pi.appendEntry(STATE_TYPE, state);
  }

  function loopConfig(ctx: ExtensionContext) {
    return loopConfigFrom(runtime?.config ?? loadConfig(ctx.cwd));
  }

  function updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (state.phase === "idle") {
      clearUi(ctx);
      return;
    }

    const role = phaseRole(state.phase);
    const roleConfig = role && runtime?.config.roles[role];
    const modelLabel = roleConfig ? ` ${roleConfig.provider}/${roleConfig.model}` : "";
    ctx.ui.setStatus(STATUS_KEY, `orchestrator ${state.phase}${modelLabel}`);

    const latestReport = state.judgeReports.at(-1);
    const lines = [
      `AI Orchestrator: ${state.phase}`,
      `Task: ${truncate(state.task, 80)}`,
      `Coder iterations: ${state.coderIterations}`,
      `Consecutive rejections: ${state.consecutiveRejections}`,
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
  return { ...(createIdleState(overrides) as RuntimeState), ...overrides };
}

function parseCommandArgs(args: string): { yolo: boolean; task: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const yolo = parts[0] === "--yolo";
  return { yolo, task: (yolo ? parts.slice(1) : parts).join(" ").trim() };
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
  const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
  const entry = entries.filter((item) => item.type === "custom" && item.customType === STATE_TYPE).pop();
  return isRuntimeState(entry?.data) ? entry.data : undefined;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeState>;
  return typeof candidate.phase === "string" && typeof candidate.task === "string";
}

function extractLastAssistantText(messages: unknown[]): string {
  const message = findLastAssistant(messages);
  return message ? extractText(message.content) : "";
}

function lastAssistantStopReason(messages: unknown[]): string | undefined {
  const stopReason = findLastAssistant(messages)?.stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function isActiveRunPhase(phase: OrchestratorState["phase"]): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "failed";
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

function phaseRole(phase: OrchestratorState["phase"]): keyof OrchestratorConfig["roles"] | undefined {
  if (phase === "planning" || phase === "replanning" || phase === "awaiting_approval") return "planner";
  if (phase === "coding") return "coder";
  if (phase === "judging") return "judge";
  return undefined;
}

function uniqueToolNames(names: string[]): string[] {
  return [...new Set(names)];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

