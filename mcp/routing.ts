import type { OrchestratorConfig, RoleConfig } from "../src/core/config.js";
import {
  rankModels,
  type DiscoveredModel,
  type ExcludedCandidate,
  type ModelCapabilityProfile,
  type ModelSelectionIdentity,
  type RankedModelCandidate,
  type TaskFeatures,
} from "../src/core/modelRouting.js";

export interface McpSeparationResult {
  required: boolean;
  satisfied: boolean;
  builderIdentity?: string;
  reason: string;
}

export interface McpRoutingMetadata {
  selectedIdentity: { provider: string; model: string; family?: string };
  thinking: RoleConfig["thinking"];
  policyVersion: string;
  score: { total: number; breakdown: RankedModelCandidate["scoreBreakdown"] } | null;
  fallbackHistory: Array<{ identity: string; reason: string }>;
  separation: McpSeparationResult;
  legacyFallback: boolean;
}

export interface McpCompletionCandidate extends RoleConfig {
  family?: string;
  maxOutputTokens?: number;
  requestedOutputTokens?: number;
  estimatedCostUsd?: number;
}

export interface McpRoute {
  candidates: McpCompletionCandidate[];
  ranked: RankedModelCandidate[];
  excluded: ExcludedCandidate[];
  policyVersion: string;
  separation: McpSeparationResult;
  legacyFallback: boolean;
  builder?: ModelSelectionIdentity;
  familySeparationRequired: boolean;
}

const SUPPORTED_APIS = new Set(["anthropic-messages", "openai-responses", "openai-completions"]);

export function defaultTaskFeatures(text: string): TaskFeatures {
  return {
    // A character-per-token upper bound is intentionally conservative across
    // provider tokenizers and prevents clients from understating prompt cost.
    contextTokens: Math.max(1, text.length),
    expectedOutputTokens: 4_096,
    requiredInput: ["text"],
    risk: "medium",
    workKind: "unknown",
    fileCount: 0,
    languages: [],
    riskSignals: [],
    failureSignals: [],
  };
}

/** Merge caller hints without allowing them to understate prompt size, output, or risk. */
export function mergeTaskFeatures(text: string, hints?: TaskFeatures): TaskFeatures {
  const derived = defaultTaskFeatures(text);
  if (!hints) return derived;
  const riskRank = { low: 0, medium: 1, high: 2 } as const;
  return {
    contextTokens: Math.max(derived.contextTokens, hints.contextTokens),
    expectedOutputTokens: Math.max(derived.expectedOutputTokens, hints.expectedOutputTokens),
    requiredInput: [...new Set([...derived.requiredInput, ...hints.requiredInput])],
    risk: riskRank[hints.risk] > riskRank[derived.risk] ? hints.risk : derived.risk,
    workKind: hints.workKind,
    fileCount: Math.max(derived.fileCount, hints.fileCount),
    languages: [...new Set([...derived.languages, ...hints.languages])],
    riskSignals: [...new Set([...derived.riskSignals, ...hints.riskSignals])],
    failureSignals: [...new Set([...derived.failureSignals, ...hints.failureSignals])],
  };
}

export function resolveMcpRoute(input: {
  config: OrchestratorConfig;
  stage: "plan" | "fast-judge";
  role: "planner" | "judge";
  task: TaskFeatures;
  coderIdentity?: string;
  /** Rank without making the configured engine active. Used only by orchestrator_models. */
  preview?: boolean;
}): McpRoute {
  const { config, stage, role } = input;
  const familySeparationRequired = stage === "fast-judge"
    && config.routing.separation.requireDifferentProviderFamilyFor.includes("fast-judge");
  const strict = stage === "fast-judge";
  const builder = input.coderIdentity ? resolveBuilderIdentity(config, parseIdentity(input.coderIdentity)) : undefined;
  if (strict && !builder && !input.preview) {
    throw new Error("Strict maker/checker separation requires coderIdentity for orchestrator_judge");
  }

  // Capability-shadow is observational on every surface. Active planner/judge
  // calls keep the exact legacy role while orchestrator_models exposes ranking.
  if (!input.preview && config.routing.engine === "capability" && config.mcp.models.length === 0) {
    throw new Error(`No trusted MCP model catalog is configured for active capability routing at ${stage}`);
  }
  if ((!input.preview && config.routing.engine !== "capability") || config.mcp.models.length === 0) {
    const exact = completionCandidateForRole(config, config.roles[role], input.task.expectedOutputTokens);
    const separation = separationFor(strict, familySeparationRequired, builder, exact);
    if (!input.preview && !separation.satisfied) {
      throw new Error(`Strict maker/checker separation failed: ${separation.reason}`);
    }
    return {
      candidates: [exact],
      ranked: [],
      excluded: [],
      policyVersion: config.routing.version,
      separation,
      legacyFallback: true,
      ...(builder ? { builder } : {}),
      familySeparationRequired,
    };
  }

  const normalized = normalizeCatalog(config, stage === "fast-judge", input.preview === true);
  const profiles: Record<string, ModelCapabilityProfile> = {};
  for (const entry of config.mcp.models) {
    const profile = config.routing.profiles[entry.profile ?? `${entry.provider}/${entry.model}`];
    if (profile) profiles[`${entry.provider}/${entry.model}`] = { ...profile, provenance: "user" };
  }
  const policy = structuredClone(config.routing);
  policy.limits.maxEstimatedUsdPerRun = Math.min(
    policy.limits.maxEstimatedUsdPerRun,
    policy.budgets.maxEstimatedUsdPerStage,
    policy.budgets.maxEstimatedUsdPerRun,
  );
  if (!policy.budgets.allowUnknownCost) policy.unknownCost = "exclude";
  if (strict) policy.separation.checkerMustDifferFromBuilder = true;

  const decision = rankModels({
    stage,
    task: input.task,
    models: normalized,
    profiles,
    policy,
    priorSelections: builder ? [{ stage: "build", ...builder }] : [],
  });
  if (decision.eligible.length === 0 && !input.preview) {
    throw new Error(`No eligible trusted MCP model for ${stage}: ${decision.excluded.map((item) => `${item.identity.provider}/${item.identity.model}: ${item.detail}`).join("; ")}`);
  }

  const ranked = input.preview
    ? [...decision.eligible]
    : boundedFallbackPrefix(decision.eligible, config, policy.limits.maxEstimatedUsdPerRun);
  const candidates = ranked.map((candidate) => completionCandidateForRanked(config, candidate, input.task.expectedOutputTokens));
  const separation = separationFor(strict, familySeparationRequired, builder, candidates[0]);
  return {
    candidates,
    ranked,
    excluded: [...decision.excluded],
    policyVersion: decision.policyVersion,
    separation,
    legacyFallback: false,
    ...(builder ? { builder } : {}),
    familySeparationRequired,
  };
}

function normalizeCatalog(
  config: OrchestratorConfig,
  structuredOutputRequired: boolean,
  preview: boolean,
): DiscoveredModel[] {
  return config.mcp.models.map((entry) => {
    const provider = config.mcp.providers[entry.provider];
    const profile = config.routing.profiles[entry.profile ?? `${entry.provider}/${entry.model}`];
    const structuredCapable = (profile?.scores.structuredOutput ?? 0) >= 4_500;
    const providerCompatible = Boolean(provider && SUPPORTED_APIS.has(provider.api));
    return {
      provider: entry.provider,
      model: entry.model,
      ...(entry.family ? { family: entry.family } : {}),
      api: provider?.api,
      // Preview proves trusted configuration and API compatibility, not secret state.
      callable: providerCompatible && (preview || Boolean(provider?.apiKey)) && (!structuredOutputRequired || structuredCapable),
      reasoning: entry.reasoning,
      supportedThinking: entry.supportedThinking,
      input: entry.input,
      contextWindow: entry.contextWindow,
      maxOutputTokens: Math.min(entry.maxOutputTokens, providerOutputLimit(provider?.api)),
      ...(entry.cost ? { cost: entry.cost } : {}),
    };
  });
}

function providerOutputLimit(api: string | undefined): number {
  if (api === "openai-completions") return 4_096;
  if (api === "anthropic-messages" || api === "openai-responses") return 8_192;
  return 0;
}

function boundedFallbackPrefix(
  eligible: readonly RankedModelCandidate[],
  config: OrchestratorConfig,
  estimatedBudgetUsd: number,
): RankedModelCandidate[] {
  const maxCandidates = Math.min(
    eligible.length,
    config.routing.limits.maxAttemptsPerStage,
    config.routing.circuitBreakers.maxSelectionFailures,
    config.routing.budgets.maxPaidFallbacksPerRun + 1,
  );
  const result: RankedModelCandidate[] = [];
  let cumulativeKnownCost = 0;
  for (const candidate of eligible.slice(0, maxCandidates)) {
    const nextKnownCost = cumulativeKnownCost + (candidate.estimatedCostUsd ?? 0);
    if (candidate.estimatedCostUsd !== undefined && nextKnownCost > estimatedBudgetUsd) continue;
    result.push(candidate);
    cumulativeKnownCost = nextKnownCost;
  }
  return result;
}

function completionCandidateForRanked(
  config: OrchestratorConfig,
  ranked: RankedModelCandidate,
  requestedOutputTokens: number,
): McpCompletionCandidate {
  const catalog = config.mcp.models.find((entry) => entry.provider === ranked.identity.provider && entry.model === ranked.identity.model);
  return {
    provider: ranked.identity.provider,
    model: ranked.identity.model,
    thinking: ranked.thinking,
    ...(ranked.identity.family ? { family: ranked.identity.family } : {}),
    ...(catalog ? { maxOutputTokens: Math.min(catalog.maxOutputTokens, providerOutputLimit(config.mcp.providers[catalog.provider]?.api)) } : {}),
    requestedOutputTokens,
    ...(ranked.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: ranked.estimatedCostUsd }),
  };
}

function completionCandidateForRole(
  config: OrchestratorConfig,
  role: RoleConfig,
  requestedOutputTokens: number,
): McpCompletionCandidate {
  const catalog = config.mcp.models.find((entry) => entry.provider === role.provider && entry.model === role.model);
  const profile = catalog ? config.routing.profiles[catalog.profile ?? `${catalog.provider}/${catalog.model}`] : undefined;
  const family = profile?.family ?? catalog?.family;
  return {
    ...role,
    ...(family ? { family } : {}),
    ...(catalog ? { maxOutputTokens: Math.min(catalog.maxOutputTokens, providerOutputLimit(config.mcp.providers[catalog.provider]?.api)) } : {}),
    requestedOutputTokens,
  };
}

function resolveBuilderIdentity(config: OrchestratorConfig, identity: ModelSelectionIdentity): ModelSelectionIdentity {
  const catalog = config.mcp.models.find((entry) => entry.provider === identity.provider && entry.model === identity.model);
  const profile = catalog ? config.routing.profiles[catalog.profile ?? `${catalog.provider}/${catalog.model}`] : undefined;
  const family = profile?.family ?? catalog?.family;
  return family ? { ...identity, family } : identity;
}

function parseIdentity(value: string): ModelSelectionIdentity {
  const normalized = value.trim();
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1 || /\s/.test(normalized)) {
    throw new Error("coderIdentity must use provider/model format without whitespace");
  }
  return { provider: normalized.slice(0, slash), model: normalized.slice(slash + 1) };
}

function separationFor(
  required: boolean,
  familyRequired: boolean,
  builder: ModelSelectionIdentity | undefined,
  checker: Pick<McpCompletionCandidate, "provider" | "model" | "family"> | undefined,
): McpSeparationResult {
  const builderIdentity = builder ? `${builder.provider}/${builder.model}` : undefined;
  const base = { required, ...(builderIdentity ? { builderIdentity } : {}) };
  if (!required) return { ...base, satisfied: true, reason: "strict separation is not required by the active MCP engine" };
  if (!builder) return { ...base, satisfied: false, reason: "coderIdentity was not supplied" };
  if (!checker) return { ...base, satisfied: false, reason: "no eligible checker is available" };
  if (checker.provider.includes("/") || /\s/.test(checker.provider) || /\s/.test(checker.model)) {
    return { ...base, satisfied: false, reason: "selected checker identity is not canonical provider/model syntax" };
  }
  if (checker.provider === builder.provider && checker.model === builder.model) {
    return { ...base, satisfied: false, reason: "selected checker is the BUILD model" };
  }
  if (familyRequired && (!checker.family || !builder.family || checker.family === builder.family)) {
    return { ...base, satisfied: false, reason: "selected checker does not prove a family distinct from BUILD" };
  }
  return {
    ...base,
    satisfied: true,
    reason: familyRequired ? "selected checker differs from BUILD by identity and family" : "selected checker differs from BUILD identity",
  };
}

export function metadataFor(
  route: McpRoute,
  selectedIndex: number,
  fallbackHistory: McpRoutingMetadata["fallbackHistory"],
): McpRoutingMetadata {
  const candidate = route.candidates[selectedIndex];
  if (!candidate) throw new Error(`Selected MCP candidate index ${selectedIndex} is out of range`);
  const ranked = route.ranked[selectedIndex];
  return {
    selectedIdentity: {
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.family ? { family: candidate.family } : {}),
    },
    thinking: candidate.thinking,
    policyVersion: route.policyVersion,
    score: ranked ? { total: ranked.score, breakdown: ranked.scoreBreakdown } : null,
    fallbackHistory,
    separation: separationFor(route.separation.required, route.familySeparationRequired, route.builder, candidate),
    legacyFallback: route.legacyFallback,
  };
}
