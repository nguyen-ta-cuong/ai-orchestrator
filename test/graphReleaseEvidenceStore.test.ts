import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAPH_ENGINE_FEATURES,
  createGraphExperimentManifest,
  type GraphEvidenceEvent,
  type GraphExperimentManifest,
  type GraphRunEvidenceEvent,
  type GraphStageEvidenceEvent,
} from "../src/core/graphEvidence.js";
import {
  GraphReleaseEvidenceError,
  digestGraphReleaseArtifact,
  encodeGraphReleaseArtifact,
  resolveUserGraphReleaseRoot,
  verifyGraphReleaseRecord,
  type GraphCleanRollbackArtifact,
  type GraphConfigMigrationArtifact,
  type GraphCoverageArtifact,
  type GraphReleaseRecord,
  type GraphRolloutDecision,
  type GraphRolloutDecisionArtifact,
} from "../src/lifecycle/graphReleaseEvidenceStore.js";

const trustedHome = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => trustedHome.path };
});

const tempDirs: string[] = [];
const engineGroups = ["G0", "G1", "G2", "G3", "G4", "G5", "G6"] as const;
const taskCategories = [
  "small-fix",
  "multi-file-feature",
  "test-failure",
  "refactor",
  "persistence-change",
  "security-sensitive",
  "read-only-analysis",
  "conflicting-writes",
] as const;

function opaqueId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function validatorsForCategory(
  taskCategory: GraphRunEvidenceEvent["taskCategory"],
): GraphRunEvidenceEvent["validatorTypes"] {
  if (taskCategory === "security-sensitive") return ["tests", "security"];
  if (taskCategory === "read-only-analysis") return ["structured-tool", "tests"];
  return ["tests"];
}

function makeTempDir(): string {
  const path = join(tmpdir(), `ai-orchestrator-graph-release-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function verifyFixture(fixture: ReturnType<typeof writeReleaseFixture>) {
  trustedHome.path = fixture.home;
  return verifyGraphReleaseRecord({ releaseVersion: fixture.releaseVersion });
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("trusted graph release evidence", () => {
  it("verifies canonical artifact bytes and removes only the verified-artifact retirement blocker", () => {
    const fixture = writeReleaseFixture(makeTempDir());

    expect(verifyFixture(fixture)).toEqual({
      eligible: true,
      missing: [],
      releaseVersion: fixture.releaseVersion,
      decision: "enable-sequential-graph",
      artifactDigests: fixture.record.artifactDigests,
    });
  });

  it("keeps a fully verified record ineligible until a released compatibility window exists", () => {
    const fixture = writeReleaseFixture(makeTempDir(), 0);

    expect(verifyFixture(fixture)).toMatchObject({
      eligible: false,
      missing: ["released-compatibility-window"],
    });
  });

  it("authenticates a report-derived keep-shadow decision without making retirement eligible", () => {
    const fixture = writeReleaseFixture(makeTempDir(), 1, "keep-graph-shadow");

    expect(verifyFixture(fixture)).toMatchObject({
      eligible: false,
      missing: ["decision-ready-rollout-report"],
      decision: "keep-graph-shadow",
    });
  });

  it("rejects changed, non-canonical, and symlinked artifact bytes", () => {
    const changed = writeReleaseFixture(makeTempDir());
    const coverage = JSON.parse(readFileSync(join(changed.releaseRoot, "graph-coverage.json"), "utf8")) as GraphCoverageArtifact;
    coverage.suites.fast.passed += 1;
    writeFileSync(join(changed.releaseRoot, "graph-coverage.json"), encodeGraphReleaseArtifact(coverage));
    expect(() => verifyFixture(changed)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "artifact-digest-mismatch" }),
    );

    const nonCanonical = writeReleaseFixture(makeTempDir());
    const recordPath = join(nonCanonical.releaseRoot, "release-record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as GraphReleaseRecord;
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    expect(() => verifyFixture(nonCanonical)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const linked = writeReleaseFixture(makeTempDir());
    const outside = join(makeTempDir(), "coverage.json");
    writeFileSync(outside, readFileSync(join(linked.releaseRoot, "graph-coverage.json")));
    unlinkSync(join(linked.releaseRoot, "graph-coverage.json"));
    symlinkSync(outside, join(linked.releaseRoot, "graph-coverage.json"));
    expect(() => verifyFixture(linked)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );
  });

  it("rejects digest-matched evidence for the wrong graph release or a backwards compatibility window", () => {
    const wrongGraph = writeReleaseFixture(makeTempDir());
    const coveragePath = join(wrongGraph.releaseRoot, "graph-coverage.json");
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as GraphCoverageArtifact;
    coverage.graphVersion = "2.0.0";
    const coverageBytes = encodeGraphReleaseArtifact(coverage);
    writeFileSync(coveragePath, coverageBytes);
    wrongGraph.record.artifactDigests.graphCoverage = digestGraphReleaseArtifact(coverageBytes);
    writeFileSync(
      join(wrongGraph.releaseRoot, "release-record.json"),
      encodeGraphReleaseArtifact(wrongGraph.record),
    );
    expect(() => verifyFixture(wrongGraph)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const backwardsWindow = writeReleaseFixture(makeTempDir());
    backwardsWindow.record.compatibilityWindowReleases = ["1.0.0"];
    writeFileSync(
      join(backwardsWindow.releaseRoot, "release-record.json"),
      encodeGraphReleaseArtifact(backwardsWindow.record),
    );
    expect(() => verifyFixture(backwardsWindow)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-record" }),
    );
  });

  it("derives a fixed release store from the trusted home and rejects caller-selected roots", () => {
    const home = makeTempDir();
    trustedHome.path = home;
    expect(resolveUserGraphReleaseRoot()).toBe(join(realpathSync(home), ".ai-orchestrator", "graph-releases"));
    expect(() => verifyGraphReleaseRecord({
      homeDirectory: resolveUserGraphReleaseRoot(),
      releaseVersion: "1.1.0",
    } as never)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-user-store" }),
    );

    const fixture = writeReleaseFixture(makeTempDir(), 0);
    trustedHome.path = fixture.home;
    expect(() => verifyGraphReleaseRecord({
      homeDirectory: fixture.home,
      userStoreRoot: fixture.root,
      releaseVersion: fixture.releaseVersion,
    } as never)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-user-store" }),
    );

    const linkedHome = makeTempDir();
    const outside = makeTempDir();
    mkdirSync(join(linkedHome, ".ai-orchestrator"), { recursive: true });
    symlinkSync(outside, join(linkedHome, ".ai-orchestrator", "graph-releases"));
    trustedHome.path = linkedHome;
    expect(() => resolveUserGraphReleaseRoot()).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-user-store" }),
    );
  });

  it("rejects unsafe writable directories in the trusted release path", () => {
    const fixture = writeReleaseFixture(makeTempDir(), 0);
    chmodSync(fixture.root, 0o777);

    expect(() => verifyFixture(fixture)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-user-store" }),
    );

    const writableArtifact = writeReleaseFixture(makeTempDir(), 0);
    chmodSync(join(writableArtifact.releaseRoot, "graph-coverage.json"), 0o666);
    expect(() => verifyFixture(writableArtifact)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );
  });

  it.each(["win32", "android"] as const)(
    "fails closed on %s without a trusted ownership and ACL adapter",
    (platform) => {
      const fixture = writeReleaseFixture(makeTempDir(), 0);
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: platform });
        expect(() => verifyFixture(fixture)).toThrowError(
          expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-user-store" }),
        );
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    },
  );

  it("requires each claimed compatibility window to be a canonical later release bundle", () => {
    const nonexistent = writeReleaseFixture(makeTempDir());
    rmSync(join(nonexistent.root, "1.2.0"), { recursive: true });
    expect(() => verifyFixture(nonexistent)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-record" }),
    );

    const prerelease = writeReleaseFixture(makeTempDir());
    prerelease.record.compatibilityWindowReleases = ["1.2.0-rc.1"];
    writeFileSync(
      join(prerelease.releaseRoot, "release-record.json"),
      encodeGraphReleaseArtifact(prerelease.record),
    );
    expect(() => verifyFixture(prerelease)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-record" }),
    );

    const linked = writeReleaseFixture(makeTempDir());
    const outside = join(makeTempDir(), "1.2.0");
    renameSync(join(linked.root, "1.2.0"), outside);
    symlinkSync(outside, join(linked.root, "1.2.0"));
    expect(() => verifyFixture(linked)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-record" }),
    );
  });

  it("requires rollback and config round-trip evidence to chain through every compatibility release", () => {
    const incompatibleRollback = writeReleaseFixture(makeTempDir());
    rewriteCompatibilityArtifact(incompatibleRollback, "clean-rollback.json", "cleanRollback", (artifact) => {
      artifact.previousReleaseVersion = "1.0.0";
    });
    expect(() => verifyFixture(incompatibleRollback)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const incompatibleMigration = writeReleaseFixture(makeTempDir());
    rewriteCompatibilityArtifact(incompatibleMigration, "config-migration.json", "configMigration", (artifact) => {
      artifact.sourceReleaseVersion = "1.0.0";
    });
    expect(() => verifyFixture(incompatibleMigration)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const validChain = writeReleaseFixture(makeTempDir(), 2);
    expect(verifyFixture(validChain)).toMatchObject({ eligible: true, missing: [] });

    const brokenSecondLink = writeReleaseFixture(makeTempDir(), 2);
    rewriteCompatibilityArtifact(
      brokenSecondLink,
      "clean-rollback.json",
      "cleanRollback",
      (artifact) => {
        artifact.previousReleaseVersion = brokenSecondLink.releaseVersion;
      },
      "1.3.0",
    );
    expect(() => verifyFixture(brokenSecondLink)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const brokenConfigContinuity = writeReleaseFixture(makeTempDir(), 2);
    rewriteCompatibilityArtifact(
      brokenConfigContinuity,
      "config-migration.json",
      "configMigration",
      (artifact) => {
        artifact.beforeConfigDigest = opaqueId("unrelated-source-config");
        artifact.roundTripConfigDigest = opaqueId("unrelated-source-config");
      },
      "1.3.0",
    );
    expect(() => verifyFixture(brokenConfigContinuity)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );
  });

  it("semantically validates later rollout and coverage evidence against the retained default", () => {
    const malformedRollout = writeReleaseFixture(makeTempDir());
    rewriteCompatibilityArtifact(
      malformedRollout,
      "rollout-report.json",
      "rolloutReport",
      (artifact) => { artifact.decision = "keep-graph-shadow"; },
    );
    expect(() => verifyFixture(malformedRollout)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const regressedCoverage = writeReleaseFixture(makeTempDir());
    rewriteCompatibilityArtifact(
      regressedCoverage,
      "graph-coverage.json",
      "graphCoverage",
      (artifact) => {
        const suites = artifact.suites as Record<string, Record<string, unknown>>;
        suites.fast!.failed = 1;
      },
    );
    expect(() => verifyFixture(regressedCoverage)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );

    const changedDefault = writeReleaseFixture(makeTempDir());
    rewriteCompatibilityDecision(changedDefault, "keep-graph-shadow");
    expect(() => verifyFixture(changedDefault)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );
  });

  it("rejects release records at the byte limit plus one without an unbounded read", () => {
    const fixture = writeReleaseFixture(makeTempDir(), 0);
    writeFileSync(join(fixture.releaseRoot, "release-record.json"), Buffer.alloc((64 * 1024) + 1, 0x20));

    expect(() => verifyFixture(fixture)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "invalid-release-artifact" }),
    );
  });

  it("enforces one cumulative byte budget across all compatibility-window reads", () => {
    const fixture = writeReleaseFixture(makeTempDir(), 16);

    expect(() => verifyFixture(fixture)).toThrowError(
      expect.objectContaining<Partial<GraphReleaseEvidenceError>>({ code: "release-read-budget-exceeded" }),
    );
  }, 20_000);
});

function writeReleaseFixture(
  home: string,
  compatibilityWindows = 1,
  decision: GraphRolloutDecision = "enable-sequential-graph",
): {
  home: string;
  root: string;
  releaseRoot: string;
  releaseVersion: string;
  record: GraphReleaseRecord;
} {
  const releaseVersion = "1.1.0";
  trustedHome.path = home;
  const root = resolveUserGraphReleaseRoot();
  const releaseRoot = join(root, releaseVersion);
  mkdirSync(releaseRoot, { recursive: true });

  const manifest = experimentManifest(releaseVersion);
  const rollout: GraphRolloutDecisionArtifact = {
    schemaVersion: 1,
    kind: "graph-rollout-decision",
    releaseVersion,
    decision,
    experimentManifest: manifest,
    events: experimentEvents(manifest, decision !== "keep-graph-shadow"),
  };
  const coverage: GraphCoverageArtifact = {
    schemaVersion: 1,
    kind: "graph-coverage",
    releaseVersion,
    graphVersion: "1.0.0",
    suites: {
      fast: passingSuite(),
      lifecycleSequential: passingSuite(),
      lifecycleDag: passingSuite(),
      recovery: passingSuite(),
      parallelIsolation: passingSuite(),
    },
  };
  const rollback: GraphCleanRollbackArtifact = {
    schemaVersion: 1,
    kind: "graph-clean-rollback",
    releaseVersion,
    previousReleaseVersion: "1.0.0",
    packageRollbackExitCode: 0,
    restoredEngine: "graph-shadow",
    workingTreeCleanBefore: true,
    workingTreeCleanAfter: true,
  };
  const migration: GraphConfigMigrationArtifact = {
    schemaVersion: 1,
    kind: "graph-config-migration",
    releaseVersion,
    sourceReleaseVersion: "1.0.0",
    sourceSchemaVersion: 1,
    targetSchemaVersion: 2,
    forwardExitCode: 0,
    backwardExitCode: 0,
    beforeConfigDigest: opaqueId("config-1.0.0"),
    afterConfigDigest: opaqueId(`config-${releaseVersion}`),
    roundTripConfigDigest: opaqueId("config-1.0.0"),
    rollbackEngine: "graph-shadow",
  };
  const artifacts = {
    rolloutReport: encodeGraphReleaseArtifact(rollout),
    graphCoverage: encodeGraphReleaseArtifact(coverage),
    cleanRollback: encodeGraphReleaseArtifact(rollback),
    configMigration: encodeGraphReleaseArtifact(migration),
  };
  for (const [name, contents] of Object.entries({
    "rollout-report.json": artifacts.rolloutReport,
    "graph-coverage.json": artifacts.graphCoverage,
    "clean-rollback.json": artifacts.cleanRollback,
    "config-migration.json": artifacts.configMigration,
  })) writeFileSync(join(releaseRoot, name), contents);

  const compatibilityWindowReleases = Array.from(
    { length: compatibilityWindows },
    (_, index) => `1.${index + 2}.0`,
  );
  const record: GraphReleaseRecord = {
    schemaVersion: 1,
    releaseVersion,
    releasedCompatibilityWindows: compatibilityWindows,
    compatibilityWindowReleases,
    artifactDigests: {
      rolloutReport: digestGraphReleaseArtifact(artifacts.rolloutReport),
      graphCoverage: digestGraphReleaseArtifact(artifacts.graphCoverage),
      cleanRollback: digestGraphReleaseArtifact(artifacts.cleanRollback),
      configMigration: digestGraphReleaseArtifact(artifacts.configMigration),
    },
  };
  writeFileSync(join(releaseRoot, "release-record.json"), encodeGraphReleaseArtifact(record));
  let previousReleaseVersion = releaseVersion;
  let previousConfigDigest = migration.afterConfigDigest;
  let previousSchemaVersion = migration.targetSchemaVersion;
  for (const compatibilityReleaseVersion of compatibilityWindowReleases) {
    const nextMigration = writeCompatibilityRelease(
      root,
      compatibilityReleaseVersion,
      previousReleaseVersion,
      previousConfigDigest,
      previousSchemaVersion,
      decision,
    );
    previousReleaseVersion = compatibilityReleaseVersion;
    previousConfigDigest = nextMigration.afterConfigDigest;
    previousSchemaVersion = nextMigration.targetSchemaVersion;
  }
  return { home, root, releaseRoot, releaseVersion, record };
}

function writeCompatibilityRelease(
  root: string,
  releaseVersion: string,
  sourceReleaseVersion: string,
  sourceConfigDigest: string,
  sourceSchemaVersion: number,
  decision: GraphRolloutDecision,
): Pick<GraphConfigMigrationArtifact, "afterConfigDigest" | "targetSchemaVersion"> {
  const releaseRoot = join(root, releaseVersion);
  mkdirSync(releaseRoot, { recursive: true });
  const manifest = experimentManifest(releaseVersion);
  const rollout: GraphRolloutDecisionArtifact = {
    schemaVersion: 1,
    kind: "graph-rollout-decision",
    releaseVersion,
    decision,
    experimentManifest: manifest,
    events: experimentEvents(manifest, decision !== "keep-graph-shadow"),
  };
  const coverage: GraphCoverageArtifact = {
    schemaVersion: 1,
    kind: "graph-coverage",
    releaseVersion,
    graphVersion: "1.0.0",
    suites: {
      fast: passingSuite(),
      lifecycleSequential: passingSuite(),
      lifecycleDag: passingSuite(),
      recovery: passingSuite(),
      parallelIsolation: passingSuite(),
    },
  };
  const rollback: GraphCleanRollbackArtifact = {
    schemaVersion: 1,
    kind: "graph-clean-rollback",
    releaseVersion,
    previousReleaseVersion: sourceReleaseVersion,
    packageRollbackExitCode: 0,
    restoredEngine: "graph-shadow",
    workingTreeCleanBefore: true,
    workingTreeCleanAfter: true,
  };
  const migration: GraphConfigMigrationArtifact = {
    schemaVersion: 1,
    kind: "graph-config-migration",
    releaseVersion,
    sourceReleaseVersion,
    sourceSchemaVersion,
    targetSchemaVersion: sourceSchemaVersion + 1,
    forwardExitCode: 0,
    backwardExitCode: 0,
    beforeConfigDigest: sourceConfigDigest,
    afterConfigDigest: opaqueId(`config-${releaseVersion}`),
    roundTripConfigDigest: sourceConfigDigest,
    rollbackEngine: "graph-shadow",
  };
  const artifacts = {
    rolloutReport: encodeGraphReleaseArtifact(rollout),
    graphCoverage: encodeGraphReleaseArtifact(coverage),
    cleanRollback: encodeGraphReleaseArtifact(rollback),
    configMigration: encodeGraphReleaseArtifact(migration),
  };
  writeFileSync(join(releaseRoot, "rollout-report.json"), artifacts.rolloutReport);
  writeFileSync(join(releaseRoot, "graph-coverage.json"), artifacts.graphCoverage);
  writeFileSync(join(releaseRoot, "clean-rollback.json"), artifacts.cleanRollback);
  writeFileSync(join(releaseRoot, "config-migration.json"), artifacts.configMigration);
  const record: GraphReleaseRecord = {
    schemaVersion: 1,
    releaseVersion,
    releasedCompatibilityWindows: 0,
    compatibilityWindowReleases: [],
    artifactDigests: {
      rolloutReport: digestGraphReleaseArtifact(artifacts.rolloutReport),
      graphCoverage: digestGraphReleaseArtifact(artifacts.graphCoverage),
      cleanRollback: digestGraphReleaseArtifact(artifacts.cleanRollback),
      configMigration: digestGraphReleaseArtifact(artifacts.configMigration),
    },
  };
  writeFileSync(join(releaseRoot, "release-record.json"), encodeGraphReleaseArtifact(record));
  return {
    afterConfigDigest: migration.afterConfigDigest,
    targetSchemaVersion: migration.targetSchemaVersion,
  };
}

function rewriteCompatibilityArtifact(
  fixture: ReturnType<typeof writeReleaseFixture>,
  filename: "rollout-report.json" | "graph-coverage.json" | "clean-rollback.json" | "config-migration.json",
  digestName: keyof GraphReleaseRecord["artifactDigests"],
  mutate: (artifact: Record<string, unknown>) => void,
  releaseVersion = "1.2.0",
): void {
  const releaseRoot = join(fixture.root, releaseVersion);
  const artifact = JSON.parse(readFileSync(join(releaseRoot, filename), "utf8")) as Record<string, unknown>;
  mutate(artifact);
  const bytes = encodeGraphReleaseArtifact(artifact);
  writeFileSync(join(releaseRoot, filename), bytes);
  const recordPath = join(releaseRoot, "release-record.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as GraphReleaseRecord;
  record.artifactDigests[digestName] = digestGraphReleaseArtifact(bytes);
  writeFileSync(recordPath, encodeGraphReleaseArtifact(record));
}

function rewriteCompatibilityDecision(
  fixture: ReturnType<typeof writeReleaseFixture>,
  decision: GraphRolloutDecision,
  releaseVersion = "1.2.0",
): void {
  const manifest = experimentManifest(releaseVersion);
  const artifact: GraphRolloutDecisionArtifact = {
    schemaVersion: 1,
    kind: "graph-rollout-decision",
    releaseVersion,
    decision,
    experimentManifest: manifest,
    events: experimentEvents(manifest, decision !== "keep-graph-shadow"),
  };
  const bytes = encodeGraphReleaseArtifact(artifact);
  const releaseRoot = join(fixture.root, releaseVersion);
  writeFileSync(join(releaseRoot, "rollout-report.json"), bytes);
  const recordPath = join(releaseRoot, "release-record.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as GraphReleaseRecord;
  record.artifactDigests.rolloutReport = digestGraphReleaseArtifact(bytes);
  writeFileSync(recordPath, encodeGraphReleaseArtifact(record));
}

function passingSuite(): { passed: number; failed: number; skipped: number } {
  return { passed: 1, failed: 0, skipped: 0 };
}

function experimentManifest(releaseVersion: string): GraphExperimentManifest {
  return createGraphExperimentManifest({
    schemaVersion: 1,
    releaseVersion,
    engines: engineGroups.map((engineGroup) => ({
      engineGroup,
      graphVersion: "1.0.0",
      configurationDigest: opaqueId(`${releaseVersion}-${engineGroup}-configuration`),
      features: GRAPH_ENGINE_FEATURES[engineGroup],
    })),
    cases: taskCategories.flatMap((taskCategory) => Array.from({ length: 10 }, (_, index) => ({
      corpusCaseId: opaqueId(`${releaseVersion}-${taskCategory}-case-${index}`),
      taskCategory,
      snapshotDigest: opaqueId(`${releaseVersion}-${taskCategory}-case-${index}-snapshot`),
    }))),
  });
}

function experimentEvents(
  manifest: GraphExperimentManifest,
  typedRecoveryObserved = true,
): GraphEvidenceEvent[] {
  const cases = new Map(manifest.cases.map((item) => [item.corpusCaseId, item]));
  const engines = new Map(manifest.engines.map((item) => [item.engineGroup, item]));
  const events: GraphEvidenceEvent[] = [];
  for (const engineGroup of engineGroups) {
    const engine = engines.get(engineGroup)!;
    for (const taskCategory of taskCategories) {
      for (let index = 0; index < 10; index += 1) {
        const corpusCaseId = opaqueId(`${manifest.releaseVersion}-${taskCategory}-case-${index}`);
        const corpusCase = cases.get(corpusCaseId)!;
        const label = `${engineGroup}-${taskCategory}-${index}`;
        const runId = opaqueId(`release-run-${label}`);
        const recoveryCase = typedRecoveryObserved
          && (engineGroup === "G0" || engineGroup === "G5")
          && taskCategory === "small-fix"
          && index === 0;
        const fast = engineGroup === "G0" || engineGroup === "G1";
        const stageKinds = fast
          ? (["plan", "build", "fast-judge"] as const)
          : (["define", "plan", "build", "verify", "review", "ship"] as const);
        let stages: GraphStageEvidenceEvent[] = stageKinds.map((stage, stageIndex) => ({
          schemaVersion: 1,
          type: "stage",
          eventId: opaqueId(`release-stage-${stage}-${label}`),
          runId,
          corpusCaseId,
          experimentId: manifest.experimentId,
          corpusSnapshotDigest: corpusCase.snapshotDigest,
          engineConfigurationDigest: engine.configurationDigest,
          sequence: stageIndex + 1,
          recordedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, 0, stageIndex)).toISOString(),
          engineGroup,
          taskCategory,
          graphVersion: engine.graphVersion,
          planVersion: 1,
          stage,
          nodeId: opaqueId(`release-node-${stage}-${label}`),
          attempt: 1,
          status: "succeeded",
          contractStatus: "passed",
          validatorTypes: validatorsForCategory(taskCategory),
          readySetWidth: 1,
          retryCount: 0,
          fallbackCount: 0,
          recoveryLevel: "none",
          durationMs: stage === "verify" || stage === "fast-judge" ? 1 : 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
          failureLocalizationMs: 0,
        }));
        if (recoveryCase && engineGroup === "G0") {
          const judge = stages.at(-1)!;
          const build = stages.find((stage) => stage.stage === "build")!;
          stages = [
            ...stages.slice(0, -1),
            { ...judge, status: "failed", contractStatus: "failed" },
            {
              ...build,
              eventId: opaqueId(`release-stage-retry-build-${label}`),
              nodeId: opaqueId(`release-node-retry-build-${label}`),
              attempt: 2,
              recoveryLevel: "retry",
              durationMs: 0,
            },
            {
              ...judge,
              eventId: opaqueId(`release-stage-retry-judge-${label}`),
              nodeId: opaqueId(`release-node-retry-judge-${label}`),
              attempt: 2,
              durationMs: 0,
            },
          ];
        } else if (recoveryCase && engineGroup === "G5") {
          const verifyIndex = stages.findIndex((stage) => stage.stage === "verify");
          const verify = stages[verifyIndex]!;
          const build = stages.find((stage) => stage.stage === "build")!;
          stages = [
            ...stages.slice(0, verifyIndex),
            { ...verify, status: "failed", contractStatus: "failed" },
            {
              ...verify,
              eventId: opaqueId(`release-stage-diagnose-${label}`),
              nodeId: opaqueId(`release-node-diagnose-${label}`),
              stage: "debug",
              validatorTypes: ["structured-tool", ...verify.validatorTypes],
              recoveryLevel: "diagnose",
              durationMs: 0,
            },
            {
              ...build,
              eventId: opaqueId(`release-stage-repair-build-${label}`),
              nodeId: opaqueId(`release-node-repair-build-${label}`),
              attempt: 2,
              recoveryLevel: "repair",
              durationMs: 0,
            },
            {
              ...verify,
              eventId: opaqueId(`release-stage-repair-verify-${label}`),
              nodeId: opaqueId(`release-node-repair-verify-${label}`),
              attempt: 2,
              durationMs: 0,
            },
            ...stages.slice(verifyIndex + 1),
          ];
        }
        stages = stages.map((stage, stageIndex) => ({
          ...stage,
          sequence: stageIndex + 1,
          recordedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, 0, stageIndex)).toISOString(),
        }));
        const runDurationMs = stages.reduce((total, stage) => total + (stage.durationMs as number), 0);
        const recoveryOrder = ["none", "retry", "diagnose", "repair", "replan", "pause", "fail"] as const;
        const recoveryLevel = stages.reduce<GraphRunEvidenceEvent["recoveryLevel"]>((highest, stage) => (
          recoveryOrder.indexOf(stage.recoveryLevel) > recoveryOrder.indexOf(highest)
            ? stage.recoveryLevel
            : highest
        ), "none");
        const recoveryStages = stages.filter((stage) => stage.recoveryLevel !== "none");
        const firstPassKind = fast ? "fast-judge" : "verify";
        const firstPass = stages.find((stage) => stage.stage === firstPassKind)!;
        let acceptedChecker = false;
        let laterRejection = false;
        for (const stage of stages) {
          if (stage.stage !== "fast-judge" && stage.stage !== "verify" && stage.stage !== "review") continue;
          const accepted = stage.status === "succeeded" && stage.contractStatus === "passed";
          if (acceptedChecker && !accepted) laterRejection = true;
          if (accepted) acceptedChecker = true;
        }
        const run: GraphRunEvidenceEvent = {
          schemaVersion: 1,
          type: "run",
          eventId: opaqueId(`release-summary-${label}`),
          runId,
          corpusCaseId,
          experimentId: manifest.experimentId,
          corpusSnapshotDigest: corpusCase.snapshotDigest,
          engineConfigurationDigest: engine.configurationDigest,
          sequence: stages.length + 1,
          recordedAt: "2026-07-22T00:00:01.000Z",
          engineGroup,
          taskCategory,
          graphVersion: engine.graphVersion,
          planVersion: 1,
          finalStatus: "done",
          traceCompleteness: "complete",
          nodeCount: new Set(stages.map((stage) => stage.nodeId)).size,
          nodeExecutions: stages.length,
          redundantNodeExecutions: 0,
          maxReadySetWidth: 1,
          validatorTypes: [
            "structured-tool",
            "schema",
            "tests",
            "typecheck",
            "lint",
            "build",
            "security",
            "human-gate",
          ].filter((validator): validator is GraphRunEvidenceEvent["validatorTypes"][number] => stages.some((stage) => (
            stage.status === "succeeded"
              && stage.contractStatus === "passed"
              && stage.validatorTypes.includes(validator as GraphRunEvidenceEvent["validatorTypes"][number])
          ))),
          contractChecks: {
            passed: stages.filter((stage) => stage.contractStatus === "passed").length,
            failed: stages.filter((stage) => stage.contractStatus === "failed").length,
            skipped: stages.filter((stage) => stage.contractStatus === "skipped").length,
          },
          retryCount: stages.reduce((total, stage) => total + stage.retryCount, 0),
          fallbackCount: 0,
          recoveryLevel,
          recoveryAttempts: recoveryStages.length,
          recoverySuccesses: recoveryStages.filter((stage) => (
            stage.status === "succeeded" && stage.contractStatus === "passed"
          )).length,
          buildPasses: Math.max(...stages.filter((stage) => stage.stage === "build").map((stage) => stage.attempt)),
          firstPassVerification: firstPass.attempt === 1
            && firstPass.status === "succeeded"
            && firstPass.contractStatus === "passed",
          laterRejection,
          humanOverride: false,
          durationMs: runDurationMs,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
          failureLocalizationMs: 0,
          parallelism: {
            mode: "none",
            executedConcurrently: false,
            summedNodeDurationMs: runDurationMs,
            criticalPathDurationMs: runDurationMs,
            failedNodeCount: stages.filter((stage) => stage.status === "failed").length,
            skippedNodeCount: stages.filter((stage) => stage.status === "skipped").length,
            conflictingNodeCount: 0,
          },
        };
        events.push(...stages, run);
      }
    }
  }
  return events;
}
