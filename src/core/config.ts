import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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

export interface OrchestratorConfig {
  roles: {
    planner: RoleConfig;
    coder: RoleConfig;
    judge: RoleConfig;
  };
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
  mcp: {
    providers: Record<string, ProviderConfig>;
  };
}

type ConfigPatch = Partial<{
  roles: Partial<Record<keyof OrchestratorConfig["roles"], Partial<RoleConfig>>>;
  loop: Partial<OrchestratorConfig["loop"]>;
  approval: Partial<OrchestratorConfig["approval"]>;
  judge: Partial<OrchestratorConfig["judge"]>;
  mcp: Partial<{ providers: Record<string, Partial<ProviderConfig>> }>;
}>;

export const DEFAULT_CONFIG: OrchestratorConfig = {
  roles: {
    planner: { provider: "fable", model: "fable", thinking: "xhigh" },
    coder: { provider: "openai", model: "gpt-5.5", thinking: "xhigh" },
    judge: { provider: "fable", model: "fable", thinking: "xhigh" },
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
  mcp: {
    providers: {
      fable: {
        baseUrl: "https://api.fable.co/v1",
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

export function loadConfig(cwd: string): OrchestratorConfig {
  const userPath = join(homedir(), ".ai-orchestrator", "config.json");
  const projectPath = join(cwd, ".ai-orchestrator.json");

  const merged = deepMerge(
    deepMerge(cloneConfig(DEFAULT_CONFIG), readJsonIfPresent(userPath)),
    readJsonIfPresent(projectPath),
  ) as OrchestratorConfig;

  return interpolateMcpApiKeys(merged);
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
    return JSON.parse(readFileSync(path, "utf8")) as ConfigPatch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read orchestrator config at ${path}: ${message}`);
  }
}

function interpolateMcpApiKeys(config: OrchestratorConfig): OrchestratorConfig {
  const next = cloneConfig(config);
  for (const provider of Object.values(next.mcp.providers)) {
    if (typeof provider.apiKey === "string") {
      provider.apiKey = interpolateEnvVar(provider.apiKey);
    }
  }
  return next;
}

function interpolateEnvVar(value: string): string {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!match) {
    return value;
  }
  return process.env[match[1]] ?? "";
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
