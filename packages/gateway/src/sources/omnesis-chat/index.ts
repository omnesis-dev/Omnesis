// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public surface of the omnesis-chat built-in source. See `wiring.ts`
 * for the boot-time entry point.
 */

export {
  OMNESIS_CHAT_PROVIDER_ID,
  OMNESIS_CHAT_SOURCE_ID,
  OMNESIS_CHAT_LABEL,
  OMNESIS_CHAT_ACCENT_COLOR,
  OMNESIS_CHAT_BG_COLOR,
  seedOmnesisChatSourceMeta,
} from "./source-meta.js";
export {
  bootOmnesisChat,
  deleteOmnesisChatConversation,
  type OmnesisChatBootDeps,
  type OmnesisChatRuntime,
} from "./wiring.js";
export { retainOmnesisChatConversation, type OmnesisChatRetentionDeps } from "./wiring.js";
export {
  ConversationUpserter,
  DEFAULT_DEBOUNCE_MS,
  buildDocumentInput,
  type ConversationUpserterDeps,
} from "./upsert.js";
export { renderConversation, type RenderedConversation, type RenderedCitation } from "./render.js";
export {
  CONVERSATION_CITATION_LINK_TYPE,
  upsertConversationCitations,
  findConversationDocId,
  type ConversationCitationInput,
  type UpsertConversationCitationsResult,
} from "./citation-writer.js";
export { runConversationBackfill, BACKFILL_FLAG_KEY, type BackfillResult } from "./backfill.js";

export {
  ensureConversationMemoryEvidence,
  validateConversationAnnotationEvidence,
  type ConversationMemoryEvidence,
} from "./memory-evidence.js";
