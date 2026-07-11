import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleConfig {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface ProviderConfig {
  baseUrl: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions" | string;
  apiKey?: string;
}

export type RoleName = "planner" | "coder" | "judge" | "spec" | "verifier" | "reviewer" | "debugger" | "shipper";
export type LifecycleRoutedStage = "define" | "plan" | "verify" | "review" | "debug" | "ship";
export type ModelCandidate = RoleConfig;
export type ShipCommitMode = "ask" | "never" | "auto";
export type ShipOpenPrMode = "ask" | "never";

export interface LifecycleRoutingConfig {
  enabled: boolean;
  stages: Record<LifecycleRoutedStage, ModelCandidate[]>;
}

export interface OrchestratorConfig {
  roles: Record<RoleName, RoleConfig>;
  loop: {
    maxCoderIterations: number;
    plannerEscalationAfterRejections: number;
  };
  approval: {
    requirePlanApproval: boolean;
  };
  judge: {
    runTests: boolean;
  };
  lifecycle: {
    artifactsDir: string;
  };
  build: {
    commitPerTask: boolean;
  };
  routing: {
    lifecycle: LifecycleRoutingConfig;
  };
  ship: {
    commit: ShipCommitMode;
    openPr: ShipOpenPrMode;
  };
  mcp: {
    providers: Record<string, ProviderConfig>;
  };
}

type ConfigPatch = Partial<{
  roles: Partial<Record<keyof OrchestratorConfig["roles"], Partial<RoleConfig>>>;
  loop: Partial<OrchestratorConfig["loop"]>;
  approval: Partial<OrchestratorConfig["approval"]>;
  judge: Partial<OrchestratorConfig["judge"]>;
  lifecycle: Partial<OrchestratorConfig["lifecycle"]>;
  build: Partial<OrchestratorConfig["build"]>;
  routing: Partial<{ lifecycle: Partial<{ enabled: boolean; stages: Partial<Record<LifecycleRoutedStage, ModelCandidate[]>> }> }>;
  ship: Partial<OrchestratorConfig["ship"]>;
  mcp: Partial<{ providers: Record<string, Partial<ProviderConfig>> }>;
}>;

export const UNCONFIGURED_FABLE_BASE_URL = "https://example.invalid/fable/v1";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FABLE: ModelCandidate = { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" };
const GPT_56_SOL: ModelCandidate = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" };
const GPT_56_TERRA: ModelCandidate = { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "xhigh" };
const GPT_56_LUNA: ModelCandidate = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "xhigh" };

function candidates(...values: ModelCandidate[]): ModelCandidate[] {
  return values.map((value) => ({ ...value }));
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  roles: {
    planner: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    coder: { provider: "openai-codex", model: "gpt-5.5", thinking: "xhigh" },
    judge: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    spec: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    verifier: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    reviewer: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    debugger: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
    shipper: { provider: "anthropic", model: "claude-fable-5", thinking: "xhigh" },
  },
  loop: {
    maxCoderIterations: 3,
    plannerEscalationAfterRejections: 2,
  },
  approval: {
    requirePlanApproval: true,
  },
  judge: {
    runTests: true,
  },
  lifecycle: {
    artifactsDir: ".ai-orchestrator/runs",
  },
  build: {
    commitPerTask: false,
  },
  routing: {
    lifecycle: {
      enabled: true,
      stages: {
        define: candidates(FABLE, GPT_56_SOL, GPT_56_TERRA, GPT_56_LUNA),
        plan: candidates(FABLE, GPT_56_SOL, GPT_56_TERRA, GPT_56_LUNA),
        verify: candidates(GPT_56_SOL, FABLE, GPT_56_TERRA, GPT_56_LUNA),
        review: candidates(GPT_56_SOL, FABLE, GPT_56_TERRA, GPT_56_LUNA),
        debug: candidates(GPT_56_SOL, FABLE, GPT_56_TERRA, GPT_56_LUNA),
        ship: candidates(FABLE, GPT_56_SOL, GPT_56_TERRA, GPT_56_LUNA),
      },
    },
  },
  ship: {
    commit: "ask",
    openPr: "ask",
  },
  mcp: {
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com/v1",
        api: "anthropic-messages",
        apiKey: "$ANTHROPIC_API_KEY",
      },
      fable: {
        // Intentionally invalid until the user supplies a dedicated Fable endpoint in config.
        baseUrl: UNCONFIGURED_FABLE_BASE_URL,
        api: "anthropic-messages",
        apiKey: "$FABLE_API_KEY",
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        apiKey: "$OPENAI_API_KEY",
      },
    },
  },
};

export interface LoadConfigOptions {
  /**
   * Pi resolves models and credentials through its own registry and ignores mcp.providers.
   * Use this when loading config for the pi extension so partial MCP config intended for
   * the future MCP surface cannot block /orchestrate.
   */
  ignoreMcpProviders?: boolean;
  /**
   * Project config is repository-controlled input. Use this on the MCP surface so a
   * cloned repository cannot redirect provider endpoints and exfiltrate user env vars.
   */
  ignoreProjectMcpProviders?: boolean;
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): OrchestratorConfig {
  const userPath = join(homedir(), ".ai-orchestrator", "config.json");
  const projectPath = join(cwd, ".ai-orchestrator.json");

  const userConfig = readJsonIfPresent(userPath);
  const projectConfig = readJsonIfPresent(projectPath);
  const merged = deepMerge(
    deepMerge(cloneConfig(DEFAULT_CONFIG), sanitizeConfigPatch(userConfig, options.ignoreMcpProviders)),
    sanitizeConfigPatch(projectConfig, options.ignoreMcpProviders || options.ignoreProjectMcpProviders),
  );

  return interpolateMcpApiKeys(validateConfig(merged));
}

export function loopConfigFrom(config: OrchestratorConfig): {
  maxCoderIterations: number;
  plannerEscalationAfterRejections: number;
  requirePlanApproval: boolean;
} {
  return {
    maxCoderIterations: config.loop.maxCoderIterations,
    plannerEscalationAfterRejections: config.loop.plannerEscalationAfterRejections,
    requirePlanApproval: config.approval.requirePlanApproval,
  };
}

function readJsonIfPresent(path: string): ConfigPatch {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) {
      throw new Error("config root must be a JSON object");
    }
    return parsed as ConfigPatch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read orchestrator config at ${path}: ${message}`);
  }
}

function interpolateMcpApiKeys(config: OrchestratorConfig): OrchestratorConfig {
  const next = cloneConfig(config);
  for (const provider of Object.values(next.mcp.providers)) {
    if (typeof provider.apiKey === "string") {
      const interpolated = interpolateEnvVar(provider.apiKey);
      if (interpolated === undefined) {
        delete provider.apiKey;
      } else {
        provider.apiKey = interpolated;
      }
    }
  }
  return next;
}

function interpolateEnvVar(value: string): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (match) {
    return process.env[match[1]];
  }
  if (value.startsWith("$") || value.includes("${")) {
    throw new Error(`Invalid mcp provider apiKey environment reference ${JSON.stringify(value)}; use exact "$ENV_VAR" syntax or a literal key without a leading "$"`);
  }
  return value;
}

function validateConfig(value: unknown): OrchestratorConfig {
  const config = requirePlainObject(value, "config");
  const roles = requirePlainObject(config.roles, "roles");
  const loop = requirePlainObject(config.loop, "loop");
  const approval = requirePlainObject(config.approval, "approval");
  const judge = requirePlainObject(config.judge, "judge");
  const lifecycle = requirePlainObject(config.lifecycle, "lifecycle");
  const build = requirePlainObject(config.build, "build");
  const routing = requirePlainObject(config.routing, "routing");
  const lifecycleRouting = requirePlainObject(routing.lifecycle, "routing.lifecycle");
  const routingStages = requirePlainObject(lifecycleRouting.stages, "routing.lifecycle.stages");
  const ship = requirePlainObject(config.ship, "ship");
  const mcp = requirePlainObject(config.mcp, "mcp");
  const providers = requirePlainObject(mcp.providers, "mcp.providers");

  for (const roleName of ["planner", "coder", "judge", "spec", "verifier", "reviewer", "debugger", "shipper"] as const) {
    validateRoleConfig(roles[roleName], `roles.${roleName}`);
  }

  requireBoolean(lifecycleRouting.enabled, "routing.lifecycle.enabled");
  for (const stage of ["define", "plan", "verify", "review", "debug", "ship"] as const) {
    const stageCandidates = routingStages[stage];
    if (!Array.isArray(stageCandidates) || stageCandidates.length === 0) {
      throw new Error(`routing.lifecycle.stages.${stage} must be a non-empty array`);
    }
    stageCandidates.forEach((candidate, index) => validateRoleConfig(candidate, `routing.lifecycle.stages.${stage}[${index}]`));
  }

  requirePositiveInteger(loop.maxCoderIterations, "loop.maxCoderIterations");
  requirePositiveInteger(loop.plannerEscalationAfterRejections, "loop.plannerEscalationAfterRejections");
  requireBoolean(approval.requirePlanApproval, "approval.requirePlanApproval");
  requireBoolean(judge.runTests, "judge.runTests");
  requireSafeRelativePath(lifecycle.artifactsDir, "lifecycle.artifactsDir");
  requireBoolean(build.commitPerTask, "build.commitPerTask");
  requireStringEnum(ship.commit, "ship.commit", ["ask", "never", "auto"] as const);
  requireStringEnum(ship.openPr, "ship.openPr", ["ask", "never"] as const);

  for (const [providerName, providerValue] of Object.entries(providers)) {
    const provider = requirePlainObject(providerValue, `mcp.providers.${providerName}`);
    requireHttpsUrl(provider.baseUrl, `mcp.providers.${providerName}.baseUrl`);
    requireNonEmptyString(provider.api, `mcp.providers.${providerName}.api`);
    if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
      throw new Error(`mcp.providers.${providerName}.apiKey must be a string when provided`);
    }
  }

  return config as unknown as OrchestratorConfig;
}

function requirePlainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function validateRoleConfig(value: unknown, path: string): void {
  const role = requirePlainObject(value, path);
  requireNonEmptyString(role.provider, `${path}.provider`);
  requireNonEmptyString(role.model, `${path}.model`);
  if (!THINKING_LEVELS.includes(role.thinking as ThinkingLevel)) {
    throw new Error(`${path}.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function requireHttpsUrl(value: unknown, path: string): void {
  requireNonEmptyString(value, path);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new Error(`${path} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${path} must use https:`);
  }
}

function requirePositiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function requireBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
}

function requireStringEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): void {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  }
}

function requireSafeRelativePath(value: unknown, path: string): void {
  requireNonEmptyString(value, path);
  const text = value as string;
  if (isAbsolute(text) || text.startsWith("/") || text.startsWith("\\") || /^[A-Za-z]:/.test(text)) {
    throw new Error(`${path} must be a relative path inside the project`);
  }

  const parts = text.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`${path} must be a relative path inside the project`);
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  if (stack.length < 2) {
    throw new Error(`${path} must contain a dedicated parent directory and child directory inside the project`);
  }
}

function sanitizeConfigPatch(patch: ConfigPatch, ignoreMcpProviders?: boolean): ConfigPatch {
  if (!ignoreMcpProviders || patch.mcp === undefined) {
    return patch;
  }
  const { mcp: _ignoredMcp, ...rest } = patch;
  return rest;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeConfigKey(key)) {
      continue;
    }
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

function isUnsafeConfigKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
