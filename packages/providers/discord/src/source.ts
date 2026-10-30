// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sync loop. A cycle enumerates every channel the bot can read — text and
 * announcement channels, active threads, archived public threads — into the
 * cursor's queue, then drains it one channel at a time: each channel is
 * paged with `GET /channels/{id}/messages?after=` from the start of the UTC
 * day its last indexed message fell on, so that day's document is
 * re-rendered whole, and one document is emitted per channel-day that gained
 * a message. The last indexed day is compared by content hash on every
 * visit, so an edit or a deletion on it lands too, and a day whose messages
 * all vanished is tombstoned.
 *
 * One `sync()` call visits several quiet channels in a row (up to
 * `channelsPerCall`) and hands the cursor back as soon as a channel produces
 * work, so an idle server costs a few empty pages per tick rather than one
 * per channel — the collector sleeps after every empty `hasMore` page.
 *
 * Deliberately not done, and why:
 *  - No snapshot. Discord's REST API has no deletion feed, and enumerating
 *    every message ever sent on every cycle is the only way to learn what
 *    vanished — a day older than the channel's last indexed one keeps its
 *    document whatever happened to its messages, and so does a deleted
 *    channel.
 *  - Edits and deletions land only on the last indexed day; an older day is
 *    never re-fetched.
 */

import { createLogger } from "@omnesis/core";
import { applyDataCutoff, syncPage } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { PERMISSION_REMEDIATION } from "./client.js";
import { normalizeChannelDay } from "./normalizer.js";
import {
  CHANNEL_TYPE,
  channelDayExternalId,
  compareSnowflakes,
  dayStartAfter,
  RENDERED_MESSAGE_TYPES,
  snowflakeAt,
  utcDay,
} from "./types.js";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId, SyncRemediation } from "@omnesis/types";
import type { DiscordClient } from "./client.js";
import type {
  ChannelKind,
  ChannelRef,
  ChannelState,
  CycleCounts,
  DiscordChannel,
  DiscordCursor,
  DiscordMessage,
} from "./types.js";

const log = createLogger("source:discord");

/** Message pages (of 100) fetched per channel visit before the cursor is handed back. */
const DEFAULT_PAGES_PER_CALL = 10;

/**
 * Pages a single UTC day may run to before it is emitted in parts. A day
 * this long is fetched whole across the per-visit cap so its document is not
 * cut at an arbitrary page boundary.
 */
const MAX_PAGES_PER_DAY = 50;

/** Day documents emitted per visit — a sparse channel's history lands in slices the writer can absorb. */
const MAX_DAYS_PER_CALL = 100;

/** Quiet channels visited in one `sync()` call before the cursor is handed back. */
const DEFAULT_CHANNELS_PER_CALL = 25;

/** Archived-thread pages (of 100) enumerated per parent channel per cycle. */
const MAX_ARCHIVED_THREAD_PAGES = 5;

const TEXT_TYPES: ReadonlySet<number> = new Set([
  CHANNEL_TYPE.GUILD_TEXT,
  CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
]);
const THREAD_PARENT_TYPES: ReadonlySet<number> = new Set([
  CHANNEL_TYPE.GUILD_TEXT,
  CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  CHANNEL_TYPE.GUILD_FORUM,
  CHANNEL_TYPE.GUILD_MEDIA,
]);
const FORUM_TYPES: ReadonlySet<number> = new Set([
  CHANNEL_TYPE.GUILD_FORUM,
  CHANNEL_TYPE.GUILD_MEDIA,
]);

/**
 * Where the operator actually invites the bot. The link is generated from
 * the application the token belongs to, with View Channels and Read Message
 * History already selected, so inviting is one click on one server picker
 * instead of a walk through the Developer Portal's URL Generator. Asking
 * Discord for the application id can itself fail; the wording then falls
 * back to the manual route.
 */
function noServerRemediation(inviteUrl: string | undefined): SyncRemediation {
  return {
    summary: "The bot is not in any server Omnesis should index",
    steps: [
      inviteUrl
        ? `Open ${inviteUrl} and add the bot to each server you want indexed — you need Manage Server on it.`
        : "Invite the bot to the server: Developer Portal → your application → OAuth2 → URL Generator, scope `bot`, permissions View Channels and Read Message History.",
      "If the source names servers in its `guilds` setting, check each id is one the bot was invited to.",
    ],
    restartRequired: false,
  };
}

/**
 * Discord does not refuse a bot whose Message Content intent is off. It
 * answers normally and blanks `content`, `attachments` and `embeds` on every
 * message the bot neither wrote nor was mentioned in, so the symptom is a
 * sync that runs clean and indexes nothing readable. Saying so is the whole
 * point of this check.
 */
const MESSAGE_CONTENT_REMEDIATION: SyncRemediation = {
  summary:
    "The bot's Message Content intent is off, so Discord blanks every message body it serves",
  steps: [
    "Open the Developer Portal → your application → Bot → Privileged Gateway Intents.",
    "Turn on Message Content Intent and save.",
  ],
  restartRequired: false,
};

/**
 * Blank messages a cycle may see before the intent is blamed. Counted across
 * the cycle rather than the call, because a server of small channels hands
 * one call a handful of messages at a time and would otherwise index blanks
 * forever without ever crossing the line.
 */
const BLANK_CONTENT_THRESHOLD = 50;

/**
 * Tally one page onto the running cycle. Only message types the normalizer
 * renders are counted: a join or a pin notice carries no body of its own
 * whatever the intent is.
 */
function tallyContent(messages: readonly DiscordMessage[], cycle: CycleCounts): void {
  for (const m of messages) {
    if (!RENDERED_MESSAGE_TYPES.has(m.type)) continue;
    if (m.content.trim() || m.attachments?.length || m.embeds?.length) {
      cycle.readableMessages = (cycle.readableMessages ?? 0) + 1;
    } else {
      cycle.blankMessages = (cycle.blankMessages ?? 0) + 1;
    }
  }
}

export interface DiscordSourceOptions {
  client: DiscordClient;
  providerId: ProviderId;
  sourceId: SourceId;
  dataCutoff?: string;
  /** Only these guild ids are indexed; undefined means every guild the bot is in. */
  guildIds?: string[];
  selfUserId?: string;
  pagesPerCall?: number;
  daysPerCall?: number;
  channelsPerCall?: number;
}

interface ChannelOutcome {
  docs: DocumentInput[];
  deleted: string[];
  /** False when the per-visit cap hit first; the resume point then sits on `ref.after`. */
  done: boolean;
  access: "ok" | "forbidden" | "gone";
}

export class DiscordSource {
  private readonly opts: DiscordSourceOptions;
  private readonly pagesPerCall: number;
  private readonly daysPerCall: number;
  private readonly channelsPerCall: number;
  /** Start of the data cutoff's UTC day, so a cut day is either whole or absent. */
  private readonly cutoffDayStart: Date | undefined;

  constructor(opts: DiscordSourceOptions) {
    this.opts = opts;
    this.pagesPerCall = opts.pagesPerCall ?? DEFAULT_PAGES_PER_CALL;
    this.daysPerCall = opts.daysPerCall ?? MAX_DAYS_PER_CALL;
    this.channelsPerCall = opts.channelsPerCall ?? DEFAULT_CHANNELS_PER_CALL;
    const ms = opts.dataCutoff ? Date.parse(opts.dataCutoff) : NaN;
    this.cutoffDayStart = Number.isFinite(ms) ? new Date(utcDayStart(ms)) : undefined;
  }

  async sync(cursor: DiscordCursor | null, opts?: SyncOptions): Promise<SyncResult<DiscordCursor>> {
    try {
      return await this.runSync(cursor, opts?.signal);
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError("unknown", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  private async runSync(
    cursor: DiscordCursor | null,
    signal: AbortSignal | undefined,
  ): Promise<SyncResult<DiscordCursor>> {
    const cur: DiscordCursor = cursor
      ? {
          v: 1,
          channels: { ...cursor.channels },
          queue: cursor.queue?.map((r) => ({ ...r })),
          cycle: cursor.cycle ? { ...cursor.cycle } : undefined,
        }
      : { v: 1, channels: {} };

    let startedCycle = false;
    if (!cur.queue) {
      const queue = await this.enumerate(signal);
      log.info(`Cycle start: ${queue.length} channels to visit`);
      if (queue.length === 0) return syncPage([], { v: 1, channels: cur.channels });
      cur.queue = queue;
      cur.cycle = { readable: 0, unreadable: 0 };
      startedCycle = true;
    }
    cur.cycle ??= { readable: 0, unreadable: 0 };

    const docs: DocumentInput[] = [];
    const deleted: string[] = [];
    for (let visits = 0; visits < this.channelsPerCall && cur.queue.length > 0; visits++) {
      const ref = cur.queue[0];
      const out = await this.syncChannel(ref, cur, cur.cycle, signal);
      docs.push(...out.docs);
      deleted.push(...out.deleted);
      if (out.done) {
        cur.queue.shift();
        if (out.access === "ok") cur.cycle.readable++;
        else if (out.access === "forbidden") cur.cycle.unreadable++;
        else delete cur.channels[ref.id];
      }
      // Hand work back as soon as there is any; a channel mid-drain stays at the head.
      if (out.docs.length > 0 || out.deleted.length > 0 || !out.done) break;
    }

    // Thrown before the page is returned: the documents it would carry are
    // the blanked ones. Pinning the cursor here is the point — unlike a
    // refused channel, a blanked one reads properly the moment the intent is
    // turned on, so re-reading exactly these messages is what should happen.
    const blank = cur.cycle.blankMessages ?? 0;
    if (!cur.cycle.readableMessages && blank >= BLANK_CONTENT_THRESHOLD) {
      throw new SyncError(
        "permission",
        `Discord returned ${blank} messages with no content, no attachment and no embed.`,
        { remediation: MESSAGE_CONTENT_REMEDIATION },
      );
    }

    if (cur.queue.length === 0) {
      const { readable, unreadable } = cur.cycle;
      delete cur.queue;
      delete cur.cycle;
      if (readable === 0 && unreadable > 0) {
        const message = `Discord refused every one of the ${unreadable} channels this bot can see.`;
        // Thrown only from the call that also enumerated: a thrown page keeps
        // no cursor, so the persisted one is the queue-less previous cycle
        // and the next tick enumerates afresh — a grant made meanwhile is
        // seen. Thrown later it would pin the cursor on the last channel.
        if (startedCycle) {
          throw new SyncError("permission", message, { remediation: PERMISSION_REMEDIATION });
        }
        log.error(`${message} ${PERMISSION_REMEDIATION.steps.join(" ")}`);
      }
    }

    return syncPage(applyDataCutoff(docs, this.cutoffDayStart, log, "conversations"), cur, {
      hasMore: cur.queue !== undefined,
      deletedExternalIds: deleted,
    });
  }

  /**
   * Fetch one channel from `start`, oldest first: up to `pagesPerCall`
   * pages, extended while the UTC day it started in is still open so a long
   * day is fetched whole, and stopped early once more than `daysPerCall`
   * days are in hand.
   */
  private async fetchFrom(
    ref: ChannelRef,
    start: string,
    signal: AbortSignal | undefined,
  ): Promise<{ fetched: DiscordMessage[]; complete: boolean } | "forbidden" | "gone"> {
    const fetched: DiscordMessage[] = [];
    const days = new Set<string>();
    let after = start;
    for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
      const res = await this.opts.client.listMessages(ref.id, after, signal);
      if (res.kind !== "ok") return res.kind;
      for (const row of res.rows) {
        fetched.push(row);
        days.add(utcDay(row.timestamp));
      }
      if (!res.full) return { fetched, complete: true };
      if (res.after === undefined) return { fetched, complete: false };
      after = res.after;
      if (days.size > this.daysPerCall) break;
      // Past the per-visit cap, keep going only while the newest day is the
      // day we started in — otherwise the caller holds it back whole.
      if (page + 1 >= this.pagesPerCall && dayStartAfter(after) !== start) break;
    }
    return { fetched, complete: false };
  }

  private async syncChannel(
    ref: ChannelRef,
    cur: DiscordCursor,
    cycle: CycleCounts,
    signal: AbortSignal | undefined,
  ): Promise<ChannelOutcome> {
    const state = cur.channels[ref.id];
    const start = ref.after ?? (state ? dayStartAfter(state.lastId) : this.cutoffAfter());

    const page = await this.fetchFrom(ref, start, signal);
    if (page === "gone") {
      log.info(`#${ref.name} (${ref.id}) no longer exists — skipped`);
      return { docs: [], deleted: [], done: true, access: "gone" };
    }
    if (page === "forbidden") {
      log.warn(`#${ref.name} (${ref.id}): the bot may not read it — skipped this cycle`);
      return { docs: [], deleted: [], done: true, access: "forbidden" };
    }
    let { fetched } = page;
    const { complete } = page;
    tallyContent(fetched, cycle);

    if (fetched.length === 0) {
      // The last indexed day's messages are all gone: its document goes with them.
      if (state?.lastDay !== undefined && state.lastHash !== undefined && !ref.after) {
        cur.channels[ref.id] = { lastId: state.lastId, lastDay: state.lastDay };
        return {
          docs: [],
          deleted: [channelDayExternalId(ref.id, state.lastDay)],
          done: true,
          access: "ok",
        };
      }
      return { docs: [], deleted: [], done: true, access: "ok" };
    }

    // Hold back what the next visit should render whole: the newest, possibly
    // half-fetched day when the page cap hit, and every day past the per-visit
    // day cap. Both resume from the start of the first held-back day.
    let holdFrom: string | undefined;
    if (!complete) holdFrom = dayStartAfter(fetched[fetched.length - 1].id);
    const days = new Set<string>();
    for (const m of fetched) {
      days.add(utcDay(m.timestamp));
      if (days.size > this.daysPerCall) {
        const first = dayStartAfter(m.id);
        if (holdFrom === undefined || compareSnowflakes(first, holdFrom) < 0) holdFrom = first;
        break;
      }
    }
    let done = complete && holdFrom === undefined;
    if (holdFrom !== undefined) {
      if (compareSnowflakes(holdFrom, start) > 0) {
        fetched = fetched.filter((m) => compareSnowflakes(m.id, holdFrom) <= 0);
        ref.after = holdFrom;
        done = false;
      } else {
        // ponytail: one UTC day longer than MAX_PAGES_PER_DAY pages is rendered
        // from this visit's messages only and overwritten by the next part;
        // buffer the day in the cursor if such channels matter.
        ref.after = fetched[fetched.length - 1].id;
        done = false;
        log.warn(
          `#${ref.name}: a single day exceeds ${MAX_PAGES_PER_DAY * 100} messages — emitted in parts`,
        );
      }
    }
    if (fetched.length === 0) return { docs: [], deleted: [], done, access: "ok" };

    const byDay = new Map<string, DiscordMessage[]>();
    for (const m of fetched) {
      const day = utcDay(m.timestamp);
      const bucket = byDay.get(day);
      if (bucket) bucket.push(m);
      else byDay.set(day, [m]);
    }
    const newest = fetched[fetched.length - 1].id;
    const newestDay = utcDay(fetched[fetched.length - 1].timestamp);
    const docs: DocumentInput[] = [];
    const deleted: string[] = [];
    const next: ChannelState = { lastId: newest, lastDay: newestDay };
    if (state && compareSnowflakes(newest, state.lastId) < 0) next.lastId = state.lastId;

    // The day indexed last was re-fetched whole and is judged by content: a
    // changed hash re-emits it, a day that now renders nothing is removed.
    const watched = state?.lastDay;
    if (watched !== undefined && state?.lastHash !== undefined && !byDay.has(watched)) {
      deleted.push(channelDayExternalId(ref.id, watched));
    }
    for (const [day, messages] of byDay) {
      const isWatched = day === watched;
      // An older day whose newest message was already indexed is unchanged.
      if (
        !isWatched &&
        day !== newestDay &&
        state &&
        compareSnowflakes(messages[messages.length - 1].id, state.lastId) <= 0
      ) {
        continue;
      }
      const doc = normalizeChannelDay(ref, day, messages, {
        providerId: this.opts.providerId,
        sourceId: this.opts.sourceId,
        selfUserId: this.opts.selfUserId,
      });
      if (day === newestDay) next.lastHash = doc?.contentHash;
      if (isWatched) {
        if (doc?.contentHash === state?.lastHash) continue;
        if (doc) docs.push(doc);
        else if (state?.lastHash !== undefined) deleted.push(channelDayExternalId(ref.id, day));
        continue;
      }
      if (doc) docs.push(doc);
    }
    cur.channels[ref.id] = next;
    if (docs.length > 0 || deleted.length > 0) {
      log.info(
        `#${ref.name}: ${fetched.length} messages → ${docs.length} day documents${deleted.length ? `, ${deleted.length} removed` : ""}`,
      );
    }
    return { docs, deleted, done, access: "ok" };
  }

  /** `after` for a channel's first visit: the start of the cutoff's UTC day, or the dawn of time. */
  private cutoffAfter(): string {
    if (!this.cutoffDayStart) return "0";
    return dayStartAfter(snowflakeAt(this.cutoffDayStart.getTime()));
  }

  /** Every channel the bot can read across the selected guilds. */
  private async enumerate(signal: AbortSignal | undefined): Promise<ChannelRef[]> {
    const guilds = await this.opts.client.listGuilds(signal);
    const wanted = this.opts.guildIds;
    const selected = wanted ? guilds.filter((g) => wanted.includes(g.id)) : guilds;
    if (wanted) {
      for (const id of wanted) {
        if (!guilds.some((g) => g.id === id)) {
          log.warn(`Guild ${id} is configured but the bot is not a member of it`);
        }
      }
    }
    if (selected.length === 0) {
      const inviteUrl = await this.opts.client.inviteUrl(signal).catch((err: unknown) => {
        log.warn(`Could not build the bot's invite link: ${(err as Error).message}`);
        return undefined;
      });
      throw new SyncError(
        "permission",
        wanted
          ? `The bot is not a member of any configured server (${wanted.join(", ")}).`
          : "The bot has not been invited to any server yet.",
        { remediation: noServerRemediation(inviteUrl) },
      );
    }

    const queue: ChannelRef[] = [];
    let refused: SyncError | undefined;
    let refusedCount = 0;
    for (const guild of selected) {
      try {
        queue.push(...(await this.enumerateGuild(guild.id, guild.name, signal)));
      } catch (err) {
        if (err instanceof SyncError && err.kind === "permission") {
          log.warn(`Skipping guild ${guild.name} (${guild.id}): ${err.message}`);
          refused = err;
          refusedCount++;
          continue;
        }
        throw err;
      }
    }
    if (refused && refusedCount === selected.length) {
      throw new SyncError(
        "permission",
        `Discord refused every one of the ${refusedCount} servers this bot is in: ${refused.message}`,
        { remediation: PERMISSION_REMEDIATION },
      );
    }
    return queue;
  }

  private async enumerateGuild(
    guildId: string,
    guildName: string,
    signal: AbortSignal | undefined,
  ): Promise<ChannelRef[]> {
    const { client } = this.opts;
    const channels = await client.listGuildChannels(guildId, signal);
    const byId = new Map(channels.map((c) => [c.id, c]));
    const refs: ChannelRef[] = [];

    for (const c of channels) {
      if (!TEXT_TYPES.has(c.type)) continue;
      const kind: ChannelKind =
        c.type === CHANNEL_TYPE.GUILD_ANNOUNCEMENT ? "announcement" : "text";
      refs.push({ id: c.id, guildId, guildName, name: c.name ?? c.id, kind });
    }

    const threads: DiscordChannel[] = await client.listActiveThreads(guildId, signal);
    for (const parent of channels) {
      if (!THREAD_PARENT_TYPES.has(parent.type)) continue;
      let before: string | undefined;
      for (let page = 0; page < MAX_ARCHIVED_THREAD_PAGES; page++) {
        const res = await client.listPublicArchivedThreads(parent.id, before, signal);
        if (!res || res.threads.length === 0) break;
        threads.push(...res.threads);
        before = res.threads[res.threads.length - 1].thread_metadata?.archive_timestamp;
        if (!res.hasMore || !before) break;
      }
    }

    const seen = new Set<string>();
    for (const t of threads) {
      if (seen.has(t.id) || t.type === CHANNEL_TYPE.PRIVATE_THREAD) continue;
      seen.add(t.id);
      const parent = t.parent_id ? byId.get(t.parent_id) : undefined;
      refs.push({
        id: t.id,
        guildId,
        guildName,
        name: t.name ?? t.id,
        kind: parent && FORUM_TYPES.has(parent.type) ? "forum-post" : "thread",
        parentName: parent?.name ?? undefined,
      });
    }
    return refs;
  }
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
