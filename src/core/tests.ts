import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function detectTestCommand(cwd: string): string | undefined {
  if (hasRealNpmTest(cwd)) {
    return "npm test";
  }
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) {
    return "pytest";
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return "cargo test";
  }
  if (existsSync(join(cwd, "go.mod"))) {
    return "go test ./...";
  }
  return undefined;
}

function hasRealNpmTest(cwd: string): boolean {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const testScript = packageJson.scripts?.test;
    return typeof testScript === "string" && isRealTestScript(testScript);
  } catch {
    return false;
  }
}

function isRealTestScript(script: string): boolean {
  const normalized = script.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== "echo \"error: no test specified\" && exit 1" &&
    normalized !== "echo 'error: no test specified' && exit 1" &&
    normalized !== "echo error: no test specified && exit 1"
  );
}
