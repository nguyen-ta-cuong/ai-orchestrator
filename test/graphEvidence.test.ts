import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GraphEvidenceError,
  assessLegacyRetirement,
  buildGraphEvidenceReport,
  validateGraphEvidenceEvent,
  type GraphRunEvidenceEvent,
  type GraphStageEvidenceEvent,
} from "../src/core/graphEvidence.js";

function opaqueId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const usage = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: "unknown" as const,
  cacheWriteTokens: "unknown" as const,
};

const cost = { estimatedUsd: 0.04, observedUsd: 0.03 };

const stageEvent: GraphStageEvidenceEvent = {
  schemaVersion: 1,
  type: "stage",
  eventId: opaqueId("base-stage-1"),
  runId: opaqueId("base-run"),
  corpusCaseId: opaqueId("multi-file-case-1"),
  sequence: 1,
  recordedAt: "2026-07-20T00:00:00.000Z",
  engineGroup: "G4",
  taskCategory: "multi-file-feature",
  graphVersion: "1.0.0",
  planVersion: 1,
  stage: "build",
  nodeId: opaqueId("base-node-1"),
  attempt: 1,
  status: "succeeded",
  contractStatus: "passed",
  validatorTypes: ["schema", "tests"],
  readySetWidth: 2,
  retryCount: 0,
  fallbackCount: 0,
  recoveryLevel: "none",
  durationMs: 700,
  usage,
  cost,
  failureLocalizationMs: "unknown",
};

const stageEventTwo: GraphStageEvidenceEvent = {
  ...stageEvent,
  eventId: opaqueId("base-stage-2"),
  sequence: 2,
  recordedAt: "2026-07-20T00:00:00.200Z",
  nodeId: opaqueId("base-node-2"),
  durationMs: 300,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: { estimatedUsd: 0, observedUsd: 0 },
};

const stageEventThree: GraphStageEvidenceEvent = {
  ...stageEventTwo,
  eventId: opaqueId("base-stage-3"),
  sequence: 3,
  recordedAt: "2026-07-20T00:00:00.400Z",
  nodeId: opaqueId("base-node-3"),
  stage: "verify",
  durationMs: 200,
};

const completeStageEvents = [stageEvent, stageEventTwo, stageEventThree] as const;

const runEvent: GraphRunEvidenceEvent = {
  schemaVersion: 1,
  type: "run",
  eventId: opaqueId("base-summary"),
  runId: opaqueId("base-run"),
  corpusCaseId: opaqueId("multi-file-case-1"),
  sequence: 4,
  recordedAt: "2026-07-20T00:00:01.000Z",
  engineGroup: "G4",
  taskCategory: "multi-file-feature",
  graphVersion: "1.0.0",
  planVersion: 1,
  finalStatus: "done",
  traceCompleteness: "complete",
  nodeCount: 3,
  nodeExecutions: 3,
  redundantNodeExecutions: 0,
  maxReadySetWidth: 2,
  validatorTypes: ["schema", "tests"],
  contractChecks: { passed: 3, failed: 0, skipped: 0 },
  retryCount: 0,
  fallbackCount: 0,
  recoveryLevel: "none",
  recoveryAttempts: 0,
  recoverySuccesses: 0,
  buildPasses: 1,
  firstPassVerification: true,
  laterRejection: false,
  humanOverride: false,
  durationMs: 1_000,
  usage,
  cost,
  failureLocalizationMs: "unknown",
  parallelism: {
    mode: "read-only",
    executedConcurrently: true,
    summedNodeDurationMs: 1_200,
    criticalPathDurationMs: 800,
    failedNodeCount: 0,
    skippedNodeCount: 0,
    conflictingNodeCount: 0,
  },
};

function completeLedger(
  label: string,
  runOverrides: Partial<GraphRunEvidenceEvent> = {},
  mutateStages: (stages: GraphStageEvidenceEvent[]) => GraphStageEvidenceEvent[] = (stages) => stages,
): { stages: GraphStageEvidenceEvent[]; run: GraphRunEvidenceEvent } {
  const runId = opaqueId(`${label}-run`);
  const draftRun: GraphRunEvidenceEvent = {
    ...runEvent,
    ...runOverrides,
    eventId: opaqueId(`${label}-summary`),
    runId,
  };
  const mutated = mutateStages(completeStageEvents.map((stage) => ({
    ...stage,
    runId,
    corpusCaseId: draftRun.corpusCaseId,
    engineGroup: draftRun.engineGroup,
    taskCategory: draftRun.taskCategory,
    graphVersion: draftRun.graphVersion,
    planVersion: draftRun.planVersion,
  })));
  const stages = mutated.map((stage, index) => ({
    ...stage,
    eventId: opaqueId(`${label}-stage-${index + 1}`),
    sequence: index + 1,
    recordedAt: `2026-07-20T00:00:00.${String(index * 100).padStart(3, "0")}Z`,
  }));
  const uniqueNodes = new Set(stages.map((stage) => stage.nodeId));
  const validatorOrder = ["structured-tool", "schema", "tests", "typecheck", "lint", "build", "security", "human-gate"] as const;
  const validators = validatorOrder.filter((validator) => stages.some((stage) => stage.validatorTypes.includes(validator)));
  const contractChecks = {
    passed: stages.filter((stage) => stage.contractStatus === "passed").length,
    failed: stages.filter((stage) => stage.contractStatus === "failed").length,
    skipped: stages.filter((stage) => stage.contractStatus === "skipped").length,
  };
  const sumEvidence = (
    select: (stage: GraphStageEvidenceEvent) => number | "unknown",
  ): number | "unknown" => {
    let total = 0;
    for (const stage of stages) {
      const value = select(stage);
      if (value === "unknown") return "unknown";
      total += value;
    }
    return Math.round(total * 100_000_000) / 100_000_000;
  };
  const recoveryOrder = ["none", "retry", "diagnose", "repair", "replan", "pause", "fail"] as const;
  const recoveryLevel = stages.reduce<GraphRunEvidenceEvent["recoveryLevel"]>((highest, stage) => (
    recoveryOrder.indexOf(stage.recoveryLevel) > recoveryOrder.indexOf(highest) ? stage.recoveryLevel : highest
  ), "none");
  const recoveryStages = stages.filter((stage) => stage.recoveryLevel !== "none");
  const firstVerify = stages.find((stage) => stage.stage === "verify");
  let acceptedCheckerSeen = false;
  let laterRejection = false;
  for (const stage of stages) {
    if (stage.stage !== "verify" && stage.stage !== "review" && stage.stage !== "fast-judge") continue;
    const accepted = stage.status === "succeeded" && stage.contractStatus === "passed";
    if (acceptedCheckerSeen && !accepted) laterRejection = true;
    if (accepted) acceptedCheckerSeen = true;
  }

  return {
    stages,
    run: {
      ...draftRun,
      sequence: stages.length + 1,
      recordedAt: "2026-07-20T00:00:01.000Z",
      nodeCount: uniqueNodes.size,
      nodeExecutions: stages.length,
      redundantNodeExecutions: stages.length - uniqueNodes.size,
      maxReadySetWidth: Math.max(...stages.map((stage) => stage.readySetWidth)),
      validatorTypes: validators,
      contractChecks,
      retryCount: stages.reduce((total, stage) => total + stage.retryCount, 0),
      fallbackCount: stages.reduce((total, stage) => total + stage.fallbackCount, 0),
      recoveryLevel,
      recoveryAttempts: recoveryStages.length,
      recoverySuccesses: recoveryStages.filter((stage) => (
        stage.status === "succeeded" && stage.contractStatus === "passed"
      )).length,
      buildPasses: Math.max(0, ...stages.filter((stage) => stage.stage === "build").map((stage) => stage.attempt)),
      firstPassVerification: firstVerify === undefined
        ? "unknown"
        : firstVerify.attempt === 1 && firstVerify.status === "succeeded" && firstVerify.contractStatus === "passed",
      laterRejection,
      usage: {
        inputTokens: sumEvidence((stage) => stage.usage.inputTokens),
        outputTokens: sumEvidence((stage) => stage.usage.outputTokens),
        cacheReadTokens: sumEvidence((stage) => stage.usage.cacheReadTokens),
        cacheWriteTokens: sumEvidence((stage) => stage.usage.cacheWriteTokens),
      },
      cost: {
        estimatedUsd: sumEvidence((stage) => stage.cost.estimatedUsd),
        observedUsd: sumEvidence((stage) => stage.cost.observedUsd),
      },
      parallelism: {
        ...draftRun.parallelism,
        failedNodeCount: stages.filter((stage) => stage.status === "failed").length,
        skippedNodeCount: stages.filter((stage) => stage.status === "skipped").length,
      },
    },
  };
}

function ledgerEvents(ledger: ReturnType<typeof completeLedger>): Array<GraphStageEvidenceEvent | GraphRunEvidenceEvent> {
  return [...ledger.stages, ledger.run];
}

const engineGroups: readonly GraphRunEvidenceEvent["engineGroup"][] = ["G0", "G1", "G2", "G3", "G4", "G5", "G6"];
const taskCategories: readonly GraphRunEvidenceEvent["taskCategory"][] = [
  "small-fix",
  "multi-file-feature",
  "test-failure",
  "refactor",
  "persistence-change",
  "security-sensitive",
  "read-only-analysis",
  "conflicting-writes",
];

function knownCompleteLedger(
  label: string,
  engineGroup: GraphRunEvidenceEvent["engineGroup"],
  taskCategory: GraphRunEvidenceEvent["taskCategory"],
  corpusCaseId: string,
): ReturnType<typeof completeLedger> {
  return completeLedger(label, { engineGroup, taskCategory, corpusCaseId }, (stages) => stages.map((stage) => ({
    ...stage,
    usage: {
      ...stage.usage,
      cacheReadTokens: stage.usage.cacheReadTokens === "unknown" ? 0 : stage.usage.cacheReadTokens,
      cacheWriteTokens: stage.usage.cacheWriteTokens === "unknown" ? 0 : stage.usage.cacheWriteTokens,
    },
  })));
}

function ablationMatrixEvidence(options: {
  groups?: readonly GraphRunEvidenceEvent["engineGroup"][];
  categories?: readonly GraphRunEvidenceEvent["taskCategory"][];
  distinctCases?: boolean;
} = {}): Array<GraphStageEvidenceEvent | GraphRunEvidenceEvent> {
  const groups = options.groups ?? engineGroups;
  const categories = options.categories ?? taskCategories;
  const evidence: Array<GraphStageEvidenceEvent | GraphRunEvidenceEvent> = [];
  for (const engineGroup of groups) {
    for (const taskCategory of categories) {
      for (let index = 0; index < 10; index += 1) {
        const caseIndex = options.distinctCases === false ? 0 : index;
        const corpusCaseId = opaqueId(`matrix-${taskCategory}-case-${caseIndex}`);
        evidence.push(...ledgerEvents(knownCompleteLedger(
          `matrix-${engineGroup}-${taskCategory}-${index}`,
          engineGroup,
          taskCategory,
          corpusCaseId,
        )));
      }
    }
  }
  return evidence;
}

describe("graph execution evidence", () => {
  it("accepts closed privacy-minimal stage and run events", () => {
    expect(validateGraphEvidenceEvent(stageEvent)).toEqual({ ok: true, event: stageEvent });
    expect(validateGraphEvidenceEvent(runEvent)).toEqual({ ok: true, event: runEvent });

    const mutable = structuredClone(stageEvent);
    const validation = validateGraphEvidenceEvent(mutable);
    mutable.nodeId = "mutated-after-validation";
    expect(validation.ok && validation.event.type === "stage" ? validation.event.nodeId : undefined)
      .toBe(stageEvent.nodeId);
  });

  it.each([
    [{ ...stageEvent, prompt: "SECRET-MARKER" }, "unexpected-field"],
    [{ ...stageEvent, error: "SECRET-MARKER" }, "unexpected-field"],
    [{ ...stageEvent, nodeId: "/private/user/repository/file.ts" }, "invalid-token"],
    [{ ...stageEvent, validatorTypes: ["tests", "model-prose"] }, "invalid-enum"],
    [{ ...stageEvent, durationMs: Number.POSITIVE_INFINITY }, "invalid-number"],
    [{ ...runEvent, parallelism: { ...runEvent.parallelism, rawDiff: "SECRET-MARKER" } }, "unexpected-field"],
    [{ ...runEvent, recoverySuccesses: 2, recoveryAttempts: 1 }, "inconsistent-metrics"],
    [{ ...runEvent, redundantNodeExecutions: 4, nodeExecutions: 3 }, "inconsistent-metrics"],
  ] as const)("rejects sensitive, open-ended, or inconsistent evidence %#", (event, error) => {
    expect(validateGraphEvidenceEvent(event)).toEqual({ ok: false, error });
  });

  it("rejects hostile array prototypes instead of validating through overridden iteration", () => {
    class HostileValidators extends Array<string> {
      override *[Symbol.iterator](): ArrayIterator<string> {
        yield "tests";
      }
    }
    const validators = new HostileValidators("SECRET-MARKER");
    const validation = validateGraphEvidenceEvent({ ...stageEvent, validatorTypes: validators });

    expect(validation.ok).toBe(false);
    expect(JSON.stringify(validation)).not.toContain("SECRET-MARKER");
  });

  it("validates the report event container before invoking any instance method", () => {
    const hostile = [runEvent] as unknown[] & { map: () => unknown[] };
    hostile.map = () => [{
      ...runEvent,
      graphVersion: "SECRET MARKER /private/path",
      recordedAt: "not-a-time",
    }];

    expect(() => buildGraphEvidenceReport(hostile)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }),
    );
  });

  it("aggregates deterministic observed-only cohort metrics and preserves unknowns", () => {
    const failed: GraphRunEvidenceEvent = {
      ...runEvent,
      eventId: opaqueId("failed-summary"),
      runId: opaqueId("failed-run"),
      sequence: 1,
      engineGroup: "G0",
      finalStatus: "failed",
      traceCompleteness: "partial",
      contractChecks: { passed: 1, failed: 1, skipped: 1 },
      retryCount: 2,
      recoveryLevel: "repair",
      recoveryAttempts: 1,
      recoverySuccesses: 0,
      buildPasses: 2,
      firstPassVerification: false,
      laterRejection: true,
      durationMs: 2_000,
      usage: { ...usage, inputTokens: "unknown" },
      cost: { estimatedUsd: "unknown", observedUsd: "unknown" },
      parallelism: {
        mode: "none",
        executedConcurrently: false,
        summedNodeDurationMs: "unknown",
        criticalPathDurationMs: "unknown",
        failedNodeCount: 1,
        skippedNodeCount: 1,
        conflictingNodeCount: 0,
      },
    };

    const evidence = [...completeStageEvents, runEvent, failed];
    const report = buildGraphEvidenceReport(evidence, { minimumCohortRuns: 10 });
    const reversed = buildGraphEvidenceReport([...evidence].reverse(), { minimumCohortRuns: 10 });

    expect(report).toEqual(reversed);
    expect(report).toMatchObject({
      schemaVersion: 1,
      qualityClaim: "observed-executions-only",
      rolloutDecisionEligible: false,
      eventCount: 5,
      stageEventCount: 3,
      runCount: 2,
      totals: {
        runCount: 2,
        successCount: 1,
        successRateBasisPoints: "unknown",
        contractChecks: { passed: 4, failed: 1, skipped: 1, satisfactionRateBasisPoints: "unknown" },
        wallTimeMs: { total: 3_000, knownSamples: 2, unknownSamples: 0 },
        inputTokens: { total: 1_000, knownSamples: 1, unknownSamples: 1 },
        observedCostUsd: { total: 0.03, knownSamples: 1, unknownSamples: 1 },
        redundantNodeExecutions: 0,
        firstPassVerification: { successes: 1, knownSamples: 2, rateBasisPoints: "unknown" },
        recovery: { successes: 0, attempts: 1, successRateBasisPoints: "unknown" },
        graphVersions: { "1.0.0": 2 },
        planVersions: { "1": 2 },
        recoveryLevels: { none: 1, retry: 0, diagnose: 0, repair: 1, replan: 0, pause: 0, fail: 0 },
        traceStatuses: { complete: 1, partial: 1, missing: 0 },
        failureLoopRuns: 1,
        failureLoopRateBasisPoints: "unknown",
        completeTraceRuns: 1,
        completeTraceRateBasisPoints: 5_000,
        usefulParallelism: { usefulRuns: 1, eligibleRuns: 1, observedCriticalPathSavingsMs: 400 },
      },
    });
    expect(report.cohorts.map(({ engineGroup }) => engineGroup)).toEqual(["G0", "G4"]);
    expect(report.limitations).toContain("insufficient-cohort-samples");
    expect(JSON.stringify(report)).not.toContain("SECRET-MARKER");
  });

  it("states that an empty corpus is insufficient instead of implying a rollout decision", () => {
    const report = buildGraphEvidenceReport([]);

    expect(report.runCount).toBe(0);
    expect(report.totals.successRateBasisPoints).toBe("unknown");
    expect(report.limitations).toEqual([
      "no-counterfactual-quality-claim",
      "paid-provider-evidence-not-attested",
      "insufficient-cohort-samples",
      "incomplete-engine-group-coverage",
      "incomplete-task-category-coverage",
      "incomplete-ablation-matrix",
      "insufficient-distinct-corpus-cases",
    ]);
    expect(() => buildGraphEvidenceReport([], { minimumCohortRuns: 9 })).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-report-options" }),
    );
  });

  it("does not count speculative or wasteful overlap as useful parallelism", () => {
    const cases = [
      completeLedger("not-concurrent", {
        parallelism: { ...runEvent.parallelism, executedConcurrently: false },
      }),
      completeLedger("failed-node", {}, (stages) => [
        { ...stages[0]!, status: "failed" },
        ...stages.slice(1),
      ]),
      completeLedger("skipped-node", {}, (stages) => [
        stages[0]!,
        { ...stages[1]!, status: "skipped" },
        ...stages.slice(2),
      ]),
      completeLedger("conflicting-node", {
        parallelism: { ...runEvent.parallelism, conflictingNodeCount: 1 },
      }),
      completeLedger("redundant-node", {}, (stages) => [
        ...stages,
        {
          ...stages[0]!,
          attempt: 2,
          retryCount: 1,
          recoveryLevel: "retry",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
      ]),
      completeLedger("no-savings", {
        parallelism: { ...runEvent.parallelism, criticalPathDurationMs: 1_200 },
      }),
      completeLedger("failed-run", { finalStatus: "failed" }),
      completeLedger("failed-contract", {}, (stages) => [
        { ...stages[0]!, contractStatus: "failed" },
        ...stages.slice(1),
      ]),
      completeLedger("skipped-contract", {}, (stages) => [
        { ...stages[0]!, contractStatus: "skipped" },
        ...stages.slice(1),
      ]),
    ];

    for (const ledger of cases) {
      expect(buildGraphEvidenceReport(ledgerEvents(ledger)).totals.usefulParallelism.usefulRuns).toBe(0);
    }
    expect(buildGraphEvidenceReport(ledgerEvents(completeLedger("useful"))).totals.usefulParallelism).toEqual({
      eligibleRuns: 1,
      usefulRuns: 1,
      observedCriticalPathSavingsMs: 400,
    });
  });

  it("rejects a claimed complete trace when no stage evidence exists", () => {
    expect(() => buildGraphEvidenceReport([{
      ...runEvent,
      sequence: 1,
      traceCompleteness: "complete",
    }])).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }));
  });

  it.each([
    () => {
      const ledger = completeLedger("sequence-gap");
      ledger.stages[1] = { ...ledger.stages[1]!, sequence: 3 };
      ledger.stages[2] = { ...ledger.stages[2]!, sequence: 4 };
      ledger.run = { ...ledger.run, sequence: 5 };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("time-regression");
      ledger.stages[1] = { ...ledger.stages[1]!, recordedAt: "2026-07-19T23:59:59.000Z" };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("duplicate-attempt");
      ledger.stages[1] = {
        ...ledger.stages[1]!,
        nodeId: ledger.stages[0]!.nodeId,
        attempt: ledger.stages[0]!.attempt,
      };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-count");
      ledger.run = { ...ledger.run, nodeExecutions: ledger.run.nodeExecutions + 1 };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-usage");
      ledger.run = { ...ledger.run, usage: { ...ledger.run.usage, inputTokens: 999_999 } };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-contracts");
      ledger.run = { ...ledger.run, contractChecks: { passed: 2, failed: 1, skipped: 0 } };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-recovery");
      ledger.run = { ...ledger.run, recoveryAttempts: 1, recoverySuccesses: 1 };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-first-pass");
      ledger.run = { ...ledger.run, firstPassVerification: false };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-later-rejection");
      ledger.run = { ...ledger.run, laterRejection: true };
      return ledgerEvents(ledger);
    },
  ])("replays complete traces and rejects forged summaries %#", (makeEvidence) => {
    expect(() => buildGraphEvidenceReport(makeEvidence())).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("rejects sparse, decorated, or subclassed event containers", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = runEvent;
    expect(() => buildGraphEvidenceReport(sparse)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }),
    );

    const decorated = [...completeStageEvents, runEvent] as Array<unknown> & { source?: string };
    decorated.source = "untrusted";
    expect(() => buildGraphEvidenceReport(decorated)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }),
    );

    class EvidenceArray extends Array<unknown> {}
    expect(() => buildGraphEvidenceReport(new EvidenceArray(runEvent))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }),
    );
  });

  it.each([
    { ...stageEvent, eventId: "meaningful-event-name" },
    { ...stageEvent, runId: "run_opaque_01" },
    { ...stageEvent, corpusCaseId: "customer-repository" },
    { ...stageEvent, nodeId: "implement-api" },
    { ...stageEvent, graphVersion: "lifecycle-1.0.0" },
    { ...stageEvent, graphVersion: "01.0.0" },
  ])("accepts only opaque IDs and strict semantic graph versions %#", (event) => {
    expect(validateGraphEvidenceEvent(event)).toEqual({ ok: false, error: "invalid-token" });
  });

  it("requires integer token and duration evidence", () => {
    expect(validateGraphEvidenceEvent({
      ...stageEvent,
      usage: { ...stageEvent.usage, inputTokens: 1.5 },
    })).toEqual({ ok: false, error: "invalid-number" });
    expect(validateGraphEvidenceEvent({ ...stageEvent, durationMs: 1.5 }))
      .toEqual({ ok: false, error: "invalid-number" });
    expect(validateGraphEvidenceEvent({
      ...stageEvent,
      cost: { ...stageEvent.cost, observedUsd: 0.000000001 },
    })).toEqual({ ok: false, error: "invalid-number" });
  });

  it("fails closed before bounded evidence totals lose integer precision", () => {
    const summaries: GraphRunEvidenceEvent[] = [];
    for (let index = 0; index < 9_008; index += 1) {
      summaries.push({
        ...runEvent,
        eventId: opaqueId(`overflow-event-${index}`),
        runId: opaqueId(`overflow-run-${index}`),
        sequence: 1,
        traceCompleteness: "partial",
        usage: { ...runEvent.usage, inputTokens: 1_000_000_000_000 },
      });
    }

    expect(() => buildGraphEvidenceReport(summaries)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "aggregate-overflow" }),
    );
  });

  it("orders opaque report keys by deterministic code units", () => {
    const upper = {
      ...runEvent,
      eventId: opaqueId("version-upper-event"),
      runId: opaqueId("version-upper-run"),
      sequence: 1,
      traceCompleteness: "partial" as const,
      graphVersion: "1.0.0+A",
    };
    const lower = {
      ...runEvent,
      eventId: opaqueId("version-lower-event"),
      runId: opaqueId("version-lower-run"),
      sequence: 1,
      traceCompleteness: "partial" as const,
      graphVersion: "1.0.0+a",
    };

    expect(Object.keys(buildGraphEvidenceReport([lower, upper]).totals.graphVersions))
      .toEqual(["1.0.0+A", "1.0.0+a"]);
  });

  it("keeps rollout rates unknown when any run summary or trace is incomplete", () => {
    const incompleteStage = {
      ...stageEvent,
      eventId: opaqueId("incomplete-stage"),
      runId: opaqueId("incomplete-run"),
    };
    const complete = completeLedger("complete-with-incomplete-peer");
    const report = buildGraphEvidenceReport([...ledgerEvents(complete), incompleteStage]);

    expect(report.totals.successRateBasisPoints).toBe("unknown");
    expect(report.totals.contractChecks.satisfactionRateBasisPoints).toBe("unknown");
    expect(report.totals.firstPassVerification.rateBasisPoints).toBe("unknown");
    expect(report.limitations).toContain("incomplete-run-summaries");
    expect(report.rolloutDecisionEligible).toBe(false);
  });

  it("requires same-corpus complete G0 baselines before a cohort can be sufficient", () => {
    const baselineLedgers: ReturnType<typeof completeLedger>[] = [];
    const graphLedgers: ReturnType<typeof completeLedger>[] = [];
    for (let index = 0; index < 10; index += 1) {
      const corpusCaseId = opaqueId(`paired-corpus-case-${index}`);
      baselineLedgers.push(knownCompleteLedger(
        `paired-baseline-${index}`,
        "G0",
        "multi-file-feature",
        corpusCaseId,
      ));
      graphLedgers.push(knownCompleteLedger(
        `paired-graph-${index}`,
        "G4",
        "multi-file-feature",
        corpusCaseId,
      ));
    }
    const pairedEvidence = [...baselineLedgers, ...graphLedgers].flatMap(ledgerEvents);
    const paired = buildGraphEvidenceReport(pairedEvidence, { minimumCohortRuns: 10 });

    expect(paired.limitations).toContain("incomplete-ablation-matrix");
    expect(paired.limitations).not.toContain("unpaired-baseline-corpus");
    expect(paired.rolloutDecisionEligible).toBe(false);

    const duplicateCorpus = knownCompleteLedger(
      "unpaired-graph",
      "G4",
      "multi-file-feature",
      baselineLedgers[0]!.run.corpusCaseId,
    );
    const unpairedEvidence = [
      ...baselineLedgers,
      ...graphLedgers.slice(0, 9),
      duplicateCorpus,
    ].flatMap(ledgerEvents);
    const unpaired = buildGraphEvidenceReport(unpairedEvidence, { minimumCohortRuns: 10 });
    expect(unpaired.limitations).toContain("unpaired-baseline-corpus");
    expect(unpaired.rolloutDecisionEligible).toBe(false);
  });

  it("requires the full G0-G6 by representative-category matrix with distinct corpus cases", () => {
    const fullEvidence = ablationMatrixEvidence();
    const complete = buildGraphEvidenceReport(fullEvidence);
    expect(complete.rolloutDecisionEligible).toBe(true);

    const missingGroup = buildGraphEvidenceReport(
      fullEvidence.filter((event) => event.engineGroup !== "G6"),
    );
    expect(missingGroup.rolloutDecisionEligible).toBe(false);
    expect(missingGroup.limitations).toContain("incomplete-engine-group-coverage");
    expect(missingGroup.limitations).toContain("incomplete-ablation-matrix");

    const missingCategory = buildGraphEvidenceReport(
      fullEvidence.filter((event) => event.taskCategory !== "security-sensitive"),
    );
    expect(missingCategory.rolloutDecisionEligible).toBe(false);
    expect(missingCategory.limitations).toContain("incomplete-task-category-coverage");
    expect(missingCategory.limitations).toContain("incomplete-ablation-matrix");

    const repeatedCases = buildGraphEvidenceReport(ablationMatrixEvidence({ distinctCases: false }));
    expect(repeatedCases.rolloutDecisionEligible).toBe(false);
    expect(repeatedCases.limitations).toContain("insufficient-distinct-corpus-cases");
  });

  it("fails closed on malformed ledgers and ambiguous run summaries", () => {
    expect(() => buildGraphEvidenceReport([{ ...runEvent, rawSource: "SECRET" }]))
      .toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }));
    expect(() => buildGraphEvidenceReport([runEvent, { ...runEvent }]))
      .toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "duplicate-event-id" }));
    expect(() => buildGraphEvidenceReport([
      ...completeStageEvents,
      runEvent,
      { ...runEvent, eventId: opaqueId("other-summary"), sequence: 5 },
    ])).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "duplicate-run-summary" }));
    expect(() => buildGraphEvidenceReport([
      ...completeStageEvents,
      runEvent,
      {
        ...stageEvent,
        eventId: opaqueId("late-stage"),
        nodeId: opaqueId("late-node"),
        sequence: 5,
        recordedAt: "2026-07-20T00:00:02.000Z",
      },
    ])).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "run-summary-not-terminal" }));
    expect(validateGraphEvidenceEvent(Object.assign(Object.create({ prompt: "SECRET" }), runEvent)))
      .toEqual({ ok: false, error: "not-object" });
    const accessor = { ...runEvent } as GraphRunEvidenceEvent;
    Object.defineProperty(accessor, "runId", { enumerable: true, get: () => opaqueId("base-run") });
    expect(validateGraphEvidenceEvent(accessor)).toEqual({ ok: false, error: "not-object" });
    const hidden = { ...runEvent };
    Object.defineProperty(hidden, "rawPrompt", { value: "SECRET", enumerable: false });
    expect(validateGraphEvidenceEvent(hidden)).toEqual({ ok: false, error: "unexpected-field" });
    expect(validateGraphEvidenceEvent(Object.assign({ ...runEvent }, { [Symbol("secret")]: "SECRET" })))
      .toEqual({ ok: false, error: "unexpected-field" });
  });

  it("keeps legacy retirement ineligible without trusted release-bound artifact evidence", () => {
    expect(assessLegacyRetirement({
      releasedCompatibilityWindows: 0,
    })).toEqual({
      eligible: false,
      missing: [
        "released-compatibility-window",
        "trusted-release-evidence",
        "decision-ready-rollout-report",
        "graph-coverage",
        "clean-rollback",
        "config-migration",
      ],
    });

    expect(assessLegacyRetirement({
      releasedCompatibilityWindows: 0,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: "1.1.0",
        artifactDigest: opaqueId("rollout-report"),
        decision: "enable-sequential-graph",
      },
      graphCoverage: { releaseVersion: "1.1.0", artifactDigest: opaqueId("coverage") },
      cleanRollback: { releaseVersion: "1.1.0", artifactDigest: opaqueId("rollback") },
      configMigration: { releaseVersion: "1.1.0", artifactDigest: opaqueId("migration") },
    })).toEqual({ eligible: false, missing: ["released-compatibility-window"] });

    expect(assessLegacyRetirement({
      releasedCompatibilityWindows: 1,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: "1.1.0",
        artifactDigest: opaqueId("bound-rollout-report"),
        decision: "enable-sequential-graph",
      },
      graphCoverage: { releaseVersion: "1.1.0", artifactDigest: opaqueId("bound-coverage") },
      cleanRollback: { releaseVersion: "1.2.0", artifactDigest: opaqueId("mismatched-rollback") },
      configMigration: { releaseVersion: "1.1.0", artifactDigest: opaqueId("bound-migration") },
    })).toEqual({ eligible: false, missing: ["consistent-release-binding"] });

    expect(() => assessLegacyRetirement({
      releasedCompatibilityWindows: 0,
      claimedEvidence: "trust me",
    } as never)).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-retirement-evidence" }));

    expect(() => assessLegacyRetirement({
      releasedCompatibilityWindows: 0,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: "release-1",
        artifactDigest: "not-a-digest",
        decision: "enable-sequential-graph",
      },
    })).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-retirement-evidence" }));
  });
});
