import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRAPH_ENGINE_FEATURES,
  GraphEvidenceError,
  assessLegacyRetirement,
  buildGraphEvidenceReport,
  createGraphExperimentManifest,
  graphDisjointnessReceiptDigest,
  graphPlanActivationDigest,
  graphSchedulerReceiptDigest,
  graphWorktreeReceiptDigest,
  validateGraphEvidenceEvent,
  validateGraphExperimentManifest,
  type GraphExperimentManifest,
  type GraphRunEvidenceEvent,
  type GraphStageEvidenceEvent,
} from "../src/core/graphEvidence.js";

function opaqueId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const validatorOrder = ["structured-tool", "schema", "tests", "typecheck", "lint", "build", "security", "human-gate"] as const;

function validatorsForCategory(
  taskCategory: GraphRunEvidenceEvent["taskCategory"],
  existing: readonly (typeof validatorOrder)[number][],
): Array<(typeof validatorOrder)[number]> {
  const required: readonly (typeof validatorOrder)[number][] = taskCategory === "security-sensitive"
    ? ["tests", "security"]
    : taskCategory === "read-only-analysis"
      ? ["structured-tool"]
      : ["tests"];
  return validatorOrder.filter((validator) => existing.includes(validator) || required.includes(validator));
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
  experimentId: opaqueId("base-experiment"),
  corpusSnapshotDigest: opaqueId("multi-file-case-1-snapshot"),
  engineConfigurationDigest: opaqueId("G6-configuration"),
  sequence: 1,
  recordedAt: "2026-07-20T00:00:00.000Z",
  engineGroup: "G6",
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

const stageEventFour: GraphStageEvidenceEvent = {
  ...stageEventThree,
  eventId: opaqueId("base-stage-4"),
  sequence: 4,
  recordedAt: "2026-07-20T00:00:00.600Z",
  nodeId: opaqueId("base-node-4"),
  stage: "ship",
  durationMs: 0,
};

const defineStageEvent: GraphStageEvidenceEvent = {
  ...stageEvent,
  eventId: opaqueId("base-stage-define"),
  sequence: 1,
  recordedAt: "2026-07-20T00:00:00.000Z",
  stage: "define",
  nodeId: opaqueId("base-node-define"),
  durationMs: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: { estimatedUsd: 0, observedUsd: 0 },
};

const planStageEvent: GraphStageEvidenceEvent = {
  ...defineStageEvent,
  eventId: opaqueId("base-stage-plan"),
  sequence: 2,
  recordedAt: "2026-07-20T00:00:00.100Z",
  stage: "plan",
  nodeId: opaqueId("base-node-plan"),
};

const reviewStageEvent: GraphStageEvidenceEvent = {
  ...stageEventThree,
  eventId: opaqueId("base-stage-review"),
  sequence: 6,
  recordedAt: "2026-07-20T00:00:00.500Z",
  stage: "review",
  nodeId: opaqueId("base-node-review"),
  durationMs: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: { estimatedUsd: 0, observedUsd: 0 },
};

const rawCompleteStageEvents: GraphStageEvidenceEvent[] = [
  defineStageEvent,
  planStageEvent,
  { ...stageEvent, sequence: 3, recordedAt: "2026-07-20T00:00:00.200Z" },
  { ...stageEventTwo, sequence: 4, recordedAt: "2026-07-20T00:00:00.300Z" },
  { ...stageEventThree, sequence: 5, recordedAt: "2026-07-20T00:00:00.400Z" },
  reviewStageEvent,
  { ...stageEventFour, sequence: 7, recordedAt: "2026-07-20T00:00:00.600Z" },
] as const;

function scheduleStages(
  label: string,
  source: readonly GraphStageEvidenceEvent[],
  mode: GraphRunEvidenceEvent["parallelism"]["mode"],
): { stages: GraphStageEvidenceEvent[]; criticalPathDurationMs: number } {
  const origin = Date.parse("2026-07-20T00:00:00.000Z");
  const intervals: Array<{ start: number; end: number }> = [];
  let cursor = origin;
  let index = 0;
  const parallelCandidate = (stage: GraphStageEvidenceEvent): boolean => mode === "isolated-writes"
    ? stage.stage === "build" || stage.stage === "integrate"
    : mode === "read-only" && stage.stage !== "build" && stage.stage !== "integrate";

  while (index < source.length) {
    const stage = source[index]!;
    if (mode !== "none" && parallelCandidate(stage) && stage.readySetWidth >= 2) {
      let endIndex = index + 1;
      while (endIndex < source.length
        && parallelCandidate(source[endIndex]!)
        && source[endIndex]!.readySetWidth >= 2) endIndex += 1;
      const group = source.slice(index, endIndex);
      if (group.length >= 2) {
        let maximum = 0;
        for (const candidate of group) {
          if (typeof candidate.durationMs !== "number") throw new Error("Complete fixture stages need numeric duration");
          intervals.push({ start: cursor, end: cursor + candidate.durationMs });
          maximum = Math.max(maximum, candidate.durationMs);
        }
        cursor += maximum;
        index = endIndex;
        continue;
      }
    }
    if (typeof stage.durationMs !== "number") throw new Error("Complete fixture stages need numeric duration");
    intervals.push({ start: cursor, end: cursor + stage.durationMs });
    cursor += stage.durationMs;
    index += 1;
  }

  let lastRecordedAt = origin;
  let stages = source.map((stage, stageIndex) => {
    const interval = intervals[stageIndex]!;
    lastRecordedAt = Math.max(lastRecordedAt, interval.end);
    const isolatedMutation = mode === "isolated-writes"
      && (stage.stage === "build" || stage.stage === "integrate");
    const baseRevisionDigest = isolatedMutation ? opaqueId(`${label}-base-revision`) : undefined;
    const writeSetDigest = isolatedMutation ? opaqueId(`${label}-write-set-${stageIndex}`) : undefined;
    const identity = {
      runId: stage.runId,
      corpusCaseId: stage.corpusCaseId,
      corpusSnapshotDigest: stage.corpusSnapshotDigest,
      eventId: stage.eventId,
      nodeId: stage.nodeId,
      sequence: stage.sequence,
      attempt: stage.attempt,
      stage: stage.stage,
      startedAt: new Date(interval.start).toISOString(),
      completedAt: new Date(interval.end).toISOString(),
      ...(baseRevisionDigest === undefined ? {} : { baseRevisionDigest }),
      ...(writeSetDigest === undefined ? {} : { writeSetDigest }),
    };
    const worktreeReceiptDigest = isolatedMutation
      ? graphWorktreeReceiptDigest(identity)
      : undefined;
    const schedulerReceiptDigest = graphSchedulerReceiptDigest({
      ...identity,
      ...(worktreeReceiptDigest === undefined ? {} : { worktreeReceiptDigest }),
    });
    return {
      ...stage,
      recordedAt: new Date(lastRecordedAt).toISOString(),
      executionWindow: {
        startedAt: identity.startedAt,
        completedAt: identity.completedAt,
        schedulerReceiptDigest,
        ...(isolatedMutation ? {
          worktreeReceiptDigest,
          baseRevisionDigest,
          writeSetDigest,
          disjointnessReceiptDigest: opaqueId(`${label}-pending-disjointness-receipt`),
        } : {}),
      },
    };
  });
  const isolatedStages = stages.filter((stage) => stage.executionWindow.worktreeReceiptDigest !== undefined);
  if (isolatedStages.length > 0) {
    const first = isolatedStages[0]!;
    const disjointnessReceiptDigest = graphDisjointnessReceiptDigest({
      runId: first.runId,
      corpusCaseId: first.corpusCaseId,
      corpusSnapshotDigest: first.corpusSnapshotDigest,
      baseRevisionDigest: first.executionWindow.baseRevisionDigest!,
      executions: isolatedStages.map((stage) => ({
        runId: stage.runId,
        corpusCaseId: stage.corpusCaseId,
        corpusSnapshotDigest: stage.corpusSnapshotDigest,
        eventId: stage.eventId,
        nodeId: stage.nodeId,
        sequence: stage.sequence,
        attempt: stage.attempt,
        stage: stage.stage,
        startedAt: stage.executionWindow.startedAt,
        completedAt: stage.executionWindow.completedAt,
        baseRevisionDigest: stage.executionWindow.baseRevisionDigest!,
        writeSetDigest: stage.executionWindow.writeSetDigest!,
        worktreeReceiptDigest: stage.executionWindow.worktreeReceiptDigest!,
        schedulerReceiptDigest: stage.executionWindow.schedulerReceiptDigest,
      })),
    });
    stages = stages.map((stage) => stage.executionWindow.worktreeReceiptDigest === undefined
      ? stage
      : {
        ...stage,
        executionWindow: { ...stage.executionWindow, disjointnessReceiptDigest },
      });
  }
  return { stages, criticalPathDurationMs: cursor - origin };
}

function rebindExecutionReceipts(
  source: readonly GraphStageEvidenceEvent[],
): GraphStageEvidenceEvent[] {
  let stages = source.map((stage): GraphStageEvidenceEvent => {
    const window = stage.executionWindow;
    if (window === undefined) return stage;
    const isolated = window.baseRevisionDigest !== undefined;
    const identity = {
      runId: stage.runId,
      corpusCaseId: stage.corpusCaseId,
      corpusSnapshotDigest: stage.corpusSnapshotDigest,
      eventId: stage.eventId,
      nodeId: stage.nodeId,
      sequence: stage.sequence,
      attempt: stage.attempt,
      stage: stage.stage,
      startedAt: window.startedAt,
      completedAt: window.completedAt,
      ...(window.baseRevisionDigest === undefined ? {} : { baseRevisionDigest: window.baseRevisionDigest }),
      ...(window.writeSetDigest === undefined ? {} : { writeSetDigest: window.writeSetDigest }),
    };
    const worktreeReceiptDigest = isolated ? graphWorktreeReceiptDigest(identity) : undefined;
    const schedulerReceiptDigest = graphSchedulerReceiptDigest({
      ...identity,
      ...(worktreeReceiptDigest === undefined ? {} : { worktreeReceiptDigest }),
    });
    return {
      ...stage,
      executionWindow: {
        ...window,
        schedulerReceiptDigest,
        ...(worktreeReceiptDigest === undefined ? {} : { worktreeReceiptDigest }),
      },
    };
  });
  const isolatedStages = stages.filter((stage) => stage.executionWindow?.worktreeReceiptDigest !== undefined);
  if (isolatedStages.length === 0) return stages;
  const first = isolatedStages[0]!;
  const disjointnessReceiptDigest = graphDisjointnessReceiptDigest({
    runId: first.runId,
    corpusCaseId: first.corpusCaseId,
    corpusSnapshotDigest: first.corpusSnapshotDigest,
    baseRevisionDigest: first.executionWindow!.baseRevisionDigest!,
    executions: isolatedStages.map((stage) => ({
      runId: stage.runId,
      corpusCaseId: stage.corpusCaseId,
      corpusSnapshotDigest: stage.corpusSnapshotDigest,
      eventId: stage.eventId,
      nodeId: stage.nodeId,
      sequence: stage.sequence,
      attempt: stage.attempt,
      stage: stage.stage,
      startedAt: stage.executionWindow!.startedAt,
      completedAt: stage.executionWindow!.completedAt,
      baseRevisionDigest: stage.executionWindow!.baseRevisionDigest!,
      writeSetDigest: stage.executionWindow!.writeSetDigest!,
      worktreeReceiptDigest: stage.executionWindow!.worktreeReceiptDigest!,
      schedulerReceiptDigest: stage.executionWindow!.schedulerReceiptDigest,
    })),
  });
  stages = stages.map((stage) => stage.executionWindow?.worktreeReceiptDigest === undefined
    ? stage
    : {
      ...stage,
      executionWindow: { ...stage.executionWindow, disjointnessReceiptDigest },
    });
  return stages;
}

const completeStageEvents = scheduleStages(
  "base",
  rawCompleteStageEvents,
  "isolated-writes",
).stages;

const runEvent: GraphRunEvidenceEvent = {
  schemaVersion: 1,
  type: "run",
  eventId: opaqueId("base-summary"),
  runId: opaqueId("base-run"),
  corpusCaseId: opaqueId("multi-file-case-1"),
  experimentId: opaqueId("base-experiment"),
  corpusSnapshotDigest: opaqueId("multi-file-case-1-snapshot"),
  engineConfigurationDigest: opaqueId("G6-configuration"),
  sequence: 8,
  recordedAt: "2026-07-20T00:00:01.000Z",
  engineGroup: "G6",
  taskCategory: "multi-file-feature",
  graphVersion: "1.0.0",
  planVersion: 1,
  finalStatus: "done",
  traceCompleteness: "complete",
  nodeCount: 7,
  nodeExecutions: 7,
  redundantNodeExecutions: 0,
  maxReadySetWidth: 2,
  validatorTypes: ["schema", "tests"],
  contractChecks: { passed: 7, failed: 0, skipped: 0 },
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
    mode: "isolated-writes",
    executedConcurrently: true,
    summedNodeDurationMs: 1_200,
    criticalPathDurationMs: 900,
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
  const mutated = mutateStages(rawCompleteStageEvents.map((stage) => ({
    ...stage,
    runId,
    corpusCaseId: draftRun.corpusCaseId,
    experimentId: draftRun.experimentId,
    corpusSnapshotDigest: draftRun.corpusSnapshotDigest,
    engineConfigurationDigest: draftRun.engineConfigurationDigest,
    engineGroup: draftRun.engineGroup,
    taskCategory: draftRun.taskCategory,
    graphVersion: draftRun.graphVersion,
    planVersion: draftRun.planVersion,
  })));
  const sequenced = mutated.map((stage, index) => ({
    ...stage,
    eventId: opaqueId(`${label}-stage-${index + 1}`),
    runId,
    corpusCaseId: draftRun.corpusCaseId,
    experimentId: draftRun.experimentId,
    corpusSnapshotDigest: draftRun.corpusSnapshotDigest,
    engineConfigurationDigest: draftRun.engineConfigurationDigest,
    engineGroup: draftRun.engineGroup,
    taskCategory: draftRun.taskCategory,
    graphVersion: draftRun.graphVersion,
    sequence: index + 1,
  }));
  let activePlanActivationDigest: string | undefined;
  const activated = sequenced.map((stage) => {
    if (stage.planTransition !== undefined) {
      activePlanActivationDigest = graphPlanActivationDigest({
        runId: stage.runId,
        corpusCaseId: stage.corpusCaseId,
        corpusSnapshotDigest: stage.corpusSnapshotDigest,
        eventId: stage.eventId,
        nodeId: stage.nodeId,
        sequence: stage.sequence,
        transition: stage.planTransition,
      });
    }
    return activePlanActivationDigest === undefined
      ? stage
      : { ...stage, planActivationDigest: activePlanActivationDigest };
  });
  const scheduled = scheduleStages(
    label,
    activated,
    draftRun.parallelism.executedConcurrently ? draftRun.parallelism.mode : "none",
  );
  const stages = scheduled.stages;
  const uniqueNodes = new Set(stages.map((stage) => stage.nodeId));
  const validators = validatorOrder.filter((validator) => stages.some((stage) => (
    stage.status === "succeeded"
      && stage.contractStatus === "passed"
      && stage.validatorTypes.includes(validator)
  )));
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
  const firstPassStage = draftRun.engineGroup === "G0" || draftRun.engineGroup === "G1"
    ? "fast-judge"
    : "verify";
  const firstVerify = stages.find((stage) => stage.stage === firstPassStage);
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
      recordedAt: new Date(Math.max(...stages.map((stage) => Date.parse(stage.recordedAt))) + 100).toISOString(),
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
      durationMs: typeof draftRun.durationMs === "number"
        ? Math.max(draftRun.durationMs, scheduled.criticalPathDurationMs)
        : draftRun.durationMs,
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
        mode: draftRun.parallelism.executedConcurrently ? draftRun.parallelism.mode : "none",
        summedNodeDurationMs: sumEvidence((stage) => stage.durationMs),
        criticalPathDurationMs: scheduled.criticalPathDurationMs,
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

const matrixManifest: GraphExperimentManifest = createGraphExperimentManifest({
  schemaVersion: 1,
  releaseVersion: "1.0.0",
  engines: engineGroups.map((engineGroup) => ({
    engineGroup,
    graphVersion: "1.0.0",
    configurationDigest: opaqueId(`matrix-${engineGroup}-configuration`),
    features: GRAPH_ENGINE_FEATURES[engineGroup],
  })),
  cases: taskCategories.flatMap((taskCategory) => Array.from({ length: 10 }, (_, index) => ({
    corpusCaseId: opaqueId(`matrix-${taskCategory}-case-${index}`),
    taskCategory,
    snapshotDigest: opaqueId(`matrix-${taskCategory}-case-${index}-snapshot`),
  }))),
});

const matrixEngines = new Map(matrixManifest.engines.map((engine) => [engine.engineGroup, engine]));
const matrixCases = new Map(matrixManifest.cases.map((item) => [item.corpusCaseId, item]));

function knownCompleteLedger(
  label: string,
  engineGroup: GraphRunEvidenceEvent["engineGroup"],
  taskCategory: GraphRunEvidenceEvent["taskCategory"],
  corpusCaseId: string,
  exerciseRecovery = false,
  executeG6Concurrently = true,
): ReturnType<typeof completeLedger> {
  const parallelism: GraphRunEvidenceEvent["parallelism"] = engineGroup === "G6" && executeG6Concurrently
    ? {
      ...runEvent.parallelism,
      mode: "isolated-writes",
      executedConcurrently: true,
    }
    : {
      ...runEvent.parallelism,
      mode: "none",
      executedConcurrently: false,
      criticalPathDurationMs: runEvent.parallelism.summedNodeDurationMs,
    };
  return completeLedger(label, {
    engineGroup,
    taskCategory,
    corpusCaseId,
    durationMs: engineGroup === "G6" && executeG6Concurrently ? 1_000 : 1_200,
    parallelism,
  }, (stages) => {
    const normalized = stages
    .filter((stage) => !((engineGroup === "G0" || engineGroup === "G1")
      && (stage.stage === "define" || stage.stage === "review" || stage.stage === "ship")))
    .map((stage) => ({
      ...stage,
      stage: (engineGroup === "G0" || engineGroup === "G1") && stage.stage === "verify"
        ? "fast-judge"
        : stage.stage,
      validatorTypes: validatorsForCategory(taskCategory, stage.validatorTypes),
      usage: {
        ...stage.usage,
        cacheReadTokens: stage.usage.cacheReadTokens === "unknown" ? 0 : stage.usage.cacheReadTokens,
        cacheWriteTokens: stage.usage.cacheWriteTokens === "unknown" ? 0 : stage.usage.cacheWriteTokens,
      },
    }));
    if (!exerciseRecovery) return normalized;
    if (engineGroup === "G0") {
      const judge = normalized.at(-1)!;
      const build = normalized.filter((stage) => stage.stage === "build").at(-1)!;
      return [
        ...normalized.slice(0, -1),
        { ...judge, status: "failed", contractStatus: "failed" },
        {
          ...build,
          nodeId: opaqueId(`${label}-retry-build`),
          attempt: 2,
          recoveryLevel: "retry",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        {
          ...judge,
          nodeId: opaqueId(`${label}-retry-judge`),
          attempt: 2,
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
      ];
    }
    if (engineGroup === "G5") {
      const verifyIndex = normalized.findIndex((stage) => stage.stage === "verify");
      const verify = normalized[verifyIndex]!;
      const build = normalized.filter((stage) => stage.stage === "build").at(-1)!;
      return [
        ...normalized.slice(0, verifyIndex),
        { ...verify, status: "failed", contractStatus: "failed" },
        {
          ...verify,
          nodeId: opaqueId(`${label}-diagnose`),
          stage: "debug",
          validatorTypes: validatorsForCategory(taskCategory, [...verify.validatorTypes, "structured-tool"]),
          recoveryLevel: "diagnose",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        {
          ...build,
          nodeId: opaqueId(`${label}-repair-build`),
          attempt: 2,
          recoveryLevel: "repair",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        {
          ...verify,
          nodeId: opaqueId(`${label}-repair-verify`),
          attempt: 2,
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        ...normalized.slice(verifyIndex + 1),
      ];
    }
    return normalized;
  });
}

function ablationMatrixEvidence(options: {
  groups?: readonly GraphRunEvidenceEvent["engineGroup"][];
  categories?: readonly GraphRunEvidenceEvent["taskCategory"][];
  distinctCases?: boolean;
  regressGraphGroups?: boolean;
  g6ParallelCategories?: readonly GraphRunEvidenceEvent["taskCategory"][];
} = {}): Array<GraphStageEvidenceEvent | GraphRunEvidenceEvent> {
  const groups = options.groups ?? engineGroups;
  const categories = options.categories ?? taskCategories;
  const evidence: Array<GraphStageEvidenceEvent | GraphRunEvidenceEvent> = [];
  for (const engineGroup of groups) {
    for (const taskCategory of categories) {
      for (let index = 0; index < 10; index += 1) {
        const caseIndex = options.distinctCases === false ? 0 : index;
        const corpusCaseId = opaqueId(`matrix-${taskCategory}-case-${caseIndex}`);
        const engine = matrixEngines.get(engineGroup)!;
        const corpusCase = matrixCases.get(corpusCaseId)!;
        const exerciseRecovery = taskCategory === "small-fix" && index === 0
          && (engineGroup === "G0" || engineGroup === "G5");
        const executeG6Concurrently = engineGroup !== "G6"
          || options.g6ParallelCategories === undefined
          || options.g6ParallelCategories.includes(taskCategory);
        const ledger = knownCompleteLedger(
          `matrix-${engineGroup}-${taskCategory}-${index}`,
          engineGroup,
          taskCategory,
          corpusCaseId,
          exerciseRecovery,
          executeG6Concurrently,
        );
        if (options.regressGraphGroups && engineGroup !== "G0") {
          const terminal = ledger.stages.at(-1)!;
          terminal.status = "failed";
          terminal.contractStatus = "failed";
          ledger.run.finalStatus = "failed";
          ledger.run.contractChecks = {
            ...ledger.run.contractChecks,
            passed: ledger.run.contractChecks.passed - 1,
            failed: ledger.run.contractChecks.failed + 1,
          };
          if (engineGroup === "G1") ledger.run.firstPassVerification = false;
          ledger.run.parallelism = {
            ...ledger.run.parallelism,
            failedNodeCount: ledger.run.parallelism.failedNodeCount + 1,
          };
        }
        ledger.stages = rebindExecutionReceipts(ledger.stages.map((event) => ({
          ...event,
          experimentId: matrixManifest.experimentId,
          corpusSnapshotDigest: corpusCase.snapshotDigest,
          engineConfigurationDigest: engine.configurationDigest,
        })));
        ledger.run = {
          ...ledger.run,
          experimentId: matrixManifest.experimentId,
          corpusSnapshotDigest: corpusCase.snapshotDigest,
          engineConfigurationDigest: engine.configurationDigest,
        };
        evidence.push(...ledgerEvents(ledger));
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
    [{ ...stageEvent, recordedAt: `${"2".repeat(65)}` }, "invalid-time"],
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
      eventCount: 9,
      stageEventCount: 7,
      runCount: 2,
      totals: {
        runCount: 2,
        successCount: 1,
        successRateBasisPoints: "unknown",
        contractChecks: { passed: 8, failed: 1, skipped: 1, satisfactionRateBasisPoints: "unknown" },
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
        usefulParallelism: { usefulRuns: 1, eligibleRuns: 1, observedCriticalPathSavingsMs: 300 },
      },
    });
    expect(report.cohorts.map(({ engineGroup }) => engineGroup)).toEqual(["G0", "G6"]);
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
      "unverified-experiment-provenance",
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
        durationMs: 1_200,
        parallelism: {
          ...runEvent.parallelism,
          mode: "none",
          executedConcurrently: false,
          criticalPathDurationMs: 1_200,
        },
      }),
      completeLedger("failed-node", {}, (stages) => [
        ...stages.slice(0, 2),
        { ...stages[2]!, status: "failed" },
        ...stages.slice(3),
      ]),
      completeLedger("skipped-node", {}, (stages) => [
        ...stages.slice(0, 2),
        { ...stages[2]!, status: "skipped" },
        ...stages.slice(3),
      ]),
      completeLedger("conflicting-node", {
        parallelism: { ...runEvent.parallelism, conflictingNodeCount: 1 },
      }),
      completeLedger("redundant-node", {}, (stages) => [
        stages[0]!,
        {
          ...stages[0]!,
          attempt: 2,
          retryCount: 1,
          recoveryLevel: "retry",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        ...stages.slice(1),
      ]),
      completeLedger("failed-run", { finalStatus: "failed" }, (stages) => stages.map((stage, index) => (
        index === stages.length - 1 ? { ...stage, status: "failed", contractStatus: "failed" } : stage
      ))),
      completeLedger("failed-contract", {}, (stages) => [
        ...stages.slice(0, 2),
        { ...stages[2]!, contractStatus: "failed" },
        ...stages.slice(3),
      ]),
      completeLedger("skipped-contract", {}, (stages) => [
        ...stages.slice(0, 2),
        { ...stages[2]!, contractStatus: "skipped" },
        ...stages.slice(3),
      ]),
    ];

    for (const ledger of cases) {
      expect(buildGraphEvidenceReport(ledgerEvents(ledger)).totals.usefulParallelism.usefulRuns).toBe(0);
    }
    expect(buildGraphEvidenceReport(ledgerEvents(completeLedger("useful"))).totals.usefulParallelism).toEqual({
      eligibleRuns: 1,
      usefulRuns: 1,
      observedCriticalPathSavingsMs: 300,
    });

    const forgedNoSavings = completeLedger("forged-no-savings");
    forgedNoSavings.run.parallelism = {
      ...forgedNoSavings.run.parallelism,
      criticalPathDurationMs: forgedNoSavings.run.parallelism.summedNodeDurationMs,
    };
    expect(() => buildGraphEvidenceReport(ledgerEvents(forgedNoSavings))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("rejects run durations below the replayed critical path for sequential and concurrent traces", () => {
    const sequential = knownCompleteLedger(
      "forged-sequential-duration",
      "G5",
      "small-fix",
      opaqueId("forged-sequential-duration-case"),
    );
    sequential.run.durationMs = 0;
    expect(() => buildGraphEvidenceReport(ledgerEvents(sequential))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const concurrent = knownCompleteLedger(
      "forged-concurrent-duration",
      "G6",
      "multi-file-feature",
      opaqueId("forged-concurrent-duration-case"),
    );
    concurrent.run.durationMs = (concurrent.run.parallelism.criticalPathDurationMs as number) - 1;
    expect(() => buildGraphEvidenceReport(ledgerEvents(concurrent))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("rejects a claimed complete trace when no stage evidence exists", () => {
    expect(() => buildGraphEvidenceReport([{
      ...runEvent,
      sequence: 1,
      traceCompleteness: "complete",
    }])).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }));
  });

  it("rejects BUILD-only success traces and derives fast-path first-pass checking from fast-judge", () => {
    const buildOnly = completeLedger("build-only-success", {}, (stages) => (
      stages.filter((stage) => stage.stage === "build")
    ));
    expect(() => buildGraphEvidenceReport(ledgerEvents(buildOnly))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const mutationAfterShip = completeLedger("mutation-after-ship", {}, (stages) => [
      ...stages,
      {
        ...stages[0]!,
        nodeId: opaqueId("mutation-after-ship-node"),
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: { estimatedUsd: 0, observedUsd: 0 },
      },
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(mutationAfterShip))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const fast = knownCompleteLedger(
      "fast-path-checker",
      "G0",
      "small-fix",
      opaqueId("fast-path-case"),
    );
    expect(fast.stages.some((stage) => stage.stage === "fast-judge")).toBe(true);
    expect(fast.run.firstPassVerification).toBe(true);
    expect(() => buildGraphEvidenceReport(ledgerEvents(fast))).not.toThrow();
  });

  it("rejects checker-only and wrong-family complete traces", () => {
    const fastCheckerOnly = completeLedger("fast-checker-only", {
      engineGroup: "G0",
      taskCategory: "small-fix",
      durationMs: 200,
      parallelism: {
        mode: "none",
        executedConcurrently: false,
        summedNodeDurationMs: 200,
        criticalPathDurationMs: 200,
        failedNodeCount: 0,
        skippedNodeCount: 0,
        conflictingNodeCount: 0,
      },
    }, (stages) => stages
      .filter((stage) => stage.stage === "verify")
      .map((stage) => ({ ...stage, stage: "fast-judge" })));
    expect(() => buildGraphEvidenceReport(ledgerEvents(fastCheckerOnly))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const lifecycleCheckerOnly = completeLedger("lifecycle-checker-only", {}, (stages) => (
      stages.filter((stage) => stage.stage === "verify" || stage.stage === "ship")
    ));
    expect(() => buildGraphEvidenceReport(ledgerEvents(lifecycleCheckerOnly))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const wrongFastFamily = completeLedger("wrong-fast-family", {}, (stages) => stages.map((stage) => (
      stage.stage === "verify" ? { ...stage, stage: "fast-judge" } : stage
    )));
    expect(() => buildGraphEvidenceReport(ledgerEvents(wrongFastFamily))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const wrongLifecycleFamily = knownCompleteLedger(
      "wrong-lifecycle-family",
      "G0",
      "small-fix",
      opaqueId("wrong-lifecycle-family-case"),
    );
    wrongLifecycleFamily.stages[wrongLifecycleFamily.stages.length - 1] = {
      ...wrongLifecycleFamily.stages.at(-1)!,
      stage: "ship",
    };
    expect(() => buildGraphEvidenceReport(ledgerEvents(wrongLifecycleFamily))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("accepts only monotonic replan-backed plan-version changes in typed-recovery groups", () => {
    const versioned = completeLedger("versioned-recovery", {
      engineGroup: "G5",
      planVersion: 2,
      durationMs: 2_100,
      parallelism: {
        ...runEvent.parallelism,
        mode: "none",
        executedConcurrently: false,
        summedNodeDurationMs: 2_100,
        criticalPathDurationMs: 2_100,
        failedNodeCount: 1,
      },
    }, (stages) => {
      const transition = {
          sourcePlanVersion: 1,
          targetPlanVersion: 2,
          graphDigest: opaqueId("versioned-recovery-graph-2"),
          planDigest: opaqueId("versioned-recovery-plan-artifact-2"),
          approvalDigest: opaqueId("versioned-recovery-approval-2"),
          recoveryLedgerDigest: opaqueId("versioned-recovery-ledger-2"),
      };
      return [
        ...stages.slice(0, 4).map((stage) => ({ ...stage, planVersion: 1 })),
        {
          ...stages[4]!,
          status: "failed",
          contractStatus: "failed",
          planVersion: 1,
        },
        {
          ...stages[4]!,
          nodeId: opaqueId("versioned-recovery-debug"),
          stage: "debug",
          recoveryLevel: "replan",
          planVersion: 1,
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { estimatedUsd: 0, observedUsd: 0 },
        },
        {
          ...stages[1]!,
          nodeId: opaqueId("versioned-recovery-plan-2"),
          planVersion: 2,
          planTransition: transition,
        },
        { ...stages[2]!, nodeId: opaqueId("versioned-recovery-build-2"), planVersion: 2, attempt: 2 },
        { ...stages[4]!, nodeId: opaqueId("versioned-recovery-verify-2"), planVersion: 2, attempt: 2 },
        { ...stages[5]!, nodeId: opaqueId("versioned-recovery-review-2"), planVersion: 2, attempt: 2 },
        { ...stages[6]!, nodeId: opaqueId("versioned-recovery-ship-2"), planVersion: 2, attempt: 2 },
      ];
    });
    expect(() => buildGraphEvidenceReport(ledgerEvents(versioned))).not.toThrow();

    for (const status of ["failed", "skipped"] as const) {
      const unauthorized = structuredClone(versioned);
      const debug = unauthorized.stages.find((stage) => stage.recoveryLevel === "replan")!;
      debug.status = status;
      debug.contractStatus = status === "failed" ? "failed" : "skipped";
      unauthorized.run.contractChecks.passed -= 1;
      unauthorized.run.contractChecks[status] += 1;
      unauthorized.run.recoverySuccesses -= 1;
      unauthorized.run.parallelism[status === "failed" ? "failedNodeCount" : "skippedNodeCount"] += 1;
      expect(() => buildGraphEvidenceReport(ledgerEvents(unauthorized))).toThrowError(
        expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
      );
    }

    const replayedActivation = structuredClone(versioned);
    const replacementRunId = opaqueId("versioned-recovery-replayed-run");
    replayedActivation.run.runId = replacementRunId;
    replayedActivation.stages = replayedActivation.stages.map((stage) => {
      const replayed = { ...stage, runId: replacementRunId };
      delete replayed.executionWindow;
      return replayed;
    });
    expect(() => buildGraphEvidenceReport(ledgerEvents(replayedActivation))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const replayedPlanEvent = structuredClone(versioned);
    replayedPlanEvent.stages = replayedPlanEvent.stages.map((stage) => {
      const replayed = { ...stage };
      delete replayed.executionWindow;
      if (replayed.planTransition !== undefined) replayed.eventId = opaqueId("replayed-plan-event-id");
      return replayed;
    });
    expect(() => buildGraphEvidenceReport(ledgerEvents(replayedPlanEvent))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const debugIndex = versioned.stages.findIndex((stage) => stage.recoveryLevel === "replan");
    const reusedReplan = completeLedger("reused-replan-authorization", {
      engineGroup: "G5",
      planVersion: 2,
      durationMs: versioned.run.durationMs,
      parallelism: versioned.run.parallelism,
    }, () => [
      ...versioned.stages.slice(0, debugIndex + 1),
      {
        ...versioned.stages[debugIndex]!,
        nodeId: opaqueId("reused-replan-authorization-debug"),
      },
      ...versioned.stages.slice(debugIndex + 1),
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(reusedReplan))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const nonRecoveryGroup = structuredClone(versioned);
    nonRecoveryGroup.run.engineGroup = "G4";
    nonRecoveryGroup.stages = nonRecoveryGroup.stages.map((stage) => ({ ...stage, engineGroup: "G4" }));
    expect(() => buildGraphEvidenceReport(ledgerEvents(nonRecoveryGroup))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const skippedVersion = structuredClone(versioned);
    skippedVersion.run.planVersion = 3;
    skippedVersion.stages = skippedVersion.stages.map((stage) => (
      stage.planVersion === 2 ? { ...stage, planVersion: 3 } : stage
    ));
    expect(() => buildGraphEvidenceReport(ledgerEvents(skippedVersion))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const relabelledSummary = structuredClone(versioned);
    relabelledSummary.run.planVersion = 3;
    expect(() => buildGraphEvidenceReport(ledgerEvents(relabelledSummary))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const missingApprovalBinding = structuredClone(versioned);
    delete missingApprovalBinding.stages.find((stage) => stage.planVersion === 2)!.planTransition;
    expect(() => buildGraphEvidenceReport(ledgerEvents(missingApprovalBinding))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const missingActivationBinding = structuredClone(versioned);
    delete missingActivationBinding.stages.find((stage) => (
      stage.planVersion === 2 && stage.stage === "build"
    ))!.planActivationDigest;
    expect(() => buildGraphEvidenceReport(ledgerEvents(missingActivationBinding))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const successorPlanIndex = versioned.stages.findIndex((stage) => (
      stage.planVersion === 2 && stage.stage === "plan"
    ));
    const duplicateSuccessorPlan = completeLedger("duplicate-successor-plan", {
      engineGroup: "G5",
      planVersion: 2,
      durationMs: versioned.run.durationMs,
      parallelism: versioned.run.parallelism,
    }, () => [
      ...versioned.stages.slice(0, successorPlanIndex + 1),
      {
        ...versioned.stages[successorPlanIndex]!,
        nodeId: opaqueId("duplicate-successor-plan-node"),
        planTransition: undefined,
      },
      ...versioned.stages.slice(successorPlanIndex + 1),
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(duplicateSuccessorPlan))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("rejects recovery labels that do not replay a failed-checker diagnosis and repair", () => {
    const fabricated = completeLedger("fabricated-recovery", {
      engineGroup: "G5",
      durationMs: 1_200,
      parallelism: {
        ...runEvent.parallelism,
        mode: "none",
        executedConcurrently: false,
        criticalPathDurationMs: 1_200,
      },
    }, (stages) => stages.map((stage) => (
      stage.stage === "build" ? { ...stage, recoveryLevel: "repair" as const } : stage
    )));

    expect(() => buildGraphEvidenceReport(ledgerEvents(fabricated))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const diagnosisWithoutRejection = completeLedger("diagnosis-without-checker-rejection", {
      engineGroup: "G5",
      durationMs: 1_200,
      parallelism: {
        ...runEvent.parallelism,
        mode: "none",
        executedConcurrently: false,
        criticalPathDurationMs: 1_200,
      },
    }, (stages) => [
      ...stages.slice(0, 2),
      { ...stages[2]!, status: "failed" },
      {
        ...stages[4]!,
        nodeId: opaqueId("diagnosis-without-checker-rejection-debug"),
        stage: "debug",
        recoveryLevel: "diagnose",
        durationMs: 0,
      },
      { ...stages[3]!, recoveryLevel: "repair", attempt: 2 },
      ...stages.slice(4),
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(diagnosisWithoutRejection))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const unconsumedReplan = completeLedger("unconsumed-replan", {
      engineGroup: "G5",
      durationMs: 1_200,
      parallelism: {
        ...runEvent.parallelism,
        mode: "none",
        executedConcurrently: false,
        criticalPathDurationMs: 1_200,
      },
    }, (stages) => {
      const verifyIndex = stages.findIndex((stage) => stage.stage === "verify");
      const verify = stages[verifyIndex]!;
      const build = stages.find((stage) => stage.stage === "build")!;
      const zero = {
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: { estimatedUsd: 0, observedUsd: 0 },
      } as const;
      return [
        ...stages.slice(0, verifyIndex),
        { ...verify, status: "failed", contractStatus: "failed" },
        {
          ...verify,
          ...zero,
          nodeId: opaqueId("unconsumed-replan-debug"),
          stage: "debug",
          recoveryLevel: "replan",
        },
        {
          ...build,
          ...zero,
          nodeId: opaqueId("unconsumed-replan-build"),
          attempt: 2,
          recoveryLevel: "repair",
        },
        { ...verify, ...zero, nodeId: opaqueId("unconsumed-replan-verify"), attempt: 2 },
        ...stages.slice(verifyIndex + 1),
      ];
    });
    expect(() => buildGraphEvidenceReport(ledgerEvents(unconsumedReplan))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("does not let an unsuccessful typed DEBUG authorize repair", () => {
    const rejected = knownCompleteLedger(
      "failed-debug-authorization",
      "G5",
      "small-fix",
      opaqueId("failed-debug-authorization-case"),
      true,
    );
    const debug = rejected.stages.find((stage) => stage.stage === "debug")!;
    debug.status = "failed";
    debug.contractStatus = "failed";
    rejected.run.contractChecks.passed -= 1;
    rejected.run.contractChecks.failed += 1;
    rejected.run.recoverySuccesses -= 1;
    rejected.run.parallelism.failedNodeCount += 1;

    expect(() => buildGraphEvidenceReport(ledgerEvents(rejected))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("replays a large late-failure recovery trace without per-event history rescans", () => {
    const successfulPrefixBuilds = 5_000;
    const recoveryCycles = 10_000;
    const ledger = completeLedger("linear-recovery-scale", {
      engineGroup: "G5",
      durationMs: 1_200,
      parallelism: {
        ...runEvent.parallelism,
        mode: "none",
        executedConcurrently: false,
        criticalPathDurationMs: 1_200,
      },
    }, (stages) => {
      const result: GraphStageEvidenceEvent[] = [stages[0]!, stages[1]!];
      const build = stages[2]!;
      const verify = stages[4]!;
      const zero = {
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: { estimatedUsd: 0, observedUsd: 0 },
      } as const;
      for (let index = 0; index < successfulPrefixBuilds; index += 1) {
        result.push({
          ...build,
          ...zero,
          nodeId: opaqueId(`linear-prefix-build-${index}`),
        });
      }
      for (let index = 0; index < recoveryCycles; index += 1) {
        result.push(
          {
            ...verify,
            ...zero,
            nodeId: opaqueId(`linear-rejected-verify-${index}`),
            attempt: index + 1,
            status: "failed",
            contractStatus: "failed",
          },
          {
            ...verify,
            ...zero,
            nodeId: opaqueId(`linear-debug-${index}`),
            stage: "debug",
            attempt: index + 1,
            recoveryLevel: "diagnose",
          },
          {
            ...build,
            ...zero,
            nodeId: opaqueId(`linear-repair-${index}`),
            attempt: index + 2,
            recoveryLevel: "repair",
          },
        );
      }
      result.push(
        { ...verify, ...zero, nodeId: opaqueId("linear-final-verify"), attempt: recoveryCycles + 1 },
        stages[5]!,
        stages[6]!,
      );
      return result;
    });

    expect(ledger.stages.length).toBe(35_005);
    expect(() => buildGraphEvidenceReport(ledgerEvents(ledger))).not.toThrow();
  }, 30_000);

  it("derives isolated parallelism from exact scheduler and worktree receipts", () => {
    const missingWindow = knownCompleteLedger(
      "missing-parallel-window",
      "G6",
      "multi-file-feature",
      opaqueId("missing-parallel-window-case"),
    );
    delete missingWindow.stages.find((stage) => stage.stage === "build")!.executionWindow;
    expect(() => buildGraphEvidenceReport(ledgerEvents(missingWindow))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const duplicateWorktree = knownCompleteLedger(
      "duplicate-worktree-receipt",
      "G6",
      "multi-file-feature",
      opaqueId("duplicate-worktree-receipt-case"),
    );
    const builds = duplicateWorktree.stages.filter((stage) => stage.stage === "build");
    builds[1]!.executionWindow!.worktreeReceiptDigest = builds[0]!.executionWindow!.worktreeReceiptDigest;
    expect(() => buildGraphEvidenceReport(ledgerEvents(duplicateWorktree))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const receiptTampering: Array<{
      label: string;
      mutate: (ledger: ReturnType<typeof completeLedger>) => void;
    }> = [
      {
        label: "corpus",
        mutate: (ledger) => {
          const corpusCaseId = opaqueId("replayed-receipt-other-corpus");
          const corpusSnapshotDigest = opaqueId("replayed-receipt-other-snapshot");
          ledger.run.corpusCaseId = corpusCaseId;
          ledger.run.corpusSnapshotDigest = corpusSnapshotDigest;
          ledger.stages = ledger.stages.map((stage) => ({ ...stage, corpusCaseId, corpusSnapshotDigest }));
        },
      },
      {
        label: "node",
        mutate: (ledger) => {
          ledger.stages.find((stage) => stage.stage === "build")!.nodeId = opaqueId("tampered-receipt-node");
        },
      },
      {
        label: "attempt",
        mutate: (ledger) => {
          ledger.stages.find((stage) => stage.stage === "build")!.attempt += 10;
          ledger.run.buildPasses += 10;
        },
      },
      {
        label: "timestamps",
        mutate: (ledger) => {
          const window = ledger.stages.find((stage) => stage.stage === "build")!.executionWindow!;
          window.startedAt = new Date(Date.parse(window.startedAt) - 1).toISOString();
          window.completedAt = new Date(Date.parse(window.completedAt) - 1).toISOString();
        },
      },
      {
        label: "base",
        mutate: (ledger) => {
          ledger.stages.find((stage) => stage.stage === "build")!.executionWindow!.baseRevisionDigest = opaqueId("tampered-base");
        },
      },
      {
        label: "write-set",
        mutate: (ledger) => {
          ledger.stages.find((stage) => stage.stage === "build")!.executionWindow!.writeSetDigest = opaqueId("tampered-write-set");
        },
      },
    ];
    for (const tampering of receiptTampering) {
      const tampered = knownCompleteLedger(
        `receipt-${tampering.label}`,
        "G6",
        "multi-file-feature",
        opaqueId(`receipt-${tampering.label}-case`),
      );
      tampering.mutate(tampered);
      expect(() => buildGraphEvidenceReport(ledgerEvents(tampered)), tampering.label).toThrowError(
        expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
      );
    }

    const toggledSummary = knownCompleteLedger(
      "summary-only-parallelism",
      "G5",
      "multi-file-feature",
      opaqueId("summary-only-parallelism-case"),
    );
    toggledSummary.run.engineGroup = "G6";
    toggledSummary.stages = toggledSummary.stages.map((stage) => ({ ...stage, engineGroup: "G6" }));
    toggledSummary.run.parallelism = {
      ...toggledSummary.run.parallelism,
      mode: "isolated-writes",
      executedConcurrently: true,
      criticalPathDurationMs: 900,
    };
    expect(() => buildGraphEvidenceReport(ledgerEvents(toggledSummary))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const replayedAcrossRun = knownCompleteLedger(
      "cross-run-receipt-source",
      "G6",
      "multi-file-feature",
      opaqueId("cross-run-receipt-case"),
    );
    const replacementRunId = opaqueId("cross-run-receipt-target");
    replayedAcrossRun.run.runId = replacementRunId;
    replayedAcrossRun.stages = replayedAcrossRun.stages.map((stage) => ({
      ...stage,
      runId: replacementRunId,
    }));
    expect(() => buildGraphEvidenceReport(ledgerEvents(replayedAcrossRun))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("requires non-empty validators and security validation for security-sensitive complete runs", () => {
    expect(validateGraphEvidenceEvent({ ...stageEvent, validatorTypes: [] }))
      .toEqual({ ok: false, error: "unbounded-array" });

    const unsecured = knownCompleteLedger(
      "missing-security-validator",
      "G5",
      "security-sensitive",
      opaqueId("missing-security-validator-case"),
    );
    unsecured.stages = unsecured.stages.map((stage) => ({
      ...stage,
      validatorTypes: stage.validatorTypes.filter((validator) => validator !== "security"),
    }));
    unsecured.run.validatorTypes = unsecured.run.validatorTypes.filter((validator) => validator !== "security");
    expect(() => buildGraphEvidenceReport(ledgerEvents(unsecured))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    for (const status of ["failed", "skipped"] as const) {
      const ineffective = knownCompleteLedger(
        `ineffective-security-validator-${status}`,
        "G5",
        "security-sensitive",
        opaqueId(`ineffective-security-validator-${status}-case`),
      );
      ineffective.stages = ineffective.stages.map((stage) => ({
        ...stage,
        validatorTypes: stage.validatorTypes.filter((validator) => validator !== "security"),
      }));
      const ineffectiveValidator = ineffective.stages.find((stage) => stage.stage === "build")!;
      ineffectiveValidator.validatorTypes = [...ineffectiveValidator.validatorTypes, "security"];
      ineffectiveValidator.status = status;
      ineffectiveValidator.contractStatus = status;
      ineffective.run.validatorTypes = ineffective.run.validatorTypes.filter((validator) => validator !== "security");
      ineffective.run.contractChecks.passed -= 1;
      ineffective.run.contractChecks[status] += 1;
      ineffective.run.parallelism[status === "failed" ? "failedNodeCount" : "skippedNodeCount"] += 1;
      expect(() => buildGraphEvidenceReport(ledgerEvents(ineffective)), status).toThrowError(
        expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
      );
    }
  });

  it("requires a failed summary to terminate at the failure instead of a later successful ship", () => {
    const recoveredThenShipped = completeLedger("failed-after-successful-ship", { finalStatus: "failed" }, (stages) => [
      { ...stages[0]!, status: "failed", contractStatus: "failed" },
      ...stages.slice(1),
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(recoveredThenShipped))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it("rejects reversed or unresolved lifecycle checker paths", () => {
    const reversed = completeLedger("reversed-checkers", {}, (stages) => [
      ...stages.slice(0, 4),
      stages[5]!,
      stages[4]!,
      stages[6]!,
    ]);
    expect(() => buildGraphEvidenceReport(ledgerEvents(reversed))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );

    const unresolved = completeLedger("unresolved-review", {}, (stages) => stages.map((stage) => (
      stage.stage === "review" ? { ...stage, status: "failed", contractStatus: "failed" } : stage
    )));
    expect(() => buildGraphEvidenceReport(ledgerEvents(unresolved))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it.each(["cancelled", "paused"] as const)("treats %s stage outcomes as absorbing", (status) => {
    const nonAbsorbing = completeLedger(`non-absorbing-${status}`, {}, (stages) => stages.map((stage, index) => (
      index === 2 ? { ...stage, status } : stage
    )));
    expect(() => buildGraphEvidenceReport(ledgerEvents(nonAbsorbing))).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-trace" }),
    );
  });

  it.each([
    () => {
      const ledger = completeLedger("sequence-gap");
      for (let index = 1; index < ledger.stages.length; index += 1) {
        ledger.stages[index] = { ...ledger.stages[index]!, sequence: index + 2 };
      }
      ledger.run = { ...ledger.run, sequence: ledger.stages.length + 2 };
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
    () => {
      const ledger = completeLedger("forged-human-override");
      ledger.run = { ...ledger.run, humanOverride: true };
      return ledgerEvents(ledger);
    },
    () => {
      const ledger = completeLedger("forged-node-duration");
      ledger.run = {
        ...ledger.run,
        parallelism: { ...ledger.run.parallelism, summedNodeDurationMs: 1_199 },
      };
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
    { ...stageEvent, experimentId: "experiment-one" },
    { ...stageEvent, corpusSnapshotDigest: "fixture-one" },
    { ...stageEvent, engineConfigurationDigest: "graph-enabled" },
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

  it("fails closed before decimal cost aggregation loses a valid fractional contribution", () => {
    const values = [90_000_000, 90_000_000, 0.00000001];
    const summaries = values.map((observedUsd, index): GraphRunEvidenceEvent => ({
      ...runEvent,
      eventId: opaqueId(`decimal-overflow-event-${index}`),
      runId: opaqueId(`decimal-overflow-run-${index}`),
      sequence: 1,
      traceCompleteness: "partial",
      cost: { estimatedUsd: 0, observedUsd },
    }));

    expect(() => buildGraphEvidenceReport(summaries)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "aggregate-overflow" }),
    );
  });

  it("rejects mixed graph releases instead of aggregating incomparable versions", () => {
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

    expect(() => buildGraphEvidenceReport([lower, upper])).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-identity" }),
    );
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
    expect(complete.rolloutDecisionEligible).toBe(false);
    expect(complete.limitations).toContain("unverified-experiment-provenance");

    const trusted = buildGraphEvidenceReport(fullEvidence, { experimentManifest: matrixManifest });
    expect(trusted.evidenceComplete).toBe(true);
    expect(trusted.rolloutDecisionEligible).toBe(true);
    expect(trusted.recommendedDecision).toBe("enable-graph-dag");
    expect(trusted.decisionReasons).toEqual(["dag-non-inferior"]);
    expect(trusted.limitations).not.toContain("unverified-experiment-provenance");

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

  it("does not treat recovery labels as typed recovery without a structured DEBUG directive", () => {
    const evidence = structuredClone(ablationMatrixEvidence());
    const debug = evidence.find((event): event is GraphStageEvidenceEvent => (
      event.type === "stage"
        && event.engineGroup === "G5"
        && event.stage === "debug"
        && event.recoveryLevel === "diagnose"
    ))!;
    debug.validatorTypes = debug.validatorTypes.filter((validator) => validator !== "structured-tool");
    const summary = evidence.find((event): event is GraphRunEvidenceEvent => (
      event.type === "run" && event.runId === debug.runId
    ))!;
    summary.validatorTypes = summary.validatorTypes.filter((validator) => validator !== "structured-tool");

    const report = buildGraphEvidenceReport(evidence, { experimentManifest: matrixManifest });
    expect(report.evidenceComplete).toBe(true);
    expect(report.rolloutDecisionEligible).toBe(false);
    expect(report.recommendedDecision).toBe("keep-graph-shadow");
    expect(report.decisionReasons).toEqual(["typed-recovery-unobserved"]);
  });

  it("excludes failed optional validators from cohort coverage", () => {
    const evidence = structuredClone(ablationMatrixEvidence());
    const summary = evidence.find((event): event is GraphRunEvidenceEvent => (
      event.type === "run"
        && event.engineGroup === "G3"
        && event.taskCategory === "multi-file-feature"
        && event.corpusCaseId === opaqueId("matrix-multi-file-feature-case-1")
    ))!;
    const stages = evidence.filter((event): event is GraphStageEvidenceEvent => (
      event.type === "stage" && event.runId === summary.runId
    ));
    for (const stage of stages) {
      stage.validatorTypes = stage.validatorTypes.filter((validator) => validator !== "schema");
    }
    const failedValidator = stages.find((stage) => stage.stage === "build")!;
    failedValidator.validatorTypes = ["schema", ...failedValidator.validatorTypes];
    failedValidator.status = "failed";
    summary.validatorTypes = summary.validatorTypes.filter((validator) => validator !== "schema");
    summary.parallelism.failedNodeCount += 1;

    const report = buildGraphEvidenceReport(evidence, { experimentManifest: matrixManifest });
    const cohort = report.cohorts.find((item) => (
      item.engineGroup === "G3" && item.taskCategory === "multi-file-feature"
    ))!;
    expect(cohort.validatorTypes.schema).toBe(9);
    expect(report.recommendedDecision).toBe("keep-graph-shadow");
    expect(report.decisionReasons).toEqual(["sequential-regression"]);
  });

  it("requires verified isolated parallelism across representative write categories", () => {
    const report = buildGraphEvidenceReport(ablationMatrixEvidence({
      g6ParallelCategories: ["multi-file-feature"],
    }), { experimentManifest: matrixManifest });

    expect(report.evidenceComplete).toBe(true);
    expect(report.recommendedDecision).toBe("enable-sequential-graph");
    expect(report.decisionReasons).toEqual([
      "sequential-non-inferior",
      "useful-isolated-parallelism-unobserved",
    ]);
  });

  it("keeps graph-shadow when a structurally complete graph matrix regresses against G0", () => {
    const report = buildGraphEvidenceReport(ablationMatrixEvidence({ regressGraphGroups: true }), {
      experimentManifest: matrixManifest,
    });

    expect(report.evidenceComplete).toBe(true);
    expect(report.rolloutDecisionEligible).toBe(false);
    expect(report.recommendedDecision).toBe("keep-graph-shadow");
    expect(report.decisionReasons).toEqual(["sequential-regression"]);
  });

  it("keeps graph-shadow when one intermediate ablation group regresses", () => {
    const evidence = structuredClone(ablationMatrixEvidence());
    const terminal = evidence.find((event): event is GraphStageEvidenceEvent => (
      event.type === "stage"
        && event.engineGroup === "G3"
        && event.taskCategory === "small-fix"
        && event.stage === "ship"
    ))!;
    terminal.status = "failed";
    terminal.contractStatus = "failed";
    const summary = evidence.find((event): event is GraphRunEvidenceEvent => (
      event.type === "run" && event.runId === terminal.runId
    ))!;
    summary.finalStatus = "failed";
    summary.contractChecks.passed -= 1;
    summary.contractChecks.failed += 1;
    summary.parallelism.failedNodeCount += 1;

    const report = buildGraphEvidenceReport(evidence, { experimentManifest: matrixManifest });
    expect(report.evidenceComplete).toBe(true);
    expect(report.recommendedDecision).toBe("keep-graph-shadow");
    expect(report.decisionReasons).toEqual(["sequential-regression"]);
  });

  it("treats skipped candidate contracts as negative rollout evidence", () => {
    const evidence = structuredClone(ablationMatrixEvidence());
    const candidateStages = evidence.filter((event): event is GraphStageEvidenceEvent => (
      event.type === "stage"
        && event.engineGroup === "G5"
        && event.taskCategory === "small-fix"
        && event.stage === "build"
    ));
    const skipped = candidateStages[1]!;
    skipped.contractStatus = "skipped";
    const summary = evidence.find((event): event is GraphRunEvidenceEvent => (
      event.type === "run" && event.runId === skipped.runId
    ))!;
    summary.contractChecks.passed -= 1;
    summary.contractChecks.skipped += 1;

    const report = buildGraphEvidenceReport(evidence, { experimentManifest: matrixManifest });
    expect(report.evidenceComplete).toBe(true);
    expect(report.recommendedDecision).toBe("keep-graph-shadow");
    expect(report.decisionReasons).toEqual(["sequential-regression"]);
  });

  it("treats retries, fallbacks, failed/skipped/conflicting work, redundancy, and validator loss as regressions", () => {
    const mutations: Array<{
      name: string;
      apply: (stages: GraphStageEvidenceEvent[], summary: GraphRunEvidenceEvent) => void;
    }> = [
      {
        name: "retry",
        apply: (stages, summary) => {
          stages.find((stage) => stage.stage === "build")!.retryCount += 2;
          summary.retryCount += 2;
        },
      },
      {
        name: "fallback",
        apply: (stages, summary) => {
          stages.find((stage) => stage.stage === "build")!.fallbackCount += 1;
          summary.fallbackCount += 1;
        },
      },
      {
        name: "failed work",
        apply: (stages, summary) => {
          stages.find((stage) => stage.stage === "build")!.status = "failed";
          summary.parallelism.failedNodeCount += 1;
        },
      },
      {
        name: "skipped work",
        apply: (stages, summary) => {
          stages.find((stage) => stage.stage === "build")!.status = "skipped";
          summary.parallelism.skippedNodeCount += 1;
        },
      },
      {
        name: "conflicting work",
        apply: (_stages, summary) => {
          summary.parallelism.conflictingNodeCount += 1;
        },
      },
      {
        name: "redundant work",
        apply: (stages, summary) => {
          const builds = stages.filter((stage) => stage.stage === "build");
          builds[1]!.nodeId = builds[0]!.nodeId;
          builds[1]!.attempt = 2;
          summary.nodeCount -= 1;
          summary.redundantNodeExecutions += 1;
          summary.buildPasses = 2;
        },
      },
      {
        name: "validator coverage",
        apply: (stages, summary) => {
          for (const stage of stages) {
            stage.validatorTypes = stage.validatorTypes.filter((validator) => validator !== "schema");
          }
          summary.validatorTypes = summary.validatorTypes.filter((validator) => validator !== "schema");
        },
      },
    ];

    for (const mutation of mutations) {
      const evidence = structuredClone(ablationMatrixEvidence());
      const corpusCaseId = opaqueId("matrix-multi-file-feature-case-1");
      const summary = evidence.find((event): event is GraphRunEvidenceEvent => (
        event.type === "run"
          && event.engineGroup === "G3"
          && event.taskCategory === "multi-file-feature"
          && event.corpusCaseId === corpusCaseId
      ))!;
      const stages = evidence.filter((event): event is GraphStageEvidenceEvent => (
        event.type === "stage" && event.runId === summary.runId
      ));
      mutation.apply(stages, summary);
      const rebound = new Map(rebindExecutionReceipts(stages).map((stage) => [stage.eventId, stage]));
      for (let index = 0; index < evidence.length; index += 1) {
        const event = evidence[index]!;
        if (event.type === "stage" && event.runId === summary.runId) evidence[index] = rebound.get(event.eventId)!;
      }

      const report = buildGraphEvidenceReport(evidence, { experimentManifest: matrixManifest });
      expect(report.recommendedDecision, mutation.name).toBe("keep-graph-shadow");
      expect(report.decisionReasons, mutation.name).toEqual(["sequential-regression"]);
    }
  }, 10_000);

  it("binds evidence to the canonical experiment manifest and exact engine feature vector", () => {
    expect(validateGraphExperimentManifest(structuredClone(matrixManifest))).toEqual(matrixManifest);
    expect(createGraphExperimentManifest({
      schemaVersion: 1,
      releaseVersion: matrixManifest.releaseVersion,
      corpusSnapshotDigest: matrixManifest.corpusSnapshotDigest,
      engines: [...matrixManifest.engines].reverse(),
      cases: [...matrixManifest.cases].reverse(),
    })).toEqual(matrixManifest);

    const relabelled = ablationMatrixEvidence().map((event) => event.engineGroup === "G6"
      ? { ...event, engineConfigurationDigest: matrixEngines.get("G0")!.configurationDigest }
      : event);
    expect(() => buildGraphEvidenceReport(relabelled, { experimentManifest: matrixManifest })).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-experiment-evidence" }),
    );

    const wrongFeatures = structuredClone(matrixManifest);
    wrongFeatures.engines[6] = {
      ...wrongFeatures.engines[6]!,
      features: { ...wrongFeatures.engines[6]!.features, isolatedParallelBuild: false },
    };
    expect(() => validateGraphExperimentManifest(wrongFeatures)).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-experiment-manifest" }),
    );

    expect(() => createGraphExperimentManifest({
      schemaVersion: 1,
      releaseVersion: matrixManifest.releaseVersion,
      engines: matrixManifest.engines.map((engine) => ({
        ...engine,
        configurationDigest: matrixManifest.engines[0]!.configurationDigest,
      })),
      cases: matrixManifest.cases,
    })).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-experiment-manifest" }));

    expect(() => createGraphExperimentManifest({
      schemaVersion: 1,
      releaseVersion: matrixManifest.releaseVersion,
      engines: matrixManifest.engines,
      cases: matrixManifest.cases.map((item, index) => ({
        ...item,
        snapshotDigest: index === 1 ? matrixManifest.cases[0]!.snapshotDigest : item.snapshotDigest,
      })),
    })).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-experiment-manifest" }));
  });

  it("rejects relabelled corpus identities across task categories", () => {
    const caseId = opaqueId("relabeled-corpus-case");
    const first = knownCompleteLedger("relabeled-first", "G0", "small-fix", caseId);
    const second = knownCompleteLedger("relabeled-second", "G1", "security-sensitive", caseId);
    expect(() => buildGraphEvidenceReport([...ledgerEvents(first), ...ledgerEvents(second)])).toThrowError(
      expect.objectContaining<Partial<GraphEvidenceError>>({ code: "inconsistent-run-identity" }),
    );
  });

  it("fails closed on malformed ledgers and ambiguous run summaries", () => {
    expect(() => buildGraphEvidenceReport([{ ...runEvent, rawSource: "SECRET" }]))
      .toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "invalid-event" }));
    expect(() => buildGraphEvidenceReport([runEvent, { ...runEvent }]))
      .toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "duplicate-event-id" }));
    expect(() => buildGraphEvidenceReport([
      ...completeStageEvents,
      runEvent,
      { ...runEvent, eventId: opaqueId("other-summary"), sequence: 9 },
    ])).toThrowError(expect.objectContaining<Partial<GraphEvidenceError>>({ code: "duplicate-run-summary" }));
    expect(() => buildGraphEvidenceReport([
      ...completeStageEvents,
      runEvent,
      {
        ...stageEvent,
        eventId: opaqueId("late-stage"),
        nodeId: opaqueId("late-node"),
        sequence: 9,
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
        "verified-release-artifacts",
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
    })).toEqual({ eligible: false, missing: ["released-compatibility-window", "verified-release-artifacts"] });

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
    })).toEqual({ eligible: false, missing: ["verified-release-artifacts", "consistent-release-binding"] });

    expect(assessLegacyRetirement({
      releasedCompatibilityWindows: 1,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: "1.1.0",
        artifactDigest: opaqueId("self-attested-rollout"),
        decision: "enable-sequential-graph",
      },
      graphCoverage: { releaseVersion: "1.1.0", artifactDigest: opaqueId("self-attested-coverage") },
      cleanRollback: { releaseVersion: "1.1.0", artifactDigest: opaqueId("self-attested-rollback") },
      configMigration: { releaseVersion: "1.1.0", artifactDigest: opaqueId("self-attested-migration") },
    })).toEqual({ eligible: false, missing: ["verified-release-artifacts"] });

    expect(assessLegacyRetirement({
      releasedCompatibilityWindows: 1,
      evidenceSource: "trusted-release-record",
      rolloutReport: {
        releaseVersion: "1.1.0",
        artifactDigest: opaqueId("shadow-rollout"),
        decision: "keep-graph-shadow",
      },
      graphCoverage: { releaseVersion: "1.1.0", artifactDigest: opaqueId("shadow-coverage") },
      cleanRollback: { releaseVersion: "1.1.0", artifactDigest: opaqueId("shadow-rollback") },
      configMigration: { releaseVersion: "1.1.0", artifactDigest: opaqueId("shadow-migration") },
    })).toEqual({
      eligible: false,
      missing: ["verified-release-artifacts", "decision-ready-rollout-report"],
    });

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
