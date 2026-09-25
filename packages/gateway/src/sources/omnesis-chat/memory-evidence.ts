// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Conversation evidence keeps the existing document/quote contract, while
 * authenticating the quoted speaker against the canonical durable transcript.
 * Rendered speaker labels are presentation, never authority: an assistant can
 * quote or reproduce those labels in its own answer. */

import { containsNormalized } from "../../brain/quote-match.js";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./ids.js";
import { buildDocumentInput, type ConversationUpserter } from "./upsert.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type Database from "better-sqlite3";

export interface ConversationMemoryEvidence {
  documentId: string;
  userMessages: string[];
  truncated: boolean;
}

/** Bound tool-result context without changing the canonical evidence record. */
export const CONVERSATION_EVIDENCE_MAX_CHARACTERS = 8_000;
export const CONVERSATION_EVIDENCE_MAX_MESSAGES = 8;

interface EvidenceDeps {
  readDb: Database.Database;
  loadConversation: (id: string) => Promise<ConversationRecord | null>;
}

/** User-role tool results and the machine-generated seed prefix are excluded. */
export function conversationUserMessages(record: ConversationRecord): string[] {
  if (record.originUnrecognized) return [];
  const start = record.origin?.seedMessageCount ?? 0;
  if (record.origin && (!Number.isSafeInteger(start) || start <= 0)) return [];
  return record.messages
    .slice(start)
    .flatMap((message) =>
      message.role === "user"
        ? message.parts.flatMap((part) =>
            part.kind === "text" && part.text.trim() ? [part.text.trim()] : [],
          )
        : [],
    );
}

/** Newest exact excerpts, returned in conversation order. No synthetic text is
 * inserted into an excerpt: each remains a quotable span of the actual user. */
export function boundedConversationUserMessages(userMessages: readonly string[]): {
  userMessages: string[];
  truncated: boolean;
} {
  const excerpts: string[] = [];
  let remaining = CONVERSATION_EVIDENCE_MAX_CHARACTERS;
  let truncated = false;
  for (let index = userMessages.length - 1; index >= 0; index--) {
    if (remaining === 0 || excerpts.length === CONVERSATION_EVIDENCE_MAX_MESSAGES) {
      truncated = true;
      break;
    }
    const message = userMessages[index]!;
    let start = Math.max(0, message.length - remaining);
    // Do not cut a surrogate pair at the beginning of a tail excerpt.
    const first = message.charCodeAt(start);
    if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start++;
    const excerpt = message.slice(start);
    truncated ||= start > 0;
    if (excerpt.length > 0) excerpts.push(excerpt);
    remaining -= excerpt.length;
  }
  return { userMessages: excerpts.reverse(), truncated };
}

/** Caller must first persist the live session. A missing/stale/suppressed
 * document refuses memory preparation instead of inventing an evidence id. */
export async function ensureConversationMemoryEvidence(
  deps: EvidenceDeps & { upserter: ConversationUpserter },
  sessionId: string,
): Promise<ConversationMemoryEvidence | null> {
  deps.upserter.enqueue(sessionId, () => deps.loadConversation(sessionId));
  await deps.upserter.flush(sessionId);
  const record = await deps.loadConversation(sessionId);
  if (!record) return null;
  const row = deps.readDb
    .prepare<
      [string, string, string],
      { id: string; content: string | null }
    >("SELECT id, content FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
    .get(OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID, sessionId);
  // The debouncer logs failures; never mistake an old document for a successful
  // synchronous flush. Quote checks still run again when an annotation writes.
  if (!row || row.content !== buildDocumentInput(record).content) return null;
  const bounded = boundedConversationUserMessages(conversationUserMessages(record));
  return bounded.userMessages.length ? { documentId: row.id, ...bounded } : null;
}

/** Additional validation for annotations; other sources retain their normal
 * evidence rules. Checking each atom separately prevents an assistant quote
 * from entering through additionalEvidence or a legacy annotation revision. */
export async function validateConversationAnnotationEvidence(
  deps: EvidenceDeps,
  documentId: string,
  quote: string,
): Promise<{ code: string; message: string } | null> {
  const row = deps.readDb
    .prepare<
      [string],
      { provider_id: string; source_id: string; external_id: string }
    >("SELECT provider_id, source_id, external_id FROM documents WHERE id = ?")
    .get(documentId);
  if (!row || row.source_id !== OMNESIS_CHAT_SOURCE_ID) return null;
  const record =
    row.provider_id === OMNESIS_CHAT_PROVIDER_ID
      ? await deps.loadConversation(row.external_id)
      : null;
  if (record && conversationUserMessages(record).some((text) => containsNormalized(text, quote))) {
    return null;
  }
  return {
    code: "invalid_evidence",
    message:
      "Conversation evidence must quote a persisted user message. Assistant replies, tool results, titles, and generated prompts cannot establish user testimony.",
  };
}
