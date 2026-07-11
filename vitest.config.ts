import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const piRuntimeStub = fileURLToPath(new URL("./test/fixtures/pi-runtime-stubs.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-ai": piRuntimeStub,
      typebox: piRuntimeStub,
    },
  },
});
