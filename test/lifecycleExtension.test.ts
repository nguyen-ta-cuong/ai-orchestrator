import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import lifecycleExtension from "../extensions/lifecycle.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import {
  acquireRunLease,
  checkpointLifecycleGraphEvent,
  createRun,
  readState,
  releaseRunLease,
  writeState,
} from "../src/lifecycle/artifacts.js";
import type { LifecyclePhase, LifecycleState } from "../src/core/lifecycle.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

const tempDirs: string[] = [];

function overwriteAsLegacy(paths: ReturnType<typeof createRun>["paths"], state: LifecycleState): void {
  rmSync(paths.graph, { force: true });
  writeFileSync(paths.events, "");
  state.version = 1;
  delete state.graphExecution;
  delete state.envelopeRevision;
  delete state.previousEnvelopeHash;
  delete state.envelopeHash;
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

function writeFixtureState(paths: ReturnType<typeof createRun>["paths"], state: LifecycleState): void {
  const owner = acquireRunLease(paths, `fixture-${Math.random().toString(36).slice(2)}`);
  try {
    writeState(paths, state, { owner });
  } finally {
    releaseRunLease(paths, owner);
  }
}

function makeRun(phase: LifecyclePhase) {
  const cwd = join(tmpdir(), `ai-orchestrator-extension-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  tempDirs.push(cwd);
  const created = createRun(cwd, DEFAULT_CONFIG.lifecycle.artifactsDir, "fix lifecycle races");
  writeFileSync(join(cwd, "README.md"), "# Fixture\n");
  writeFileSync(join(cwd, ".gitignore"), ".ai-orchestrator/\nhome/\nsrc/orch-runs/\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "Lifecycle Tests"], { cwd });
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
  const state = readState(created.paths)!;
  Object.assign(state, {
    version: 1,
    graphExecution: undefined,
    phase,
    baselinePaths: [],
    baselineStagedPaths: [],
    originalModel: { provider: "test", id: "original-model", thinking: "high" },
    modelRestored: false,
  });
  writeFileSync(created.paths.spec, "# Specification\n");
  writeFileSync(created.paths.plan, "# Plan\n");
  overwriteAsLegacy(created.paths, state);
  return { cwd, paths: created.paths };
}

function extensionHarness(cwd: string, models: Array<Record<string, unknown>> = [{ provider: "anthropic", id: "claude-fable-5" }]) {
  vi.stubEnv("HOME", join(cwd, "home"));
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler>();
  let activeTools = ["read", "bash", "agent_team"];
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler)),
    on: vi.fn((name: string, handler: EventHandler) => events.set(name, handler)),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "high"),
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(async () => true),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    exec,
  };
  lifecycleExtension(pi as unknown as ExtensionAPI);

  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    signal: new AbortController().signal,
    model: { provider: "test", id: "current-model" },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => ({ provider, id }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "Approve"),
      editor: vi.fn(async () => "Revise the artifact"),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    waitForIdle: vi.fn(async () => undefined),
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
  } as unknown as ExtensionCommandContext;

  return { commands, events, exec, pi, ctx, activeTools: () => activeTools };
}

function structuredPlan(planVersion: number) {
  return {
    schemaVersion: 1 as const,
    id: "structured-plan",
    planVersion,
    summary: "Inspect the approved change and produce durable evidence.",
    entry: "inspect",
    exit: "inspect",
    nodes: [{
      id: "inspect",
      handler: "inspect" as const,
      priority: 0,
      objective: "Inspect the repository.",
      instructions: ["Inspect the files required by the approved specification."],
      acceptanceCriteria: ["The repository inventory is complete."],
      verificationCommands: [],
      inputContracts: [],
      outputContracts: [{ id: "inventory", kind: "artifact" as const, validation: "sha256" as const }],
      toolPolicy: "read-only" as const,
      sideEffect: "read" as const,
      workspace: "shared" as const,
      idempotency: "read-replay-safe" as const,
      resourceLocks: [],
      writeSet: [],
      retryLimit: 0,
      timeoutMs: 1_000,
    }],
    dependencies: [],
    joins: [],
  };
}

function submittedPlanTool(harness: ReturnType<typeof extensionHarness>) {
  return vi.mocked(harness.pi.registerTool).mock.calls.find(([tool]) =>
    (tool as { name?: string }).name === "submit_build_plan")?.[0] as {
      parameters: { properties: { plan: { properties: Record<string, unknown> } } };
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle Pi extension safety", () => {
  it("accepts PLAN only through submit_build_plan and writes canonical versioned artifacts", async () => {
    const run = makeRun("planning");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.activeTools()).toContain("submit_build_plan");
    expect(harness.activeTools()).not.toContain("edit");
    expect(harness.activeTools()).not.toContain("write");
    await expect(harness.events.get("tool_call")!({
      toolName: "write",
      input: { path: run.paths.plan },
    }, harness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });

    const submit = submittedPlanTool(harness);
    expect((submit.parameters.properties.plan.properties.nodes as { items: { properties: Record<string, { enum?: string[] }> } })
      .items.properties.handler.enum).toEqual(["inspect", "design", "implement", "validate", "integrate"]);
    await submit.execute("plan", { plan: structuredPlan(1) });

    const graphPath = join(run.paths.root, "build", "plan-versions", "1", "plan.graph.json");
    const markdownPath = join(run.paths.root, "build", "plan-versions", "1", "plan.md");
    expect(JSON.parse(readFileSync(graphPath, "utf8"))).toMatchObject({ id: "structured-plan", planVersion: 1 });
    expect(readFileSync(markdownPath, "utf8")).toBe(readFileSync(run.paths.plan, "utf8"));
    expect(readFileSync(run.paths.plan, "utf8")).toContain("Plan hash:");
  });

  it("reminds once for a missing structured PLAN submission and then fails closed", async () => {
    const run = makeRun("planning");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    await harness.events.get("agent_end")!({ messages: [{ role: "assistant", content: "prose only" }] }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_settled")!({}, harness.ctx as unknown as ExtensionContext);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.pi.sendUserMessage).mock.calls.at(-1)?.[0]).toContain("submit_build_plan");
    expect(readState(run.paths)?.phase).toBe("planning");

    await harness.events.get("agent_end")!({ messages: [{ role: "assistant", content: "still prose" }] }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_settled")!({}, harness.ctx as unknown as ExtensionContext);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("remained missing after one reminder");
    expect(readState(run.paths)?.phase).toBe("planning");
    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
  });

  it("recovers a durable structured submission that crashed before the PLAN phase transition", async () => {
    const run = makeRun("planning");
    const state = readState(run.paths)!;
    state.yolo = true;
    writeFixtureState(run.paths, state);
    const submitting = extensionHarness(run.cwd);
    await submitting.commands.get("lifecycle")!("resume", submitting.ctx);
    await submittedPlanTool(submitting).execute("plan", { plan: structuredPlan(1) });
    await submitting.events.get("session_shutdown")!({}, submitting.ctx as unknown as ExtensionContext);
    expect(readState(run.paths)?.phase).toBe("planning");
    expect(readState(run.paths)?.planFingerprint).toBeUndefined();

    const resumed = extensionHarness(run.cwd);
    try {
      await resumed.commands.get("lifecycle")!("resume", resumed.ctx);
    } catch (error) {
      if (!(error instanceof Error) || !/Lifecycle phase building is not the active graph node/.test(error.message)) throw error;
    }
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Recovered submitted BUILD plan v1");
  }, 10_000);

  it("reconciles an appended event under the lease before the first resume write", async () => {
    const cwd = join(tmpdir(), `ai-orchestrator-extension-reconcile-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    const run = createRun(cwd, DEFAULT_CONFIG.lifecycle.artifactsDir, "resume a durable event");
    const snapshot = readState(run.paths)!;
    const graph = snapshot.graphExecution!;
    const crashWriter = acquireRunLease(run.paths, "crash-writer");
    expect(() => checkpointLifecycleGraphEvent(run.paths, snapshot, {
      schemaVersion: 1,
      kind: "node-status",
      sequence: graph.lastAppliedEventSequence + 1,
      eventId: "resume-crash-entry",
      runId: snapshot.runId,
      graphId: graph.graphId,
      graphVersion: graph.graphVersion,
      graphDigest: graph.graphDigest,
      planVersion: graph.planVersion,
      nodeId: "defining",
      priorStatus: "ready",
      nextStatus: "running",
      attempt: 1,
      timestamp: new Date().toISOString(),
      artifactRefs: [],
    }, {
      owner: crashWriter,
      tempId: "resume-crash-entry",
      failAt(point) {
        if (point === "after-event-append") throw new Error("simulated append-before-snapshot crash");
      },
    })).toThrow("simulated append-before-snapshot crash");
    expect(releaseRunLease(run.paths, crashWriter)).toBe(true);
    expect(JSON.parse(readFileSync(run.paths.state, "utf8"))).toMatchObject({ graphExecution: { revision: 2 } });

    const harness = extensionHarness(cwd);
    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(run.paths.state, "utf8"))).toMatchObject({
      originalModel: { provider: "test", id: "current-model" },
      graphExecution: {
        revision: 4,
        nodeStates: {
          defining: {
            status: "running",
            sideEffect: { status: "intent_recorded", class: "model" },
          },
        },
      },
    });
    await harness.events.get("session_shutdown")!({}, harness.ctx as unknown as ExtensionContext);
  });

  it("durably enters human wait before approving an artifact", async () => {
    const run = makeRun("awaiting_spec_approval");
    const harness = extensionHarness(run.cwd);
    let resolveChoice: ((value: string) => void) | undefined;
    vi.mocked(harness.ctx.ui.select).mockImplementationOnce(() => new Promise((resolve) => { resolveChoice = resolve; }));

    const resumed = harness.commands.get("lifecycle")!("resume", harness.ctx);
    await vi.waitFor(() => {
      expect(readState(run.paths)?.graphExecution?.nodeStates.awaiting_spec_approval).toMatchObject({ status: "waiting_human", attempts: 1 });
      expect(readState(run.paths)?.graphExecution?.guard.humanWaitStartedAt).toBeTruthy();
    });
    resolveChoice!("Approve");
    await resumed;

    expect(readState(run.paths)).toMatchObject({
      phase: "planning",
      graphExecution: { nodeStates: { awaiting_spec_approval: { status: "blocked" }, planning: { status: "running" } } },
    });
  });

  it("routes approval revision and cancellation from durable human wait", async () => {
    const revisionRun = makeRun("awaiting_plan_approval");
    const revisionHarness = extensionHarness(revisionRun.cwd);
    vi.mocked(revisionHarness.ctx.ui.select).mockResolvedValueOnce("Revise");
    vi.mocked(revisionHarness.ctx.ui.editor).mockResolvedValueOnce("Clarify the rollback requirements");
    await revisionHarness.commands.get("lifecycle")!("resume", revisionHarness.ctx);
    expect(readState(revisionRun.paths)).toMatchObject({
      phase: "planning",
      revisionFeedback: { artifact: "plan", feedback: "Clarify the rollback requirements" },
      graphExecution: { nodeStates: { awaiting_plan_approval: { status: "blocked" }, planning: { status: "running" } } },
    });

    const cancellationRun = makeRun("awaiting_spec_approval");
    const cancellationHarness = extensionHarness(cancellationRun.cwd);
    vi.mocked(cancellationHarness.ctx.ui.select).mockResolvedValueOnce("Cancel");
    await cancellationHarness.commands.get("lifecycle")!("resume", cancellationHarness.ctx);
    expect(readState(cancellationRun.paths)).toMatchObject({
      phase: "idle",
      graphExecution: { ready: [], nodeStates: { awaiting_spec_approval: { status: "cancelled" } } },
    });
    expect(cancellationHarness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(existsSync(join(cancellationRun.paths.root, "..", "current"))).toBe(false);
  });

  it("enforces human-wait denial and durable timeout while cancellation remains available", async () => {
    const deniedRun = makeRun("awaiting_spec_approval");
    writeFileSync(join(deniedRun.cwd, ".ai-orchestrator.json"), JSON.stringify({ execution: { limits: { humanWait: "deny" } } }));
    const deniedHarness = extensionHarness(deniedRun.cwd);
    await expect(deniedHarness.commands.get("lifecycle")!("resume", deniedHarness.ctx)).resolves.toBeUndefined();
    expect(readState(deniedRun.paths)?.graphExecution?.nodeStates.awaiting_spec_approval?.status).toBe("ready");
    expect(deniedHarness.ctx.ui.select).not.toHaveBeenCalled();
    expect(deniedHarness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(deniedHarness.pi.setModel).toHaveBeenCalled();
    expect(existsSync(deniedRun.paths.executionLease)).toBe(false);
    await deniedHarness.commands.get("lifecycle-stop")!("", deniedHarness.ctx);
    expect(readState(deniedRun.paths)?.phase).toBe("idle");

    const timeoutRun = makeRun("awaiting_plan_approval");
    writeFileSync(join(timeoutRun.cwd, ".ai-orchestrator.json"), JSON.stringify({ execution: { limits: { maxHumanWaitMs: 1 } } }));
    const first = extensionHarness(timeoutRun.cwd);
    (first.ctx as unknown as { hasUI: boolean }).hasUI = false;
    await first.commands.get("lifecycle")!("resume", first.ctx);
    const waiting = readState(timeoutRun.paths)!;
    expect(waiting.graphExecution?.nodeStates.awaiting_plan_approval?.status).toBe("waiting_human");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const resumed = extensionHarness(timeoutRun.cwd);
    await expect(resumed.commands.get("lifecycle")!("resume", resumed.ctx)).resolves.toBeUndefined();
    expect(readFileSync(timeoutRun.paths.journal, "utf8")).toContain("human-wait-timeout");
    expect(resumed.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(existsSync(timeoutRun.paths.executionLease)).toBe(false);
    await expect(resumed.commands.get("lifecycle-stop")!("", resumed.ctx)).resolves.toBeUndefined();
    expect(readState(timeoutRun.paths)).toMatchObject({
      phase: "idle",
      graphExecution: { ready: [], nodeStates: { awaiting_plan_approval: { status: "cancelled" } } },
    });
  });

  it("skips human-wait policy for a yolo ship gate", async () => {
    const run = makeRun("awaiting_ship_approval");
    const state = readState(run.paths)!;
    state.yolo = true;
    overwriteAsLegacy(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ execution: { limits: { humanWait: "deny" } }, ship: { commit: "never", openPr: "never" } }));
    const harness = extensionHarness(run.cwd);

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(readState(run.paths)?.phase).toBe("done");
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalledWith("SHIP report is GO", expect.anything());
  });

  it("fails closed on oversized and post-approval symlink-swapped lifecycle artifacts", async () => {
    const oversizedRun = makeRun("planning");
    writeFileSync(oversizedRun.paths.spec, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const oversizedHarness = extensionHarness(oversizedRun.cwd);
    await oversizedHarness.commands.get("lifecycle")!("resume", oversizedHarness.ctx);
    expect(readFileSync(oversizedRun.paths.journal, "utf8")).toContain("oversized and exceeds its limit");
    expect(oversizedHarness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(oversizedHarness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(existsSync(oversizedRun.paths.executionLease)).toBe(false);

    const swappedRun = makeRun("awaiting_spec_approval");
    const outside = join(swappedRun.cwd, "outside-spec.md");
    writeFileSync(outside, "# Outside authority\n");
    const swappedHarness = extensionHarness(swappedRun.cwd);
    vi.mocked(swappedHarness.ctx.ui.select).mockImplementationOnce(async () => {
      unlinkSync(swappedRun.paths.spec);
      symlinkSync(outside, swappedRun.paths.spec);
      return "Approve";
    });
    await expect(swappedHarness.commands.get("lifecycle")!("resume", swappedHarness.ctx)).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("# Outside authority\n");
    expect(swappedHarness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(swappedHarness.pi.setModel).toHaveBeenCalled();
    expect(existsSync(swappedRun.paths.executionLease)).toBe(false);
  });

  it("uses capability routing for BUILD and an independent VERIFY model", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: {
          "invented/coder": { family: "maker", confidence: 9000, version: "test", scores: { coding: 9500, verification: 6000 } },
          "invented/checker": { family: "checker", confidence: 9000, version: "test", scores: { coding: 6000, verification: 9500 } },
        },
      },
    }));
    const models = ["coder", "checker"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const buildHarness = extensionHarness(run.cwd, models);
    await buildHarness.commands.get("lifecycle")!("resume", buildHarness.ctx);
    expect(readState(run.paths)?.modelSelections).toEqual(expect.arrayContaining([expect.objectContaining({
      stage: "build",
      model: "coder",
      family: "maker",
      routing: expect.objectContaining({ engine: "capability" }),
    })]));
    expect(readState(run.paths)?.modelSelections.at(-1)).toMatchObject({
      stage: "verify", model: "checker", family: "checker", routing: { separation: "different-family" },
    });
    const evidence = readFileSync(run.paths.evidence, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      stage: "build",
      selected: expect.objectContaining({ provider: "invented", model: "coder" }),
    })]));
    expect(JSON.stringify(evidence)).not.toContain("# Plan");

    await buildHarness.events.get("session_shutdown")!({}, buildHarness.ctx as unknown as ExtensionContext);
    const resumeHarness = extensionHarness(run.cwd, models);
    await resumeHarness.commands.get("lifecycle")!("resume", resumeHarness.ctx);
    expect(readState(run.paths)?.modelSelections).toHaveLength(2);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("ambiguous persisted side effect");
    expect(resumeHarness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(readFileSync(run.paths.routing, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("records a fresh routing decision for a later BUILD pass", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: { engine: "capability", unknownCost: "allow", profiles: {
        "invented/coder": { confidence: 9000, version: "test", scores: { coding: 9500 } },
      } },
    }));
    const models = [{ provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }];
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);

    const state = readState(run.paths)!;
    state.buildIterations += 1;
    state.phase = "building";
    overwriteAsLegacy(run.paths, state);
    const next = extensionHarness(run.cwd, models);
    await next.commands.get("lifecycle")!("resume", next.ctx);

    expect(readState(run.paths)?.modelSelections.filter((selection) => selection.stage === "build")).toHaveLength(2);
  });

  it("exposes routing recommendations as a report without mutating policy", async () => {
    const { cwd } = makeRun("planning");
    const harness = extensionHarness(cwd);
    await harness.commands.get("lifecycle-routing-report")!("", harness.ctx);

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("No routing recommendation") }),
      { triggerTurn: false },
    );
    expect(existsSync(join(cwd, ".ai-orchestrator.json"))).toBe(false);
  });

  it("applies and rolls back a confirmed versioned routing recommendation", async () => {
    const { cwd } = makeRun("planning");
    const store = join(cwd, "home", ".ai-orchestrator", "routing-evidence");
    mkdirSync(store, { recursive: true });
    const events = Array.from({ length: 10 }, (_, index) => ({
      version: 1, eventId: `recommend-${index}`, runId: `run-${index}`, decisionId: `decision-${index}`,
      stage: "build", recordedAt: new Date().toISOString(), policyVersion: "policy-v1", profileVersion: "profiles-v1",
      task: { workKind: "feature", risk: "medium", languages: ["typescript"], fileCount: 1 },
      selected: { provider: "p", model: index < 7 ? "strong" : "weak" },
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: { estimatedUsd: 0.01, observedUsd: 0.01 },
      outcome: { type: "stage-ended", verdict: index < 7 ? "approve" : "reject", finalRunStatus: index < 7 ? "done" : "failed", buildIteration: 1 },
    }));
    writeFileSync(join(store, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const userConfigPath = join(cwd, "home", ".ai-orchestrator", "config.json");
    writeFileSync(userConfigPath, `${JSON.stringify({ mcp: { providers: { custom: { baseUrl: "https://provider.example/v1", api: "openai-responses", apiKey: "literal-secret" } } } })}\n`, { mode: 0o600 });
    const harness = extensionHarness(cwd);

    await harness.commands.get("lifecycle-routing-apply")!("1", harness.ctx);
    expect(JSON.parse(readFileSync(userConfigPath, "utf8"))).toMatchObject({
      routing: { stages: { build: { prefer: ["p/strong"] } }, version: expect.stringContaining("recommendation-") },
    });
    expect(statSync(userConfigPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(userConfigPath, "utf8")).toContain("literal-secret");
    const appliedNotice = vi.mocked(harness.ctx.ui.notify).mock.calls.map(([message]) => String(message)).find((message) => message.includes("Applied routing recommendation"));
    const id = /recommendation (\d+-[a-f0-9-]{8})/.exec(appliedNotice ?? "")?.[1];
    expect(id).toBeTruthy();
    const recordPath = join(store, "recommendations", `${id}.json`);
    const pendingRecord = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, `${JSON.stringify({ ...pendingRecord, status: "pending" }, null, 2)}\n`, { mode: 0o600 });

    await harness.commands.get("lifecycle-routing-rollback")!(id!, harness.ctx);
    expect(JSON.parse(readFileSync(userConfigPath, "utf8"))).toMatchObject({ routing: { stages: { build: { prefer: [] } } } });
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({ status: "rolled-back" });
  });

  it("rejects missing prerequisite artifacts before changing model or tools", async () => {
    const run = makeRun("planning");
    writeFileSync(run.paths.spec, "");
    const harness = extensionHarness(run.cwd);

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(harness.pi.setModel).toHaveBeenCalledTimes(1);
    expect(harness.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "test", id: "original-model" }));
    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("spec artifact is missing");
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("persists stage-ended usage, cost, compliance, and profile evidence", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: {
          "invented/coder": { family: "maker", confidence: 9000, version: "coder-profile-v1", scores: { coding: 9500, verification: 6000 } },
          "invented/checker": { family: "checker", confidence: 9000, version: "checker-profile-v1", scores: { coding: 6000, verification: 9500 } },
        },
      },
    }));
    const models = ["coder", "checker"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }));
    const harness = extensionHarness(run.cwd, models);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    await harness.events.get("message_end")!({
      message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: { total: 0.012 } } },
    }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_end")!({ messages: [{ role: "assistant", content: "implemented" }] }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_settled")!({}, harness.ctx as unknown as ExtensionContext);

    const events = readFileSync(run.paths.evidence, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      stage: "build",
      profileVersion: "coder-profile-v1",
      usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: expect.objectContaining({ observedUsd: 0.004 }),
      outcome: expect.objectContaining({ type: "stage-ended", structuredToolCompliance: true }),
    }));
    const userEvents = readFileSync(join(run.cwd, "home", ".ai-orchestrator", "routing-evidence", "events.jsonl"), "utf8");
    expect(userEvents).toContain("coder-profile-v1");
    expect(userEvents).toContain('"type":"stage-ended"');
  });

  it("pauses a resumed run when its frozen routing policy changes", async () => {
    const run = makeRun("building");
    const configPath = join(run.cwd, ".ai-orchestrator.json");
    const writeRoutingConfig = (coding: number) => writeFileSync(configPath, JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: { "invented/coder": { confidence: 9000, version: `v-${coding}`, scores: { coding } } },
      },
    }));
    writeRoutingConfig(9500);
    const models = [{ provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }];
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);
    const unfinishedBuild = readState(run.paths)!;
    unfinishedBuild.phase = "building";
    overwriteAsLegacy(run.paths, unfinishedBuild);

    writeRoutingConfig(9000);
    const resumed = extensionHarness(run.cwd, models);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain("routing policy changed");
    expect(readState(run.paths)?.phase).toBe("building");
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();

    await resumed.commands.get("lifecycle")!("migrate-routing", resumed.ctx);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Routing policy explicitly migrated");
    const migrated = extensionHarness(run.cwd, models);
    await migrated.commands.get("lifecycle")!("resume", migrated.ctx);
    expect(readState(run.paths)?.phase).toBe("verifying");
    expect(readState(run.paths)?.modelSelections.filter(({ stage }) => stage === "build").at(-1)
      ?.routing?.failureCategories).not.toContain("policy-migrated");
  });

  it("retains convergence breakers when a re-plan is unchanged", async () => {
    const run = makeRun("planning");
    const initial = extensionHarness(run.cwd);
    await initial.commands.get("lifecycle")!("resume", initial.ctx);
    await submittedPlanTool(initial).execute("plan", { plan: structuredPlan(1) });
    await initial.events.get("session_shutdown")!({}, initial.ctx as unknown as ExtensionContext);

    const state = readState(run.paths)!;
    state.yolo = true;
    state.rejectionFingerprints = ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"];
    state.planFingerprint = createHash("sha256")
      .update(readFileSync(run.paths.plan, "utf8").trim().replace(/\s+/g, " ").toLowerCase())
      .digest("hex")
      .slice(0, 16);
    writeFixtureState(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ routing: { circuitBreakers: { repeatedRejectionFingerprintLimit: 2 } } }));
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readState(run.paths)?.rejectionFingerprints).toEqual(["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"]);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("identical checker rejections");
  });

  it.each([
    [{ rejectionFingerprints: ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"] }, { repeatedRejectionFingerprintLimit: 2 }, "identical checker rejections"],
    [{ buildEvidenceFingerprints: ["bbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbb"] }, { maxBuildPassesWithoutImprovement: 1 }, "unchanged evidence"],
  ] as const)("pauses BUILD when a convergence circuit breaker trips %#", async (statePatch, breakerPatch, reason) => {
    const run = makeRun("building");
    const state = readState(run.paths)!;
    Object.assign(state, statePatch);
    writeFixtureState(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ routing: { circuitBreakers: breakerPatch } }));
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain(reason);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("pauses before model activation when a routing budget would be exceeded", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        budgets: { maxEstimatedUsdPerStage: 0.001 },
        profiles: {
          "invented/coder": { confidence: 9000, version: "test", scores: { coding: 9500 } },
        },
      },
    }));
    const harness = extensionHarness(run.cwd, [{
      provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
      cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    }]);
    harness.ctx.ui.confirm = vi.fn(async () => false);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.pi.setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "coder" }));
    expect(readFileSync(run.paths.journal, "utf8")).toContain("paused by routing budget");
  });

  it("counts prior user-store events toward the daily routing ceiling", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        budgets: { maxEstimatedUsdPerDay: 0.5 },
        evidence: { enabled: false },
        profiles: { "invented/coder": { confidence: 9000, scores: { coding: 9500 } } },
      },
    }));
    const harness = extensionHarness(run.cwd, [{
      provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }]);
    harness.ctx.ui.confirm = vi.fn(async () => false);
    const userStore = join(run.cwd, "home", ".ai-orchestrator", "routing-evidence");
    mkdirSync(userStore, { recursive: true });
    writeFileSync(join(userStore, "budget.jsonl"), `${JSON.stringify({
      version: 1, eventId: "prior", runId: "prior-run", recordedAt: new Date().toISOString(),
      outcome: "stage-started", estimatedUsd: 0.5,
    })}\n`);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain("daily estimated budget");
    expect(harness.pi.setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "coder" }));
    expect(existsSync(join(userStore, "events.jsonl"))).toBe(false);
  });

  it("does not access runtime tool state while the extension factory is loading", () => {
    const getActiveTools = vi.fn(() => {
      throw new Error("Extension runtime not initialized");
    });
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getActiveTools,
    };

    expect(() => lifecycleExtension(pi as unknown as ExtensionAPI)).not.toThrow();
    expect(getActiveTools).not.toHaveBeenCalled();
  });

  it("persists provider errors as unknown and blocks automatic fallback until reconciliation", async () => {
    const run = makeRun("verifying");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability", unknownCost: "allow",
        profiles: {
          "invented/first": { confidence: 9000, version: "test", scores: { verification: 9500 } },
          "invented/second": { confidence: 9000, version: "test", scores: { verification: 8500 } },
        },
      },
    }));
    const models = ["first", "second"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("message_end")!({ message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } } } }, first.ctx as unknown as ExtensionContext);
    await first.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error" }] }, first.ctx as unknown as ExtensionContext);
    await first.events.get("agent_settled")!({}, first.ctx as unknown as ExtensionContext);
    expect(readState(run.paths)?.graphExecution?.nodeStates.verifying?.sideEffect).toMatchObject({
      status: "unknown",
      outcome: "unknown",
    });

    const resumed = extensionHarness(run.cwd, models);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)?.modelSelections).toEqual([
      expect.objectContaining({ model: "first", routing: expect.objectContaining({ failureCategories: expect.arrayContaining(["provider-error"]) }) }),
    ]);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("ambiguous persisted side effect");
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();
    const ledger = readFileSync(join(run.cwd, "home", ".ai-orchestrator", "routing-evidence", "budget.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "stage-ended", observedUsd: 0.03 })]));
  });

  it("records a typed fallback when the highest-ranked model cannot be activated", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability", unknownCost: "allow",
        profiles: {
          "invented/first": { confidence: 9000, version: "test", scores: { coding: 9500 } },
          "invented/second": { confidence: 9000, version: "test", scores: { coding: 8500 } },
        },
      },
    }));
    const models = ["first", "second"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const harness = extensionHarness(run.cwd, models);
    vi.mocked(harness.pi.setModel).mockImplementation(async (model: unknown) => (model as { id: string }).id !== "first");
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    expect(readState(run.paths)?.modelSelections.at(-1)).toMatchObject({
      model: "second",
      routing: { fallbackCount: 1, attemptedModels: ["invented/first", "invented/second"], failureCategories: ["unavailable"] },
    });
  });

  it("keeps post-BUILD VERIFY away from artifacts/publication and keeps PLAN bash read-only", async () => {
    const buildRun = makeRun("building");
    const buildHarness = extensionHarness(buildRun.cwd);
    await buildHarness.commands.get("lifecycle")!("resume", buildHarness.ctx);
    expect(readState(buildRun.paths)?.phase).toBe("verifying");
    expect(buildHarness.activeTools()).toContain("bash");
    expect(buildHarness.activeTools()).not.toContain("agent_team");

    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git -C . commit -am bypass" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "rm -rf .ai-orchestrator" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git reset --hard" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "edit", input: { path: buildRun.paths.plan } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "write", input: { path: join(buildRun.cwd, ".ai-orchestrator", "active-run.json") } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "edit", input: { path: join(buildRun.cwd, "src.ts") } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });

    const planRun = makeRun("planning");
    writeFileSync(join(planRun.cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const planHarness = extensionHarness(planRun.cwd);
    await planHarness.commands.get("lifecycle")!("resume", planHarness.ctx);
    await expect(planHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, planHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(planHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git diff" } }, planHarness.ctx as unknown as ExtensionContext)).resolves.toBeUndefined();
  });

  it("fails closed when an approved prose plan changes after its legacy graph migration", async () => {
    const run = makeRun("building");
    const first = extensionHarness(run.cwd);
    vi.mocked(first.pi.setModel).mockResolvedValue(false);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    writeFileSync(run.paths.plan, "# Replaced plan\n");

    const resumed = extensionHarness(run.cwd);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("prose plan no longer matches");
  });

  it("protects a custom nested artifact directory after BUILD advances to VERIFY", async () => {
    const cwd = join(tmpdir(), `ai-orchestrator-custom-artifacts-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    const created = createRun(cwd, "src/orch-runs", "custom artifacts");
    writeFileSync(join(cwd, ".gitignore"), "src/orch-runs/\nhome/\n.ai-orchestrator/\n");
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Lifecycle Tests"], { cwd });
    execFileSync("git", ["add", "README.md", ".gitignore"], { cwd });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
    const state = readState(created.paths)!;
    Object.assign(state, { version: 1, graphExecution: undefined, phase: "building", baselinePaths: [], baselineStagedPaths: [], originalModel: { provider: "test", id: "original", thinking: "high" }, modelRestored: false });
    writeFileSync(created.paths.spec, "# Spec\n");
    writeFileSync(created.paths.plan, "# Plan\n");
    overwriteAsLegacy(created.paths, state);
    writeFileSync(join(cwd, ".ai-orchestrator.json"), JSON.stringify({ lifecycle: { artifactsDir: "src/orch-runs" } }));
    const harness = extensionHarness(cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readState(created.paths)?.phase).toBe("verifying");
    await expect(harness.events.get("tool_call")!({ toolName: "edit", input: { path: join(cwd, "src", "feature.ts") } }, harness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(harness.events.get("tool_call")!({ toolName: "edit", input: { path: created.paths.plan } }, harness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
  });

  it("does not expose agent_team during SHIP", async () => {
    const run = makeRun("shipping");
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.activeTools()).toEqual(["read", "grep", "find", "ls", "bash", "ship_decision"]);
  });

  it("releases a live VERIFY model reservation before absorbing lifecycle cancellation", async () => {
    const run = makeRun("building");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readState(run.paths)).toMatchObject({
      phase: "verifying",
      graphExecution: {
        guard: { modelCallsInFlight: 1, providerCallsInFlight: 1 },
        nodeStates: { verifying: { status: "running", sideEffect: { status: "intent_recorded", class: "model" } } },
      },
    });

    await harness.commands.get("lifecycle-stop")!("", harness.ctx);

    expect(readState(run.paths)).toMatchObject({
      phase: "idle",
      modelRestored: true,
      graphExecution: {
        ready: [],
        guard: { modelCallsInFlight: 0, providerCallsInFlight: 0 },
        nodeStates: { verifying: { status: "cancelled", sideEffect: { status: "unknown", class: "model" } } },
      },
    });
    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("recovers changed artifact bytes after a model-intent crash without repeating DEFINE", async () => {
    const run = makeRun("defining");
    const first = extensionHarness(run.cwd);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);
    expect(readState(run.paths)?.graphExecution?.nodeStates.defining?.sideEffect?.status).toBe("unknown");

    writeFileSync(run.paths.spec, "# Specification recovered from the interrupted model call\n");
    const resumed = extensionHarness(run.cwd);
    vi.mocked(resumed.ctx.ui.select).mockResolvedValueOnce("Revise");
    vi.mocked(resumed.ctx.ui.editor).mockResolvedValueOnce("");
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)).toMatchObject({
      phase: "awaiting_spec_approval",
      graphExecution: {
        guard: { modelCallsInFlight: 0, providerCallsInFlight: 0 },
        nodeStates: { defining: { status: "blocked", sideEffect: { status: "succeeded", class: "model" } } },
      },
    });
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(readState(run.paths)?.modelSelections.filter((selection) => selection.stage === "define")).toHaveLength(1);
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("keeps an unchanged artifact request ambiguous after a model-intent crash", async () => {
    const run = makeRun("defining");
    const first = extensionHarness(run.cwd);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);

    const resumed = extensionHarness(run.cwd);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)).toMatchObject({
      phase: "defining",
      graphExecution: {
        guard: { modelCallsInFlight: 0, providerCallsInFlight: 0 },
        nodeStates: { defining: { status: "running", sideEffect: { status: "unknown", class: "model" } } },
      },
    });
    expect(readFileSync(run.paths.journal, "utf8")).toContain("ambiguous persisted side effect");
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("reconciles a durable DEBUG diagnosis before taking the terminal failure edge", async () => {
    const run = makeRun("debugging");
    const prepared = readState(run.paths)!;
    prepared.buildIterations = DEFAULT_CONFIG.loop.maxCoderIterations;
    prepared.consecutiveRejections = 1;
    prepared.verdicts = [{ stage: "verify", verdict: "reject", reasons: "tests still fail", requiredFixes: "repair the defect" }];
    writeFixtureState(run.paths, prepared);

    const first = extensionHarness(run.cwd);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    const debugTool = vi.mocked(first.pi.registerTool).mock.calls.find(([tool]) => (tool as { name?: string }).name === "debug_diagnosis")?.[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await debugTool.execute("diagnosis", {
      rootCause: "The retry budget is exhausted by the same defect",
      evidence: "The final verification still fails",
      confidence: "high",
      recommendedFix: "Re-plan before another build",
      filesLikelyAffected: ["src/feature.ts"],
      validationCommands: ["npm test"],
    });
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);
    expect(readState(run.paths)?.graphExecution?.nodeStates.debugging?.sideEffect?.status).toBe("unknown");

    const resumed = extensionHarness(run.cwd);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)).toMatchObject({
      phase: "failed",
      modelRestored: true,
      graphExecution: {
        ready: [],
        guard: { modelCallsInFlight: 0, providerCallsInFlight: 0 },
        nodeStates: {
          debugging: { status: "failed", sideEffect: { status: "succeeded", class: "model" } },
          failed: { status: "executed" },
        },
      },
    });
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("restores tools, model, and lease after a non-human execution ceiling rejects entry", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      execution: { limits: { maxWallTimeMs: 1 } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const harness = extensionHarness(run.cwd);

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(readState(run.paths)).toMatchObject({
      phase: "building",
      modelRestored: true,
      graphExecution: { nodeStates: { building: { status: "ready" } } },
    });
    expect(readFileSync(run.paths.journal, "utf8")).toContain("wall-time-limit");
    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(harness.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "test", id: "original-model" }));
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("restores tools, model, and lease when shutdown uncertainty checkpointing fails", async () => {
    const run = makeRun("building");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    writeFileSync(run.paths.events, "partial-event-without-newline");

    await expect(harness.events.get("session_shutdown")!({}, harness.ctx as unknown as ExtensionContext))
      .rejects.toThrow(/event log|corrupt|partial/i);

    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(harness.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "test", id: "original-model" }));
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("restores tools, model, and lease when durable cancellation checkpointing fails", async () => {
    const run = makeRun("building");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    writeFileSync(run.paths.events, "partial-event-without-newline");

    await expect(harness.commands.get("lifecycle-stop")!("", harness.ctx))
      .rejects.toThrow(/event log|corrupt|partial/i);

    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
    expect(harness.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "test", id: "original-model" }));
    expect(existsSync(run.paths.executionLease)).toBe(false);
  });

  it("recovers a checker verdict persisted before agent settlement", async () => {
    const run = makeRun("verifying");
    const first = extensionHarness(run.cwd);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    const verifyTool = vi.mocked(first.pi.registerTool).mock.calls.find(([tool]) => (tool as { name?: string }).name === "verify_verdict")?.[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await verifyTool.execute("verdict", { verdict: "approve", reasons: "tests pass" });
    expect(readState(run.paths)?.pendingCheckerVerdict).toMatchObject({ phase: "verifying", verdict: "approve" });
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);

    const resumed = extensionHarness(run.cwd);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)?.phase).not.toBe("verifying");
    expect(readState(run.paths)?.pendingCheckerVerdict).toBeUndefined();
    expect(readFileSync(run.paths.journal, "utf8")).toContain("VERIFY approve: tests pass");
  });

  it("persists modelRestored on the authoritative runtime state", async () => {
    const run = makeRun("shipping");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    await harness.events.get("session_shutdown")!({}, harness.ctx as unknown as ExtensionContext);

    expect(readState(run.paths)?.modelRestored).toBe(true);
  });

  it("does not commit after a stale confirmation cancels the run", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);
    const confirm = vi.mocked(harness.ctx.ui.confirm);
    confirm.mockImplementationOnce(async () => {
      await harness.commands.get("lifecycle-stop")!("", harness.ctx);
      return true;
    });

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["add"]), expect.anything());
    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit"]), expect.anything());
  });

  it("requires fresh consent for an uncommitted finalization checkpoint", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitBaseSha: "abc1234", commitMessage: "Implement crafted checkpoint" };
    writeFixtureState(run.paths, state);
    writeFileSync(join(run.cwd, "feature.ts"), "export const feature = true;\n");
    const harness = extensionHarness(run.cwd);
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "abc1234\n", stderr: "" };
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "?? feature.ts\0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    vi.mocked(harness.ctx.ui.confirm).mockResolvedValue(false);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit"]), expect.anything());
    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["add"]), expect.anything());
  });

  it("retains terminal ownership until failed model restoration is retried", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);
    vi.mocked(harness.pi.setModel).mockResolvedValue(false);

    await harness.commands.get("ship")!("", harness.ctx);

    expect(readState(run.paths)).toMatchObject({ phase: "done", modelRestored: false });
    expect(existsSync(join(run.paths.root, "..", "current"))).toBe(true);

    vi.mocked(harness.pi.setModel).mockResolvedValue(true);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    expect(readState(run.paths)?.modelRestored).toBe(true);
    expect(existsSync(join(run.paths.root, "..", "current"))).toBe(false);
  });

  it("resumes standalone SHIP from finalizing", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("ship")!("", harness.ctx);

    expect(readState(run.paths)?.phase).toBe("done");
  });

  it("recovers a commit created before its SHA checkpoint was persisted", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitBaseSha: "abc1234", commitMessage: "Implement recovered work" };
    writeFixtureState(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ ship: { openPr: "never" } }));
    const harness = extensionHarness(run.cwd);
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "def5678\n", stderr: "" };
      if (command === "git" && args.join(" ") === "rev-parse HEAD^") return { code: 0, stdout: "abc1234\n", stderr: "" };
      if (command === "git" && args.join(" ") === "log -1 --format=%s") return { code: 0, stdout: "Implement recovered work\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readState(run.paths)).toMatchObject({ phase: "done", finalization: { commitSha: "def5678" } });
    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit"]), expect.anything());
  });

  it("refuses PR creation until an explicitly pushed upstream matches HEAD", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitSha: "abc1234" };
    writeFixtureState(run.paths, state);
    const harness = extensionHarness(run.cwd);
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith("git", ["rev-parse", "@{upstream}"], expect.anything());
    expect(harness.exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("explicitly pushed"), "error");
  });

  it("does not open a pull request after a stale confirmation cancels the run", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitSha: "abc1234", prHead: "feature/crafted" };
    writeFixtureState(run.paths, state);
    const harness = extensionHarness(run.cwd);
    const confirm = vi.mocked(harness.ctx.ui.confirm);
    confirm.mockImplementationOnce(async () => {
      await harness.commands.get("lifecycle-stop")!("", harness.ctx);
      return true;
    });

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(harness.exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
  });
});
