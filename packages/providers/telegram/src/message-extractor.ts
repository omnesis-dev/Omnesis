// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TgMessage` → `StoredMessage`: what of a Telegram message the archive keeps.
 *
 * Three kinds of message are never stored (`docs/telegram-source.md` D11):
 * anything under a self-destruct timer (`ttlPeriod`), view-once media, and
 * service messages that say nothing about the conversation (a screenshot
 * notice, a theme change, a gift). Telegram's terms forbid keeping
 * self-destructing content past its life, so those are dropped before they
 * reach the disk at all, not filtered at render time.
 *
 * Media is kept as a descriptor only: its kind, name, size and duration for
 * the placeholder, and the file id a later phase downloads with. No bytes.
 */

import type { TgMessage } from "./client/types.js";
import type { MediaDescriptor, StoredMessage } from "./types.js";

/**
 * Bumped when this function's output changes for the same input, so a re-walk
 * rewrites rows an older build stored instead of keeping them.
 */
export const EXTRACT_REVISION = 1;

/**
 * The service messages worth a line in the day's conversation, and how that
 * line reads after the actor's name. Every other action is noise.
 */
const SERVICE_PHRASES: Readonly<Record<string, string>> = {
  chat_created: "created the group",
  channel_created: "created the channel",
  title_changed: "changed the group name",
  photo_changed: "changed the group photo",
  photo_deleted: "removed the group photo",
  users_added: "added members",
  user_joined_link: "joined via an invite link",
  user_joined_approved: "joined the group",
  user_left: "left the group",
  user_removed: "removed a member",
  message_pinned: "pinned a message",
  call: "called",
  group_call_started: "started a voice chat",
  group_call_ended: "ended a voice chat",
  topic_created: "created a topic",
};

/** The phrase a kept service message renders as, after the actor's name. */
export function servicePhrase(service: string): string {
  return SERVICE_PHRASES[service] ?? service.replace(/_/gu, " ");
}

/** What the archive keeps of `msg`, or `null` when it keeps nothing. */
export function extractMessage(msg: TgMessage): StoredMessage | null {
  if (msg.ttlPeriod) return null;
  if (msg.media?.isViewOnce) return null;
  if (msg.service !== undefined && !(msg.service in SERVICE_PHRASES)) return null;
  const media = msg.media ? describeMedia(msg.media) : undefined;
  if (!msg.text && !media && msg.service === undefined) return null;
  return {
    chatId: msg.chatId,
    msgId: msg.id,
    box: msg.box,
    ts: msg.date,
    ...(msg.editDate ? { editTs: msg.editDate } : {}),
    ...(msg.senderId !== undefined ? { senderId: msg.senderId } : {}),
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    outgoing: msg.outgoing,
    text: msg.text,
    ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
    ...(msg.topicId ? { topicId: msg.topicId } : {}),
    ...(msg.forwardFrom ? { forwardFrom: msg.forwardFrom } : {}),
    ...(msg.groupedId ? { groupedId: msg.groupedId } : {}),
    ...(msg.service !== undefined ? { service: msg.service } : {}),
    ...(media ? { media } : {}),
  };
}

function describeMedia(media: NonNullable<TgMessage["media"]>): MediaDescriptor {
  const { isViewOnce: _viewOnce, ...descriptor } = media;
  return descriptor;
}
