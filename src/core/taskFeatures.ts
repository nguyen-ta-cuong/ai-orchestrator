import type { TaskFeatures, TaskRisk } from "./modelRouting.js";

export interface TaskFeatureEvidence {
  task?: unknown;
  spec?: unknown;
  plan?: unknown;
  changedPaths?: unknown;
  languages?: unknown;
  testCommand?: unknown;
  verdictCategory?: unknown;
}

const WORK_KIND_SIGNALS: readonly [TaskFeatures["workKind"], RegExp][] = [
  ["bug-fix", /\b(?:bug|fix|broken|failure|regression|crash|incorrect)\b/i],
  ["migration", /\b(?:migrat(?:e|ion)|upgrade|port)\b/i],
  ["refactor", /\b(?:refactor|restructure|cleanup|clean up)\b/i],
  ["test-only", /\b(?:test-only|tests? only|add tests?|coverage)\b/i],
  ["documentation", /\b(?:docs?|documentation|readme|guide)\b/i],
  ["configuration", /\b(?:config(?:uration)?|settings?|yaml|toml)\b/i],
  ["release", /\b(?:release|publish|ship|changelog)\b/i],
  ["feature", /\b(?:feature|add|implement|build|support|adopt)\b/i],
];

const RISK_SIGNALS: readonly [string, RegExp][] = [
  ["auth-security", /\b(?:auth(?:entication|orization)?|credential|secret|security|permission|token)\b/i],
  ["persistence", /\b(?:database|schema|persist(?:ence|ed)?|storage|transaction)\b/i],
  ["concurrency", /\b(?:concurren(?:cy|t)|race|lock|atomic|thread|actor)\b/i],
  ["publication", /\b(?:publish|release|deploy|push|pull request|\bpr\b)\b/i],
];

const FAILURE_SIGNALS: readonly [string, RegExp][] = [
  ["test-failure", /(?:\b(?:test|tests|ci)\b[^\n]{0,32}\b(?:fail|failed|failure|red)\b|\b(?:fail|failed|failure|red)\b[^\n]{0,32}\b(?:test|tests|ci)\b)/i],
  ["crash", /\b(?:crash|panic|fatal|exception)\b/i],
  ["regression", /\bregression\b/i],
  ["checker-rejection", /\b(?:reject|rejected|verdict)\b/i],
];

export function extractTaskFeatures(input: unknown): TaskFeatures {
  const evidence = normalizeEvidence(input);
  const text = [evidence.task, evidence.spec, evidence.plan, evidence.verdictCategory]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const changedPaths = stringArray(evidence.changedPaths);
  const languages = [...new Set(stringArray(evidence.languages).map((value) => value.toLowerCase()))].sort();
  const riskSignals = signals(text, RISK_SIGNALS);
  const failureSignals = signals(text, FAILURE_SIGNALS);
  const risk: TaskRisk = riskSignals.includes("auth-security") || riskSignals.includes("publication")
    ? "high"
    : riskSignals.length > 0 || failureSignals.length > 0 ? "medium" : "low";
  const textLength = text.length;

  return {
    contextTokens: clamp(Math.ceil(textLength / 4), 1_000, 120_000),
    expectedOutputTokens: clamp(2_000 + changedPaths.length * 250, 2_000, 16_000),
    requiredInput: ["text"],
    risk,
    workKind: WORK_KIND_SIGNALS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown",
    fileCount: changedPaths.length,
    languages,
    riskSignals,
    failureSignals,
  };
}

function normalizeEvidence(input: unknown): TaskFeatureEvidence {
  if (typeof input === "string") return { task: input };
  return isRecord(input) ? input as TaskFeatureEvidence : {};
}

function signals(text: string, definitions: readonly [string, RegExp][]): string[] {
  return definitions.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
