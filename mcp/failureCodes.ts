export const MCP_PROVIDER_FAILURE_CODES = [
  "http_error",
  "invalid_json",
  "provider_response_failed",
  "schema_validation_failed",
  "timeout",
  "aborted",
  "truncated",
  "provider_unconfigured",
  "missing_api_key",
  "unsupported_api",
  "empty_response",
  "response_too_large",
  "provider_failed",
] as const;

export type McpProviderFailureCode = typeof MCP_PROVIDER_FAILURE_CODES[number];

/** Collapse arbitrary provider/error text to a closed, persistence-safe code. */
export function classifyMcpProviderFailure(value: unknown): McpProviderFailureCode {
  const message = value instanceof Error ? value.message : String(value);
  if ((MCP_PROVIDER_FAILURE_CODES as readonly string[]).includes(message)) {
    return message as McpProviderFailureCode;
  }
  if (/LLM request failed \(\d+/i.test(message)) return "http_error";
  if (/not valid JSON/i.test(message)) return "invalid_json";
  if (/OpenAI response failed|OpenAI response was incomplete/i.test(message)) return "provider_response_failed";
  if (/schema validation|standalone JSON object|required JSON shape/i.test(message)) return "schema_validation_failed";
  if (/timed out/i.test(message)) return "timeout";
  if (/aborted/i.test(message)) return "aborted";
  if (/truncated|token limit/i.test(message)) return "truncated";
  if (/No MCP provider configured/i.test(message)) return "provider_unconfigured";
  if (/Missing API key/i.test(message)) return "missing_api_key";
  if (/Unsupported MCP provider API/i.test(message)) return "unsupported_api";
  if (/empty completion/i.test(message)) return "empty_response";
  if (/response exceeded/i.test(message)) return "response_too_large";
  return "provider_failed";
}
