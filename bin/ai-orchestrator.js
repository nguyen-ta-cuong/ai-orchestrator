#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: ai-orchestrator install-cursor [--global]\n\nInstalls Cursor rule, skill, and MCP assets for the Plan → Code → Judge workflow.\n`);
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
if (noMcp) {
  process.stderr.write("install-cursor --no-mcp is not available yet; no-MCP Cursor fallback assets are planned for Milestone 4.\n");
  process.exit(1);
}

const cursorDir = globalInstall ? join(homedir(), ".cursor") : join(process.cwd(), ".cursor");
const rulesDir = join(cursorDir, "rules");
const skillsDir = join(cursorDir, "skills", "orchestrate");
mkdirSync(rulesDir, { recursive: true });
mkdirSync(dirname(skillsDir), { recursive: true });

const ruleTarget = join(rulesDir, "ai-orchestrator.mdc");
const skillTarget = join(skillsDir, "SKILL.md");
copyIfAbsentOrIdentical(join(root, "cursor", "rules", "ai-orchestrator.mdc"), ruleTarget);
mkdirSync(skillsDir, { recursive: true });
copyIfAbsentOrIdentical(join(root, "skills", "orchestrate", "SKILL.md"), skillTarget);

process.stdout.write(`Installed Cursor rule: ${ruleTarget}\n`);
process.stdout.write(`Installed Cursor skill: ${skillsDir}\n`);

const snippetPath = join(root, "cursor", "mcp.json");
const snippet = readFileSync(snippetPath, "utf8").trim();
const mcpPath = join(cursorDir, "mcp.json");
if (existsSync(mcpPath)) {
  process.stdout.write(`\nMCP config already exists at ${mcpPath}; it was not modified. Merge this snippet manually:\n\n${snippet}\n`);
} else {
  writeFileSync(mcpPath, `${snippet}\n`);
  process.stdout.write(`Wrote MCP config: ${mcpPath}\n`);
}

function copyIfAbsentOrIdentical(source, target) {
  const content = readFileSync(source, "utf8");
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing !== content) {
      process.stdout.write(`Skipped existing customized file (not overwritten): ${target}\n`);
      return;
    }
  }
  writeFileSync(target, content);
}
