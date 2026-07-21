import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pathsForRun } from "../src/lifecycle/artifacts.js";

const architecture = readFileSync(resolve("docs/graph-architecture.md"), "utf8");
const fastExtension = readFileSync(resolve("extensions/orchestrator.ts"), "utf8");
const lifecycleExtension = readFileSync(resolve("extensions/lifecycle.ts"), "utf8");
const mcpServer = readFileSync(resolve("mcp/server.ts"), "utf8");
const fastReducer = readFileSync(resolve("src/core/loop.ts"), "utf8");
const lifecycleReducer = readFileSync(resolve("src/core/lifecycle.ts"), "utf8");
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "ai-orchestrator-graph-docs-")));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

function typeMembers(source: string, typeName: string): string[] {
  const declaration = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`))?.[1];
  if (!declaration) throw new Error(`Could not find ${typeName}`);
  return captures(declaration, /"([a-z_]+)"/g);
}

describe("structured graph architecture documentation", () => {
  it("names every registered Pi command so command documentation cannot drift", () => {
    const directCommands = [fastExtension, lifecycleExtension]
      .flatMap((source) => captures(source, /pi\.registerCommand\("([a-z-]+)"/g));
    const stageCommands = captures(lifecycleExtension, /registerStageCommand\("([a-z-]+)"/g);

    for (const command of [...new Set([...directCommands, ...stageCommands])]) {
      expect(architecture, `missing /${command}`).toContain(`\`/${command}\``);
    }
  });

  it("names every structured workflow tool exposed by Pi and MCP", () => {
    const piTools = [fastExtension, lifecycleExtension]
      .flatMap((source) => captures(source, /name:\s*"([a-z_]+)"/g));
    const mcpTools = captures(mcpServer, /server\.registerTool\(\s*"([a-z_]+)"/g);

    for (const tool of new Set([...piTools, ...mcpTools])) {
      expect(architecture, `missing tool ${tool}`).toContain(`\`${tool}\``);
    }
  });

  it("names every reducer phase and keeps the shipped reducers authoritative", () => {
    const phases = [
      ...typeMembers(fastReducer, "Phase"),
      ...typeMembers(lifecycleReducer, "LifecyclePhase"),
    ];

    for (const phase of new Set(phases)) {
      expect(architecture, `missing reducer phase ${phase}`).toContain(`\`${phase}\``);
    }
    expect(architecture).toContain("`nextPhase()`");
    expect(architecture).toContain("`nextStage()`");
  });

  it("names every current run artifact returned by the disk adapter", () => {
    const paths = pathsForRun(tempRoot, ".ai-orchestrator/runs", "20260720-1200-abcdef");

    for (const [key, path] of Object.entries(paths)) {
      if (key === "root") continue;
      expect(architecture, `missing artifact ${basename(path)}`).toContain(basename(path));
    }
  });

  it("contains the three approved program canvases and marks target-only files", () => {
    expect(architecture.match(/```mermaid/g)).toHaveLength(4);
    expect(architecture).toContain("0010 canvases");
    expect(architecture).toContain("Graph compiler and validator");
    expect(architecture).toContain("Immutable BUILD DAG vN");
    expect(architecture).toContain("The exact schemas and filenames become contracts only when their owning plans land.");
  });
});
