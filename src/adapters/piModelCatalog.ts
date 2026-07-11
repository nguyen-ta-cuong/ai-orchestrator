import type { DiscoveredModel, ModelCost } from "../core/modelRouting.js";
import type { ThinkingLevel } from "../core/config.js";

export interface PiModelLike {
  provider: unknown;
  id: unknown;
  name?: unknown;
  api?: unknown;
  reasoning?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  cost?: unknown;
  thinkingLevelMap?: unknown;
  [key: string]: unknown;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizePiModelCatalog(models: readonly PiModelLike[]): DiscoveredModel[] {
  return models.filter(hasValidIdentity).map(normalizePiModel);
}

function normalizePiModel(model: PiModelLike): DiscoveredModel {
  const reasoning = model.reasoning === true;
  const normalized: DiscoveredModel = {
    provider: String(model.provider),
    model: String(model.id),
    ...(typeof model.name === "string" && model.name.length > 0 ? { displayName: model.name } : {}),
    ...(typeof model.api === "string" && model.api.length > 0 ? { api: model.api } : {}),
    callable: true,
    reasoning,
    supportedThinking: supportedThinkingLevels(reasoning, model.thinkingLevelMap),
    input: normalizeInput(model.input),
    contextWindow: nonNegativeInteger(model.contextWindow),
    maxOutputTokens: nonNegativeInteger(model.maxTokens),
  };
  const cost = normalizeCost(model.cost);
  return cost ? { ...normalized, cost } : normalized;
}

function supportedThinkingLevels(reasoning: boolean, value: unknown): ThinkingLevel[] {
  if (!reasoning) return ["off"];
  if (!isPlainObject(value)) return ["off", "minimal", "low", "medium", "high"];
  return THINKING_LEVELS.filter((level) => {
    if (Object.hasOwn(value, level)) return typeof value[level] === "string";
    return level !== "xhigh" && level !== "max";
  });
}

function normalizeInput(value: unknown): ("text" | "image")[] {
  if (!Array.isArray(value)) return ["text"];
  const result = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
  return [...new Set(result.length > 0 ? result : ["text"] as const)];
}

function normalizeCost(value: unknown): ModelCost | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!fields.every((field) => isNonNegativeNumber(value[field]))) return undefined;
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
  };
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidIdentity(model: PiModelLike): boolean {
  return typeof model.provider === "string" && model.provider.trim().length > 0
    && typeof model.id === "string" && model.id.trim().length > 0;
}
