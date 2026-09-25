// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/agent` — demo agent that runs inside the gateway, calls into the
 * corpus via tools, and streams typed events to the portal.
 *
 * Public surface:
 *   - `ChatBackend` + `AgentSession` — the orchestration layer.
 *   - `ReplayBackend` — deterministic playback from a `.jsonl` fixture, used
 *     for tests and the cost-free demo path.
 *   - Tool-handle + chat-message types reused by every backend.
 *
 * Higher-level backends (Anthropic, OpenAI-compatible) and the tool
 * implementations land in subsequent phases.
 */

export {
  AgentSession,
  type CancelCause,
  type SessionOptions,
  type SendOptions,
  type Subscriber,
} from "./session.js";

export {
  classifyAgentTurn,
  CONTEXT_WINDOW_EXCEEDED_MESSAGE,
  OUTPUT_TRUNCATED_MESSAGE,
  type AgentTurnOutcome,
} from "./turn-outcome.js";

export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  type ChatBackend,
  type ChatMessage,
  type AssistantPart,
  type ReportArtifactPart,
  type UserPart,
  type ReasoningBound,
  type LlmProbe,
  type LlmRequestTiming,
  type LlmRequestTracker,
  probeTurnEvents,
  startLlmRequest,
  type TurnInput,
  type ToolHandle,
  type ToolCaller,
  type ToolContext,
  UNATTRIBUTED_CALLER,
  wrapEvent,
} from "./backend.js";

export {
  ReplayBackend,
  RoutingReplayBackend,
  parseFixture,
  serializeFixture,
  type ReplayBackendOptions,
  type ReplayEntry,
  type ReplayFixture,
  type ReplayScenario,
  type RoutingReplayBackendOptions,
} from "./replay-backend.js";

export {
  AnthropicBackend,
  type AnthropicBackendOptions,
  type AnthropicClientLike,
} from "./anthropic-backend.js";

export { HttpChatBackend, type HttpChatBackendOptions } from "./http-backend.js";
export {
  modelReasoningRequestFields,
  preferredReasoningWireProtocol,
  supportsModelReasoningControl,
  type ReasoningWireProtocol,
} from "./model-reasoning-wire.js";
export { outputBudgetForSelectedReasoning } from "./http-output-budget.js";

export { agentFailureScope, type AgentFailureScope } from "./http-error.js";

export {
  OpenAIResponsesBackend,
  type OpenAIResponsesBackendOptions,
  convertHistoryToResponsesInput,
  convertToolsToResponses,
  parseResponsesSSE,
} from "./openai-responses-backend.js";

export { HttpAgentBackend, type HttpAgentBackendOptions } from "./http-agent-backend.js";

export {
  CodexAppServerBackend,
  CodexAppServerRuntime,
  MANAGED_CODEX_PACKAGE,
  MANAGED_CODEX_PACKAGE_VERSION,
  assertSupportedCodexRuntime,
  buildCodexEnv,
  convertToolsToCodexDynamicTools,
  ensureCodexHome,
  parseCodexCliVersion,
  renderCodexUserInput,
  resolveCodexRuntimeCommand,
  type CodexAppServerBackendOptions,
  type CodexAppServerRuntimeOptions,
  type CodexDynamicToolSpec,
  type CodexRuntimeCommandInfo,
  type CodexRuntimeProbe,
  type CodexRuntimeSource,
  type CodexRuntimeTurnOptions,
  type CodexTurnRunner,
} from "./codex-app-server-backend.js";

export {
  CODEX_RUNTIME_COMPAT,
  isSupportedCodexCliVersion,
  isTestedCodexCliVersion,
} from "./codex-compat.js";

export {
  CodexRuntimePool,
  reconcileMemberAuth,
  type CodexRuntimePoolOptions,
} from "./codex-runtime-pool.js";

export { zodToJsonSchema } from "./zod-to-json-schema.js";

export {
  CORPUS_CONTENT_IS_DATA,
  SUBJECT_ATTRIBUTION_REQUIRES_EVIDENCE,
  renderAnalyticsCatalog,
  renderAnalyticsRetrievalGuidance,
  renderCognitionRetrievalGuidance,
  renderReadOnlyRetrievalPlaybook,
  renderTemporalRetrievalGuidance,
  type ReadOnlyRetrievalPlaybookInput,
  type RetrievalCatalogColumn,
  type RetrievalCatalogTable,
} from "./instructions/read-only-retrieval.js";

// Tools — registry helpers + the built-in catalog.
export {
  buildBuiltinTools,
  findTool,
  selectNonCitationTools,
  selectSharedTools,
  selectGenericSubagentTools,
  selectSubagentTools,
  CITATION_TOOL_NAMES,
  GENERIC_SUBAGENT_TOOL_NAMES,
  type BuiltinToolsOptions,
} from "./tools/registry.js";
export {
  createSearchDocumentsTool,
  buildSearchDocumentsArgsSchema,
  searchDocumentsArgsSchema,
  type SearchDocumentsArgs,
  type SearchToolDeps,
} from "./tools/search.js";
export {
  createFetchDocumentTool,
  fetchDocumentArgsSchema,
  type FetchDocumentArgs,
  type FetchDocumentToolDeps,
} from "./tools/fetch-document.js";
export {
  createTraceConnectionsTool,
  traceConnectionsArgsSchema,
  type TraceConnectionsArgs,
  type TraceConnectionsToolDeps,
} from "./tools/trace-connections.js";
export {
  createRunSqlTool,
  runSqlArgsSchema,
  type RunSqlArgs,
  type RunSqlToolDeps,
} from "./tools/run-sql.js";
export {
  createLookupPeopleTool,
  lookupPeopleArgsSchema,
  LOOKUP_PEOPLE_MAX_LIMIT,
  type LookupPeopleArgs,
  type LookupPeopleToolDeps,
} from "./tools/lookup-people.js";
export {
  createLookupDocumentByUrlTool,
  lookupDocumentByUrlArgsSchema,
  type LookupDocumentByUrlArgs,
  type LookupDocumentByUrlToolDeps,
} from "./tools/lookup-document-by-url.js";
export {
  createAnnotateTool,
  annotateArgsSchema,
  type AnnotateArgs,
  type AnnotateToolDeps,
} from "./tools/annotate.js";
export {
  createCiteRecordTool,
  citeRecordArgsSchema,
  type CiteRecordArgs,
  type CiteRecordToolDeps,
} from "./tools/cite-record.js";
export {
  createPlanTool,
  planArgsSchema,
  PlanStore,
  type PlanArgs,
  type PlanToolDeps,
} from "./tools/plan.js";
export {
  createWatchCreateTool,
  createWatchUpdateTool,
  watchCreateArgsSchema,
  watchUpdateArgsSchema,
  type WatchCreateArgs,
  type WatchUpdateArgs,
  type WatchToolDeps,
} from "./tools/watch.js";
export {
  createSpawnSubagentTool,
  spawnSubagentArgsSchema,
  type SpawnSubagentArgs,
  type SpawnSubagentToolDeps,
} from "./tools/spawn-subagent.js";
export {
  createJoinSubagentsTool,
  joinSubagentsArgsSchema,
  type JoinSubagentsArgs,
  type JoinSubagentsToolDeps,
} from "./tools/join-subagents.js";

// Specialists — the named personas spawn_subagent drives (#748).
export {
  defineSpecialist,
  SpecialistRegistry,
  UnknownSpecialistError,
  BUILTIN_SPECIALISTS,
  researchPlannerSpecialist,
  historySweepSpecialist,
  sourceDigestSpecialist,
  citationVerifierSpecialist,
  createBuiltinSpecialistRegistry,
  verifyQuotes,
  type SpecialistDescriptor,
  type QuoteVerification,
  type QuoteVerificationReport,
} from "./specialists/index.js";
export {
  WatchPortError,
  SqlPortOverCapError,
  SqlPortNotPermittedError,
  RecordPortError,
  SubagentPortError,
  UnsupportedSearchFilterError,
} from "./tools/types.js";
export type {
  SearchPort,
  SearchPortInput,
  SearchPortFilters,
  SearchPortResult,
  DocumentPort,
  DocumentPortResult,
  DocumentByUrlPort,
  DocumentByUrlPortResult,
  PersonPort,
  PersonPortInput,
  PersonPortResult,
  TrailPort,
  TrailPortOptions,
  SqlPort,
  SqlPortResult,
  SqlPortSource,
  RecordPort,
  RecordCitationResolved,
  RecordCitationRejection,
  ToolPorts,
  WatchPort,
  WatchPortNotify,
  WatchPortResult,
  WatchPortEntry,
  WatchPortDetail,
  WatchPortProbe,
  WatchPortRejection,
  SubagentPort,
  SubagentPortInput,
  SubagentPortResult,
  SubagentSpawnHandle,
  SubagentJoinInput,
  SubagentJoinResult,
  LoopReadPort,
  LoopListPortResult,
  LoopSearchPortInput,
  LoopSearchPortResult,
  TemporalReadPort,
  EntityContextPort,
  EntityContextResult,
  EntityContextSeed,
  EntityContextSeedKind,
} from "./tools/types.js";
