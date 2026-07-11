import type { OrchestratorConfig, RoleConfig, ThinkingLevel } from "../src/core/config.js";

export type ModelRole = "planner" | "judge";

export interface CompletionRequest {
  config: OrchestratorConfig;
  role: ModelRole;
  prompt: string;
  signal?: AbortSignal;
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000;
let fakeLlmWarningPrinted = false;

export async function completeWithRole({ config, role, prompt, signal }: CompletionRequest): Promise<string> {
  const roleConfig = config.roles[role];
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

async function anthropicMessages(baseUrl: string, apiKey: string, role: RoleConfig, prompt: string, signal?: AbortSignal): Promise<string> {
  const json = await postJson(endpoint(baseUrl, "/messages"), {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, {
    model: role.model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
    ...anthropicThinking(role.thinking),
  }, signal, [apiKey]);
  const response = json as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  if (response.stop_reason === "max_tokens") {
    throw new Error("Anthropic response was truncated at max_tokens; increase token budget or reduce prompt size");
  }
  return (response.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n").trim();
}

async function openaiResponses(baseUrl: string, apiKey: string, role: RoleConfig, prompt: string, signal?: AbortSignal): Promise<string> {
  const json = await postJson(endpoint(baseUrl, "/responses"), {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, {
    model: role.model,
    input: prompt,
    max_output_tokens: 8192,
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

async function openaiCompletions(baseUrl: string, apiKey: string, role: RoleConfig, prompt: string, signal?: AbortSignal): Promise<string> {
  const reasoning = openaiCompletionsReasoning(role.thinking);
  const json = await postJson(endpoint(baseUrl, "/chat/completions"), {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, {
    model: role.model,
    messages: [{ role: "user", content: prompt }],
    ...(reasoning.reasoning_effort ? { max_completion_tokens: 8192, ...reasoning } : { max_tokens: 4096, temperature: 0 }),
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
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout.signal });
    const text = await response.text();
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

function anthropicThinking(thinking: ThinkingLevel): Record<string, unknown> {
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
  return { thinking: { type: "enabled", budget_tokens: budgetByLevel[thinking] } };
}
