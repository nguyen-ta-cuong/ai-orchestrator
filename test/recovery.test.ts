import { describe, expect, it } from "vitest";
import {
  applyRecoveryDecision,
  applyRecoveryDecisionToLedger,
  classifyFailure,
  createRecoveryLedger,
  fingerprintFailure,
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

function evidence(category: FailureCategory, overrides: Partial<FailureEvidence> = {}): FailureEvidence {
  return {
    version: 1,
    category,
    nodeKind: "build",
    graphVersion: "lifecycle-v1",
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
    diagnosisHash: hashB,
    evidenceRefs: ["nodes/1/build/result.json"],
    repairScope: local ? ["src/feature.ts"] : [],
    validationRequirements: local ? ["tests-pass"] : [],
    topologyAssessment: structural ? "structural" : "preserve",
    ...overrides,
  };
}

function stateFor(
  failure: FailureEvidence,
  remaining: RecoveryBudgets = { retry: 1, repair: 1, replan: 1 },
  sourcePlanVersion = 3,
): RecoveryState {
  const ledger = registerRecovery(createRecoveryLedger(1), failure, { remaining, sourcePlanVersion });
  return resumeRecoveryState(ledger, fingerprintFailure(failure));
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
    expect(classifyFailure(failure, consumed)).toMatchObject({ action: "fail", reason: "recovery-level-consumed" });
  });

  it("fails closed at the plan-version ceiling instead of overflowing a successor", () => {
    const failure = evidence("invalid-topology");
    expect(classifyFailure(
      failure,
      stateFor(failure, { retry: 1, repair: 1, replan: 1 }, 1_000_000),
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

    expect(classifyFailure(failure, retried, directive(failure, "invalid-topology"))).toMatchObject({
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
      expect(next.activePlanVersion).toBe(3);
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
    expect(next).toMatchObject({ sourcePlanVersion: 3, activePlanVersion: 4, consumed: ["replan"] });
    expect(classifyFailure(failure, next, directive(failure))).toMatchObject({
      action: "fail",
      reason: "recovery-level-consumed",
      targetPlanVersion: 4,
    });
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
    })).toThrow("decrement exactly once");

    const afterRepair = applyRecoveryDecision(state, repair);
    expect(() => applyRecoveryDecision(afterRepair, repair)).toThrow("stale remaining budget");

    const regressiveDecision = classifyFailure(
      failure,
      stateFor(failure),
      directive(failure, "transient-tool"),
    );
    expect(() => applyRecoveryDecision(afterRepair, {
      ...regressiveDecision,
      failureFingerprint: afterRepair.fingerprint,
      observedCategory: afterRepair.observedCategory,
      remainingBefore: afterRepair.remaining,
      remainingAfter: { ...afterRepair.remaining, retry: afterRepair.remaining.retry - 1 },
      sourcePlanVersion: afterRepair.activePlanVersion,
      targetPlanVersion: afterRepair.activePlanVersion,
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
  });

  it("makes pause and fail outcomes absorbing", () => {
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
    expect(applyRecoveryDecision(paused, unrelatedDecision)).toEqual(paused);
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
  it("walks retry to repair to replan exactly once while decreasing rank at every step", () => {
    const failure = evidence("unknown");
    let state = stateFor(failure, { retry: 2, repair: 2, replan: 2 });
    const diagnoses = [
      directive(failure, "timeout"),
      directive(failure, "implementation-defect", {
        repairScope: ["src/core/worker.ts"],
        validationRequirements: ["worker-contract"],
      }),
      directive(failure, "invalid-topology"),
    ] as const;

    for (const [index, expectedLevel] of (["retry", "repair", "replan"] as const).entries()) {
      const before = state;
      const decision = classifyFailure(failure, before, diagnoses[index]);
      state = applyRecoveryDecision(before, decision);
      expect(decision.action).toBe(expectedLevel);
      expect(compareTuple(recoveryRankingTuple(state), recoveryRankingTuple(before))).toBeLessThan(0);
    }

    expect(state.consumed).toEqual(["retry", "repair", "replan"]);
    expect(state.remaining).toEqual({ retry: 1, repair: 1, replan: 1 });
    expect(state.activePlanVersion).toBe(state.sourcePlanVersion + 1);
    const terminalDecision = classifyFailure(failure, state, diagnoses[2]);
    const terminal = applyRecoveryDecision(state, terminalDecision);
    expect(terminalDecision).toMatchObject({ action: "fail", reason: "recovery-level-consumed" });
    expect(compareTuple(recoveryRankingTuple(terminal), recoveryRankingTuple(state))).toBeLessThan(0);
  });

  it("never regresses levels, reuses a level, increases budgets, or leaves rank unchanged", () => {
    const categoryForLevel: Record<RecoveryLevel, FailureCategory> = {
      retry: "timeout",
      repair: "implementation-defect",
      replan: "invalid-topology",
    };

    for (let retryBudget = 0; retryBudget <= 3; retryBudget += 1) {
      for (let repairBudget = 0; repairBudget <= 3; repairBudget += 1) {
        for (let replanBudget = 0; replanBudget <= 3; replanBudget += 1) {
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
              const repeated = classifyFailure(
                failure,
                next,
                level === "retry" ? undefined : directive(failure),
              );
              expect(repeated.action).toBe("fail");
            }
          }
        }
      }
    }
  });

  it("never automatically recovers any safety failure", () => {
    for (const category of ["budget", "authorization", "policy", "side-effect"] as const) {
      for (let budget = 0; budget <= 3; budget += 1) {
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

describe("recovery ledger", () => {
  it("round-trips immutable consumed history and terminal outcomes across resume", () => {
    const failure = evidence("timeout");
    const initialized = registerRecovery(createRecoveryLedger(4), failure, {
      remaining: { retry: 2, repair: 1, replan: 1 },
      sourcePlanVersion: 7,
    });
    const initial = resumeRecoveryState(initialized, fingerprintFailure(failure));
    const retry = classifyFailure(failure, initial);
    const updated = applyRecoveryDecisionToLedger(initialized, retry);

    const restored = validateRecoveryLedger(JSON.parse(JSON.stringify(updated)));
    expect(resumeRecoveryState(restored, fingerprintFailure(failure))).toMatchObject({
      consumed: ["retry"],
      remaining: { retry: 1, repair: 1, replan: 1 },
      status: "active",
    });

    const exhausted = classifyFailure(failure, resumeRecoveryState(restored, fingerprintFailure(failure)));
    const terminal = applyRecoveryDecisionToLedger(restored, exhausted);
    const replayed = applyRecoveryDecisionToLedger(terminal, exhausted);
    expect(replayed).toEqual(terminal);
    expect(resumeRecoveryState(validateRecoveryLedger(JSON.parse(JSON.stringify(replayed))), fingerprintFailure(failure)))
      .toMatchObject({ status: "failed", consumed: ["retry"] });
  });

  it("rejects duplicate initialization and an attempted budget/history reset", () => {
    const failure = evidence("transient-tool");
    const initialized = registerRecovery(createRecoveryLedger(), failure, {
      remaining: { retry: 1, repair: 1, replan: 1 },
      sourcePlanVersion: 1,
    });
    expect(() => registerRecovery(initialized, failure, {
      remaining: { retry: 10, repair: 10, replan: 10 },
      sourcePlanVersion: 1,
    })).toThrow("already initialized");

    const initial = resumeRecoveryState(initialized, fingerprintFailure(failure));
    const updated = applyRecoveryDecisionToLedger(initialized, classifyFailure(failure, initial));
    const tampered = JSON.parse(JSON.stringify(updated)) as {
      entries: Array<{
        initial: RecoveryState;
        transitions: Array<{ decision: RecoveryDecision; state: RecoveryState }>;
      }>;
    };
    tampered.entries[0]!.transitions[0]!.state = {
      ...tampered.entries[0]!.transitions[0]!.state,
      remaining: { retry: 2, repair: 1, replan: 1 },
    };
    expect(() => validateRecoveryLedger(tampered)).toThrow("replayed decision");
  });

  it("rejects a semantically impossible persisted route for a known category", () => {
    const failure = evidence("timeout");
    const initialized = registerRecovery(createRecoveryLedger(), failure, {
      remaining: { retry: 1, repair: 1, replan: 1 },
      sourcePlanVersion: 1,
    });
    const initial = resumeRecoveryState(initialized, fingerprintFailure(failure));
    const retry = classifyFailure(failure, initial);
    for (const route of ["repair", "replan"] as const) {
      const structural = route === "replan";
      const forgedDecision = {
        ...retry,
        effectiveCategory: structural ? "invalid-topology" : "implementation-defect",
        action: route,
        reason: structural ? "structural-defect" : "local-defect",
        topology: structural ? "successor" : "preserve",
        targetPlanVersion: structural ? 2 : 1,
        remainingAfter: { ...retry.remainingBefore, [route]: retry.remainingBefore[route] - 1 },
      } as const;
      const forgedState = {
        ...initial,
        consumed: [route],
        remaining: forgedDecision.remainingAfter,
        activePlanVersion: forgedDecision.targetPlanVersion,
      };
      const tampered = JSON.parse(JSON.stringify(initialized)) as {
        entries: Array<{ transitions: Array<{ decision: unknown; state: unknown }> }>;
      };
      tampered.entries[0]!.transitions.push({ decision: forgedDecision, state: forgedState });
      expect(() => validateRecoveryLedger(tampered)).toThrow("cannot recategorize known failure");
    }
  });

  it("rejects persisted history that skips the next ladder level", () => {
    const failure = evidence("unknown");
    const initialized = registerRecovery(createRecoveryLedger(), failure, {
      remaining: { retry: 1, repair: 1, replan: 1 },
      sourcePlanVersion: 1,
    });
    const initial = resumeRecoveryState(initialized, fingerprintFailure(failure));
    const retriedLedger = applyRecoveryDecisionToLedger(
      initialized,
      classifyFailure(failure, initial, directive(failure, "timeout")),
    );
    const retried = resumeRecoveryState(retriedLedger, fingerprintFailure(failure));
    const directReplan = classifyFailure(failure, stateFor(failure, retried.remaining, 1), directive(failure, "invalid-topology"));
    const forgedDecision = {
      ...directReplan,
      remainingBefore: retried.remaining,
      remainingAfter: { ...retried.remaining, replan: retried.remaining.replan - 1 },
      sourcePlanVersion: retried.activePlanVersion,
      targetPlanVersion: retried.activePlanVersion + 1,
    };
    const forgedState = {
      ...retried,
      consumed: ["retry", "replan"],
      remaining: forgedDecision.remainingAfter,
      activePlanVersion: forgedDecision.targetPlanVersion,
    };
    const tampered = JSON.parse(JSON.stringify(retriedLedger)) as {
      entries: Array<{ transitions: Array<{ decision: unknown; state: unknown }> }>;
    };
    tampered.entries[0]!.transitions.push({ decision: forgedDecision, state: forgedState });

    expect(() => validateRecoveryLedger(tampered)).toThrow("skip");
  });

  it("tracks multiple fingerprints independently within a hard entry bound", () => {
    const first = evidence("timeout", { artifactHashes: [hashA] });
    const second = evidence("timeout", { artifactHashes: [hashB] });
    const third = evidence("timeout", { graphVersion: "lifecycle-v2" });
    const options = { remaining: { retry: 1, repair: 1, replan: 1 }, sourcePlanVersion: 1 };
    const ledger = registerRecovery(registerRecovery(createRecoveryLedger(2), first, options), second, options);

    expect(ledger.entries.map((entry) => entry.fingerprint)).toEqual(
      [fingerprintFailure(first), fingerprintFailure(second)].sort(),
    );
    expect(resumeRecoveryState(ledger, fingerprintFailure(first)).fingerprint).toBe(fingerprintFailure(first));
    expect(resumeRecoveryState(ledger, fingerprintFailure(second)).fingerprint).toBe(fingerprintFailure(second));
    expect(() => registerRecovery(ledger, third, options)).toThrow("entry limit");
  });
});
