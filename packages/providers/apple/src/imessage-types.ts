// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";

/**
 * Sync cursor for Apple iMessage source.
 * Uses message ROWID as watermark for incremental sync.
 */
export interface AppleIMessageSyncCursor extends Record<string, unknown> {
  /** Highest message.ROWID we have processed */
  lastRowId: number;
  /**
   * Queue size pinned at the start of the current sync cycle (count of
   * messages with ROWID > cursor at cycle start). Cleared when the cycle
   * ends with `hasMore: false` so the next cycle re-counts.
   */
  cycleQueueTotal?: number;
  /**
   * Signature of the snapshot ID set we last reported to the gateway —
   * a content hash over the current day-doc signatures and attachment child IDs.
   * iMessage rows are mutable (edits, unsends, tapback removals, attachment
   * metadata), so this must track more than `COUNT/MAX(ROWID)`.
   */
  lastSnapshotSignature?: string;
  /**
   * Per parent day-doc signature keyed by externalId (`chatIdentifier:YYYY-MM-DD`).
   * Lets the source re-emit just the days whose rendered content changed when
   * there are no new ROWIDs to pull.
   */
  lastDaySignatures?: Record<string, string>;
}

export function isAppleIMessageSyncCursor(v: unknown): v is AppleIMessageSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastRowId !== "number") return false;
  if (c.cycleQueueTotal !== undefined && typeof c.cycleQueueTotal !== "number") return false;
  if (c.lastSnapshotSignature !== undefined && typeof c.lastSnapshotSignature !== "string")
    return false;
  if (c.lastDaySignatures !== undefined) {
    if (!c.lastDaySignatures || typeof c.lastDaySignatures !== "object") return false;
    for (const [k, v] of Object.entries(c.lastDaySignatures as Record<string, unknown>)) {
      if (typeof k !== "string" || typeof v !== "string") return false;
    }
  }
  return true;
}

export const validateAppleIMessageSyncCursor = makeCursorValidator(isAppleIMessageSyncCursor);

/**
 * Raw message row from chat.db (joined query result).
 */
export interface RawIMessage {
  rowId: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | Uint8Array | null;
  date: number;
  isFromMe: number;
  isSystemMessage: number;
  handleId: number;
  service: string;
  cacheHasAttachments: number;
  associatedMessageGuid: string | null;
  associatedMessageType: number;
  associatedMessageEmoji: string | null;
  replyToGuid: string | null;
  threadOriginatorGuid: string | null;
  groupTitle: string | null;
  chatIdentifier: string;
  chatDisplayName: string | null;
  /**
   * @deprecated Apple's chat.style values aren't a reliable group/single signal —
   * macOS 25.3 inverts the documented mapping (style=45 means 1-to-1, style=43
   * means group on certain chat.db files). We now derive isGroup from
   * `COUNT(DISTINCT chat_handle_join.handle_id)` per chat instead. Field is
   * retained here for tests / debugging but should not be relied on.
   */
  chatStyle: number;
  /** Distinct handle count per chat — `> 1` is a real group chat. */
  chatHandleCount: number;
  contactId: string | null; // handle.id (phone or email)
}

/**
 * Raw attachment row from chat.db.
 */
export interface RawIMessageAttachment {
  attachmentRowId: number;
  guid: string | null;
  messageRowId: number;
  filename: string | null;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number;
}

/**
 * Parsed message ready for normalization.
 */
export interface ParsedIMessage {
  rowId: number;
  guid: string;
  text: string;
  date: Date;
  isFromMe: boolean;
  isSystemMessage: boolean;
  sender: string;
  service: string;
  attachments: IMessageAttachmentInfo[];
  /** Tapback info (only set for reaction messages) */
  tapback?: {
    type: string;
    targetGuid: string;
    emoji?: string;
    action: "add" | "remove";
  };
  replyToGuid?: string;
  threadOriginatorGuid?: string;
  contactId?: string;
}

/**
 * Attachment metadata for display and extraction.
 */
export interface IMessageAttachmentInfo {
  /** Apple attachment.guid, when present. Used for durable transcript cache keys. */
  guid?: string;
  filename: string;
  mimeType: string | null;
  /** Resolved absolute path to the file on disk (from chat.db attachment.filename) */
  filePath: string | null;
  /** File size in bytes */
  totalBytes: number;
  /**
   * Transcript of an audio clip, set by the source's inline-transcription pass
   * before normalization. Present only for `audio/*` attachments once speech-to-
   * text has run; the normalizer renders it inline (`[Audio, M:SS]: …`). `""`
   * is a valid value (no speech detected) and isn't retried.
   */
  transcript?: string;
  /** Duration of the audio clip in seconds, when the transcriber reported it. */
  durationSec?: number;
}

/**
 * Info about a chat for normalization.
 */
export interface IMessageChatInfo {
  chatIdentifier: string;
  displayName: string | null;
  isGroup: boolean;
  service: string;
  /**
   * Full participant roster (phone/email handle strings, from
   * `chat_handle_join`) for a group chat, so members who stayed silent on a
   * given day still count as participants. Only populated for groups;
   * undefined/empty when the roster is unknown.
   */
  participantHandles?: string[];
}
