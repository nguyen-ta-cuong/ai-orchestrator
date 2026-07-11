import type {
  LifecycleRoutedStage,
  ModelCandidate,
  OrchestratorConfig,
  RoleConfig,
} from "./config.js";

export interface AvailableModelRef {
  provider: string;
  model: string;
}

export interface LifecycleModelChoice {
  stage: LifecycleRoutedStage;
  candidate: ModelCandidate;
  source: "routing" | "role-fallback";
  reason: string;
}

export function lifecycleModelChoices(
  stage: LifecycleRoutedStage,
  config: OrchestratorConfig,
  available: readonly AvailableModelRef[],
  fallbackRole: RoleConfig,
): LifecycleModelChoice[] {
  const availableKeys = new Set(available.map(modelKey));
  const seen = new Set<string>();
  const choices: LifecycleModelChoice[] = [];

  if (config.routing.lifecycle.enabled) {
    for (const candidate of config.routing.lifecycle.stages[stage]) {
      const key = modelKey({ provider: candidate.provider, model: candidate.model });
      if (!availableKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      choices.push({
        stage,
        candidate: { ...candidate },
        source: "routing",
        reason: `selected from locally available ${stage} candidates by configured priority`,
      });
    }
  }

  const fallbackKey = modelKey({ provider: fallbackRole.provider, model: fallbackRole.model });
  if (availableKeys.has(fallbackKey) && !seen.has(fallbackKey)) {
    choices.push({
      stage,
      candidate: { ...fallbackRole },
      source: "role-fallback",
      reason: config.routing.lifecycle.enabled
        ? "configured role fallback after locally available routed candidates"
        : "dynamic lifecycle routing is disabled; using configured role",
    });
  }

  return choices;
}

function modelKey(model: AvailableModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}
