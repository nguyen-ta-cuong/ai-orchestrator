import type { OrchestratorConfig, ThinkingLevel } from "../src/core/config.js";
import type { McpCompletionCandidate } from "./routing.js";

export type ModelRole = "planner" | "judge";

export interface CompletionRequest {
  config: OrchestratorConfig;
  role: ModelRole;
  prompt: string;
  signal?: AbortSignal;
}

export interface RoutedCompletionRequest extends CompletionRequest {
  candidates: readonly McpCompletionCandidate[];
  /** Reject candidate output before accepting it, allowing an eligible fallback. */
  validateText?: (text: string) => void;
}

export interface RoutedCompletionResult {
  text: string;
  selectedIndex: number;
  fallbackHistory: Array<{ identity: string; reason: string }>;
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MAX_LLM_RESPONSE_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_MAX_THINKING_MAX_TOKENS = 16384;
let fakeLlmWarningPrinted = false;

export async function completeWithRole({ config, role, prompt, signal }: CompletionRequest): Promise<string> {
  return (await completeRouted({ config, role, prompt, signal, candidates: [config.roles[role]] })).text;
}

export async function completeRouted({ config, role, prompt, signal, candidates, validateText }: RoutedCompletionRequest): Promise<RoutedCompletionResult> {
  const fallbackHistory: RoutedCompletionResult["fallbackHistory"] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const roleConfig = candidates[index]!;
    try {
      const text = await completeCandidate(config, role, roleConfig, prompt, signal);
      if (validateText) {
        try {
          validateText(text);
        } catch {
          throw new Error("Candidate output failed required schema validation");
        }
      }
      return { text, selectedIndex: index, fallbackHistory };
    } catch (error) {
      const reason = sanitizeError(error, Object.values(config.mcp.providers).flatMap((provider) => provider.apiKey ? [provider.apiKey] : []));
      fallbackHistory.push({ identity: `${roleConfig.provider}/${roleConfig.model}`, reason });
      if (signal?.aborted || index === candidates.length - 1) throw new Error(`All eligible MCP completion candidates failed: ${fallbackHistory.map((item) => `${item.identity}: ${item.reason}`).join("; ")}`);
    }
  }
  throw new Error("No MCP completion candidates were supplied");
}

async function completeCandidate(config: OrchestratorConfig, role: ModelRole, roleConfig: McpCompletionCandidate, prompt: string, signal?: AbortSignal): Promise<string> {
  const provider = config.mcp.providers[roleConfig.provider];
  if (!provider) {
    throw new Error(`No MCP provider configured for role ${role} provider ${roleConfig.provider}`);
  }
  if (!provider.apiKey) {
    throw new Error(`Missing API key for MCP provider ${roleConfig.provider}; set mcp.providers.${roleConfig.provider}.apiKey`);
  }
  const apiKey = provider.apiKey;

  if (process.env.AI_ORCH_FAKE_LLM === "1") {
    if (!fakeLlmWarningPrinted) {
      console.error("[ai-orchestrator-mcp] AI_ORCH_FAKE_LLM=1 is active; returning fake planner/judge responses.");
      fakeLlmWarningPrinted = true;
    }
    return fakeCompletion(role);
  }

  const text = await (async () => {
    switch (provider.api) {
      case "anthropic-messages":
        return anthropicMessages(provider.baseUrl, apiKey, roleConfig, prompt, signal);
      case "openai-responses":
        return openaiResponses(provider.baseUrl, apiKey, roleConfig, prompt, signal);
      case "openai-completions":
        return openaiCompletions(provider.baseUrl, apiKey, roleConfig, prompt, signal);
      default:
        throw new Error(`Unsupported MCP provider API for ${roleConfig.provider}: ${provider.api}`);
    }
  })();

  if (text.trim().length === 0) {
    throw new Error(`LLM provider ${roleConfig.provider} returned an empty completion for role ${role}`);
  }
  return text;
}

function sanitizeError(error: unknown, secrets: string[]): string {
  const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
  const httpStatus = /^LLM request failed \((\d+)/.exec(message)?.[1];
  if (httpStatus) return `LLM request failed (${httpStatus})`;
  if (message.startsWith("LLM response was not valid JSON")) return "LLM response was not valid JSON";
  if (message.startsWith("OpenAI response failed")) return "OpenAI response failed";
  if (message.startsWith("OpenAI response was incomplete")) return "OpenAI response was incomplete";
  if (message.startsWith("Candidate output failed")) return "candidate output failed required schema validation";
  if (message.includes("timed out")) return "LLM request timed out";
  if (message.includes("aborted by client")) return "LLM request aborted by client";
  if (message.includes("truncated") || message.includes("token limit")) return "LLM response was truncated";
  if (message.startsWith("No MCP provider configured")) return "MCP provider is not configured";
  if (message.startsWith("Missing API key")) return "MCP provider API key is missing";
  if (message.startsWith("Unsupported MCP provider API")) return "MCP provider API is unsupported";
  if (message.includes("returned an empty completion")) return "LLM provider returned an empty completion";
  if (message.includes("response exceeded")) return "LLM response exceeded the size limit";
  return "MCP candidate failed";
}

function fakeCompletion(role: ModelRole): string {
  if (role === "planner") {
    return [
      "1. Inspect the relevant files and existing tests.",
      "2. Implement the requested behavior with minimal, focused changes.",
      "3. Run the detected project tests and fix any failures.",
    ].join("\n");
  }
  const verdict = process.env.AI_ORCH_FAKE_LLM_VERDICT === "approve" ? "approve" : "reject";
  return JSON.stringify({
    verdict,
    reasons: `Fake judge ${verdict} for MCP protocol tests.`,
    ...(verdict === "reject" ? { requiredFixes: "Address the fake failing condition before retrying." } : {}),
  });
}

async function anthropicMessages(baseUrl: string, apiKey: string, role: McpCompletionCandidate, prompt: string, signal?: AbortSignal): Promise<string> {
  const json = await postJson(endpoint(baseUrl, "/messages"), {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, {
    model: role.model,
    max_tokens: completionTokenLimit(role, anthropicMaxTokens(role.thinking)),
    messages: [{ role: "user", content: prompt }],
    ...anthropicThinking(role.thinking, completionTokenLimit(role, anthropicMaxTokens(role.thinking))),
  }, signal, [apiKey]);
  const response = json as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  if (response.stop_reason === "max_tokens") {
    throw new Error("Anthropic response was truncated at max_tokens; increase token budget or reduce prompt size");
  }
  return (response.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n").trim();
}

async function openaiResponses(baseUrl: string, apiKey: string, role: McpCompletionCandidate, prompt: string, signal?: AbortSignal): Promise<string> {
  const json = await postJson(endpoint(baseUrl, "/responses"), {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, {
    model: role.model,
    input: prompt,
    max_output_tokens: completionTokenLimit(role, 8192),
    ...openaiResponsesReasoning(role.thinking),
  }, signal, [apiKey]);
  const response = json as {
    output_text?: string;
    status?: string;
    incomplete_details?: unknown;
    error?: unknown;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (response.status === "incomplete") {
    throw new Error(`OpenAI response was incomplete: ${redactSecrets(JSON.stringify(response.incomplete_details ?? {}), [apiKey])}`);
  }
  if (response.status === "failed") {
    throw new Error(`OpenAI response failed: ${redactSecrets(JSON.stringify(response.error ?? {}), [apiKey])}`);
  }
  if (typeof response.output_text === "string") {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => (part.type === "output_text" ? part.text ?? "" : ""))
    .join("\n")
    .trim();
}

async function openaiCompletions(baseUrl: string, apiKey: string, role: McpCompletionCandidate, prompt: string, signal?: AbortSignal): Promise<string> {
  const reasoning = openaiCompletionsReasoning(role.thinking);
  const json = await postJson(endpoint(baseUrl, "/chat/completions"), {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, {
    model: role.model,
    messages: [{ role: "user", content: prompt }],
    ...(reasoning.reasoning_effort
      ? { max_completion_tokens: completionTokenLimit(role, 8192), ...reasoning }
      : { max_tokens: completionTokenLimit(role, 4096), temperature: 0 }),
  }, signal, [apiKey]);
  const choice = (json as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> }).choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("OpenAI chat completion was truncated at the token limit");
  }
  return choice?.message?.content?.trim() ?? "";
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  secrets: string[] = [],
): Promise<unknown> {
  const timeout = withTimeout(signal, DEFAULT_LLM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout.signal, redirect: "error" });
    const text = await readBoundedResponseText(response);
    if (!response.ok) {
      throw new Error(
        `LLM request failed (${response.status} ${response.statusText}): ${redactSecrets(text, secrets).slice(0, 1000)}`,
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`LLM response was not valid JSON: ${redactSecrets(text, secrets).slice(0, 1000)}`);
    }
  } catch (error) {
    if (timeout.timedOut()) {
      throw new Error(`LLM request timed out after ${DEFAULT_LLM_TIMEOUT_MS}ms`);
    }
    if (signal?.aborted) {
      throw new Error("LLM request aborted by client");
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LLM_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`LLM response exceeded ${MAX_LLM_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_LLM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`LLM response exceeded ${MAX_LLM_RESPONSE_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromCaller = (): void => controller.abort();
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
    timedOut: () => didTimeOut,
  };
}

function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url.toString();
}

function openaiResponsesReasoning(thinking: ThinkingLevel): Record<string, unknown> {
  const effort = openaiEffort(thinking);
  return effort ? { reasoning: { effort } } : {};
}

function openaiCompletionsReasoning(thinking: ThinkingLevel): Record<string, unknown> {
  const effort = openaiEffort(thinking);
  return effort ? { reasoning_effort: effort } : {};
}

function openaiEffort(thinking: ThinkingLevel): "minimal" | "low" | "medium" | "high" | undefined {
  if (thinking === "off") {
    return undefined;
  }
  return thinking === "minimal" ? "minimal" : thinking === "low" ? "low" : thinking === "medium" ? "medium" : "high";
}

function anthropicThinking(thinking: ThinkingLevel, maxTokens: number): Record<string, unknown> {
  if (thinking === "off" || thinking === "minimal" || thinking === "low") {
    return {};
  }
  const budgetByLevel: Record<ThinkingLevel, number> = {
    off: 0,
    minimal: 0,
    low: 0,
    medium: 1024,
    high: 2048,
    xhigh: 4096,
    max: 8192,
  };
  return { thinking: { type: "enabled", budget_tokens: Math.min(budgetByLevel[thinking], Math.max(1, maxTokens - 1)) } };
}

function completionTokenLimit(role: McpCompletionCandidate, apiLimit: number): number {
  return Math.max(1, Math.min(role.maxOutputTokens ?? apiLimit, role.requestedOutputTokens ?? apiLimit, apiLimit));
}

function anthropicMaxTokens(thinking: ThinkingLevel): number {
  return thinking === "max" ? ANTHROPIC_MAX_THINKING_MAX_TOKENS : ANTHROPIC_DEFAULT_MAX_TOKENS;
}
