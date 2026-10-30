// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DiscordClient } from "./client.js";

/** Shared per-account context handed to the source entry. */
export interface DiscordContext {
  client: DiscordClient;
  accountId: string;
  dataCutoff?: string;
  configDir?: string;
}

// ---------------------------------------------------------------------------
// Discord API rows — only the fields the source reads.
// ---------------------------------------------------------------------------

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  parent_id?: string | null;
  thread_metadata?: { archived: boolean; archive_timestamp?: string; locked?: boolean };
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  /** ISO 8601, UTC. */
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
  mentions?: DiscordUser[];
  referenced_message?: DiscordMessage | null;
  /** Present on a message posted through a webhook; its author is then not a real user. */
  webhook_id?: string;
}

/**
 * The fields the normalizer reads. A row Discord hands back without them is
 * skipped and logged rather than failing the whole page.
 */
export function isWellFormedMessage(m: unknown): m is DiscordMessage {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  const author = r.author as Record<string, unknown> | undefined;
  return (
    typeof r.id === "string" &&
    /^\d+$/.test(r.id) &&
    typeof r.timestamp === "string" &&
    Number.isFinite(Date.parse(r.timestamp)) &&
    typeof r.type === "number" &&
    typeof r.content === "string" &&
    typeof author === "object" &&
    author !== null &&
    typeof author.id === "string" &&
    typeof author.username === "string"
  );
}

/** Channel types (https://docs.discord.com/developers/resources/channel). */
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

/** Message types rendered into a day document; everything else is a system notice. */
export const RENDERED_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  0, // DEFAULT
  19, // REPLY
  20, // CHAT_INPUT_COMMAND
]);

export type ChannelKind = "text" | "announcement" | "thread" | "forum-post";

/**
 * A channel queued for the running cycle — what a day document needs besides
 * its messages. Serialised into the cursor, so it stays plain JSON.
 */
export interface ChannelRef {
  id: string;
  guildId: string;
  guildName: string;
  name: string;
  kind: ChannelKind;
  /** The text or forum channel a thread hangs off. */
  parentName?: string;
  /** Resume point when one call's page cap hit mid-channel (see source.ts). */
  after?: string;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface ChannelState {
  /** Newest message id rendered into a document. */
  lastId: string;
  /** UTC day of `lastId` — the one day re-rendered on every visit. */
  lastDay?: string;
  /** Content hash of that day's document, so an edit or deletion re-emits it and an unchanged day is a no-op. */
  lastHash?: string;
}

/** What one cycle has seen so far, carried in the cursor so it spans calls. */
export interface CycleCounts {
  readable: number;
  unreadable: number;
  readableMessages?: number;
  blankMessages?: number;
}

export interface DiscordCursor extends SyncCursor {
  v: 1;
  channels: Record<string, ChannelState>;
  /** Channels still to visit this cycle; absent between cycles. */
  queue?: ChannelRef[];
  /**
   * How many channels this cycle could and could not read, so a bot with no
   * access anywhere is reported, not silent, and how many of its messages
   * carried a body — a cycle of nothing but blanked messages means the
   * Message Content intent is off. Message counts are absent on a cursor
   * written before they were kept.
   */
  cycle?: CycleCounts;
}

export function isDiscordCursor(v: unknown): v is DiscordCursor {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (c.v !== 1) return false;
  if (typeof c.channels !== "object" || c.channels === null) return false;
  for (const state of Object.values(c.channels as Record<string, unknown>)) {
    if (typeof state !== "object" || state === null) return false;
    const s = state as Partial<ChannelState>;
    if (typeof s.lastId !== "string") return false;
    if (s.lastDay !== undefined && typeof s.lastDay !== "string") return false;
    if (s.lastHash !== undefined && typeof s.lastHash !== "string") return false;
  }
  if (c.queue !== undefined) {
    // The source never writes an empty queue; one would leave every call with nothing to visit.
    if (!Array.isArray(c.queue) || c.queue.length === 0) return false;
    if (!c.queue.every((r) => typeof (r as ChannelRef | null)?.id === "string")) return false;
  }
  if (c.cycle !== undefined) {
    const cy = c.cycle as Partial<Record<string, unknown>> | null;
    if (typeof cy?.readable !== "number" || typeof cy.unreadable !== "number") return false;
    if (cy.readableMessages !== undefined && typeof cy.readableMessages !== "number") return false;
    if (cy.blankMessages !== undefined && typeof cy.blankMessages !== "number") return false;
  }
  return true;
}

export const validateDiscordCursor = makeCursorValidator(isDiscordCursor);

// ---------------------------------------------------------------------------
// Snowflakes
// ---------------------------------------------------------------------------

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Creation time of a snowflake id, in epoch milliseconds. */
function snowflakeTimestampMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake a message created at `ms` could carry. */
export function snowflakeAt(ms: number): string {
  const rel = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH_MS;
  return rel <= 0n ? "0" : (rel << 22n).toString();
}

/** UTC calendar day (`YYYY-MM-DD`) of an ISO timestamp, whatever offset it is written with. */
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** `after` value that admits every message from the start of `id`'s UTC day. */
export function dayStartAfter(id: string): string {
  const day = new Date(snowflakeTimestampMs(id));
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const first = BigInt(snowflakeAt(start));
  return first === 0n ? "0" : (first - 1n).toString();
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function channelDayExternalId(channelId: string, day: string): string {
  return `${channelId}:${day}`;
}
