// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncCursor } from "@omnesis/source-sdk";
import type { ExtractionResult, TranscriptionPlaceholderState } from "@omnesis/core";
import type { ChatKind, MessageBox, TgMediaRef } from "./client/types.js";
import type { MediaState } from "./media-retry.js";

/**
 * The cursor the host persists for `telegram-messages`: a position in the
 * account's archive, never the corpus. `committedSeq` acknowledges the drain of
 * the archive named by `storeId` (WhatsApp's `emit_seq` protocol); `phase` is
 * for observability.
 */
export interface TelegramSyncCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  committedSeq: number;
  storeId?: string;
}

/** What a message's media is, without its bytes: for rendering and download. */
export type MediaDescriptor = Omit<TgMediaRef, "isViewOnce">;

/** A message as the archive keeps it (`messages` row). */
export interface StoredMessage {
  chatId: number;
  msgId: number;
  box: MessageBox;
  /** Unix seconds. */
  ts: number;
  editTs?: number;
  senderId?: number;
  senderName?: string;
  outgoing: boolean;
  /** Markdown. */
  text: string;
  replyToId?: number;
  topicId?: number;
  forwardFrom?: string;
  groupedId?: string;
  /** A service message's action, e.g. `message_pinned`. */
  service?: string;
  media?: MediaDescriptor;
  /** Where the media lifecycle stands; absent for media Omnesis never downloads. */
  mediaState?: MediaState;
  /** Unix seconds before which the next media attempt waits. */
  mediaNextAttempt?: number;
  /** What the last failed media attempt reported, while it is still pending. */
  mediaLastError?: string;
  /** A voice note's transcript; `""` when it held no speech. */
  transcript?: string;
  /** Unix seconds this message last changed after it was archived (edit, transcript, topic rename). */
  changedAt?: number;
  /** An attachment's extraction, re-emitted on every render of its day. */
  extraction?: ExtractionResult;
  /**
   * Render only, never stored: why a voice note shows no transcript, as the
   * media pass worked it out for this render. Absent: no transcriber is wired.
   */
  transcription?: TranscriptionPlaceholderState;
}

/**
 * Where a chat's history walk stands. `failed` is a chat Telegram refused
 * (left, banned, private); it is tried again at the next full reconcile.
 */
export type WalkState = "pending" | "walking" | "done" | "excluded" | "failed";

/** A chat as the archive keeps it (`chats` row). */
export interface StoredChat {
  chatId: number;
  kind: ChatKind;
  title: string;
  username?: string;
  isArchived: boolean;
  isForum: boolean;
  walkState: WalkState;
}
