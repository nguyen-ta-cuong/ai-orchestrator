import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTestCommand } from "../src/core/tests.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-tests-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectTestCommand", () => {
  it("detects npm test when package.json has a real test script", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

    expect(detectTestCommand(dir)).toBe("npm test");
  });

  it("ignores npm init's placeholder test script", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }),
    );

    expect(detectTestCommand(dir)).toBeUndefined();
  });

  it("detects common non-npm project test commands", () => {
    const python = makeTempDir();
    writeFileSync(join(python, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const rust = makeTempDir();
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = \"demo\"\n");
    const go = makeTempDir();
    writeFileSync(join(go, "go.mod"), "module demo\n");

    expect(detectTestCommand(python)).toBe("pytest");
    expect(detectTestCommand(rust)).toBe("cargo test");
    expect(detectTestCommand(go)).toBe("go test ./...");
  });
});
