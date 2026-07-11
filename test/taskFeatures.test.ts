import { describe, expect, it } from "vitest";
import { extractTaskFeatures } from "../src/core/taskFeatures.js";

describe("extractTaskFeatures", () => {
  it.each([
    ["implement a feature", "feature"],
    ["fix a broken parser regression", "bug-fix"],
    ["migrate the schema", "migration"],
    ["refactor the router", "refactor"],
    ["tests only for routing", "test-only"],
    ["update README documentation", "documentation"],
    ["change yaml configuration", "configuration"],
    ["prepare release notes", "release"],
    ["consider the situation", "unknown"],
  ] as const)("classifies %s", (task, workKind) => {
    expect(extractTaskFeatures(task).workKind).toBe(workKind);
  });

  it("extracts security, persistence, concurrency, and failure signals deterministically", () => {
    const input = {
      task: "Fix auth token persistence race after failed tests",
      changedPaths: ["src/auth.ts", "test/auth.test.ts"],
      languages: ["TypeScript", "typescript"],
    };
    const first = extractTaskFeatures(input);
    expect(first).toEqual(extractTaskFeatures(structuredClone(input)));
    expect(first.risk).toBe("high");
    expect(first.riskSignals).toEqual(["auth-security", "persistence", "concurrency"]);
    expect(first.failureSignals).toContain("test-failure");
    expect(first.fileCount).toBe(2);
    expect(first.languages).toEqual(["typescript"]);
  });

  it.each([undefined, null, 42, [], {}, { task: { untrusted: true } }])("fails closed for unclassified input %#", (input) => {
    expect(extractTaskFeatures(input)).toMatchObject({ workKind: "unknown", risk: "low", requiredInput: ["text"] });
  });
});
