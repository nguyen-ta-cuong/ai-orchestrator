import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/lifecycle/artifacts.js";
import {
  appendRoutingBudgetLedgerEvent,
  appendRoutingEvidenceEvent,
  readRoutingBudgetLedger,
  readRoutingEvidenceEvents,
  resolveUserEvidenceRoot,
} from "../src/lifecycle/routingEvidenceStore.js";
import type { RoutingEvidenceEvent } from "../src/core/routingEvidence.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-evidence-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("routing evidence store", () => {
  it("appends valid per-run evidence as bounded JSON Lines", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".ai-orchestrator/runs", "task");
    const event = eventFor(run.runId);

    appendRoutingEvidenceEvent({ runPaths: run.paths, event });
    appendRoutingEvidenceEvent({ runPaths: run.paths, event });

    expect(readRoutingEvidenceEvents(run.paths.evidence).events).toEqual([event]);
  });

  it("skips and quarantines corrupt or oversized lines instead of treating them as policy", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".ai-orchestrator/runs", "task");
    writeFileSync(run.paths.evidence, `${JSON.stringify(eventFor(run.runId))}\nnot-json\n${"x".repeat(300_000)}\n`);

    const result = readRoutingEvidenceEvents(run.paths.evidence);

    expect(result.events).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(existsSync(`${run.paths.evidence}.quarantine`)).toBe(true);
  });

  it("keeps the independent budget ledger strict and idempotent", () => {
    const home = makeTempDir();
    const root = resolveUserEvidenceRoot(home, "routing-evidence");
    const event = { version: 1 as const, eventId: "budget-1", runId: "run-1", recordedAt: new Date().toISOString(), outcome: "stage-started" as const, estimatedUsd: 0.1 };
    appendRoutingBudgetLedgerEvent(root, event);
    appendRoutingBudgetLedgerEvent(root, event);
    expect(readRoutingBudgetLedger(join(root, "budget.jsonl"))).toEqual([event]);

    writeFileSync(join(root, "budget.jsonl"), `${JSON.stringify({ ...event, rawPrompt: "SECRET" })}\n`);
    expect(() => readRoutingBudgetLedger(join(root, "budget.jsonl"))).toThrow(/corrupt/);
  });

  it("keeps user evidence storage inside the trusted user root", () => {
    const home = makeTempDir();
    const root = resolveUserEvidenceRoot(home, "routing-evidence");
    expect(root).toBe(join(realpathSync(home), ".ai-orchestrator", "routing-evidence"));
    expect(() => resolveUserEvidenceRoot(home, "../outside")).toThrow(/inside the user ai-orchestrator directory/);
  });

  it("rejects symlink escape for the user evidence root", () => {
    const home = makeTempDir();
    const outside = makeTempDir();
    mkdirSync(join(home, ".ai-orchestrator"), { recursive: true });
    symlinkSync(outside, join(home, ".ai-orchestrator", "routing-evidence"));

    expect(() => resolveUserEvidenceRoot(home, "routing-evidence")).toThrow(/must not contain symlinks/);
  });

  it("rejects a symlinked per-run evidence file", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();
    const run = createRun(cwd, ".ai-orchestrator/runs", "task");
    const outsideFile = join(outside, "events.jsonl");
    writeFileSync(outsideFile, "outside\n");
    unlinkSync(run.paths.evidence);
    symlinkSync(outsideFile, run.paths.evidence);

    expect(() => appendRoutingEvidenceEvent({ runPaths: run.paths, event: eventFor(run.runId) })).toThrow(/must not contain symlinks/);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });
});

function eventFor(runId: string): RoutingEvidenceEvent {
  return {
    version: 1,
    eventId: "event-1",
    runId,
    decisionId: "decision-1",
    stage: "build",
    recordedAt: "2026-07-12T00:00:00.000Z",
    policyVersion: "policy-v1",
    profileVersion: "profiles-v1",
    task: { workKind: "feature", risk: "medium", languages: ["typescript"], fileCount: 1 },
    selected: { provider: "p", model: "m" },
    usage: { inputTokens: "unknown", outputTokens: "unknown", cacheReadTokens: "unknown", cacheWriteTokens: "unknown" },
    cost: { estimatedUsd: "unknown", observedUsd: "unknown" },
    outcome: { type: "stage-started", buildIteration: 0 },
  };
}
