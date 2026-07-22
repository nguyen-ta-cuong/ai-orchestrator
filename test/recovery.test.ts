import { describe, expect, it } from "vitest";
import {
  applyRecoveryReleaseToLedger,
  applyRecoveryDecision,
  applyRecoveryDecisionToLedger,
  applyRecoverySuccessorEventToLedger,
  classifyFailure,
  createRecoveryLedger,
  fingerprintFailure,
  recoveryBudgetKey,
  recoveryDirectiveDigest,
  registerRecovery,
  recoveryRankingTuple,
  resumeRecoveryState,
  validateFailureEvidence,
  validateRecoveryDecision,
  validateRecoveryDirective,
  validateRecoveryLedger,
  validateRecoveryState,
  type FailureCategory,
  type FailureEvidence,
  type RecoveryBudgets,
  type RecoveryDecision,
  type RecoveryDirective,
  type RecoveryLevel,
  type RecoveryState,
} from "../src/core/recovery.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function evidence(category: FailureCategory, overrides: Partial<FailureEvidence> = {}): FailureEvidence {
  return {
    version: 1,
    runId: "run-recovery-test",
    nodeId: "build",
    category,
    nodeKind: "build",
    graphVersion: "lifecycle-v1",
    graphDigest: hashC,
    planVersion: 3,
    planHash: hashB,
    attempt: 1,
    failureLineageId: "lineage-build",
    artifactHashes: [hashA],
    ...overrides,
  };
}

function directive(
  failure: FailureEvidence,
  rootCauseCategory: FailureCategory = failure.category,
  overrides: Partial<RecoveryDirective> = {},
): RecoveryDirective {
  const structural = rootCauseCategory === "missing-dependency" ||
    rootCauseCategory === "invalid-topology" || rootCauseCategory === "wrong-decomposition";
  const local = rootCauseCategory === "output-contract" || rootCauseCategory === "implementation-defect";
  return {
    version: 1,
    failureFingerprint: fingerprintFailure(failure),
    rootCauseCategory,
    confidence: "high",
    diagnosisRef: `plan-versions/${failure.planVersion}/debug.json`,
    diagnosisHash: hashB,
    evidenceRefs: [`nodes/${failure.planVersion}/${failure.nodeId}/result.json`],
    repairScope: local ? ["src/feature.ts"] : [],
    validationRequirements: local ? ["tests-pass"] : structural ? ["graph-contract"] : [],
    topologyAssessment: structural ? "structural" : "preserve",
    ...overrides,
  };
}

function stateFor(
  failure: FailureEvidence,
  remaining: RecoveryBudgets = { retry: 1, repair: 1, replan: 1 },
): RecoveryState {
  const authority = {
    version: 1 as const,
    runId: failure.runId,
    graphDigest: failure.graphDigest,
    activePlanVersion: failure.planVersion,
    activePlanHash: failure.planHash,
    limits: { maxEntries: 1, maxPlanVersions: Math.max(failure.planVersion, 4), budgets: remaining },
  };
  const ledger = registerRecovery(createRecoveryLedger(authority), authority, failure);
  return resumeRecoveryState(ledger, authority, fingerprintFailure(failure));
}

function compareTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("failure evidence", () => {
  it("creates a deterministic privacy-safe fingerprint from canonical bounded evidence", () => {
    const first = evidence("output-contract", {
      contractViolation: "validator-rejected",
      artifactHashes: [hashB, hashA],
    });
    const reordered = { ...first, artifactHashes: [hashA, hashB] };

    expect(fingerprintFailure(first)).toBe(fingerprintFailure(reordered));
    expect(fingerprintFailure(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(validateFailureEvidence(first)).toEqual({ ...first, artifactHashes: [hashA, hashB] });
  });

  it("rejects unclosed, raw, oversized, duplicate, and malformed evidence", () => {
    expect(() => validateFailureEvidence({ ...evidence("timeout"), message: "secret provider error" }))
      .toThrow("unexpected field message");
    expect(() => validateFailureEvidence({ ...evidence("timeout"), nodeKind: "x".repeat(129) }))
      .toThrow("nodeKind");
    expect(() => validateFailureEvidence({ ...evidence("timeout"), artifactHashes: [hashA, hashA] }))
      .toThrow("duplicate");
    expect(() => validateFailureEvidence({ ...evidence("timeout"), artifactHashes: ["not-a-hash"] }))
      .toThrow("artifactHashes[0]");
    expect(() => validateFailureEvidence({ ...evidence("timeout"), category: "mystery" }))
      .toThrow("category");
    expect(() => validateFailureEvidence({ ...evidence("timeout"), artifactHashes: Array(33).fill(hashA) }))
      .toThrow("at most 32");
  });

  it("never consumes required or optional schema fields from Object.prototype", () => {
    const prototype = Object.prototype as unknown as Record<string, unknown>;
    const originalVersion = Object.getOwnPropertyDescriptor(Object.prototype, "version");
    const originalContractViolation = Object.getOwnPropertyDescriptor(Object.prototype, "contractViolation");
    try {
      Object.defineProperty(Object.prototype, "version", { configurable: true, value: 1 });
      Object.defineProperty(Object.prototype, "contractViolation", {
        configurable: true,
        value: "validator-rejected",
      });
      const missingVersion: Partial<FailureEvidence> = { ...evidence("timeout") };
      delete missingVersion.version;
      expect(() => validateFailureEvidence(missingVersion)).toThrow(/version/);

      const normalized = validateFailureEvidence(evidence("timeout"));
      expect(Object.hasOwn(normalized, "contractViolation")).toBe(false);
    } finally {
      if (originalVersion) Object.defineProperty(Object.prototype, "version", originalVersion);
      else delete prototype.version;
      if (originalContractViolation) {
        Object.defineProperty(Object.prototype, "contractViolation", originalContractViolation);
      } else {
        delete prototype.contractViolation;
      }
    }
  });
});

describe("recovery directive", () => {
  it("accepts closed typed diagnosis data and rejects raw prose or inconsistent topology", () => {
    const localFailure = evidence("implementation-defect");
    expect(validateRecoveryDirective(directive(localFailure))).toEqual(directive(localFailure));

    expect(() => validateRecoveryDirective({ ...directive(localFailure), explanation: "raw diagnosis" }))
      .toThrow("unexpected field explanation");
    expect(() => validateRecoveryDirective({ ...directive(localFailure), repairScope: ["../outside.ts"] }))
      .toThrow("repairScope[0]");
    expect(() => validateRecoveryDirective({ ...directive(localFailure), repairScope: [] }))
      .toThrow("repairScope");
    expect(() => validateRecoveryDirective({
      ...directive(evidence("invalid-topology")),
      topologyAssessment: "preserve",
    })).toThrow("structural root cause");
  });
});

describe("classifyFailure", () => {
  const cases: ReadonlyArray<{
    category: FailureCategory;
    withDiagnosis: boolean;
    action: RecoveryLevel | "pause" | "fail";
    reason: string;
  }> = [
    { category: "transient-provider", withDiagnosis: false, action: "retry", reason: "transient-failure" },
    { category: "transient-tool", withDiagnosis: false, action: "retry", reason: "transient-failure" },
    { category: "timeout", withDiagnosis: false, action: "retry", reason: "transient-failure" },
    { category: "output-contract", withDiagnosis: true, action: "repair", reason: "local-defect" },
    { category: "implementation-defect", withDiagnosis: true, action: "repair", reason: "local-defect" },
    { category: "missing-dependency", withDiagnosis: true, action: "replan", reason: "structural-defect" },
    { category: "invalid-topology", withDiagnosis: true, action: "replan", reason: "structural-defect" },
    { category: "wrong-decomposition", withDiagnosis: true, action: "replan", reason: "structural-defect" },
    { category: "configuration", withDiagnosis: false, action: "pause", reason: "configuration-change-required" },
    { category: "authorization", withDiagnosis: false, action: "pause", reason: "human-authorization-required" },
    { category: "policy", withDiagnosis: false, action: "pause", reason: "policy-change-required" },
    { category: "side-effect", withDiagnosis: false, action: "pause", reason: "side-effect-review-required" },
    { category: "budget", withDiagnosis: false, action: "fail", reason: "global-budget-exhausted" },
    { category: "unknown", withDiagnosis: false, action: "pause", reason: "diagnosis-required" },
    { category: "unknown", withDiagnosis: true, action: "fail", reason: "unknown-after-diagnosis" },
  ];

  for (const entry of cases) {
    it(`${entry.category} deterministically selects ${entry.action}`, () => {
      const failure = evidence(entry.category);
      const decision = classifyFailure(
        failure,
        stateFor(failure),
        entry.withDiagnosis ? directive(failure) : undefined,
      );

      expect(decision).toMatchObject({
        action: entry.action,
        reason: entry.reason,
        failureFingerprint: fingerprintFailure(failure),
      });
    });
  }

  it("requires typed diagnosis before repair or replan", () => {
    for (const category of ["output-contract", "invalid-topology"] as const) {
      const failure = evidence(category);
      expect(classifyFailure(failure, stateFor(failure))).toMatchObject({
        action: "pause",
        reason: "diagnosis-required",
      });
    }
  });

  it("rejects diagnosis and evidence references from a stale plan version", () => {
    const failure = evidence("implementation-defect");
    const state = stateFor(failure);
    expect(() => classifyFailure(failure, state, {
      ...directive(failure),
      diagnosisRef: "plan-versions/2/debug.json",
    })).toThrow("diagnosisRef");
    expect(() => classifyFailure(failure, state, {
      ...directive(failure),
      evidenceRefs: ["nodes/2/build/result.json"],
    })).toThrow("evidenceRef");
  });

  it("allows a diagnosis to classify unknown evidence without resetting its fingerprint", () => {
    const failure = evidence("unknown");
    const diagnosis = directive(failure, "implementation-defect", {
      repairScope: ["src/core/worker.ts"],
      validationRequirements: ["worker-contract"],
    });
    const decision = classifyFailure(failure, stateFor(failure), diagnosis);

    expect(decision).toMatchObject({
      action: "repair",
      observedCategory: "unknown",
      effectiveCategory: "implementation-defect",
      failureFingerprint: fingerprintFailure(failure),
    });
  });

  it("fails closed when the selected level is exhausted or already consumed", () => {
    const failure = evidence("transient-provider");
    const noBudget = stateFor(failure, { retry: 0, repair: 1, replan: 1 });
    expect(classifyFailure(failure, noBudget)).toMatchObject({ action: "fail", reason: "retry-exhausted" });

    const first = classifyFailure(failure, stateFor(failure));
    const consumed = applyRecoveryDecision(stateFor(failure), first);
    expect(classifyFailure(failure, validateRecoveryState({ ...consumed, status: "active" })))
      .toMatchObject({ action: "fail", reason: "recovery-level-consumed" });
  });

  it("fails closed at the plan-version ceiling instead of overflowing a successor", () => {
    const failure = evidence("invalid-topology", { planVersion: 1_000_000 });
    expect(classifyFailure(
      failure,
      stateFor(failure, { retry: 1, repair: 1, replan: 1 }),
      directive(failure),
    )).toMatchObject({ action: "fail", reason: "replan-exhausted", targetPlanVersion: 1_000_000 });
  });

  it("does not skip an unconsumed ladder level after recovery has begun", () => {
    const failure = evidence("unknown");
    const state = stateFor(failure);
    const retried = applyRecoveryDecision(
      state,
      classifyFailure(failure, state, directive(failure, "timeout")),
    );

    expect(classifyFailure(
      failure,
      validateRecoveryState({ ...retried, status: "active" }),
      directive(failure, "invalid-topology"),
    )).toMatchObject({
      action: "fail",
      reason: "recovery-level-skipped",
    });
  });
});

describe("applyRecoveryDecision", () => {
  it("preserves topology and plan version for retry and repair", () => {
    for (const category of ["timeout", "implementation-defect"] as const) {
      const failure = evidence(category);
      const state = stateFor(failure);
      const decision = classifyFailure(
        failure,
        state,
        category === "implementation-defect" ? directive(failure) : undefined,
      );
      const next = applyRecoveryDecision(state, decision);

      expect(decision.topology).toBe("preserve");
      expect(next.sourcePlanVersion).toBe(3);
      expect(next.approvedPlanVersion).toBe(3);
      expect(state.consumed).toEqual([]);
      expect(next.consumed).toEqual([decision.action]);
    }
  });

  it("increments a replanned successor exactly once without changing the source version", () => {
    const failure = evidence("invalid-topology");
    const state = stateFor(failure);
    const decision = classifyFailure(failure, state, directive(failure));
    const next = applyRecoveryDecision(state, decision);

    expect(decision).toMatchObject({
      action: "replan",
      topology: "successor",
      sourcePlanVersion: 3,
      targetPlanVersion: 4,
    });
    expect(next).toMatchObject({
      sourcePlanVersion: 3,
      approvedPlanVersion: 3,
      status: "waiting-successor-artifact",
      consumed: ["replan"],
    });
    expect(() => classifyFailure(failure, next, directive(failure))).toThrow("waiting-successor-artifact");
  });

  it("rejects fingerprint resets, stale snapshots, budget increases, repeats, and level regression", () => {
    const failure = evidence("unknown");
    const state = stateFor(failure);
    const repair = classifyFailure(failure, state, directive(failure, "implementation-defect", {
      repairScope: ["src/core/worker.ts"],
      validationRequirements: ["worker-contract"],
    }));

    expect(() => applyRecoveryDecision(state, { ...repair, failureFingerprint: hashA }))
      .toThrow("fingerprint");
    expect(() => applyRecoveryDecision(state, {
      ...repair,
      remainingBefore: { ...repair.remainingBefore, retry: 0 },
      remainingAfter: { ...repair.remainingAfter, retry: 0 },
    })).toThrow("stale remaining budget");
    expect(() => validateRecoveryDecision({
      ...repair,
      remainingAfter: { ...repair.remainingAfter, repair: repair.remainingBefore.repair + 1 },
    })).toThrow(/0 or 1|decrement exactly once/);

    const afterRepair = applyRecoveryDecision(state, repair);
    expect(applyRecoveryDecision(afterRepair, repair)).toEqual(afterRepair);

    const regressiveDecision = classifyFailure(
      failure,
      stateFor(failure),
      directive(failure, "transient-tool"),
    );
    expect(() => applyRecoveryDecision(validateRecoveryState({ ...afterRepair, status: "active" }), {
      ...regressiveDecision,
      failureFingerprint: afterRepair.fingerprint,
      observedCategory: afterRepair.observedCategory,
      remainingBefore: afterRepair.remaining,
      remainingAfter: { ...afterRepair.remaining, retry: afterRepair.remaining.retry - 1 },
      sourcePlanVersion: afterRepair.approvedPlanVersion,
      sourcePlanHash: afterRepair.approvedPlanHash,
      targetPlanVersion: afterRepair.approvedPlanVersion,
    })).toThrow("regress");
  });

  it("rejects forged category/action and reason combinations before applying them", () => {
    const failure = evidence("authorization");
    const state = stateFor(failure);
    const paused = classifyFailure(failure, state);
    const forgedRetry = {
      ...paused,
      action: "retry",
      reason: "transient-failure",
      remainingAfter: { ...paused.remainingAfter, retry: paused.remainingAfter.retry - 1 },
    };
    expect(() => validateRecoveryDecision(forgedRetry)).toThrow("cannot recover automatically");
    expect(() => validateRecoveryDecision({ ...paused, effectiveCategory: "timeout" }))
      .toThrow("cannot recategorize known failure");
    expect(() => validateRecoveryDecision({ ...paused, reason: "policy-change-required" }))
      .toThrow("does not match");

    const structuralFailure = evidence("invalid-topology");
    const structural = classifyFailure(
      structuralFailure,
      stateFor(structuralFailure),
      directive(structuralFailure),
    );
    const undiagnosed = { ...structural } as Partial<typeof structural>;
    delete undiagnosed.directiveHash;
    expect(() => validateRecoveryDecision(undiagnosed)).toThrow("diagnosis directive hash");
  });

  it("makes failures absorbing and waiting states require explicit release evidence", () => {
    const budgetFailure = evidence("budget");
    const active = stateFor(budgetFailure);
    const failed = applyRecoveryDecision(active, classifyFailure(budgetFailure, active));

    const unrelatedFailure = evidence("timeout");
    const unrelatedDecision = classifyFailure(unrelatedFailure, stateFor(unrelatedFailure));
    expect(applyRecoveryDecision(failed, unrelatedDecision)).toEqual(failed);

    const authorizationFailure = evidence("authorization");
    const authorizationState = stateFor(authorizationFailure);
    const paused = applyRecoveryDecision(
      authorizationState,
      classifyFailure(authorizationFailure, authorizationState),
    );
    expect(paused.status).toBe("waiting-authorization");
    expect(() => applyRecoveryDecision(paused, unrelatedDecision)).toThrow("explicit resume");
  });

  it("strictly validates state snapshots", () => {
    const failure = evidence("timeout");
    const state = stateFor(failure);
    expect(validateRecoveryState(state)).toEqual(state);
    expect(() => validateRecoveryState({ ...state, extra: true })).toThrow("unexpected field extra");
    expect(() => validateRecoveryState({ ...state, remaining: { ...state.remaining, retry: -1 } }))
      .toThrow("remaining.retry");
    expect(() => validateRecoveryState({ ...state, consumed: ["repair", "retry"] }))
      .toThrow("strictly escalate");
  });
});

describe("bounded recovery properties", () => {
  it("never increases a frozen 0/1 budget and every permitted recovery decreases rank", () => {
    const categoryForLevel: Record<RecoveryLevel, FailureCategory> = {
      retry: "timeout",
      repair: "implementation-defect",
      replan: "invalid-topology",
    };

    for (let retryBudget = 0; retryBudget <= 1; retryBudget += 1) {
      for (let repairBudget = 0; repairBudget <= 1; repairBudget += 1) {
        for (let replanBudget = 0; replanBudget <= 1; replanBudget += 1) {
          const budgets = { retry: retryBudget, repair: repairBudget, replan: replanBudget };
          for (const level of ["retry", "repair", "replan"] as const) {
            const failure = evidence(categoryForLevel[level]);
            const state = stateFor(failure, budgets);
            const decision = classifyFailure(
              failure,
              state,
              level === "retry" ? undefined : directive(failure),
            );
            const next = applyRecoveryDecision(state, decision);

            expect(next.remaining.retry).toBeLessThanOrEqual(state.remaining.retry);
            expect(next.remaining.repair).toBeLessThanOrEqual(state.remaining.repair);
            expect(next.remaining.replan).toBeLessThanOrEqual(state.remaining.replan);
            expect(compareTuple(recoveryRankingTuple(next), recoveryRankingTuple(state))).toBeLessThan(0);

            if (decision.action === level) {
              expect(next.consumed).toEqual([level]);
            }
          }
        }
      }
    }
  });

  it("never automatically recovers any safety failure", () => {
    for (const category of ["budget", "authorization", "policy", "side-effect"] as const) {
      for (let budget = 0; budget <= 1; budget += 1) {
        const failure = evidence(category);
        const decision = classifyFailure(failure, stateFor(failure, {
          retry: budget,
          repair: budget,
          replan: budget,
        }));
        expect(["pause", "fail"]).toContain(decision.action);
      }
    }
  });
});

describe("durable recovery hardening", () => {
  const authority = {
    version: 1 as const,
    runId: "run-recovery-1",
    graphDigest: "c".repeat(64),
    activePlanVersion: 2,
    activePlanHash: "1".repeat(64),
    limits: {
      maxEntries: 8,
      maxPlanVersions: 4,
      budgets: { retry: 1, repair: 1, replan: 1 },
    },
  };

  const durableFailure = {
    version: 1 as const,
    runId: authority.runId,
    nodeId: "build-a",
    nodeKind: "build",
    graphVersion: "lifecycle-v1",
    graphDigest: authority.graphDigest,
    planVersion: 2,
    planHash: authority.activePlanHash,
    attempt: 1,
    failureLineageId: "lineage-build-a",
    category: "invalid-topology" as const,
    contractViolation: "validator-rejected" as const,
    contractId: "build-output",
    artifactHashes: [hashA],
  };

  const structuralDirective = {
    version: 1 as const,
    failureFingerprint: fingerprintFailure(durableFailure),
    rootCauseCategory: "invalid-topology" as const,
    confidence: "high" as const,
    diagnosisRef: "plan-versions/2/debug.json",
    diagnosisHash: hashB,
    evidenceRefs: ["nodes/2/build-a/result.json"],
    repairScope: [],
    validationRequirements: ["graph-contract"],
    topologyAssessment: "structural" as const,
  };

  it("binds canonical authoritative failure identity into the fingerprint", () => {
    const base = fingerprintFailure(durableFailure);
    expect(fingerprintFailure({ ...durableFailure, nodeId: "build-b" })).not.toBe(base);
    expect(fingerprintFailure({ ...durableFailure, attempt: 2 })).not.toBe(base);
    expect(fingerprintFailure({ ...durableFailure, planVersion: 3 })).not.toBe(base);
    expect(fingerprintFailure({ ...durableFailure, failureLineageId: "lineage-build-b" })).not.toBe(base);
    expect(fingerprintFailure({ ...durableFailure, graphDigest: "d".repeat(64) })).not.toBe(base);
    expect(fingerprintFailure({ ...durableFailure, planHash: "9".repeat(64) })).not.toBe(base);
    expect(recoveryBudgetKey({ ...durableFailure, attempt: 2, artifactHashes: [hashB] }))
      .toBe(recoveryBudgetKey(durableFailure));
    expect(recoveryBudgetKey({ ...durableFailure, nodeId: "build-b" }))
      .not.toBe(recoveryBudgetKey(durableFailure));
  });

  it("keeps parallel node lineages independent", () => {
    const first = { ...durableFailure, category: "timeout" as const };
    const second = {
      ...first,
      nodeId: "build-b",
      failureLineageId: "lineage-build-b",
    };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, first);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(first));
    ledger = registerRecovery(ledger, authority, second);
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(second))).toMatchObject({
      consumed: [],
      remaining: { retry: 1, repair: 1, replan: 1 },
    });
  });

  it("advances new occurrences under one stable lineage budget without replenishment", () => {
    const transient = { ...durableFailure, category: "timeout" as const };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, transient);
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(transient));
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(transient))).toMatchObject({
      status: "released",
      consumed: ["retry"],
      remaining: { retry: 0, repair: 1, replan: 1 },
    });

    const local = {
      ...durableFailure,
      category: "implementation-defect" as const,
      attempt: 2,
      artifactHashes: [hashB],
    };
    ledger = registerRecovery(ledger, authority, local);
    const localInitial = resumeRecoveryState(ledger, authority, fingerprintFailure(local));
    expect(localInitial).toMatchObject({ consumed: ["retry"], remaining: { retry: 0, repair: 1, replan: 1 } });
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(local),
      directive(local, "implementation-defect", {
        diagnosisRef: "plan-versions/2/debug-local.json",
        repairScope: ["src/core/recovery.ts"],
        validationRequirements: ["recovery-contract"],
      }),
    );

    const structural = {
      ...durableFailure,
      attempt: 3,
      artifactHashes: ["8".repeat(64)],
    };
    ledger = registerRecovery(ledger, authority, structural);
    const structuralInitial = resumeRecoveryState(ledger, authority, fingerprintFailure(structural));
    expect(structuralInitial).toMatchObject({
      consumed: ["retry", "repair"],
      remaining: { retry: 0, repair: 0, replan: 1 },
    });
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(structural),
      { ...structuralDirective, failureFingerprint: fingerprintFailure(structural) },
    );
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(structural))).toMatchObject({
      consumed: ["retry", "repair", "replan"],
      remaining: { retry: 0, repair: 0, replan: 0 },
    });

    expect(() => registerRecovery(ledger, authority, {
      ...structural,
      attempt: 4,
      artifactHashes: ["7".repeat(64)],
    })).toThrow(/prior lineage occurrence|released/);
  });

  it("persists immutable evidence and rederives every diagnosis-bound decision", () => {
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, durableFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
    );
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure)).status)
      .toBe("waiting-diagnosis");

    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
      structuralDirective,
    );
    const record = ledger.records.at(-1);
    expect(record?.kind).toBe("decision");
    if (!record || record.kind !== "decision") throw new Error("missing decision record");
    expect(record.directive).toEqual(structuralDirective);
    expect(record.decision.directiveHash).toBe(recoveryDirectiveDigest(structuralDirective));

    const tampered = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
    const transition = tampered.records.at(-1);
    if (!transition || transition.kind !== "decision") throw new Error("missing decision record");
    delete (transition as { directive?: unknown }).directive;
    expect(() => validateRecoveryLedger(tampered, authority)).toThrow(/directive|rederived|hash chain/);
  });

  it("uses explicit release evidence to resume non-diagnosis waits", () => {
    const authorizationFailure = { ...durableFailure, category: "authorization" as const };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, authorizationFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(authorizationFailure),
    );
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(authorizationFailure)).status)
      .toBe("waiting-authorization");

    ledger = applyRecoveryReleaseToLedger(ledger, authority, {
      version: 1,
      failureFingerprint: fingerprintFailure(authorizationFailure),
      reason: "authorization-granted",
      evidenceRef: "plan-versions/2/recovery-authorization.json",
      evidenceHash: "e".repeat(64),
    });
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(authorizationFailure)).status)
      .toBe("released");
  });

  it("keeps N approved through successor intent, artifact, and approval, then activates N+1", () => {
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, durableFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
      structuralDirective,
    );
    let state = resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure));
    expect(state).toMatchObject({
      status: "waiting-successor-artifact",
      sourcePlanVersion: 2,
      approvedPlanVersion: 2,
      successor: { status: "intent-recorded", targetPlanVersion: 3 },
    });

    const artifact = {
      version: 1 as const,
      phase: "artifact-durable" as const,
      failureFingerprint: fingerprintFailure(durableFailure),
      sourcePlanVersion: 2,
      targetPlanVersion: 3,
      graphHash: "d".repeat(64),
      planHash: "e".repeat(64),
      graphRef: "plan-versions/3/graph.json",
      planRef: "plan-versions/3/plan.md",
    };
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, artifact);
    state = resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure));
    expect(state).toMatchObject({ status: "waiting-successor-approval", approvedPlanVersion: 2 });

    const approval = {
      ...artifact,
      phase: "approved" as const,
      approvalRef: "plan-versions/3/approval.json",
      approvalHash: "f".repeat(64),
    };
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, approval);
    state = resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure));
    expect(state).toMatchObject({ status: "ready-successor-activation", approvedPlanVersion: 2 });

    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, {
      ...approval,
      phase: "activated",
    });
    state = resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure));
    expect(state).toMatchObject({
      status: "released",
      approvedPlanVersion: 3,
      approvedPlanHash: artifact.planHash,
      successor: { status: "activated" },
    });

    expect(() => registerRecovery(ledger, authority, {
      ...durableFailure,
      attempt: 2,
      artifactHashes: ["6".repeat(64)],
    })).toThrow(/current approved plan/);

    const repeated = {
      ...durableFailure,
      planVersion: 3,
      planHash: artifact.planHash,
      attempt: 2,
      artifactHashes: ["7".repeat(64)],
    };
    ledger = registerRecovery(ledger, authority, repeated);
    const repeatedState = resumeRecoveryState(ledger, authority, fingerprintFailure(repeated));
    expect(repeatedState).toMatchObject({ consumed: ["replan"], remaining: { replan: 0 } });
    ledger = applyRecoveryDecisionToLedger(ledger, authority, fingerprintFailure(repeated), {
      ...structuralDirective,
      failureFingerprint: fingerprintFailure(repeated),
      diagnosisRef: "plan-versions/3/debug.json",
      evidenceRefs: ["nodes/3/build-a/result.json"],
    });
    expect(resumeRecoveryState(ledger, authority, fingerprintFailure(repeated))).toMatchObject({
      status: "failed",
      consumed: ["replan"],
      remaining: { replan: 0 },
    });
  });

  it("lets only current-plan recovery records advance after authoritative activation", () => {
    const competingFailure = {
      ...durableFailure,
      nodeId: "build-b",
      failureLineageId: "lineage-build-b",
      artifactHashes: [hashB],
    };
    const authorizationFailure = {
      ...durableFailure,
      nodeId: "ship-a",
      failureLineageId: "lineage-ship-a",
      category: "authorization" as const,
      artifactHashes: ["9".repeat(64)],
    };
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, durableFailure);
    ledger = registerRecovery(ledger, authority, competingFailure);
    ledger = registerRecovery(ledger, authority, authorizationFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(authorizationFailure),
    );
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
      structuralDirective,
    );
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(competingFailure),
      {
        ...structuralDirective,
        failureFingerprint: fingerprintFailure(competingFailure),
        evidenceRefs: ["nodes/2/build-b/result.json"],
      },
    );

    const firstArtifact = {
      version: 1 as const,
      phase: "artifact-durable" as const,
      failureFingerprint: fingerprintFailure(durableFailure),
      sourcePlanVersion: 2,
      targetPlanVersion: 3,
      graphHash: "d".repeat(64),
      planHash: "e".repeat(64),
      graphRef: "plan-versions/3/graph.json",
      planRef: "plan-versions/3/plan.md",
    };
    const secondArtifact = {
      ...firstArtifact,
      failureFingerprint: fingerprintFailure(competingFailure),
      graphHash: "7".repeat(64),
      planHash: "8".repeat(64),
    };
    const approve = <T extends typeof firstArtifact>(artifact: T) => ({
      ...artifact,
      phase: "approved" as const,
      approvalHash: "f".repeat(64),
      approvalRef: "plan-versions/3/approval.json",
    });
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, firstArtifact);
    expect(() => applyRecoverySuccessorEventToLedger(ledger, authority, secondArtifact))
      .toThrow(/plan-versions\/3|namespace|reserved/);
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, approve(firstArtifact));
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, {
      ...approve(firstArtifact),
      phase: "activated",
    });

    expect(() => applyRecoveryReleaseToLedger(ledger, authority, {
      version: 1,
      failureFingerprint: fingerprintFailure(authorizationFailure),
      reason: "authorization-granted",
      evidenceRef: "plan-versions/2/recovery-authorization.json",
      evidenceHash: "6".repeat(64),
    })).toThrow(/current approved plan|stale source plan/);
  });

  it("binds the ledger to frozen authority, genesis, and its append-only hash chain", () => {
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, durableFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
      structuralDirective,
    );
    expect(validateRecoveryLedger(JSON.parse(JSON.stringify(ledger)), authority)).toEqual(ledger);
    expect(() => validateRecoveryLedger(ledger, {
      ...authority,
      limits: { ...authority.limits, maxPlanVersions: 5 },
    })).toThrow(/authority|genesis|limits/);
    expect(() => validateRecoveryLedger(ledger, {
      ...authority,
      activePlanHash: "9".repeat(64),
    })).toThrow(/authority|genesis|plan/i);
    expect(() => registerRecovery(createRecoveryLedger(authority), authority, {
      ...durableFailure,
      planHash: "9".repeat(64),
    })).toThrow(/planHash|approved ledger plan/);

    const tampered = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
    tampered.records.reverse();
    expect(() => validateRecoveryLedger(tampered, authority)).toThrow(/sequence|hash chain/);
  });

  it("rejects accessors, inherited records, sparse or augmented arrays, and budgets above one", () => {
    let reads = 0;
    const accessor = { ...durableFailure } as Record<string, unknown>;
    Object.defineProperty(accessor, "nodeId", {
      enumerable: true,
      get() {
        reads += 1;
        return "build-a";
      },
    });
    expect(() => validateFailureEvidence(accessor)).toThrow(/data propert|plain/);
    expect(reads).toBe(0);
    expect(() => validateFailureEvidence(Object.assign(Object.create(durableFailure), {})))
      .toThrow(/plain/);
    expect(() => validateFailureEvidence({ ...durableFailure, artifactHashes: Array(1) }))
      .toThrow(/dense|array/);
    const augmented = [hashA] as string[] & { map?: unknown };
    Object.defineProperty(augmented, "map", { value: () => [] });
    expect(() => validateFailureEvidence({ ...durableFailure, artifactHashes: augmented }))
      .toThrow(/exact|array/);
    expect(() => createRecoveryLedger({
      ...authority,
      limits: { ...authority.limits, budgets: { retry: 2, repair: 1, replan: 1 } },
    })).toThrow(/0 or 1/);
  });

  it("uses portable repository semantics for repair scope", () => {
    const localFailure = { ...durableFailure, category: "implementation-defect" as const };
    const base = {
      ...structuralDirective,
      failureFingerprint: fingerprintFailure(localFailure),
      rootCauseCategory: "implementation-defect" as const,
      topologyAssessment: "preserve" as const,
      repairScope: ["src/core/recovery.ts"],
    };
    expect(validateRecoveryDirective(base).repairScope).toEqual(["src/core/recovery.ts"]);
    for (const path of ["C:/outside.ts", ".ai-orchestrator/state.json", "src/CON.txt", "src/file."]) {
      expect(() => validateRecoveryDirective({ ...base, repairScope: [path] })).toThrow(/repairScope/);
    }
  });

  it("validates successor state artifact references against its exact target version", () => {
    let ledger = registerRecovery(createRecoveryLedger(authority), authority, durableFailure);
    ledger = applyRecoveryDecisionToLedger(
      ledger,
      authority,
      fingerprintFailure(durableFailure),
      structuralDirective,
    );
    ledger = applyRecoverySuccessorEventToLedger(ledger, authority, {
      version: 1,
      phase: "artifact-durable",
      failureFingerprint: fingerprintFailure(durableFailure),
      sourcePlanVersion: 2,
      targetPlanVersion: 3,
      graphHash: "d".repeat(64),
      planHash: "e".repeat(64),
      graphRef: "plan-versions/3/graph.json",
      planRef: "plan-versions/3/plan.md",
    });
    const state = resumeRecoveryState(ledger, authority, fingerprintFailure(durableFailure));
    expect(() => validateRecoveryState({
      ...state,
      successor: { ...state.successor, graphRef: "plan-versions/3/other.json" },
    })).toThrow(/exact target plan version/);
  });
});
