import { describe, expect, it } from "vitest";
import { isReadOnlyLifecycleCommand } from "../src/lifecycle/readOnlyPolicy.js";

describe("isReadOnlyLifecycleCommand", () => {
  it("allows repository inspection and the exact detected test command", () => {
    expect(isReadOnlyLifecycleCommand("git diff --staged")).toBe(true);
    expect(isReadOnlyLifecycleCommand("rg -n TODO src")).toBe(true);
    expect(isReadOnlyLifecycleCommand("npm test", "npm test")).toBe(true);
  });

  it("blocks mutation, chaining, redirection, substitution, and altered test commands", () => {
    for (const command of [
      "git commit -am bad",
      "rm -rf src",
      "git diff && git reset --hard",
      "git status\nrm -rf src",
      "git status\r\nrm -rf src",
      "git status\0rm -rf src",
      "cat file > output",
      "echo $(touch owned)",
      "npm test -- --update",
      "find . -delete",
      "find . -exec rm -f {} +",
      "git diff --output=report.txt",
      "rg --pre 'touch owned' pattern",
    ]) {
      expect(isReadOnlyLifecycleCommand(command, "npm test"), command).toBe(false);
    }
  });
});
