import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  getAgentDir,
  type ModelRegistry,
  type ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { constants, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { mkdir, open, opendir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BuildWorkerAdapter, BuildWorkerReceipt, BuildWorkerRequest } from "./buildWorker.js";

const RESULT_TOOL = "submit_build_worker_result";
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_OUTPUT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_GREP_PATTERN_BYTES = 4 * 1024;
const MAX_GREP_FILES = 1_000;
const MAX_GREP_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GREP_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GREP_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_GREP_MATCHES = 1_000;
const MAX_GREP_CONTEXT = 20;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GREP_OUTPUT_BYTES = 50 * 1024;
const MAX_WORKER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GLOB_PATTERN_BYTES = 1_024;
const MAX_GLOB_VISITED_ENTRIES = 10_000;
const MAX_GLOB_VISITED_DIRECTORIES = 2_000;
const MAX_GLOB_RESULTS = 1_000;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_LS_ENTRIES = 500;
const MAX_LS_VISITED_ENTRIES = 2_000;
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;

export interface PiNestedSession {
  prompt(text: string, options?: Readonly<{ expandPromptTemplates?: boolean; source?: "interactive" | "rpc" | "extension" }>): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): {
    tokens: { input: number; output: number };
    cost: number;
  };
  readonly isIdle: boolean;
  readonly state?: Readonly<{ messages?: readonly unknown[] }>;
}

export interface PiNestedSessionInput {
  cwd: string;
  model: Readonly<PiBuildModel>;
  thinkingLevel: ThinkingLevel;
  modelRegistry: ModelRegistry;
  authStorage: ModelRegistry["authStorage"];
  tools: readonly string[];
  toolPolicy: BuildWorkerRequest["toolPolicy"];
  declaredWriteSet: readonly string[];
  protectedWorkspacePaths: readonly string[];
  onResult(value: unknown): void;
}

export interface PiNestedSessionFactory {
  create(input: Readonly<PiNestedSessionInput>): Promise<Readonly<{ session: PiNestedSession }>>;
}

export interface PiBuildWorkerAdapterOptions {
  repositoryRoot: string;
  model: Readonly<PiBuildModel>;
  thinkingLevel: ThinkingLevel;
  modelRegistry: ModelRegistry;
  now(): string;
  family?: string;
  protectedWorkspacePaths: readonly string[];
  sessionFactory?: Readonly<PiNestedSessionFactory>;
}

/** Opaque full Pi model object. Only provider/id are inspected; every other
 * runtime field is preserved and passed through to createAgentSession. */
export type PiBuildModel = Readonly<Model<any>>;

/**
 * Create an isolated in-memory Pi worker. The nested session reuses the exact
 * trusted outer registry/model/auth objects, disables recursive resource
 * discovery, exposes only the immutable request's tools plus one terminating
 * result tool, and is always disposed.
 */
export function createPiBuildWorkerAdapter(
  options: Readonly<PiBuildWorkerAdapterOptions>,
): Readonly<BuildWorkerAdapter> {
  const sessionFactory = options.sessionFactory ?? defaultNestedSessionFactory;
  return Object.freeze({
    async invoke(request: Readonly<BuildWorkerRequest>, { signal }: Readonly<{ signal: AbortSignal }>) {
      let submitted: unknown;
      const created = await sessionFactory.create({
        cwd: workerCwd(request, options.repositoryRoot),
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        modelRegistry: options.modelRegistry,
        authStorage: options.modelRegistry.authStorage,
        tools: Object.freeze([...request.activeTools, RESULT_TOOL]),
        toolPolicy: request.toolPolicy,
        declaredWriteSet: request.declaredWriteSet,
        protectedWorkspacePaths: options.protectedWorkspacePaths,
        onResult(value) {
          if (submitted !== undefined) throw new Error("BUILD worker result was submitted more than once");
          submitted = normalizeSubmittedResult(value, request);
        },
      });
      const session = created.session;
      let lastAssistant: Readonly<{ text?: string; stopReason?: string; errorMessage?: string }> | undefined;
      const unsubscribe = session.subscribe((event) => {
        const candidate = assistantFromEvent(event);
        if (candidate) lastAssistant = candidate;
      });
      const abort = () => { void session.abort(); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw abortError("BUILD worker was aborted before its nested session started");
        await session.prompt(workerPrompt(request), { expandPromptTemplates: false, source: "extension" });
        await session.waitForIdle();
        const stats = session.getSessionStats();
        const final = normalizeFinalSessionState(session, request, submitted, lastAssistant);
        return workerReceipt(request, final, stats, options);
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        if (!session.isIdle && signal.aborted) await session.abort().catch(() => undefined);
        session.dispose();
      }
    },
    async reconcile(_request: Readonly<BuildWorkerRequest>, _options: Readonly<{ signal: AbortSignal }>) {
      // Sessions are intentionally in-memory and provider calls have no trusted
      // query-by-id contract. A crash-era invocation therefore stays unknown;
      // replaying it would risk duplicating maker side effects.
      return undefined;
    },
  });
}

export function buildWorkerOutputArtifactPath(
  request: Pick<BuildWorkerRequest, "planVersion" | "nodeId" | "attempt">,
  contractId: string,
): string {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(contractId)) {
    throw new Error("BUILD worker output contract id is invalid");
  }
  return `nodes/${request.planVersion}/${request.nodeId}/attempt-${request.attempt}/${contractId}.json`;
}

const defaultNestedSessionFactory: PiNestedSessionFactory = Object.freeze({
  async create(input: Readonly<PiNestedSessionInput>) {
    const resultTool = defineTool({
      name: RESULT_TOOL,
      label: "Submit BUILD Worker Result",
      description: "Submit the final bounded result for this BUILD node. This must be the final action.",
      promptSnippet: "Submit the final BUILD-node outcome",
      promptGuidelines: [
        "Use submit_build_worker_result exactly once as the final action after completing only the assigned BUILD node.",
      ],
      parameters: Type.Object({
        outcome: StringEnum(["succeeded", "failed"] as const),
        summary: Type.String({ maxLength: MAX_SUMMARY_BYTES }),
        outputs: Type.Array(Type.Object({
          contractId: Type.String(),
          content: Type.String({ maxLength: MAX_OUTPUT_PAYLOAD_BYTES }),
        }), { maxItems: 64 }),
      }),
      async execute(_toolCallId: string, params: {
        outcome: "succeeded" | "failed";
        summary: string;
        outputs: Array<{ contractId: string; content: string }>;
      }) {
        input.onResult(params);
        return {
          content: [{ type: "text", text: `BUILD worker reported ${params.outcome}.` }],
          details: { outcome: params.outcome },
          terminate: true,
        };
      },
    });
    const loader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      modelRegistry: input.modelRegistry,
      authStorage: input.authStorage,
      noTools: "builtin",
      tools: [...input.tools],
      customTools: [...buildWorkerToolDefinitions(input), resultTool],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(input.cwd),
    });
    return Object.freeze({ session: session as unknown as PiNestedSession });
  },
});

function workerCwd(request: Readonly<BuildWorkerRequest>, repositoryRoot: string): string {
  return request.workspace.kind === "owned-worktree" ? request.workspace.worktreePath : repositoryRoot;
}

function workerPrompt(request: Readonly<BuildWorkerRequest>): string {
  const contracts = request.declaredOutputContracts.map(({ id, kind }) =>
    `- ${id}: ${kind === "file-set" ? "the coordinator derives this from the trusted Git inspection; do not submit content" : `submit its bounded content in outputs[contractId=${id}]`}; the coordinator creates and validates ${buildWorkerOutputArtifactPath(request, id)}`);
  return [
    request.prompt,
    "When the node is complete, call submit_build_worker_result. Do not invent artifact paths; the trusted coordinator owns artifact materialization.",
    "Declared coordinator-owned outputs:",
    ...contracts,
  ].join("\n");
}

function normalizeSubmittedResult(
  value: unknown,
  request: Readonly<BuildWorkerRequest>,
): Readonly<{
  outcome: "succeeded" | "failed";
  summary: string;
  outputs: readonly Readonly<{ contractId: string; content: string }>[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BUILD worker result must be an object");
  const record = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if ((Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
      Reflect.ownKeys(record).some((key) => typeof key !== "string" || !["outcome", "summary", "outputs"].includes(key))) {
    throw new Error("BUILD worker result must contain only outcome, summary, and outputs data properties");
  }
  if ((record.outcome !== "succeeded" && record.outcome !== "failed") || typeof record.summary !== "string" ||
      record.summary.trim() !== record.summary || record.summary.length === 0 ||
      Buffer.byteLength(record.summary, "utf8") > MAX_SUMMARY_BYTES) {
    throw new Error("BUILD worker result outcome or summary is invalid");
  }
  if (!Array.isArray(record.outputs) || Object.getPrototypeOf(record.outputs) !== Array.prototype || record.outputs.length > 64) {
    throw new Error("BUILD worker outputs must be a bounded plain array");
  }
  const outputs = record.outputs.map((value, index) => normalizeOutputPayload(value, index));
  const ids = outputs.map(({ contractId }) => contractId);
  if (new Set(ids).size !== ids.length) throw new Error("BUILD worker outputs contain duplicate contracts");
  const required = request.declaredOutputContracts.filter(({ kind }) => kind !== "file-set").map(({ id }) => id).sort();
  if (record.outcome === "succeeded" && !sameStrings([...ids].sort(), required)) {
    throw new Error("Successful BUILD worker outputs must exactly match non-file-set contracts");
  }
  if (record.outcome === "failed" && outputs.length > 0) throw new Error("Failed BUILD worker result cannot submit outputs");
  return Object.freeze({ outcome: record.outcome, summary: record.summary, outputs: Object.freeze(outputs) });
}

function normalizeFinalSessionState(
  session: Readonly<PiNestedSession>,
  request: Readonly<BuildWorkerRequest>,
  submitted: unknown,
  observed: Readonly<{ text?: string; stopReason?: string; errorMessage?: string }> | undefined,
): Readonly<{
  outcome: "succeeded" | "failed";
  summary: string;
  outputs: readonly Readonly<{ contractId: string; content: string }>[];
}> {
  const final = observed ?? lastAssistantFromMessages(session.state?.messages);
  if (final?.stopReason === "error" || final?.stopReason === "aborted" || final?.errorMessage) {
    return Object.freeze({
      outcome: "failed",
      summary: boundedSummary(final.errorMessage ?? final.text ?? `Worker session ended with ${final.stopReason}.`),
      outputs: Object.freeze([]),
    });
  }
  if (submitted !== undefined) return normalizeSubmittedResult(submitted, request);
  const fallback = final?.text?.trim();
  return Object.freeze({
    outcome: "failed",
    summary: fallback && Buffer.byteLength(fallback, "utf8") <= MAX_SUMMARY_BYTES
      ? `Worker stopped without the terminating result tool: ${fallback}`
      : "Worker stopped without the terminating result tool.",
    outputs: Object.freeze([]),
  });
}

function assistantFromEvent(value: unknown): Readonly<{ text?: string; stopReason?: string; errorMessage?: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type === "message_end") return normalizeAssistantMessage(event.message);
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    return lastAssistantFromMessages(event.messages);
  }
  return undefined;
}

function lastAssistantFromMessages(
  values: readonly unknown[] | undefined,
): Readonly<{ text?: string; stopReason?: string; errorMessage?: string }> | undefined {
  if (!values) return undefined;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeAssistantMessage(values[index]);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeAssistantMessage(
  value: unknown,
): Readonly<{ text?: string; stopReason?: string; errorMessage?: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return undefined;
  const text = Array.isArray(message.content)
    ? message.content.flatMap((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) return [];
        const item = block as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      }).join("\n").trim()
    : undefined;
  return Object.freeze({
    ...(text ? { text: boundedSummary(text) } : {}),
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === "string" ? { errorMessage: boundedSummary(message.errorMessage) } : {}),
  });
}

function boundedSummary(value: string): string {
  const trimmed = value.trim() || "Nested BUILD worker failed without diagnostic text.";
  if (Buffer.byteLength(trimmed, "utf8") <= MAX_SUMMARY_BYTES) return trimmed;
  return Buffer.from(trimmed, "utf8").subarray(0, MAX_SUMMARY_BYTES - 32).toString("utf8") + "\n[truncated]";
}

function workerReceipt(
  request: Readonly<BuildWorkerRequest>,
  result: Readonly<{
    outcome: "succeeded" | "failed";
    summary: string;
    outputs: readonly Readonly<{ contractId: string; content: string }>[];
  }>,
  stats: Readonly<{ tokens: { input: number; output: number }; cost: number }>,
  options: Readonly<PiBuildWorkerAdapterOptions>,
): BuildWorkerReceipt {
  const usageValid = Number.isSafeInteger(stats.tokens.input) && stats.tokens.input >= 0 &&
    Number.isSafeInteger(stats.tokens.output) && stats.tokens.output >= 0 &&
    Number.isFinite(stats.cost) && stats.cost >= 0;
  if (!usageValid) throw new Error("BUILD worker session returned invalid usage statistics");
  return Object.freeze({
    schemaVersion: 1,
    requestRef: request.requestRef,
    outcome: result.outcome,
    worker: Object.freeze({
      provider: options.model.provider,
      model: options.model.id,
      ...(options.family === undefined ? {} : { family: options.family }),
    }),
    claimedOutputPaths: result.outcome === "succeeded"
      ? Object.freeze(request.declaredOutputContracts.map(({ id }) => buildWorkerOutputArtifactPath(request, id)))
      : Object.freeze([]),
    outputPayloads: result.outcome === "succeeded" ? result.outputs : Object.freeze([]),
    summary: result.summary,
    usage: Object.freeze({
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      observedUsd: stats.cost,
    }),
    completedAt: options.now(),
  });
}

function normalizeOutputPayload(value: unknown, index: number): Readonly<{ contractId: string; content: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`BUILD worker output ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if ((Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
      Reflect.ownKeys(record).some((key) => typeof key !== "string" || !["contractId", "content"].includes(key)) ||
      typeof record.contractId !== "string" || typeof record.content !== "string" ||
      Buffer.byteLength(record.content, "utf8") > MAX_OUTPUT_PAYLOAD_BYTES) {
    throw new Error(`BUILD worker output ${index} is invalid or oversized`);
  }
  return Object.freeze({ contractId: record.contractId, content: record.content });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildWorkerToolDefinitions(input: Readonly<PiNestedSessionInput>): unknown[] {
  const readGuard = createWorkspaceReadGuard(input.cwd, input.protectedWorkspacePaths);
  const readOnly = [
    createReadToolDefinition(input.cwd, { operations: {
      async readFile(path: string) { return secureReadFile(readGuard(path)); },
      async access(path: string) { await secureReadableAccess(readGuard(path)); },
    } }),
    createSecureGrepToolDefinition(input.cwd, readGuard),
    createSecureFindToolDefinition(input.cwd, readGuard),
    createSecureLsToolDefinition(input.cwd, readGuard),
  ];
  if (input.toolPolicy === "read-only") return readOnly;
  const guard = createDeclaredMutationGuard(
    input.cwd,
    input.declaredWriteSet,
    input.protectedWorkspacePaths,
  );
  return [
    ...readOnly,
    createEditToolDefinition(input.cwd, { operations: {
      async readFile(path: string) { guard.file(path); return secureReadFile(path); },
      async writeFile(path: string, content: string) { guard.file(path); await secureWriteFile(path, content); },
      async access(path: string) { guard.file(path); await secureWritableAccess(path); },
    } }),
    createWriteToolDefinition(input.cwd, { operations: {
      async writeFile(path: string, content: string) { guard.file(path); await secureWriteFile(path, content); },
      async mkdir(path: string) { guard.directory(path); await mkdir(path, { recursive: true }); },
    } }),
  ];
}

export function createWorkspaceReadGuard(
  cwdValue: string,
  protectedWorkspacePaths: readonly string[] = [],
): (path: string) => string {
  if (!isAbsolute(cwdValue) || !existsSync(cwdValue)) throw new Error("BUILD worker cwd must be an existing absolute directory");
  const lexicalCwd = resolve(cwdValue);
  const cwd = realpathSync(cwdValue);
  const protectedPaths = normalizeProtectedWorkspacePaths(protectedWorkspacePaths);
  return (path: string) => {
    if (!isAbsolute(path)) throw new Error("BUILD worker read target must be absolute");
    const target = resolve(path);
    const fromLexicalCwd = relative(lexicalCwd, target);
    const fromCanonicalCwd = relative(cwd, target);
    const lexicalBase = isContainedRelativePath(fromLexicalCwd)
      ? lexicalCwd
      : isContainedRelativePath(fromCanonicalCwd)
        ? cwd
        : undefined;
    if (lexicalBase === undefined) {
      throw new Error(`BUILD worker read escaped its workspace: ${path}`);
    }
    const fromCwd = relative(lexicalBase, target);
    if (isProtectedWorkspacePath(fromCwd, protectedPaths)) {
      throw new Error(`BUILD worker cannot read protected orchestration or Git metadata: ${path}`);
    }
    assertNoExistingSymlink(lexicalBase, target, "read");
    if (!existsSync(target)) return target;
    const canonical = realpathSync(target);
    const canonicalRelative = relative(cwd, canonical);
    if (!isContainedRelativePath(canonicalRelative)) {
      throw new Error(`BUILD worker read escaped its workspace: ${path}`);
    }
    assertNotHardLinkedFile(canonical, "read");
    return canonical;
  };
}

function isContainedRelativePath(value: string): boolean {
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function normalizeProtectedWorkspacePaths(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
      throw new Error("BUILD worker protected workspace path must be a non-empty relative path");
    }
    const parts: string[] = [];
    for (const part of value.split(/[\\/]+/)) {
      if (part.length === 0 || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) throw new Error("BUILD worker protected workspace path must remain contained");
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    if (parts.length === 0) throw new Error("BUILD worker protected workspace path must remain contained");
    return parts.join("/").toLowerCase();
  });
  return Object.freeze([...new Set(normalized)].sort());
}

function isProtectedWorkspacePath(relativePath: string, protectedPaths: readonly string[]): boolean {
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean).join("/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.includes(".git") || segments.includes(".ai-orchestrator")) return true;
  return protectedPaths.some((protectedPath) =>
    normalized === protectedPath || normalized.startsWith(`${protectedPath}/`));
}

function createDeclaredMutationGuard(
  cwdValue: string,
  declared: readonly string[],
  protectedWorkspacePaths: readonly string[],
): Readonly<{
  file(path: string): void;
  directory(path: string): void;
}> {
  if (!isAbsolute(cwdValue) || !existsSync(cwdValue)) throw new Error("BUILD worker cwd must be an existing absolute directory");
  const lexicalCwd = resolve(cwdValue);
  const cwd = realpathSync(cwdValue);
  const protectedPaths = normalizeProtectedWorkspacePaths(protectedWorkspacePaths);
  const checkContained = (path: string): Readonly<{ target: string; base: string }> => {
    if (!isAbsolute(path)) throw new Error("BUILD worker mutation target must be absolute");
    const target = resolve(path);
    const fromLexicalCwd = relative(lexicalCwd, target);
    const fromCanonicalCwd = relative(cwd, target);
    const base = isContainedRelativePath(fromLexicalCwd)
      ? lexicalCwd
      : isContainedRelativePath(fromCanonicalCwd)
        ? cwd
        : undefined;
    if (base === undefined) {
      throw new Error(`BUILD worker mutation escaped its workspace: ${path}`);
    }
    const fromCwd = relative(base, target);
    if (isProtectedWorkspacePath(fromCwd, protectedPaths)) {
      throw new Error(`BUILD worker cannot mutate protected orchestration or Git metadata: ${path}`);
    }
    assertNoExistingSymlink(base, target, "mutation");
    return Object.freeze({ target, base });
  };
  return Object.freeze({
    file(path: string) {
      const { target, base } = checkContained(path);
      const roots = declared.map((declaredPath) => resolve(base, declaredPath));
    if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
      throw new Error(`BUILD worker mutation is outside the declared write set: ${path}`);
    }
    if (existsSync(target)) assertNotHardLinkedFile(target, "mutation");
    },
    directory(path: string) {
      const { target, base } = checkContained(path);
      const roots = declared.map((declaredPath) => resolve(base, declaredPath));
      if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`) || root.startsWith(`${target}${sep}`))) {
        throw new Error(`BUILD worker directory creation is outside the declared write set: ${path}`);
      }
    },
  });
}

function assertNoExistingSymlink(cwd: string, target: string, operation: "read" | "mutation"): void {
  const fromCwd = relative(cwd, target);
  let current = cwd;
  for (const part of fromCwd.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`BUILD worker ${operation} path contains a symlink: ${current}`);
  }
}

function assertSafeRegularFile(fileStats: Stats, path: string, operation: "read" | "mutation"): void {
  if (!fileStats.isFile()) throw new Error(`BUILD worker ${operation} target must be a regular file: ${path}`);
  if (fileStats.nlink !== 1) {
    throw new Error(`BUILD worker ${operation} target must not be hard linked: ${path}`);
  }
}

function assertNotHardLinkedFile(path: string, operation: "read" | "mutation"): void {
  const fileStats = lstatSync(path);
  if (fileStats.isFile() && fileStats.nlink !== 1) {
    throw new Error(`BUILD worker ${operation} target must not be hard linked: ${path}`);
  }
}

async function secureReadFile(path: string, maxBytes = MAX_WORKER_FILE_BYTES): Promise<Buffer> {
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fileStats = await descriptor.stat();
    assertSafeRegularFile(fileStats, path, "read");
    if (fileStats.size > maxBytes) throw new Error(`BUILD worker read target exceeds its ${maxBytes}-byte bound: ${path}`);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, maxBytes + 1 - offset));
      const { bytesRead } = await descriptor.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`BUILD worker read target exceeds its ${maxBytes}-byte bound: ${path}`);
    return Buffer.concat(chunks, offset);
  } finally {
    await descriptor.close();
  }
}

async function secureReadableAccess(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertSafeRegularFile(await descriptor.stat(), path, "read");
  } finally {
    await descriptor.close();
  }
}

async function secureWritableAccess(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    assertSafeRegularFile(await descriptor.stat(), path, "mutation");
  } finally {
    await descriptor.close();
  }
}

async function secureWriteFile(path: string, content: string): Promise<void> {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_WORKER_FILE_BYTES) {
    throw new Error(`BUILD worker mutation content exceeds its ${MAX_WORKER_FILE_BYTES}-byte bound`);
  }
  let descriptor;
  try {
    descriptor = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    descriptor = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o666,
    );
  }
  try {
    assertSafeRegularFile(await descriptor.stat(), path, "mutation");
    await descriptor.truncate(0);
    await descriptor.writeFile(content, { encoding: "utf8" });
  } finally {
    await descriptor.close();
  }
}

interface SecureGrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface SecureGrepDetails {
  truncation?: Readonly<{
    truncated: true;
    originalBytes: number;
    outputBytes: number;
    maxBytes: number;
  }>;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  filesSkipped?: number;
}

interface SecureLsInput {
  path?: string;
  limit?: number;
}

function createSecureLsToolDefinition(
  cwd: string,
  guard: (path: string) => string,
): unknown {
  return defineTool({
    name: "ls",
    label: "ls",
    description: `List a bounded directory. Protected metadata and links are excluded; at most ${MAX_LS_ENTRIES} entries are returned.`,
    promptSnippet: "List bounded directory contents",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: `Maximum entries (default and maximum: ${MAX_LS_ENTRIES})` })),
    }),
    async execute(
      _toolCallId: string,
      params: SecureLsInput,
      signal?: AbortSignal,
    ) {
      const limit = params.limit === undefined ? MAX_LS_ENTRIES : params.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LS_ENTRIES) {
        throw new Error("BUILD worker ls limit is outside its bounded range");
      }
      if (signal?.aborted) throw abortError("BUILD worker ls was aborted");
      const directory = guard(resolve(cwd, params.path || "."));
      if (!(await stat(directory)).isDirectory()) throw new Error("BUILD worker ls path must be a directory");
      const results: string[] = [];
      let visitedEntries = 0;
      let entryLimitReached = false;
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (signal?.aborted) throw abortError("BUILD worker ls was aborted");
        visitedEntries += 1;
        if (visitedEntries > MAX_LS_VISITED_ENTRIES) {
          throw new Error("BUILD worker ls exceeded its entry budget");
        }
        if (entry.isSymbolicLink() || isExcludedTraversalEntry(entry.name)) continue;
        try {
          guard(resolve(directory, entry.name));
        } catch {
          continue;
        }
        results.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (results.length > limit) {
          entryLimitReached = true;
          results.pop();
          break;
        }
      }
      results.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      if (results.length === 0) {
        return Object.freeze({
          content: Object.freeze([{ type: "text" as const, text: "(empty directory)" }]),
          details: undefined,
        });
      }
      const bounded = boundedLineOutput(results, MAX_TOOL_OUTPUT_BYTES);
      const notices: string[] = [];
      if (entryLimitReached) notices.push(`${limit} entries limit reached`);
      if (bounded.truncated) notices.push(`${MAX_TOOL_OUTPUT_BYTES / 1024}KB output limit reached`);
      const output = notices.length === 0 ? bounded.text : `${bounded.text}\n\n[${notices.join(". ")}]`;
      const details = {
        ...(entryLimitReached ? { entryLimitReached: limit } : {}),
        ...(bounded.truncated ? {
          truncation: Object.freeze({
            truncated: true as const,
            outputBytes: Buffer.byteLength(bounded.text, "utf8"),
            maxBytes: MAX_TOOL_OUTPUT_BYTES,
          }),
        } : {}),
      };
      return Object.freeze({
        content: Object.freeze([{ type: "text" as const, text: output }]),
        details: Object.keys(details).length === 0 ? undefined : Object.freeze(details),
      });
    },
  });
}

function boundedLineOutput(lines: readonly string[], maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const accepted: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const added = Buffer.byteLength(line, "utf8") + (accepted.length === 0 ? 0 : 1);
    if (bytes + added > maxBytes) return Object.freeze({ text: accepted.join("\n"), truncated: true });
    accepted.push(line);
    bytes += added;
  }
  return Object.freeze({ text: accepted.join("\n"), truncated: false });
}

function isExcludedTraversalEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return /[\u0000-\u001f\u007f]/.test(name) || lower === ".git" || lower === ".ai-orchestrator" || lower === "node_modules";
}

interface SecureFindInput {
  pattern: string;
  path?: string;
  limit?: number;
}

function createSecureFindToolDefinition(
  cwd: string,
  guard: (path: string) => string,
): unknown {
  return defineTool({
    name: "find",
    label: "find",
    description: `Search bounded workspace paths by glob pattern. Protected metadata, links, and node_modules are excluded. Returns at most ${MAX_GLOB_RESULTS} paths.`,
    promptSnippet: "Find files by a bounded glob pattern",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern such as '*.ts' or 'src/**/*.test.ts'" }),
      path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: `Maximum results (default and maximum: ${MAX_GLOB_RESULTS})` })),
    }),
    async execute(
      _toolCallId: string,
      params: SecureFindInput,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw abortError("BUILD worker find was aborted");
      const limit = params.limit === undefined ? MAX_GLOB_RESULTS : params.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GLOB_RESULTS) {
        throw new Error("BUILD worker find limit is outside its bounded range");
      }
      const root = guard(resolve(cwd, params.path || "."));
      if (!(await stat(root)).isDirectory()) throw new Error("BUILD worker find path must be a directory");
      const results = await secureGlob(root, params.pattern, limit, guard, signal);
      if (results.length === 0) {
        return Object.freeze({
          content: Object.freeze([{ type: "text" as const, text: "No files found matching pattern" }]),
          details: undefined,
        });
      }
      const paths = results.map((path) => relative(root, path).split(sep).join("/"));
      const resultLimitReached = paths.length >= limit;
      const bounded = boundedLineOutput(paths, MAX_TOOL_OUTPUT_BYTES);
      const notices: string[] = [];
      if (resultLimitReached) notices.push(`${limit} results limit reached`);
      if (bounded.truncated) notices.push(`${MAX_TOOL_OUTPUT_BYTES / 1024}KB output limit reached`);
      const output = notices.length === 0 ? bounded.text : `${bounded.text}\n\n[${notices.join(". ")}]`;
      const details = {
        ...(resultLimitReached ? { resultLimitReached: limit } : {}),
        ...(bounded.truncated ? {
          truncation: Object.freeze({
            truncated: true as const,
            outputBytes: Buffer.byteLength(bounded.text, "utf8"),
            maxBytes: MAX_TOOL_OUTPUT_BYTES,
          }),
        } : {}),
      };
      return Object.freeze({
        content: Object.freeze([{ type: "text" as const, text: output }]),
        details: Object.keys(details).length === 0 ? undefined : Object.freeze(details),
      });
    },
  });
}

function createSecureGrepToolDefinition(
  cwd: string,
  guard: (path: string) => string,
): unknown {
  return defineTool({
    name: "grep",
    label: "grep",
    description: "Search securely enumerated workspace files for a pattern. Protected metadata and symlinks are never searched.",
    promptSnippet: "Search file contents without crossing protected workspace boundaries",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
      context: Type.Optional(Type.Number({ description: "Context lines before and after each match" })),
      limit: Type.Optional(Type.Number({ description: "Maximum matches to return" })),
    }),
    async execute(
      _toolCallId: string,
      params: SecureGrepInput,
      signal?: AbortSignal,
    ) {
      return secureGrep(cwd, guard, params, signal);
    },
  });
}

async function secureGrep(
  cwd: string,
  guard: (path: string) => string,
  params: SecureGrepInput,
  signal?: AbortSignal,
): Promise<Readonly<{
  content: readonly Readonly<{ type: "text"; text: string }>[];
  details: SecureGrepDetails | undefined;
}>> {
  if (typeof params.pattern !== "string" || params.pattern.length === 0 ||
      Buffer.byteLength(params.pattern, "utf8") > MAX_GREP_PATTERN_BYTES || params.pattern.includes("\0")) {
    throw new Error("BUILD worker grep pattern is invalid or oversized");
  }
  if (params.ignoreCase !== undefined && typeof params.ignoreCase !== "boolean" ||
      params.literal !== undefined && typeof params.literal !== "boolean") {
    throw new Error("BUILD worker grep flags are invalid");
  }
  const context = params.context === undefined ? 0 : params.context;
  const requestedLimit = params.limit === undefined ? 100 : params.limit;
  if (!Number.isSafeInteger(context) || context < 0 || context > MAX_GREP_CONTEXT ||
      !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_GREP_MATCHES) {
    throw new Error("BUILD worker grep context or limit is outside its bounded range");
  }
  if (signal?.aborted) throw abortError("BUILD worker grep was aborted");
  const target = guard(resolve(cwd, params.path || "."));
  const targetStat = await stat(target);
  const targetIsDirectory = targetStat.isDirectory();
  if (!targetIsDirectory && !targetStat.isFile()) throw new Error("BUILD worker grep target must be a regular file or directory");
  const matcher = params.glob === undefined ? undefined : compileGlob(params.glob);
  const files = targetIsDirectory
    ? await secureGlob(target, params.glob ?? "**/*", MAX_GREP_FILES, guard, signal)
    : matcher === undefined || matcher.test(target.split(sep).at(-1) ?? "") ? [target] : [];
  const outputLines: string[] = [];
  let matchCount = 0;
  let totalBytes = 0;
  let linesTruncated = false;
  let filesSkipped = 0;
  let batchBytes = 0;
  let batch: Array<Readonly<{
    bytes: Buffer;
    displayPath: string;
    startLine: number;
    endLineExclusive: number;
  }>> = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0 || matchCount >= requestedLimit) return;
    const chunks: Buffer[] = [];
    for (const file of batch) {
      chunks.push(file.bytes);
      if (file.bytes.length === 0 || file.bytes[file.bytes.length - 1] !== 0x0a) chunks.push(Buffer.from("\n"));
    }
    const matchLines = await ripgrepStdin(
      Buffer.concat(chunks),
      params,
      requestedLimit - matchCount,
      signal,
    );
    let fileIndex = 0;
    const decoded = new Map<number, string[]>();
    for (const lineNumber of matchLines) {
      while (fileIndex + 1 < batch.length && lineNumber >= batch[fileIndex]!.endLineExclusive) fileIndex += 1;
      const file = batch[fileIndex];
      if (file === undefined || lineNumber < file.startLine || lineNumber >= file.endLineExclusive) {
        throw new Error("BUILD worker grep returned a line outside its bounded input map");
      }
      const localLine = lineNumber - file.startLine + 1;
      let contentLines = decoded.get(fileIndex);
      if (contentLines === undefined) {
        contentLines = file.bytes.toString("utf8").split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
        decoded.set(fileIndex, contentLines);
      }
      matchCount += 1;
      const start = Math.max(1, localLine - context);
      const end = Math.min(contentLines.length, localLine + context);
      for (let current = start; current <= end; current += 1) {
        const truncated = truncateGrepLine(contentLines[current - 1] ?? "");
        linesTruncated ||= truncated.truncated;
        outputLines.push(current === localLine
          ? `${file.displayPath}:${current}: ${truncated.text}`
          : `${file.displayPath}-${current}- ${truncated.text}`);
      }
    }
    batch = [];
    batchBytes = 0;
  };

  for (const file of files) {
    if (matchCount >= requestedLimit) break;
    if (signal?.aborted) throw abortError("BUILD worker grep was aborted");
    let bytes: Buffer;
    try {
      bytes = await secureReadFile(guard(file), MAX_GREP_FILE_BYTES);
    } catch (error) {
      if (error instanceof Error && /exceeds its \d+-byte bound/.test(error.message)) {
        filesSkipped += 1;
        continue;
      }
      throw error;
    }
    if (bytes.byteLength > MAX_GREP_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_GREP_TOTAL_BYTES) throw new Error("BUILD worker grep exceeded its aggregate read budget");
    const displayPath = targetIsDirectory
      ? relative(target, file).split(sep).join("/")
      : file.split(sep).at(-1) ?? file;
    const separatorBytes = bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a ? 1 : 0;
    if (batch.length > 0 && batchBytes + bytes.byteLength + separatorBytes > MAX_GREP_BATCH_BYTES) {
      await flushBatch();
      if (matchCount >= requestedLimit) break;
    }
    const startLine = batch.length === 0 ? 1 : batch[batch.length - 1]!.endLineExclusive;
    let lineCount = separatorBytes;
    for (const byte of bytes) if (byte === 0x0a) lineCount += 1;
    batch.push(Object.freeze({
      bytes,
      displayPath,
      startLine,
      endLineExclusive: startLine + Math.max(1, lineCount),
    }));
    batchBytes += bytes.byteLength + separatorBytes;
  }
  await flushBatch();

  if (matchCount === 0) {
    return Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "No matches found" }]),
      details: filesSkipped === 0 ? undefined : Object.freeze({ filesSkipped }),
    });
  }
  const rawOutput = outputLines.join("\n");
  const truncatedOutput = truncateGrepOutput(rawOutput);
  const details: SecureGrepDetails = {
    ...(matchCount >= requestedLimit ? { matchLimitReached: requestedLimit } : {}),
    ...(linesTruncated ? { linesTruncated: true } : {}),
    ...(filesSkipped > 0 ? { filesSkipped } : {}),
    ...(truncatedOutput.truncation === undefined ? {} : { truncation: truncatedOutput.truncation }),
  };
  const notices: string[] = [];
  if (details.matchLimitReached) notices.push(`${details.matchLimitReached} matches limit reached`);
  if (details.truncation) notices.push(`${MAX_GREP_OUTPUT_BYTES / 1024}KB output limit reached`);
  if (details.linesTruncated) notices.push(`some lines truncated to ${MAX_GREP_LINE_LENGTH} chars`);
  if (details.filesSkipped) notices.push(`${details.filesSkipped} oversized file(s) skipped`);
  const text = notices.length === 0
    ? truncatedOutput.text
    : `${truncatedOutput.text}\n\n[${notices.join(". ")}]`;
  return Object.freeze({
    content: Object.freeze([{ type: "text" as const, text }]),
    details: Object.keys(details).length === 0 ? undefined : Object.freeze(details),
  });
}

async function ripgrepStdin(
  bytes: Uint8Array,
  params: Pick<SecureGrepInput, "pattern" | "ignoreCase" | "literal">,
  limit: number,
  signal?: AbortSignal,
): Promise<number[]> {
  return new Promise<number[]>((resolvePromise, reject) => {
    const args = ["--line-number", "--no-heading", "--color=never", "--text", "--max-count", String(limit)];
    if (params.ignoreCase) args.push("--ignore-case");
    if (params.literal) args.push("--fixed-strings");
    args.push("--", params.pattern, "-");
    const child = spawn("rg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      work();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(abortError("BUILD worker grep was aborted")));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_GREP_FILE_BYTES) {
        child.kill();
        finish(() => reject(new Error("BUILD worker grep subprocess output exceeded its bound")));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_SUMMARY_BYTES) {
        child.kill();
        finish(() => reject(new Error("BUILD worker grep subprocess error exceeded its bound")));
      }
    });
    child.on("error", (error) => finish(() => reject(new Error(`BUILD worker grep failed to start: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `BUILD worker grep exited with code ${code}`));
        return;
      }
      const lines = stdout.split("\n").filter(Boolean).map((line) => {
        const match = /^(\d+):/.exec(line);
        if (!match) throw new Error("BUILD worker grep returned an invalid line record");
        return Number(match[1]);
      });
      resolvePromise(lines);
    }));
    child.stdin.on("error", (error) => finish(() => reject(new Error(`BUILD worker grep input failed: ${error.message}`))));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(bytes);
  });
}

function truncateGrepLine(value: string): Readonly<{ text: string; truncated: boolean }> {
  const sanitized = value.replace(/\r/g, "");
  if (sanitized.length <= MAX_GREP_LINE_LENGTH) return Object.freeze({ text: sanitized, truncated: false });
  return Object.freeze({ text: `${sanitized.slice(0, MAX_GREP_LINE_LENGTH)}...`, truncated: true });
}

function truncateGrepOutput(value: string): Readonly<{
  text: string;
  truncation?: SecureGrepDetails["truncation"];
}> {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= MAX_GREP_OUTPUT_BYTES) return Object.freeze({ text: value });
  const bytes = Buffer.from(value, "utf8").subarray(0, MAX_GREP_OUTPUT_BYTES);
  const text = bytes.toString("utf8").replace(/[^\n]*$/, "").replace(/\n$/, "");
  return Object.freeze({
    text,
    truncation: Object.freeze({
      truncated: true as const,
      originalBytes,
      outputBytes: Buffer.byteLength(text, "utf8"),
      maxBytes: MAX_GREP_OUTPUT_BYTES,
    }),
  });
}

async function secureGlob(
  root: string,
  pattern: string,
  requestedLimit: number,
  guard: (path: string) => string,
  signal?: AbortSignal,
): Promise<string[]> {
  const matcher = compileGlob(pattern);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_GLOB_RESULTS)
    : MAX_GLOB_RESULTS;
  const results: string[] = [];
  const patternHasPath = pattern.includes("/");
  let visitedEntries = 0;
  let visitedDirectories = 0;
  const walk = async (directory: string): Promise<void> => {
    if (results.length >= limit) return;
    if (signal?.aborted) throw abortError("BUILD worker file traversal was aborted");
    visitedDirectories += 1;
    if (visitedDirectories > MAX_GLOB_VISITED_DIRECTORIES) {
      throw new Error("BUILD worker file traversal exceeded its directory budget");
    }
    const entries = await opendir(guard(directory));
    for await (const entry of entries) {
      if (signal?.aborted) throw abortError("BUILD worker file traversal was aborted");
      visitedEntries += 1;
      if (visitedEntries > MAX_GLOB_VISITED_ENTRIES) {
        throw new Error("BUILD worker file traversal exceeded its entry budget");
      }
      if (results.length >= limit) return;
      if (entry.isSymbolicLink() || isExcludedTraversalEntry(entry.name)) {
        continue;
      }
      const target = resolve(directory, entry.name);
      let canonical: string;
      try {
        canonical = guard(target);
      } catch {
        continue;
      }
      const relativePath = relative(root, canonical).split(sep).join("/");
      if (entry.isDirectory()) {
        await walk(canonical);
      } else if (entry.isFile() && matcher.test(patternHasPath ? relativePath : entry.name)) {
        results.push(canonical);
      }
    }
  };
  await walk(root);
  return results;
}

interface GlobMatcher {
  test(value: string): boolean;
}

function compileGlob(value: string): GlobMatcher {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_GLOB_PATTERN_BYTES ||
      /[\0\r\n]/.test(value) || isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error("BUILD worker find pattern is invalid");
  }
  const pattern = value.replace(/^\.\//, "");
  const patternSegments = pattern.split("/");
  if (patternSegments.some((segment) => segment.length === 0 || segment.includes("**") && segment !== "**")) {
    throw new Error("BUILD worker find pattern has an unsupported globstar placement");
  }
  return Object.freeze({
    test(candidate: string): boolean {
      if (candidate.includes("\\") || candidate.split("/").some((segment) => segment.length === 0)) return false;
      return matchGlobSegments(patternSegments, candidate.split("/"));
    },
  });
}

function matchGlobSegments(pattern: readonly string[], candidate: readonly string[]): boolean {
  let patternIndex = 0;
  let candidateIndex = 0;
  let globstarIndex = -1;
  let globstarCandidateIndex = -1;
  while (candidateIndex < candidate.length) {
    const patternSegment = pattern[patternIndex];
    if (patternSegment === "**") {
      globstarIndex = patternIndex;
      globstarCandidateIndex = candidateIndex;
      patternIndex += 1;
      continue;
    }
    if (patternSegment !== undefined && matchGlobSegment(patternSegment, candidate[candidateIndex]!)) {
      patternIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (globstarIndex >= 0) {
      patternIndex = globstarIndex + 1;
      globstarCandidateIndex += 1;
      candidateIndex = globstarCandidateIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "**") patternIndex += 1;
  return patternIndex === pattern.length;
}

function matchGlobSegment(pattern: string, candidate: string): boolean {
  let patternIndex = 0;
  let candidateIndex = 0;
  let starIndex = -1;
  let starCandidateIndex = -1;
  while (candidateIndex < candidate.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "?" || patternCharacter === candidate[candidateIndex]) {
      patternIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (patternCharacter === "*") {
      starIndex = patternIndex;
      starCandidateIndex = candidateIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starCandidateIndex += 1;
      candidateIndex = starCandidateIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
