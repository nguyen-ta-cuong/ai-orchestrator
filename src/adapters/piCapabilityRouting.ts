import { createHash } from "node:crypto";
import type { ConfigProvenance, OrchestratorConfig, RoleName, ThinkingLevel } from "../core/config.js";
import { lifecycleModelChoices } from "../core/lifecycleRouting.js";
import {
  modelIdentityKey,
  rankModels,
  resolveModelProfiles,
  type ModelSelectionIdentity,
  type RankedModelCandidate,
  type RoutingDecision,
  type RoutingPolicy,
  type RoutingStage,
  type TaskFeatures,
} from "../core/modelRouting.js";
import { extractTaskFeatures, type TaskFeatureEvidence } from "../core/taskFeatures.js";
import { normalizePiModelCatalog, type PiModelLike } from "./piModelCatalog.js";

export interface PiRoutingCandidate {
  provider: string;
  model: string;
  family?: string;
  thinking: ThinkingLevel;
  rank: number;
  score?: number;
  estimatedCostUsd?: number;
  profileVersion?: string;
  reason: string;
}

export interface PiRoutingPlan {
  engine: OrchestratorConfig["routing"]["engine"];
  policyVersion: string;
  taskFeatures: TaskFeatures;
  taskFeaturesHash: string;
  candidates: readonly PiRoutingCandidate[];
  decision?: RoutingDecision;
}

export interface CreatePiRoutingPlanInput {
  config: OrchestratorConfig;
  provenance: ConfigProvenance;
  stage: RoutingStage;
  role: RoleName;
  available: readonly PiModelLike[];
  evidence: TaskFeatureEvidence | string;
  priorSelections?: readonly ModelSelectionIdentity[];
  /** Compute active capability policy for a read-only preview without changing configured engine behavior. */
  forceCapability?: boolean;
}

export function piRoutingRunVersion(config: OrchestratorConfig, provenance: ConfigProvenance): string {
  return stableHash({ routing: config.routing, roles: config.roles, provenance });
}

export function createPiRoutingPlan(input: CreatePiRoutingPlanInput): PiRoutingPlan {
  const taskFeatures = extractTaskFeatures(input.evidence);
  const taskFeaturesHash = stableHash(taskFeatures);
  if (input.config.routing.engine !== "capability" && !input.forceCapability) {
    return {
      engine: input.config.routing.engine,
      policyVersion: `${input.config.routing.version}:${stableHash({ engine: input.config.routing.engine, role: input.config.roles[input.role] })}`,
      taskFeatures,
      taskFeaturesHash,
      candidates: legacyCandidates(input, taskFeatures),
    };
  }

  const policy = capabilityPolicy(input);
  const decision = rankModels({
    stage: input.stage,
    task: taskFeatures,
    models: normalizePiModelCatalog(input.available),
    profiles: input.config.routing.profiles,
    policy,
    priorSelections: input.priorSelections ?? [],
  });
  return {
    engine: "capability",
    policyVersion: `${decision.policyVersion}:${stableHash({ policy, profiles: input.config.routing.profiles })}`,
    taskFeatures,
    taskFeaturesHash,
    decision,
    candidates: decision.eligible.slice(0, policy.limits.maxAttemptsPerStage).map((candidate, index) => rankedCandidate(candidate, index)),
  };
}

function capabilityPolicy(input: CreatePiRoutingPlanInput): RoutingPolicy {
  const policy = structuredClone(input.config.routing) as RoutingPolicy;
  const identity = `${input.config.roles[input.role].provider}/${input.config.roles[input.role].model}`;
  const stage = policy.stages[input.stage];
  if (input.provenance.roles[input.role] === "builtin") {
    stage.prefer = [identity, ...stage.prefer.filter((value) => value !== identity)];
  } else {
    stage.pins = [identity];
    stage.minimumProfileConfidence = 0;
    stage.minimumScores = {};
    stage.thinking = input.config.roles[input.role].thinking;
    policy.allowInferredProfiles = true;
  }
  return policy;
}

function legacyCandidates(input: CreatePiRoutingPlanInput, taskFeatures: TaskFeatures): PiRoutingCandidate[] {
  const catalog = normalizePiModelCatalog(input.available);
  const available = catalog.map(({ provider, model }) => ({ provider, model }));
  const rawCandidates = input.stage !== "build" && input.stage !== "fast-judge"
    ? lifecycleModelChoices(
      input.stage,
      input.config,
      available,
      input.config.roles[input.role],
    ).map((choice, index) => ({
      ...choice.candidate,
      rank: index + 1,
      reason: choice.reason,
    }))
    : [{ ...input.config.roles[input.role], rank: 1, reason: `legacy ${input.role} role selection` }];
  const profiles = resolveModelProfiles(
    catalog,
    [{ provenance: "project", profiles: input.config.routing.profiles }],
    input.config.routing,
  );
  const candidates = rawCandidates.map((candidate) => {
    const identity = modelIdentityKey(candidate);
    const model = catalog.find((item) => modelIdentityKey(item) === identity);
    const profile = profiles.get(identity);
    const estimatedCostUsd = model?.cost
      ? (taskFeatures.contextTokens * model.cost.input + taskFeatures.expectedOutputTokens * model.cost.output) / 1_000_000
      : undefined;
    return {
      ...candidate,
      ...(profile?.family ? { family: profile.family } : model?.family ? { family: model.family } : {}),
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      ...(profile?.version ? { profileVersion: profile.version } : {}),
    };
  });

  if (!["verify", "debug", "review", "ship", "fast-judge"].includes(input.stage)) return candidates;
  const builder = [...(input.priorSelections ?? [])].reverse().find((selection) => selection.stage === "build");
  if (!builder) return candidates;
  const requireDifferentFamily = input.config.routing.separation.requireDifferentProviderFamilyFor.includes(input.stage);
  return candidates.filter((candidate) => {
    if (modelIdentityKey(candidate) === modelIdentityKey(builder)) return false;
    if (!requireDifferentFamily) return true;
    return Boolean(builder.family && candidate.family && builder.family !== candidate.family);
  });
}

function rankedCandidate(candidate: RankedModelCandidate, index: number): PiRoutingCandidate {
  const capability = candidate.scoreBreakdown.find((component) => component.name === "capability-fit");
  return {
    provider: candidate.identity.provider,
    model: candidate.identity.model,
    ...(candidate.identity.family ? { family: candidate.identity.family } : {}),
    thinking: candidate.thinking,
    rank: index + 1,
    score: candidate.score,
    ...(candidate.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: candidate.estimatedCostUsd }),
    profileVersion: candidate.profile.version,
    reason: `${capability?.detail ?? "capability fit"}; score ${candidate.score}; profile ${candidate.profile.provenance}/${candidate.profile.version}; ${candidate.thinkingReason}`,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
