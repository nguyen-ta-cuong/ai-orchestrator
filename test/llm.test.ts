import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";
import { completeRouted, completeWithRole } from "../mcp/llm.js";

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
    expect(result.fallbackHistory).toEqual([{ identity: "test/primary", reason: "LLM request failed (503)" }]);
    expect(JSON.stringify(result)).not.toContain(apiKey);
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
    expect(result.fallbackHistory).toEqual([{ identity: "test/primary", reason: "candidate output failed required schema validation" }]);
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
