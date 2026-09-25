// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/protocol` — WebSocket envelope + typed message registry.
 *
 * Re-exports the discriminated WS envelope (request/response/event) and
 * the per-type registry that producers and consumers consult for
 * compile-time inference and zod-backed runtime validation. Importing
 * from this subpath signals the consumer is on the wire-protocol
 * surface, not the internal helpers.
 *
 * Stable contract surface — every change here is a protocol-version
 * concern (see `PROTOCOL_VERSION`).
 */

// WS envelope — discriminated request/response/event with type guards
// and payload constructors.
export {
  WsCorrelationId,
  newCorrelationId,
  isWsCommand,
  isWsResponse,
  isWsEvent,
  isWsEnvelope,
  makeCommand,
  makeResponseOk,
  makeResponseErr,
  makeEvent,
} from "../ws-protocol.js";

export type {
  WsCommand,
  WsResponse,
  WsResponseOk,
  WsResponseErr,
  WsEvent,
  WsEnvelope,
} from "../ws-protocol.js";

// Typed registry of every known command + event payload schema.
// `parseRequestPayload` / `parseResponsePayload` / `parseEventPayload`
// surface zod-backed runtime validation for cross-process boundaries.
export {
  WS_AUTH_PROTOCOL_PREFIX,
  websocketAuthProtocol,
  parseWebSocketAuthProtocolHeader,
} from "../ws-auth.js";

export {
  PROTOCOL_VERSION,
  wsCommandSchemas,
  wsEventSchemas,
  isKnownCommandType,
  isKnownEventType,
  parseRequestPayload,
  parseResponsePayload,
  parseEventPayload,
} from "../ws-messages.js";

export type {
  WsCommandRegistry,
  WsCommandType,
  WsEventRegistry,
  WsEventType,
  WsRequestPayload,
  WsResponsePayload,
  WsEventPayload,
} from "../ws-messages.js";

// Agent-harness protocol — typed parts the demo agent streams to the portal
// (and, later, iOS) so the renderer can paint source-shaped cards, working
// sets, and provenance trails without parsing markdown.
export {
  KNOWN_AGENT_ERROR_CODES,
  docBodySchema,
  docRefSchema,
  personSummarySchema,
  toolResultSchema,
  chatMessageSchema,
  agentSessionCreateRequest,
  agentSessionCreateResponse,
  agentMessageSendRequest,
  agentMessageSendResponse,
  agentSessionCancelRequest,
  agentSessionCancelResponse,
  agentMessageStartEvent,
  agentTextDeltaEvent,
  agentThinkingDeltaEvent,
  agentToolStartEvent,
  agentToolResultEvent,
  agentCitationEvent,
  agentCitationsUpdateEvent,
  agentSubagentSpawnedEvent,
  agentSubagentEventEvent,
  agentSubagentResultEvent,
  agentMessageEndEvent,
  agentErrorEvent,
} from "../agent-protocol.js";

export type {
  KnownAgentErrorCode,
  DocBody,
  DocRef,
  PersonSummary,
  ToolResult,
  ChatMessageWire,
  AgentSessionCreateRequest,
  AgentSessionCreateResponse,
  AgentMessageSendRequest,
  AgentMessageSendResponse,
  AgentSessionCancelRequest,
  AgentSessionCancelResponse,
  AgentMessageStartEvent,
  AgentTextDeltaEvent,
  AgentThinkingDeltaEvent,
  AgentToolStartEvent,
  AgentToolResultEvent,
  AgentCitationEvent,
  AgentCitationsUpdateEvent,
  AgentSubagentSpawnedEvent,
  AgentSubagentEventEvent,
  AgentSubagentResultEvent,
  AgentMessageEndEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentEventType,
  Citation,
} from "../agent-protocol.js";
