import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  assessLegacyRetirement,
  buildGraphEvidenceReport,
  validateGraphExperimentManifest,
  type GraphEvidenceEvent,
  type GraphEvidenceReport,
  type GraphExperimentManifest,
  type GraphRolloutDecision,
  type LegacyRetirementAssessment,
} from "../core/graphEvidence.js";

export type { GraphRolloutDecision } from "../core/graphEvidence.js";

export interface GraphReleaseArtifactDigests {
  rolloutReport: string;
  graphCoverage: string;
  cleanRollback: string;
  configMigration: string;
}

export interface GraphReleaseRecord {
  schemaVersion: 1;
  releaseVersion: string;
  releasedCompatibilityWindows: number;
  compatibilityWindowReleases: string[];
  artifactDigests: GraphReleaseArtifactDigests;
}

export interface GraphRolloutDecisionArtifact {
  schemaVersion: 1;
  kind: "graph-rollout-decision";
  releaseVersion: string;
  decision: GraphRolloutDecision;
  experimentManifest: GraphExperimentManifest;
  events: GraphEvidenceEvent[];
}

export interface GraphCoverageSuiteResult {
  passed: number;
  failed: number;
  skipped: number;
}

export interface GraphCoverageArtifact {
  schemaVersion: 1;
  kind: "graph-coverage";
  releaseVersion: string;
  graphVersion: string;
  suites: {
    fast: GraphCoverageSuiteResult;
    lifecycleSequential: GraphCoverageSuiteResult;
    lifecycleDag: GraphCoverageSuiteResult;
    recovery: GraphCoverageSuiteResult;
    parallelIsolation: GraphCoverageSuiteResult;
  };
}

export interface GraphCleanRollbackArtifact {
  schemaVersion: 1;
  kind: "graph-clean-rollback";
  releaseVersion: string;
  previousReleaseVersion: string;
  packageRollbackExitCode: 0;
  restoredEngine: "graph-shadow";
  workingTreeCleanBefore: true;
  workingTreeCleanAfter: true;
}

export interface GraphConfigMigrationArtifact {
  schemaVersion: 1;
  kind: "graph-config-migration";
  releaseVersion: string;
  sourceReleaseVersion: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  forwardExitCode: 0;
  backwardExitCode: 0;
  beforeConfigDigest: string;
  afterConfigDigest: string;
  roundTripConfigDigest: string;
  rollbackEngine: "graph-shadow";
}

export interface VerifyGraphReleaseRecordInput {
  releaseVersion: string;
}

export interface VerifiedGraphReleaseAssessment extends LegacyRetirementAssessment {
  releaseVersion: string;
  decision: GraphRolloutDecision;
  releasedCompatibilityWindows: number;
  /** Recomputed from the canonical manifest and event ledger; raw events are never returned. */
  report: Readonly<GraphEvidenceReport>;
  artifactDigests: Readonly<GraphReleaseArtifactDigests>;
}

export type GraphReleaseEvidenceErrorCode =
  | "invalid-user-store"
  | "invalid-release-record"
  | "invalid-release-artifact"
  | "artifact-digest-mismatch"
  | "rollout-report-ineligible"
  | "release-read-budget-exceeded";

export class GraphReleaseEvidenceError extends Error {
  readonly code: GraphReleaseEvidenceErrorCode;

  constructor(code: GraphReleaseEvidenceErrorCode) {
    super(`Graph release evidence failed: ${code}`);
    this.name = "GraphReleaseEvidenceError";
    this.code = code;
  }
}

const RELEASE_FILE = "release-record.json";
const ARTIFACT_FILES = {
  rolloutReport: "rollout-report.json",
  graphCoverage: "graph-coverage.json",
  cleanRollback: "clean-rollback.json",
  configMigration: "config-migration.json",
} as const;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SUPPORTING_ARTIFACT_BYTES = 256 * 1024;
const MAX_ROLLOUT_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_RELEASE_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_COMPATIBILITY_WINDOWS = 32;
const MAX_SUITE_ASSERTIONS = 1_000_000;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TRUSTED_POSIX_METADATA_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
]);

export function resolveUserGraphReleaseRoot(): string {
  try {
    const realHome = trustedExistingDirectoryPath(homedir());
    const base = join(realHome, ".ai-orchestrator");
    validateOptionalDirectory(realHome, base);
    const root = join(base, "graph-releases");
    validateOptionalDirectory(base, root);
    return root;
  } catch {
    throw new GraphReleaseEvidenceError("invalid-user-store");
  }
}

export function verifyGraphReleaseRecord(
  input: VerifyGraphReleaseRecordInput,
): VerifiedGraphReleaseAssessment {
  const openDirectories: TrustedDirectory[] = [];
  const readBudget: ReadBudget = { remainingBytes: MAX_TOTAL_RELEASE_EVIDENCE_BYTES };
  try {
    const verifiedInput = validateVerifyInput(input);
    stableReleaseVersion(verifiedInput.releaseVersion);
    const homePath = trustedExistingDirectoryPath(homedir());
    const home = openTrustedDirectory(homePath, "invalid-user-store");
    openDirectories.push(home);
    const base = openTrustedChildDirectory(home, ".ai-orchestrator", "invalid-user-store");
    openDirectories.push(base);
    const root = openTrustedChildDirectory(base, "graph-releases", "invalid-user-store");
    openDirectories.push(root);
    const releaseRoot = openTrustedChildDirectory(root, verifiedInput.releaseVersion, "invalid-release-record");
    openDirectories.push(releaseRoot);

    const release = readCanonicalJson(releaseRoot, RELEASE_FILE, MAX_RECORD_BYTES, readBudget);
    const record = validateReleaseRecord(release.value, verifiedInput.releaseVersion);

    const rollout = readAndVerifyArtifact(
      releaseRoot,
      ARTIFACT_FILES.rolloutReport,
      record.artifactDigests.rolloutReport,
      MAX_ROLLOUT_ARTIFACT_BYTES,
      readBudget,
    );
    const coverage = readAndVerifyArtifact(
      releaseRoot,
      ARTIFACT_FILES.graphCoverage,
      record.artifactDigests.graphCoverage,
      MAX_SUPPORTING_ARTIFACT_BYTES,
      readBudget,
    );
    const rollback = readAndVerifyArtifact(
      releaseRoot,
      ARTIFACT_FILES.cleanRollback,
      record.artifactDigests.cleanRollback,
      MAX_SUPPORTING_ARTIFACT_BYTES,
      readBudget,
    );
    const migration = readAndVerifyArtifact(
      releaseRoot,
      ARTIFACT_FILES.configMigration,
      record.artifactDigests.configMigration,
      MAX_SUPPORTING_ARTIFACT_BYTES,
      readBudget,
    );

    const rolloutDecision = validateRolloutArtifact(rollout.value, record.releaseVersion);
    validateCoverageArtifact(coverage.value, record.releaseVersion, rolloutDecision.graphVersion);
    const previousReleaseVersion = validateRollbackArtifact(rollback.value, record.releaseVersion);
    const migrationLink = validateMigrationArtifact(
      migration.value,
      record.releaseVersion,
      previousReleaseVersion,
    );
    verifyCompatibilityWindows(root, record, rolloutDecision.decision, migrationLink, readBudget);
    assertDirectoryUnchanged(releaseRoot);
    assertDirectoryUnchanged(root);
    assertDirectoryUnchanged(base);
    assertDirectoryUnchanged(home);

    const structural = assessLegacyRetirement({
      releasedCompatibilityWindows: record.releasedCompatibilityWindows,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: record.releaseVersion,
        artifactDigest: rollout.digest,
        decision: rolloutDecision.decision,
      },
      graphCoverage: { releaseVersion: record.releaseVersion, artifactDigest: coverage.digest },
      cleanRollback: { releaseVersion: record.releaseVersion, artifactDigest: rollback.digest },
      configMigration: { releaseVersion: record.releaseVersion, artifactDigest: migration.digest },
    });
    const missing = structural.missing.filter((requirement) => requirement !== "verified-release-artifacts");
    return Object.freeze({
      eligible: missing.length === 0,
      missing,
      releaseVersion: record.releaseVersion,
      decision: rolloutDecision.decision,
      releasedCompatibilityWindows: record.releasedCompatibilityWindows,
      report: rolloutDecision.report,
      artifactDigests: Object.freeze({ ...record.artifactDigests }),
    });
  } catch (error) {
    if (error instanceof GraphReleaseEvidenceError) throw error;
    throw new GraphReleaseEvidenceError("invalid-release-record");
  } finally {
    for (const directory of openDirectories.reverse()) closeSync(directory.descriptor);
  }
}

/** Canonical bytes used by the trusted release tooling and verified on read. */
export function encodeGraphReleaseArtifact(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

export function digestGraphReleaseArtifact(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function readAndVerifyArtifact(
  releaseRoot: TrustedDirectory,
  filename: string,
  expectedDigest: string,
  maximumBytes: number,
  readBudget: ReadBudget,
): { value: unknown; digest: string } {
  const artifact = readCanonicalJson(releaseRoot, filename, maximumBytes, readBudget);
  if (artifact.digest !== expectedDigest) {
    throw new GraphReleaseEvidenceError("artifact-digest-mismatch");
  }
  return artifact;
}

function readCanonicalJson(
  directory: TrustedDirectory,
  filename: string,
  maximumBytes: number,
  readBudget: ReadBudget,
): { value: unknown; digest: string } {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    assertDirectoryUnchanged(directory);
    const path = join(directory.path, filename);
    assertDirectChild(directory.path, path);
    const pathBefore = lstatSync(path, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) invalidArtifact();
    assertTrustedFilesystemMetadata(pathBefore, invalidArtifact);
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFilesystemObject(pathBefore, before)) invalidArtifact();
    assertTrustedFilesystemMetadata(before, invalidArtifact);
    if (before.size > BigInt(maximumBytes)) invalidArtifact();
    if (before.size > BigInt(readBudget.remainingBytes)) {
      throw new GraphReleaseEvidenceError("release-read-budget-exceeded");
    }
    const bytes = readBoundedFile(descriptor, maximumBytes);
    readBudget.remainingBytes -= bytes.byteLength;
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameStableFile(before, after)
      || !sameStableFile(after, pathAfter)
      || BigInt(bytes.byteLength) !== before.size) invalidArtifact();
    const text = bytes.toString("utf8");
    const value = JSON.parse(text) as unknown;
    if (text !== encodeGraphReleaseArtifact(value)) {
      throw new GraphReleaseEvidenceError("invalid-release-artifact");
    }
    const digest = digestGraphReleaseArtifact(bytes);
    const finalDescriptorIdentity = fstatSync(descriptor, { bigint: true });
    const finalPathIdentity = lstatSync(path, { bigint: true });
    if (!sameStableFile(before, finalDescriptorIdentity)
      || !sameStableFile(finalDescriptorIdentity, finalPathIdentity)) invalidArtifact();
    assertDirectoryUnchanged(directory);
    return { value, digest };
  } catch (error) {
    if (error instanceof GraphReleaseEvidenceError) throw error;
    throw new GraphReleaseEvidenceError("invalid-release-artifact");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface MigrationLink {
  targetConfigDigest: string;
  targetSchemaVersion: number;
}

interface ReadBudget {
  remainingBytes: number;
}

function verifyCompatibilityWindows(
  root: TrustedDirectory,
  record: GraphReleaseRecord,
  expectedDecision: GraphRolloutDecision,
  initialMigration: MigrationLink,
  readBudget: ReadBudget,
): void {
  let expectedPreviousRelease = record.releaseVersion;
  let expectedSourceConfigDigest = initialMigration.targetConfigDigest;
  let expectedSourceSchemaVersion = initialMigration.targetSchemaVersion;
  for (const releaseVersion of record.compatibilityWindowReleases) {
    const releaseRoot = openTrustedChildDirectory(root, releaseVersion, "invalid-release-record");
    try {
      const recordArtifact = readCanonicalJson(releaseRoot, RELEASE_FILE, MAX_RECORD_BYTES, readBudget);
      const compatibilityRecord = validateReleaseRecord(recordArtifact.value, releaseVersion);
      const rollout = readAndVerifyArtifact(
        releaseRoot,
        ARTIFACT_FILES.rolloutReport,
        compatibilityRecord.artifactDigests.rolloutReport,
        MAX_ROLLOUT_ARTIFACT_BYTES,
        readBudget,
      );
      const coverage = readAndVerifyArtifact(
        releaseRoot,
        ARTIFACT_FILES.graphCoverage,
        compatibilityRecord.artifactDigests.graphCoverage,
        MAX_SUPPORTING_ARTIFACT_BYTES,
        readBudget,
      );
      const rollback = readAndVerifyArtifact(
        releaseRoot,
        ARTIFACT_FILES.cleanRollback,
        compatibilityRecord.artifactDigests.cleanRollback,
        MAX_SUPPORTING_ARTIFACT_BYTES,
        readBudget,
      );
      const migration = readAndVerifyArtifact(
        releaseRoot,
        ARTIFACT_FILES.configMigration,
        compatibilityRecord.artifactDigests.configMigration,
        MAX_SUPPORTING_ARTIFACT_BYTES,
        readBudget,
      );
      const compatibilityDecision = validateRolloutArtifact(rollout.value, releaseVersion);
      if (compatibilityDecision.decision !== expectedDecision) invalidArtifact();
      validateCoverageArtifact(coverage.value, releaseVersion, compatibilityDecision.graphVersion);
      const previousRelease = validateRollbackArtifact(rollback.value, releaseVersion);
      if (previousRelease !== expectedPreviousRelease) invalidArtifact();
      const migrationLink = validateMigrationArtifact(
        migration.value,
        releaseVersion,
        expectedPreviousRelease,
        expectedSourceConfigDigest,
        expectedSourceSchemaVersion,
      );
      assertDirectoryUnchanged(releaseRoot);
      assertDirectoryUnchanged(root);
      expectedPreviousRelease = releaseVersion;
      expectedSourceConfigDigest = migrationLink.targetConfigDigest;
      expectedSourceSchemaVersion = migrationLink.targetSchemaVersion;
    } finally {
      closeSync(releaseRoot.descriptor);
    }
  }
}

function validateReleaseRecord(value: unknown, expectedRelease: string): GraphReleaseRecord {
  const record = exactRecord(value, [
    "schemaVersion",
    "releaseVersion",
    "releasedCompatibilityWindows",
    "compatibilityWindowReleases",
    "artifactDigests",
  ], invalidRecord);
  if (record.schemaVersion !== 1 || record.releaseVersion !== expectedRelease) invalidRecord();
  stableReleaseVersion(record.releaseVersion);
  boundedInteger(record.releasedCompatibilityWindows, 0, MAX_COMPATIBILITY_WINDOWS, invalidRecord);
  const windows = exactStringArray(record.compatibilityWindowReleases, MAX_COMPATIBILITY_WINDOWS);
  if (windows.length !== record.releasedCompatibilityWindows) invalidRecord();
  const uniqueWindows = new Set<string>();
  let previousWindow = expectedRelease;
  for (const version of windows) {
    stableReleaseVersion(version);
    if (uniqueWindows.has(version) || compareSemanticVersions(previousWindow, version) >= 0) invalidRecord();
    uniqueWindows.add(version);
    previousWindow = version;
  }
  const digests = exactRecord(record.artifactDigests, [
    "rolloutReport", "graphCoverage", "cleanRollback", "configMigration",
  ], invalidRecord);
  for (const digest of Object.values(digests)) sha256Digest(digest);
  return {
    schemaVersion: 1,
    releaseVersion: record.releaseVersion,
    releasedCompatibilityWindows: record.releasedCompatibilityWindows,
    compatibilityWindowReleases: windows,
    artifactDigests: {
      rolloutReport: digests.rolloutReport as string,
      graphCoverage: digests.graphCoverage as string,
      cleanRollback: digests.cleanRollback as string,
      configMigration: digests.configMigration as string,
    },
  };
}

function validateRolloutArtifact(
  value: unknown,
  releaseVersion: string,
): { decision: GraphRolloutDecision; graphVersion: string; report: Readonly<GraphEvidenceReport> } {
  const record = exactRecord(value, [
    "schemaVersion", "kind", "releaseVersion", "decision", "experimentManifest", "events",
  ]);
  if (record.schemaVersion !== 1
    || record.kind !== "graph-rollout-decision"
    || record.releaseVersion !== releaseVersion
    || (record.decision !== "keep-graph-shadow"
      && record.decision !== "enable-sequential-graph"
      && record.decision !== "enable-graph-dag")) {
    invalidArtifact();
  }
  let report: ReturnType<typeof buildGraphEvidenceReport>;
  try {
    const manifest = validateGraphExperimentManifest(record.experimentManifest);
    if (manifest.releaseVersion !== releaseVersion) invalidArtifact();
    report = buildGraphEvidenceReport(record.events as readonly unknown[], { experimentManifest: manifest });
  } catch (error) {
    if (error instanceof GraphReleaseEvidenceError) throw error;
    invalidArtifact();
  }
  if (record.decision !== report.recommendedDecision) invalidArtifact();
  if (record.decision !== "keep-graph-shadow" && !report.rolloutDecisionEligible) {
    throw new GraphReleaseEvidenceError("rollout-report-ineligible");
  }
  const graphVersions = Object.keys(report.totals.graphVersions);
  if (graphVersions.length !== 1) invalidArtifact();
  return {
    decision: record.decision as GraphRolloutDecision,
    graphVersion: graphVersions[0]!,
    report: Object.freeze(report),
  };
}

function validateCoverageArtifact(value: unknown, releaseVersion: string, graphVersion: string): void {
  const record = exactRecord(value, ["schemaVersion", "kind", "releaseVersion", "graphVersion", "suites"]);
  if (record.schemaVersion !== 1
    || record.kind !== "graph-coverage"
    || record.releaseVersion !== releaseVersion
    || record.graphVersion !== graphVersion) {
    invalidArtifact();
  }
  semanticVersion(record.graphVersion);
  const suites = exactRecord(record.suites, [
    "fast", "lifecycleSequential", "lifecycleDag", "recovery", "parallelIsolation",
  ]);
  for (const suite of Object.values(suites)) validatePassingSuite(suite);
}

function validatePassingSuite(value: unknown): void {
  const result = exactRecord(value, ["passed", "failed", "skipped"]);
  boundedInteger(result.passed, 1, MAX_SUITE_ASSERTIONS, invalidArtifact);
  boundedInteger(result.failed, 0, MAX_SUITE_ASSERTIONS, invalidArtifact);
  boundedInteger(result.skipped, 0, MAX_SUITE_ASSERTIONS, invalidArtifact);
  if (result.failed !== 0 || result.skipped !== 0) invalidArtifact();
}

function validateRollbackArtifact(value: unknown, releaseVersion: string): string {
  const record = exactRecord(value, [
    "schemaVersion",
    "kind",
    "releaseVersion",
    "previousReleaseVersion",
    "packageRollbackExitCode",
    "restoredEngine",
    "workingTreeCleanBefore",
    "workingTreeCleanAfter",
  ]);
  if (record.schemaVersion !== 1
    || record.kind !== "graph-clean-rollback"
    || record.releaseVersion !== releaseVersion
    || record.previousReleaseVersion === releaseVersion
    || record.packageRollbackExitCode !== 0
    || record.restoredEngine !== "graph-shadow"
    || record.workingTreeCleanBefore !== true
    || record.workingTreeCleanAfter !== true) {
    invalidArtifact();
  }
  stableReleaseVersion(record.previousReleaseVersion);
  if (compareSemanticVersions(record.previousReleaseVersion, releaseVersion) >= 0) invalidArtifact();
  return record.previousReleaseVersion;
}

function validateMigrationArtifact(
  value: unknown,
  releaseVersion: string,
  expectedSourceReleaseVersion: string,
  expectedSourceConfigDigest?: string,
  expectedSourceSchemaVersion?: number,
): MigrationLink {
  const record = exactRecord(value, [
    "schemaVersion",
    "kind",
    "releaseVersion",
    "sourceReleaseVersion",
    "sourceSchemaVersion",
    "targetSchemaVersion",
    "forwardExitCode",
    "backwardExitCode",
    "beforeConfigDigest",
    "afterConfigDigest",
    "roundTripConfigDigest",
    "rollbackEngine",
  ]);
  if (record.schemaVersion !== 1
    || record.kind !== "graph-config-migration"
    || record.releaseVersion !== releaseVersion
    || record.sourceReleaseVersion !== expectedSourceReleaseVersion
    || record.forwardExitCode !== 0
    || record.backwardExitCode !== 0
    || record.rollbackEngine !== "graph-shadow") {
    invalidArtifact();
  }
  boundedInteger(record.sourceSchemaVersion, 1, MAX_SUITE_ASSERTIONS, invalidArtifact);
  boundedInteger(record.targetSchemaVersion, 1, MAX_SUITE_ASSERTIONS, invalidArtifact);
  stableReleaseVersion(record.sourceReleaseVersion);
  if (compareSemanticVersions(record.sourceReleaseVersion, releaseVersion) >= 0) invalidArtifact();
  sha256Digest(record.beforeConfigDigest);
  sha256Digest(record.afterConfigDigest);
  sha256Digest(record.roundTripConfigDigest);
  if (record.targetSchemaVersion < record.sourceSchemaVersion
    || record.beforeConfigDigest !== record.roundTripConfigDigest
    || (expectedSourceConfigDigest !== undefined
      && record.beforeConfigDigest !== expectedSourceConfigDigest)
    || (expectedSourceSchemaVersion !== undefined
      && record.sourceSchemaVersion !== expectedSourceSchemaVersion)) {
    invalidArtifact();
  }
  return {
    targetConfigDigest: record.afterConfigDigest,
    targetSchemaVersion: record.targetSchemaVersion,
  };
}

interface TrustedDirectory {
  path: string;
  descriptor: number;
  initial: BigIntStats;
}

function validateVerifyInput(value: unknown): VerifyGraphReleaseRecordInput {
  if (!isPlainRecord(value)) throw new GraphReleaseEvidenceError("invalid-user-store");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string"
    || key !== "releaseVersion")
    || keys.length !== 1
    || !Object.hasOwn(value, "releaseVersion")
    || typeof value.releaseVersion !== "string") {
    throw new GraphReleaseEvidenceError("invalid-user-store");
  }
  return value as unknown as VerifyGraphReleaseRecordInput;
}

function trustedExistingDirectoryPath(value: string): string {
  try {
    if (!isAbsolute(value)) throw new Error("not-absolute");
    const real = realpathSync(resolve(value));
    assertNoSymlinkComponents(real);
    const identity = lstatSync(real, { bigint: true });
    if (!identity.isDirectory()) throw new Error("not-directory");
    assertTrustedFilesystemMetadata(identity, () => { throw new Error("unsafe-directory"); });
    return real;
  } catch {
    throw new GraphReleaseEvidenceError("invalid-user-store");
  }
}

function validateOptionalDirectory(parent: string, target: string): void {
  assertDirectChild(parent, target);
  if (!existsSync(target)) return;
  assertNoSymlinkComponents(target);
  const identity = lstatSync(target, { bigint: true });
  if (!identity.isDirectory() || realpathSync(target) !== resolve(target)) {
    throw new Error("not-canonical-directory");
  }
  assertTrustedFilesystemMetadata(identity, () => { throw new Error("unsafe-directory"); });
}

function openTrustedChildDirectory(
  parent: TrustedDirectory,
  childName: string,
  code: GraphReleaseEvidenceErrorCode,
): TrustedDirectory {
  if (childName.length === 0 || childName === "." || childName === ".." || /[\\/\u0000]/.test(childName)) {
    throw new GraphReleaseEvidenceError(code);
  }
  const path = join(parent.path, childName);
  try {
    assertDirectChild(parent.path, path);
    assertDirectoryUnchanged(parent);
    const child = openTrustedDirectory(path, code);
    assertDirectoryUnchanged(parent);
    return child;
  } catch (error) {
    if (error instanceof GraphReleaseEvidenceError) throw error;
    throw new GraphReleaseEvidenceError(code);
  }
}

function openTrustedDirectory(path: string, code: GraphReleaseEvidenceErrorCode): TrustedDirectory {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  let descriptor: number | undefined;
  try {
    const canonicalPath = resolve(path);
    assertNoSymlinkComponents(canonicalPath);
    const pathIdentity = lstatSync(canonicalPath, { bigint: true });
    if (pathIdentity.isSymbolicLink() || !pathIdentity.isDirectory()) throw new Error("not-directory");
    descriptor = openSync(canonicalPath, constants.O_RDONLY | noFollow | directoryOnly);
    const descriptorIdentity = fstatSync(descriptor, { bigint: true });
    if (!descriptorIdentity.isDirectory() || !sameFilesystemObject(pathIdentity, descriptorIdentity)) {
      throw new Error("directory-changed");
    }
    assertTrustedFilesystemMetadata(descriptorIdentity, () => { throw new Error("unsafe-directory"); });
    if (realpathSync(canonicalPath) !== canonicalPath) throw new Error("not-canonical");
    return { path: canonicalPath, descriptor, initial: descriptorIdentity };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof GraphReleaseEvidenceError) throw error;
    throw new GraphReleaseEvidenceError(code);
  }
}

function assertDirectoryUnchanged(directory: TrustedDirectory): void {
  try {
    const descriptorIdentity = fstatSync(directory.descriptor, { bigint: true });
    const pathIdentity = lstatSync(directory.path, { bigint: true });
    if (!descriptorIdentity.isDirectory()
      || pathIdentity.isSymbolicLink()
      || !pathIdentity.isDirectory()
      || !sameStableDirectory(directory.initial, descriptorIdentity)
      || !sameStableDirectory(descriptorIdentity, pathIdentity)
      || realpathSync(directory.path) !== directory.path) {
      invalidArtifact();
    }
  } catch (error) {
    if (error instanceof GraphReleaseEvidenceError) throw error;
    invalidArtifact();
  }
}

function readBoundedFile(descriptor: number, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const remainingThroughOverflowByte = (maximumBytes + 1) - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingThroughOverflowByte));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total === 0 || total > maximumBytes) invalidArtifact();
  return Buffer.concat(chunks, total);
}

function sameFilesystemObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFilesystemObject(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return sameFilesystemObject(left, right)
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertTrustedFilesystemMetadata(identity: BigIntStats, fail: () => never): void {
  if (!TRUSTED_POSIX_METADATA_PLATFORMS.has(process.platform)
    || typeof process.getuid !== "function"
    || (identity.mode & 0o022n) !== 0n
    || identity.uid !== BigInt(process.getuid())) {
    fail();
  }
}

function assertContained(root: string, target: string): void {
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("outside-root");
}

function assertDirectChild(root: string, target: string): void {
  assertContained(root, target);
  const relation = relative(root, target);
  if (relation.length === 0 || relation.includes("/") || relation.includes("\\")) {
    throw new Error("not-direct-child");
  }
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  for (const part of absolute.slice(filesystemRoot.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("symlink");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  fail: () => never = invalidArtifact,
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    fail();
  }
  return value;
}

function exactStringArray(value: unknown, maximum: number): string[] {
  const entries = exactArray(value, maximum, invalidRecord);
  if (entries.some((entry) => typeof entry !== "string")) invalidRecord();
  return entries as string[];
}

function exactArray(value: unknown, maximum: number, fail: () => never = invalidArtifact): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length))) fail();
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail();
    entries.push(descriptor.value);
  }
  return entries;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidArtifact();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${exactArray(value, 100_000).map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) invalidArtifact();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) invalidArtifact();
  const sorted = (keys as string[]).sort(compareCodeUnits);
  return `{${sorted.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fail: () => never,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) fail();
}

function semanticVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 128 || !SEMVER.test(value)) invalidRecord();
}

function stableReleaseVersion(value: unknown): asserts value is string {
  semanticVersion(value);
  const match = SEMVER.exec(value);
  if (!match || match[4] !== undefined || match[5] !== undefined) invalidRecord();
}

function compareSemanticVersions(left: string, right: string): number {
  const leftMatch = SEMVER.exec(left);
  const rightMatch = SEMVER.exec(right);
  if (!leftMatch || !rightMatch) invalidRecord();
  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareBigInt(leftMatch[index]!, rightMatch[index]!);
    if (comparison !== 0) return comparison;
  }
  const leftPre = leftMatch[4]?.split(".");
  const rightPre = rightMatch[4]?.split(".");
  if (leftPre === undefined || rightPre === undefined) {
    return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  }
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const comparison = compareBigInt(leftPart, rightPart);
      if (comparison !== 0) return comparison;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const comparison = compareCodeUnits(leftPart, rightPart);
      if (comparison !== 0) return comparison;
    }
  }
  return 0;
}

function compareBigInt(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function sha256Digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalidRecord();
}

function isArrayIndex(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function invalidRecord(): never {
  throw new GraphReleaseEvidenceError("invalid-release-record");
}

function invalidArtifact(): never {
  throw new GraphReleaseEvidenceError("invalid-release-artifact");
}
