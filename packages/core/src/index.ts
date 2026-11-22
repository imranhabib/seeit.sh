// The public interface of @seeit/core. Provider-specific code lives in
// provider/anthropic/ and provider/openai/; shared types in provider/model.ts.

export { createSseParser, type SseEvent } from "./sse.ts";
export { decideCompletion, type Completion } from "./completion.ts";
export { FIXTURE_FOR_VERSION, hasFixture } from "./tested-versions.ts";
export { analyzeCall, type AnalyzedCall, type CallFields, type RecordedCall } from "./call.ts";
export { callFlags, type Flag } from "./flags.ts";
export { hashPiece, rebuildRequest, requestPieces } from "./pieces.ts";
export {
  CONTEXT_ANALYSIS_VERSION,
  type CallDetails,
  type CallRecords,
  type ContextCategory,
  type ContextPart,
  type ModelCatalogEntry,
  type QuotaWindow,
  type RequestPiece,
  type ToolResult,
  type ToolUse,
  type ToolUseKind,
} from "./records.ts";
export { interpretResponse, type CapturedResponse } from "./response.ts";
export { PROVIDER_FOR, createInterpreter, quotaHeaders, readRequest, usageFromJsonBody } from "./provider/index.ts";
export {
  estimateTokens,
  type CallKind,
  type ContextShape,
  type Harness,
  type Provider,
  type RequestInfo,
  type StreamInterpreter,
  type StreamSummary,
  type Usage,
} from "./provider/model.ts";
export { resendsTurnStart } from "./provider/anthropic/request.ts";
export { fromAnthropicUsage } from "./provider/anthropic/usage.ts";
export { fromOpenAIUsage } from "./provider/openai/usage.ts";
