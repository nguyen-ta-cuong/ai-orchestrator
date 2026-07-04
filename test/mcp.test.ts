import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpTestClient {
  private nextId = 1;
  private buffer = "";
  private messages: JsonRpcResponse[] = [];
  private parseErrors: string[] = [];
  private waiters: Array<() => void> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          try {
            this.messages.push(JSON.parse(line) as JsonRpcResponse);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.parseErrors.push(`Failed to parse stdout JSON-RPC line ${JSON.stringify(line)}: ${message}`);
          }
          for (const waiter of this.waiters.splice(0)) waiter();
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await this.waitFor(id);
    if (response.error) {
      throw new Error(`${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private async waitFor(id: number): Promise<JsonRpcResponse> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (this.parseErrors.length > 0) {
        throw new Error(this.parseErrors.join("\n"));
      }
      const response = this.messages.find((message) => message.id === id);
      if (response) return response;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for JSON-RPC response ${id}`);
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }
}

const tempDirs: string[] = [];

beforeAll(() => {
  try {
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc")], { stdio: "pipe", timeout: 120_000 });
  } catch (error) {
    const maybeExecError = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    throw new Error(
      [
        maybeExecError.message ?? "tsc failed",
        maybeExecError.stdout?.toString(),
        maybeExecError.stderr?.toString(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}, 120_000);

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-orchestrator-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function withServer<T>(fn: (client: McpTestClient) => Promise<T>, env: Record<string, string> = {}): Promise<T> {
  const cwd = tempDir();
  const home = tempDir();
  const child = spawn(process.execPath, [resolve("dist/mcp/server.js")], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      HOME: home,
      USERPROFILE: home,
      AI_ORCH_FAKE_LLM: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const client = new McpTestClient(child);
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ai-orchestrator-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized");
    return await fn(client);
  } catch (error) {
    if (stderr) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstderr:\n${stderr}`);
    }
    throw error;
  } finally {
    child.kill();
  }
}

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0].text;
}

describe("MCP server", () => {
  it("lists orchestrator tools with input schemas", async () => {
    await withServer(async (client) => {
      const result = (await client.request("tools/list")) as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> };
      const names = result.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["orchestrator_judge", "orchestrator_plan"]);

      const plan = result.tools.find((tool) => tool.name === "orchestrator_plan");
      expect(plan?.inputSchema?.properties).toHaveProperty("task");
      expect(plan?.inputSchema?.properties).toHaveProperty("repoContext");
      expect(plan?.inputSchema?.properties).toHaveProperty("diffSummary");
      expect(plan?.inputSchema?.required).toContain("task");

      const judge = result.tools.find((tool) => tool.name === "orchestrator_judge");
      expect(judge?.inputSchema?.properties).toHaveProperty("diff");
      expect(judge?.inputSchema?.properties).toHaveProperty("consecutiveRejections");
      expect(judge?.inputSchema?.required).toEqual(
        expect.arrayContaining(["task", "plan", "diff", "iteration", "consecutiveRejections"]),
      );
    });
  });

  it("calls orchestrator_plan for fresh plans and replans", async () => {
    await withServer(async (client) => {
      const fresh = await client.request("tools/call", {
        name: "orchestrator_plan",
        arguments: { task: "add a flag", repoContext: "cli.ts parses argv" },
      });
      expect(toolText(fresh)).toContain("Present this plan to the user for approval");

      const replan = await client.request("tools/call", {
        name: "orchestrator_plan",
        arguments: {
          task: "add a flag",
          previousPlan: "1. edit cli",
          diffSummary: "diff --git a/cli.ts b/cli.ts\n+broken",
          judgeReports: "reject: missing tests",
        },
      });
      expect(toolText(replan)).toContain("Present this plan to the user for approval");
    });
  });

  it.each([
    [{ iteration: 1, consecutiveRejections: 0 }, "retry_coding"],
    [{ iteration: 2, consecutiveRejections: 1 }, "replan"],
    [{ iteration: 3, consecutiveRejections: 1 }, "stop_failed"],
  ] as const)("computes reject nextAction %s via the core loop policy", async (counters, nextAction) => {
    await withServer(async (client) => {
      const result = await client.request("tools/call", {
        name: "orchestrator_judge",
        arguments: {
          task: "add a flag",
          plan: "1. edit cli\n2. test",
          diff: "diff --git a/cli.ts b/cli.ts\n+broken",
          testOutput: "failing test",
          ...counters,
        },
      });

      const parsed = JSON.parse(toolText(result)) as { verdict: string; nextAction: string; requiredFixes?: string };
      expect(parsed.verdict).toBe("reject");
      expect(parsed.requiredFixes).toContain("fake failing condition");
      expect(parsed.nextAction).toBe(nextAction);
    });
  });

  it("computes done nextAction for approve verdicts", async () => {
    await withServer(async (client) => {
      const result = await client.request("tools/call", {
        name: "orchestrator_judge",
        arguments: {
          task: "add a flag",
          plan: "1. edit cli\n2. test",
          diff: "diff --git a/cli.ts b/cli.ts\n+working",
          testOutput: "passing test",
          iteration: 1,
          consecutiveRejections: 0,
        },
      });

      const parsed = JSON.parse(toolText(result)) as { verdict: string; nextAction: string; requiredFixes?: string };
      expect(parsed.verdict).toBe("approve");
      expect(parsed.requiredFixes).toBeUndefined();
      expect(parsed.nextAction).toBe("done");
    }, { AI_ORCH_FAKE_LLM_VERDICT: "approve" });
  });
});
