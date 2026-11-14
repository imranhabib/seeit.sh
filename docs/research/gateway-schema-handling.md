# Provider schemas and gateway handling

Checked 2026-11-13. Primary sources only. This note separates public API definitions from harness-specific traffic and separates translation from transparent forwarding.

## Available schema baselines

OpenAI publishes an [OpenAPI specification](https://github.com/openai/openai-openapi) for its public API. The official TypeScript SDK also defines response objects and the `ResponseStreamEvent` union in [responses.ts](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts). These are useful starting points for documented public requests, responses, and stream events; they do not establish a complete contract for every subscription backend or harness version.

Anthropic's official SDK defines stable Messages shapes in [messages.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) and beta shapes in [beta/messages.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/messages/messages.ts). Its [streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming) explicitly says new event types may be added and clients should handle unknown events gracefully. A closed union in today's SDK is therefore a versioned baseline, not a promise that the wire format cannot grow.

Codex's own source is useful for the client side of its protocol. Its [Responses SSE parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs) uses optional JSON values in `ResponsesStreamEvent` and defines completion usage fields including `cached_tokens`, `cache_write_tokens`, and `codex_rollout_budget_units`. [protocol models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs) define `ResponseItem`. Inspect the tag matching the installed harness: current `main` is not proof of what an older client sends, and client source is not an exhaustive server contract.

## LiteLLM: translation and passthrough coexist

LiteLLM documents distinct [translated, native, and passthrough paths](https://docs.litellm.ai/docs/supported_endpoints). Translation maps formats across providers; passthrough calls one provider's own API. This distinction matters more than the product name when assessing compatibility.

For normalized chat calls, LiteLLM [maps provider stop reasons to OpenAI-compatible values](https://docs.litellm.ai/docs/completion/output), preserving a differing native reason in `provider_specific_fields.native_finish_reason`. Its [input rules](https://docs.litellm.ai/docs/completion/input) reject unsupported OpenAI parameters by default, optionally drop them with `drop_params`, and treat other parameters as provider-specific request-body arguments. This request behavior does not prove arbitrary response fields survive every translator.

An explicit evolution example: the [native Responses passthrough documentation](https://docs.litellm.ai/docs/response_api_native_passthrough) explains that bridging Responses through Chat Completions can approximate or drop Responses-only request fields; opting into the backend's native endpoint avoids that translation.

The inspected [passthrough stream handler](https://github.com/BerriAI/litellm/blob/f5ef14308bf7582af365aabae1ea0ff1b0c626df/litellm/proxy/pass_through_endpoints/streaming_handler.py#L223) collects `aiter_bytes()` chunks for logging and yields the same chunks when cost injection is inactive. **Inference:** unknown response fields and SSE events survive this branch because it does not reconstruct them. Cost injection takes another branch that parses complete SSE frames and rewrites output, so this is not a universal byte-preservation guarantee. A checked-in [integration test](https://github.com/BerriAI/litellm/blob/f5ef14308bf7582af365aabae1ea0ff1b0c626df/tests/integration/observability/test_anthropic_overloaded_failure_signals.py#L385) verifies an upstream error body survives a native Anthropic stream after a keepalive opens it. I did not run that test or verify a dedicated arbitrary-unknown-event test.

## Helicone: a transparent response path

Helicone also has translation code, so the claim here is limited to its inspected provider proxy path. [handleProxyRequest](https://github.com/Helicone/helicone/blob/cfddabd090807e435fa02ea1a62c4fe333b6278a/worker/src/lib/HeliconeProxyRequest/ProxyRequestHandler.ts#L103) wraps the provider response in `ReadableInterceptor`, returns that stream to the caller, and exposes a completed body separately for logging. Its [interceptor](https://github.com/Helicone/helicone/blob/cfddabd090807e435fa02ea1a62c4fe333b6278a/worker/src/lib/util/ReadableInterceptor.ts#L37) enqueues each original chunk and separately decodes a copy into a log array; it does not validate each JSON field before forwarding. **Inference:** new JSON fields and unknown SSE event types remain in this response stream without needing a complete schema. This is an inline interceptor, not a `body.tee()` implementation. An optional `streamForceFormat` flag changes chunk grouping. No universal guarantee for all Helicone gateway modes, parser accuracy, or unknown-event tests was established.

## Implication for seeit.sh

Use official schemas and matching harness source to understand expected fields. Keep transport forwarding independent from schema interpretation. Extract only the runtime fields needed for usage and attribution, tolerate unrelated fields/events, and preserve raw traffic on the existing recording branch. A new field can pass through correctly while the accounting parser still needs an update; forwarding compatibility and accounting completeness need separate checks.

Use small synthetic tests for usage variants, missing fields, unknown events, and odd chunk boundaries, plus redacted recordings for observed harness behavior and regressions. Treat unavailable usage as unknown rather than silently asserting zero. These are recommendations, not claims that an inspected gateway implements every one of them. No implementation changes were made for this research.
