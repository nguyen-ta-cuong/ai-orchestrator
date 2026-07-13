import type { ThinkingLevel } from "./config.js";

export type RoutingStage = "define" | "plan" | "build" | "verify" | "debug" | "review" | "ship" | "fast-judge";
export type TaskRisk = "low" | "medium" | "high";
export type ProfileProvenance = "user" | "project" | "builtin" | "observed" | "inferred";
export type RoutingMode = "quality" | "balanced" | "economy" | "pinned" | "custom";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DiscoveredModel {
  provider: string;
  model: string;
  displayName?: string;
  family?: string;
  api?: string;
  callable: boolean;
  reasoning: boolean;
  supportedThinking: readonly ThinkingLevel[];
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxOutputTokens: number;
  cost?: ModelCost;
}

export interface ModelCapabilityScores {
  requirements: number;
  architecture: number;
  coding: number;
  debugging: number;
  verification: number;
  review: number;
  release: number;
  structuredOutput: number;
  longContext: number;
  speed: number;
  economy: number;
}

export type CapabilityName = keyof ModelCapabilityScores;

export interface ModelCapabilityProfile {
  family?: string;
  confidence: number;
  provenance?: ProfileProvenance;
  version?: string;
  scores: Partial<ModelCapabilityScores>;
}

export interface ProfileSource {
  provenance: ProfileProvenance;
  profiles: Readonly<Record<string, ModelCapabilityProfile>>;
}

export interface ResolvedModelProfile {
  identity: ModelSelectionIdentity;
  family?: string;
  confidence: number;
  provenance: ProfileProvenance;
  version: string;
  scores: ModelCapabilityScores;
}

export interface TaskFeatures {
  contextTokens: number;
  expectedOutputTokens: number;
  requiredInput: readonly ("text" | "image")[];
  risk: TaskRisk;
  workKind: "feature" | "bug-fix" | "refactor" | "migration" | "test-only" | "documentation" | "configuration" | "release" | "unknown";
  fileCount: number;
  languages: readonly string[];
  riskSignals: readonly string[];
  failureSignals: readonly string[];
}

export interface StageRoutingPolicy {
  prefer: readonly string[];
  pins: readonly string[];
  requiredInput: readonly ("text" | "image")[];
  minimumContextWindow: number;
  minimumOutputTokens: number;
  requiresReasoning: boolean;
  minimumProfileConfidence: number;
  minimumScores: Partial<ModelCapabilityScores>;
  weights: Partial<ModelCapabilityScores>;
  thinking: ThinkingLevel;
}

export interface RoutingPolicy {
  version: string;
  mode: RoutingMode;
  allowInferredProfiles: boolean;
  unknownCost: "exclude" | "penalize" | "allow";
  unknownCostPenaltyBasisPoints: number;
  confidenceBonusBasisPoints: number;
  costPenaltyBasisPointsPerUsd: number;
  deny: {
    providers: readonly string[];
    models: readonly string[];
    families: readonly string[];
  };
  separation: {
    checkerMustDifferFromBuilder: boolean;
    preferDifferentProviderFamily: boolean;
    requireDifferentProviderFamilyFor: readonly RoutingStage[];
  };
  limits: {
    maxEstimatedUsdPerRun: number;
    maxAttemptsPerStage: number;
  };
  stages: Record<RoutingStage, StageRoutingPolicy>;
}

export interface ModelSelectionIdentity {
  stage?: RoutingStage;
  provider: string;
  model: string;
  family?: string;
}

export interface RoutingRequest {
  stage: RoutingStage;
  task: TaskFeatures;
  models: readonly DiscoveredModel[];
  profiles: Readonly<Record<string, ModelCapabilityProfile>>;
  policy: RoutingPolicy;
  priorSelections: readonly ModelSelectionIdentity[];
}

export interface ScoreComponent {
  name: "capability-fit" | "task-feature-fit" | "profile-confidence" | "provider-diversity" | "estimated-cost" | "unknown-cost";
  value: number;
  detail: string;
}

export interface RankedModelCandidate {
  identity: ModelSelectionIdentity;
  thinking: ThinkingLevel;
  score: number;
  scoreBreakdown: readonly ScoreComponent[];
  profile: Pick<ResolvedModelProfile, "confidence" | "provenance" | "version">;
  estimatedCostUsd?: number;
}

export type ExclusionCode =
  | "not-callable"
  | "denied-provider"
  | "denied-model"
  | "denied-family"
  | "pinned-only"
  | "profile-unknown"
  | "profile-confidence-low"
  | "capability-score-low"
  | "input-unsupported"
  | "context-insufficient"
  | "output-insufficient"
  | "reasoning-required"
  | "cost-unknown"
  | "cost-limit-exceeded"
  | "same-builder-model"
  | "same-builder-family";

export interface ExcludedCandidate {
  identity: ModelSelectionIdentity;
  code: ExclusionCode;
  detail: string;
}

export interface RoutingDecision {
  stage: RoutingStage;
  policyVersion: string;
  eligible: readonly RankedModelCandidate[];
  excluded: readonly ExcludedCandidate[];
  taskFeatures: TaskFeatures;
}

export interface ThinkingSelection {
  requested: ThinkingLevel;
  selected: ThinkingLevel;
  clamped: boolean;
  reason: string;
}

const EMPTY_SCORES: ModelCapabilityScores = {
  requirements: 0,
  architecture: 0,
  coding: 0,
  debugging: 0,
  verification: 0,
  review: 0,
  release: 0,
  structuredOutput: 0,
  longContext: 0,
  speed: 0,
  economy: 0,
};

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CHECKER_STAGES = new Set<RoutingStage>(["verify", "debug", "review", "ship", "fast-judge"]);

function stagePolicy(
  weights: Partial<ModelCapabilityScores>,
  minimumScores: Partial<ModelCapabilityScores>,
  thinking: ThinkingLevel,
): StageRoutingPolicy {
  return {
    prefer: [],
    pins: [],
    requiredInput: ["text"],
    minimumContextWindow: 16_000,
    minimumOutputTokens: 2_000,
    requiresReasoning: false,
    minimumProfileConfidence: 2_500,
    minimumScores,
    weights,
    thinking,
  };
}

export const DEFAULT_STAGE_REQUIREMENTS: Record<RoutingStage, StageRoutingPolicy> = {
  define: stagePolicy({ requirements: 4, architecture: 2, structuredOutput: 2, longContext: 2 }, { requirements: 5_000 }, "high"),
  plan: stagePolicy({ architecture: 5, requirements: 2, longContext: 2, structuredOutput: 1 }, { architecture: 5_000 }, "high"),
  build: stagePolicy({ coding: 6, debugging: 1, structuredOutput: 1, longContext: 2 }, { coding: 5_000 }, "medium"),
  verify: stagePolicy({ verification: 6, structuredOutput: 3, debugging: 1 }, { verification: 5_000 }, "medium"),
  debug: stagePolicy({ debugging: 6, architecture: 2, longContext: 2 }, { debugging: 5_000 }, "high"),
  review: stagePolicy({ review: 5, architecture: 2, verification: 1, structuredOutput: 1, longContext: 1 }, { review: 5_000 }, "high"),
  ship: stagePolicy({ release: 5, review: 2, structuredOutput: 2, architecture: 1 }, { release: 5_000 }, "high"),
  "fast-judge": stagePolicy({ verification: 4, review: 4, structuredOutput: 2 }, { verification: 4_500, review: 4_500 }, "high"),
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: "capability-foundation-v1",
  mode: "balanced",
  allowInferredProfiles: false,
  unknownCost: "penalize",
  unknownCostPenaltyBasisPoints: 750,
  confidenceBonusBasisPoints: 500,
  costPenaltyBasisPointsPerUsd: 100,
  deny: { providers: [], models: [], families: [] },
  separation: {
    checkerMustDifferFromBuilder: true,
    preferDifferentProviderFamily: true,
    requireDifferentProviderFamilyFor: [],
  },
  limits: { maxEstimatedUsdPerRun: 8, maxAttemptsPerStage: 3 },
  stages: DEFAULT_STAGE_REQUIREMENTS,
};

export function modelIdentityKey(identity: Pick<ModelSelectionIdentity, "provider" | "model">): string {
  return `${identity.provider}\u0000${identity.model}`;
}

export function resolveModelProfiles(
  models: readonly DiscoveredModel[],
  profileSources: readonly ProfileSource[],
  policy: RoutingPolicy,
): ReadonlyMap<string, ResolvedModelProfile> {
  const byIdentity = new Map<string, ResolvedModelProfile>();
  const orderedSources = [...profileSources].sort((left, right) => provenanceRank(left.provenance) - provenanceRank(right.provenance));

  for (const discovered of models) {
    const lookupKey = `${discovered.provider}/${discovered.model}`;
    for (const source of orderedSources) {
      const candidate = source.profiles[lookupKey] ?? source.profiles[modelIdentityKey(discovered)];
      if (!candidate) continue;
      byIdentity.set(modelIdentityKey(discovered), resolveProfile(discovered, candidate, source.provenance));
    }
    if (!byIdentity.has(modelIdentityKey(discovered)) && policy.allowInferredProfiles) {
      byIdentity.set(modelIdentityKey(discovered), resolveProfile(discovered, {
        confidence: 0,
        provenance: "inferred",
        version: "inferred-v1",
        scores: {},
      }, "inferred"));
    }
  }

  return byIdentity;
}

export function rankModels(request: RoutingRequest): RoutingDecision {
  const profiles = resolveModelProfiles(
    request.models,
    profileSourcesFrom(request.profiles),
    request.policy,
  );
  const excluded: ExcludedCandidate[] = [];
  const eligible: RankedModelCandidate[] = [];

  for (const model of request.models) {
    const identity = identityFor(request.stage, model);
    const exclusion = exclusionFor(model, identity, profiles.get(modelIdentityKey(model)), request);
    if (exclusion) {
      excluded.push(exclusion);
      continue;
    }

    const profile = profiles.get(modelIdentityKey(model))!;
    const rankedIdentity = profile.family ? { ...identity, family: profile.family } : identity;
    const thinking = selectThinkingLevel(request.stage, model, request.policy, request.task.risk);
    const estimatedCostUsd = estimateCost(model, request.task);
    const scoreBreakdown = scoreModel(model, profile, estimatedCostUsd, request);
    eligible.push({
      identity: rankedIdentity,
      thinking: thinking.selected,
      score: scoreBreakdown.reduce((sum, component) => sum + component.value, 0),
      scoreBreakdown,
      profile: { confidence: profile.confidence, provenance: profile.provenance, version: profile.version },
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    });
  }

  eligible.sort((left, right) => compareCandidates(left, right, request.policy, request.stage));
  return {
    stage: request.stage,
    policyVersion: request.policy.version,
    eligible,
    excluded,
    taskFeatures: structuredClone(request.task),
  };
}

function profileSourcesFrom(profiles: Readonly<Record<string, ModelCapabilityProfile>>): ProfileSource[] {
  const grouped = new Map<ProfileProvenance, Record<string, ModelCapabilityProfile>>();
  for (const [identity, profile] of Object.entries(profiles)) {
    const provenance = profile.provenance ?? "project";
    const source = grouped.get(provenance) ?? {};
    source[identity] = profile;
    grouped.set(provenance, source);
  }
  return [...grouped].map(([provenance, sourceProfiles]) => ({ provenance, profiles: sourceProfiles }));
}

export function selectThinkingLevel(
  stage: RoutingStage,
  model: DiscoveredModel,
  policy: RoutingPolicy,
  risk: TaskRisk,
): ThinkingSelection {
  const target = policy.stages[stage].thinking;
  const requested = risk === "high" ? raiseThinking(target) : target;
  const supported = [...new Set(model.supportedThinking)].sort((a, b) => thinkingRank(a) - thinkingRank(b));
  const selected = supported.includes(requested)
    ? requested
    : [...supported].reverse().find((level) => thinkingRank(level) <= thinkingRank(requested)) ?? supported[0] ?? "off";
  const clamped = selected !== requested;
  return {
    requested,
    selected,
    clamped,
    reason: clamped
      ? `${requested} is unsupported by ${model.provider}/${model.model}; clamped to ${selected}`
      : `${selected} is supported by ${model.provider}/${model.model}`,
  };
}

function resolveProfile(model: DiscoveredModel, profile: ModelCapabilityProfile, provenance: ProfileProvenance): ResolvedModelProfile {
  return {
    identity: identityFor(undefined, model),
    family: profile.family ?? model.family,
    confidence: profile.confidence,
    provenance,
    version: profile.version ?? "unversioned",
    scores: { ...EMPTY_SCORES, ...profile.scores },
  };
}

function exclusionFor(
  model: DiscoveredModel,
  identity: ModelSelectionIdentity,
  profile: ResolvedModelProfile | undefined,
  request: RoutingRequest,
): ExcludedCandidate | undefined {
  const policy = request.policy;
  const stage = policy.stages[request.stage];
  const excluded = (code: ExclusionCode, detail: string): ExcludedCandidate => ({ identity, code, detail });
  const identityText = `${model.provider}/${model.model}`;

  if (!model.callable) return excluded("not-callable", `${identityText} is not callable on this surface`);
  if (policy.deny.providers.includes(model.provider)) return excluded("denied-provider", `provider ${model.provider} is denied by policy`);
  if (policy.deny.models.includes(identityText)) return excluded("denied-model", `${identityText} is denied by policy`);
  const family = profile?.family ?? model.family;
  if (family && policy.deny.families.includes(family)) return excluded("denied-family", `family ${family} is denied by policy`);
  if ((policy.mode === "pinned" || stage.pins.length > 0) && !stage.pins.includes(identityText)) {
    return excluded("pinned-only", `${identityText} is not pinned for ${request.stage}`);
  }
  if (!profile) return excluded("profile-unknown", `${identityText} has no explicit profile and inferred profiles are disabled`);
  if (profile.confidence < stage.minimumProfileConfidence) {
    return excluded("profile-confidence-low", `${identityText} profile confidence ${profile.confidence} is below ${stage.minimumProfileConfidence}`);
  }
  for (const [capability, minimum] of Object.entries(stage.minimumScores) as [CapabilityName, number][]) {
    if (profile.scores[capability] < minimum) {
      return excluded("capability-score-low", `${identityText} ${capability} score ${profile.scores[capability]} is below ${minimum}`);
    }
  }
  const requiredInputs = new Set([...stage.requiredInput, ...request.task.requiredInput]);
  const missingInput = [...requiredInputs].find((input) => !model.input.includes(input));
  if (missingInput) return excluded("input-unsupported", `${identityText} does not support required ${missingInput} input`);
  const requiredContext = Math.max(stage.minimumContextWindow, request.task.contextTokens);
  if (model.contextWindow < requiredContext) return excluded("context-insufficient", `${identityText} context ${model.contextWindow} is below ${requiredContext}`);
  const requiredOutput = Math.max(stage.minimumOutputTokens, request.task.expectedOutputTokens);
  if (model.maxOutputTokens < requiredOutput) return excluded("output-insufficient", `${identityText} output limit ${model.maxOutputTokens} is below ${requiredOutput}`);
  if (stage.requiresReasoning && !model.reasoning) return excluded("reasoning-required", `${identityText} does not support required reasoning`);
  const estimatedCost = estimateCost(model, request.task);
  if (estimatedCost === undefined && policy.unknownCost === "exclude") return excluded("cost-unknown", `${identityText} has unknown cost under exclude policy`);
  if (estimatedCost !== undefined && estimatedCost > policy.limits.maxEstimatedUsdPerRun) {
    return excluded("cost-limit-exceeded", `${identityText} estimated cost $${estimatedCost.toFixed(4)} exceeds $${policy.limits.maxEstimatedUsdPerRun}`);
  }

  const builder = latestBuildSelection(request.priorSelections);
  if (builder && CHECKER_STAGES.has(request.stage)) {
    if (modelIdentityKey(builder) === modelIdentityKey(model)) {
      return excluded("same-builder-model", `${identityText} is the BUILD model and cannot check its own work`);
    }
    if (policy.separation.requireDifferentProviderFamilyFor.includes(request.stage)) {
      if (!family || !builder.family || family === builder.family) {
        return excluded("same-builder-family", `${identityText} does not prove a family distinct from BUILD`);
      }
    }
  }
  return undefined;
}

function scoreModel(
  model: DiscoveredModel,
  profile: ResolvedModelProfile,
  estimatedCostUsd: number | undefined,
  request: RoutingRequest,
): ScoreComponent[] {
  const weights = Object.entries(request.policy.stages[request.stage].weights) as [CapabilityName, number][];
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const capabilityFit = totalWeight === 0
    ? 0
    : Math.round(weights.reduce((sum, [name, weight]) => sum + profile.scores[name] * weight, 0) / totalWeight);
  const taskFeatureFit = scoreTaskFeatureFit(profile.scores, request.task);
  const confidence = Math.round(profile.confidence * request.policy.confidenceBonusBasisPoints / 10_000);
  const builder = latestBuildSelection(request.priorSelections);
  const family = profile.family ?? model.family;
  const diversity = builder && request.policy.separation.preferDifferentProviderFamily && family && builder.family && family !== builder.family ? 250 : 0;
  const modeCostMultiplier = request.policy.mode === "quality" ? 0.25 : 1;
  const cost = estimatedCostUsd === undefined
    ? request.policy.unknownCost === "penalize" ? -Math.round(request.policy.unknownCostPenaltyBasisPoints * modeCostMultiplier) : 0
    : -Math.round(estimatedCostUsd * request.policy.costPenaltyBasisPointsPerUsd * modeCostMultiplier);

  return [
    { name: "capability-fit", value: capabilityFit, detail: `weighted ${request.stage} capability fit` },
    { name: "task-feature-fit", value: taskFeatureFit, detail: `fit for ${request.task.workKind}, risk, scale, and failure signals` },
    { name: "profile-confidence", value: confidence, detail: `profile confidence ${profile.confidence}` },
    { name: "provider-diversity", value: diversity, detail: diversity > 0 ? "different family from BUILD" : "no diversity bonus" },
    {
      name: estimatedCostUsd === undefined ? "unknown-cost" : "estimated-cost",
      value: cost,
      detail: estimatedCostUsd === undefined ? "cost metadata unavailable" : `estimated $${estimatedCostUsd.toFixed(4)}`,
    },
  ];
}

function scoreTaskFeatureFit(scores: ModelCapabilityScores, task: TaskFeatures): number {
  const relevant: number[] = [];
  const byWorkKind: Record<TaskFeatures["workKind"], readonly CapabilityName[]> = {
    feature: ["architecture", "coding"],
    "bug-fix": ["debugging", "coding"],
    refactor: ["architecture", "coding", "review"],
    migration: ["architecture", "longContext", "review"],
    "test-only": ["verification", "structuredOutput"],
    documentation: ["requirements", "longContext"],
    configuration: ["architecture", "review"],
    release: ["release", "review"],
    unknown: [],
  };
  for (const capability of byWorkKind[task.workKind]) relevant.push(scores[capability]);
  if (task.risk === "high" || task.riskSignals.length > 0) relevant.push(scores.review, scores.verification);
  if (task.failureSignals.length > 0) relevant.push(scores.debugging, scores.verification);
  if (task.fileCount >= 10 || task.contextTokens >= 64_000) relevant.push(scores.longContext, scores.architecture);
  if (task.languages.length > 1) relevant.push(scores.longContext);
  return relevant.length === 0 ? 0 : Math.round(relevant.reduce((sum, value) => sum + value, 0) / relevant.length / 5);
}

function latestBuildSelection(selections: readonly ModelSelectionIdentity[]): ModelSelectionIdentity | undefined {
  return [...selections].reverse().find((selection) => selection.stage === "build");
}

function estimateCost(model: DiscoveredModel, task: TaskFeatures): number | undefined {
  if (!model.cost) return undefined;
  return (task.contextTokens * model.cost.input + task.expectedOutputTokens * model.cost.output) / 1_000_000;
}

function compareCandidates(
  left: RankedModelCandidate,
  right: RankedModelCandidate,
  policy: RoutingPolicy,
  stage: RoutingStage,
): number {
  const stagePolicy = policy.stages[stage];
  if (stagePolicy.pins.length > 0) {
    const leftPinned = preferIndex(left.identity, stagePolicy.pins);
    const rightPinned = preferIndex(right.identity, stagePolicy.pins);
    if (leftPinned !== rightPinned) return leftPinned - rightPinned;
  }
  if (policy.mode === "economy") {
    const leftCost = left.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
    const rightCost = right.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
    if (leftCost !== rightCost) return leftCost - rightCost;
  }
  if (right.score !== left.score) return right.score - left.score;
  const leftPreferred = preferIndex(left.identity, stagePolicy.prefer);
  const rightPreferred = preferIndex(right.identity, stagePolicy.prefer);
  if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
  if (right.profile.confidence !== left.profile.confidence) return right.profile.confidence - left.profile.confidence;
  const leftCost = left.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
  const rightCost = right.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) return leftCost - rightCost;
  const leftIdentity = `${left.identity.provider}/${left.identity.model}`;
  const rightIdentity = `${right.identity.provider}/${right.identity.model}`;
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function preferIndex(identity: ModelSelectionIdentity, prefer: readonly string[]): number {
  const index = prefer.indexOf(`${identity.provider}/${identity.model}`);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function identityFor(stage: RoutingStage | undefined, model: DiscoveredModel): ModelSelectionIdentity {
  return {
    ...(stage ? { stage } : {}),
    provider: model.provider,
    model: model.model,
    ...(model.family ? { family: model.family } : {}),
  };
}

function provenanceRank(provenance: ProfileProvenance): number {
  return ({ inferred: 0, builtin: 1, observed: 2, project: 3, user: 4 })[provenance];
}

function thinkingRank(level: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(level);
}

function raiseThinking(level: ThinkingLevel): ThinkingLevel {
  return THINKING_LEVELS[Math.min(thinkingRank(level) + 1, THINKING_LEVELS.length - 1)]!;
}
