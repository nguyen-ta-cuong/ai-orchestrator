/** Failures that prove the provider did not produce an accepted result. */
export const MCP_PROVIDER_DEFINITE_FAILURE_CODES = [
  "http_error",
  "invalid_json",
  "provider_response_failed",
  "schema_validation_failed",
  "truncated",
  "provider_unconfigured",
  "missing_api_key",
  "unsupported_api",
  "empty_response",
  "response_too_large",
] as const;

/**
 * Post-dispatch failures where the provider may have accepted or completed the
 * request. Retrying these would risk duplicate paid work.
 */
export const MCP_PROVIDER_UNCERTAIN_FAILURE_CODES = [
  "timeout",
  "aborted",
  "provider_failed",
] as const;

export const MCP_PROVIDER_FAILURE_CODES = [
  ...MCP_PROVIDER_DEFINITE_FAILURE_CODES,
  ...MCP_PROVIDER_UNCERTAIN_FAILURE_CODES,
] as const;

export type McpProviderFailureCode = typeof MCP_PROVIDER_FAILURE_CODES[number];
export type McpProviderDefiniteFailureCode = typeof MCP_PROVIDER_DEFINITE_FAILURE_CODES[number];
export type McpProviderUncertainFailureCode = typeof MCP_PROVIDER_UNCERTAIN_FAILURE_CODES[number];

export function isUncertainMcpProviderFailure(
  code: McpProviderFailureCode,
): code is McpProviderUncertainFailureCode {
  return (MCP_PROVIDER_UNCERTAIN_FAILURE_CODES as readonly McpProviderFailureCode[]).includes(code);
}

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
  if (/No MCP provider configured|MCP provider is not configured/i.test(message)) return "provider_unconfigured";
  if (/Missing API key|API key is missing/i.test(message)) return "missing_api_key";
  if (/Unsupported MCP provider API|MCP provider API is unsupported/i.test(message)) return "unsupported_api";
  if (/empty completion/i.test(message)) return "empty_response";
  if (/response exceeded/i.test(message)) return "response_too_large";
  return "provider_failed";
}
