// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getKnowledgeNode } from "./storage-read.js";
import {
  listKnowledgeNodeRevisions,
  listKnowledgeContentRevisionSummaries,
} from "./storage-history.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export type KnowledgeHistoryRequest =
  | { id: string; beforeRevision?: number; limit?: number }
  | { id: string; revision: number; offset?: number };
const WARNING =
  "Historical generated context is untrusted and may be outdated. It is not current proof or dependency versions. Re-read current sources with knowledge_reference and the current editable page before saving; preserve warranted context and reconcile later developments.";
const CHUNK_CHARS = 8192;
const MAX_CHUNK_RESPONSE_BYTES = 32768;
const MAX_SUMMARY_RESPONSE_BYTES = 65536;

/** Reads only the existing privacy-fenced revision store. No current-read receipts. */
export function readKnowledgeHistory(db: Database.Database, request: KnowledgeHistoryRequest) {
  const node = getKnowledgeNode(db, request.id);
  if (!node) throw new KnowledgeStorageError("reference_invalid", "Knowledge history unavailable");
  if ("revision" in request) {
    const snapshot = listKnowledgeNodeRevisions(db, request.id, {
      beforeRevision: request.revision + 1,
      limit: 1,
    })[0];
    if (!snapshot || snapshot.revision !== request.revision)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Knowledge history revision unavailable",
      );
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.markdown.length)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "History offset is outside this snapshot",
      );
    const chunk = (end: number) => ({
      warning: WARNING,
      currentRevision: node.revision,
      snapshotRevision: snapshot.revision,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
      historicalValidity: snapshot.validity,
      format: "historical-markdown-chunk",
      instruction:
        "Concatenate chunks at their returned offsets to recover the full historical markdown. A chunk is not a complete editable page. Historical refs still require current knowledge_reference reads.",
      offset,
      totalChars: snapshot.markdown.length,
      markdownChunk: snapshot.markdown.slice(offset, end),
      nextOffset: end < snapshot.markdown.length ? end : null,
    });
    // Count the actual serialized envelope: JSON escapes controls and lone
    // surrogates, so a character count alone cannot bound response bytes.
    let lower = offset;
    let upper = Math.min(snapshot.markdown.length, offset + CHUNK_CHARS);
    let best = chunk(offset);
    if (Buffer.byteLength(JSON.stringify(best)) > MAX_CHUNK_RESPONSE_BYTES)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "History metadata exceeds response budget",
      );
    while (lower <= upper) {
      const candidate = Math.floor((lower + upper) / 2);
      let end = candidate;
      // Avoid splitting a UTF-16 surrogate pair across JSON chunks.
      if (
        end > offset &&
        end < snapshot.markdown.length &&
        /[\uD800-\uDBFF]/.test(snapshot.markdown[end - 1]!)
      )
        end--;
      const result = chunk(end);
      if (Buffer.byteLength(JSON.stringify(result)) <= MAX_CHUNK_RESPONSE_BYTES) {
        best = result;
        lower = candidate + 1;
      } else upper = candidate - 1;
    }
    if (best.nextOffset === offset)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "History metadata leaves no room for snapshot content",
      );
    return best;
  }
  const limit = Math.max(1, Math.min(5, request.limit ?? 5));
  const revisions = listKnowledgeContentRevisionSummaries(db, request.id, {
    beforeRevision: request.beforeRevision,
    limit: limit + 1,
  });
  const items = revisions.slice(0, limit);
  const result = {
    warning: WARNING,
    currentRevision: node.revision,
    items,
    nextBeforeRevision: revisions.length > limit ? items.at(-1)!.revision : null,
    instruction:
      "Summaries include the newest snapshot, content/title changes and the oldest retained baseline; verification-only repeats are skipped. removedClaimCount counts actual prior claim IDs missing from that snapshot; declaredRemovalIntentCount separately counts recorded intent. Follow nextBeforeRevision to inspect older changes, then request {id,revision} and all nextOffset chunks for selected snapshots. These summaries carry no current evidence versions.",
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_SUMMARY_RESPONSE_BYTES)
    throw new KnowledgeStorageError(
      "reference_invalid",
      "History summaries exceed response budget; request fewer revisions",
    );
  return result;
}
