export type ExecutionRouteMode = "fast" | "lifecycle-sequential" | "lifecycle-dag";
export type DeclaredExecutionRouteMode = "automatic" | ExecutionRouteMode;
export type ExecutionTaskRisk = "low" | "medium" | "high";
export type ExecutionTaskCategory =
  | "small-fix"
  | "multi-file-feature"
  | "test-failure"
  | "refactor"
  | "persistence-change"
  | "security-sensitive"
  | "read-only-analysis"
  | "conflicting-writes";
export type ExecutionMutation = "read-only" | "write";
export type ExecutionWriteIsolation = "none" | "worktree";
export type ExecutionParallelWriteSafety = "not-applicable" | "unverified" | "verified-disjoint" | "conflicting";

export interface ExecutionTaskFeatures {
  category: ExecutionTaskCategory;
  risk: ExecutionTaskRisk;
  expectedSteps: number;
  independentBranchCount: number;
  durabilityRequired: boolean;
  mutation: ExecutionMutation;
  writeIsolation: ExecutionWriteIsolation;
  /** Result derived from the immutable BUILD DAG's reviewed resource/write-set contracts. */
  parallelWriteSafety: ExecutionParallelWriteSafety;
}

export interface TrustedExecutionPolicy {
  /** An explicit mode is a trusted user pin. */
  mode: DeclaredExecutionRouteMode;
  /** Maximum autonomy available to automatic routing. */
  maxMode: ExecutionRouteMode;
  /** Permission only; worktree isolation and independent writes are still required. */
  allowParallelWrites: boolean;
}

export interface ProjectExecutionPolicy {
  /** Repository policy may reduce an automatic route, never expand it or override a user pin. */
  requestedMode?: DeclaredExecutionRouteMode;
  /** Repository-local ceiling applied only when compatible with the derived safety floor. */
  maxMode?: ExecutionRouteMode;
  /** `false` can disable; `true` cannot create trusted permission. */
  allowParallelWrites?: boolean;
}

export interface ExecutionRoutingInput {
  user: TrustedExecutionPolicy;
  task: ExecutionTaskFeatures;
  project?: ProjectExecutionPolicy;
}

export type ExecutionRouteReason =
  | "user-pin"
  | "simple-low-risk"
  | "durability-required"
  | "elevated-risk"
  | "multi-step"
  | "independent-branches"
  | "user-ceiling"
  | "project-reduction"
  | "project-expansion-denied"
  | "project-reduction-denied-by-safety-floor"
  | "project-mode-ignored-by-user-pin"
  | "parallel-writes-user-permission-required"
  | "parallel-writes-project-disabled"
  | "parallel-writes-worktree-required"
  | "parallel-writes-conflict-declared"
  | "parallel-writes-disjoint-write-sets-required"
  | "parallel-writes-trusted-opt-in";

export interface ExecutionRouteDecision {
  mode: ExecutionRouteMode;
  source: "automatic" | "user-pin";
  parallelWrites: boolean;
  projectReductionApplied: boolean;
  reasonCodes: readonly ExecutionRouteReason[];
  /** Static, policy-authored explanations. No task or repository text is interpolated. */
  explanations: readonly string[];
}

export type ExecutionRoutingErrorCode =
  | "invalid-input"
  | "unexpected-field"
  | "user-pin-exceeds-ceiling"
  | "no-permitted-mode";

export class ExecutionRoutingError extends Error {
  readonly code: ExecutionRoutingErrorCode;

  constructor(code: ExecutionRoutingErrorCode) {
    super(`Execution routing failed: ${code}`);
    this.name = "ExecutionRoutingError";
    this.code = code;
  }
}

const MODE_ORDER: readonly ExecutionRouteMode[] = ["fast", "lifecycle-sequential", "lifecycle-dag"];
const DECLARED_MODES: readonly DeclaredExecutionRouteMode[] = ["automatic", ...MODE_ORDER];
const TASK_RISKS: readonly ExecutionTaskRisk[] = ["low", "medium", "high"];
const TASK_CATEGORIES: readonly ExecutionTaskCategory[] = [
  "small-fix",
  "multi-file-feature",
  "test-failure",
  "refactor",
  "persistence-change",
  "security-sensitive",
  "read-only-analysis",
  "conflicting-writes",
];
const MUTATIONS: readonly ExecutionMutation[] = ["read-only", "write"];
const WRITE_ISOLATIONS: readonly ExecutionWriteIsolation[] = ["none", "worktree"];
const PARALLEL_WRITE_SAFETY: readonly ExecutionParallelWriteSafety[] = [
  "not-applicable",
  "unverified",
  "verified-disjoint",
  "conflicting",
];

const EXPLANATIONS: Readonly<Record<ExecutionRouteReason, string>> = Object.freeze({
  "user-pin": "The trusted user explicitly pinned this execution mode.",
  "simple-low-risk": "A short, low-risk task stays on the bounded fast path.",
  "durability-required": "The task requires durable lifecycle state and recovery.",
  "elevated-risk": "The declared risk requires lifecycle checks and durable evidence.",
  "multi-step": "The expected step count exceeds the bounded fast-path threshold.",
  "independent-branches": "Declared independent branches can use an immutable lifecycle DAG.",
  "user-ceiling": "Trusted user policy reduced the automatically selected autonomy level.",
  "project-reduction": "Repository policy reduced an automatic route within the safety floor.",
  "project-expansion-denied": "Repository policy cannot expand the automatically selected autonomy level.",
  "project-reduction-denied-by-safety-floor": "Repository policy cannot bypass a derived lifecycle safety requirement.",
  "project-mode-ignored-by-user-pin": "Repository mode policy cannot override a trusted user pin.",
  "parallel-writes-user-permission-required": "Parallel writes require explicit trusted user permission.",
  "parallel-writes-project-disabled": "Repository policy disabled parallel writes.",
  "parallel-writes-worktree-required": "Parallel writes require declared worktree isolation.",
  "parallel-writes-conflict-declared": "Declared conflicting writes must remain sequential.",
  "parallel-writes-disjoint-write-sets-required": "Parallel writes require independently verified disjoint BUILD write sets.",
  "parallel-writes-trusted-opt-in": "Trusted user permission and worktree isolation allow parallel writes.",
});

export function routeExecution(input: ExecutionRoutingInput): Readonly<ExecutionRouteDecision> {
  validateInput(input);

  const reasons: ExecutionRouteReason[] = [];
  const safetyFloor = deriveSafetyFloor(input.task);
  let mode: ExecutionRouteMode;
  let source: ExecutionRouteDecision["source"];
  let projectReductionApplied = false;

  if (input.user.mode !== "automatic") {
    if (modeRank(input.user.mode) > modeRank(input.user.maxMode)) {
      throw new ExecutionRoutingError("user-pin-exceeds-ceiling");
    }
    mode = input.user.mode;
    source = "user-pin";
    addReason(reasons, "user-pin");
    if (projectAttemptsModeChoice(input.project, mode)) {
      addReason(reasons, "project-mode-ignored-by-user-pin");
    }
  } else {
    source = "automatic";
    mode = deriveAutomaticMode(input.task, reasons);
    if (modeRank(input.user.maxMode) < modeRank(safetyFloor)) {
      throw new ExecutionRoutingError("no-permitted-mode");
    }
    if (modeRank(mode) > modeRank(input.user.maxMode)) {
      mode = input.user.maxMode;
      addReason(reasons, "user-ceiling");
    }

    const projectModes = [
      input.project?.requestedMode === "automatic" ? undefined : input.project?.requestedMode,
      input.project?.maxMode,
    ];
    for (const projectMode of projectModes) {
      if (projectMode === undefined) continue;
      if (modeRank(projectMode) < modeRank(mode)) {
        if (modeRank(projectMode) < modeRank(safetyFloor)) {
          addReason(reasons, "project-reduction-denied-by-safety-floor");
        } else {
          mode = projectMode;
          projectReductionApplied = true;
          addReason(reasons, "project-reduction");
        }
      } else if (projectMode === input.project?.requestedMode && modeRank(projectMode) > modeRank(mode)) {
        addReason(reasons, "project-expansion-denied");
      }
    }
  }

  const parallelWrites = resolveParallelWrites(input, mode, reasons);
  const reasonCodes = Object.freeze([...reasons]);
  return Object.freeze({
    mode,
    source,
    parallelWrites,
    projectReductionApplied,
    reasonCodes,
    explanations: Object.freeze(reasonCodes.map((reason) => EXPLANATIONS[reason])),
  });
}

function deriveSafetyFloor(task: ExecutionTaskFeatures): ExecutionRouteMode {
  return task.durabilityRequired || hasElevatedRisk(task) || task.expectedSteps > 3 || task.independentBranchCount > 1
    ? "lifecycle-sequential"
    : "fast";
}

function deriveAutomaticMode(task: ExecutionTaskFeatures, reasons: ExecutionRouteReason[]): ExecutionRouteMode {
  if (task.durabilityRequired) addReason(reasons, "durability-required");
  if (hasElevatedRisk(task)) addReason(reasons, "elevated-risk");
  if (task.independentBranchCount > 1) {
    addReason(reasons, "independent-branches");
    return "lifecycle-dag";
  }
  if (task.expectedSteps > 3) addReason(reasons, "multi-step");
  if (reasons.length > 0) return "lifecycle-sequential";
  addReason(reasons, "simple-low-risk");
  return "fast";
}

function hasElevatedRisk(task: ExecutionTaskFeatures): boolean {
  return task.risk !== "low"
    || task.category === "persistence-change"
    || task.category === "security-sensitive"
    || task.category === "conflicting-writes";
}

function resolveParallelWrites(
  input: ExecutionRoutingInput,
  mode: ExecutionRouteMode,
  reasons: ExecutionRouteReason[],
): boolean {
  if (mode !== "lifecycle-dag" || input.task.mutation !== "write") return false;
  if (!input.user.allowParallelWrites) {
    addReason(reasons, "parallel-writes-user-permission-required");
    return false;
  }
  if (input.project?.allowParallelWrites === false) {
    addReason(reasons, "parallel-writes-project-disabled");
    return false;
  }
  if (input.task.parallelWriteSafety === "conflicting") {
    addReason(reasons, "parallel-writes-conflict-declared");
    return false;
  }
  if (input.task.independentBranchCount < 2) return false;
  if (input.task.writeIsolation !== "worktree") {
    addReason(reasons, "parallel-writes-worktree-required");
    return false;
  }
  if (input.task.parallelWriteSafety !== "verified-disjoint") {
    addReason(reasons, "parallel-writes-disjoint-write-sets-required");
    return false;
  }
  addReason(reasons, "parallel-writes-trusted-opt-in");
  return true;
}

function projectAttemptsModeChoice(project: ProjectExecutionPolicy | undefined, pinned: ExecutionRouteMode): boolean {
  if (!project) return false;
  return (project.requestedMode !== undefined && project.requestedMode !== "automatic" && project.requestedMode !== pinned)
    || (project.maxMode !== undefined && modeRank(project.maxMode) < modeRank(pinned));
}

function addReason(reasons: ExecutionRouteReason[], reason: ExecutionRouteReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function modeRank(mode: ExecutionRouteMode): number {
  return MODE_ORDER.indexOf(mode);
}

function validateInput(input: unknown): asserts input is ExecutionRoutingInput {
  const root = record(input);
  exactKeys(root, ["user", "task", "project"]);
  const user = record(root.user);
  exactKeys(user, ["mode", "maxMode", "allowParallelWrites"]);
  enumValue(user.mode, DECLARED_MODES);
  enumValue(user.maxMode, MODE_ORDER);
  booleanValue(user.allowParallelWrites);

  const task = record(root.task);
  exactKeys(task, [
    "category",
    "risk",
    "expectedSteps",
    "independentBranchCount",
    "durabilityRequired",
    "mutation",
    "writeIsolation",
    "parallelWriteSafety",
  ]);
  enumValue(task.category, TASK_CATEGORIES);
  enumValue(task.risk, TASK_RISKS);
  boundedInteger(task.expectedSteps, 1, 1_000);
  boundedInteger(task.independentBranchCount, 1, 128);
  if ((task.independentBranchCount as number) > (task.expectedSteps as number)) {
    throw new ExecutionRoutingError("invalid-input");
  }
  booleanValue(task.durabilityRequired);
  enumValue(task.mutation, MUTATIONS);
  enumValue(task.writeIsolation, WRITE_ISOLATIONS);
  enumValue(task.parallelWriteSafety, PARALLEL_WRITE_SAFETY);
  validateTaskFeatureConsistency(task as unknown as ExecutionTaskFeatures);

  if (root.project !== undefined) {
    const project = record(root.project);
    exactKeys(project, ["requestedMode", "maxMode", "allowParallelWrites"]);
    if (project.requestedMode !== undefined) enumValue(project.requestedMode, DECLARED_MODES);
    if (project.maxMode !== undefined) enumValue(project.maxMode, MODE_ORDER);
    if (project.allowParallelWrites !== undefined) booleanValue(project.allowParallelWrites);
  }
}

function validateTaskFeatureConsistency(task: ExecutionTaskFeatures): void {
  if (task.mutation === "read-only") {
    if (task.writeIsolation !== "none" || task.parallelWriteSafety !== "not-applicable") {
      throw new ExecutionRoutingError("invalid-input");
    }
    return;
  }

  if (task.parallelWriteSafety === "not-applicable"
    || (task.category === "conflicting-writes") !== (task.parallelWriteSafety === "conflicting")
    || (task.parallelWriteSafety === "verified-disjoint" && task.independentBranchCount < 2)) {
    throw new ExecutionRoutingError("invalid-input");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutionRoutingError("invalid-input");
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null)
    || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new ExecutionRoutingError("invalid-input");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new ExecutionRoutingError("unexpected-field");
    }
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ExecutionRoutingError("invalid-input");
  }
}

function booleanValue(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new ExecutionRoutingError("invalid-input");
}

function boundedInteger(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ExecutionRoutingError("invalid-input");
  }
}
