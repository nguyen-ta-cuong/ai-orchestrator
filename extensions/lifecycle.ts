import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigWithProvenance,
  loopConfigFrom,
  type ConfigProvenance,
  type LifecycleRoutedStage,
  type OrchestratorConfig,
  type RoleName,
  type ThinkingLevel,
} from "../src/core/config.js";
import { createPiRoutingPlan, piRoutingRunVersion, type PiRoutingCandidate, type PiRoutingPlan } from "../src/adapters/piCapabilityRouting.js";
import { enforceRoutingBudget, type RoutingBudgetSnapshot, type RoutingCostEstimate } from "../src/core/routingBudget.js";
import {
  debugPrompt,
  buildPrompt,
  reviewPrompt,
  shipPrompt,
  specPrompt,
  taskPlanPrompt,
  verifyPrompt,
} from "../src/core/lifecyclePrompts.js";
import {
  nextStage,
  type LifecycleEvent,
  type LifecyclePhase,
  type LifecycleStageVerdict,
  type LifecycleState,
} from "../src/core/lifecycle.js";
import { recommendRoutingPolicyChanges } from "../src/core/routingEvidence.js";
import { detectTestCommand } from "../src/core/tests.js";
import { isReadOnlyLifecycleCommand } from "../src/lifecycle/readOnlyPolicy.js";
import {
  acquireRunLease,
  appendJournal,
  appendRoutingTrace,
  assertRunPathsSafe,
  createRun,
  currentRun,
  ownsRunLease,
  readState,
  releaseRun,
  releaseRunLease,
  writeState,
  type RunPaths,
} from "../src/lifecycle/artifacts.js";
import {
  appendRoutingBudgetLedgerEvent,
  appendRoutingEvidenceEvent,
  readRoutingBudgetLedger,
  readRoutingEvidenceEvents,
  resolveUserEvidenceRoot,
} from "../src/lifecycle/routingEvidenceStore.js";

const ENTRY_TYPE = "ai-orchestrator-lifecycle";
const STATUS_KEY = ENTRY_TYPE;
const WIDGET_KEY = ENTRY_TYPE;
const VERDICT_TOOLS = new Set(["verify_verdict", "review_verdict", "debug_diagnosis", "ship_decision"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const READ_TOOLS = ["read", "grep", "find", "ls", "bash"];
const PUBLICATION_COMMAND = /\bgit\b[\s\S]*?\b(?:add|commit|push|tag)\b|\bgh\b[\s\S]*?\bpr\b[\s\S]*?\bcreate\b|\b(?:npm|pnpm|yarn)\b[\s\S]*?\bpublish\b/i;
const DESTRUCTIVE_GIT_COMMAND = /\bgit\b[\s\S]*?\b(?:clean|reset|checkout|restore)\b/i;
const TESTABLE_READ_ONLY_PHASES = new Set<LifecyclePhase>(["verifying", "reviewing", "debugging", "shipping"]);

type StandaloneStage = "spec" | "plan" | "build" | "test" | "debug" | "review" | "ship";
interface PendingDiagnosis {
  rootCause: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
  recommendedFix: string;
  filesLikelyAffected: string[];
  validationCommands: string[];
}

type PendingVerdict =
  | { kind: "verify" | "review"; verdict: "approve" | "reject"; reasons: string; requiredFixes?: string }
  | { kind: "ship"; verdict: "approve" | "reject"; reasons: string; requiredFixes?: string };

interface Runtime {
  config: OrchestratorConfig;
  provenance: ConfigProvenance;
  cwd: string;
  paths: RunPaths;
  state: LifecycleState;
  automatic: boolean;
  standalone?: StandaloneStage;
  toolsBeforeRun: string[];
  invocationOriginal?: LifecycleState["originalModel"];
  pendingVerdict?: PendingVerdict;
  pendingDiagnosis?: PendingDiagnosis;
  remindedPhase?: LifecyclePhase;
  specRevisionFeedback?: string;
  planRevisionFeedback?: string;
  attemptedModels: string[];
  leaseOwner: string;
  lastUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    observedUsd: number;
  };
}

export default function lifecycleExtension(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  let pendingSettlement: { runId: string; messages: unknown[] } | undefined;
  let stopping = false;

  pi.registerFlag("lifecycle-yolo", {
    description: "Skip lifecycle spec, plan, and ship approval gates",
    type: "boolean",
    default: false,
  });

  registerVerdictTools();

  pi.registerCommand("lifecycle", {
    description: "Run or resume the durable DEFINE → SHIP lifecycle",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (args.trim() === "resume") {
        await resumeRun(ctx);
      } else if (args.trim() === "migrate-routing") {
        await migrateRoutingPolicy(ctx);
      } else {
        await startPipeline(args, ctx);
      }
    },
  });

  pi.registerCommand("lifecycle-routing-report", {
    description: "Show report-only routing recommendations from privacy-minimized user evidence",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const config = loadPiConfig(ctx.cwd);
      const store = join(resolveUserEvidenceRoot(undefined, config.routing.evidence.userStoreDir), "events.jsonl");
      const read = readRoutingEvidenceEvents(store);
      const recommendations = recommendRoutingPolicyChanges(read.events, {
        minimumSamples: config.routing.evidence.minRecommendationSamples,
      });
      const content = recommendations.length > 0
        ? `Routing recommendations (report only; no policy was changed):\n\n${JSON.stringify(recommendations, null, 2)}`
        : `No routing recommendation met the ${config.routing.evidence.minRecommendationSamples}-sample threshold across ${read.events.length} valid events.`;
      pi.sendMessage({ customType: ENTRY_TYPE, content, display: true, details: { recommendations, warnings: read.warnings } }, { triggerTurn: false });
    },
  });

  pi.registerCommand("lifecycle-routing-apply", {
    description: "Explicitly apply one report recommendation to trusted user preferences",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await applyRoutingRecommendation(args, ctx);
    },
  });

  pi.registerCommand("lifecycle-routing-rollback", {
    description: "Rollback a previously applied routing recommendation by id",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await rollbackRoutingRecommendation(args, ctx);
    },
  });

  pi.registerCommand("lifecycle-stop", {
    description: "Stop the active lifecycle, restore the model, and preserve artifacts",
    handler: async (_args, ctx) => {
      await stopRun(ctx, "Lifecycle stopped by user.");
    },
  });

  registerStageCommand("spec", "Run DEFINE only", async (args, ctx) => startSpec(args, ctx));
  registerStageCommand("plan", "Run PLAN for the current lifecycle", async (_args, ctx) => startStandalone("plan", "planning", ctx));
  registerStageCommand("build", "Run BUILD for the current lifecycle", async (_args, ctx) => startStandalone("build", "building", ctx));
  registerStageCommand("test", "Run VERIFY for the current lifecycle", async (_args, ctx) => startStandalone("test", "verifying", ctx));
  registerStageCommand("debug", "Run read-only DEBUG for the current lifecycle", async (_args, ctx) => startStandalone("debug", "debugging", ctx));
  registerStageCommand("review", "Run REVIEW for the current lifecycle", async (_args, ctx) => startStandalone("review", "reviewing", ctx));
  registerStageCommand("ship", "Run or resume SHIP finalization for the current lifecycle", async (_args, ctx) =>
    startStandalone("ship", ["shipping", "awaiting_ship_approval", "finalizing"], ctx));

  pi.on("tool_call", async (event) => {
    const activeRuntime = runtime;
    const state = activeRuntime?.state;
    if (!activeRuntime || !state) return;
    assertRunPathsSafe(activeRuntime.paths);
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (state.phase === "building") {
        const metadataRoot = resolve(activeRuntime.paths.root, "../..");
        if (isBlockedBuildCommand(command, activeRuntime.config.lifecycle.artifactsDir, metadataRoot)) {
          return { block: true, reason: "BUILD may edit source but cannot modify orchestrator metadata, perform destructive Git operations, or stage, commit, tag, push, open a PR, or publish." };
        }
        return;
      }
      const testCommand = activeRuntime.config.judge.runTests && TESTABLE_READ_ONLY_PHASES.has(state.phase)
        ? detectTestCommand(activeRuntime.cwd)
        : undefined;
      if (!isReadOnlyLifecycleCommand(command, testCommand)) {
        return { block: true, reason: `${stageLabel(state.phase)} allows only reviewed read-only inspection commands${testCommand ? " and the exact detected test command" : ""}.` };
      }
      return;
    }
    if (!MUTATION_TOOLS.has(event.toolName)) return;

    if (state.phase === "building") {
      const input = event.input as { path?: unknown };
      const requestedPath = typeof input.path === "string" ? resolve(activeRuntime.cwd, input.path.replace(/^@/, "")) : "";
      const artifactsRoot = resolve(activeRuntime.paths.root, "..");
      if (requestedPath !== artifactsRoot && !requestedPath.startsWith(`${artifactsRoot}/`)) return;
      return { block: true, reason: "BUILD may edit source files but lifecycle artifacts are orchestrator-owned." };
    }
    if (state.phase === "defining" || state.phase === "planning") {
      const input = event.input as { path?: unknown };
      const requestedPath = typeof input.path === "string" ? resolve(activeRuntime.cwd, input.path.replace(/^@/, "")) : "";
      const allowedPath = resolve(state.phase === "defining" ? activeRuntime.paths.spec : activeRuntime.paths.plan);
      if (requestedPath === allowedPath) return;
      return { block: true, reason: `${stageLabel(state.phase)} may write only ${allowedPath}.` };
    }

    return { block: true, reason: `${stageLabel(state.phase)} is read-only; edit/write are blocked.` };
  });

  pi.on("message_end", async (event) => {
    if (!runtime || !event.message || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage) return;
    runtime.lastUsage = {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      observedUsd: usage.cost.total,
    };
  });

  pi.on("agent_end", async (event) => {
    if (runtime) pendingSettlement = { runId: runtime.state.runId, messages: event.messages };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime || !pendingSettlement || pendingSettlement.runId !== runtime.state.runId) return;
    const { runId, messages } = pendingSettlement;
    pendingSettlement = undefined;
    try {
      const stopReason = lastAssistantStopReason(messages);
      if (stopReason === "aborted" || stopReason === "error") {
        if (stopReason === "error") recordProviderFailure();
        await interruptRun(ctx, stopReason === "aborted"
          ? "Lifecycle turn was aborted. Run /lifecycle resume to continue."
          : "Lifecycle turn ended with a model/provider error. Run /lifecycle resume to try the next eligible fallback.");
        return;
      }

      if (!ownsRun(runId, runtime.state.phase)) return;
      switch (runtime.state.phase) {
        case "defining":
          await artifactStageEnded(ctx, "spec");
          break;
        case "planning":
          await artifactStageEnded(ctx, "plan");
          break;
        case "building":
          await recordBuildEvidenceFingerprint(ctx);
          if (!runtime || !ownsRun(runtime.state.runId, "building")) return;
          persistRoutingStageOutcome("build", { structuredToolCompliance: true, verdict: "unknown" });
          await transition({ type: "build_produced" }, "BUILD completed; entering VERIFY", ctx);
          await continueOrPause(ctx, "test");
          break;
        case "verifying":
          await checkerStageEnded(ctx, "verify");
          break;
        case "reviewing":
          await checkerStageEnded(ctx, "review");
          break;
        case "debugging":
          await debugStageEnded(ctx);
          break;
        case "shipping":
          await checkerStageEnded(ctx, "ship");
          break;
        default:
          break;
      }
    } catch (error) {
      await interruptRun(ctx, `Lifecycle stopped after an internal error: ${errorMessage(error)}. Run /lifecycle resume after correcting it.`);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    deactivateVerdictTools();
    const loaded = loadCurrent(ctx.cwd);
    if (!loaded || (!isActivePhase(loaded.state.phase) && loaded.state.modelRestored !== false)) {
      clearUi(ctx);
      return;
    }

    if (loaded.state.modelRestored === false) {
      const sessionLeaseOwner = randomUUID();
      try {
        acquireRunLease(loaded.paths, sessionLeaseOwner);
      } catch {
        clearUi(ctx);
        notify(ctx, `Lifecycle run ${loaded.state.runId} is executing in another Pi process; this session will not restore or mutate it.`, "warning");
        return;
      }
      try {
        const restored = await restoreOriginalModel(ctx, loaded.state);
        writeState(loaded.paths, loaded.state);
        if (!restored) {
          clearUi(ctx);
          notify(ctx, `Lifecycle run ${loaded.state.runId} still needs original-model restoration. Fix model availability and use /lifecycle resume or /lifecycle-stop.`, "warning");
          return;
        }
        if (!isActivePhase(loaded.state.phase)) {
          releaseRun(ctx.cwd, loadPiConfig(ctx.cwd).lifecycle.artifactsDir, loaded.state.runId);
          clearUi(ctx);
          return;
        }
      } finally {
        releaseRunLease(loaded.paths, sessionLeaseOwner);
      }
    }
    clearUi(ctx);
    runtime = undefined;
    notify(ctx, `Lifecycle run ${loaded.state.runId} is at ${loaded.state.phase}. Use /lifecycle resume or /lifecycle-stop.`, "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (runtime) {
      restoreTools();
      await restoreRuntimeModel(ctx);
      persistMirror(runtime.state);
      releaseRuntimeLease();
    }
    runtime = undefined;
    deactivateVerdictTools();
    clearUi(ctx);
  });

  function registerVerdictTools(): void {
    pi.registerTool({
      name: "verify_verdict",
      label: "Verify Verdict",
      description: "Return the structured verdict for lifecycle VERIFY.",
      promptSnippet: "Return the lifecycle VERIFY approve/reject verdict",
      promptGuidelines: ["Use verify_verdict exactly once as the final action during lifecycle VERIFY."],
      parameters: Type.Object({
        verdict: StringEnum(["approve", "reject"] as const),
        reasons: Type.String(),
        requiredFixes: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        requireToolPhase("verifying", "verify_verdict");
        runtime!.pendingVerdict = { kind: "verify", ...params };
        persistMirror(runtime!.state);
        return { content: [{ type: "text", text: `Recorded VERIFY verdict: ${params.verdict}` }], details: params, terminate: true };
      },
    });

    pi.registerTool({
      name: "review_verdict",
      label: "Review Verdict",
      description: "Return the structured verdict for lifecycle REVIEW.",
      promptSnippet: "Return the lifecycle REVIEW approve/reject verdict",
      promptGuidelines: ["Use review_verdict exactly once as the final action during lifecycle REVIEW."],
      parameters: Type.Object({
        verdict: StringEnum(["approve", "reject"] as const),
        reasons: Type.String(),
        requiredFixes: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        requireToolPhase("reviewing", "review_verdict");
        runtime!.pendingVerdict = { kind: "review", ...params };
        persistMirror(runtime!.state);
        return { content: [{ type: "text", text: `Recorded REVIEW verdict: ${params.verdict}` }], details: params, terminate: true };
      },
    });

    pi.registerTool({
      name: "debug_diagnosis",
      label: "Debug Diagnosis",
      description: "Return a structured root-cause diagnosis for lifecycle DEBUG.",
      promptSnippet: "Return the lifecycle DEBUG root-cause diagnosis",
      promptGuidelines: ["Use debug_diagnosis exactly once as the final action during lifecycle DEBUG."],
      parameters: Type.Object({
        rootCause: Type.String(),
        evidence: Type.String(),
        confidence: StringEnum(["low", "medium", "high"] as const),
        recommendedFix: Type.String(),
        filesLikelyAffected: Type.Array(Type.String()),
        validationCommands: Type.Array(Type.String()),
      }),
      async execute(_id, params) {
        requireToolPhase("debugging", "debug_diagnosis");
        const diagnosis = params as PendingDiagnosis;
        runtime!.pendingDiagnosis = diagnosis;
        runtime!.state.debugDiagnosisVerdictIndex = latestRejectionIndex();
        writeState(runtime!.paths, runtime!.state);
        assertRunPathsSafe(runtime!.paths);
        writeFileSync(runtime!.paths.debug, formatDiagnosis(diagnosis));
        appendJournal(runtime!.paths, `DEBUG diagnosis recorded: ${truncate(diagnosis.rootCause, 160)}`);
        persistMirror(runtime!.state);
        return { content: [{ type: "text", text: "Recorded DEBUG diagnosis." }], details: diagnosis, terminate: true };
      },
    });

    pi.registerTool({
      name: "ship_decision",
      label: "Ship Decision",
      description: "Return the lifecycle SHIP go/no-go report.",
      promptSnippet: "Return the lifecycle SHIP GO or NO-GO decision",
      promptGuidelines: ["Use ship_decision exactly once as the final action during lifecycle SHIP."],
      parameters: Type.Object({
        decision: StringEnum(["go", "no_go"] as const),
        report: Type.String(),
        blockers: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        requireToolPhase("shipping", "ship_decision");
        runtime!.pendingVerdict = {
          kind: "ship",
          verdict: params.decision === "go" ? "approve" : "reject",
          reasons: params.report,
          requiredFixes: params.blockers,
        };
        persistMirror(runtime!.state);
        return { content: [{ type: "text", text: `Recorded SHIP decision: ${params.decision}` }], details: params, terminate: true };
      },
    });
  }

  function registerStageCommand(
    name: StandaloneStage,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ): void {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        await ctx.waitForIdle();
        await handler(args, ctx);
      },
    });
  }

  async function applyRoutingRecommendation(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const index = Number.parseInt(args.trim(), 10) - 1;
    if (!Number.isInteger(index) || index < 0) {
      notify(ctx, "Usage: /lifecycle-routing-apply <1-based recommendation number>", "error");
      return;
    }
    const config = loadPiConfig(ctx.cwd);
    const userStoreRoot = resolveUserEvidenceRoot(undefined, config.routing.evidence.userStoreDir);
    const events = readRoutingEvidenceEvents(join(userStoreRoot, "events.jsonl")).events;
    const recommendations = recommendRoutingPolicyChanges(events, { minimumSamples: config.routing.evidence.minRecommendationSamples });
    const recommendation = recommendations[index];
    if (!recommendation || recommendation.recommendedChange.kind !== "prefer-model") {
      notify(ctx, "That bounded prefer-model recommendation is no longer available; run /lifecycle-routing-report again.", "error");
      return;
    }
    if (!ctx.hasUI || !(await ctx.ui.confirm(
      "Apply routing recommendation to trusted user config?",
      `${recommendation.expectedTradeoff}\n\nThis writes only routing.stages.${recommendation.stage}.prefer in ~/.ai-orchestrator/config.json and creates a rollback record.`,
    ))) return;

    const configPath = join(homedir(), ".ai-orchestrator", "config.json");
    const raw = readUserConfigObject(configPath);
    const routing = objectChild(raw, "routing");
    const stages = objectChild(routing, "stages");
    const stage = objectChild(stages, recommendation.stage);
    const previousPrefer = Array.isArray(stage.prefer) ? stage.prefer.filter((value): value is string => typeof value === "string") : [];
    const identity = `${recommendation.recommendedChange.provider}/${recommendation.recommendedChange.model}`;
    const appliedPrefer = [identity, ...previousPrefer.filter((value) => value !== identity)];
    stage.prefer = appliedPrefer;
    const previousVersion = typeof routing.version === "string" ? routing.version : undefined;
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    routing.version = `recommendation-${id}`;
    writeUserJson(configPath, raw);
    writeUserJson(join(userStoreRoot, "recommendations", `${id}.json`), {
      version: 1, id, status: "applied", appliedAt: new Date().toISOString(), stage: recommendation.stage,
      identity, previousPrefer, appliedPrefer, previousVersion, appliedVersion: routing.version,
    });
    notify(ctx, `Applied routing recommendation ${id}. Roll back with /lifecycle-routing-rollback ${id}.`, "info");
  }

  async function rollbackRoutingRecommendation(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const id = args.trim();
    if (!/^\d+-[a-f0-9-]{8}$/i.test(id)) {
      notify(ctx, "Usage: /lifecycle-routing-rollback <recommendation-id>", "error");
      return;
    }
    const config = loadPiConfig(ctx.cwd);
    const userStoreRoot = resolveUserEvidenceRoot(undefined, config.routing.evidence.userStoreDir);
    const recordPath = join(userStoreRoot, "recommendations", `${id}.json`);
    const record = readUserConfigObject(recordPath) as Record<string, unknown>;
    if (record.status !== "applied" || typeof record.stage !== "string" || !Array.isArray(record.previousPrefer) || !Array.isArray(record.appliedPrefer)) {
      notify(ctx, `Recommendation ${id} is unavailable or already rolled back.`, "error");
      return;
    }
    if (!ctx.hasUI || !(await ctx.ui.confirm("Rollback routing recommendation?", `Restore the previous trusted user preference list for ${record.stage}?`))) return;
    const configPath = join(homedir(), ".ai-orchestrator", "config.json");
    const raw = readUserConfigObject(configPath);
    const routing = objectChild(raw, "routing");
    const stages = objectChild(routing, "stages");
    const stage = objectChild(stages, record.stage);
    if (JSON.stringify(stage.prefer ?? []) !== JSON.stringify(record.appliedPrefer)) {
      notify(ctx, "Current user preferences changed after application; refusing an unsafe automatic rollback.", "error");
      return;
    }
    stage.prefer = record.previousPrefer;
    if (typeof record.previousVersion === "string") routing.version = record.previousVersion;
    else delete routing.version;
    writeUserJson(configPath, raw);
    writeUserJson(recordPath, { ...record, status: "rolled-back", rolledBackAt: new Date().toISOString() });
    notify(ctx, `Rolled back routing recommendation ${id}.`, "info");
  }

  function readUserConfigObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked user policy file: ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`User policy file must contain a JSON object: ${path}`);
    return parsed as Record<string, unknown>;
  }

  function objectChild(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const current = parent[key];
    if (current && typeof current === "object" && !Array.isArray(current)) return current as Record<string, unknown>;
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }

  function writeUserJson(path: string, value: Record<string, unknown>): void {
    const directory = join(path, "..");
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing symlinked user policy directory: ${directory}`);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked user policy file: ${path}`);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  }

  async function startPipeline(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (runtime) {
      notify(ctx, "A lifecycle operation is already active or restoring its model in this Pi session.", "warning");
      return;
    }
    if (hasActiveFastPath(ctx)) {
      notify(ctx, "A /orchestrate fast-path run is active in this session. Stop it before starting lifecycle.", "error");
      return;
    }
    const parsed = parseTaskArgs(args);
    if (!parsed.task) {
      notify(ctx, "Usage: /lifecycle [--yolo] <task> or /lifecycle resume", "error");
      return;
    }
    if (loadCurrent(ctx.cwd)?.state && isActivePhase(loadCurrent(ctx.cwd)!.state.phase)) {
      notify(ctx, "A lifecycle run is already active. Use /lifecycle resume or /lifecycle-stop.", "error");
      return;
    }

    const resolved = loadPiResolvedConfig(ctx.cwd);
    const config = resolved.config;
    const yolo = parsed.yolo || pi.getFlag("lifecycle-yolo") === true;
    const created = createRun(ctx.cwd, config.lifecycle.artifactsDir, parsed.task, yolo);
    const state = readState(created.paths);
    if (!state) throw new Error("new lifecycle state could not be read");
    state.originalModel = currentModelState(ctx);
    writeState(created.paths, state);
    runtime = makeRuntime(config, resolved.provenance, ctx.cwd, created.paths, state, true, undefined, currentModelState(ctx));
    const baseline = await workingTreeStatus(ctx);
    if (!ownsRun(state.runId, "defining")) return;
    runtime.state.baselinePaths = baseline?.paths;
    runtime.state.baselineStagedPaths = baseline?.stagedPaths;
    writeState(created.paths, runtime.state);
    appendJournal(created.paths, "Lifecycle pipeline started");
    persistMirror(state);
    await runCurrentPhase(ctx);
  }

  async function startSpec(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (runtime) {
      notify(ctx, "A lifecycle operation is already active or restoring its model in this Pi session.", "warning");
      return;
    }
    if (hasActiveFastPath(ctx)) {
      notify(ctx, "A /orchestrate fast-path run is active in this session. Stop it before starting lifecycle.", "error");
      return;
    }
    const parsed = parseTaskArgs(args);
    if (!parsed.task) {
      notify(ctx, "Usage: /spec [--yolo] <idea>", "error");
      return;
    }
    const active = loadCurrent(ctx.cwd);
    if (active && isActivePhase(active.state.phase)) {
      notify(ctx, `Run ${active.state.runId} is already at ${active.state.phase}.`, "error");
      return;
    }

    const resolved = loadPiResolvedConfig(ctx.cwd);
    const config = resolved.config;
    const yolo = parsed.yolo || pi.getFlag("lifecycle-yolo") === true;
    const created = createRun(ctx.cwd, config.lifecycle.artifactsDir, parsed.task, yolo);
    const state = readState(created.paths);
    if (!state) throw new Error("new lifecycle state could not be read");
    state.originalModel = currentModelState(ctx);
    writeState(created.paths, state);
    runtime = makeRuntime(config, resolved.provenance, ctx.cwd, created.paths, state, false, "spec", currentModelState(ctx));
    const baseline = await workingTreeStatus(ctx);
    if (!ownsRun(state.runId, "defining")) return;
    runtime.state.baselinePaths = baseline?.paths;
    runtime.state.baselineStagedPaths = baseline?.stagedPaths;
    writeState(created.paths, runtime.state);
    appendJournal(created.paths, "Standalone DEFINE started");
    persistMirror(state);
    await runCurrentPhase(ctx);
  }

  async function migrateRoutingPolicy(ctx: ExtensionCommandContext): Promise<void> {
    if (runtime) {
      notify(ctx, "Pause or stop the active lifecycle turn before migrating its routing policy.", "warning");
      return;
    }
    const loaded = loadCurrent(ctx.cwd);
    if (!loaded || !isActivePhase(loaded.state.phase)) {
      notify(ctx, "No active lifecycle run is available for routing migration.", "error");
      return;
    }
    const leaseOwner = randomUUID();
    try {
      acquireRunLease(loaded.paths, leaseOwner);
    } catch {
      notify(ctx, "Lifecycle run is executing in another Pi process; routing migration was not applied.", "warning");
      return;
    }
    try {
      if (!ctx.hasUI || !(await ctx.ui.confirm(
        "Migrate lifecycle routing policy?",
        "This explicitly adopts the current trusted routing and role configuration for the unfinished phase. Completed routing evidence remains unchanged.",
      ))) return;
      if (!ownsRunLease(loaded.paths, leaseOwner)) return;
      const resolved = loadPiResolvedConfig(ctx.cwd);
      const nextVersion = piRoutingRunVersion(resolved.config, resolved.provenance);
      const latest = readState(loaded.paths);
      if (!latest || latest.runId !== loaded.state.runId || !isActivePhase(latest.phase)) {
        notify(ctx, "Lifecycle state changed before routing migration; retry after inspecting the active run.", "warning");
        return;
      }
      const entryKey = currentPhaseEntryKey(latest);
      const saved = [...latest.modelSelections].reverse().find((selection) =>
        selection.routing?.phaseEntryKey === entryKey && !selection.routing.failureCategories.includes("policy-migrated"));
      if (saved?.routing) saved.routing.failureCategories.push("policy-migrated");
      latest.routingPolicyVersion = nextVersion;
      writeState(loaded.paths, latest);
      appendJournal(loaded.paths, `Routing policy explicitly migrated for unfinished phase to ${nextVersion}`);
      persistMirror(latest);
      notify(ctx, "Lifecycle routing policy migrated. Use /lifecycle resume to continue.", "info");
    } finally {
      releaseRunLease(loaded.paths, leaseOwner);
    }
  }

  async function resumeRun(ctx: ExtensionCommandContext): Promise<void> {
    if (runtime) {
      notify(ctx, "A lifecycle operation is already active or restoring its model in this Pi session.", "warning");
      return;
    }
    if (hasActiveFastPath(ctx)) {
      notify(ctx, "A /orchestrate fast-path run is active in this session. Stop it before resuming lifecycle.", "error");
      return;
    }
    const loaded = loadCurrent(ctx.cwd);
    if (!loaded) {
      notify(ctx, "No lifecycle run is available to resume.", "error");
      return;
    }
    const resolved = loadPiResolvedConfig(ctx.cwd);
    if (!isActivePhase(loaded.state.phase)) {
      if (loaded.state.modelRestored !== false) {
        notify(ctx, `Lifecycle run ${loaded.state.runId} is ${loaded.state.phase}; it cannot be resumed.`, "info");
        return;
      }
      runtime = makeRuntime(resolved.config, resolved.provenance, ctx.cwd, loaded.paths, loaded.state, true, undefined, currentModelState(ctx));
      restoreTools();
      const restored = await restoreRuntimeModel(ctx);
      if (restored) {
        releaseRun(runtime.cwd, runtime.config.lifecycle.artifactsDir, loaded.state.runId);
        notify(ctx, "Original lifecycle model restored; terminal run ownership released.", "info");
      } else {
        notify(ctx, "Original-model restoration is still pending. Fix model availability and run /lifecycle resume again.", "warning");
      }
      releaseRuntimeLease();
      runtime = undefined;
      deactivateVerdictTools();
      clearUi(ctx);
      return;
    }
    const config = resolved.config;
    if (!loaded.state.originalModel) {
      loaded.state.originalModel = currentModelState(ctx);
      writeState(loaded.paths, loaded.state);
    }
    runtime = makeRuntime(config, resolved.provenance, ctx.cwd, loaded.paths, loaded.state, true, undefined, currentModelState(ctx));
    appendJournal(loaded.paths, `Resumed at ${loaded.state.phase}`);
    persistMirror(loaded.state);
    await runCurrentPhase(ctx);
  }

  async function startStandalone(
    stage: StandaloneStage,
    expected: LifecyclePhase | readonly LifecyclePhase[],
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (runtime) {
      notify(ctx, "A lifecycle operation is already active or restoring its model in this Pi session.", "warning");
      return;
    }
    if (hasActiveFastPath(ctx)) {
      notify(ctx, "A /orchestrate fast-path run is active in this session. Stop it before running a lifecycle stage.", "error");
      return;
    }
    const loaded = loadCurrent(ctx.cwd);
    if (!loaded) {
      notify(ctx, `No lifecycle run exists. Start with /spec <idea> or /lifecycle <task>.`, "error");
      return;
    }
    const expectedPhases = Array.isArray(expected) ? expected : [expected];
    if (!expectedPhases.includes(loaded.state.phase)) {
      notify(ctx, `Run ${loaded.state.runId} is at ${loaded.state.phase}; next command is ${nextCommand(loaded.state.phase)}.`, "error");
      return;
    }
    const resolved = loadPiResolvedConfig(ctx.cwd);
    const config = resolved.config;
    if (!loaded.state.originalModel) loaded.state.originalModel = currentModelState(ctx);
    writeState(loaded.paths, loaded.state);
    runtime = makeRuntime(config, resolved.provenance, ctx.cwd, loaded.paths, loaded.state, false, stage, currentModelState(ctx));
    appendJournal(loaded.paths, `Standalone ${stage.toUpperCase()} started`);
    persistMirror(loaded.state);
    await runCurrentPhase(ctx);
  }

  function makeRuntime(
    config: OrchestratorConfig,
    provenance: ConfigProvenance,
    cwd: string,
    paths: RunPaths,
    state: LifecycleState,
    automatic: boolean,
    standalone: StandaloneStage | undefined,
    invocationOriginal: LifecycleState["originalModel"],
  ): Runtime {
    const leaseOwner = randomUUID();
    acquireRunLease(paths, leaseOwner);
    return {
      config,
      provenance,
      cwd,
      paths,
      state,
      automatic,
      standalone,
      toolsBeforeRun: pi.getActiveTools().filter((name) => !VERDICT_TOOLS.has(name)),
      invocationOriginal,
      attemptedModels: [],
      leaseOwner,
    };
  }

  async function runCurrentPhase(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    assertRunPathsSafe(runtime.paths);
    runtime.pendingVerdict = undefined;
    runtime.pendingDiagnosis = undefined;
    runtime.remindedPhase = undefined;
    switch (runtime.state.phase) {
      case "defining":
        if (!(await enterRoutedStage("define", "spec", ctx))) return;
        activateArtifactTools();
        updateUi(ctx);
        sendPrompt(specPrompt(runtime.state.task, rel(runtime.paths.spec), undefined, runtime.specRevisionFeedback));
        break;
      case "awaiting_spec_approval":
        await requestArtifactApproval(ctx, "spec");
        break;
      case "planning": {
        const spec = readRequired(runtime.paths.spec, "spec");
        if (!(await enterRoutedStage("plan", "planner", ctx))) return;
        activateArtifactTools();
        updateUi(ctx);
        sendPrompt(taskPlanPrompt(spec, rel(runtime.paths.plan), runtime.planRevisionFeedback ?? replanFeedback()));
        break;
      }
      case "awaiting_plan_approval":
        await requestArtifactApproval(ctx, "plan");
        break;
      case "building":
        await enterBuild(ctx);
        break;
      case "verifying": {
        const spec = readRequired(runtime.paths.spec, "spec");
        const plan = readRequired(runtime.paths.plan, "plan");
        if (!(await enterRoutedStage("verify", "verifier", ctx))) return;
        activateReadOnlyTools("verify_verdict");
        updateUi(ctx);
        sendPrompt(verifyPrompt(spec, plan, runtime.config.judge.runTests ? detectTestCommand(runtime.cwd) : undefined));
        break;
      }
      case "reviewing": {
        const spec = readRequired(runtime.paths.spec, "spec");
        const plan = readRequired(runtime.paths.plan, "plan");
        if (!(await enterRoutedStage("review", "reviewer", ctx))) return;
        activateReadOnlyTools("review_verdict");
        updateUi(ctx);
        sendPrompt(reviewPrompt(spec, plan));
        break;
      }
      case "debugging": {
        const rejectionIndex = latestRejectionIndex();
        if (runtime.state.debugDiagnosisVerdictIndex === rejectionIndex && isNonEmpty(runtime.paths.debug)) {
          await transition({ type: "debug_produced", debugPath: rel(runtime.paths.debug) }, "Recovered durable DEBUG diagnosis", ctx);
          if (!runtime) return;
          const recoveredPhase = runtime.state.phase as LifecyclePhase;
          if (recoveredPhase === "failed") await finishRun(ctx);
          else await continueOrPause(ctx, nextStandaloneForPhase(recoveredPhase));
          break;
        }
        const spec = readRequired(runtime.paths.spec, "spec");
        const plan = readRequired(runtime.paths.plan, "plan");
        runtime.state.debugDiagnosisVerdictIndex = undefined;
        writeState(runtime.paths, runtime.state);
        assertRunPathsSafe(runtime.paths);
        writeFileSync(runtime.paths.debug, "");
        if (!(await enterRoutedStage("debug", "debugger", ctx))) return;
        activateReadOnlyTools("debug_diagnosis");
        updateUi(ctx);
        sendPrompt(debugPrompt(
          spec,
          plan,
          latestRejection(),
          rel(runtime.paths.debug),
        ));
        break;
      }
      case "shipping": {
        const spec = readRequired(runtime.paths.spec, "spec");
        const plan = readRequired(runtime.paths.plan, "plan");
        if (!(await enterRoutedStage("ship", "shipper", ctx))) return;
        activateReadOnlyTools("ship_decision");
        updateUi(ctx);
        sendPrompt(shipPrompt(spec, plan, runtime.state.verdicts));
        break;
      }
      case "awaiting_ship_approval":
        await requestShipApproval(ctx);
        break;
      case "finalizing":
        await finalizeRun(ctx);
        break;
      case "done":
      case "failed":
        await finishRun(ctx);
        break;
      case "idle":
        notify(ctx, "Lifecycle is idle.", "info");
        break;
      default:
        assertNever(runtime.state.phase);
    }
  }

  async function enterBuild(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    const breaker = convergenceBreakerReason(runtime.state, runtime.config);
    if (breaker) {
      await interruptRun(ctx, `Lifecycle BUILD paused by convergence circuit breaker: ${breaker}`);
      return;
    }
    const plan = readRequired(runtime.paths.plan, "plan");
    restoreBuildTools();
    if (!(await enterModelStage("build", "coder", ctx))) return;
    updateUi(ctx);
    sendPrompt(buildPrompt(plan, buildFeedback(), runtime.config.build.commitPerTask));
  }

  async function enterRoutedStage(stage: LifecycleRoutedStage, role: RoleName, ctx: ExtensionContext): Promise<boolean> {
    return enterModelStage(stage, role, ctx);
  }

  async function enterModelStage(stage: LifecycleRoutedStage | "build", role: RoleName, ctx: ExtensionContext): Promise<boolean> {
    if (!runtime) return false;
    const runPolicyVersion = piRoutingRunVersion(runtime.config, runtime.provenance);
    if (runtime.state.routingPolicyVersion && runtime.state.routingPolicyVersion !== runPolicyVersion) {
      await interruptRun(ctx, `Lifecycle routing policy changed from ${runtime.state.routingPolicyVersion} to ${runPolicyVersion}. Restore the saved policy or explicitly migrate the run before resuming.`);
      return false;
    }
    if (!runtime.state.routingPolicyVersion) {
      runtime.state.routingPolicyVersion = runPolicyVersion;
      writeState(runtime.paths, runtime.state);
      appendJournal(runtime.paths, `Routing policy frozen for run: ${runPolicyVersion}`);
    }
    const available = ctx.modelRegistry.getAvailable();
    const expectedRunId = runtime.state.runId;
    const expectedPhase = runtime.state.phase;
    const evidence = await routingEvidence(ctx);
    if (!ownsRun(expectedRunId, expectedPhase)) return false;
    const plan = createPiRoutingPlan({
      config: runtime.config,
      provenance: runtime.provenance,
      stage,
      role,
      available,
      evidence,
      priorSelections: runtime.state.modelSelections.map((selection) => ({
        stage: selection.stage,
        provider: selection.provider,
        model: selection.model,
        ...(selection.family ? { family: selection.family } : {}),
      })),
    });
    const phaseEntryKey = currentPhaseEntryKey(runtime.state);
    const saved = [...runtime.state.modelSelections].reverse().find((selection) =>
      selection.stage === stage && selection.routing?.phaseEntryKey === phaseEntryKey
      && !selection.routing.failureCategories.some((category) => category === "provider-error" || category === "policy-migrated"));
    if (saved) {
      if (saved.routing!.policyVersion !== plan.policyVersion || saved.routing!.engine !== plan.engine) {
        await modelFailure(ctx, stage, [`saved decision ${saved.routing!.decisionId} uses a different routing policy`]);
        throw new Error(`saved routing policy for ${stage} no longer matches`);
      }
      const eligible = plan.candidates.some((candidate) => candidate.provider === saved.provider && candidate.model === saved.model);
      const model = eligible ? ctx.modelRegistry.find(saved.provider, saved.model) : undefined;
      const expectedRunId = runtime.state.runId;
      const expectedPhase = runtime.state.phase;
      if (!model || !(await pi.setModel(model))) {
        if (!ownsRun(expectedRunId, expectedPhase)) return false;
        await modelFailure(ctx, stage, [`saved selection ${saved.provider}/${saved.model} is unavailable or ineligible`]);
        return false;
      }
      if (!ownsRun(expectedRunId, expectedPhase)) return false;
      pi.setThinkingLevel(saved.thinking);
      runtime.state.modelRestored = false;
      writeState(runtime.paths, runtime.state);
      appendJournal(runtime.paths, `Model ${stage}: reused saved decision ${saved.routing!.decisionId} (${saved.provider}/${saved.model})`);
      return true;
    }

    runtime.attemptedModels = [];
    const providerFailed = new Set(runtime.state.modelSelections
      .filter((selection) => selection.stage === stage && selection.routing?.failureCategories.includes("provider-error"))
      .map((selection) => `${selection.provider}/${selection.model}`));
    const attempts: { provider: string; model: string; outcome: "selected" | "unavailable" | "unconfigured" }[] = [];
    for (const candidate of plan.candidates) {
      if (providerFailed.has(`${candidate.provider}/${candidate.model}`)) continue;
      const label = `${candidate.provider}/${candidate.model}`;
      if (breakerBlocksCandidate(stage, candidate, attempts)) {
        attempts.push({ provider: candidate.provider, model: candidate.model, outcome: "unavailable" });
        continue;
      }
      const budgetAllowed = await enforceCandidateBudget(stage, candidate, ctx);
      if (!budgetAllowed) {
        persistRoutingTrace(stage, plan, attempts);
        return false;
      }
      runtime.attemptedModels.push(label);
      const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
      if (!model) {
        attempts.push({ provider: candidate.provider, model: candidate.model, outcome: "unconfigured" });
        continue;
      }
      const expectedRunId = runtime.state.runId;
      const expectedPhase = runtime.state.phase;
      const activated = await pi.setModel(model);
      if (!runtime || !ownsRun(expectedRunId, expectedPhase)) return false;
      if (!activated) {
        attempts.push({ provider: candidate.provider, model: candidate.model, outcome: "unavailable" });
        continue;
      }
      attempts.push({ provider: candidate.provider, model: candidate.model, outcome: "selected" });
      pi.setThinkingLevel(candidate.thinking);
      recordModelSelection(stage, candidate, plan, attempts);
      return true;
    }
    persistRoutingTrace(stage, plan, attempts);
    await modelFailure(ctx, stage, runtime.attemptedModels.length > 0 ? runtime.attemptedModels : plan.decision?.excluded.map((item) => `${item.identity.provider}/${item.identity.model}: ${item.code}`) ?? []);
    return false;
  }

  function recordModelSelection(
    stage: LifecycleRoutedStage | "build",
    candidate: PiRoutingCandidate,
    plan: PiRoutingPlan,
    attempts: readonly { provider: string; model: string; outcome: "selected" | "unavailable" | "unconfigured" }[],
  ): void {
    if (!runtime) return;
    const decisionId = `${runtime.state.runId}:${stage}:${runtime.state.modelSelections.length + 1}`;
    const builder = [...runtime.state.modelSelections].reverse().find((selection) => selection.stage === "build");
    const separation = !builder || stage === "build" ? "not-applicable"
      : builder.family && candidate.family && builder.family !== candidate.family ? "different-family" : "different-model";
    const fallbackCount = attempts.filter((attempt) => attempt.outcome !== "selected").length;
    const reason = `${candidate.reason}${fallbackCount > 0 ? `; fallback count ${fallbackCount}` : ""}`;
    runtime.state.modelRestored = false;
    runtime.state.modelSelections.push({
      stage,
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.family ? { family: candidate.family } : {}),
      thinking: candidate.thinking,
      reason,
      selectedAt: new Date().toISOString(),
      routing: {
        decisionId,
        engine: plan.engine,
        policyVersion: plan.policyVersion,
        ...(candidate.profileVersion ? { profileVersion: candidate.profileVersion } : {}),
        taskFeaturesHash: plan.taskFeaturesHash,
        phaseEntryKey: currentPhaseEntryKey(runtime.state),
        selectedRank: candidate.rank,
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
        separation,
        fallbackCount,
        attemptedModels: attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
        failureCategories: attempts.filter((attempt) => attempt.outcome !== "selected").map((attempt) => attempt.outcome),
      },
    });
    writeState(runtime.paths, runtime.state);
    persistRoutingTrace(stage, plan, attempts, decisionId);
    persistRoutingEvidence(stage, candidate, plan, decisionId);
    appendJournal(runtime.paths, `Model ${stage}: ${candidate.provider}/${candidate.model} (${candidate.thinking}) — ${reason}; ${separation}; ${plan.engine}`);
    persistMirror(runtime.state);
  }

  function persistRoutingTrace(
    stage: LifecycleRoutedStage | "build",
    plan: PiRoutingPlan,
    attempts: readonly { provider: string; model: string; outcome: "selected" | "unavailable" | "unconfigured" }[],
    decisionId = `${runtime?.state.runId ?? "unknown"}:${stage}:failed`,
  ): void {
    if (!runtime) return;
    appendRoutingTrace(runtime.paths, {
      decisionId,
      runId: runtime.state.runId,
      stage,
      recordedAt: new Date().toISOString(),
      plan,
      attempts,
    });
  }

  async function enforceCandidateBudget(
    stage: LifecycleRoutedStage | "build",
    candidate: PiRoutingCandidate,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (!runtime) return false;
    const estimate: RoutingCostEstimate = candidate.estimatedCostUsd === undefined
      ? { status: "unknown", reason: "candidate cost metadata unavailable" }
      : { status: "known", estimatedUsd: candidate.estimatedCostUsd };
    const decision = enforceRoutingBudget({
      stage,
      estimate,
      budgets: runtime.config.routing.budgets,
      snapshot: routingBudgetSnapshot(),
      unattended: !ctx.hasUI,
    });
    if (decision.allowed === true) return true;
    if (decision.allowed === "ask") {
      const expectedRunId = runtime.state.runId;
      const expectedPhase = runtime.state.phase;
      const confirmed = ctx.hasUI && await ctx.ui.confirm("Routing budget warning", `${decision.reason}\n\nContinue with ${candidate.provider}/${candidate.model}?`);
      if (!ownsRun(expectedRunId, expectedPhase)) return false;
      if (confirmed) return true;
    }
    await interruptRun(ctx, `Lifecycle ${stage} paused by routing budget: ${decision.reason}`);
    return false;
  }

  function breakerBlocksCandidate(
    stage: LifecycleRoutedStage | "build",
    candidate: PiRoutingCandidate,
    attempts: readonly { provider: string; model: string; outcome: "selected" | "unavailable" | "unconfigured" }[],
  ): boolean {
    if (!runtime) return false;
    const failedAttempts = attempts.filter((attempt) => attempt.outcome !== "selected").length;
    if (failedAttempts >= runtime.config.routing.circuitBreakers.maxSelectionFailures) return true;
    const projectedFallbacks = routingBudgetSnapshot().paidFallbacks + failedAttempts;
    if (projectedFallbacks > runtime.config.routing.budgets.maxPaidFallbacksPerRun) return true;
    if (!runtime.config.routing.circuitBreakers.requireIndependentChecker || !isCheckerRoutingStage(stage)) return false;
    const builder = [...runtime.state.modelSelections].reverse().find((selection) => selection.stage === "build");
    return Boolean(builder && builder.provider === candidate.provider && builder.model === candidate.model);
  }

  function routingBudgetSnapshot(): RoutingBudgetSnapshot {
    if (!runtime) {
      return { estimatedRunUsd: 0, observedRunUsd: 0, estimatedDayUsd: 0, observedDayUsd: 0, paidFallbacks: 0, attemptsByStage: {} };
    }
    const userRoot = resolveUserEvidenceRoot(undefined, runtime.config.routing.evidence.userStoreDir);
    const ledger = readRoutingBudgetLedger(join(userRoot, "budget.jsonl"));
    const runEvents = ledger.filter((event) => event.runId === runtime!.state.runId);
    const today = new Date().toISOString().slice(0, 10);
    const dailyEvents = ledger.filter((event) => event.recordedAt.startsWith(today));
    const snapshot: RoutingBudgetSnapshot = {
      estimatedRunUsd: 0,
      observedRunUsd: 0,
      estimatedDayUsd: dailyEvents.reduce((sum, event) => sum + (event.outcome === "stage-started" ? event.estimatedUsd ?? 0 : 0), 0),
      observedDayUsd: dailyEvents.reduce((sum, event) => sum + (event.outcome === "stage-ended" ? event.observedUsd ?? 0 : 0), 0),
      paidFallbacks: runtime.state.modelSelections.reduce((sum, selection) => sum + (selection.routing?.fallbackCount ?? 0), 0),
      attemptsByStage: {},
    };
    for (const event of runEvents) {
      if (event.outcome === "stage-started") snapshot.estimatedRunUsd += event.estimatedUsd ?? 0;
      if (event.outcome === "stage-ended") snapshot.observedRunUsd += event.observedUsd ?? 0;
    }
    for (const selection of runtime.state.modelSelections) {
      snapshot.attemptsByStage[selection.stage] = (snapshot.attemptsByStage[selection.stage] ?? 0) + 1;
    }
    return snapshot;
  }

  function persistRoutingEvidence(
    stage: LifecycleRoutedStage | "build",
    candidate: PiRoutingCandidate,
    plan: PiRoutingPlan,
    decisionId: string,
  ): void {
    if (!runtime) return;
    const userStoreRoot = resolveUserEvidenceRoot(undefined, runtime.config.routing.evidence.userStoreDir);
    appendRoutingBudgetLedgerEvent(userStoreRoot, {
      version: 1,
      eventId: `${decisionId}:budget:stage-started`,
      runId: runtime.state.runId,
      recordedAt: new Date().toISOString(),
      outcome: "stage-started",
      ...(candidate.estimatedCostUsd === undefined ? {} : { estimatedUsd: candidate.estimatedCostUsd }),
    });
    if (!runtime.config.routing.evidence.enabled) return;
    appendRoutingEvidenceEvent({
      runPaths: runtime.paths,
      userStoreRoot,
      event: {
        version: 1,
        eventId: `${decisionId}:stage-started`,
        runId: runtime.state.runId,
        decisionId,
        stage,
        recordedAt: new Date().toISOString(),
        policyVersion: plan.policyVersion,
        profileVersion: candidate.profileVersion ?? "legacy-role",
        task: {
          workKind: plan.taskFeatures.workKind,
          risk: plan.taskFeatures.risk,
          languages: [...plan.taskFeatures.languages],
          fileCount: plan.taskFeatures.fileCount,
        },
        selected: {
          provider: candidate.provider,
          model: candidate.model,
          ...(candidate.family ? { family: candidate.family } : {}),
        },
        durationMs: "unknown",
        fallbackCount: runtime.state.modelSelections.at(-1)?.routing?.fallbackCount ?? 0,
        usage: {
          inputTokens: "unknown",
          outputTokens: "unknown",
          cacheReadTokens: "unknown",
          cacheWriteTokens: "unknown",
        },
        cost: {
          estimatedUsd: candidate.estimatedCostUsd ?? "unknown",
          observedUsd: "unknown",
        },
        outcome: {
          type: "stage-started",
          structuredToolCompliance: "unknown",
          verdict: "unknown",
          buildIteration: runtime.state.buildIterations,
        },
      },
    });
  }

  function persistRoutingStageOutcome(
    stage: LifecycleRoutedStage | "build",
    outcome: { type?: "stage-ended" | "final-status"; structuredToolCompliance: boolean | "unknown"; verdict: "approve" | "reject" | "unknown"; finalRunStatus?: "done" | "failed" | "cancelled" },
  ): void {
    if (!runtime) return;
    const selection = [...runtime.state.modelSelections].reverse().find((item) => item.stage === stage && item.routing);
    if (!selection?.routing) return;
    const usage = outcome.type === "final-status" ? undefined : runtime.lastUsage;
    const userStoreRoot = resolveUserEvidenceRoot(undefined, runtime.config.routing.evidence.userStoreDir);
    if (outcome.type !== "final-status") {
      appendRoutingBudgetLedgerEvent(userStoreRoot, {
        version: 1,
        eventId: `${selection.routing.decisionId}:budget:stage-ended:${runtime.state.buildIterations}:${runtime.state.verdicts.length}`,
        runId: runtime.state.runId,
        recordedAt: new Date().toISOString(),
        outcome: "stage-ended",
        ...(usage ? { observedUsd: usage.observedUsd } : {}),
      });
    }
    if (!runtime.config.routing.evidence.enabled) {
      if (outcome.type !== "final-status") runtime.lastUsage = undefined;
      return;
    }
    const started = readRoutingEvidenceEvents(runtime.paths.evidence).events.find((event) =>
      event.decisionId === selection.routing!.decisionId && event.outcome.type === "stage-started");
    appendRoutingEvidenceEvent({
      runPaths: runtime.paths,
      userStoreRoot,
      event: {
        version: 1,
        eventId: `${selection.routing.decisionId}:${outcome.type ?? "stage-ended"}:${runtime.state.buildIterations}:${runtime.state.verdicts.length}`,
        runId: runtime.state.runId,
        decisionId: selection.routing.decisionId,
        stage,
        recordedAt: new Date().toISOString(),
        policyVersion: selection.routing.policyVersion,
        profileVersion: selection.routing.profileVersion ?? "legacy-role",
        task: started?.task ?? { workKind: "unknown", risk: "medium", languages: [], fileCount: 0 },
        selected: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.family ? { family: selection.family } : {}),
        },
        durationMs: Math.max(0, Date.now() - Date.parse(selection.selectedAt)),
        fallbackCount: selection.routing.fallbackCount,
        ...(outcome.verdict === "reject" ? { rejectionCategory: `${stage}-reject` } : {}),
        usage: {
          inputTokens: usage?.inputTokens ?? "unknown",
          outputTokens: usage?.outputTokens ?? "unknown",
          cacheReadTokens: usage?.cacheReadTokens ?? "unknown",
          cacheWriteTokens: usage?.cacheWriteTokens ?? "unknown",
        },
        cost: {
          estimatedUsd: started?.cost.estimatedUsd ?? "unknown",
          observedUsd: usage?.observedUsd ?? "unknown",
        },
        outcome: {
          type: outcome.type ?? "stage-ended",
          structuredToolCompliance: outcome.structuredToolCompliance,
          verdict: outcome.verdict,
          buildIteration: runtime.state.buildIterations,
          ...(outcome.finalRunStatus ? { finalRunStatus: outcome.finalRunStatus } : {}),
        },
      },
    });
    if (outcome.type !== "final-status") runtime.lastUsage = undefined;
  }

  async function recordBuildEvidenceFingerprint(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    const active = runtime;
    const runId = active.state.runId;
    const [diff, untracked] = await Promise.all([
      pi.exec("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], { timeout: 20_000, signal: ctx.signal }),
      pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { timeout: 10_000, signal: ctx.signal }),
    ]);
    if (runtime !== active || !ownsRun(runId, "building")) return;
    const evidence = `${diff.code}:${diff.stdout}\n${diff.stderr}\n${untracked.code}:${untracked.stdout}\n${untracked.stderr}`;
    active.state.buildEvidenceFingerprints.push(convergenceFingerprint(evidence));
    writeState(active.paths, active.state);
    appendJournal(active.paths, `BUILD convergence fingerprint recorded for pass ${active.state.buildIterations + 1}`);
  }

  function convergenceBreakerReason(state: LifecycleState, config: OrchestratorConfig): string | undefined {
    const repeatedRejections = trailingEqualCount(state.rejectionFingerprints);
    if (repeatedRejections >= config.routing.circuitBreakers.repeatedRejectionFingerprintLimit) {
      return `${repeatedRejections} identical checker rejections reached the configured limit; inspect debug.md and re-plan with new evidence.`;
    }
    const unchangedBuilds = Math.max(0, trailingEqualCount(state.buildEvidenceFingerprints) - 1);
    if (unchangedBuilds >= config.routing.circuitBreakers.maxBuildPassesWithoutImprovement) {
      return `${unchangedBuilds} consecutive BUILD passes produced unchanged evidence; inspect the diff and re-plan before spending another pass.`;
    }
    return undefined;
  }

  function trailingEqualCount(values: readonly string[]): number {
    const latest = values.at(-1);
    if (!latest) return 0;
    let count = 0;
    for (let index = values.length - 1; index >= 0 && values[index] === latest; index -= 1) count += 1;
    return count;
  }

  function convergenceFingerprint(value: string): string {
    return createHash("sha256").update(value.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 16);
  }

  function persistDownstreamReversal(stage: "verify" | "review", reason: string): void {
    if (!runtime?.config.routing.evidence.enabled) return;
    const selection = [...runtime.state.modelSelections].reverse().find((item) => item.stage === stage && item.routing);
    if (!selection?.routing) return;
    const started = readRoutingEvidenceEvents(runtime.paths.evidence).events.find((event) =>
      event.decisionId === selection.routing!.decisionId && event.outcome.type === "stage-started");
    if (!started) return;
    appendRoutingEvidenceEvent({
      runPaths: runtime.paths,
      userStoreRoot: resolveUserEvidenceRoot(undefined, runtime.config.routing.evidence.userStoreDir),
      event: {
        ...started,
        eventId: `${selection.routing.decisionId}:downstream-reversal:${runtime.state.verdicts.length}`,
        recordedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(selection.selectedAt)),
        rejectionCategory: "downstream-reversal",
        usage: { inputTokens: "unknown", outputTokens: "unknown", cacheReadTokens: "unknown", cacheWriteTokens: "unknown" },
        cost: { estimatedUsd: started.cost.estimatedUsd, observedUsd: "unknown" },
        outcome: {
          type: "stage-ended",
          structuredToolCompliance: true,
          verdict: "reject",
          laterReversal: true,
          buildIteration: runtime.state.buildIterations,
        },
      },
    });
    appendJournal(runtime.paths, `${stage.toUpperCase()} downstream outcome reversed: ${truncate(reason, 120)}`);
  }

  function isBlockedBuildCommand(command: string, artifactsDir: string, metadataRoot: string): boolean {
    const normalized = command.replace(/\\(?:\r?\n)?/g, "").replace(/["']/g, " ");
    return PUBLICATION_COMMAND.test(normalized) || DESTRUCTIVE_GIT_COMMAND.test(normalized) ||
      normalized.includes(artifactsDir) || normalized.includes(metadataRoot) || normalized.includes(".ai-orchestrator") ||
      /\brm\b[\s\S]*?(?:\s\.\/?(?:\s|$)|\s\*|\/\*)/i.test(normalized) ||
      /\bfind\b[\s\S]*?\s-delete\b/i.test(normalized);
  }

  function currentPhaseEntryKey(state: LifecycleState): string {
    return `${state.phase}:${state.buildIterations}:${state.verdicts.length}:${state.debugDiagnosisVerdictIndex ?? "none"}`;
  }

  function routingStageForPhase(phase: LifecyclePhase): LifecycleRoutedStage | "build" | undefined {
    return ({
      defining: "define",
      planning: "plan",
      building: "build",
      verifying: "verify",
      reviewing: "review",
      debugging: "debug",
      shipping: "ship",
    } as Partial<Record<LifecyclePhase, LifecycleRoutedStage | "build">>)[phase];
  }

  function isCheckerRoutingStage(stage: LifecycleRoutedStage | "build"): boolean {
    return stage === "verify" || stage === "debug" || stage === "review" || stage === "ship";
  }

  async function routingEvidence(ctx: ExtensionContext) {
    if (!runtime) return {};
    const status = await workingTreeStatus(ctx);
    const changedPaths = status?.paths ?? runtime.state.baselinePaths ?? [];
    return {
      task: runtime.state.task,
      spec: existsSync(runtime.paths.spec) ? readFileSync(runtime.paths.spec, "utf8").slice(0, 256_000) : undefined,
      plan: existsSync(runtime.paths.plan) ? readFileSync(runtime.paths.plan, "utf8").slice(0, 256_000) : undefined,
      changedPaths,
      languages: [...new Set(changedPaths.map(languageForPath).filter((value): value is string => Boolean(value)))],
      testCommand: detectTestCommand(runtime.cwd),
      verdictCategory: runtime.state.verdicts.at(-1)?.reasons,
    };
  }

  function languageForPath(path: string): string | undefined {
    const extension = path.split(".").at(-1)?.toLowerCase();
    return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", rb: "ruby", rs: "rust", go: "go", swift: "swift", kt: "kotlin", java: "java", cs: "csharp" } as Record<string, string>)[extension ?? ""];
  }

  async function artifactStageEnded(ctx: ExtensionContext, artifact: "spec" | "plan"): Promise<void> {
    if (!runtime) return;
    const path = artifact === "spec" ? runtime.paths.spec : runtime.paths.plan;
    if (!isNonEmpty(path)) {
      if (runtime.remindedPhase !== runtime.state.phase) {
        runtime.remindedPhase = runtime.state.phase;
        sendPrompt(`Write the required ${artifact} artifact to exactly ${rel(path)} before finishing. Do not perform another stage.`);
        return;
      }
      await interruptRun(ctx, `${artifact.toUpperCase()} stopped because ${rel(path)} remained empty after a reminder.`);
      return;
    }

    persistRoutingStageOutcome(artifact === "spec" ? "define" : "plan", {
      structuredToolCompliance: true,
      verdict: "unknown",
    });
    if (artifact === "plan") {
      runtime.state.rejectionFingerprints = [];
      runtime.state.buildEvidenceFingerprints = [];
      writeState(runtime.paths, runtime.state);
    }
    await transition(
      artifact === "spec"
        ? { type: "spec_produced", specPath: rel(path) }
        : { type: "plan_produced", planPath: rel(path) },
      `${artifact.toUpperCase()} artifact produced`,
      ctx,
    );
    if (runtime?.state.phase === "awaiting_spec_approval" || runtime?.state.phase === "awaiting_plan_approval") {
      await requestArtifactApproval(ctx, artifact);
    } else {
      await continueOrPause(ctx, artifact === "spec" ? "plan" : "build");
    }
  }

  async function requestArtifactApproval(ctx: ExtensionContext, artifact: "spec" | "plan"): Promise<void> {
    if (!runtime) return;
    const expected = artifact === "spec" ? "awaiting_spec_approval" : "awaiting_plan_approval";
    const runId = runtime.state.runId;
    if (!ctx.hasUI) {
      await interruptRun(ctx, `${artifact} approval requires interactive mode. Resume with --yolo only by starting a new yolo run.`);
      return;
    }
    const choice = await ctx.ui.select(`${artifact.toUpperCase()} ready`, ["Approve", "Revise", "Cancel"]);
    if (!ownsRun(runId, expected)) return;
    if (choice === "Approve") {
      await transition({ type: artifact === "spec" ? "spec_approved" : "plan_approved" }, `${artifact.toUpperCase()} approved`, ctx);
      await continueOrPause(ctx, artifact === "spec" ? "plan" : "build");
      return;
    }
    if (choice === "Revise") {
      const feedback = await ctx.ui.editor(`How should ${artifact} change?`, "");
      if (!ownsRun(runId, expected)) return;
      if (!feedback?.trim()) {
        await interruptRun(ctx, `${artifact.toUpperCase()} revision cancelled.`);
        return;
      }
      if (artifact === "spec") runtime.specRevisionFeedback = feedback.trim();
      else runtime.planRevisionFeedback = feedback.trim();
      await transition({ type: artifact === "spec" ? "spec_rejected_by_user" : "plan_rejected_by_user" }, `${artifact.toUpperCase()} revision requested`, ctx);
      await runCurrentPhase(ctx);
      return;
    }
    await stopRun(ctx, `${artifact.toUpperCase()} approval cancelled.`);
  }

  async function checkerStageEnded(ctx: ExtensionContext, stage: "verify" | "review" | "ship"): Promise<void> {
    if (!runtime) return;
    const structuredToolCompliance = Boolean(runtime.pendingVerdict && runtime.pendingVerdict.kind === stage);
    if (!runtime.pendingVerdict || runtime.pendingVerdict.kind !== stage) {
      if (runtime.remindedPhase !== runtime.state.phase) {
        runtime.remindedPhase = runtime.state.phase;
        const tool = stage === "verify" ? "verify_verdict" : stage === "review" ? "review_verdict" : "ship_decision";
        sendPrompt(`Finish ${stage.toUpperCase()} by calling ${tool} exactly once. Do not edit files.`);
        return;
      }
      runtime.pendingVerdict = {
        kind: stage,
        verdict: "reject",
        reasons: `${stage.toUpperCase()} did not return a structured verdict; treat the work as unverified.`,
        requiredFixes: "Repeat the checker stage and provide structured evidence.",
      };
    }
    const verdict = runtime.pendingVerdict;
    if (!verdict) throw new Error(`${stage} verdict was not available after recovery`);
    runtime.pendingVerdict = undefined;
    if (verdict.verdict === "reject") {
      runtime.state.rejectionFingerprints.push(convergenceFingerprint(`${verdict.reasons}\n${verdict.requiredFixes ?? ""}`));
      writeState(runtime.paths, runtime.state);
    }
    persistRoutingStageOutcome(stage, { structuredToolCompliance, verdict: verdict.verdict });
    if (verdict.verdict === "reject" && stage === "review") persistDownstreamReversal("verify", verdict.reasons);
    if (verdict.verdict === "reject" && stage === "ship") {
      persistDownstreamReversal("review", verdict.reasons);
      persistDownstreamReversal("verify", verdict.reasons);
    }
    await transition({
      type: "verdict",
      stage,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      requiredFixes: verdict.requiredFixes,
    }, `${stage.toUpperCase()} ${verdict.verdict}: ${truncate(verdict.reasons, 160)}`, ctx);

    if (!runtime) return;
    if (runtime.state.phase === "awaiting_ship_approval") {
      await requestShipApproval(ctx);
    } else if (runtime.state.phase === "finalizing") {
      await finalizeRun(ctx);
    } else if (runtime.state.phase === "done" || runtime.state.phase === "failed") {
      await finishRun(ctx);
    } else {
      await continueOrPause(ctx, nextStandaloneForPhase(runtime.state.phase));
    }
  }

  async function debugStageEnded(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    const structuredToolCompliance = Boolean(runtime.pendingDiagnosis && isNonEmpty(runtime.paths.debug));
    if (!runtime.pendingDiagnosis || !isNonEmpty(runtime.paths.debug)) {
      if (runtime.remindedPhase !== "debugging") {
        runtime.remindedPhase = "debugging";
        sendPrompt("Finish DEBUG by calling debug_diagnosis exactly once. Do not edit source files.");
        return;
      }
      const rejection = latestRejection();
      const synthesized: PendingDiagnosis = {
        rootCause: "The debugger did not return a structured diagnosis.",
        evidence: rejection.reasons,
        confidence: "low",
        recommendedFix: rejection.requiredFixes ?? "Reproduce the rejection and address its concrete findings.",
        filesLikelyAffected: [],
        validationCommands: [],
      };
      runtime.pendingDiagnosis = synthesized;
      runtime.state.debugDiagnosisVerdictIndex = latestRejectionIndex();
      writeState(runtime.paths, runtime.state);
      assertRunPathsSafe(runtime.paths);
      writeFileSync(runtime.paths.debug, formatDiagnosis(synthesized));
      appendJournal(runtime.paths, "Synthesized DEBUG diagnosis after missing structured output");
    }
    runtime.pendingDiagnosis = undefined;
    persistRoutingStageOutcome("debug", { structuredToolCompliance, verdict: "unknown" });
    await transition({ type: "debug_produced", debugPath: rel(runtime.paths.debug) }, "DEBUG diagnosis produced", ctx);
    if (!runtime) return;
    if (runtime.state.phase === "failed") await finishRun(ctx);
    else await continueOrPause(ctx, nextStandaloneForPhase(runtime.state.phase));
  }

  async function requestShipApproval(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    if (runtime.state.yolo) {
      await transition({ type: "ship_confirmed" }, "SHIP automatically confirmed under --yolo (publication policy still applies)", ctx);
      await finalizeRun(ctx);
      return;
    }
    const runId = runtime.state.runId;
    if (!ctx.hasUI) {
      await interruptRun(ctx, "SHIP confirmation requires interactive mode; the working tree was left unchanged.");
      return;
    }
    const confirmed = await ctx.ui.confirm("SHIP report is GO", "Proceed to configured commit/PR finalization?");
    if (!ownsRun(runId, "awaiting_ship_approval")) return;
    await transition({ type: confirmed ? "ship_confirmed" : "ship_declined" }, confirmed ? "SHIP confirmed" : "SHIP declined", ctx);
    if (!runtime) return;
    if (runtime.state.phase === "finalizing") await finalizeRun(ctx);
    else await finishRun(ctx);
  }

  async function finalizeRun(ctx: ExtensionContext): Promise<void> {
    if (!runtime || runtime.state.phase !== "finalizing") return;
    const commitOutcome = await maybeCommit(ctx);
    if (commitOutcome === "failed") {
      await interruptRun(ctx, "Finalization paused after a Git failure. Correct the problem and run /lifecycle resume.");
      return;
    }
    if (commitOutcome === "committed") {
      const prOutcome = await maybeOpenPr(ctx);
      if (prOutcome === "failed") {
        await interruptRun(ctx, "Finalization paused after a pull-request failure. Correct the problem and run /lifecycle resume.");
        return;
      }
    }
    await transition({ type: "finalize_complete" }, "Finalization complete", ctx);
    await finishRun(ctx);
  }

  async function maybeCommit(ctx: ExtensionContext): Promise<"committed" | "skipped" | "failed"> {
    if (!runtime) return "failed";
    const runId = runtime.state.runId;
    if (runtime.state.finalization?.commitSha) return "committed";
    if (runtime.config.ship.commit === "never") return "skipped";
    const checkpointed = Boolean(runtime.state.finalization?.commitBaseSha && runtime.state.finalization.commitMessage);
    if (checkpointed) {
      const recovered = await reconcilePendingCommit(ctx);
      if (recovered !== "pending") return recovered;
    }
    if (!runtime.state.baselinePaths || !runtime.state.baselineStagedPaths) {
      notify(ctx, "Cannot safely attribute files for this older run; commit skipped.", "error");
      return "failed";
    }
    if (runtime.state.baselineStagedPaths.length > 0) {
      notify(ctx, `Refusing to commit because files were already staged before the lifecycle: ${runtime.state.baselineStagedPaths.join(", ")}`, "error");
      return "failed";
    }

    let files: string[];
    try {
      files = await changedFiles(ctx);
    } catch (error) {
      notify(ctx, `Could not collect lifecycle changes: ${errorMessage(error)}`, "error");
      return "failed";
    }
    if (files.length === 0) {
      notify(ctx, "No lifecycle-attributable source files were available to commit.", "info");
      return "skipped";
    }
    if (!checkpointed) {
      const shouldCommit = ctx.hasUI && await ctx.ui.confirm(
        "Commit lifecycle changes",
        `${runtime.config.ship.commit === "auto" ? "Commit policy is auto, but explicit confirmation is still required.\n\n" : ""}Files:\n${files.map((file) => `- ${file}`).join("\n")}\n\nCommit now?`,
      );
      if (!ownsRun(runId, "finalizing")) return "failed";
      if (!shouldCommit) return "skipped";
      const revalidated = await changedFiles(ctx);
      if (!sameStringSet(files, revalidated)) {
        notify(ctx, "Working-tree manifest changed after confirmation; commit was not attempted.", "error");
        return "failed";
      }
      const base = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal: ctx.signal });
      if (base.code !== 0 || !base.stdout.trim()) {
        notify(ctx, `Could not checkpoint pre-commit HEAD: ${base.stderr || base.stdout}`, "error");
        return "failed";
      }
      const message = `Implement ${truncate(runtime.state.task.replace(/\s+/g, " "), 60)}`;
      runtime.state.finalization = { ...runtime.state.finalization, commitBaseSha: base.stdout.trim(), commitMessage: message };
      writeState(runtime.paths, runtime.state);
      appendJournal(runtime.paths, `Commit intent checkpointed at ${base.stdout.trim()} for: ${files.join(", ")}`);
      persistMirror(runtime.state);
    }
    for (const file of files) {
      const result = await pi.exec("git", ["add", "--", file], { timeout: 10_000, signal: ctx.signal });
      if (result.code !== 0) {
        notify(ctx, `git add failed for ${file}: ${result.stderr || result.stdout}`, "error");
        return "failed";
      }
    }
    const message = runtime.state.finalization?.commitMessage ?? `Implement ${truncate(runtime.state.task.replace(/\s+/g, " "), 60)}`;
    const commit = await pi.exec("git", ["commit", "-m", message], { timeout: 30_000, signal: ctx.signal });
    if (commit.code !== 0) {
      notify(ctx, `git commit failed: ${commit.stderr || commit.stdout}`, "error");
      return "failed";
    }
    const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal: ctx.signal });
    if (head.code !== 0 || !head.stdout.trim()) {
      notify(ctx, `Commit created but its SHA could not be recorded: ${head.stderr || head.stdout}`, "error");
      return "failed";
    }
    runtime.state.finalization = { ...runtime.state.finalization, commitSha: head.stdout.trim() };
    writeState(runtime.paths, runtime.state);
    appendJournal(runtime.paths, `Committed ${head.stdout.trim()}: ${message}`);
    persistMirror(runtime.state);
    return "committed";
  }

  async function reconcilePendingCommit(ctx: ExtensionContext): Promise<"committed" | "pending" | "failed"> {
    if (!runtime?.state.finalization?.commitBaseSha || !runtime.state.finalization.commitMessage) return "pending";
    const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal: ctx.signal });
    if (head.code !== 0 || !head.stdout.trim()) return "failed";
    const currentHead = head.stdout.trim();
    if (currentHead === runtime.state.finalization.commitBaseSha) return "pending";
    const [parent, subject] = await Promise.all([
      pi.exec("git", ["rev-parse", "HEAD^"], { timeout: 10_000, signal: ctx.signal }),
      pi.exec("git", ["log", "-1", "--format=%s"], { timeout: 10_000, signal: ctx.signal }),
    ]);
    if (parent.code !== 0 || subject.code !== 0 ||
      parent.stdout.trim() !== runtime.state.finalization.commitBaseSha ||
      subject.stdout.trim() !== runtime.state.finalization.commitMessage) {
      notify(ctx, "HEAD changed after the saved commit checkpoint but does not match the lifecycle commit; explicit recovery is required.", "error");
      return "failed";
    }
    runtime.state.finalization = { ...runtime.state.finalization, commitSha: currentHead };
    writeState(runtime.paths, runtime.state);
    appendJournal(runtime.paths, `Recovered committed SHA ${currentHead} from saved finalization intent`);
    persistMirror(runtime.state);
    return "committed";
  }

  function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
  }

  async function maybeOpenPr(ctx: ExtensionContext): Promise<"opened" | "skipped" | "failed"> {
    if (!runtime) return "failed";
    const runId = runtime.state.runId;
    if (runtime.state.finalization?.prUrl) return "opened";
    if (runtime.config.ship.openPr === "never") return "skipped";
    const checkpointedHead = runtime.state.finalization?.prHead;
    if (checkpointedHead) {
      const existing = await pi.exec("gh", ["pr", "view", checkpointedHead, "--json", "url", "--jq", ".url"], { timeout: 30_000, signal: ctx.signal });
      if (existing.code === 0 && existing.stdout.trim()) {
        runtime.state.finalization = { ...runtime.state.finalization, prUrl: existing.stdout.trim() };
        writeState(runtime.paths, runtime.state);
        appendJournal(runtime.paths, `Recovered pull request: ${existing.stdout.trim()}`);
        persistMirror(runtime.state);
        return "opened";
      }
    } else {
      const confirmed = ctx.hasUI && await ctx.ui.confirm("Open pull request", "Run gh pr create --fill now?");
      if (!ownsRun(runId, "finalizing")) return "failed";
      if (!confirmed) return "skipped";
    }
    const branch = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000, signal: ctx.signal });
    const localHead = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal: ctx.signal });
    const upstreamHead = await pi.exec("git", ["rev-parse", "@{upstream}"], { timeout: 10_000, signal: ctx.signal });
    if (branch.code !== 0 || !branch.stdout.trim() || branch.stdout.trim() === "HEAD" ||
      (checkpointedHead !== undefined && branch.stdout.trim() !== checkpointedHead) ||
      localHead.code !== 0 || upstreamHead.code !== 0 || localHead.stdout.trim() !== upstreamHead.stdout.trim()) {
      notify(ctx, "Refusing to open a PR until the current branch is explicitly pushed and its upstream matches HEAD.", "error");
      return "failed";
    }
    runtime.state.finalization = { ...runtime.state.finalization, prHead: branch.stdout.trim() };
    writeState(runtime.paths, runtime.state);
    appendJournal(runtime.paths, `Pull-request intent checkpointed for ${branch.stdout.trim()}`);
    persistMirror(runtime.state);
    const result = await pi.exec("gh", ["pr", "create", "--fill", "--head", branch.stdout.trim()], { timeout: 60_000, signal: ctx.signal });
    if (result.code !== 0) {
      notify(ctx, `gh pr create failed: ${result.stderr || result.stdout}`, "error");
      return "failed";
    }
    const prUrl = result.stdout.trim();
    runtime.state.finalization = { ...runtime.state.finalization, prUrl };
    writeState(runtime.paths, runtime.state);
    appendJournal(runtime.paths, `Opened pull request: ${prUrl}`);
    persistMirror(runtime.state);
    return "opened";
  }

  async function workingTreeStatus(ctx: ExtensionContext): Promise<{ paths: string[]; stagedPaths: string[] } | undefined> {
    const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      timeout: 10_000,
      signal: ctx.signal,
    });
    if (result.code !== 0) return undefined;
    return parsePorcelainStatus(result.stdout);
  }

  async function changedFiles(ctx: ExtensionContext): Promise<string[]> {
    if (!runtime?.state.baselinePaths) throw new Error("baseline file set is unavailable");
    const status = await workingTreeStatus(ctx);
    if (!status) throw new Error("git status failed");
    const baseline = new Set(runtime.state.baselinePaths);
    const artifactPrefix = `${relative(runtime.cwd, resolve(runtime.cwd, runtime.config.lifecycle.artifactsDir)).replaceAll("\\", "/")}/`;
    return status.paths
      .filter((file) => !baseline.has(file))
      .filter((file) => !file.replaceAll("\\", "/").startsWith(artifactPrefix));
  }

  async function continueOrPause(ctx: ExtensionContext, next: StandaloneStage): Promise<void> {
    if (!runtime) return;
    if (runtime.automatic) {
      await runCurrentPhase(ctx);
      return;
    }
    await pauseStandalone(ctx, `Stage complete. Next: /${next}`);
  }

  async function pauseStandalone(ctx: ExtensionContext, message: string): Promise<void> {
    if (!runtime) return;
    const state = runtime.state;
    restoreTools();
    const restored = await restoreRuntimeModel(ctx);
    clearUi(ctx);
    notify(ctx, restored ? message : `${message} Original-model restoration is still pending; use /lifecycle resume to retry.`, restored ? "info" : "warning");
    persistMirror(state);
    releaseRuntimeLease();
    runtime = undefined;
    deactivateVerdictTools();
  }

  async function finishRun(ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    const finished = runtime.state;
    const summary = finalSummary(finished, runtime.paths);
    const lastStage = finished.modelSelections.at(-1)?.stage;
    if (lastStage) {
      persistRoutingStageOutcome(lastStage, {
        type: "final-status",
        structuredToolCompliance: true,
        verdict: finished.verdicts.at(-1)?.verdict ?? "unknown",
        finalRunStatus: finished.phase === "failed" ? "failed" : "done",
      });
    }
    restoreTools();
    const restored = await restoreRuntimeModel(ctx);
    if (restored) {
      releaseRun(runtime.cwd, runtime.config.lifecycle.artifactsDir, finished.runId);
    } else {
      appendJournal(runtime.paths, "Run finished but original-model restoration is pending; current ownership retained");
    }
    clearUi(ctx);
    pi.sendMessage({ customType: ENTRY_TYPE, content: summary, display: true, details: finished }, { triggerTurn: false });
    persistMirror(finished);
    if (!restored) notify(ctx, "Run finished, but original-model restoration is pending. Fix model availability and use /lifecycle resume.", "warning");
    releaseRuntimeLease();
    runtime = undefined;
    deactivateVerdictTools();
  }

  async function stopRun(ctx: ExtensionContext, message: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      if (!runtime) {
        const loaded = loadCurrent(ctx.cwd);
        if (!loaded || (!isActivePhase(loaded.state.phase) && loaded.state.modelRestored !== false)) {
          notify(ctx, "No active lifecycle run.", "info");
          return;
        }
        const resolved = loadPiResolvedConfig(ctx.cwd);
        runtime = makeRuntime(resolved.config, resolved.provenance, ctx.cwd, loaded.paths, loaded.state, false, undefined, currentModelState(ctx));
      }
      const stopped = runtime.state;
      if (!ctx.isIdle()) ctx.abort();
      await transition({ type: "cancelled" }, "Lifecycle cancelled", ctx);
      restoreTools();
      const restored = await restoreRuntimeModel(ctx);
      if (restored) {
        releaseRun(runtime.cwd, runtime.config.lifecycle.artifactsDir, stopped.runId);
      } else {
        appendJournal(runtime.paths, "Lifecycle cancelled but original-model restoration is pending; current ownership retained");
      }
      clearUi(ctx);
      pi.sendMessage({ customType: ENTRY_TYPE, content: message, display: true, details: stopped }, { triggerTurn: false });
      if (!restored) notify(ctx, "Original-model restoration is pending. Fix model availability and run /lifecycle-stop again.", "warning");
      releaseRuntimeLease();
      runtime = undefined;
      deactivateVerdictTools();
    } finally {
      stopping = false;
    }
  }

  async function interruptRun(ctx: ExtensionContext, message: string): Promise<void> {
    if (!runtime) return;
    const state = runtime.state;
    if (!ctx.isIdle()) ctx.abort();
    restoreTools();
    await restoreRuntimeModel(ctx);
    clearUi(ctx);
    appendJournal(runtime.paths, message);
    persistMirror(state);
    pi.sendMessage({ customType: ENTRY_TYPE, content: message, display: true, details: state }, { triggerTurn: false });
    releaseRuntimeLease();
    runtime = undefined;
    deactivateVerdictTools();
  }

  async function transition(event: LifecycleEvent, journal: string, ctx: ExtensionContext): Promise<void> {
    if (!runtime) return;
    const before = runtime.state.phase;
    const next = nextStage(runtime.state, event, loopConfigFrom(runtime.config));
    if (next.phase === before && JSON.stringify(next) === JSON.stringify(runtime.state)) return;
    runtime.state = next;
    writeState(runtime.paths, next);
    appendJournal(runtime.paths, `${before} -> ${next.phase}: ${journal}`);
    persistMirror(next);
    updateUi(ctx);
  }

  function activateArtifactTools(): void {
    if (!runtime) return;
    const optionalQuestions = runtime.toolsBeforeRun.filter((name) => name === "ask_user_question" || name === "questionnaire");
    pi.setActiveTools(unique([...READ_TOOLS, "edit", "write", ...optionalQuestions]));
  }

  function activateReadOnlyTools(verdictTool?: string): void {
    if (!runtime) return;
    pi.setActiveTools(unique([...READ_TOOLS, ...(verdictTool ? [verdictTool] : [])]));
  }

  function restoreBuildTools(): void {
    if (!runtime) return;
    pi.setActiveTools(runtime.toolsBeforeRun);
  }

  function restoreTools(): void {
    if (runtime) pi.setActiveTools(runtime.toolsBeforeRun);
    else deactivateVerdictTools();
  }

  function deactivateVerdictTools(): void {
    const active = pi.getActiveTools();
    const next = active.filter((name) => !VERDICT_TOOLS.has(name));
    if (next.length !== active.length) pi.setActiveTools(next);
  }

  function requireToolPhase(phase: LifecyclePhase, tool: string): void {
    if (!runtime || runtime.state.phase !== phase || !ownsRun(runtime.state.runId, phase)) {
      throw new Error(`${tool} is only valid for the active lifecycle ${phase} phase`);
    }
  }

  function ownsRun(runId: string, phase?: LifecyclePhase): boolean {
    if (!runtime || runtime.state.runId !== runId || (phase && runtime.state.phase !== phase)) return false;
    const active = currentRun(runtime.cwd, runtime.config.lifecycle.artifactsDir);
    const disk = active && readState(active.paths);
    return active?.runId === runId && disk?.runId === runId && ownsRunLease(runtime.paths, runtime.leaseOwner) && (!phase || disk.phase === phase);
  }

  function releaseRuntimeLease(): void {
    if (runtime) releaseRunLease(runtime.paths, runtime.leaseOwner);
  }

  function recordProviderFailure(): void {
    if (!runtime) return;
    const stage = routingStageForPhase(runtime.state.phase);
    if (!stage) return;
    const selection = [...runtime.state.modelSelections].reverse().find((item) => item.stage === stage && item.routing);
    if (!selection?.routing || selection.routing.failureCategories.includes("provider-error")) return;
    persistRoutingStageOutcome(stage, { structuredToolCompliance: false, verdict: "unknown" });
    selection.routing.failureCategories.push("provider-error");
    selection.routing.fallbackCount += 1;
    writeState(runtime.paths, runtime.state);
    appendJournal(runtime.paths, `Model ${stage}: ${selection.provider}/${selection.model} failed during provider execution; fallback required`);
    persistMirror(runtime.state);
  }

  function latestRejectionIndex(): number {
    const verdicts = runtime?.state.verdicts ?? [];
    for (let index = verdicts.length - 1; index >= 0; index -= 1) {
      if (verdicts[index].verdict === "reject") return index;
    }
    throw new Error("DEBUG requires a preceding rejection");
  }

  function latestRejection(): LifecycleStageVerdict {
    const index = latestRejectionIndex();
    return runtime!.state.verdicts[index];
  }

  function buildFeedback(): string | undefined {
    if (!runtime) return undefined;
    const rejection = [...runtime.state.verdicts].reverse().find((verdict) => verdict.verdict === "reject");
    if (!rejection) return undefined;
    const diagnosis = isNonEmpty(runtime.paths.debug) ? readFileSync(runtime.paths.debug, "utf8").trim() : undefined;
    return [
      `${rejection.stage.toUpperCase()} rejection: ${rejection.reasons}`,
      rejection.requiredFixes ? `Required fixes: ${rejection.requiredFixes}` : undefined,
      diagnosis ? `Independent DEBUG diagnosis:\n${diagnosis}` : undefined,
    ].filter(Boolean).join("\n\n");
  }

  function replanFeedback(): string | undefined {
    if (!runtime || runtime.state.consecutiveRejections !== 0) return undefined;
    const rejection = [...runtime.state.verdicts].reverse().find((verdict) => verdict.verdict === "reject");
    if (!rejection) return undefined;
    const diagnosis = isNonEmpty(runtime.paths.debug) ? readFileSync(runtime.paths.debug, "utf8").trim() : undefined;
    return [`Checker rejection: ${rejection.reasons}`, rejection.requiredFixes, diagnosis].filter(Boolean).join("\n\n");
  }

  function rel(path: string): string {
    return relative(runtime?.cwd ?? process.cwd(), path).replaceAll("\\", "/");
  }

  async function modelFailure(ctx: ExtensionContext, stage: string, attempted: string[]): Promise<void> {
    const detail = attempted.length > 0 ? attempted.join(", ") : "no configured candidate is authenticated locally";
    await interruptRun(ctx, `Lifecycle ${stage} model unavailable (${detail}). Configure a candidate in Pi and ~/.ai-orchestrator/config.json or ${ctx.cwd}/.ai-orchestrator.json, then resume.`);
  }

  function updateUi(ctx: ExtensionContext): void {
    if (!runtime || !ctx.hasUI) return;
    const selection = runtime.state.modelSelections.at(-1);
    const model = selection ? `${selection.provider}/${selection.model}` : "selecting model";
    ctx.ui.setStatus(STATUS_KEY, `lifecycle ${runtime.state.phase} ${model}`);
    const verdict = runtime.state.verdicts.at(-1);
    const routing = selection?.routing;
    ctx.ui.setWidget(WIDGET_KEY, [
      `Lifecycle: ${runtime.state.phase}`,
      `Model: ${model}`,
      `Build iterations: ${runtime.state.buildIterations}`,
      `Consecutive rejections: ${runtime.state.consecutiveRejections}`,
      routing ? `Routing: ${routing.engine}; rank ${routing.selectedRank}; ${routing.separation}; fallback ${routing.fallbackCount}` : "Routing: legacy selection",
      verdict ? `Last verdict: ${verdict.stage} ${verdict.verdict} — ${truncate(verdict.reasons, 80)}` : "Last verdict: none",
    ]);
  }

  function clearUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function currentModelState(ctx: ExtensionContext): LifecycleState["originalModel"] {
    return ctx.model
      ? { provider: String(ctx.model.provider), id: String(ctx.model.id), thinking: pi.getThinkingLevel() as ThinkingLevel }
      : undefined;
  }

  async function restoreRuntimeModel(ctx: ExtensionContext): Promise<boolean> {
    if (!runtime) return true;
    const originalModel = runtime.automatic ? runtime.state.originalModel : runtime.invocationOriginal;
    return restoreOriginalModel(ctx, runtime.state, originalModel);
  }

  async function restoreOriginalModel(
    ctx: ExtensionContext,
    state: LifecycleState,
    originalModel: LifecycleState["originalModel"] = state.originalModel,
  ): Promise<boolean> {
    const original = originalModel;
    if (!original) {
      state.modelRestored = true;
      persistRestoredState(state);
      return true;
    }
    const model = ctx.modelRegistry.find(original.provider, original.id);
    if (!model) {
      state.modelRestored = false;
      persistRestoredState(state);
      notify(ctx, `Could not restore original model ${original.provider}/${original.id}: model not found.`, "warning");
      return false;
    }
    if (!(await pi.setModel(model))) {
      state.modelRestored = false;
      persistRestoredState(state);
      notify(ctx, `Could not restore original model ${original.provider}/${original.id}: authentication unavailable.`, "warning");
      return false;
    }
    pi.setThinkingLevel(original.thinking);
    state.modelRestored = true;
    persistRestoredState(state);
    return true;
  }

  function persistRestoredState(state: LifecycleState): void {
    if (runtime?.state.runId === state.runId) writeState(runtime.paths, state);
  }

  function persistMirror(state: LifecycleState): void {
    pi.appendEntry(ENTRY_TYPE, state);
  }

  function sendPrompt(prompt: string): void {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.sendMessage({ customType: ENTRY_TYPE, content: `[${level}] ${message}`, display: true }, { triggerTurn: false });
  }
}

function hasActiveFastPath(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  const latest = entries.filter((entry) => entry.type === "custom" && entry.customType === "ai-orchestrator").pop();
  if (!latest?.data || typeof latest.data !== "object") return false;
  const phase = (latest.data as { phase?: unknown }).phase;
  return typeof phase === "string" && phase !== "idle" && phase !== "done" && phase !== "failed";
}

function loadPiConfig(cwd: string): OrchestratorConfig {
  return loadConfig(cwd, { ignoreMcpProviders: true });
}

function loadPiResolvedConfig(cwd: string) {
  return loadConfigWithProvenance(cwd, { ignoreMcpProviders: true });
}

function loadCurrent(cwd: string): { paths: RunPaths; state: LifecycleState } | undefined {
  let config: OrchestratorConfig;
  try {
    config = loadPiConfig(cwd);
  } catch {
    config = DEFAULT_CONFIG;
  }
  const active = currentRun(cwd, config.lifecycle.artifactsDir);
  if (!active) return undefined;
  const state = readState(active.paths);
  return state?.runId === active.runId ? { paths: active.paths, state } : undefined;
}

function parsePorcelainStatus(output: string): { paths: string[]; stagedPaths: string[] } {
  const records = output.split("\0");
  const paths: string[] = [];
  const stagedPaths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const x = record[0];
    const path = record.slice(3);
    if (path) {
      paths.push(path);
      if (x !== " " && x !== "?") stagedPaths.push(path);
    }
    if (x === "R" || x === "C") index += 1;
  }
  return { paths: unique(paths), stagedPaths: unique(stagedPaths) };
}

function parseTaskArgs(args: string): { yolo: boolean; task: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let yolo = false;
  while (parts[0] === "--yolo") {
    yolo = true;
    parts.shift();
  }
  return { yolo, task: parts.join(" ").trim() };
}

function readRequired(path: string, label: string): string {
  if (!isNonEmpty(path)) throw new Error(`${label} artifact is missing or empty: ${path}`);
  return readFileSync(path, "utf8");
}

function isNonEmpty(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}

function isActivePhase(phase: LifecyclePhase): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function lastAssistantStopReason(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    return typeof message.stopReason === "string" ? message.stopReason : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stageLabel(phase: LifecyclePhase): string {
  return phase.replaceAll("_", " ").toUpperCase();
}

function nextCommand(phase: LifecyclePhase): string {
  return `/${nextStandaloneForPhase(phase)}`;
}

function nextStandaloneForPhase(phase: LifecyclePhase): StandaloneStage {
  switch (phase) {
    case "defining":
    case "awaiting_spec_approval": return "spec";
    case "planning":
    case "awaiting_plan_approval": return "plan";
    case "building": return "build";
    case "verifying": return "test";
    case "debugging": return "debug";
    case "reviewing": return "review";
    case "shipping":
    case "awaiting_ship_approval":
    case "finalizing":
    case "done":
    case "failed":
    case "idle": return "ship";
    default: return assertNever(phase);
  }
}

function formatDiagnosis(diagnosis: PendingDiagnosis): string {
  return [
    "# DEBUG Diagnosis",
    "",
    "## Root Cause",
    diagnosis.rootCause,
    "",
    "## Evidence",
    diagnosis.evidence,
    "",
    `## Confidence\n${diagnosis.confidence}`,
    "",
    "## Recommended Fix",
    diagnosis.recommendedFix,
    "",
    "## Files Likely Affected",
    diagnosis.filesLikelyAffected.length > 0 ? diagnosis.filesLikelyAffected.map((file) => `- ${file}`).join("\n") : "- Unknown",
    "",
    "## Validation Commands",
    diagnosis.validationCommands.length > 0 ? diagnosis.validationCommands.map((command) => `- \`${command}\``).join("\n") : "- Re-run the checker validation",
    "",
  ].join("\n");
}

function finalSummary(state: LifecycleState, paths: RunPaths): string {
  return [
    state.phase === "done" ? "Lifecycle completed." : "Lifecycle failed at the configured BUILD cap.",
    `Task: ${state.task}`,
    `Build iterations: ${state.buildIterations}`,
    `Verdicts: ${state.verdicts.map((verdict) => `${verdict.stage}:${verdict.verdict}`).join(", ") || "none"}`,
    `Journal: ${paths.journal}`,
    state.debugPath ? `Latest diagnosis: ${paths.debug}` : undefined,
    state.phase === "failed" ? "The working tree was left as-is for human review." : undefined,
  ].filter(Boolean).join("\n\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lifecycle value: ${JSON.stringify(value)}`);
}
