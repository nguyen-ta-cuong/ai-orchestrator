#!/usr/bin/env node
import { main } from "../dist/mcp/server.js";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
