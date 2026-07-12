import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_ROUTING_POLICY,
  type ModelCapabilityProfile,
  type RoutingPolicy,
  type RoutingStage,
  type StageRoutingPolicy,
} from "./modelRouting.js";
import {
  DEFAULT_ROUTING_BUDGETS,
  DEFAULT_ROUTING_CIRCUIT_BREAKERS,
  type RoutingBudgets,
  type RoutingCircuitBreakers,
} from "./routingBudget.js";

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

export interface CapabilityRoutingConfig extends RoutingPolicy {
  engine: "legacy" | "capability-shadow" | "capability";
  profiles: Record<string, ModelCapabilityProfile>;
  evidence: RoutingEvidenceConfig;
  budgets: RoutingBudgets;
  circuitBreakers: RoutingCircuitBreakers;
}

export interface RoutingEvidenceConfig {
  enabled: boolean;
  userStoreDir: string;
  shadowComparisons: boolean;
  minRecommendationSamples: number;
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
  } & CapabilityRoutingConfig;
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
  routing: Partial<CapabilityRoutingConfig> & {
    lifecycle?: Partial<{ enabled: boolean; stages: Partial<Record<LifecycleRoutedStage, ModelCandidate[]>> }>;
    deny?: Partial<RoutingPolicy["deny"]>;
    separation?: Partial<RoutingPolicy["separation"]>;
    limits?: Partial<RoutingPolicy["limits"]>;
    evidence?: Partial<RoutingEvidenceConfig>;
    budgets?: Partial<RoutingBudgets>;
    circuitBreakers?: Partial<RoutingCircuitBreakers>;
    stages?: Partial<Record<RoutingStage, Partial<StageRoutingPolicy>>>;
  };
  ship: Partial<OrchestratorConfig["ship"]>;
  mcp: Partial<{ providers: Record<string, Partial<ProviderConfig>> }>;
}>;

export const UNCONFIGURED_FABLE_BASE_URL = "https://example.invalid/fable/v1";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROUTING_STAGES: readonly RoutingStage[] = ["define", "plan", "build", "verify", "debug", "review", "ship", "fast-judge"];
const CAPABILITY_NAMES = [
  "requirements", "architecture", "coding", "debugging", "verification", "review", "release",
  "structuredOutput", "longContext", "speed", "economy",
] as const;
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
    ...cloneConfig(DEFAULT_ROUTING_POLICY),
    engine: "capability-shadow",
    profiles: {},
    evidence: {
      enabled: true,
      userStoreDir: "routing-evidence",
      shadowComparisons: true,
      minRecommendationSamples: 10,
    },
    budgets: cloneConfig(DEFAULT_ROUTING_BUDGETS),
    circuitBreakers: cloneConfig(DEFAULT_ROUTING_CIRCUIT_BREAKERS),
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

export type ConfigSource = "builtin" | "user" | "project";

export interface ConfigProvenance {
  roles: Record<RoleName, ConfigSource>;
}

export interface ResolvedOrchestratorConfig {
  config: OrchestratorConfig;
  provenance: ConfigProvenance;
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): OrchestratorConfig {
  return loadConfigWithProvenance(cwd, options).config;
}

export function loadConfigWithProvenance(cwd: string, options: LoadConfigOptions = {}): ResolvedOrchestratorConfig {
  const userPath = join(homedir(), ".ai-orchestrator", "config.json");
  const projectPath = join(cwd, ".ai-orchestrator.json");

  const userConfig = readJsonIfPresent(userPath);
  const projectConfig = readJsonIfPresent(projectPath);
  const userMerged = deepMerge(cloneConfig(DEFAULT_CONFIG), sanitizeConfigPatch(userConfig, options.ignoreMcpProviders));
  validateConfig(cloneConfig(userMerged));
  const projectPatch = sanitizeConfigPatch(projectConfig, options.ignoreMcpProviders || options.ignoreProjectMcpProviders);
  const merged = deepMerge(userMerged, constrainProjectRoutingPatch(projectPatch, userMerged.routing));

  return {
    config: interpolateMcpApiKeys(validateConfig(merged)),
    provenance: { roles: roleProvenance(userConfig, projectConfig) },
  };
}

function roleProvenance(user: ConfigPatch, project: ConfigPatch): Record<RoleName, ConfigSource> {
  const roles = {} as Record<RoleName, ConfigSource>;
  for (const role of ["planner", "coder", "judge", "spec", "verifier", "reviewer", "debugger", "shipper"] as const) {
    roles[role] = hasRoleIdentityOverride(project.roles?.[role])
      ? "project"
      : hasRoleIdentityOverride(user.roles?.[role]) ? "user" : "builtin";
  }
  return roles;
}

function hasRoleIdentityOverride(value: Partial<RoleConfig> | undefined): boolean {
  return value !== undefined && (Object.hasOwn(value, "provider") || Object.hasOwn(value, "model"));
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
  validateCapabilityRouting(routing);

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

function validateCapabilityRouting(routing: Record<string, unknown>): void {
  requireStringEnum(routing.engine, "routing.engine", ["legacy", "capability-shadow", "capability"] as const);
  requireStringEnum(routing.mode, "routing.mode", ["quality", "balanced", "economy", "pinned", "custom"] as const);
  requireNonEmptyString(routing.version, "routing.version");
  requireBoolean(routing.allowInferredProfiles, "routing.allowInferredProfiles");
  requireStringEnum(routing.unknownCost, "routing.unknownCost", ["exclude", "penalize", "allow"] as const);
  requireNonNegativeInteger(routing.unknownCostPenaltyBasisPoints, "routing.unknownCostPenaltyBasisPoints");
  requireNonNegativeInteger(routing.confidenceBonusBasisPoints, "routing.confidenceBonusBasisPoints");
  requireNonNegativeNumber(routing.costPenaltyBasisPointsPerUsd, "routing.costPenaltyBasisPointsPerUsd");

  const deny = requirePlainObject(routing.deny, "routing.deny");
  requireStringArray(deny.providers, "routing.deny.providers");
  requireStringArray(deny.models, "routing.deny.models");
  requireStringArray(deny.families, "routing.deny.families");

  const separation = requirePlainObject(routing.separation, "routing.separation");
  requireBoolean(separation.checkerMustDifferFromBuilder, "routing.separation.checkerMustDifferFromBuilder");
  requireBoolean(separation.preferDifferentProviderFamily, "routing.separation.preferDifferentProviderFamily");
  requireEnumArray(separation.requireDifferentProviderFamilyFor, "routing.separation.requireDifferentProviderFamilyFor", ROUTING_STAGES);

  const limits = requirePlainObject(routing.limits, "routing.limits");
  requireNonNegativeNumber(limits.maxEstimatedUsdPerRun, "routing.limits.maxEstimatedUsdPerRun");
  requirePositiveInteger(limits.maxAttemptsPerStage, "routing.limits.maxAttemptsPerStage");

  const evidence = requirePlainObject(routing.evidence, "routing.evidence");
  requireBoolean(evidence.enabled, "routing.evidence.enabled");
  requireUserStoreRelativePath(evidence.userStoreDir, "routing.evidence.userStoreDir");
  requireBoolean(evidence.shadowComparisons, "routing.evidence.shadowComparisons");
  requirePositiveInteger(evidence.minRecommendationSamples, "routing.evidence.minRecommendationSamples");

  const budgets = requirePlainObject(routing.budgets, "routing.budgets");
  for (const key of [
    "maxEstimatedUsdPerStage",
    "maxEstimatedUsdPerRun",
    "maxObservedUsdPerRun",
    "maxEstimatedUsdPerDay",
    "maxObservedUsdPerDay",
  ] as const) {
    requireNonNegativeNumber(budgets[key], `routing.budgets.${key}`);
  }
  requireNonNegativeInteger(budgets.maxPaidFallbacksPerRun, "routing.budgets.maxPaidFallbacksPerRun");
  requireBoolean(budgets.allowUnknownCost, "routing.budgets.allowUnknownCost");

  const circuitBreakers = requirePlainObject(routing.circuitBreakers, "routing.circuitBreakers");
  requirePositiveInteger(circuitBreakers.maxSelectionFailures, "routing.circuitBreakers.maxSelectionFailures");
  requirePositiveInteger(circuitBreakers.repeatedRejectionFingerprintLimit, "routing.circuitBreakers.repeatedRejectionFingerprintLimit");
  requirePositiveInteger(circuitBreakers.maxBuildPassesWithoutImprovement, "routing.circuitBreakers.maxBuildPassesWithoutImprovement");
  requireBoolean(circuitBreakers.requireIndependentChecker, "routing.circuitBreakers.requireIndependentChecker");

  const stages = requirePlainObject(routing.stages, "routing.stages");
  for (const stageName of ROUTING_STAGES) validateCapabilityStage(stages[stageName], `routing.stages.${stageName}`);

  const profiles = requirePlainObject(routing.profiles, "routing.profiles");
  for (const [identity, value] of Object.entries(profiles)) {
    if (!identity.includes("/") || identity.startsWith("/") || identity.endsWith("/") || identity.trim() !== identity) {
      throw new Error("routing.profiles keys must be non-empty provider/model identities");
    }
    const profile = requirePlainObject(value, `routing.profiles.${identity}`);
    if (profile.family !== undefined) requireNonEmptyString(profile.family, `routing.profiles.${identity}.family`);
    requireBasisPoints(profile.confidence, `routing.profiles.${identity}.confidence`);
    if (profile.provenance !== undefined) {
      requireStringEnum(profile.provenance, `routing.profiles.${identity}.provenance`, ["user", "project", "builtin", "observed", "inferred"] as const);
    }
    if (profile.version !== undefined) requireNonEmptyString(profile.version, `routing.profiles.${identity}.version`);
    validateCapabilityValues(profile.scores, `routing.profiles.${identity}.scores`, true);
  }
}

function validateCapabilityStage(value: unknown, path: string): void {
  const stage = requirePlainObject(value, path);
  requireStringArray(stage.prefer, `${path}.prefer`);
  requireStringArray(stage.pins, `${path}.pins`);
  requireEnumArray(stage.requiredInput, `${path}.requiredInput`, ["text", "image"] as const);
  requireNonNegativeInteger(stage.minimumContextWindow, `${path}.minimumContextWindow`);
  requireNonNegativeInteger(stage.minimumOutputTokens, `${path}.minimumOutputTokens`);
  requireBoolean(stage.requiresReasoning, `${path}.requiresReasoning`);
  requireBasisPoints(stage.minimumProfileConfidence, `${path}.minimumProfileConfidence`);
  validateCapabilityValues(stage.minimumScores, `${path}.minimumScores`, true);
  validateCapabilityValues(stage.weights, `${path}.weights`, false);
  requireStringEnum(stage.thinking, `${path}.thinking`, THINKING_LEVELS);
}

function validateCapabilityValues(value: unknown, path: string, basisPoints: boolean): void {
  const values = requirePlainObject(value, path);
  for (const [name, score] of Object.entries(values)) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(name)) throw new Error(`${path}.${name} is not a recognized capability`);
    if (basisPoints) requireBasisPoints(score, `${path}.${name}`);
    else requireNonNegativeInteger(score, `${path}.${name}`);
  }
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

function requireNonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer`);
}

function requireNonNegativeNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a non-negative number`);
}

function requireBasisPoints(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new Error(`${path} must be an integer between 0 and 10000`);
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

function requireStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  value.forEach((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
}

function requireEnumArray<T extends string>(value: unknown, path: string, allowed: readonly T[]): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  value.forEach((item, index) => requireStringEnum(item, `${path}[${index}]`, allowed));
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

function requireUserStoreRelativePath(value: unknown, path: string): void {
  requireNonEmptyString(value, path);
  const text = value as string;
  if (isAbsolute(text) || text.startsWith("/") || text.startsWith("\\") || /^[A-Za-z]:/.test(text)) {
    throw new Error(`${path} must be a relative path inside the user ai-orchestrator directory`);
  }
  for (const part of text.split(/[\\/]+/)) {
    if (part === ".." || /[\u0000-\u001f\u007f]/.test(part)) {
      throw new Error(`${path} must be a relative path inside the user ai-orchestrator directory`);
    }
  }
}

function sanitizeConfigPatch(patch: ConfigPatch, ignoreMcpProviders?: boolean): ConfigPatch {
  if (!ignoreMcpProviders || patch.mcp === undefined) {
    return patch;
  }
  const { mcp: _ignoredMcp, ...rest } = patch;
  return rest;
}

function constrainProjectRoutingPatch(patch: ConfigPatch, userRouting: CapabilityRoutingConfig): ConfigPatch {
  if (!patch.routing) return patch;
  const routing = cloneConfig(patch.routing) as unknown as Record<string, unknown>;
  protectDenyRules(routing, userRouting);
  protectLimits(routing, userRouting);
  protectBudgets(routing, userRouting);
  protectCircuitBreakers(routing, userRouting);
  protectSeparation(routing, userRouting);
  return { ...patch, routing: routing as unknown as ConfigPatch["routing"] };
}

function protectDenyRules(routing: Record<string, unknown>, userRouting: CapabilityRoutingConfig): void {
  if (routing.deny === undefined) {
    routing.deny = cloneConfig(userRouting.deny);
    return;
  }
  if (!isPlainObject(routing.deny)) return;
  routing.deny.providers = protectedUnion(userRouting.deny.providers, routing.deny.providers);
  routing.deny.models = protectedUnion(userRouting.deny.models, routing.deny.models);
  routing.deny.families = protectedUnion(userRouting.deny.families, routing.deny.families);
}

function protectLimits(routing: Record<string, unknown>, userRouting: CapabilityRoutingConfig): void {
  if (routing.limits === undefined) {
    routing.limits = cloneConfig(userRouting.limits);
    return;
  }
  if (!isPlainObject(routing.limits)) return;
  routing.limits.maxEstimatedUsdPerRun = protectedMinimum(
    userRouting.limits.maxEstimatedUsdPerRun,
    routing.limits.maxEstimatedUsdPerRun,
  );
  routing.limits.maxAttemptsPerStage = protectedMinimum(
    userRouting.limits.maxAttemptsPerStage,
    routing.limits.maxAttemptsPerStage,
  );
}

function protectBudgets(routing: Record<string, unknown>, userRouting: CapabilityRoutingConfig): void {
  if (routing.budgets === undefined) {
    routing.budgets = cloneConfig(userRouting.budgets);
    return;
  }
  if (!isPlainObject(routing.budgets)) return;
  for (const key of [
    "maxEstimatedUsdPerStage",
    "maxEstimatedUsdPerRun",
    "maxObservedUsdPerRun",
    "maxEstimatedUsdPerDay",
    "maxObservedUsdPerDay",
    "maxPaidFallbacksPerRun",
  ] as const) {
    routing.budgets[key] = protectedMinimum(userRouting.budgets[key], routing.budgets[key]);
  }
  routing.budgets.allowUnknownCost = protectedBoolean(!userRouting.budgets.allowUnknownCost, invertBoolean(routing.budgets.allowUnknownCost));
  if (typeof routing.budgets.allowUnknownCost === "boolean") {
    routing.budgets.allowUnknownCost = !routing.budgets.allowUnknownCost;
  }
}

function protectCircuitBreakers(routing: Record<string, unknown>, userRouting: CapabilityRoutingConfig): void {
  if (routing.circuitBreakers === undefined) {
    routing.circuitBreakers = cloneConfig(userRouting.circuitBreakers);
    return;
  }
  if (!isPlainObject(routing.circuitBreakers)) return;
  routing.circuitBreakers.maxSelectionFailures = protectedMinimum(
    userRouting.circuitBreakers.maxSelectionFailures,
    routing.circuitBreakers.maxSelectionFailures,
  );
  routing.circuitBreakers.repeatedRejectionFingerprintLimit = protectedMinimum(
    userRouting.circuitBreakers.repeatedRejectionFingerprintLimit,
    routing.circuitBreakers.repeatedRejectionFingerprintLimit,
  );
  routing.circuitBreakers.maxBuildPassesWithoutImprovement = protectedMinimum(
    userRouting.circuitBreakers.maxBuildPassesWithoutImprovement,
    routing.circuitBreakers.maxBuildPassesWithoutImprovement,
  );
  routing.circuitBreakers.requireIndependentChecker = protectedBoolean(
    userRouting.circuitBreakers.requireIndependentChecker,
    routing.circuitBreakers.requireIndependentChecker,
  );
}

function protectSeparation(routing: Record<string, unknown>, userRouting: CapabilityRoutingConfig): void {
  if (routing.separation === undefined) {
    routing.separation = cloneConfig(userRouting.separation);
    return;
  }
  if (!isPlainObject(routing.separation)) return;
  routing.separation.checkerMustDifferFromBuilder = protectedBoolean(
    userRouting.separation.checkerMustDifferFromBuilder,
    routing.separation.checkerMustDifferFromBuilder,
  );
  routing.separation.preferDifferentProviderFamily = protectedBoolean(
    userRouting.separation.preferDifferentProviderFamily,
    routing.separation.preferDifferentProviderFamily,
  );
  routing.separation.requireDifferentProviderFamilyFor = protectedUnion(
    userRouting.separation.requireDifferentProviderFamilyFor,
    routing.separation.requireDifferentProviderFamilyFor,
  );
}

function protectedUnion(base: readonly string[], patch: unknown): unknown {
  return patch === undefined ? [...base] : Array.isArray(patch) ? [...new Set([...base, ...patch])] : patch;
}

function protectedMinimum(base: number, patch: unknown): unknown {
  return patch === undefined ? base : typeof patch === "number" ? Math.min(base, patch) : patch;
}

function protectedBoolean(base: boolean, patch: unknown): unknown {
  return patch === undefined ? base : typeof patch === "boolean" ? base || patch : patch;
}

function invertBoolean(value: unknown): unknown {
  return typeof value === "boolean" ? !value : value;
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
