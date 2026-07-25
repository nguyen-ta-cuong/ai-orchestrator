import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyRecoveryDecisionToLedger,
  applyRecoveryReleaseToLedger,
  applyRecoverySuccessorEventToLedger,
  createRecoveryLedger,
  fingerprintFailure,
  registerRecovery,
  type FailureEvidence,
  type RecoveryAuthority,
  type RecoveryDirective,
} from "../src/core/recovery.js";
import {
  authenticateRecoveryArtifacts,
  recoveryArtifactBinding,
  type RecoveryArtifactBinding,
} from "../src/runtime/recoveryArtifacts.js";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const graphBytes = Buffer.from('{"graph":"v1"}');
const planBytes = Buffer.from("approved plan");
const authority: RecoveryAuthority = {
  version: 1,
  runId: "run-artifacts",
  graphDigest: digest(graphBytes),
  activePlanVersion: 1,
  activePlanHash: digest(planBytes),
  limits: { maxEntries: 8, maxPlanVersions: 3, budgets: { retry: 1, repair: 1, replan: 1 } },
};

function failure(category: FailureEvidence["category"], attempt = 1): FailureEvidence {
  return {
    version: 1,
    runId: authority.runId,
    nodeId: "build",
    category,
    nodeKind: "build",
    graphVersion: "1",
    graphDigest: authority.graphDigest,
    planVersion: 1,
    planHash: authority.activePlanHash,
    attempt,
    failureLineageId: "lineage-artifacts",
    artifactHashes: [authority.activePlanHash],
  };
}

function binding(reference: string, bytes: Uint8Array): RecoveryArtifactBinding {
  const hash = digest(bytes);
  return recoveryArtifactBinding(reference, {
    path: `mutations/${hash}.json`, sha256: hash, sizeBytes: bytes.byteLength,
  });
}

function reader(entries: Array<[RecoveryArtifactBinding, Uint8Array]>) {
  const bytesByPath = new Map(entries.map(([entry, bytes]) => [entry.storageRef.path, bytes]));
  return (reference: RecoveryArtifactBinding["storageRef"]) => {
    const bytes = bytesByPath.get(reference.path);
    if (!bytes) throw new Error("missing test artifact");
    return bytes;
  };
}

function baseBindings(): Array<[RecoveryArtifactBinding, Uint8Array]> {
  return [
    [binding("plan-versions/1/graph.json", graphBytes), graphBytes],
    [binding("plan-versions/1/plan.md", planBytes), planBytes],
  ];
}

describe("trusted recovery artifact authentication", () => {
  it("authenticates diagnosis, evidence, release, successor graph/plan, and approval bytes", () => {
    const localFailure = failure("implementation-defect");
    const diagnosisBytes = Buffer.from("typed diagnosis");
    const evidenceBytes = Buffer.from("validator evidence");
    const directive: RecoveryDirective = {
      version: 1,
      failureFingerprint: fingerprintFailure(localFailure),
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      diagnosisRef: "plan-versions/1/diagnosis.md",
      diagnosisHash: digest(diagnosisBytes),
      evidenceRefs: ["plan-versions/1/evidence.json", "plan-versions/1/plan.md"],
      repairScope: ["src/feature.ts"],
      validationRequirements: ["focused-tests"],
      topologyAssessment: "preserve",
    };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, localFailure);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(localFailure), directive);

    const configurationFailure = failure("configuration", 2);
    ledger = registerRecovery(ledger, authority, configurationFailure);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(configurationFailure));
    const releaseBytes = Buffer.from("configuration changed");
    ledger = applyRecoveryReleaseToLedger(ledger, authority, {
      version: 1,
      failureFingerprint: fingerprintFailure(configurationFailure),
      reason: "configuration-changed",
      evidenceRef: "plan-versions/1/releases/config.json",
      evidenceHash: digest(releaseBytes),
    });

    const structuralFailure = failure("invalid-topology", 3);
    const structuralDiagnosis = Buffer.from("topology is invalid");
    ledger = registerRecovery(ledger, authority, structuralFailure);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(structuralFailure), {
      version: 1,
      failureFingerprint: fingerprintFailure(structuralFailure),
      rootCauseCategory: "invalid-topology",
      confidence: "high",
      diagnosisRef: "plan-versions/1/topology-diagnosis.md",
      diagnosisHash: digest(structuralDiagnosis),
      evidenceRefs: [],
      repairScope: [],
      validationRequirements: ["graph-contract"],
      topologyAssessment: "structural",
    });
    const graph2 = Buffer.from('{"graph":"v2"}');
    const plan2 = Buffer.from("successor plan");
    const approval2 = Buffer.from('{"approved":true}');
    const successorBase = {
      version: 1 as const,
      failureFingerprint: fingerprintFailure(structuralFailure),
      sourcePlanVersion: 1,
      targetPlanVersion: 2,
      graphHash: digest(graph2),
      planHash: digest(plan2),
      graphRef: "plan-versions/2/graph.json",
      planRef: "plan-versions/2/plan.md",
    };
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, { ...successorBase, phase: "artifact-durable" });
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, {
      ...successorBase,
      phase: "approved",
      approvalHash: digest(approval2),
      approvalRef: "plan-versions/2/approval.json",
    });

    const entries = [
      ...baseBindings(),
      [binding(directive.diagnosisRef, diagnosisBytes), diagnosisBytes],
      [binding(directive.evidenceRefs[0]!, evidenceBytes), evidenceBytes],
      [binding("plan-versions/1/releases/config.json", releaseBytes), releaseBytes],
      [binding("plan-versions/1/topology-diagnosis.md", structuralDiagnosis), structuralDiagnosis],
      [binding("plan-versions/2/graph.json", graph2), graph2],
      [binding("plan-versions/2/plan.md", plan2), plan2],
      [binding("plan-versions/2/approval.json", approval2), approval2],
    ] as Array<[RecoveryArtifactBinding, Uint8Array]>;

    expect(authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: entries.map(([entry]) => entry),
      readArtifact: reader(entries),
    }).bindings).toHaveLength(entries.length);
  });

  it("fails closed for changed bytes, missing bindings, forged hashes, extras, and non-content-addressed storage", () => {
    const transient = failure("timeout");
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, transient);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(transient));
    const entries = baseBindings();
    const bindings = entries.map(([entry]) => entry);

    expect(() => authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings,
      readArtifact: reader([[entries[0]![0], Buffer.from("tampered")], entries[1]!]),
    })).toThrow(/bytes do not match/);
    expect(() => authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: bindings.slice(0, 1),
      readArtifact: reader(entries),
    })).toThrow(/missing/);
    expect(() => authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: [{ ...bindings[0]!, sha256: "f".repeat(64) }, bindings[1]!],
      readArtifact: reader(entries),
    })).toThrow(/storage reference/);

    const extraBytes = Buffer.from("unreferenced");
    const extra = binding("plan-versions/1/extra.txt", extraBytes);
    let extraReadCount = 0;
    expect(() => authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: [...bindings, extra],
      readArtifact: (reference) => {
        extraReadCount += 1;
        return reader([...entries, [extra, extraBytes]])(reference);
      },
    })).toThrow(/not referenced/);
    expect(extraReadCount).toBe(0);
    expect(() => recoveryArtifactBinding("plan-versions/1/plan.md", {
      path: `nodes/1/build/contracts/${authority.activePlanHash}.bin`,
      sha256: authority.activePlanHash,
      sizeBytes: planBytes.byteLength,
    })).toThrow(/content-addressed mutation/);
    expect(() => recoveryArtifactBinding(".git/recovery.json", {
      path: `mutations/${authority.activePlanHash}.json`,
      sha256: authority.activePlanHash,
      sizeBytes: planBytes.byteLength,
    })).toThrow(/portable relative path/);
  });

  it("reads and hashes identical authoritative storage only once", () => {
    const localFailure = failure("implementation-defect");
    const diagnosisRef = "plan-versions/1/diagnosis-copy.md";
    const directive: RecoveryDirective = {
      version: 1,
      failureFingerprint: fingerprintFailure(localFailure),
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      diagnosisRef,
      diagnosisHash: authority.activePlanHash,
      evidenceRefs: [],
      repairScope: ["src/feature.ts"],
      validationRequirements: ["focused-tests"],
      topologyAssessment: "preserve",
    };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, localFailure);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(localFailure), directive);

    const entries = baseBindings();
    const diagnosisBinding = recoveryArtifactBinding(diagnosisRef, entries[1]![0].storageRef);
    const allBindings = [...entries.map(([entry]) => entry), diagnosisBinding];
    let readCount = 0;

    expect(authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: allBindings,
      readArtifact: (reference) => {
        readCount += 1;
        return reader(entries)(reference);
      },
    }).bindings).toHaveLength(3);
    expect(readCount).toBe(2);
  });

  it("rejects aggregate unique storage over 64 MiB before reading", () => {
    const localFailure = failure("implementation-defect");
    const diagnosisRef = "plan-versions/1/large-diagnosis.md";
    const evidenceRef = "plan-versions/1/large-evidence.bin";
    const diagnosisHash = "a".repeat(64);
    const evidenceHash = "b".repeat(64);
    const directive: RecoveryDirective = {
      version: 1,
      failureFingerprint: fingerprintFailure(localFailure),
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      diagnosisRef,
      diagnosisHash,
      evidenceRefs: [evidenceRef],
      repairScope: ["src/feature.ts"],
      validationRequirements: ["focused-tests"],
      topologyAssessment: "preserve",
    };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, localFailure);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(localFailure), directive);
    const oversizedBindings = [
      ...baseBindings().map(([entry]) => entry),
      recoveryArtifactBinding(diagnosisRef, {
        path: `mutations/${diagnosisHash}.json`,
        sha256: diagnosisHash,
        sizeBytes: 32 * 1024 * 1024,
      }),
      recoveryArtifactBinding(evidenceRef, {
        path: `mutations/${evidenceHash}.json`,
        sha256: evidenceHash,
        sizeBytes: 32 * 1024 * 1024,
      }),
    ];
    let readCount = 0;

    expect(() => authenticateRecoveryArtifacts({
      authority,
      ledger,
      bindings: oversizedBindings,
      readArtifact: () => {
        readCount += 1;
        return new Uint8Array();
      },
    })).toThrow(/aggregate storage byte budget/);
    expect(readCount).toBe(0);
  });

  it("rejects a content-addressed path whose basename does not match its hash", () => {
    expect(() => recoveryArtifactBinding("plan-versions/1/plan.md", {
      path: `mutations/${"f".repeat(64)}.json`,
      sha256: authority.activePlanHash,
      sizeBytes: planBytes.byteLength,
    })).toThrow(/path does not match its SHA-256 digest/);
  });
});
