// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One chat's UTC day → one conversation document (`docs/telegram-source.md` §8).
 *
 * The same shape as WhatsApp's day documents
 * (`packages/providers/whatsapp/src/normalizer.ts`): a title, one markdown line
 * per message, and the people who spoke. It renders from the archive, never
 * from what one sync page happened to fetch, so a day re-rendered after an
 * edit, a deletion or a late page is always the whole day.
 *
 * The day boundary is UTC, so a document's external id is the same on every
 * host; clock times are the collector host's local time, as WhatsApp writes
 * them. The account holder is "You". Bots and deleted accounts are not people.
 */

import {
  cleanPersonName,
  computeContentHash,
  extractEmailsFromText,
  extractPhonesFromText,
  isAutomatedSenderAddress,
  isNonIdentifyingEmail,
  transcriptionPlaceholderNote,
} from "@omnesis/core";
import { servicePhrase } from "./message-extractor.js";
import { telegramLinks } from "./links.js";
import type {
  DocumentInput,
  PersonIdentifier,
  PersonMention,
  ProviderId,
  SourceId,
} from "@omnesis/types";
import type { StoredUser } from "./message-store.js";
import type { MediaDescriptor, StoredChat, StoredMessage } from "./types.js";

/** The alias prefix the descriptor's `selfIdentity` declares. */
const TELEGRAM_LID_PREFIX = "telegram-user";

export interface DayRenderInput {
  chat: StoredChat;
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** The day's surviving messages, oldest first; never empty. */
  messages: readonly StoredMessage[];
  /** Everyone the archive knows who appears in the day. */
  users: ReadonlyMap<number, StoredUser>;
  /** Messages the day replies to, by id, when the archive holds them. */
  replies: ReadonlyMap<number, StoredMessage>;
  /** A forum's topic titles by topic id; a message in an unknown topic renders without one. */
  topics?: ReadonlyMap<number, string>;
  self: { id: number; phoneE164?: string };
  providerId: ProviderId;
  sourceId: SourceId;
  /** For phones found in message text, which may be written nationally. */
  phoneRegion?: string;
  /** Unix seconds the day last changed after it was archived, deleted messages included. */
  changedAt?: number;
}

type PhoneRegion = Parameters<typeof extractPhonesFromText>[1];

const GROUPISH = new Set(["group", "supergroup", "forum"]);

/** Telegram's own service-notifications account (login codes, security notices). */
const TELEGRAM_SERVICE_USER_ID = 777_000;

/**
 * A display name worth giving a person: cleaned, and not a phone number or a
 * bare number, which some accounts carry as their name and which would name
 * a person after a number rather than identify them by it.
 */
function personName(raw: string | undefined): string | undefined {
  const name = cleanPersonName(raw);
  if (!name) return undefined;
  if (/^[\d\s+().-]+$/u.test(name) && /\d/u.test(name)) return undefined;
  return name;
}

/**
 * How a Telegram user is identified to the people graph: their account LID,
 * and their phone when Telegram shows it.
 */
export function telegramPersonIdentifiers(
  userId: number,
  users: ReadonlyMap<number, StoredUser>,
): PersonIdentifier[] {
  const phone = users.get(userId)?.phoneE164;
  return [
    { kind: "lid", value: `${TELEGRAM_LID_PREFIX}:${userId}` },
    ...(phone ? [{ kind: "phone" as const, value: phone }] : []),
  ];
}

/** The day document's external id: the marked chat id and the UTC date. */
export function dayExternalId(chatId: number, date: string): string {
  return `${chatId}:${date}`;
}

/**
 * Bumped when a day's rendering changes for the same archive rows, so an
 * archive opened by a newer build re-renders the days an older one published.
 * 2: clock times in the host's local time instead of UTC.
 */
export const RENDER_REVISION = 2;

/**
 * `HH:MM` in the collector host's local time, as WhatsApp's day documents
 * write it. See #406 — planned: write clock times with a zone.
 */
function formatTime(ts: number): string {
  return new Date(ts * 1000).toTimeString().slice(0, 5);
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The placeholder a media message renders as; `undefined` for none. */
export function mediaPlaceholder(media: MediaDescriptor): string | undefined {
  const duration = formatDuration(media.durationSec);
  switch (media.kind) {
    case "photo":
      return "[Photo]";
    case "document":
      return media.fileName ? `[Document: ${media.fileName}]` : "[Document]";
    case "voice":
      return duration ? `[Voice note, ${duration}]` : "[Voice note]";
    case "audio":
      return duration ? `[Audio, ${duration}]` : "[Audio]";
    case "video":
      return duration ? `[Video, ${duration}]` : "[Video]";
    case "video_note":
      return "[Video message]";
    case "sticker":
      return media.summary ? `[Sticker ${media.summary}]` : "[Sticker]";
    case "animation":
      return "[GIF]";
    case "location":
      return media.summary ? `[Location: ${media.summary}]` : "[Location]";
    case "contact":
      return "[Contact]";
    case "poll":
      return media.summary ? `[Poll: ${media.summary}]` : "[Poll]";
    case "webpage":
      // A link preview: the URL is already in the message text.
      return undefined;
    case "other":
      return "[Media]";
  }
}

export function normalizeDayChat(input: DayRenderInput): DocumentInput {
  const { chat, date, messages, users, replies, self } = input;
  const isGroup = GROUPISH.has(chat.kind);

  const senderName = (m: Pick<StoredMessage, "outgoing" | "senderId" | "senderName">): string => {
    if (m.outgoing || m.senderId === self.id) return "You";
    const user = m.senderId !== undefined ? users.get(m.senderId) : undefined;
    return user?.displayName || m.senderName || "Unknown";
  };

  const topicOf = (m: StoredMessage): string | undefined =>
    m.topicId !== undefined ? input.topics?.get(m.topicId) : undefined;
  const lines = [`# ${chat.title} — ${date}`, ""];
  for (const m of messages) lines.push(renderMessage(m, senderName, replies, topicOf(m)));
  const content = lines.join("\n");
  // The forum topics the day's messages were posted in, in order of first appearance.
  const topics = [...new Set(messages.flatMap((m) => topicOf(m) ?? []))];

  // People: self first, the other side of a private chat, then whoever spoke.
  const people: PersonMention[] = [
    {
      role: "participant",
      name: "You",
      identifiers: [
        { kind: "lid", value: `${TELEGRAM_LID_PREFIX}:${self.id}` },
        ...(self.phoneE164 ? [{ kind: "phone" as const, value: self.phoneE164 }] : []),
      ],
    },
  ];
  const participants = new Set<string>(["You"]);
  const seen = new Set<number>([self.id]);
  const phones = new Set<string>(self.phoneE164 ? [self.phoneE164] : []);
  const addUser = (userId: number, fallbackName?: string): void => {
    if (seen.has(userId)) return;
    seen.add(userId);
    const user = users.get(userId);
    if (user?.isBot || user?.isDeleted) return;
    // A channel or anonymous admin posts as the chat, and Telegram's service
    // account sends notifications: neither is a person.
    if (userId <= 0 || userId === TELEGRAM_SERVICE_USER_ID) return;
    const name = personName(user?.displayName || fallbackName);
    const identifiers = telegramPersonIdentifiers(userId, users);
    if (user?.phoneE164) phones.add(user.phoneE164);
    people.push({ role: "participant", ...(name ? { name } : {}), identifiers });
    if (name) participants.add(name);
  };
  if (chat.kind === "private") addUser(chat.chatId, chat.title);
  for (const m of messages) {
    if (m.outgoing || m.senderId === undefined || m.service) continue;
    addUser(m.senderId, m.senderName);
  }

  const emails = new Set<string>();
  for (const email of extractEmailsFromText(content)) {
    if (emails.has(email)) continue;
    emails.add(email);
    // An address in a message names someone at most: never a new person,
    // and never a no-reply or automated sender at all.
    if (isNonIdentifyingEmail(email) || isAutomatedSenderAddress(email)) continue;
    people.push({
      role: "mentioned",
      identifiers: [{ kind: "email", value: email }],
      allowPersonCreation: false,
    });
  }
  for (const phone of extractPhonesFromText(content, input.phoneRegion as PhoneRegion)) {
    if (phones.has(phone)) continue;
    phones.add(phone);
    people.push({
      role: "mentioned",
      identifiers: [{ kind: "phone", value: phone }],
      allowPersonCreation: false,
    });
  }

  const first = messages[0];
  const created = first.ts;
  // The latest message, edit or later change (a transcript, a renamed topic,
  // a deleted message, which `changedAt` counts); a loop, since a day can
  // hold more messages than a spread may pass.
  let updated = input.changedAt ?? 0;
  for (const m of messages) updated = Math.max(updated, m.ts, m.editTs ?? 0, m.changedAt ?? 0);
  const links = telegramLinks(chat, first);

  return {
    providerId: input.providerId,
    sourceId: input.sourceId,
    externalId: dayExternalId(chat.chatId, date),
    title: `${chat.title} — ${date}`,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      tags: isGroup ? ["group"] : [],
      ...links,
      people,
      extra: {
        chatId: String(chat.chatId),
        conversationId: String(chat.chatId),
        chatName: chat.title,
        chatKind: chat.kind,
        isGroup,
        isArchived: chat.isArchived,
        messageCount: messages.filter((m) => !m.service).length,
        mediaCount: messages.filter((m) => m.media && m.media.kind !== "webpage").length,
        participants: [...participants],
        ...(topics.length > 0 ? { topics } : {}),
        date,
      },
    },
    sourceCreatedAt: new Date(created * 1000).toISOString(),
    sourceUpdatedAt: new Date(updated * 1000).toISOString(),
  };
}

/**
 * A message's media placeholder. A transcribed voice note carries its text
 * after the placeholder, so it is searchable; one without says why.
 */
function messagePlaceholder(m: StoredMessage): string | undefined {
  const media = m.media!;
  if (media.kind !== "voice") return mediaPlaceholder(media);
  const transcript = m.transcript?.trim();
  const base = mediaPlaceholder(media)!;
  if (transcript) return `${base}: ${transcript}`;
  if (!m.transcription) return base;
  return `${base.slice(0, -1)} — ${transcriptionPlaceholderNote(m.transcription)}]`;
}

function renderMessage(
  m: StoredMessage,
  senderName: (m: Pick<StoredMessage, "outgoing" | "senderId" | "senderName">) => string,
  replies: ReadonlyMap<number, StoredMessage>,
  topic: string | undefined,
): string {
  const time = topic ? `**${formatTime(m.ts)}** [#${topic}]` : `**${formatTime(m.ts)}**`;
  const sender = senderName(m);
  if (m.service) return `${time} _${sender} ${servicePhrase(m.service)}_`;

  let quote = "";
  const target = m.replyToId !== undefined ? replies.get(m.replyToId) : undefined;
  if (target) {
    const quoted = target.text.split("\n")[0] || (target.media && mediaPlaceholder(target.media));
    if (quoted) quote = `> _${senderName(target)}: ${quoted}_\n`;
  }

  const parts: string[] = [];
  if (m.forwardFrom) parts.push(`(forwarded from ${m.forwardFrom})`);
  const placeholder = m.media ? messagePlaceholder(m) : undefined;
  if (placeholder) parts.push(placeholder);
  if (m.text) parts.push(m.text);
  const edited = m.editTs ? " (edited)" : "";
  return `${quote}${time} ${sender}: ${parts.join(" ")}${edited}`;
}
