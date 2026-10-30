// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One document per channel per UTC day, the shape WhatsApp uses: a day of a
 * channel reads as one conversation, and a busy server does not become a
 * million one-line documents.
 */

import { cleanPersonName, computeContentHash } from "@omnesis/core";
import { channelDayExternalId, RENDERED_MESSAGE_TYPES } from "./types.js";
import type { ProviderId, SourceId, DocumentInput, PersonMention } from "@omnesis/types";
import type { ChannelRef, DiscordMessage, DiscordUser } from "./types.js";

export interface NormalizeContext {
  providerId: ProviderId;
  sourceId: SourceId;
  /** The operator's own Discord user id, so their messages resolve to the self person. */
  selfUserId?: string;
}

/** Platform handle, namespaced so it cannot fuse with another platform's ids. */
export function discordLid(userId: string): string {
  return `discord:${userId}`;
}

/** The display name when it survives cleaning, else the username (non-empty, never an address). */
function displayName(user: DiscordUser): string {
  return cleanPersonName(user.global_name ?? undefined) ?? user.username;
}

/** A bot user, or a webhook post whose "author" is the webhook itself. */
function isAutomated(user: DiscordUser, msg?: DiscordMessage): boolean {
  return user.bot === true || msg?.webhook_id !== undefined;
}

/** Longest day document rendered; a day past it ends with a count of what was left out. */
export const MAX_CONTENT_CHARS = 200_000;

/** Opens the exact message in the Discord web or desktop app. */
function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** `Server #channel`, or `Server #parent › thread` for a thread or forum post. */
function channelLabel(channel: ChannelRef): string {
  return channel.parentName
    ? `${channel.guildName} #${channel.parentName} › ${channel.name}`
    : `${channel.guildName} #${channel.name}`;
}

/** Discord stamps `+00:00` offsets; the corpus carries canonical `Z` instants. */
function toIso(ts: string): string {
  return new Date(ts).toISOString();
}

function formatTime(ts: string): string {
  return toIso(ts).slice(11, 16);
}

/**
 * Replace Discord's mention markup with readable text: `<@id>` becomes the
 * mentioned user's name, custom emoji shrink to `:name:`. Channel and role
 * mentions keep their ids — the message carries no names for them.
 */
export function renderMentions(content: string, mentions: DiscordUser[] | undefined): string {
  const byId = new Map((mentions ?? []).map((u) => [u.id, displayName(u)]));
  return content
    .replace(/<@!?(\d+)>/g, (m, id: string) => {
      const name = byId.get(id);
      return name ? `@${name}` : m;
    })
    .replace(/<a?:(\w+):\d+>/g, ":$1:");
}

export function renderMessage(msg: DiscordMessage): string {
  const parts: string[] = [];
  const text = renderMentions(msg.content, msg.mentions).trim();
  if (text) parts.push(text);
  for (const a of msg.attachments ?? []) parts.push(`[Attachment: ${a.filename}]`);
  for (const e of msg.embeds ?? []) {
    const label = e.title?.trim() || e.url || e.description?.split("\n")[0]?.slice(0, 80);
    if (label) parts.push(`[Embed: ${label}]`);
  }
  if (parts.length === 0) return "";

  let line = `**${formatTime(msg.timestamp)}** ${displayName(msg.author)}: ${parts.join(" ")}`;
  if (msg.edited_timestamp) line += " _(edited)_";

  const ref = msg.referenced_message;
  if (ref) {
    const quoted = renderMentions(ref.content, ref.mentions).split("\n")[0].trim();
    line = `> _${displayName(ref.author)}: ${quoted || "…"}_\n${line}`;
  }
  return line;
}

/**
 * Render one channel's messages of one UTC day. `messages` must be that
 * day's, oldest first. Returns `null` when nothing renders — a day that only
 * saw system notices produces no document.
 */
export function normalizeChannelDay(
  channel: ChannelRef,
  day: string,
  messages: DiscordMessage[],
  ctx: NormalizeContext,
): DocumentInput | null {
  const rendered = messages
    .filter((m) => RENDERED_MESSAGE_TYPES.has(m.type))
    .map((m) => ({ msg: m, line: renderMessage(m) }))
    .filter((r) => r.line !== "");
  if (rendered.length === 0) return null;

  const title = `${channelLabel(channel)} — ${day}`;
  const lines = [`# ${title}`, ""];
  let length = lines[0].length + 1;
  let shown = 0;
  for (const { line } of rendered) {
    if (length + line.length > MAX_CONTENT_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    shown++;
  }
  const omitted = rendered.length - shown;
  if (omitted > 0) lines.push("", `_… ${omitted} more messages not shown_`);
  const content = lines.join("\n");

  const people: PersonMention[] = [];
  const participants = new Map<string, string>();
  for (const { msg } of rendered) {
    const author = msg.author;
    if (isAutomated(author, msg) || participants.has(author.id)) continue;
    const name = displayName(author);
    participants.set(author.id, name);
    people.push({
      role: "participant",
      name,
      lids: [discordLid(author.id)],
      ...(ctx.selfUserId === author.id ? { isSelf: true } : {}),
    });
  }
  const mentioned = new Set<string>();
  for (const { msg } of rendered) {
    for (const user of msg.mentions ?? []) {
      if (isAutomated(user) || participants.has(user.id) || mentioned.has(user.id)) continue;
      mentioned.add(user.id);
      people.push({
        role: "mentioned",
        name: displayName(user),
        lids: [discordLid(user.id)],
        ...(ctx.selfUserId === user.id ? { isSelf: true } : {}),
      });
    }
  }

  const first = rendered[0].msg;
  let updatedAt = toIso(rendered[rendered.length - 1].msg.timestamp);
  for (const { msg } of rendered) {
    if (!msg.edited_timestamp) continue;
    const edited = toIso(msg.edited_timestamp);
    if (edited > updatedAt) updatedAt = edited;
  }

  return {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: channelDayExternalId(channel.id, day),
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      sourceUrl: messageUrl(channel.guildId, channel.id, first.id),
      documentType: "conversation",
      people,
      extra: {
        guildId: channel.guildId,
        guildName: channel.guildName,
        channelId: channel.id,
        channelName: channel.name,
        channelKind: channel.kind,
        ...(channel.parentName ? { parentChannelName: channel.parentName } : {}),
        participants: [...participants.values()],
        messageCount: rendered.length,
        date: day,
      },
    },
    sourceCreatedAt: toIso(first.timestamp),
    sourceUpdatedAt: updatedAt,
  };
}
