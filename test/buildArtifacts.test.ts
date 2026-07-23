import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBuildPlan, compileLegacySequentialBuildPlan } from "../src/core/buildPlan.js";
import {
  BUILD_EFFECT_ORDINAL,
  buildEffectIdentity,
  type BuildDispatchCheckpoint,
} from "../src/core/buildExecution.js";
import {
  appendBuildDispatchCheckpoint,
  buildPlanVersionForSubmission,
  readBuildDispatchLedger,
  readImmutableBuildPlan,
  recoverIncompleteBuildPlan,
  sealBuildDispatchLedger,
  writeBuildEffectReceipt,
  writeImmutableBuildPlan,
} from "../src/lifecycle/buildArtifacts.js";
import { acquireRunLease, createRun, releaseRunLease } from "../src/lifecycle/artifacts.js";

const tempDirs: string[] = [];
const artifactsDir = ".ai-orchestrator/runs";
const owner = "build-owner";
const now = "2026-07-22T00:00:00.000Z";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "build-artifacts-"));
  tempDirs.push(cwd);
  const run = createRun(cwd, artifactsDir, "build artifacts");
  acquireRunLease(run.paths, owner);
  return { cwd, run };
}

function checkpoint(
  compiled: ReturnType<typeof compileLegacySequentialBuildPlan>,
  runId: string,
  status: BuildDispatchCheckpoint["status"],
  resultRef?: string,
  attempt = 1,
): BuildDispatchCheckpoint {
  const identity = buildEffectIdentity({
    runId,
    planVersion: compiled.plan.planVersion,
    planHash: compiled.hash,
    nodeId: "legacy-build",
    visit: 1,
    attempt,
    purpose: "worker",
    ordinal: BUILD_EFFECT_ORDINAL.worker,
    workspace: { kind: "shared" },
  });
  return {
    ...identity,
    schemaVersion: 1,
    status,
    recordedAt: now,
    ...(resultRef === undefined ? {} : { resultRef }),
  };
}

describe("immutable BUILD artifacts", () => {
  it("writes canonical structured JSON and generated Markdown once per plan version", () => {
    const { run } = fixture();
    const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    const written = writeImmutableBuildPlan(run.paths, compiled, { owner });

    expect(written).toMatchObject({ planVersion: 1, planHash: compiled.hash });
    expect(readFileSync(written.graphPath, "utf8")).toBe(`${compiled.canonicalJson}\n`);
    expect(readFileSync(written.markdownPath, "utf8")).toContain(`Plan hash: \`${compiled.hash}\``);
    expect(readImmutableBuildPlan(run.paths, 1).hash).toBe(compiled.hash);
    expect(writeImmutableBuildPlan(run.paths, compiled, { owner })).toEqual(written);

    const collision = compileLegacySequentialBuildPlan("Different approved prose.", 1, ["src"]);
    expect(() => writeImmutableBuildPlan(run.paths, collision, { owner })).toThrow(/immutable.*version|collision/i);
    expect(buildPlanVersionForSubmission(run.paths)).toBe(2);
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it.each(["after-reservation", "after-graph", "after-markdown"] as const)(
    "recovers a crash %s from the single immutable submission reservation",
    (failurePoint) => {
      const { run } = fixture();
      const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
      expect(() => writeImmutableBuildPlan(run.paths, compiled, {
        owner,
        failAt(point) {
          if (point === failurePoint) throw new Error(`crash at ${point}`);
        },
      })).toThrow(/crash/);

      expect(buildPlanVersionForSubmission(run.paths)).toBe(1);
      expect(recoverIncompleteBuildPlan(run.paths, { owner })).toMatchObject({
        planVersion: 1,
        planHash: compiled.hash,
      });
      expect(readImmutableBuildPlan(run.paths, 1).hash).toBe(compiled.hash);
      expect(buildPlanVersionForSubmission(run.paths)).toBe(2);
    },
  );

  it("rejects skipped versions and refuses to advance past a corrupt latest version", () => {
    const skipped = fixture();
    expect(() => writeImmutableBuildPlan(
      skipped.run.paths,
      compileLegacySequentialBuildPlan("Skipped version.", 2, ["src"]),
      { owner },
    )).toThrow(/next durable submission version/i);

    const { run } = fixture();
    const compiled = compileLegacySequentialBuildPlan("Version one.", 1, ["src"]);
    const written = writeImmutableBuildPlan(run.paths, compiled, { owner });
    writeFileSync(written.manifestPath, "{}\n");
    expect(() => buildPlanVersionForSubmission(run.paths)).toThrow(/manifest|identity|canonical/i);
    expect(() => writeImmutableBuildPlan(
      run.paths,
      compileLegacySequentialBuildPlan("Version two.", 2, ["src"]),
      { owner },
    )).toThrow(/manifest|identity|canonical/i);
  });

  it("appends intent and terminal receipt under CAS, replays exact duplicates, and seals the ledger head", () => {
    const { run } = fixture();
    const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const intent = checkpoint(compiled, run.runId, "intent-recorded");

    const first = appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: null });
    expect(first.eventCount).toBe(1);
    expect(first.head).toMatch(/^[a-f0-9]{64}$/);
    expect(appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: null })).toEqual(first);

    const receipt = writeBuildEffectReceipt(run.paths, intent, {
      schemaVersion: 1,
      kind: "worker-output",
      artifactRefs: [],
    }, { owner });
    const succeeded = checkpoint(compiled, run.runId, "succeeded", receipt.sha256);
    const second = appendBuildDispatchCheckpoint(run.paths, succeeded, { owner, expectedHead: first.head });
    expect(second.eventCount).toBe(2);
    expect(() => appendBuildDispatchCheckpoint(run.paths, {
      ...succeeded,
      status: "failed",
      resultRef: undefined,
    }, { owner, expectedHead: second.head })).toThrow(/already settled|conflict/i);

    const incomplete = readBuildDispatchLedger(run.paths, 1, "legacy-build");
    expect(incomplete.head).toBe(second.head);
    expect(incomplete.checkpoints).toEqual([succeeded]);
    expect(() => sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 1,
      expectedHead: second.head!,
    }, { owner })).toThrow(/exact succeeded effect set/i);

    const artifactBytes = "validated legacy output\n";
    const artifactPath = "nodes/1/legacy-build/legacy-build-output.txt";
    mkdirSync(join(run.paths.root, "nodes", "1", "legacy-build"), { recursive: true });
    writeFileSync(join(run.paths.root, ...artifactPath.split("/")), artifactBytes);
    const artifact = {
      planVersion: 1,
      nodeId: "legacy-build",
      contract: "legacy-build-output",
      path: artifactPath,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      sizeBytes: Buffer.byteLength(artifactBytes),
    };
    const validatorIdentity = buildEffectIdentity({
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 1,
      purpose: "validator",
      ordinal: BUILD_EFFECT_ORDINAL.validator,
      workspace: { kind: "shared" },
    });
    const validatorIntent: BuildDispatchCheckpoint = {
      ...validatorIdentity,
      schemaVersion: 1,
      status: "intent-recorded",
      recordedAt: now,
    };
    const third = appendBuildDispatchCheckpoint(run.paths, validatorIntent, { owner, expectedHead: second.head });
    const validatorReceipt = writeBuildEffectReceipt(run.paths, validatorIdentity, {
      schemaVersion: 1,
      kind: "validated-build-outputs",
      artifactRefs: [artifact],
    }, { owner });
    const validatorSuccess: BuildDispatchCheckpoint = {
      ...validatorIdentity,
      schemaVersion: 1,
      status: "succeeded",
      recordedAt: now,
      resultRef: validatorReceipt.sha256,
    };
    const complete = appendBuildDispatchCheckpoint(run.paths, validatorSuccess, { owner, expectedHead: third.head });
    const receiptBytes = readFileSync(join(run.paths.root, ...validatorReceipt.path.split("/")), "utf8");
    writeFileSync(join(run.paths.root, ...validatorReceipt.path.split("/")), "{}\n");
    expect(() => sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 1,
      expectedHead: complete.head!,
    }, { owner })).toThrow(/receipt.*checkpoint|receipt bytes/i);
    writeFileSync(join(run.paths.root, ...validatorReceipt.path.split("/")), receiptBytes);

    writeFileSync(join(run.paths.root, ...artifactPath.split("/")), "tampered output\n");
    expect(() => sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 1,
      expectedHead: complete.head!,
    }, { owner })).toThrow(/artifact.*bytes/i);
    writeFileSync(join(run.paths.root, ...artifactPath.split("/")), artifactBytes);

    const sealed = sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 1,
      expectedHead: complete.head!,
    }, { owner });
    expect(sealed).toMatchObject({
      planVersion: 1,
      nodeId: "legacy-build",
      contract: "build-dispatch-ledger",
    });
    expect(sealed.path).toBe("nodes/1/legacy-build/build-dispatch-seal.json");
  });

  it("seals a successful retry while preserving terminal evidence from the failed attempt", () => {
    const { run } = fixture();
    const base = compileLegacySequentialBuildPlan("Implement it with one retry.", 1, ["src"]);
    const compiled = compileBuildPlan({
      ...base.plan,
      nodes: base.plan.nodes.map((node) => ({ ...node, retryLimit: 1 })),
    });
    writeImmutableBuildPlan(run.paths, compiled, { owner });

    const firstIntent = checkpoint(compiled, run.runId, "intent-recorded", undefined, 1);
    let ledger = appendBuildDispatchCheckpoint(run.paths, firstIntent, { owner, expectedHead: null });
    const firstFailed = checkpoint(compiled, run.runId, "failed", undefined, 1);
    ledger = appendBuildDispatchCheckpoint(run.paths, firstFailed, { owner, expectedHead: ledger.head });

    const secondIntent = checkpoint(compiled, run.runId, "intent-recorded", undefined, 2);
    ledger = appendBuildDispatchCheckpoint(run.paths, secondIntent, { owner, expectedHead: ledger.head });
    const workerReceipt = writeBuildEffectReceipt(run.paths, secondIntent, { schemaVersion: 1, kind: "worker-output" }, { owner });
    const secondSucceeded = checkpoint(compiled, run.runId, "succeeded", workerReceipt.sha256, 2);
    ledger = appendBuildDispatchCheckpoint(run.paths, secondSucceeded, { owner, expectedHead: ledger.head });

    const artifactBytes = "retry output\n";
    const artifactPath = "nodes/1/legacy-build/legacy-build-output.txt";
    mkdirSync(join(run.paths.root, "nodes", "1", "legacy-build"), { recursive: true });
    writeFileSync(join(run.paths.root, ...artifactPath.split("/")), artifactBytes);
    const artifact = {
      planVersion: 1,
      nodeId: "legacy-build",
      contract: "legacy-build-output",
      path: artifactPath,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      sizeBytes: Buffer.byteLength(artifactBytes),
    };
    const validator = buildEffectIdentity({
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 2,
      purpose: "validator",
      ordinal: BUILD_EFFECT_ORDINAL.validator,
      workspace: { kind: "shared" },
    });
    const validatorIntent: BuildDispatchCheckpoint = {
      ...validator,
      schemaVersion: 1,
      status: "intent-recorded",
      recordedAt: now,
    };
    ledger = appendBuildDispatchCheckpoint(run.paths, validatorIntent, { owner, expectedHead: ledger.head });
    const validationReceipt = writeBuildEffectReceipt(run.paths, validator, {
      schemaVersion: 1,
      kind: "validated-build-outputs",
      artifactRefs: [artifact],
    }, { owner });
    ledger = appendBuildDispatchCheckpoint(run.paths, {
      ...validator,
      schemaVersion: 1,
      status: "succeeded",
      recordedAt: now,
      resultRef: validationReceipt.sha256,
    }, { owner, expectedHead: ledger.head });

    expect(sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 2,
      expectedHead: ledger.head!,
    }, { owner })).toMatchObject({ contract: "build-dispatch-ledger" });
    expect(() => sealBuildDispatchLedger(run.paths, {
      runId: run.runId,
      planVersion: 1,
      planHash: compiled.hash,
      nodeId: "legacy-build",
      visit: 1,
      attempt: 3,
      expectedHead: ledger.head!,
    }, { owner })).toThrow(/retry|attempt/i);
  });

  it("keeps an unknown outcome unresolved until reconciliation proves a terminal result", () => {
    const { run } = fixture();
    const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    const intent = checkpoint(compiled, run.runId, "intent-recorded");
    const first = appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: null });
    const unknown = checkpoint(compiled, run.runId, "unknown");
    const uncertain = appendBuildDispatchCheckpoint(run.paths, unknown, { owner, expectedHead: first.head });
    expect(uncertain.checkpoints).toMatchObject([{ status: "unknown" }]);

    const otherIntent = {
      ...buildEffectIdentity({
        runId: run.runId,
        planVersion: 1,
        planHash: compiled.hash,
        nodeId: "legacy-build",
        visit: 1,
        attempt: 1,
        purpose: "validator" as const,
        ordinal: BUILD_EFFECT_ORDINAL.validator,
        workspace: { kind: "shared" as const },
      }),
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    expect(() => appendBuildDispatchCheckpoint(run.paths, otherIntent, {
      owner,
      expectedHead: uncertain.head,
    })).toThrow(/unresolved/i);

    const receipt = writeBuildEffectReceipt(run.paths, intent, { kind: "reconciled-worker-output" }, { owner });
    const succeeded = checkpoint(compiled, run.runId, "succeeded", receipt.sha256);
    const settled = appendBuildDispatchCheckpoint(run.paths, succeeded, { owner, expectedHead: uncertain.head });
    expect(settled.checkpoints).toMatchObject([{ status: "succeeded", resultRef: receipt.sha256 }]);
  });

  it("fails closed on stale heads, missing lease ownership, corrupt suffixes, and symlinked paths", () => {
    const { run } = fixture();
    const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    const intent = checkpoint(compiled, run.runId, "intent-recorded");
    const first = appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: null });
    const other = {
      ...buildEffectIdentity({
        runId: intent.runId,
        planVersion: intent.planVersion,
        planHash: intent.planHash,
        nodeId: intent.nodeId,
        visit: intent.visit,
        attempt: intent.attempt,
        purpose: "validator" as const,
        ordinal: BUILD_EFFECT_ORDINAL.validator,
        workspace: intent.workspace,
      }),
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    expect(() => appendBuildDispatchCheckpoint(run.paths, other, { owner, expectedHead: null })).toThrow(/revision|head/i);

    const ledgerPath = join(run.paths.nodes, "1", "legacy-build", "build-dispatch.jsonl");
    writeFileSync(ledgerPath, `${readFileSync(ledgerPath, "utf8")}not-json\n`);
    expect(() => readBuildDispatchLedger(run.paths, 1, "legacy-build")).toThrow(/corrupt|JSON|canonical/i);

    expect(releaseRunLease(run.paths, owner)).toBe(true);
    expect(() => appendBuildDispatchCheckpoint(run.paths, intent, { owner, expectedHead: first.head })).toThrow(/lease/i);

    const second = fixture();
    const nodeVersion = join(second.run.paths.nodes, "1");
    mkdirSync(nodeVersion, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "build-artifacts-outside-"));
    tempDirs.push(outside);
    symlinkSync(outside, join(nodeVersion, "legacy-build"));
    const secondCompiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    expect(() => appendBuildDispatchCheckpoint(
      second.run.paths,
      checkpoint(secondCompiled, second.run.runId, "intent-recorded"),
      { owner, expectedHead: null },
    )).toThrow(/symlink/i);

    const third = fixture();
    const thirdNode = join(third.run.paths.nodes, "1", "legacy-build");
    mkdirSync(thirdNode, { recursive: true });
    const outsideLedger = join(outside, "outside-ledger.jsonl");
    writeFileSync(outsideLedger, "");
    symlinkSync(outsideLedger, join(thirdNode, "build-dispatch.jsonl"));
    const thirdCompiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
    expect(() => appendBuildDispatchCheckpoint(
      third.run.paths,
      checkpoint(thirdCompiled, third.run.runId, "intent-recorded"),
      { owner, expectedHead: null },
    )).toThrow(/symlink/i);
    expect(readFileSync(outsideLedger, "utf8")).toBe("");
  });

  it("rejects an oversized ledger from the opened descriptor before parsing", () => {
    const { run } = fixture();
    const nodeDirectory = join(run.paths.nodes, "1", "legacy-build");
    mkdirSync(nodeDirectory, { recursive: true });
    writeFileSync(join(nodeDirectory, "build-dispatch.jsonl"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));

    expect(() => readBuildDispatchLedger(run.paths, 1, "legacy-build")).toThrow(/bounded regular file/i);
  });
});
