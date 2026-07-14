import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const binPath = resolve("bin/ai-orchestrator.js");
const mcpBinPath = resolve("bin/ai-orchestrator-mcp.js");
const staticSnippetPath = resolve("cursor/mcp.json");
const packageJsonPath = resolve("package.json");
const galleryImagePath = resolve("docs/images/ai-orchestrator-workflow.png");

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-install-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  tempDirs.push(realDir);
  return realDir;
}

function installerOptions(cwd: string): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(cwd, "home"),
      USERPROFILE: join(cwd, "home"),
    },
  };
}

function runInstaller(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [binPath, "install-cursor", ...args], installerOptions(cwd));
}

function expectedLocalSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        "ai-orchestrator": {
          command: process.execPath,
          args: [mcpBinPath],
        },
      },
    },
    null,
    2,
  );
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
    expect(readFileSync(mcpPath, "utf8")).toBe(`${expectedLocalSnippet()}\n`);
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-orchestrator.mdc"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "skills", "orchestrate", "SKILL.md"))).toBe(true);
    expect(stdout).toContain(`Wrote MCP config: ${mcpPath}`);
  });

  it("writes the portable pinned command when invoked through npx", () => {
    const cwd = makeTempDir();
    const options = installerOptions(cwd);
    execFileSync(process.execPath, [binPath, "install-cursor"], {
      ...options,
      env: { ...options.env, npm_command: "exec" },
    });

    expect(JSON.parse(readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8")))
      .toEqual(JSON.parse(readFileSync(staticSnippetPath, "utf8")));
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
    expect(stdout).toContain(expectedLocalSnippet());
  });

  it("supports --no-mcp by installing only the rule and skill", () => {
    const cwd = makeTempDir();

    const stdout = runInstaller(cwd, "--no-mcp");

    expect(existsSync(join(cwd, ".cursor", "rules", "ai-orchestrator.mdc"))).toBe(true);
    const installedRule = readFileSync(join(cwd, ".cursor", "rules", "ai-orchestrator.mdc"), "utf8");
    const installedSkill = readFileSync(join(cwd, ".cursor", "skills", "orchestrate", "SKILL.md"), "utf8");
    expect(installedRule).toContain("independent checker");
    expect(installedRule).toContain("fail closed");
    expect(installedSkill).toContain("Without orchestrator tools");
    expect(installedSkill).toContain("maker cannot approve itself");
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(false);
    expect(stdout).toContain("Skipped MCP config because --no-mcp was supplied");
  });

  it("installs into the HOME Cursor directory with --global", () => {
    const cwd = makeTempDir();

    const stdout = runInstaller(cwd, "--global", "--no-mcp");

    const homeCursor = join(cwd, "home", ".cursor");
    expect(existsSync(join(homeCursor, "rules", "ai-orchestrator.mdc"))).toBe(true);
    expect(existsSync(join(homeCursor, "skills", "orchestrate", "SKILL.md"))).toBe(true);
    expect(stdout).toContain(`Installed Cursor rule: ${join(homeCursor, "rules", "ai-orchestrator.mdc")}`);
  });

  it("refuses a symlinked project Cursor directory", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(outside, join(cwd, ".cursor"), "dir");

    const result = spawnSync(process.execPath, [binPath, "install-cursor", "--no-mcp"], installerOptions(cwd));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refuses symlinked Cursor path/);
    expect(existsSync(join(outside, "rules"))).toBe(false);
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });

  it("does not overwrite customized existing rule and skill files", () => {
    const cwd = makeTempDir();
    const rulePath = join(cwd, ".cursor", "rules", "ai-orchestrator.mdc");
    const skillPath = join(cwd, ".cursor", "skills", "orchestrate", "SKILL.md");
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(cwd, ".cursor", "skills", "orchestrate"), { recursive: true });
    writeFileSync(rulePath, "custom rule\n");
    writeFileSync(skillPath, "custom skill\n");

    const stdout = runInstaller(cwd, "--no-mcp");

    expect(readFileSync(rulePath, "utf8")).toBe("custom rule\n");
    expect(readFileSync(skillPath, "utf8")).toBe("custom skill\n");
    expect(stdout).toContain("Skipped existing customized Cursor rule");
    expect(stdout).toContain("Skipped existing customized Cursor skill");
  });

  it("packages MCP source while excluding local plans and tests", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { files: string[] };
    expect(packageJson.files).toContain("mcp");
    expect(packageJson.files).toContain("CONTRIBUTING.md");
    expect(packageJson.files).toContain("SECURITY.md");
    expect(packageJson.files).toContain("docs/images/ai-orchestrator-workflow.png");
    expect(packageJson.files).not.toContain("plans");
    expect(packageJson.files).not.toContain("test");
  });

  it("declares deterministic Pi resources and gallery discovery metadata", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name: string;
      keywords: string[];
      pi?: { extensions?: string[]; skills?: string[]; image?: string };
      publishConfig?: { access?: string };
    };

    expect(packageJson.name).toBe("@miracle3010/ai-orchestrator");
    expect(packageJson.publishConfig).toEqual({ access: "public" });
    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.pi).toEqual({
      extensions: ["./extensions"],
      skills: ["./skills"],
      image: "https://cdn.jsdelivr.net/npm/@miracle3010/ai-orchestrator/docs/images/ai-orchestrator-workflow.png",
    });
  });

  it("declares the approved npm author", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { author?: string };

    expect(packageJson.author).toBe("Cuong Nguyen");
  });

  it("ships a valid 1600 by 1135 PNG for the Pi package gallery", () => {
    const image = readFileSync(galleryImagePath);

    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image.readUInt32BE(16)).toBe(1600);
    expect(image.readUInt32BE(20)).toBe(1135);
  });

  it("keeps the static npx snippet pinned to the package version", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    const snippet = readFileSync(staticSnippetPath, "utf8");

    expect(snippet).toContain(`@miracle3010/ai-orchestrator@${packageJson.version}`);
  });
});
