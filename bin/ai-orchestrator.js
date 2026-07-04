#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: ai-orchestrator install-cursor [--no-mcp] [--global]\n\nInstalls Cursor rule and skill assets for the Plan → Code → Judge workflow.\n`);
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

if (noMcp) {
  process.stdout.write("Skipped MCP configuration because --no-mcp was supplied.\n");
  process.exit(0);
}

const snippetPath = join(root, "cursor", "mcp.json");
const snippet = readFileSync(snippetPath, "utf8").trim();
const mcpPath = join(cursorDir, "mcp.json");
if (existsSync(mcpPath)) {
  process.stdout.write(`\nMCP config already exists at ${mcpPath}; it was not modified. Merge this snippet manually:\n\n${snippet}\n`);
} else {
  process.stdout.write(`\nCreate ${mcpPath} with this MCP snippet, or merge it into an existing Cursor MCP config:\n\n${snippet}\n`);
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
