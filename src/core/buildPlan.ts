import { createHash } from "node:crypto";
import {
  compileGraph,
  type CompiledGraph,
  type GraphDefinition,
  type SideEffectClass,
} from "./graph.js";
import { requireBuildRepositoryPath } from "./repositoryPath.js";

export type BuildHandlerKind = "inspect" | "design" | "implement" | "validate" | "integrate";
export type BuildToolPolicy = "read-only" | "declared-writes" | "reviewed-validation" | "human-integration";
export type BuildWorkspace = "shared" | "isolated-worktree";
export type BuildIdempotencyPolicy = "none" | "keyed" | "read-replay-safe";
export type BuildContractKind = "artifact" | "file-set" | "evidence";
export type BuildValidationKind = "exists" | "sha256" | "structured" | "reviewed-command" | "human-review";
export type BuildResourceKind = "path" | "logical";
export type BuildResourceMode = "shared" | "exclusive";

export interface BuildOutputContract {
  id: string;
  kind: BuildContractKind;
  validation: BuildValidationKind;
  validatorRef?: string;
}

export interface BuildResourceLock {
  kind: BuildResourceKind;
  value: string;
  mode: BuildResourceMode;
}

export interface BuildNode {
  id: string;
  handler: BuildHandlerKind;
  priority: number;
  objective: string;
  instructions: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  inputContracts: string[];
  outputContracts: BuildOutputContract[];
  toolPolicy: BuildToolPolicy;
  sideEffect: SideEffectClass;
  workspace: BuildWorkspace;
  targetWorktreeNodeId?: string;
  idempotency: BuildIdempotencyPolicy;
  resourceLocks: BuildResourceLock[];
  writeSet: string[];
  retryLimit: number;
  timeoutMs: number;
}

export interface BuildDependency {
  from: string;
  to: string;
  contracts: string[];
}

export interface BuildJoin {
  nodeId: string;
  mode: "all_of";
}

export interface BuildPlan {
  schemaVersion: 1;
  id: string;
  planVersion: number;
  summary: string;
  entry: string;
  exit: string;
  nodes: BuildNode[];
  dependencies: BuildDependency[];
  joins: BuildJoin[];
}

export interface BuildPlanLimits {
  maxSerializedBytes: number;
  maxSummaryBytes: number;
  maxNodes: number;
  maxDependencies: number;
  maxFanOut: number;
  maxContractsPerNode: number;
  maxResourceLocksPerNode: number;
  maxWritePathsPerNode: number;
  maxTotalDeclaredPaths: number;
  maxWriteNodes: number;
  maxExternalNodes: number;
  maxRetryLimit: number;
  maxTimeoutMs: number;
  maxPriority: number;
}

export interface BuildSchedulerMetadata {
  priorities: Readonly<Record<string, number>>;
}

export interface BuildNodePolicy {
  handler: BuildHandlerKind;
  toolPolicy: BuildToolPolicy;
  workspace: BuildWorkspace;
  targetWorktreeNodeId?: string;
  idempotency: BuildIdempotencyPolicy;
  resourceLocks: readonly Readonly<BuildResourceLock>[];
  writeSet: readonly string[];
}

export interface CompiledBuildPlan {
  plan: Readonly<BuildPlan>;
  hash: string;
  canonicalJson: string;
  graph: CompiledGraph;
  schedulerMetadata: Readonly<BuildSchedulerMetadata>;
  nodePolicies: Readonly<Record<string, Readonly<BuildNodePolicy>>>;
}

export const DEFAULT_BUILD_PLAN_LIMITS: Readonly<BuildPlanLimits> = Object.freeze({
  maxSerializedBytes: 512 * 1024,
  maxSummaryBytes: 16 * 1024,
  maxNodes: 64,
  maxDependencies: 256,
  maxFanOut: 16,
  maxContractsPerNode: 32,
  maxResourceLocksPerNode: 32,
  maxWritePathsPerNode: 64,
  maxTotalDeclaredPaths: 512,
  maxWriteNodes: 32,
  maxExternalNodes: 1,
  maxRetryLimit: 3,
  maxTimeoutMs: 30 * 60 * 1_000,
  maxPriority: 1_000,
});

const BUILD_PLAN_KEYS = [
  "schemaVersion", "id", "planVersion", "summary", "entry", "exit", "nodes", "dependencies", "joins",
] as const;
const BUILD_NODE_KEYS = [
  "id", "handler", "priority", "objective", "instructions", "acceptanceCriteria", "verificationCommands",
  "inputContracts", "outputContracts", "toolPolicy", "sideEffect", "workspace",
  "targetWorktreeNodeId", "idempotency", "resourceLocks", "writeSet", "retryLimit", "timeoutMs",
] as const;
const BUILD_PLAN_LIMIT_KEYS = Object.keys(DEFAULT_BUILD_PLAN_LIMITS) as (keyof BuildPlanLimits)[];
const HANDLERS = new Set<BuildHandlerKind>(["inspect", "design", "implement", "validate", "integrate"]);
const TOOL_POLICIES = new Set<BuildToolPolicy>(["read-only", "declared-writes", "reviewed-validation", "human-integration"]);
const SIDE_EFFECTS = new Set<SideEffectClass>(["none", "read", "write", "external", "irreversible"]);
const WORKSPACES = new Set<BuildWorkspace>(["shared", "isolated-worktree"]);
const IDEMPOTENCY_POLICIES = new Set<BuildIdempotencyPolicy>(["none", "keyed", "read-replay-safe"]);
const CONTRACT_KINDS = new Set<BuildContractKind>(["artifact", "file-set", "evidence"]);
const VALIDATION_KINDS = new Set<BuildValidationKind>(["exists", "sha256", "structured", "reviewed-command", "human-review"]);
const RESOURCE_KINDS = new Set<BuildResourceKind>(["path", "logical"]);
const RESOURCE_MODES = new Set<BuildResourceMode>(["shared", "exclusive"]);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const LOGICAL_RESOURCE = /^[a-z][a-z0-9]*(?:[-_.:/][a-z0-9]+)*$/;
const RESERVED_NODE_ID = "build-complete";
const MAX_IDENTIFIER_BYTES = 128;
const MAX_NODE_OBJECTIVE_BYTES = 8 * 1024;
const MAX_NODE_TEXT_BYTES = 8 * 1024;
const MAX_NODE_TEXT_ITEMS = 32;
const MAX_VERIFICATION_COMMAND_BYTES = 4 * 1024;

export function compileBuildPlan(
  value: unknown,
  limits: Readonly<BuildPlanLimits> = DEFAULT_BUILD_PLAN_LIMITS,
): CompiledBuildPlan {
  const effectiveLimits = normalizeLimits(limits);
  const normalized = normalizeBuildPlan(value, effectiveLimits);
  assertBuildPlanSemantics(normalized, effectiveLimits);

  const canonicalJson = stableJson(normalized);
  assertSerializedSize(canonicalJson, effectiveLimits.maxSerializedBytes);
  const hash = createHash("sha256").update(canonicalJson).digest("hex");
  const graph = compileGraph(buildGraphDefinition(normalized, hash));
  const schedulerMetadata = deepFreeze({
    priorities: Object.fromEntries(normalized.nodes.map((node) => [node.id, node.priority])),
  });
  const nodePolicies = deepFreeze(Object.fromEntries(normalized.nodes.map((node) => [node.id, {
    handler: node.handler,
    toolPolicy: node.toolPolicy,
    workspace: node.workspace,
    ...(node.targetWorktreeNodeId === undefined ? {} : { targetWorktreeNodeId: node.targetWorktreeNodeId }),
    idempotency: node.idempotency,
    resourceLocks: node.resourceLocks.map((resource) => ({ ...resource })),
    writeSet: [...node.writeSet],
  } satisfies BuildNodePolicy])));
  const frozenPlan = deepFreeze(normalized);

  return Object.freeze({
    plan: frozenPlan,
    hash,
    canonicalJson,
    graph,
    schedulerMetadata,
    nodePolicies,
  });
}

/**
 * Compatibility bridge for an already-approved prose-only plan. Topology is
 * never parsed from Markdown: the entire legacy BUILD is one shared writer,
 * and the caller must provide the explicit repository scope captured at
 * migration time.
 */
export function compileLegacySequentialBuildPlan(
  planTextValue: string,
  planVersion: number,
  writableRepositoryRootsValue: readonly string[],
): CompiledBuildPlan {
  if (typeof planTextValue !== "string" || planTextValue.trim().length === 0) {
    throw new Error("Legacy prose plan must be non-empty");
  }
  const planText = planTextValue.trim();
  if (Buffer.byteLength(planText, "utf8") > DEFAULT_BUILD_PLAN_LIMITS.maxSerializedBytes) {
    throw new Error("Legacy prose plan exceeds the BUILD-plan migration limit");
  }
  if (!Number.isSafeInteger(planVersion) || planVersion <= 0) {
    throw new Error("Legacy prose plan version must be a positive integer");
  }
  if (!Array.isArray(writableRepositoryRootsValue) || writableRepositoryRootsValue.length === 0) {
    throw new Error("Legacy prose plan requires a non-empty explicit write scope");
  }
  const writeSet = [...new Set(writableRepositoryRootsValue.map((path, index) =>
    requireBuildRepositoryPath(path, `legacy write scope ${index}`)))].sort(comparePaths);
  for (let index = 1; index < writeSet.length; index += 1) {
    if (pathsOverlap(writeSet[index - 1]!, writeSet[index]!)) {
      throw new Error("Legacy prose plan write scope contains overlapping paths");
    }
  }
  const proseHash = createHash("sha256").update(planText).digest("hex");
  const firstLine = planText.split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").slice(0, 240);
  return compileBuildPlan({
    schemaVersion: 1,
    id: "legacy-build",
    planVersion,
    summary: `Legacy prose plan ${proseHash.slice(0, 16)}: ${firstLine}`,
    entry: "legacy-build",
    exit: "legacy-build",
    nodes: [{
      id: "legacy-build",
      handler: "implement",
      priority: 0,
      objective: "Execute the complete approved legacy implementation plan.",
      instructions: [planText],
      acceptanceCriteria: ["The approved legacy plan is implemented without changing orchestrator-owned artifacts."],
      verificationCommands: [],
      inputContracts: [],
      outputContracts: [{ id: "legacy-build-output", kind: "file-set", validation: "sha256" }],
      toolPolicy: "declared-writes",
      sideEffect: "write",
      workspace: "shared",
      idempotency: "keyed",
      resourceLocks: writeSet.map((value) => ({ kind: "path", value, mode: "exclusive" })),
      writeSet,
      retryLimit: 0,
      timeoutMs: DEFAULT_BUILD_PLAN_LIMITS.maxTimeoutMs,
    }],
    dependencies: [],
    joins: [],
  } satisfies BuildPlan);
}

/**
 * Compare re-plans by their executable content while excluding the immutable
 * reservation number. A new planVersion alone is not evidence of progress.
 */
export function buildPlanContentFingerprint(compiled: Readonly<CompiledBuildPlan>): string {
  const { planVersion: _planVersion, ...content } = compiled.plan;
  return createHash("sha256")
    .update(`build-plan-content-v1\0${stableJson(content)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Render human-facing Markdown only from the validated canonical graph. */
export function renderBuildPlanMarkdown(compiled: Readonly<CompiledBuildPlan>): string {
  const lines = [
    `# ${renderMarkdownText(compiled.plan.summary)}`,
    "",
    `Plan id: \`${compiled.plan.id}\`  `,
    `Plan version: ${compiled.plan.planVersion}  `,
    `Plan hash: \`${compiled.hash}\``,
    "",
    "## BUILD nodes",
    "",
  ];
  for (const node of compiled.plan.nodes) {
    lines.push(
      `### ${node.id}`,
      "",
      `- Handler: \`${node.handler}\``,
      `- Objective: ${renderMarkdownText(node.objective)}`,
      `- Workspace: \`${node.workspace}\``,
      `- Tool policy: \`${node.toolPolicy}\``,
      `- Side effect: \`${node.sideEffect}\``,
      `- Inputs: ${node.inputContracts.length > 0 ? node.inputContracts.map((item) => `\`${item}\``).join(", ") : "none"}`,
      `- Outputs: ${node.outputContracts.map((item) => `\`${item.id}\` (${item.validation})`).join(", ")}`,
      `- Write set: ${node.writeSet.length > 0 ? node.writeSet.map((item) => `\`${item}\``).join(", ") : "none"}`,
      "- Instructions:",
      ...node.instructions.map((item) => `  - ${renderMarkdownText(item)}`),
      "- Acceptance criteria:",
      ...node.acceptanceCriteria.map((item) => `  - ${renderMarkdownText(item)}`),
      `- Verification commands: ${node.verificationCommands.length > 0
        ? node.verificationCommands.map((item) => `\`${renderMarkdownText(item)}\``).join(", ")
        : "none"}`,
      "",
    );
  }
  lines.push("## Dependency order", "");
  if (compiled.plan.dependencies.length === 0) lines.push("Single sequential BUILD node.");
  else for (const edge of compiled.plan.dependencies) {
    lines.push(`- \`${edge.from}\` → \`${edge.to}\` via ${edge.contracts.map((item) => `\`${item}\``).join(", ")}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderMarkdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r\n?|\n/g, "<br>");
}

function normalizeBuildPlan(value: unknown, limits: Readonly<BuildPlanLimits>): BuildPlan {
  const source = requireRecord(value, "BUILD plan");
  assertOnlyKeys(source, BUILD_PLAN_KEYS, "BUILD plan");
  if (source.schemaVersion !== 1) throw new Error(`Unsupported BUILD-plan schema version: ${String(source.schemaVersion)}`);
  const id = requireIdentifier(source.id, "BUILD-plan id");
  const planVersion = requirePositiveInteger(source.planVersion, "BUILD-plan version");
  const summary = requireBoundedText(source.summary, "BUILD-plan summary", limits.maxSummaryBytes);
  const entry = requireIdentifier(source.entry, "BUILD-plan entry");
  const exit = requireIdentifier(source.exit, "BUILD-plan exit");
  const nodeValues = requireArray(source.nodes, "BUILD-plan nodes");
  const dependencyValues = requireArray(source.dependencies, "BUILD-plan dependencies");
  const joinValues = requireArray(source.joins, "BUILD-plan joins");
  if (nodeValues.length > limits.maxNodes) throw new Error(`BUILD-plan node limit exceeded: ${nodeValues.length} > ${limits.maxNodes}`);
  if (dependencyValues.length > limits.maxDependencies) {
    throw new Error(`BUILD-plan dependency limit exceeded: ${dependencyValues.length} > ${limits.maxDependencies}`);
  }
  if (joinValues.length > limits.maxNodes) throw new Error(`BUILD-plan join limit exceeded: ${joinValues.length} > ${limits.maxNodes}`);

  const nodes = nodeValues.map((node, index) => normalizeNode(node, index, limits)).sort(compareNode);
  const dependencies = dependencyValues.map((edge, index) => normalizeDependency(edge, index, limits)).sort(compareDependency);
  const joins = joinValues.map((join, index) => normalizeJoin(join, index)).sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId));
  return { schemaVersion: 1, id, planVersion, summary, entry, exit, nodes, dependencies, joins };
}

function normalizeNode(value: unknown, index: number, limits: Readonly<BuildPlanLimits>): BuildNode {
  const source = requireRecord(value, `BUILD node ${index}`);
  assertOnlyKeys(source, BUILD_NODE_KEYS, `BUILD node ${index}`);
  const id = requireIdentifier(source.id, `BUILD node ${index} id`);
  if (id === RESERVED_NODE_ID) throw new Error(`BUILD node id ${id} is reserved`);
  const handler = requireEnum(source.handler, HANDLERS, `handler for ${id}`);
  const priority = requireBoundedInteger(source.priority, limits.maxPriority, `priority for ${id}`);
  const objective = requireBoundedText(source.objective, `objective for ${id}`, MAX_NODE_OBJECTIVE_BYTES);
  const instructions = normalizeOrderedText(
    source.instructions,
    `instructions for ${id}`,
    MAX_NODE_TEXT_ITEMS,
    MAX_NODE_TEXT_BYTES,
    true,
  );
  const acceptanceCriteria = normalizeOrderedText(
    source.acceptanceCriteria,
    `acceptance criteria for ${id}`,
    MAX_NODE_TEXT_ITEMS,
    MAX_NODE_TEXT_BYTES,
    true,
  );
  const verificationCommands = normalizeOrderedText(
    source.verificationCommands,
    `verification commands for ${id}`,
    MAX_NODE_TEXT_ITEMS,
    MAX_VERIFICATION_COMMAND_BYTES,
    false,
  );
  const inputContracts = normalizeContractIds(source.inputContracts, `input contracts for ${id}`, limits.maxContractsPerNode);
  const outputValues = requireArray(source.outputContracts, `output contracts for ${id}`);
  if (inputContracts.length + outputValues.length > limits.maxContractsPerNode) {
    throw new Error(`BUILD node ${id} contract limit exceeded`);
  }
  const outputContracts = outputValues.map((contract, contractIndex) => normalizeOutputContract(contract, id, contractIndex))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  assertUnique(outputContracts.map((contract) => contract.id), `duplicate output contract for ${id}`);
  if (outputContracts.length === 0) throw new Error(`BUILD node ${id} must declare a non-empty output contract`);
  const toolPolicy = requireEnum(source.toolPolicy, TOOL_POLICIES, `tool policy for ${id}`);
  const sideEffect = requireEnum(source.sideEffect, SIDE_EFFECTS, `side-effect for ${id}`);
  const workspace = requireEnum(source.workspace, WORKSPACES, `workspace for ${id}`);
  const targetWorktreeNodeId = source.targetWorktreeNodeId === undefined
    ? undefined
    : requireIdentifier(source.targetWorktreeNodeId, `target worktree node for ${id}`);
  const idempotency = requireEnum(source.idempotency, IDEMPOTENCY_POLICIES, `idempotency policy for ${id}`);
  const resourceValues = requireArray(source.resourceLocks, `resource locks for ${id}`);
  if (resourceValues.length > limits.maxResourceLocksPerNode) throw new Error(`BUILD node ${id} resource-lock limit exceeded`);
  const resourceLocks = resourceValues.map((resource, resourceIndex) => normalizeResource(resource, id, resourceIndex))
    .sort(compareResource);
  assertUnique(
    resourceLocks.map((resource) => `${resource.kind}:${resource.value.toLowerCase()}:${resource.mode}`),
    `duplicate resource lock for ${id}`,
  );
  const writeSet = normalizePaths(source.writeSet, `write set for ${id}`, limits.maxWritePathsPerNode);
  const retryLimit = requireNonNegativeInteger(source.retryLimit, `retry limit for ${id}`);
  if (retryLimit > limits.maxRetryLimit) throw new Error(`BUILD node ${id} retry limit exceeded`);
  const timeoutMs = requirePositiveInteger(source.timeoutMs, `timeout for ${id}`);
  if (timeoutMs > limits.maxTimeoutMs) throw new Error(`BUILD node ${id} timeout limit exceeded`);

  const normalized: BuildNode = {
    id,
    handler,
    priority,
    objective,
    instructions,
    acceptanceCriteria,
    verificationCommands,
    inputContracts,
    outputContracts,
    toolPolicy,
    sideEffect,
    workspace,
    ...(targetWorktreeNodeId === undefined ? {} : { targetWorktreeNodeId }),
    idempotency,
    resourceLocks,
    writeSet,
    retryLimit,
    timeoutMs,
  };
  assertNodePolicy(normalized);
  return normalized;
}

function normalizeOutputContract(value: unknown, nodeId: string, index: number): BuildOutputContract {
  const source = requireRecord(value, `output contract ${index} for ${nodeId}`);
  assertOnlyKeys(source, ["id", "kind", "validation", "validatorRef"], `output contract ${index} for ${nodeId}`);
  const validation = requireEnum(source.validation, VALIDATION_KINDS, `output validation for ${nodeId}`);
  const validatorRef = source.validatorRef === undefined
    ? undefined
    : requireIdentifier(source.validatorRef, `output validator reference for ${nodeId}`);
  const requiresReference = validation === "structured" || validation === "reviewed-command" || validation === "human-review";
  if (requiresReference !== (validatorRef !== undefined)) {
    throw new Error(`BUILD output ${String(source.id)} validation ${validation} has an invalid validator reference`);
  }
  return {
    id: requireIdentifier(source.id, `output contract ${index} for ${nodeId}`),
    kind: requireEnum(source.kind, CONTRACT_KINDS, `output contract kind for ${nodeId}`),
    validation,
    ...(validatorRef === undefined ? {} : { validatorRef }),
  };
}

function normalizeResource(value: unknown, nodeId: string, index: number): BuildResourceLock {
  const source = requireRecord(value, `resource lock ${index} for ${nodeId}`);
  assertOnlyKeys(source, ["kind", "value", "mode"], `resource lock ${index} for ${nodeId}`);
  const kind = requireEnum(source.kind, RESOURCE_KINDS, `resource kind for ${nodeId}`);
  const mode = requireEnum(source.mode, RESOURCE_MODES, `resource mode for ${nodeId}`);
  if (kind === "logical") {
    if (typeof source.value !== "string" || Buffer.byteLength(source.value, "utf8") > MAX_IDENTIFIER_BYTES ||
        !LOGICAL_RESOURCE.test(source.value)) {
      throw new Error(`BUILD node ${nodeId} logical resource must be a bounded canonical token`);
    }
    return { kind, value: source.value, mode };
  }
  return { kind, value: requireBuildRepositoryPath(source.value, `path resource for ${nodeId}`), mode };
}

function normalizeDependency(value: unknown, index: number, limits: Readonly<BuildPlanLimits>): BuildDependency {
  const source = requireRecord(value, `BUILD dependency ${index}`);
  assertOnlyKeys(source, ["from", "to", "contracts"], `BUILD dependency ${index}`);
  const from = requireIdentifier(source.from, `BUILD dependency ${index} source`);
  const to = requireIdentifier(source.to, `BUILD dependency ${index} target`);
  const contracts = normalizeContractIds(source.contracts, `BUILD dependency ${from} -> ${to} contracts`, limits.maxContractsPerNode);
  if (contracts.length === 0) throw new Error(`BUILD dependency ${from} -> ${to} must bind a non-empty contract`);
  return { from, to, contracts };
}

function normalizeJoin(value: unknown, index: number): BuildJoin {
  const source = requireRecord(value, `BUILD join ${index}`);
  assertOnlyKeys(source, ["nodeId", "mode"], `BUILD join ${index}`);
  const nodeId = requireIdentifier(source.nodeId, `BUILD join ${index} node`);
  if (source.mode !== "all_of") throw new Error(`Unsupported BUILD join mode for ${nodeId}: ${String(source.mode)}`);
  return { nodeId, mode: "all_of" };
}

function assertBuildPlanSemantics(plan: BuildPlan, limits: Readonly<BuildPlanLimits>): void {
  const nodesById = new Map<string, BuildNode>();
  for (const node of plan.nodes) {
    if (nodesById.has(node.id)) throw new Error(`Duplicate BUILD node id: ${node.id}`);
    nodesById.set(node.id, node);
  }
  const entry = nodesById.get(plan.entry);
  const exit = nodesById.get(plan.exit);
  if (!entry) throw new Error(`BUILD-plan entry node does not exist: ${plan.entry}`);
  if (!exit) throw new Error(`BUILD-plan exit node does not exist: ${plan.exit}`);

  const globalOutputs = new Map<string, string>();
  for (const node of plan.nodes) {
    for (const contract of node.outputContracts) {
      const owner = globalOutputs.get(contract.id);
      if (owner) throw new Error(`BUILD output contract ${contract.id} is declared by both ${owner} and ${node.id}`);
      globalOutputs.set(contract.id, node.id);
    }
  }

  const incoming = new Map(plan.nodes.map((node) => [node.id, [] as BuildDependency[]]));
  const outgoing = new Map(plan.nodes.map((node) => [node.id, [] as BuildDependency[]]));
  const dependencyKeys = new Set<string>();
  for (const dependency of plan.dependencies) {
    const source = nodesById.get(dependency.from);
    const target = nodesById.get(dependency.to);
    if (!source) throw new Error(`BUILD dependency source does not exist: ${dependency.from}`);
    if (!target) throw new Error(`BUILD dependency target does not exist: ${dependency.to}`);
    const key = `${dependency.from}\u0000${dependency.to}`;
    if (dependencyKeys.has(key)) throw new Error(`BUILD plan contains duplicate dependency ${dependency.from} -> ${dependency.to}`);
    dependencyKeys.add(key);
    incoming.get(dependency.to)!.push(dependency);
    outgoing.get(dependency.from)!.push(dependency);
    const sourceContracts = new Set(source.outputContracts.map((contract) => contract.id));
    const targetContracts = new Set(target.inputContracts);
    for (const contract of dependency.contracts) {
      if (!sourceContracts.has(contract)) {
        throw new Error(`BUILD dependency ${dependency.from} -> ${dependency.to} source lacks output contract ${contract}`);
      }
      if (!targetContracts.has(contract)) {
        throw new Error(`BUILD dependency ${dependency.from} -> ${dependency.to} target lacks input contract ${contract}`);
      }
    }
  }
  const isolatedImplementers = plan.nodes.filter((node) =>
    node.handler === "implement" && node.workspace === "isolated-worktree");
  for (const node of plan.nodes.filter((candidate) => candidate.handler === "validate")) {
    if (node.workspace === "shared") {
      const isolatedInputs = node.inputContracts.filter((contract) => {
        const owner = nodesById.get(globalOutputs.get(contract) ?? "");
        return owner?.handler === "implement" && owner.workspace === "isolated-worktree";
      });
      if (isolatedInputs.length > 0) {
        throw new Error(`BUILD shared validation ${node.id} cannot validate isolated worktree outputs`);
      }
      continue;
    }
    if (!node.targetWorktreeNodeId) throw new Error(`BUILD validate node ${node.id} requires a target worktree node`);
    const target = nodesById.get(node.targetWorktreeNodeId);
    if (!target || target.handler !== "implement" || target.workspace !== "isolated-worktree") {
      throw new Error(`BUILD validate node ${node.id} target worktree must be an isolated implement node`);
    }
    const direct = incoming.get(node.id)?.find((dependency) => dependency.from === target.id);
    const outputs = target.outputContracts.map((contract) => contract.id);
    if (!direct || outputs.some((contract) => !direct.contracts.includes(contract))) {
      throw new Error(`BUILD validate node ${node.id} must bind every output from target worktree ${target.id}`);
    }
  }
  for (const implementer of isolatedImplementers) {
    if (!plan.nodes.some((node) => node.handler === "validate" &&
        node.workspace === "isolated-worktree" && node.targetWorktreeNodeId === implementer.id)) {
      throw new Error(`BUILD isolated implement node ${implementer.id} requires an explicit target-worktree validation`);
    }
  }
  if ((incoming.get(plan.entry)?.length ?? 0) > 0) throw new Error(`BUILD-plan entry ${plan.entry} cannot have an incoming dependency`);
  if (entry.inputContracts.length > 0) {
    throw new Error(`BUILD-plan entry ${plan.entry} cannot declare an input contract without predecessor provenance`);
  }
  if ((outgoing.get(plan.exit)?.length ?? 0) > 0) throw new Error(`BUILD-plan exit ${plan.exit} cannot have an outgoing dependency`);

  const joinsByNode = new Map<string, BuildJoin>();
  for (const join of plan.joins) {
    if (!nodesById.has(join.nodeId)) throw new Error(`BUILD join references unknown node: ${join.nodeId}`);
    if (joinsByNode.has(join.nodeId)) throw new Error(`Duplicate BUILD join for ${join.nodeId}`);
    joinsByNode.set(join.nodeId, join);
  }
  for (const node of plan.nodes) {
    const predecessors = incoming.get(node.id) ?? [];
    if (predecessors.length > 1 && !joinsByNode.has(node.id)) {
      throw new Error(`BUILD all_of join is required for node ${node.id}`);
    }
    if (predecessors.length <= 1 && joinsByNode.has(node.id)) {
      throw new Error(`BUILD node ${node.id} declares an all_of join without multiple dependencies`);
    }
    if (node.id !== plan.entry) {
      const bound = new Set(predecessors.flatMap((dependency) => dependency.contracts));
      for (const contract of node.inputContracts) {
        if (!bound.has(contract)) throw new Error(`BUILD node ${node.id} input contract ${contract} is not bound by a dependency`);
      }
    }
  }

  const fanOut = Math.max(0, ...[...outgoing.values()].map((dependencies) => dependencies.length));
  if (fanOut > limits.maxFanOut) throw new Error(`BUILD-plan fan-out limit exceeded: ${fanOut} > ${limits.maxFanOut}`);
  const writeNodes = plan.nodes.filter((node) => node.sideEffect === "write").length;
  if (writeNodes > limits.maxWriteNodes) throw new Error(`BUILD-plan write-node limit exceeded: ${writeNodes} > ${limits.maxWriteNodes}`);
  const totalPaths = plan.nodes.reduce((count, node) =>
    count + node.writeSet.length + node.resourceLocks.filter((resource) => resource.kind === "path").length, 0);
  if (totalPaths > limits.maxTotalDeclaredPaths) {
    throw new Error(`BUILD-plan declared-path limit exceeded: ${totalPaths} > ${limits.maxTotalDeclaredPaths}`);
  }
  for (const node of plan.nodes) {
    if (node.sideEffect === "external" && (node.handler !== "integrate" || node.id !== plan.exit)) {
      throw new Error(`BUILD external node ${node.id} must use the integrate handler at the plan exit`);
    }
    if (node.handler === "integrate" && node.id !== plan.exit) {
      throw new Error(`BUILD integrate handler ${node.id} is speculative; integration must be the plan exit`);
    }
  }
  if (plan.nodes.some((node) => node.handler === "implement" && node.workspace === "isolated-worktree") &&
      exit.handler !== "integrate") {
    throw new Error("BUILD isolated writers must terminate at an explicit human integration node");
  }
  const externalNodes = plan.nodes.filter((node) => node.sideEffect === "external").length;
  if (externalNodes > limits.maxExternalNodes) {
    throw new Error(`BUILD-plan external-node limit exceeded: ${externalNodes} > ${limits.maxExternalNodes}`);
  }

  assertNoUnorderedWriteOverlap(plan.nodes, outgoing);
}

function assertNodePolicy(node: Readonly<BuildNode>): void {
  if (node.sideEffect === "irreversible") throw new Error(`BUILD node ${node.id} cannot declare an irreversible side effect`);
  if (node.idempotency === "read-replay-safe" && node.sideEffect !== "read" && node.sideEffect !== "none") {
    throw new Error(`BUILD node ${node.id} cannot use read-replay-safe idempotency for ${node.sideEffect} work`);
  }
  if (node.retryLimit > 0 && node.idempotency === "none") {
    throw new Error(`BUILD node ${node.id} retry requires a replay-safe idempotency policy`);
  }
  if ((node.sideEffect === "write" || node.sideEffect === "external") && node.retryLimit > 0 && node.idempotency !== "keyed") {
    throw new Error(`BUILD node ${node.id} retry requires keyed idempotency for ${node.sideEffect} work`);
  }
  if (node.handler !== "validate" && node.verificationCommands.length > 0) {
    throw new Error(`BUILD node ${node.id} may execute verification commands only through a validate handler`);
  }

  for (const contract of node.outputContracts) {
    if (contract.id.startsWith("orchestrator-")) {
      throw new Error(`BUILD output contract ${node.id}/${contract.id} uses a reserved runtime prefix`);
    }
    if (contract.kind === "file-set" && node.handler !== "implement") {
      throw new Error(`BUILD file-set output ${node.id}/${contract.id} requires an implement handler`);
    }
    if (contract.validation === "structured" && contract.kind === "file-set") {
      throw new Error(`BUILD structured output ${node.id}/${contract.id} cannot use a file-set contract`);
    }
    if (contract.validation === "reviewed-command" && contract.kind !== "evidence") {
      throw new Error(`BUILD ${contract.validation} output ${node.id}/${contract.id} must use an evidence contract`);
    }
  }

  switch (node.handler) {
    case "inspect":
    case "design":
      assertExactNodePolicy(node, "read-only", "read", "shared", false);
      if (node.targetWorktreeNodeId !== undefined) throw new Error(`BUILD ${node.handler} node ${node.id} cannot target a worktree`);
      break;
    case "implement":
      assertExactNodePolicy(node, "declared-writes", "write", undefined, true);
      if (node.targetWorktreeNodeId !== undefined) throw new Error(`BUILD implement node ${node.id} cannot target another worktree`);
      break;
    case "validate":
      assertExactNodePolicy(node, "reviewed-validation", "read", undefined, false);
      if (node.workspace === "shared" && node.targetWorktreeNodeId !== undefined) {
        throw new Error(`BUILD shared validate node ${node.id} cannot target a worktree`);
      }
      if (node.outputContracts.some((contract) => contract.validation !== "reviewed-command")) {
        throw new Error(`BUILD validate node ${node.id} outputs must use reviewed-command validation`);
      }
      break;
    case "integrate":
      assertExactNodePolicy(node, "human-integration", "external", "shared", false);
      if (node.targetWorktreeNodeId !== undefined) throw new Error(`BUILD integrate node ${node.id} cannot target a worktree`);
      if (node.outputContracts.some((contract) => contract.validation !== "human-review")) {
        throw new Error(`BUILD integrate node ${node.id} outputs must use human-review validation`);
      }
      break;
  }

  for (const writePath of node.writeSet) {
    const protectedByLock = node.resourceLocks.some((resource) =>
      resource.kind === "path" && resource.mode === "exclusive" && pathContains(resource.value, writePath));
    if (!protectedByLock) throw new Error(`BUILD node ${node.id} write ${writePath} requires an exclusive path resource`);
  }
}

function assertExactNodePolicy(
  node: Readonly<BuildNode>,
  toolPolicy: BuildToolPolicy,
  sideEffect: SideEffectClass,
  workspace: BuildWorkspace | undefined,
  requiresWrites: boolean,
): void {
  if (node.toolPolicy !== toolPolicy) throw new Error(`BUILD ${node.handler} node ${node.id} has invalid tool policy ${node.toolPolicy}`);
  if (node.sideEffect !== sideEffect) throw new Error(`BUILD ${node.handler} node ${node.id} has invalid side-effect ${node.sideEffect}`);
  if (workspace && node.workspace !== workspace) throw new Error(`BUILD ${node.handler} node ${node.id} has invalid workspace ${node.workspace}`);
  if (requiresWrites && node.writeSet.length === 0) throw new Error(`BUILD implement node ${node.id} requires a non-empty write set`);
  if (!requiresWrites && node.writeSet.length > 0) throw new Error(`BUILD ${node.handler} node ${node.id} must have an empty write set`);
}

function assertNoUnorderedWriteOverlap(
  nodes: readonly BuildNode[],
  outgoing: ReadonlyMap<string, readonly BuildDependency[]>,
): void {
  const writers = nodes.filter((node) => node.writeSet.length > 0);
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex += 1) {
      const left = writers[leftIndex]!;
      const right = writers[rightIndex]!;
      if (isReachable(left.id, right.id, outgoing) || isReachable(right.id, left.id, outgoing)) continue;
      for (const leftPath of left.writeSet) {
        for (const rightPath of right.writeSet) {
          if (pathsOverlap(leftPath, rightPath)) {
            throw new Error(`BUILD nodes ${left.id} and ${right.id} declare overlapping write paths ${leftPath} and ${rightPath}`);
          }
        }
      }
    }
  }
}

function isReachable(
  from: string,
  target: string,
  outgoing: ReadonlyMap<string, readonly BuildDependency[]>,
): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of outgoing.get(current) ?? []) pending.push(edge.to);
  }
  return false;
}

function buildGraphDefinition(plan: Readonly<BuildPlan>, hash: string): GraphDefinition {
  const exit = plan.nodes.find((node) => node.id === plan.exit)!;
  return {
    schemaVersion: 1,
    id: plan.id,
    version: hash,
    kind: "dag",
    entry: plan.entry,
    nodes: [
      ...plan.nodes.map((node) => ({
        id: node.id,
        handler: node.handler,
        terminal: false,
        inputContracts: [...node.inputContracts],
        outputContracts: node.outputContracts.map((contract) => contract.id),
        sideEffect: node.sideEffect,
        timeoutMs: node.timeoutMs,
        retryBudget: node.retryLimit,
      })),
      {
        id: RESERVED_NODE_ID,
        handler: RESERVED_NODE_ID,
        terminal: true,
        inputContracts: exit.outputContracts.map((contract) => contract.id),
        outputContracts: [],
        sideEffect: "none",
        timeoutMs: 1,
        retryBudget: 0,
      },
    ],
    edges: [
      ...plan.dependencies.map((dependency) => ({
        from: dependency.from,
        to: dependency.to,
        event: `dependency-${dependency.to}`,
      })),
      { from: plan.exit, to: RESERVED_NODE_ID, event: "complete" },
    ],
  };
}

function normalizeLimits(value: Readonly<BuildPlanLimits>): BuildPlanLimits {
  const source = requireRecord(value, "build-plan limits");
  assertOnlyKeys(source, BUILD_PLAN_LIMIT_KEYS, "build-plan limits");
  const normalized = {} as Record<keyof BuildPlanLimits, number>;
  for (const key of BUILD_PLAN_LIMIT_KEYS) {
    normalized[key] = requireNonNegativeInteger(source[key], `build-plan limit ${key}`);
  }
  if (normalized.maxSerializedBytes === 0 || normalized.maxSummaryBytes === 0 || normalized.maxNodes === 0 || normalized.maxTimeoutMs === 0) {
    throw new Error("build-plan byte, summary, node, and timeout limits must be positive");
  }
  return normalized;
}

function normalizeContractIds(value: unknown, label: string, maximum: number): string[] {
  const source = requireArray(value, label);
  if (source.length > maximum) throw new Error(`${label} contract limit exceeded`);
  const contracts = source.map((contract, index) => requireIdentifier(contract, `${label} item ${index}`)).sort();
  assertUnique(contracts, `duplicate ${label}`);
  return contracts;
}

function normalizePaths(value: unknown, label: string, maximum: number): string[] {
  const source = requireArray(value, label);
  if (source.length > maximum) throw new Error(`BUILD write-path limit exceeded for ${label}`);
  const paths = source.map((path, index) => requireBuildRepositoryPath(path, `${label} item ${index}`)).sort(comparePaths);
  assertUnique(paths.map((path) => path.toLowerCase()), `duplicate ${label}`);
  for (let index = 1; index < paths.length; index += 1) {
    if (pathsOverlap(paths[index - 1]!, paths[index]!)) throw new Error(`${label} contains overlapping repository paths`);
  }
  return paths;
}

function normalizeOrderedText(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemBytes: number,
  requireNonEmpty: boolean,
): string[] {
  const source = requireArray(value, label);
  if (source.length > maximumItems || (requireNonEmpty && source.length === 0)) {
    throw new Error(`${label} must contain ${requireNonEmpty ? "between 1 and" : "at most"} ${maximumItems} items`);
  }
  const normalized = source.map((item, index) =>
    requireBoundedText(item, `${label} item ${index}`, maximumItemBytes));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate items`);
  return normalized;
}

function pathContains(parent: string, child: string): boolean {
  const normalizedParent = parent.toLowerCase();
  const normalizedChild = child.toLowerCase();
  return normalizedParent === normalizedChild || normalizedChild.startsWith(`${normalizedParent}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) ||
      descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain object containing data properties`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} contains unsupported symbol fields`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} must be a dense data-property array`);
  }
  const unexpected = Reflect.ownKeys(descriptors).filter((key) => typeof key !== "string" ||
    (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported array properties`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a bounded canonical identifier`);
  }
  return value;
}

function requireBoundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} must be non-empty, trimmed, and at most ${maximumBytes} bytes`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`Invalid ${label}: ${String(value)}`);
  return value as T;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function requireBoundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > maximum) throw new Error(`${label} exceeds the priority limit`);
  return value as number;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly (string | number | symbol)[], label: string): void {
  const extras = Reflect.ownKeys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(label);
}

function assertSerializedSize(serialized: string, maximum: number): void {
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    throw new Error(`BUILD plan exceeds the ${maximum}-byte serialized limit`);
  }
}

function compareNode(left: Readonly<BuildNode>, right: Readonly<BuildNode>): number {
  return compareCodeUnits(left.id, right.id);
}

function compareDependency(left: Readonly<BuildDependency>, right: Readonly<BuildDependency>): number {
  return compareCodeUnits(left.from, right.from) || compareCodeUnits(left.to, right.to);
}

function compareResource(left: Readonly<BuildResourceLock>, right: Readonly<BuildResourceLock>): number {
  return compareCodeUnits(left.kind, right.kind) || comparePaths(left.value, right.value) || compareCodeUnits(left.mode, right.mode);
}

function comparePaths(left: string, right: string): number {
  return compareCodeUnits(left.toLowerCase(), right.toLowerCase()) || compareCodeUnits(left, right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
