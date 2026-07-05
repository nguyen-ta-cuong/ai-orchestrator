#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "mcp", "server.js");

if (!existsSync(serverPath)) {
  console.error(`ai-orchestrator MCP build output is missing at ${serverPath}. Run \`npm run build\` before launching the MCP server from a source checkout.`);
  process.exit(1);
}

const { main } = await import(pathToFileURL(serverPath).href);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
