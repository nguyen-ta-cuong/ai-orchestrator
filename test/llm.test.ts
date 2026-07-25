import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";
import { classifyMcpProviderFailure, isUncertainMcpProviderFailure } from "../mcp/failureCodes.js";
import { completeRouted, completeWithRole, providerRequestReference } from "../mcp/llm.js";

const apiKey = "test-secret-key";

function configFor(api: string): OrchestratorConfig {
  return {
    ...DEFAULT_CONFIG,
    roles: {
      ...DEFAULT_CONFIG.roles,
      planner: { provider: "test", model: "test-model", thinking: "off" },
      judge: { provider: "test", model: "test-model", thinking: "off" },
    },
    mcp: {
      providers: {
        test: { baseUrl: "https://provider.example/v1", api, apiKey },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("completeWithRole", () => {
  it("derives stable provider request references from every paid-request input", () => {
    const config = configFor("openai-responses");
    const candidate = {
      provider: "test",
      model: "test-model",
      family: "family-a",
      thinking: "high" as const,
      requestedOutputTokens: 4_096,
      maxOutputTokens: 8_192,
    };
    const reference = providerRequestReference(config, "planner", "same prompt", candidate, 1);

    expect(reference).toMatch(/^[a-f0-9]{64}$/);
    expect(providerRequestReference(structuredClone(config), "planner", "same prompt", structuredClone(candidate), 1))
      .toBe(reference);
    for (const different of [
      providerRequestReference(config, "judge", "same prompt", candidate, 1),
      providerRequestReference(config, "planner", "different prompt", candidate, 1),
      providerRequestReference(config, "planner", "same prompt", { ...candidate, model: "other-model" }, 1),
      providerRequestReference(config, "planner", "same prompt", { ...candidate, thinking: "low" }, 1),
      providerRequestReference(config, "planner", "same prompt", { ...candidate, requestedOutputTokens: 2_048 }, 1),
      providerRequestReference(config, "planner", "same prompt", { ...candidate, maxOutputTokens: 4_096 }, 1),
      providerRequestReference(config, "planner", "same prompt", candidate, 2),
    ]) {
      expect(different).not.toBe(reference);
    }
    expect(reference).not.toContain("same prompt");
  });

  it("warns on stderr when fake LLM mode is active after provider config validates", async () => {
    vi.stubEnv("AI_ORCH_FAKE_LLM", "1");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(completeWithRole({ config: configFor("anthropic-messages"), role: "planner", prompt: "plan" })).resolves.toContain("Inspect");

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("AI_ORCH_FAKE_LLM=1 is active"));
  });

  it("does not let fake LLM mode bypass provider API key validation", async () => {
    vi.stubEnv("AI_ORCH_FAKE_LLM", "1");
    const config = configFor("anthropic-messages");
    delete config.mcp.providers.test.apiKey;

    await expect(completeWithRole({ config, role: "planner", prompt: "plan" })).rejects.toThrow(/MCP provider API key is missing/);
  });

  it("keeps sanitized pre-dispatch configuration failures definitive", () => {
    for (const [message, expected] of [
      ["MCP provider is not configured", "provider_unconfigured"],
      ["MCP provider API key is missing", "missing_api_key"],
      ["MCP provider API is unsupported", "unsupported_api"],
    ] as const) {
      const code = classifyMcpProviderFailure(message);
      expect(code).toBe(expected);
      expect(isUncertainMcpProviderFailure(code)).toBe(false);
    }
  });

  it("redacts provider secrets from non-200 error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`echo Authorization: Bearer ${apiKey}`, {
      status: 401,
      statusText: "Unauthorized",
    })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/LLM request failed \(401\)/);
    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.not.toThrow(apiKey);
  });

  it("redacts provider secrets from invalid JSON response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`not json Bearer ${apiKey}`, { status: 200 })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/LLM response was not valid JSON/);
    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.not.toThrow(apiKey);
  });

  it("rejects oversized provider responses before buffering their body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(3 * 1024 * 1024) },
    })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/response exceeded the size limit/);
  });

  it("handles OpenAI Responses failed status explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "failed",
      error: { message: "model refused" },
    })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/OpenAI response failed/);
  });

  it("filters OpenAI Responses content parts to output_text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      output: [
        { content: [{ type: "reasoning", text: "hidden" }, { type: "output_text", text: "visible" }] },
      ],
    })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .resolves.toBe("visible");
  });

  it("classifies caller abort separately from timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      controller.abort();
    })));

    await expect(completeWithRole({
      config: configFor("anthropic-messages"),
      role: "planner",
      prompt: "plan",
      signal: controller.signal,
    })).rejects.toThrow("LLM request aborted by client");
  });

  it("falls back across eligible provider candidates and redacts secrets from history", async () => {
    const config = configFor("openai-responses");
    config.mcp.providers.backup = { baseUrl: "https://backup.example/v1", api: "openai-responses", apiKey: "backup-secret" };
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).includes("provider.example")
      ? new Response(`failure ${apiKey}`, { status: 503, statusText: "Unavailable" })
      : Response.json({ output_text: "backup result" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeRouted({
      config,
      role: "planner",
      prompt: "plan",
      candidates: [
        { provider: "test", model: "primary", thinking: "off" },
        { provider: "backup", model: "secondary", thinking: "off" },
      ],
    });

    expect(result.text).toBe("backup result");
    expect(result.selectedIndex).toBe(1);
    expect(result.fallbackHistory).toEqual([{ identity: "test/primary", reason: "http_error" }]);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("records an ambiguous transport loss as unknown and does not call a fallback", async () => {
    const config = configFor("openai-responses");
    config.mcp.providers.backup = { baseUrl: "https://backup.example/v1", api: "openai-responses", apiKey: "backup-secret" };
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed after request dispatch");
    });
    const afterAttempt = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeRouted({
      config,
      role: "planner",
      prompt: "plan",
      candidates: [
        { provider: "test", model: "primary", thinking: "off" },
        { provider: "backup", model: "secondary", thinking: "off" },
      ],
      afterAttempt,
    })).rejects.toThrow(/outcome.*uncertain/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(afterAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      outcome: "unknown",
      failureCode: "provider_failed",
    }));
  });

  it("checkpoints each candidate before its network call and does not start an unreserved fallback", async () => {
    const config = configFor("openai-responses");
    config.mcp.providers.backup = { baseUrl: "https://backup.example/v1", api: "openai-responses", apiKey: "backup-secret" };
    const fetchMock = vi.fn(async () => new Response("failed", { status: 503, statusText: "Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    let remaining = 1;

    await expect(completeRouted({
      config,
      role: "planner",
      prompt: "plan",
      candidates: [
        { provider: "test", model: "primary", thinking: "off", estimatedCostUsd: 0.1 },
        { provider: "backup", model: "secondary", thinking: "off", estimatedCostUsd: 0.2 },
      ],
      beforeAttempt: async (attempt) => {
        events.push(`before:${attempt.identity.provider}/${attempt.identity.model}`);
        if (remaining === 0) throw new Error("provider budget exhausted");
        remaining -= 1;
      },
      afterAttempt: async (result) => {
        events.push(`after:${result.identity.provider}/${result.identity.model}:${result.outcome}`);
      },
    })).rejects.toThrow("provider budget exhausted");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "before:test/primary",
      "after:test/primary:failed",
      "before:backup/secondary",
    ]);
  });

  it("falls back when a candidate fails structured-output validation", async () => {
    const config = configFor("openai-responses");
    config.mcp.providers.backup = { baseUrl: "https://backup.example/v1", api: "openai-responses", apiKey: "backup-secret" };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => Response.json({
      output_text: String(url).includes("provider.example") ? "not-json" : '{"verdict":"approve","reasons":"ok"}',
    })));

    const result = await completeRouted({
      config,
      role: "judge",
      prompt: "judge",
      candidates: [
        { provider: "test", model: "primary", thinking: "off" },
        { provider: "backup", model: "secondary", thinking: "off" },
      ],
      validateText: (text) => { JSON.parse(text); },
    });

    expect(result.selectedIndex).toBe(1);
    expect(result.fallbackHistory).toEqual([{ identity: "test/primary", reason: "schema_validation_failed" }]);
  });

  it("caps provider output tokens to the trusted catalog entry", async () => {
    const config = configFor("openai-responses");
    const fetchMock = vi.fn(async () => Response.json({ output_text: "planned" }));
    vi.stubGlobal("fetch", fetchMock);

    await completeRouted({
      config,
      role: "planner",
      prompt: "plan",
      candidates: [{ provider: "test", model: "small", thinking: "off", maxOutputTokens: 3_000 }],
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ max_output_tokens: 3_000 });
    expect(request.redirect).toBe("error");
  });

  it("preserves requested visible output alongside Anthropic thinking", async () => {
    const config = configFor("anthropic-messages");
    const fetchMock = vi.fn(async () => Response.json({ content: [{ type: "text", text: "planned" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await completeRouted({
      config,
      role: "planner",
      prompt: "plan",
      candidates: [{
        provider: "test", model: "reasoner", thinking: "xhigh",
        maxOutputTokens: 8_192, requestedOutputTokens: 4_096,
      }],
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { max_tokens: number; thinking: { budget_tokens: number } };
    expect(body).toMatchObject({ max_tokens: 8_192, thinking: { budget_tokens: 4_096 } });
    expect(body.max_tokens - body.thinking.budget_tokens).toBe(4_096);
  });

  it("keeps Anthropic max thinking below max_tokens", async () => {
    const config = configFor("anthropic-messages");
    config.roles.planner.thinking = "max";
    const fetchMock = vi.fn(async () => Response.json({
      content: [{ type: "text", text: "planned" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithRole({ config, role: "planner", prompt: "plan" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      max_tokens: number;
      thinking: { budget_tokens: number };
    };
    expect(body.thinking.budget_tokens).toBe(8192);
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });
});
