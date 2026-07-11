import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizePiModelCatalog, type PiModelLike } from "../src/adapters/piModelCatalog.js";
import {
  rankModels,
  type DiscoveredModel,
  type ModelSelectionIdentity,
  type RoutingStage,
  type TaskFeatures,
} from "../src/core/modelRouting.js";
import { loadConfig, type OrchestratorConfig, type RoleConfig } from "../src/core/config.js";
import { lifecycleModelChoices } from "../src/core/lifecycleRouting.js";

const ROUTING_STAGES: readonly RoutingStage[] = ["define", "plan", "build", "verify", "debug", "review", "ship", "fast-judge"];

export default function modelRoutingPreviewExtension(pi: ExtensionAPI): void {
  pi.registerCommand("lifecycle-models", {
    description: "Preview legacy and capability model routing without invoking a model",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const stage = parseStage(args);
      if (!stage) {
        ctx.ui.notify(`Usage: /lifecycle-models [${ROUTING_STAGES.join("|")}]`, "error");
        return;
      }

      const config = loadConfig(ctx.cwd, { ignoreMcpProviders: true });
      const models = normalizePiModelCatalog(ctx.modelRegistry.getAvailable() as unknown as PiModelLike[]);
      const decision = rankModels({
        stage,
        task: previewTask(config, stage),
        models,
        profiles: config.routing.profiles,
        policy: config.routing,
        priorSelections: [],
      });
      ctx.ui.notify(formatPreview(stage, legacySelection(stage, config, models), decision), "info");
    },
  });
}

function parseStage(value: string): RoutingStage | undefined {
  const candidate = value.trim().toLowerCase() || "review";
  return ROUTING_STAGES.includes(candidate as RoutingStage) ? candidate as RoutingStage : undefined;
}

function previewTask(config: OrchestratorConfig, stage: RoutingStage): TaskFeatures {
  const requirements = config.routing.stages[stage];
  return {
    contextTokens: requirements.minimumContextWindow,
    expectedOutputTokens: requirements.minimumOutputTokens,
    requiredInput: requirements.requiredInput,
    risk: stage === "review" || stage === "ship" ? "high" : "medium",
    workKind: stage === "ship" ? "release" : "unknown",
    fileCount: 0,
    languages: [],
    riskSignals: [],
    failureSignals: [],
  };
}

function legacySelection(
  stage: RoutingStage,
  config: OrchestratorConfig,
  available: readonly DiscoveredModel[],
): ModelSelectionIdentity | undefined {
  if (stage === "build") return availableIdentity(config.roles.coder, available, stage);
  if (stage === "fast-judge") return availableIdentity(config.roles.judge, available, stage);
  const fallbackRoles: Record<Exclude<RoutingStage, "build" | "fast-judge">, RoleConfig> = {
    define: config.roles.spec,
    plan: config.roles.planner,
    verify: config.roles.verifier,
    debug: config.roles.debugger,
    review: config.roles.reviewer,
    ship: config.roles.shipper,
  };
  const choices = lifecycleModelChoices(stage, config, available, fallbackRoles[stage]);
  const candidate = choices[0]?.candidate;
  return candidate ? { stage, provider: candidate.provider, model: candidate.model } : undefined;
}

function availableIdentity(
  role: RoleConfig,
  available: readonly DiscoveredModel[],
  stage: RoutingStage,
): ModelSelectionIdentity | undefined {
  return available.some((model) => model.provider === role.provider && model.model === role.model)
    ? { stage, provider: role.provider, model: role.model }
    : undefined;
}

function formatPreview(
  stage: RoutingStage,
  legacy: ModelSelectionIdentity | undefined,
  decision: ReturnType<typeof rankModels>,
): string {
  const lines = [
    `Capability routing preview — ${stage}`,
    `Legacy selection: ${legacy ? `${legacy.provider}/${legacy.model}` : "no locally available legacy candidate"}`,
    "Capability ranking:",
  ];
  if (decision.eligible.length === 0) lines.push("  (no eligible candidates)");
  decision.eligible.forEach((candidate, index) => {
    const components = candidate.scoreBreakdown.map((component) => `${component.name}=${component.value}`).join(", ");
    lines.push(`  ${index + 1}. ${candidate.identity.provider}/${candidate.identity.model} score=${candidate.score} thinking=${candidate.thinking}`);
    lines.push(`     ${components}`);
  });
  lines.push("Exclusions:");
  if (decision.excluded.length === 0) lines.push("  (none)");
  decision.excluded.forEach((candidate) => {
    lines.push(`  - ${candidate.identity.provider}/${candidate.identity.model}: ${candidate.code} — ${candidate.detail}`);
  });
  lines.push("Shadow only; no model invoked or selected.");
  return lines.join("\n");
}

export const modelRoutingPreviewInternals = { parseStage, formatPreview };
