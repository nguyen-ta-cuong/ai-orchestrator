import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";
import { completeWithRole } from "../mcp/llm.js";

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

    await expect(completeWithRole({ config, role: "planner", prompt: "plan" })).rejects.toThrow(/Missing API key/);
  });

  it("redacts provider secrets from non-200 error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`echo Authorization: Bearer ${apiKey}`, {
      status: 401,
      statusText: "Unauthorized",
    })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/Bearer \[redacted\]/);
    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.not.toThrow(apiKey);
  });

  it("redacts provider secrets from invalid JSON response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`not json Bearer ${apiKey}`, { status: 200 })));

    await expect(completeWithRole({ config: configFor("openai-responses"), role: "planner", prompt: "plan" }))
      .rejects.toThrow(/Bearer \[redacted\]/);
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
});
