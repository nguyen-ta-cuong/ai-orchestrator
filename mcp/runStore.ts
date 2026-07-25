import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { McpRunStorageConfig } from "../src/core/config.js";
import { compileGraph, type CompiledGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  applySchedulerEvent,
  createGraphExecutionState,
  evaluateExecutionGuard,
  graphDefinitionDigest,
  graphEventDigest,
  type ArtifactReference,
  type ExecutionLimits,
  type GraphCheckpointRef,
  type GraphEvent,
  type GraphExecutionState,
} from "../src/core/scheduler.js";
import {
  acquireGraphCheckpointLease,
  assertGraphCheckpointPathsSafe,
  checkpointGraphEvent,
  createGraphCheckpointPaths,
  graphSnapshotDigest,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readGraphMutationArtifact,
  readGraphSnapshot,
  readImmutableGraphCheckpoint,
  readNodeArtifact,
  releaseGraphCheckpointLease,
  replayGraphEvents,
  writeGraphMutationArtifact,
  writeGraphSnapshot,
  writeImmutableGraphCheckpoint,
  writeNodeArtifact,
  type CheckpointFailurePoint,
  type GraphCheckpointLease,
  type GraphCheckpointPaths,
} from "../src/runtime/graphCheckpoint.js";
import { mcpRunIdSchema, MCP_RUN_ROUTING_MAX } from "./runProtocol.js";
import {
  createMcpRunRequestRecord,
  parseMcpRunPublicationAuthority,
  type McpRunCheckpointReference,
  type McpRunProviderOutput,
  type McpRunPublication,
  type McpRunPublicationGuard,
  type McpRunRecord,
  type McpRunRecordDraft,
  type McpRunRepository,
  type McpRunRequestRecord,
  type McpRunRequestUpdate,
  type McpRunStartTransaction,
  type McpRunTransaction,
  type ProviderAttemptReservation,
  type ProviderEffect,
  type ProviderEffectBase,
} from "./runService.js";

const AUTHORITY_NODE = "authority";
const PUBLICATION_EVENT = /^mcp-pub-(\d+)-([a-f0-9]{64})-(\d+)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MCP_AUTHORITY_GRAPH_DEFINITION: GraphDefinition = {
  schemaVersion: 1,
  id: "mcp-run-authority",
  version: "1",
  kind: "state-machine",
  entry: AUTHORITY_NODE,
  nodes: [
    {
      id: AUTHORITY_NODE,
      handler: "mcp-authority",
      inputContracts: [],
      outputContracts: [],
      sideEffect: "write",
      timeoutMs: 24 * 60 * 60 * 1_000,
      retryBudget: 0,
    },
    {
      id: "terminal",
      handler: "mcp-terminal",
      terminal: true,
      inputContracts: [],
      outputContracts: [],
      sideEffect: "none",
      timeoutMs: 1,
      retryBudget: 0,
    },
  ],
  edges: [{ from: AUTHORITY_NODE, to: "terminal", event: "stop" }],
};

export interface CreateMcpRunStoreOptions {
  cwd: string;
  storage: McpRunStorageConfig;
  limits: ExecutionLimits;
  /** Trusted override for tests or embedding. Production defaults to ~/.ai-orchestrator. */
  userDataRoot?: string;
  now?: () => string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  failAt?: (point: McpRunStoreFailurePoint, context: { runId: string; revision: number }) => void;
}

export type McpRunStoreFailurePoint =
  | "after-publication-artifact"
  | CheckpointFailurePoint;

export interface DurableMcpRunRepository extends McpRunRepository {
  readonly providerCallLimit: number;
  readonly repositoryDigest: string;
  runIdForRequest(requestRef: string): string;
}

interface LoadedAuthority {
  checkpoint: ReturnType<typeof readImmutableGraphCheckpoint>;
  state: GraphExecutionState;
  events: GraphEvent[];
  publications: McpRunPublication[];
}

export function createMcpRunStore(options: CreateMcpRunStoreOptions): DurableMcpRunRepository {
  return new DiskMcpRunRepository(options);
}

class DiskMcpRunRepository implements DurableMcpRunRepository {
  readonly providerCallLimit: number;
  readonly repositoryDigest: string;

  private readonly graph: CompiledGraph;
  private readonly repositoryRoot: string;
  private readonly runsRoot: string;
  private readonly projectRoot: string;
  private readonly storage: McpRunStorageConfig;
  private readonly limits: ExecutionLimits;
  private readonly now: () => string;
  private readonly pid: number;
  private readonly isProcessAlive?: (pid: number) => boolean;
  private readonly failAt?: CreateMcpRunStoreOptions["failAt"];

  constructor(options: CreateMcpRunStoreOptions) {
    this.projectRoot = canonicalDirectory(options.cwd, "MCP repository root");
    this.storage = validateStorageConfig(options.storage);
    this.limits = structuredClone(options.limits);
    this.graph = compileGraph(MCP_AUTHORITY_GRAPH_DEFINITION);
    // createGraphExecutionState is the shared strict validator for the frozen limits.
    createGraphExecutionState(this.graph, {
      runId: "mrun_0000000000000000000000",
      now: new Date(0).toISOString(),
      limits: this.limits,
    });
    this.providerCallLimit = providerCallLimitFor(this.limits);
    this.repositoryDigest = sha256(Buffer.from(this.projectRoot, "utf8"));
    const userDataRoot = options.userDataRoot === undefined
      ? join(canonicalDirectory(homedir(), "MCP user home"), ".ai-orchestrator")
      : canonicalDirectory(options.userDataRoot, "Trusted MCP user data root");
    if (!isAbsolute(userDataRoot)) throw new Error("Trusted MCP user data root must be absolute");
    this.repositoryRoot = join(userDataRoot, this.storage.userStoreDir, "repositories", this.repositoryDigest);
    this.runsRoot = join(this.repositoryRoot, "runs");
    assertContained(userDataRoot, this.repositoryRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive;
    this.failAt = options.failAt;
  }

  runIdForRequest(requestRef: string): string {
    assertSha256(requestRef, "MCP start request reference");
    return mcpRunIdSchema.parse(`mrun_${sha256(Buffer.from(
      `mcp-run-id-v1\u0000${this.repositoryDigest}\u0000${requestRef}`,
      "utf8",
    )).slice(0, 48)}`);
  }

  async withStartLease<T>(
    requestRef: string,
    work: (transaction: McpRunStartTransaction) => Promise<T>,
  ): Promise<T> {
    const runId = this.runIdForRequest(requestRef);
    return this.withLease(runId, async (paths, lease) => {
      const transaction = this.transaction(paths, lease, runId);
      return work({
        getRequest: async () => this.requestByRef(paths, requestRef, lease),
        reserve: async (draft, request, beforePublication) => {
          if (draft.runId !== runId) throw new Error("MCP start run identity is not bound to its repository request");
          const current = this.load(paths, lease);
          if (current.publications.length > 0) throw new Error("MCP run creation conflicts with existing authority");
          return this.publish(paths, lease, undefined, draft, request, beforePublication);
        },
        compareAndSwap: transaction.compareAndSwap,
        writeProviderOutput: transaction.writeProviderOutput,
      });
    });
  }

  async withRunLease<T>(runId: string, work: (transaction: McpRunTransaction) => Promise<T>): Promise<T> {
    mcpRunIdSchema.parse(runId);
    return this.withLease(runId, async (paths, lease) => work(this.transaction(paths, lease, runId)));
  }

  async get(runId: string): Promise<McpRunRecord | undefined> {
    mcpRunIdSchema.parse(runId);
    const paths = this.pathsFor(runId);
    if (!existsSync(paths.graph)) return undefined;
    const loaded = this.load(paths);
    const publication = loaded.publications.at(-1);
    if (publication) this.writeProjectMirror(publication, loaded.events.at(-1)?.timestamp);
    return clone(publication?.record);
  }

  async getCheckpoint(reference: McpRunCheckpointReference): Promise<McpRunRecord | undefined> {
    mcpRunIdSchema.parse(reference.runId);
    if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
      throw new Error("MCP checkpoint revision must be a positive safe integer");
    }
    const paths = this.pathsFor(reference.runId);
    if (!existsSync(paths.graph)) return undefined;
    const loaded = this.load(paths);
    return clone(loaded.publications[reference.revision - 1]?.record);
  }

  private transaction(paths: GraphCheckpointPaths, lease: GraphCheckpointLease, runId: string): McpRunTransaction {
    return {
      get: async () => clone(this.load(paths, lease).publications.at(-1)?.record),
      getRequest: async (requestRef) => this.requestByRef(paths, requestRef, lease),
      compareAndSwap: async (expectedRevision, draft, request, beforePublication) => {
        const loaded = this.load(paths, lease);
        const current = loaded.publications.at(-1)?.record;
        if (!current || current.revision !== expectedRevision) return undefined;
        if (draft.runId !== runId || current.runId !== runId) throw new Error("MCP CAS crossed a run boundary");
        return this.publish(paths, lease, current, draft, request, beforePublication, loaded);
      },
      writeProviderOutput: async (input) => this.writeProviderOutput(paths, lease, runId, input),
    };
  }

  private async withLease<T>(
    runId: string,
    work: (paths: GraphCheckpointPaths, lease: GraphCheckpointLease) => Promise<T>,
  ): Promise<T> {
    const paths = this.pathsFor(runId);
    const lease = acquireGraphCheckpointLease(paths, `mcp-${this.pid}-${randomBytes(8).toString("hex")}`, {
      now: this.validNow(),
      pid: this.pid,
      ...(this.isProcessAlive ? { isProcessAlive: this.isProcessAlive } : {}),
    });
    try {
      this.ensureInitialized(paths, lease, runId);
      return await work(paths, lease);
    } finally {
      releaseGraphCheckpointLease(paths, lease);
    }
  }

  private ensureInitialized(paths: GraphCheckpointPaths, lease: GraphCheckpointLease, runId: string): void {
    assertGraphCheckpointPathsSafe(paths);
    if (!existsSync(paths.graph)) {
      const genesis = createGraphExecutionState(this.graph, {
        runId,
        now: this.validNow(),
        limits: this.limits,
      });
      writeImmutableGraphCheckpoint(paths, this.graph, {}, genesis, { owner: lease });
      writeGraphSnapshot(paths, this.graph, genesis, { owner: lease, tempId: randomBytes(8).toString("hex") });
      return;
    }
    const checkpoint = readImmutableGraphCheckpoint(paths);
    if (checkpoint.runId !== runId || checkpoint.graphDigest !== graphDefinitionDigest(this.graph)) {
      throw new Error("MCP run checkpoint identity does not match its repository path");
    }
    if (!existsSync(paths.state)) {
      if (readGraphEvents(paths).length > 0) throw new Error("MCP run event authority exists without a scheduler snapshot");
      writeGraphSnapshot(paths, this.graph, checkpoint.genesisState, {
        owner: lease,
        tempId: randomBytes(8).toString("hex"),
      });
    }
  }

  private publish(
    paths: GraphCheckpointPaths,
    lease: GraphCheckpointLease,
    current: McpRunRecord | undefined,
    draft: McpRunRecordDraft,
    update: McpRunRequestUpdate,
    beforePublication: McpRunPublicationGuard,
    preloaded?: LoadedAuthority,
  ): McpRunRecord {
    if (!ownsGraphCheckpointLease(paths, lease)) {
      throw new Error("MCP publication lease generation is no longer owned");
    }
    const loaded = preloaded ?? this.load(paths, lease);
    const expectedRevision = current?.revision ?? 0;
    if (loaded.publications.length !== expectedRevision) {
      throw new Error("MCP publication head differs from its expected revision");
    }
    const record = { ...clone(draft), revision: expectedRevision + 1 } satisfies McpRunRecord;
    const frozenProviderCallLimit = providerCallLimitFor(loaded.state.effectiveLimits);
    if (record.maxProviderCalls !== frozenProviderCallLimit) {
      throw new Error("MCP provider-call limit is not derived from the frozen scheduler authority");
    }
    const request = createMcpRunRequestRecord(update, record);
    const publication = { record, request } satisfies McpRunPublication;
    // The service validates the repository-assigned revision and exact receipt
    // synchronously while this generation-bound lease is still held.
    beforePublication(clone(publication));
    if (!ownsGraphCheckpointLease(paths, lease)) {
      throw new Error("MCP publication lease generation changed during validation");
    }
    parseMcpRunPublicationAuthority(publication);

    const bytes = Buffer.from(canonicalJson(publication), "utf8");
    const digest = sha256(bytes);
    const publicationRef = writeGraphMutationArtifact(paths, {
      owner: lease,
      mutationId: digest,
      bytes,
    });
    this.failAt?.("after-publication-artifact", { runId: record.runId, revision: record.revision });
    const timestamp = monotonicTimestamp(this.validNow(), loaded.state);
    const event = eventForPublication(
      this.graph,
      loaded.state,
      current,
      publication,
      publicationRef,
      timestamp,
    );
    checkpointGraphEvent({
      graph: this.graph,
      paths,
      state: loaded.state,
      event,
      owner: lease,
      tempId: randomBytes(8).toString("hex"),
      ...(this.failAt
        ? { failAt: (point: CheckpointFailurePoint) => this.failAt?.(point, { runId: record.runId, revision: record.revision }) }
        : {}),
    });
    this.writeProjectMirror(publication, timestamp);
    return clone(record);
  }

  private writeProviderOutput(
    paths: GraphCheckpointPaths,
    lease: GraphCheckpointLease,
    runId: string,
    input: McpRunProviderOutput,
  ): ArtifactReference {
    if (input.runId !== runId) throw new Error("Provider output crossed an MCP run boundary");
    const loaded = this.load(paths, lease);
    const current = loaded.publications.at(-1)?.record;
    if (!current) throw new Error("Cannot write provider output before MCP run authority exists");
    const authority = current.requestAuthority;
    if (authority.state !== "pending" || authority.effect.phase !== "awaiting_output_commit") {
      throw new Error("Provider output has no matching durable output-commit obligation");
    }
    assertEffectMatches(input.effect, authority.effect);
    if (!sameAttempt(input.attempt, authority.effect.attempt)) {
      throw new Error("Provider output attempt does not match its durable reservation");
    }
    const expectedContract = input.effect.kind === "plan" ? "mcp-plan-output-v1" : "mcp-judge-output-v1";
    if (input.contract !== expectedContract) throw new Error("Provider output contract does not match its effect kind");
    const schedulerEffect = loaded.state.nodeStates[AUTHORITY_NODE]?.sideEffect;
    if (!schedulerEffect || schedulerEffect.status !== "intent_recorded" ||
        schedulerEffect.idempotencyKey !== input.attempt.providerAttemptIdempotencyKey ||
        schedulerEffect.requestRef !== input.attempt.providerRequestRef ||
        schedulerEffect.routingDecisionId !== input.attempt.routingDecision.decisionId) {
      throw new Error("Provider output is not bound to the scheduler's unresolved effect identity");
    }
    return writeNodeArtifact(paths, {
      owner: lease,
      planVersion: loaded.state.nodeStates[AUTHORITY_NODE]!.planVersion,
      nodeId: AUTHORITY_NODE,
      contract: `${expectedContract}:${input.effect.effectId}`,
      bytes: Buffer.from(input.bytes),
    });
  }

  private requestByRef(
    paths: GraphCheckpointPaths,
    requestRef: string,
    lease?: GraphCheckpointLease,
  ): McpRunRequestRecord | undefined {
    assertSha256(requestRef, "MCP request lookup reference");
    const publications = this.load(paths, lease).publications;
    for (let index = publications.length - 1; index >= 0; index -= 1) {
      const request = publications[index]!.request;
      if (request.requestRef === requestRef) return clone(request);
    }
    return undefined;
  }

  private load(paths: GraphCheckpointPaths, lease?: GraphCheckpointLease): LoadedAuthority {
    const checkpoint = readImmutableGraphCheckpoint(paths);
    if (checkpoint.graphDigest !== graphDefinitionDigest(this.graph)) {
      throw new Error("MCP checkpoint graph is not the canonical authority graph");
    }
    const events = readGraphEvents(paths);
    const snapshot = readGraphSnapshot(paths, this.graph);
    const replayed = replayGraphEvents(this.graph, snapshot, events, checkpoint.genesisState);
    let state = replayed;
    if (canonicalJson(snapshot) !== canonicalJson(replayed) && lease) {
      writeGraphSnapshot(paths, this.graph, replayed, {
        owner: lease,
        tempId: randomBytes(8).toString("hex"),
        expectedRevision: snapshot.revision,
        expectedSnapshotHash: graphSnapshotDigest(snapshot),
      });
      state = replayed;
    }

    const publications: McpRunPublication[] = [];
    let replay = checkpoint.genesisState;
    let prior: McpRunRecord | undefined;
    const committedOutputs = new Set<string>();
    for (const event of events) {
      const publicationRef = publicationReferenceForEvent(event);
      const bytes = readGraphMutationArtifact(paths, publicationRef);
      const text = bytes.toString("utf8");
      let unparsed: unknown;
      try {
        unparsed = JSON.parse(text);
      } catch {
        throw new Error(`MCP run publication ${event.sequence} is corrupt JSON`);
      }
      if (canonicalJson(unparsed) !== text) throw new Error(`MCP run publication ${event.sequence} is not canonical`);
      const publication = parseMcpRunPublicationAuthority(unparsed);
      if (publication.record.runId !== checkpoint.runId || publication.record.revision !== event.sequence) {
        throw new Error("MCP publication identity does not match its scheduler event");
      }
      if (publication.record.maxProviderCalls !== providerCallLimitFor(checkpoint.genesisState.effectiveLimits)) {
        throw new Error("MCP publication changed its scheduler-issued provider limit");
      }
      if (event.sequence === 1) {
        if (publication.request.mutationEffect.operation !== "start" ||
            this.runIdForRequest(publication.request.requestRef) !== publication.record.runId) {
          throw new Error("MCP genesis is not bound to this canonical repository partition");
        }
      }
      const expectedEvent = eventForPublication(
        this.graph,
        replay,
        prior,
        publication,
        publicationRef,
        event.timestamp,
      );
      if (graphEventDigest(expectedEvent) !== graphEventDigest(event) || canonicalJson(expectedEvent) !== canonicalJson(event)) {
        throw new Error(`MCP scheduler event ${event.sequence} does not authenticate its publication transition`);
      }
      validateProviderArtifacts(paths, publication, committedOutputs);
      replay = applySchedulerEvent(this.graph, replay, event);
      publications.push(publication);
      prior = publication.record;
    }
    if (canonicalJson(replay) !== canonicalJson(state)) {
      throw new Error("MCP publication replay does not match scheduler authority");
    }
    if (publications.length !== state.lastAppliedEventSequence) {
      throw new Error("MCP publication count does not match scheduler revision");
    }
    return { checkpoint, state, events, publications };
  }

  private pathsFor(runId: string): GraphCheckpointPaths {
    mcpRunIdSchema.parse(runId);
    const root = join(this.runsRoot, runId);
    assertContained(this.repositoryRoot, root);
    return createGraphCheckpointPaths(root);
  }

  private validNow(): string {
    const value = this.now();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("MCP run store clock returned an invalid timestamp");
    return new Date(value).toISOString();
  }

  private writeProjectMirror(publication: McpRunPublication, timestamp?: string): void {
    if (!this.storage.projectMirror) return;
    try {
      const directory = join(this.projectRoot, ".ai-orchestrator", "mcp-runs");
      assertContained(this.projectRoot, directory);
      ensureSecureDirectory(directory);
      const updatedAt = timestamp ?? this.validNow();
      const terminal = publication.record.status !== "active";
      const mirror = {
        schemaVersion: 1,
        runId: publication.record.runId,
        revision: publication.record.revision,
        status: publication.record.status,
        phase: publication.record.status === "cancelled"
          ? publication.record.cancelledCheckpoint?.phase ?? "idle"
          : publication.record.state.phase,
        planVersion: publication.record.planVersion,
        providerAttempts: publication.record.providerAttempts,
        authorityDigest: publication.request.authorityDigest,
        updatedAt,
        ...(terminal
          ? { retainUntil: new Date(Date.parse(updatedAt) + this.storage.terminalRetentionDays * 86_400_000).toISOString() }
          : {}),
      };
      atomicWrite(join(directory, `${publication.record.runId}.json`), `${canonicalJson(mirror)}\n`);
    } catch {
      // The project mirror is explicitly non-authoritative. A poisoned project
      // path may suppress it, but can never redirect or block user-root authority.
    }
  }
}

function eventForPublication(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  prior: McpRunRecord | undefined,
  publication: McpRunPublication,
  publicationRef: GraphCheckpointRef,
  timestamp: string,
): GraphEvent {
  const record = publication.record;
  const node = state.nodeStates[AUTHORITY_NODE];
  if (!node) throw new Error("MCP scheduler authority node is missing");
  const base = {
    schemaVersion: 1 as const,
    sequence: record.revision,
    eventId: publicationEventId(record.revision, publicationRef),
    runId: record.runId,
    graphId: graph.definition.id,
    graphVersion: graph.definition.version,
    graphDigest: graphDefinitionDigest(graph),
    planVersion: state.planVersion,
    nodeId: AUTHORITY_NODE,
    attempt: record.revision === 1 ? 1 : node.attempts,
    timestamp,
    artifactRefs: [] as ArtifactReference[],
  };
  if (!prior) {
    const decision = evaluateExecutionGuard(graph, state, state.effectiveLimits, {
      action: "node",
      nodeId: AUTHORITY_NODE,
      nodeAttempts: 1,
      concurrency: 1,
      now: timestamp,
      unattended: true,
    });
    if (!decision.allowed) throw new Error(`MCP scheduler denied run creation: ${decision.code}: ${decision.reason}`);
    return {
      ...base,
      kind: "node-status",
      priorStatus: "ready",
      nextStatus: "running",
      checkpointRef: publicationRef,
    };
  }
  if (node.status !== "running") throw new Error("MCP scheduler authority node is not running");

  const nextAttempt = newlyAttemptingEffect(prior, record);
  if (nextAttempt) {
    if (record.providerAttempts !== prior.providerAttempts + 1 || node.sideEffectOrdinal + 1 !== record.providerAttempts) {
      throw new Error("MCP provider attempt does not match the scheduler-issued ordinal");
    }
    const usage = usageFor(nextAttempt.attempt, record);
    const decision = evaluateExecutionGuard(graph, state, state.effectiveLimits, {
      action: "model",
      nodeId: AUTHORITY_NODE,
      nodeAttempts: 0,
      concurrency: 0,
      modelCalls: 1,
      providerCalls: 1,
      sideEffectAttempts: 1,
      ...usage,
      now: timestamp,
      unattended: true,
    });
    if (!decision.allowed) throw new Error(`MCP scheduler denied provider attempt: ${decision.code}: ${decision.reason}`);
    return {
      ...base,
      kind: "side-effect-intent",
      priorStatus: "running",
      nextStatus: "running",
      requestRef: nextAttempt.attempt.providerRequestRef,
      checkpointRef: publicationRef,
      routingDecisionId: nextAttempt.attempt.routingDecision.decisionId,
      sideEffect: {
        phase: "intent",
        ordinal: record.providerAttempts,
        idempotencyKey: nextAttempt.attempt.providerAttemptIdempotencyKey,
        class: "model",
      },
      reservation: { modelCalls: 1, providerCalls: 1 },
    };
  }

  const result = providerResultTransition(prior, record);
  if (result) {
    const pending = node.sideEffect;
    if (!pending || pending.status !== "intent_recorded" || !pending.checkpointRef) {
      throw new Error("MCP provider result has no unresolved scheduler intent");
    }
    if (pending.idempotencyKey !== result.attempt.providerAttemptIdempotencyKey ||
        pending.requestRef !== result.attempt.providerRequestRef ||
        pending.routingDecisionId !== result.attempt.routingDecision.decisionId) {
      throw new Error("MCP provider result changed its scheduler effect identity");
    }
    return {
      ...base,
      kind: "side-effect-result",
      priorStatus: "running",
      nextStatus: "running",
      requestRef: pending.requestRef,
      checkpointRef: pending.checkpointRef,
      routingDecisionId: pending.routingDecisionId,
      sideEffect: {
        phase: "result",
        ordinal: pending.ordinal,
        idempotencyKey: pending.idempotencyKey,
        class: "model",
        outcome: result.outcome,
        ...(result.resultRef ? { resultRef: result.resultRef } : {}),
      },
      usage: usageFor(result.attempt, record),
      reservation: { modelCalls: -1, providerCalls: -1 },
    };
  }

  return {
    ...base,
    kind: "progress",
    priorStatus: "running",
    nextStatus: "running",
    checkpointRef: publicationRef,
    progressFingerprint: publicationRef.sha256,
  };
}

function newlyAttemptingEffect(prior: McpRunRecord, next: McpRunRecord): Extract<ProviderEffect, { phase: "attempting" }> | undefined {
  const authority = next.requestAuthority;
  if (authority.state !== "pending" || authority.effect.phase !== "attempting") return undefined;
  const previous = prior.requestAuthority;
  if (previous.state === "pending" && previous.effect.phase === "attempting" &&
      sameAttempt(previous.effect.attempt, authority.effect.attempt)) return undefined;
  return authority.effect;
}

function providerResultTransition(
  prior: McpRunRecord,
  next: McpRunRecord,
): { attempt: ProviderAttemptReservation; outcome: "succeeded" | "failed" | "unknown"; resultRef?: ArtifactReference } | undefined {
  const authority = prior.requestAuthority;
  if (authority.state !== "pending" ||
      (authority.effect.phase !== "attempting" && authority.effect.phase !== "awaiting_output_commit")) return undefined;
  const attempt = authority.effect.attempt;
  const evidence = next.providerEvidence.find((item) => item.providerAttemptIdempotencyKey === attempt.providerAttemptIdempotencyKey);
  if (evidence?.phase === "output_committed") return { attempt, outcome: "succeeded", resultRef: evidence.resultRef };
  if (evidence?.phase === "failed" || evidence?.phase === "discarded") return { attempt, outcome: "failed" };
  if (evidence?.phase === "unknown") return { attempt, outcome: "unknown" };
  if (next.status === "cancelled") return { attempt, outcome: "unknown" };
  return undefined;
}

function validateProviderArtifacts(
  paths: GraphCheckpointPaths,
  publication: McpRunPublication,
  seen: Set<string>,
): void {
  for (const evidence of publication.record.providerEvidence) {
    if (evidence.phase !== "output_committed") continue;
    const expectedContract = `${evidence.kind === "plan" ? "mcp-plan-output-v1" : "mcp-judge-output-v1"}:${evidence.effectId}`;
    if (evidence.resultRef.nodeId !== AUTHORITY_NODE || evidence.resultRef.planVersion !== 1 ||
        evidence.resultRef.contract !== expectedContract) {
      throw new Error("Committed provider output reference is not bound to its exact effect");
    }
    const bytes = readNodeArtifact(paths, evidence.resultRef);
    if (seen.has(evidence.providerAttemptIdempotencyKey)) continue;
    const expected = evidence.kind === "plan"
      ? publication.record.state.plan
      : publication.record.lastVerdict === undefined ? undefined : canonicalJson(publication.record.lastVerdict);
    if (expected === undefined || bytes.toString("utf8") !== expected) {
      throw new Error("Committed provider output bytes do not match the exposed semantic transition");
    }
    seen.add(evidence.providerAttemptIdempotencyKey);
  }
}

function usageFor(attempt: ProviderAttemptReservation, record: McpRunRecord): {
  estimatedCostUsd: number;
  observedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
} {
  return {
    estimatedCostUsd: attempt.estimatedCostUsd ?? 0,
    // The routed callback exposes estimates but no provider usage receipt. The
    // scheduler charges the trusted estimate and the requested output ceiling.
    observedCostUsd: attempt.estimatedCostUsd ?? 0,
    inputTokens: record.taskFeatures?.contextTokens ?? 0,
    outputTokens: attempt.requestedOutputTokens ?? 0,
  };
}

function publicationEventId(sequence: number, reference: GraphCheckpointRef): string {
  return `mcp-pub-${sequence}-${reference.sha256}-${reference.sizeBytes}`;
}

function publicationReferenceForEvent(event: GraphEvent): GraphCheckpointRef {
  const match = PUBLICATION_EVENT.exec(event.eventId);
  if (!match || Number(match[1]) !== event.sequence) throw new Error("MCP event id does not bind a publication artifact");
  const sizeBytes = Number(match[3]);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("MCP publication size is invalid");
  return { path: `mutations/${match[2]}.json`, sha256: match[2]!, sizeBytes };
}

function assertEffectMatches(left: ProviderEffectBase, right: ProviderEffectBase): void {
  if (left.effectId !== right.effectId || left.kind !== right.kind || left.ordinal !== right.ordinal) {
    throw new Error("Provider effect identity does not match durable authority");
  }
}

function sameAttempt(left: ProviderAttemptReservation, right: ProviderAttemptReservation): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateStorageConfig(config: McpRunStorageConfig): McpRunStorageConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("MCP run storage config is invalid");
  if (typeof config.userStoreDir !== "string" || isAbsolute(config.userStoreDir)) {
    throw new Error("MCP run userStoreDir must be relative to the trusted user root");
  }
  for (const part of config.userStoreDir.split(/[\\/]/)) {
    if (!part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part)) {
      throw new Error("MCP run userStoreDir must be a safe relative path");
    }
  }
  if (typeof config.projectMirror !== "boolean") throw new Error("MCP run projectMirror must be boolean");
  if (!Number.isSafeInteger(config.terminalRetentionDays) || config.terminalRetentionDays < 1) {
    throw new Error("MCP run terminalRetentionDays must be a positive safe integer");
  }
  return structuredClone(config);
}

function providerCallLimitFor(limits: ExecutionLimits): number {
  return Math.min(MCP_RUN_ROUTING_MAX, limits.maxSideEffectAttempts);
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) throw new Error(`${label} must be an existing directory`);
  return realpathSync(absolute);
}

function monotonicTimestamp(now: string, state: Readonly<GraphExecutionState>): string {
  const prior = state.lastAppliedEventTimestamp ?? state.guard.startedAt;
  return Date.parse(now) < Date.parse(prior) ? prior : now;
}

function assertSha256(value: string, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function assertContained(root: string, target: string): void {
  const contained = relative(resolve(root), resolve(target));
  if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("MCP run path escapes its trusted root");
}

function ensureSecureDirectory(path: string): void {
  const absolute = resolve(path);
  assertNoSymlinkComponents(absolute);
  if (existsSync(absolute)) {
    if (!lstatSync(absolute).isDirectory()) throw new Error("MCP mirror path is not a directory");
    return;
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("Cannot create MCP mirror directory");
  ensureSecureDirectory(parent);
  mkdirSync(absolute, { mode: 0o700 });
}

function atomicWrite(path: string, value: string): void {
  assertNoSymlinkComponents(path);
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("MCP mirror target is not a regular file");
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const bytes = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error("MCP mirror write made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    assertNoSymlinkComponents(path);
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`MCP path must not contain symlinks: ${current}`);
  }
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new Error("Cannot canonicalize undefined MCP authority");
  return encoded;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
