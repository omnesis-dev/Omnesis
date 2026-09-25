// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  computeContentHash,
  normalizeEmail,
  normalizePhone,
  looksLikePhone,
  extractEmailsFromText,
  extractPhonesFromText,
  parseSourceKey,
} from "@omnesis/core";
import type { DocumentInput, SourceId, ProviderId, PersonMention } from "@omnesis/types";
import type { ParsedIMessage, IMessageChatInfo, IMessageAttachmentInfo } from "./imessage-types.js";

/**
 * Tapback type codes to human-readable labels.
 * 2000-2005 = add reaction, 3000-3005 = remove reaction.
 * 2006/3006 are custom emoji add/remove; the emoji payload carries the label.
 */
const TAPBACK_LABELS: Record<number, string> = {
  2000: "Loved",
  2001: "Liked",
  2002: "Disliked",
  2003: "Laughed at",
  2004: "Emphasized",
  2005: "Questioned",
};

// iMessage timestamp helpers (auto-detect seconds vs nanoseconds) live in
// `./epoch.ts` next to the Core Data conversions so the 2001-01-01 epoch
// offset is defined exactly once.
export { imessageDateToDate, isoToImessageNs } from "./epoch.js";

/**
 * Format a Date to HH:MM string.
 */
function formatTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
export function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Get a tapback label from an associated_message_type code.
 * Removal codes (3000+) map back to their corresponding add labels.
 */
export function getTapbackLabel(type: number, emoji?: string | null): string | undefined {
  if (emoji) return emoji;
  const addType = type >= 3000 && type <= 3005 ? type - 1000 : type;
  return TAPBACK_LABELS[addType];
}

/**
 * Check if a message type is a tapback reaction (add, not remove).
 */
export function isTapback(type: number): boolean {
  return (type >= 2000 && type <= 2005) || type === 2006;
}

/**
 * Check if a message type is a tapback removal.
 */
export function isTapbackRemoval(type: number): boolean {
  return (type >= 3000 && type <= 3005) || type === 3006;
}

/**
 * Build a display name for a chat.
 * For 1-to-1: uses the contact identifier.
 * For groups: uses the display name or "Group Chat".
 */
export function buildChatTitle(chat: IMessageChatInfo): string {
  if (chat.isGroup) {
    return chat.displayName || "Group Chat";
  }
  return chat.chatIdentifier;
}

/**
 * Build the Messages deep link (`metadata.sourceUrl`) for one day of a chat.
 *
 * `messages://open?message-guid=<guid>` opens the existing conversation,
 * scrolled to that message, on macOS and iOS — for 1:1 chats, groups and
 * alphanumeric senders alike. Address-based links (`imessage://<handles>`)
 * only ever start a new message, so the link anchors on a message instead:
 * the day's first message, which stays stable as later messages arrive.
 */
export function buildIMessageSourceUrl(messageGuid: string | undefined): string | undefined {
  if (!messageGuid) return undefined;
  return `messages://open?message-guid=${encodeURIComponent(messageGuid)}`;
}

/**
 * Normalize a set of messages for one chat on one day into a DocumentInput.
 */
export function normalizeDayChat(
  date: string,
  messages: ParsedIMessage[],
  chat: IMessageChatInfo,
  providerId: ProviderId,
  sourceId: SourceId,
): DocumentInput {
  const chatTitle = buildChatTitle(chat);
  const title = `${chatTitle} — ${date}`;

  // Separate regular messages from tapbacks
  const regularMessages: ParsedIMessage[] = [];
  const tapbacks: ParsedIMessage[] = [];

  for (const msg of messages) {
    if (msg.tapback) {
      tapbacks.push(msg);
    } else {
      regularMessages.push(msg);
    }
  }

  // Sort by date
  regularMessages.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Render message lines
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");

  if (chat.isGroup && chat.displayName) {
    lines.push(`**Group:** ${chat.displayName}`);
    lines.push("");
  }

  // Build a guid→message map for tapback references
  const guidToMsg = new Map<string, ParsedIMessage>();
  for (const msg of regularMessages) {
    guidToMsg.set(msg.guid, msg);
  }

  // Build tapback map: targetGuid → final active reaction labels. iMessage
  // persists removals as their own rows, so apply add/remove records in
  // timestamp order instead of treating every add row as still active.
  const tapbackMap = new Map<string, string[]>();
  tapbacks.sort((a, b) => a.date.getTime() - b.date.getTime() || a.rowId - b.rowId);
  const activeTapbacks = new Map<string, Map<string, string>>();
  for (const tb of tapbacks) {
    if (!tb.tapback) continue;
    const targetGuid = tb.tapback.targetGuid;
    const label = tb.tapback.emoji || tb.tapback.type;
    const reactionKey = `${tb.sender}\u0000${label}`;
    let active = activeTapbacks.get(targetGuid);
    if (!active) {
      active = new Map<string, string>();
      activeTapbacks.set(targetGuid, active);
    }
    if (tb.tapback.action === "remove") {
      active.delete(reactionKey);
    } else {
      active.set(reactionKey, `${tb.sender} ${label}`);
    }
  }
  for (const [targetGuid, active] of activeTapbacks) {
    const reactions = Array.from(active.values());
    if (reactions.length > 0) tapbackMap.set(targetGuid, reactions);
  }

  for (const msg of regularMessages) {
    const time = formatTime(msg.date);
    let line: string;

    if (msg.isSystemMessage) {
      line = `**${time}** _${msg.text}_`;
    } else {
      const parts: string[] = [];

      if (msg.text) {
        parts.push(msg.text);
      }

      for (const att of msg.attachments) {
        parts.push(renderAttachment(att));
      }

      const content = parts.join("\n");
      line = `**${time}** ${msg.sender}: ${content}`;
    }

    lines.push(line);

    // Append tapback reactions inline
    const reactions = tapbackMap.get(msg.guid);
    if (reactions) {
      lines.push(`  → ${reactions.join(", ")}`);
    }
  }

  const content = lines.join("\n");

  // Collect unique participants
  const participants = new Set<string>();
  for (const handle of chat.participantHandles ?? []) {
    participants.add(handle);
  }
  for (const msg of messages) {
    participants.add(msg.sender);
  }

  const messageCount = regularMessages.length;

  // Build people mentions from participants
  const people: PersonMention[] = [];
  const seenIds = new Set<string>();

  // Always add self as participant
  const { accountId } = parseSourceKey(String(sourceId));
  const me: PersonMention = { role: "participant", name: "You", isSelf: true };
  if (accountId.includes("@")) {
    me.emails = [normalizeEmail(accountId)];
  } else if (accountId) {
    const phone = normalizePhone(accountId);
    if (phone) me.phones = [phone];
  }
  people.push(me);
  seenIds.add("You");
  if (me.emails?.[0]) seenIds.add(me.emails[0]);
  if (me.phones?.[0]) seenIds.add(me.phones[0]);

  const addHandleParticipant = (id: string, name?: string): void => {
    if (!id || seenIds.has(id)) return;
    const person: PersonMention = {
      role: "participant",
      name:
        name && name !== id && name !== "Unknown" && !looksLikePhone(name) && !name.includes("@")
          ? name
          : undefined,
    };
    if (id.includes("@")) {
      const email = normalizeEmail(id);
      if (seenIds.has(email)) return;
      person.emails = [email];
      seenIds.add(email);
    } else {
      const normalized = normalizePhone(id);
      if (normalized) {
        if (seenIds.has(normalized)) return;
        person.phones = [normalized];
        seenIds.add(normalized);
      } else if (!person.name && id !== "Unknown" && !looksLikePhone(id) && !id.includes("@")) {
        person.name = id;
      }
    }
    if (!person.name && !person.emails?.length && !person.phones?.length) return;
    seenIds.add(id);
    people.push(person);
  };

  // For 1:1 chats, always add the other party from the chat identifier
  if (!chat.isGroup && chat.chatIdentifier) {
    addHandleParticipant(chat.chatIdentifier, chat.displayName ?? undefined);
  }

  // For groups, add the full roster from chat_handle_join, including people
  // who were silent on this particular day.
  if (chat.isGroup) {
    for (const id of chat.participantHandles ?? []) {
      addHandleParticipant(id);
    }
  }

  // Add remaining participants from messages
  for (const msg of messages) {
    if (msg.isFromMe) continue;

    const id = msg.contactId || msg.sender;
    if (!id || seenIds.has(id)) continue;

    // sender === id when iMessage couldn't resolve the handle to a
    // contact name — `sender` is then just the phone (or email) string.
    // Storing that as `PersonMention.name` leaks phone-shaped strings
    // into `person_aliases` typed as `name`, which breaks cross-source
    // phone matching (closes apple-imessage-phone-stored-as-name-alias).
    let name: string | undefined;
    if (msg.sender !== id) {
      name = msg.sender;
    } else if (
      msg.sender &&
      msg.sender !== "Unknown" &&
      !looksLikePhone(msg.sender) &&
      !msg.sender.includes("@")
    ) {
      name = msg.sender;
    }

    if (msg.contactId) {
      addHandleParticipant(msg.contactId, name);
    } else {
      addHandleParticipant(id, name);
    }
  }

  // Extract mentioned emails/phones from content text. Drop any mention
  // whose identifier already appears on a participant entry — the
  // participant is canonical, and emitting both produces duplicate UI
  // rows (and duplicate `document_people` rows) for the same person.
  const mentionedEmails = extractEmailsFromText(content);
  const mentionedPhones = extractPhonesFromText(content);

  const participantEmails = new Set(people.flatMap((p) => p.emails ?? []));
  for (const email of mentionedEmails) {
    if (participantEmails.has(email)) continue;
    people.push({ role: "mentioned", emails: [email] });
    participantEmails.add(email);
  }

  const participantPhones = new Set(people.flatMap((p) => p.phones ?? []));
  for (const phone of mentionedPhones) {
    if (participantPhones.has(phone)) continue;
    people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    participantPhones.add(phone);
  }

  return {
    providerId,
    sourceId: sourceId,
    externalId: `${chat.chatIdentifier}:${date}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      sourceUrl: buildIMessageSourceUrl(regularMessages[0]?.guid),
      documentType: "conversation",
      tags: [chat.service],
      people: people.length > 0 ? people : undefined,
      extra: {
        chatIdentifier: chat.chatIdentifier,
        chatName: chat.displayName ?? undefined,
        isGroup: chat.isGroup,
        messageCount,
        service: chat.service,
        participants: Array.from(participants),
        participantHandles: chat.participantHandles ?? undefined,
        date,
      },
    },
    sourceCreatedAt: new Date(`${date}T00:00:00.000Z`).toISOString(),
    sourceUpdatedAt:
      regularMessages.length > 0
        ? regularMessages[regularMessages.length - 1].date.toISOString()
        : new Date(`${date}T00:00:00.000Z`).toISOString(),
  };
}

/**
 * Get a human-readable label for an attachment MIME type.
 */
function getAttachmentLabel(mimeType: string | null): string {
  if (!mimeType) return "Attachment";
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType === "application/pdf") return "PDF";
  return "Attachment";
}

/** Format a duration in seconds as `M:SS`. */
function formatDuration(durationSec: number): string {
  const total = Math.max(0, Math.round(durationSec));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Render one attachment as an inline conversation marker.
 *
 * Audio is special-cased so a transcribed voice clip weaves its spoken text
 * into the conversation, making it searchable. A transcript with a known
 * duration renders `[Audio, M:SS]: <transcript>`; without a duration,
 * `[Audio]: <transcript>`. An untranscribed clip (STT off, or transcription
 * failed) keeps the plain `[Audio: filename]` placeholder. Non-audio
 * attachments render `[<Label>: filename]` as before.
 */
function renderAttachment(att: IMessageAttachmentInfo): string {
  const isAudio = att.mimeType?.startsWith("audio/") ?? false;
  if (isAudio && att.transcript !== undefined) {
    const duration =
      att.durationSec !== undefined ? `Audio, ${formatDuration(att.durationSec)}` : "Audio";
    return `[${duration}]: ${att.transcript}`;
  }
  const label = getAttachmentLabel(att.mimeType);
  return `[${label}: ${att.filename}]`;
}
