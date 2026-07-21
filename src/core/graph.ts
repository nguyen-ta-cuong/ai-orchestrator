export type GraphKind = "state-machine" | "dag";

export type SideEffectClass = "none" | "read" | "write" | "external" | "irreversible";

export interface GraphNodeDefinition {
  id: string;
  handler: string;
  terminal?: boolean;
  inputContracts: string[];
  outputContracts: string[];
  sideEffect: SideEffectClass;
  timeoutMs: number;
  retryBudget: number;
}

export interface GraphEdgeDefinition {
  from: string;
  to: string;
  event: string;
  guard?: string;
  boundedBy?: string;
}

export interface GraphDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: GraphKind;
  entry: string;
  nodes: GraphNodeDefinition[];
  edges: GraphEdgeDefinition[];
}

export interface CompiledGraph {
  definition: Readonly<GraphDefinition>;
  nodesById: ReadonlyMap<string, Readonly<GraphNodeDefinition>>;
  outgoingByNode: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>;
  topologicalOrder?: readonly string[];
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SIDE_EFFECTS = new Set<SideEffectClass>(["none", "read", "write", "external", "irreversible"]);

export function compileGraph(definition: GraphDefinition): CompiledGraph {
  validateDefinitionHeader(definition);

  const nodes = definition.nodes.map(cloneAndValidateNode).sort((left, right) => left.id.localeCompare(right.id));
  const mutableNodesById = new Map<string, Readonly<GraphNodeDefinition>>();
  for (const node of nodes) {
    if (mutableNodesById.has(node.id)) throw new Error(`Duplicate graph node id: ${node.id}`);
    mutableNodesById.set(node.id, node);
  }
  if (!mutableNodesById.has(definition.entry)) throw new Error(`Graph entry node does not exist: ${definition.entry}`);

  const edges = definition.edges.map((edge) => cloneAndValidateEdge(edge, mutableNodesById)).sort(compareEdges);
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.event}\u0000${edge.guard ?? ""}`;
    if (edgeKeys.has(key)) {
      throw new Error(`Ambiguous graph edges for ${edge.from}/${edge.event}/${edge.guard ?? "<unguarded>"}`);
    }
    edgeKeys.add(key);
  }

  const mutableOutgoingByNode = new Map<string, readonly Readonly<GraphEdgeDefinition>[]>() as Map<
    string,
    readonly Readonly<GraphEdgeDefinition>[]
  >;
  for (const node of nodes) mutableOutgoingByNode.set(node.id, Object.freeze([]));
  for (const node of nodes) {
    mutableOutgoingByNode.set(node.id, Object.freeze(edges.filter((edge) => edge.from === node.id)));
  }

  const nodesById = new ImmutableMap(mutableNodesById);
  const outgoingByNode = new ImmutableMap(mutableOutgoingByNode);

  assertReachable(definition.entry, nodesById, outgoingByNode);
  assertTerminalReachability(nodesById, outgoingByNode);

  const topologicalOrder = topologicalSort(nodes, outgoingByNode);
  if (definition.kind === "dag" && topologicalOrder === undefined) {
    throw new Error("DAG graph contains a cycle");
  }
  if (definition.kind === "state-machine") assertBackEdgesAreBounded(definition.entry, outgoingByNode);

  const canonicalDefinition = Object.freeze({
    schemaVersion: 1 as const,
    id: definition.id,
    version: definition.version,
    kind: definition.kind,
    entry: definition.entry,
    nodes: Object.freeze(nodes) as unknown as GraphNodeDefinition[],
    edges: Object.freeze(edges) as unknown as GraphEdgeDefinition[],
  });

  return Object.freeze({
    definition: canonicalDefinition,
    nodesById,
    outgoingByNode,
    ...(topologicalOrder ? { topologicalOrder: Object.freeze(topologicalOrder) } : {}),
  });
}

export function renderGraphMermaid(graph: CompiledGraph): string {
  const lines = ["flowchart TD"];
  for (const node of graph.definition.nodes) {
    const label = escapeMermaid(node.id);
    lines.push(node.terminal ? `    ${mermaidId(node.id)}(["${label}"])` : `    ${mermaidId(node.id)}["${label}"]`);
  }
  for (const edge of graph.definition.edges) {
    const details = [edge.event, edge.guard, edge.boundedBy ? `bounded by ${edge.boundedBy}` : undefined]
      .filter((value): value is string => value !== undefined)
      .join(" / ");
    lines.push(`    ${mermaidId(edge.from)} -->|"${escapeMermaid(details)}"| ${mermaidId(edge.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

function validateDefinitionHeader(definition: GraphDefinition): void {
  if (definition.schemaVersion !== 1) throw new Error(`Unsupported graph schema version: ${String(definition.schemaVersion)}`);
  assertIdentifier(definition.id, "graph id");
  if (!VERSION.test(definition.version)) throw new Error(`Malformed graph version: ${definition.version}`);
  if (definition.kind !== "state-machine" && definition.kind !== "dag") {
    throw new Error(`Unsupported graph kind: ${String(definition.kind)}`);
  }
  assertIdentifier(definition.entry, "graph entry");
  if (definition.nodes.length === 0) throw new Error("Graph must contain at least one node");
}

function cloneAndValidateNode(node: GraphNodeDefinition): Readonly<GraphNodeDefinition> {
  assertIdentifier(node.id, "node id");
  assertIdentifier(node.handler, `handler for node ${node.id}`);
  if (!SIDE_EFFECTS.has(node.sideEffect)) throw new Error(`Invalid side-effect class for node ${node.id}`);
  if (!Number.isFinite(node.timeoutMs) || !Number.isInteger(node.timeoutMs) || node.timeoutMs <= 0) {
    throw new Error(`Node ${node.id} timeoutMs must be a positive integer`);
  }
  if (!Number.isFinite(node.retryBudget) || !Number.isInteger(node.retryBudget) || node.retryBudget < 0) {
    throw new Error(`Node ${node.id} retryBudget must be a non-negative integer`);
  }
  const inputContracts = validateContracts(node.inputContracts, node.id, "input");
  const outputContracts = validateContracts(node.outputContracts, node.id, "output");
  if ((node.sideEffect === "external" || node.sideEffect === "irreversible") && outputContracts.length === 0) {
    throw new Error(`High-impact node ${node.id} must declare an output contract`);
  }
  if (outputContracts.some((contract) => contract === "speculative-join")) {
    throw new Error(`Node ${node.id} uses unsupported speculative-join output contract`);
  }
  return Object.freeze({
    id: node.id,
    handler: node.handler,
    ...(node.terminal === undefined ? {} : { terminal: node.terminal }),
    inputContracts,
    outputContracts,
    sideEffect: node.sideEffect,
    timeoutMs: node.timeoutMs,
    retryBudget: node.retryBudget,
  });
}

function validateContracts(contracts: string[], nodeId: string, direction: string): string[] {
  if (!Array.isArray(contracts)) throw new Error(`Node ${nodeId} ${direction}Contracts must be an array`);
  const copy = contracts.map((contract) => {
    if (typeof contract !== "string" || contract.trim() === "") {
      throw new Error(`Node ${nodeId} has an empty ${direction} contract`);
    }
    return contract;
  });
  if (new Set(copy).size !== copy.length) throw new Error(`Node ${nodeId} has duplicate ${direction} contracts`);
  return Object.freeze(copy) as unknown as string[];
}

function cloneAndValidateEdge(
  edge: GraphEdgeDefinition,
  nodesById: ReadonlyMap<string, Readonly<GraphNodeDefinition>>,
): Readonly<GraphEdgeDefinition> {
  assertIdentifier(edge.from, "edge source");
  assertIdentifier(edge.to, "edge target");
  assertIdentifier(edge.event, "edge event");
  if (!nodesById.has(edge.from)) throw new Error(`Graph edge source does not exist: ${edge.from}`);
  if (!nodesById.has(edge.to)) throw new Error(`Graph edge target does not exist: ${edge.to}`);
  if (edge.guard !== undefined) assertIdentifier(edge.guard, "edge guard");
  if (edge.boundedBy !== undefined) assertIdentifier(edge.boundedBy, "edge boundedBy");
  return Object.freeze({
    from: edge.from,
    to: edge.to,
    event: edge.event,
    ...(edge.guard === undefined ? {} : { guard: edge.guard }),
    ...(edge.boundedBy === undefined ? {} : { boundedBy: edge.boundedBy }),
  });
}

function assertReachable(
  entry: string,
  nodesById: ReadonlyMap<string, Readonly<GraphNodeDefinition>>,
  outgoing: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>,
): void {
  const reachable = visitFrom(entry, outgoing);
  const missing = [...nodesById.keys()].filter((id) => !reachable.has(id));
  if (missing.length > 0) throw new Error(`Unreachable graph nodes: ${missing.join(", ")}`);
}

function assertTerminalReachability(
  nodesById: ReadonlyMap<string, Readonly<GraphNodeDefinition>>,
  outgoing: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>,
): void {
  const terminals = new Set([...nodesById.values()].filter((node) => node.terminal).map((node) => node.id));
  if (terminals.size === 0) throw new Error("Graph must contain at least one terminal node");
  const reverse = new Map<string, string[]>();
  for (const id of nodesById.keys()) reverse.set(id, []);
  for (const edges of outgoing.values()) {
    for (const edge of edges) reverse.get(edge.to)?.push(edge.from);
  }
  const canTerminate = new Set(terminals);
  const pending = [...terminals];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const predecessor of reverse.get(current) ?? []) {
      if (!canTerminate.has(predecessor)) {
        canTerminate.add(predecessor);
        pending.push(predecessor);
      }
    }
  }
  const trapped = [...nodesById.keys()].filter((id) => !canTerminate.has(id));
  if (trapped.length > 0) throw new Error(`Graph nodes cannot reach a terminal: ${trapped.join(", ")}`);
}

function topologicalSort(
  nodes: readonly Readonly<GraphNodeDefinition>[],
  outgoing: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>,
): string[] | undefined {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edges of outgoing.values()) for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const next = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, next);
      if (next === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }
  return order.length === nodes.length ? order : undefined;
}

function assertBackEdgesAreBounded(
  entry: string,
  outgoing: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>,
): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (id: string): void => {
    visited.add(id);
    active.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (active.has(edge.to) && edge.boundedBy === undefined) {
        throw new Error(`State-machine back edge ${edge.from} -> ${edge.to} must declare boundedBy`);
      }
      if (!visited.has(edge.to)) walk(edge.to);
    }
    active.delete(id);
  };
  walk(entry);
}

function visitFrom(
  entry: string,
  outgoing: ReadonlyMap<string, readonly Readonly<GraphEdgeDefinition>[]>,
): Set<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of outgoing.get(id) ?? []) pending.push(edge.to);
  }
  return visited;
}

function compareEdges(left: Readonly<GraphEdgeDefinition>, right: Readonly<GraphEdgeDefinition>): number {
  return left.from.localeCompare(right.from)
    || left.event.localeCompare(right.event)
    || (left.guard ?? "").localeCompare(right.guard ?? "")
    || left.to.localeCompare(right.to)
    || (left.boundedBy ?? "").localeCompare(right.boundedBy ?? "");
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`Malformed ${label}: ${String(value)}`);
}

function mermaidId(id: string): string {
  return `node_${id.replaceAll("-", "_")}`;
}

function escapeMermaid(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: ReadonlyMap<K, V>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "ImmutableMap";
  }
}
