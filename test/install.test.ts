import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const binPath = resolve("bin/ai-orchestrator.js");
const snippetPath = resolve("cursor/mcp.json");

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-install-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  tempDirs.push(realDir);
  return realDir;
}

function runInstaller(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [binPath, "install-cursor", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(cwd, "home"),
      USERPROFILE: join(cwd, "home"),
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ai-orchestrator install-cursor", () => {
  it("writes Cursor rule, skill, and MCP config on a fresh default install", () => {
    const cwd = makeTempDir();

    const stdout = runInstaller(cwd);

    const mcpPath = join(cwd, ".cursor", "mcp.json");
    expect(readFileSync(mcpPath, "utf8")).toBe(`${readFileSync(snippetPath, "utf8").trim()}\n`);
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-orchestrator.mdc"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "skills", "orchestrate", "SKILL.md"))).toBe(true);
    expect(stdout).toContain(`Wrote MCP config: ${mcpPath}`);
  });

  it("does not overwrite an existing customized MCP config", () => {
    const cwd = makeTempDir();
    const mcpPath = join(cwd, ".cursor", "mcp.json");
    const existing = '{"mcpServers":{"custom":{"command":"custom"}}}\n';
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(mcpPath, existing);

    const stdout = runInstaller(cwd);

    expect(readFileSync(mcpPath, "utf8")).toBe(existing);
    expect(stdout).toContain(`MCP config already exists at ${mcpPath}; it was not modified.`);
    expect(stdout).toContain(readFileSync(snippetPath, "utf8").trim());
  });

  it("does not create MCP config when --no-mcp is supplied", () => {
    const cwd = makeTempDir();

    const stdout = runInstaller(cwd, "--no-mcp");

    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-orchestrator.mdc"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "skills", "orchestrate", "SKILL.md"))).toBe(true);
    expect(stdout).toContain("Skipped MCP configuration because --no-mcp was supplied.");
  });
});
