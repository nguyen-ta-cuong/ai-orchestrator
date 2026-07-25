function schema(type: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, ...properties };
}

export function StringEnum(values: readonly string[]): Record<string, unknown> {
  return schema("string", { enum: [...values] });
}

export const Type = {
  Object(properties: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return schema("object", { properties, ...options });
  },
  String(options: Record<string, unknown> = {}) {
    return schema("string", options);
  },
  Integer(options: Record<string, unknown> = {}) {
    return schema("integer", options);
  },
  Number(options: Record<string, unknown> = {}) {
    return schema("number", options);
  },
  Boolean(options: Record<string, unknown> = {}) {
    return schema("boolean", options);
  },
  Literal(value: unknown) {
    return { const: value };
  },
  Array(itemSchema: unknown, options: Record<string, unknown> = {}) {
    return schema("array", { items: itemSchema, ...options });
  },
  Optional(itemSchema: unknown) {
    return { ...itemSchema as Record<string, unknown>, optional: true };
  },
};

export class DefaultResourceLoader {
  constructor(_options: unknown) {}
  async reload(): Promise<void> {}
}

export const SessionManager = {
  inMemory: (_cwd?: string) => ({}),
};

export function getAgentDir(): string {
  return "/tmp/pi-agent";
}

export function defineTool<T>(tool: T): T {
  return tool;
}

function builtinTool(name: string, options?: Record<string, unknown>): Record<string, unknown> {
  return { name, ...(options === undefined ? {} : { options }) };
}

function toolPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export const createReadToolDefinition = (cwd: string, options?: Record<string, unknown>) => ({
  ...builtinTool("read", options),
  async execute(_id: string, params: { path: string }) {
    const operations = options?.operations as { readFile(path: string): Promise<Buffer | string> };
    const content = await operations.readFile(toolPath(cwd, params.path));
    return { content: [{ type: "text", text: content.toString() }], details: undefined };
  },
});
export const createGrepToolDefinition = (_cwd: string, options?: Record<string, unknown>) => builtinTool("grep", options);
export const createFindToolDefinition = (_cwd: string, options?: Record<string, unknown>) => builtinTool("find", options);
export const createLsToolDefinition = (_cwd: string, options?: Record<string, unknown>) => builtinTool("ls", options);
export const createEditToolDefinition = (cwd: string, options?: Record<string, unknown>) => ({
  ...builtinTool("edit", options),
  async execute(_id: string, params: { path: string; oldText: string; newText: string }) {
    const operations = options?.operations as {
      readFile(path: string): Promise<Buffer | string>;
      writeFile(path: string, content: string): Promise<void>;
      access(path: string): Promise<void>;
    };
    const path = toolPath(cwd, params.path);
    await operations.access(path);
    const previous = (await operations.readFile(path)).toString();
    if (!previous.includes(params.oldText)) throw new Error("edit oldText was not found");
    await operations.writeFile(path, previous.replace(params.oldText, params.newText));
    return { content: [{ type: "text", text: "Edit applied" }], details: undefined };
  },
});
export const createWriteToolDefinition = (cwd: string, options?: Record<string, unknown>) => ({
  ...builtinTool("write", options),
  async execute(_id: string, params: { path: string; content: string }) {
    const operations = options?.operations as {
      writeFile(path: string, content: string): Promise<void>;
      mkdir(path: string): Promise<void>;
    };
    const path = toolPath(cwd, params.path);
    await operations.mkdir(dirname(path));
    await operations.writeFile(path, params.content);
    return { content: [{ type: "text", text: "Wrote file" }], details: undefined };
  },
});

export async function createAgentSession(options: Record<string, unknown>): Promise<{ session: Record<string, unknown> }> {
  let idle = true;
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    get isIdle() { return idle; },
    state: { messages: [] as unknown[] },
    async prompt(text: string) {
      idle = false;
      const payload = text.split("\n\n").find((part) => part.startsWith("{\"planId\""));
      const parsed = payload ? JSON.parse(payload) as {
        node: { handler: string; writeSet: string[]; outputContracts: Array<{ id: string; kind: string }> };
      } : undefined;
      const cwd = String(options.cwd);
      if (parsed?.node.handler === "implement") {
        const declared = parsed.node.writeSet.find((path) => path.toLowerCase().includes("readme")) ?? parsed.node.writeSet[0];
        if (declared) {
          const target = declared.includes(".") ? join(cwd, declared) : join(cwd, declared, "nested-build-change.txt");
          mkdirSync(dirname(target), { recursive: true });
          if (existsSync(target)) appendFileSync(target, "\nNested BUILD test change.\n");
          else writeFileSync(target, "Nested BUILD test change.\n");
        }
      }
      const customTools = options.customTools as Array<{
        name?: string;
        execute?: (id: string, params: unknown) => Promise<unknown>;
      }> | undefined;
      const result = customTools?.find(({ name }) => name === "submit_build_worker_result");
      await result?.execute?.("test-result", {
        outcome: "succeeded",
        summary: "Completed nested BUILD test worker.",
        outputs: (parsed?.node.outputContracts ?? [])
          .filter(({ kind }) => kind !== "file-set")
          .map(({ id }) => ({ contractId: id, content: "{}" })),
      });
      idle = true;
      const message = { role: "assistant", content: [], stopReason: "stop" };
      session.state.messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async waitForIdle() {},
    async abort() { idle = true; },
    dispose() {},
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getSessionStats: () => ({ tokens: { input: 40, output: 20 }, cost: 0.004 }),
  };
  return { session };
}
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
