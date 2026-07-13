import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiRoutingPlan, type PiRoutingCandidate } from "../src/adapters/piCapabilityRouting.js";
import {
  loadConfigWithProvenance,
  type OrchestratorConfig,
  type RoleName,
} from "../src/core/config.js";
import type {
  ModelSelectionIdentity,
  RoutingDecision,
  RoutingStage,
} from "../src/core/modelRouting.js";
import { currentRun, readState } from "../src/lifecycle/artifacts.js";

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

      const resolved = loadConfigWithProvenance(ctx.cwd, { ignoreMcpProviders: true });
      const current = currentRun(ctx.cwd, resolved.config.lifecycle.artifactsDir);
      const state = current && readState(current.paths);
      const priorSelections: ModelSelectionIdentity[] = (state?.modelSelections ?? []).map((selection) => ({
        stage: selection.stage,
        provider: selection.provider,
        model: selection.model,
        ...(selection.family ? { family: selection.family } : {}),
      }));
      const evidence = {
        task: state?.task ?? `routing preview for ${stage}`,
        spec: current?.paths.spec,
        plan: current?.paths.plan,
      };
      const common = {
        provenance: resolved.provenance,
        stage,
        role: roleForStage(stage),
        available: ctx.modelRegistry.getAvailable(),
        evidence,
        priorSelections,
      } as const;
      const capability = createPiRoutingPlan({ ...common, config: resolved.config, forceCapability: true });
      if (!capability.decision) throw new Error("capability preview did not produce a routing decision");
      const legacyConfig = structuredClone(resolved.config) as OrchestratorConfig;
      legacyConfig.routing.engine = "legacy";
      const legacy = createPiRoutingPlan({ ...common, config: legacyConfig });
      ctx.ui.notify(formatPreview(stage, legacy.candidates[0], capability.decision), "info");
    },
  });
}

function parseStage(value: string): RoutingStage | undefined {
  const candidate = value.trim().toLowerCase() || "review";
  return ROUTING_STAGES.includes(candidate as RoutingStage) ? candidate as RoutingStage : undefined;
}

function roleForStage(stage: RoutingStage): RoleName {
  return ({
    define: "spec",
    plan: "planner",
    build: "coder",
    verify: "verifier",
    debug: "debugger",
    review: "reviewer",
    ship: "shipper",
    "fast-judge": "judge",
  } satisfies Record<RoutingStage, RoleName>)[stage];
}

function formatPreview(
  stage: RoutingStage,
  legacy: PiRoutingCandidate | undefined,
  decision: RoutingDecision,
): string {
  const lines = [
    `Capability routing preview — ${stage}`,
    `Legacy selection: ${legacy ? `${legacy.provider}/${legacy.model}` : "no eligible legacy candidate"}`,
    "Capability ranking:",
  ];
  if (decision.eligible.length === 0) lines.push("  (no eligible candidates)");
  decision.eligible.forEach((candidate, index) => {
    const components = candidate.scoreBreakdown.map((component) => `${component.name}=${component.value}`).join(", ");
    lines.push(`  ${index + 1}. ${candidate.identity.provider}/${candidate.identity.model} score=${candidate.score} thinking=${candidate.thinking}`);
    lines.push(`     ${components}; ${candidate.thinkingReason}`);
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
