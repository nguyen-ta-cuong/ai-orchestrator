import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_EFFECT_ORDINAL,
  buildEffectIdentity,
  type BuildRunningAction,
} from "../src/core/buildExecution.js";
import {
  executeDurableBuildAction,
  type BuildActionExecutor,
} from "../src/lifecycle/buildExecution.js";
import {
  appendBuildDispatchCheckpoint,
  readBuildDispatchLedger,
} from "../src/lifecycle/buildArtifacts.js";
import { acquireRunLease, createRun } from "../src/lifecycle/artifacts.js";

const tempDirs: string[] = [];
const owner = "build-owner";
const now = "2026-07-22T00:00:00.000Z";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "build-execution-lifecycle-"));
  tempDirs.push(cwd);
  const run = createRun(cwd, ".ai-orchestrator/runs", "durable build action");
  acquireRunLease(run.paths, owner);
  const identity = buildEffectIdentity({
    runId: run.runId,
    planVersion: 1,
    planHash: "a".repeat(64),
    nodeId: "inspect",
    visit: 1,
    attempt: 1,
    purpose: "worker",
    ordinal: BUILD_EFFECT_ORDINAL.worker,
    workspace: { kind: "shared" },
  });
  const action: BuildRunningAction = { ...identity, kind: "invoke-worker" };
  return { run, action };
}

function executor(): BuildActionExecutor & {
  execute: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
} {
  return {
    execute: vi.fn(async () => ({
      outcome: "succeeded" as const,
      recordedAt: now,
      receipt: { kind: "worker-output", artifacts: [] },
    })),
    reconcile: vi.fn(async () => ({
      outcome: "succeeded" as const,
      recordedAt: now,
      receipt: { kind: "worker-output", artifacts: [] },
    })),
  };
}

describe("durable BUILD action coordinator", () => {
  it("persists intent before invocation, receipt before result, and replays exact completion without recalling", async () => {
    const { run, action } = fixture();
    const adapter = executor();

    const completed = await executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now });
    expect(completed.checkpoint.status).toBe("succeeded");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(readBuildDispatchLedger(run.paths, 1, "inspect")).toMatchObject({ eventCount: 2 });

    const replayed = await executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now });
    expect(replayed.checkpoint).toEqual(completed.checkpoint);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.reconcile).not.toHaveBeenCalled();
  });

  it("reconciles an unresolved durable intent without invoking the effect again", async () => {
    const { run, action } = fixture();
    const adapter = executor();
    const intent = {
      ...action,
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    const { kind: _kind, ...checkpoint } = intent;
    appendBuildDispatchCheckpoint(run.paths, checkpoint, { owner, expectedHead: null });

    const result = await executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now });
    expect(result.checkpoint.status).toBe("succeeded");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  });

  it("leaves an unresolved intent durable when reconciliation has no proof", async () => {
    const { run, action } = fixture();
    const adapter = executor();
    adapter.execute.mockRejectedValueOnce(new Error("worker transport lost"));
    await expect(executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now }))
      .rejects.toThrow(/transport lost/);
    expect(readBuildDispatchLedger(run.paths, 1, "inspect")).toMatchObject({
      eventCount: 1,
      checkpoints: [{ status: "intent-recorded" }],
    });

    adapter.reconcile.mockResolvedValueOnce(undefined);
    const unresolved = await executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now });
    expect(unresolved.checkpoint.status).toBe("intent-recorded");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  });

  it("reconciles an explicit unknown checkpoint instead of treating it as terminal", async () => {
    const { run, action } = fixture();
    const adapter = executor();
    const { kind: _kind, ...effect } = action;
    const intent = {
      ...effect,
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    const first = appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: null });
    const unknown = { ...intent, status: "unknown" as const };
    appendBuildDispatchCheckpoint(run.paths, unknown, { owner, expectedHead: first.head });

    const result = await executeDurableBuildAction(
      run.paths,
      { ...action, kind: "reconcile-unknown" },
      adapter,
      { owner, recordedAt: now },
    );
    expect(result).toMatchObject({ reconciled: true, checkpoint: { status: "succeeded" } });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  });

  it("records a known failure without a fabricated receipt and rejects forged action identities", async () => {
    const { run, action } = fixture();
    const adapter = executor();
    adapter.execute.mockResolvedValueOnce({ outcome: "failed", recordedAt: now });
    const failed = await executeDurableBuildAction(run.paths, action, adapter, { owner, recordedAt: now });
    expect(failed.checkpoint).toMatchObject({ status: "failed" });
    expect(failed.checkpoint.resultRef).toBeUndefined();

    await expect(executeDurableBuildAction(run.paths, { ...action, requestRef: "b".repeat(64) }, adapter, {
      owner,
      recordedAt: now,
    })).rejects.toThrow(/identity/i);
  });

  it("never turns a synthetic reconciliation request into a first invocation", async () => {
    const { run, action } = fixture();
    const adapter = executor();

    await expect(executeDurableBuildAction(run.paths, { ...action, kind: "reconcile-unknown" }, adapter, {
      owner,
      recordedAt: now,
    })).rejects.toThrow(/existing durable unresolved intent/i);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(readBuildDispatchLedger(run.paths, 1, "inspect")).toMatchObject({ eventCount: 0 });
  });
});
