#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: ai-orchestrator install-cursor [--no-mcp] [--global]\n\nInstalls Cursor rule, skill, and optionally MCP assets for the Plan → Code → Judge workflow.\n`);
  process.exit(exitCode);
}

const [, , command, ...args] = process.argv;
if (!command || command === "--help" || command === "-h") {
  usage(0);
}
if (command !== "install-cursor") {
  process.stderr.write(`Unknown command: ${command}\n`);
  usage(1);
}

const noMcp = args.includes("--no-mcp");
const globalInstall = args.includes("--global");
const unknown = args.find((arg) => arg !== "--no-mcp" && arg !== "--global");
if (unknown) {
  process.stderr.write(`Unknown option: ${unknown}\n`);
  usage(1);
}

const requestedBase = globalInstall ? homedir() : process.cwd();
if (globalInstall) mkdirSync(requestedBase, { recursive: true });
const installBase = realpathSync(requestedBase);
const cursorDir = join(installBase, ".cursor");
assertContainedWithoutSymlinks(installBase, cursorDir);
const rulesDir = join(cursorDir, "rules");
const skillsDir = join(cursorDir, "skills", "orchestrate");
assertContainedWithoutSymlinks(installBase, rulesDir);
assertContainedWithoutSymlinks(installBase, skillsDir);
mkdirSync(rulesDir, { recursive: true });
mkdirSync(dirname(skillsDir), { recursive: true });
assertContainedWithoutSymlinks(installBase, rulesDir);
assertContainedWithoutSymlinks(installBase, dirname(skillsDir));

const ruleTarget = join(rulesDir, "ai-orchestrator.mdc");
const skillTarget = join(skillsDir, "SKILL.md");
reportCopy("Cursor rule", copyIfAbsentOrIdentical(join(root, "cursor", "rules", "ai-orchestrator.mdc"), ruleTarget), ruleTarget);
assertContainedWithoutSymlinks(installBase, skillsDir);
mkdirSync(skillsDir, { recursive: true });
reportCopy("Cursor skill", copyIfAbsentOrIdentical(join(root, "skills", "orchestrate", "SKILL.md"), skillTarget), skillTarget);

if (noMcp) {
  process.stdout.write("Skipped MCP config because --no-mcp was supplied. Cursor will use the manual no-tool workflow from the installed skill.\n");
} else {
  const portableNpx = isEphemeralNpxExecution();
  const snippet = portableNpx ? portableMcpSnippet() : localMcpSnippet();
  const mcpPath = join(cursorDir, "mcp.json");
  const portabilityNote = portableNpx
    ? "Installed the version-pinned portable npx MCP command so npm cache cleanup cannot invalidate an absolute package path.\n"
    : "Note: this local-package snippet uses machine-specific absolute paths. Do not commit it unchanged for teammates; use cursor/mcp.json as the portable pinned-npx example after publishing.\n";
  if (existsSync(mcpPath)) {
    process.stdout.write(`\nMCP config already exists at ${mcpPath}; it was not modified. Merge this local-package snippet manually:\n\n${snippet}\n${portabilityNote}`);
  } else {
    assertContainedWithoutSymlinks(installBase, mcpPath);
    writeFileSync(mcpPath, `${snippet}\n`, { flag: "wx" });
    process.stdout.write(`Wrote MCP config: ${mcpPath}\n${portabilityNote}`);
  }
}

function isEphemeralNpxExecution() {
  return process.env.npm_command === "exec" || root.split(/[\\/]+/).includes("_npx");
}

function portableMcpSnippet() {
  return JSON.stringify(JSON.parse(readFileSync(join(root, "cursor", "mcp.json"), "utf8")), null, 2);
}

function localMcpSnippet() {
  return JSON.stringify(
    {
      mcpServers: {
        "ai-orchestrator": {
          command: process.execPath,
          args: [join(root, "bin", "ai-orchestrator-mcp.js")],
        },
      },
    },
    null,
    2,
  );
}

function copyIfAbsentOrIdentical(source, target) {
  assertContainedWithoutSymlinks(installBase, target);
  const content = readFileSync(source, "utf8");
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing !== content) {
      return "skipped";
    }
    return "unchanged";
  }
  writeFileSync(target, content, { flag: "wx" });
  return "wrote";
}

function assertContainedWithoutSymlinks(base, target) {
  const relativeTarget = relative(base, resolve(target));
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Installer target must stay inside ${base}: ${target}`);
  }
  let current = base;
  for (const part of relativeTarget.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Installer refuses symlinked Cursor path: ${current}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function reportCopy(label, status, target) {
  if (status === "skipped") {
    process.stdout.write(`Skipped existing customized ${label} (not overwritten): ${target}\n`);
  } else if (status === "unchanged") {
    process.stdout.write(`${label} already up to date: ${target}\n`);
  } else {
    process.stdout.write(`Installed ${label}: ${target}\n`);
  }
}
