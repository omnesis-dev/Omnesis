// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure projection: `ConversationRecord` → dialogue-only markdown body +
 * pre-resolved citation list.
 *
 * Body shape is intentionally minimal:
 *   - User text parts and assistant text parts only.
 *   - Tool-use blocks, tool-result blocks, and assistant thinking blocks
 *     are **excluded** — they're transcript scaffolding the retrieval
 *     index doesn't benefit from.
 *   - Annotated quotes are **not** inlined as body text either; they
 *     live on the `document_links` edges as link metadata. That avoids
 *     double-indexing snippets that already exist in their source docs
 *     and keeps body searches focused on the user's framing.
 *
 * Citations are reconstructed from the persisted tool_result blocks
 * (kind `annotate.recorded` for a document citation, `cite_record.recorded`
 * for a record citation) so this projection works identically for live
 * upserts and backfill of old JSON files — both sides use the JSON transcript
 * as the source of truth.
 */

import type { ChatMessage } from "@omnesis/agent";

import type { ConversationRecord } from "../../agent/conversation-store.js";

export interface RenderedConversation {
  /** Dialogue-only markdown — see module doc for what is included. */
  body: string;
  /**
   * Pre-resolved citations harvested from `annotate.recorded` /
   * `cite_record.recorded` tool results. One entry per recording — the agent
   * may cite the same doc or row multiple times in a conversation; we keep
   * each separately so the downstream link upsert preserves every citation's
   * metadata.
   */
  citations: RenderedCitation[];
}

/** A harvested document citation (the `annotate` tool). */
export interface RenderedDocumentCitation {
  kind: "document";
  documentId: string;
  quote?: string;
  quoteAuthor?: string;
  note?: string;
}

/** A harvested record citation (the `cite_record` tool). */
export interface RenderedRecordCitation {
  kind: "record";
  table: string;
  recordKey: string;
  primaryKeyColumns: { name: string; value: string; castType?: string }[];
  title: string;
  keyFields: { label: string; value: string | number | boolean | null }[];
  semanticTime: string;
  snapshot: Record<string, string | number | boolean | null>;
  sourceId: string;
  sourceType: string;
  tableDisplayName: string;
  boundDocumentId: string | null;
}

export type RenderedCitation = RenderedDocumentCitation | RenderedRecordCitation;

const USER_LABEL = "You";
const ASSISTANT_LABEL = "Omnesis";

export function renderConversation(record: ConversationRecord): RenderedConversation {
  const body = renderDialogue(record);
  const citations = harvestCitations(record.messages);
  return { body, citations };
}

function renderDialogue(record: ConversationRecord): string {
  const title = record.title || "(untitled)";
  const parts: string[] = [`# ${title}`];
  let firstUserStampApplied = false;

  for (const msg of record.messages) {
    if (msg.role === "user") {
      const text = joinUserTextParts(msg);
      if (text.length === 0) continue;
      const stamp = firstUserStampApplied ? "" : ` (${formatStamp(record.createdAt)})`;
      firstUserStampApplied = true;
      parts.push(`**${USER_LABEL}**${stamp}:\n${text}`);
    } else {
      const text = joinAssistantTextParts(msg);
      if (text.length === 0) continue;
      parts.push(`**${ASSISTANT_LABEL}**:\n${text}`);
    }
  }

  return parts.join("\n\n");
}

function joinUserTextParts(msg: Extract<ChatMessage, { role: "user" }>): string {
  const pieces: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === "text") {
      const t = part.text.trim();
      if (t.length > 0) pieces.push(t);
    }
    // tool_result parts deliberately dropped — see module doc.
  }
  return pieces.join("\n\n");
}

function joinAssistantTextParts(msg: Extract<ChatMessage, { role: "assistant" }>): string {
  const pieces: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === "text") {
      const t = withoutTerminalMarker(part.text).trim();
      if (t.length > 0) pieces.push(t);
    }
    // thinking + tool_use parts deliberately dropped — see module doc.
  }
  return pieces.join("\n\n");
}

/** Prefix of the breadcrumb `@omnesis/agent` appends to a turn that failed or was stopped. */
const TERMINAL_MARKER = "Model request failed: ";

/**
 * Assistant text without the breadcrumb a dead turn ends on. The breadcrumb
 * is scaffolding for the model's next request, not dialogue, and indexing it
 * would surface every stopped or failed chat for "model request failed".
 * Anchored where the session writes it — at the start of the text, or after
 * the blank line separating it from the answer — so prose that quotes the
 * phrase mid-sentence is kept.
 */
function withoutTerminalMarker(text: string): string {
  if (text.startsWith(TERMINAL_MARKER)) return "";
  const separated = text.lastIndexOf(`\n\n${TERMINAL_MARKER}`);
  return separated < 0 ? text : text.slice(0, separated);
}

function formatStamp(iso: string): string {
  // Render the ISO timestamp as a calendar date — keeps the body
  // searchable by phrase ("Paris 2026-05") without polluting it with
  // the wall-clock noise of every individual turn.
  return iso.slice(0, 10);
}

function harvestCitations(messages: ReadonlyArray<ChatMessage>): RenderedCitation[] {
  const out: RenderedCitation[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.kind !== "tool_result") continue;
      out.push(...extractCitations(part.result));
    }
  }
  return out;
}

/**
 * The citations a tool result contributes to the durable graph: N (in order)
 * for an `annotate.batch` (annotate_many), one for a singular annotate /
 * cite_record, none otherwise. A failed child (`kind:"error"`) yields nothing.
 */
function extractCitations(result: unknown): RenderedCitation[] {
  if (
    result &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "annotate.batch"
  ) {
    const items = Array.isArray((result as { items?: unknown }).items)
      ? (result as { items: unknown[] }).items
      : [];
    const out: RenderedCitation[] = [];
    for (const item of items) {
      const c = extractCitation(item);
      if (c) out.push(c);
    }
    return out;
  }
  const single = extractCitation(result);
  return single ? [single] : [];
}

function extractCitation(result: unknown): RenderedCitation | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.kind === "annotate.recorded") {
    if (typeof r.documentId !== "string" || r.documentId.length === 0) return null;
    return {
      kind: "document",
      documentId: r.documentId,
      quote: typeof r.quote === "string" ? r.quote : undefined,
      quoteAuthor: typeof r.quoteAuthor === "string" ? r.quoteAuthor : undefined,
      note: typeof r.note === "string" ? r.note : undefined,
    };
  }
  if (r.kind === "cite_record.recorded") {
    // The tool result was validated against `citeRecordRecordedResult` at the
    // wire boundary, so the fields are well-typed; light guards keep the
    // backfill path (older JSON transcripts) defensive.
    if (typeof r.table !== "string" || typeof r.recordKey !== "string") return null;
    if (typeof r.semanticTime !== "string" || r.semanticTime.length === 0) return null;
    return {
      kind: "record",
      table: r.table,
      recordKey: r.recordKey,
      primaryKeyColumns: Array.isArray(r.primaryKeyColumns)
        ? (r.primaryKeyColumns as RenderedRecordCitation["primaryKeyColumns"])
        : [],
      title: typeof r.title === "string" ? r.title : "",
      keyFields: Array.isArray(r.keyFields)
        ? (r.keyFields as RenderedRecordCitation["keyFields"])
        : [],
      semanticTime: r.semanticTime,
      snapshot:
        r.snapshot && typeof r.snapshot === "object"
          ? (r.snapshot as RenderedRecordCitation["snapshot"])
          : {},
      sourceId: typeof r.sourceId === "string" ? r.sourceId : "",
      sourceType: typeof r.sourceType === "string" ? r.sourceType : "",
      tableDisplayName: typeof r.tableDisplayName === "string" ? r.tableDisplayName : "",
      boundDocumentId: typeof r.boundDocumentId === "string" ? r.boundDocumentId : null,
    };
  }
  return null;
}
