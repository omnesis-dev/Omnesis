// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pushed agent-conversation sources — the server half of the plugin transport.
 * A harness-side plugin (OpenClaw / Hermes) reads its own durable transcript
 * and POSTs raw turns to `POST /agent-messages`; this module's ledger +
 * day projector render them into corpus documents via the same shared
 * renderer the collector-hosted reader sources use, so the two transports are
 * interchangeable.
 */

export { createAgentMessagesTables } from "./storage.js";
export {
  bootAgentConversations,
  type AgentConversationsRuntime,
  type AgentConversationsBootDeps,
  type PushMessageInput,
} from "./wiring.js";
export type { AgentMessageRow, Bucket } from "./storage.js";
export { isKnownHarness, KNOWN_HARNESSES } from "./meta.js";
