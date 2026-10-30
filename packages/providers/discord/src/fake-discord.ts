// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory stand-in for the Discord REST API, driven through `fetchImpl`.
 * Test-only. Every identity here is invented.
 */

import { snowflakeAt } from "./types.js";
import type { DiscordChannel, DiscordGuild, DiscordMessage, DiscordUser } from "./types.js";

export const BOT: DiscordUser = {
  id: "900000000000000001",
  username: "omnesis-indexer",
  bot: true,
};
export const MAYA: DiscordUser = {
  id: "100000000000000001",
  username: "maya.reeves",
  global_name: "Maya Reeves",
};
export const JAMIE: DiscordUser = {
  id: "100000000000000002",
  username: "jamielopez",
  global_name: "Jamie Lopez",
};
export const DAVID: DiscordUser = {
  id: "100000000000000003",
  username: "dlin",
  global_name: "David Lin",
};
export const SARAH: DiscordUser = {
  id: "100000000000000004",
  username: "smendez",
  global_name: null,
};
export const TICKER_BOT: DiscordUser = { id: "900000000000000002", username: "ticker", bot: true };

let seq = 0;

/** A snowflake created at `iso`, unique and increasing within a test file. */
function idAt(iso: string): string {
  seq += 1;
  return (BigInt(snowflakeAt(Date.parse(iso))) + BigInt(seq)).toString();
}

export function msg(
  channelId: string,
  author: DiscordUser,
  iso: string,
  content: string,
  extra: Partial<DiscordMessage> = {},
): DiscordMessage {
  return {
    id: idAt(iso),
    channel_id: channelId,
    author,
    content,
    timestamp: iso,
    type: 0,
    ...extra,
  };
}

interface FakeGuild extends DiscordGuild {
  channels: DiscordChannel[];
  activeThreads: DiscordChannel[];
}

export class FakeDiscord {
  me: DiscordUser = BOT;
  readonly guilds = new Map<string, FakeGuild>();
  /** The application the bot token belongs to; its id is an invite URL's `client_id`. */
  applicationId = "800000000000000001";
  readonly archived = new Map<string, DiscordChannel[]>();
  readonly messages = new Map<string, DiscordMessage[]>();
  /** Channel ids the bot may not read (403 on every channel route). */
  readonly forbidden = new Set<string>();
  /** Guild ids whose channel listing is refused. */
  readonly forbiddenGuilds = new Set<string>();
  /** Scripted responses by path prefix, consumed first-in first-out. */
  readonly scripted: Array<{
    match: string;
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [];
  readonly requests: Array<{ path: string; headers: Record<string, string> }> = [];

  addGuild(id: string, name: string): FakeGuild {
    const g: FakeGuild = { id, name, channels: [], activeThreads: [] };
    this.guilds.set(id, g);
    return g;
  }

  addChannel(guildId: string, channel: DiscordChannel): DiscordChannel {
    const full = { guild_id: guildId, ...channel };
    this.guilds.get(guildId)!.channels.push(full);
    this.messages.set(channel.id, this.messages.get(channel.id) ?? []);
    return full;
  }

  addThread(
    guildId: string,
    thread: DiscordChannel,
    opts: { archived?: boolean; archivedAt?: string } = {},
  ): DiscordChannel {
    const full = {
      guild_id: guildId,
      thread_metadata: {
        archived: opts.archived ?? false,
        archive_timestamp: opts.archivedAt ?? "2026-03-09T00:00:00.000Z",
      },
      ...thread,
    };
    if (opts.archived) {
      const list = this.archived.get(thread.parent_id!) ?? [];
      list.push(full);
      this.archived.set(thread.parent_id!, list);
    } else {
      this.guilds.get(guildId)!.activeThreads.push(full);
    }
    this.messages.set(thread.id, this.messages.get(thread.id) ?? []);
    return full;
  }

  post(message: DiscordMessage): DiscordMessage {
    const list = this.messages.get(message.channel_id) ?? [];
    list.push(message);
    list.sort((a, b) => (safeBigInt(a.id) < safeBigInt(b.id) ? -1 : 1));
    this.messages.set(message.channel_id, list);
    return message;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v\d+/, "") + url.search;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    this.requests.push({ path, headers });

    const scriptedIdx = this.scripted.findIndex((s) => path.startsWith(s.match));
    if (scriptedIdx >= 0) {
      const [s] = this.scripted.splice(scriptedIdx, 1);
      return reply(s.status, s.body ?? { message: "scripted" }, s.headers);
    }
    if (headers.authorization !== `Bot valid-token`) {
      return reply(401, { message: "401: Unauthorized" });
    }

    let m: RegExpMatchArray | null;
    if (path === "/users/@me") return reply(200, this.me);
    if (path === "/oauth2/applications/@me") return reply(200, { id: this.applicationId });
    if (path.startsWith("/users/@me/guilds")) {
      return reply(
        200,
        [...this.guilds.values()].map(({ id, name }) => ({ id, name })),
      );
    }
    if ((m = path.match(/^\/guilds\/(\d+)\/channels$/))) {
      if (this.forbiddenGuilds.has(m[1])) return reply(403, { message: "Missing Access" });
      return reply(200, this.guilds.get(m[1])?.channels ?? []);
    }
    if ((m = path.match(/^\/guilds\/(\d+)\/threads\/active$/))) {
      return reply(200, { threads: this.guilds.get(m[1])?.activeThreads ?? [], members: [] });
    }
    if ((m = path.match(/^\/channels\/(\d+)\/threads\/archived\/public/))) {
      if (this.forbidden.has(m[1])) return reply(403, { message: "Missing Access" });
      // Newest archive first, `before` exclusive, `limit` per page — as Discord pages it.
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const all = [...(this.archived.get(m[1]) ?? [])].sort((a, b) =>
        archivedAt(b).localeCompare(archivedAt(a)),
      );
      const eligible = before ? all.filter((t) => archivedAt(t) < before) : all;
      const threads = eligible.slice(0, limit);
      return reply(200, { threads, members: [], has_more: eligible.length > threads.length });
    }
    if ((m = path.match(/^\/channels\/(\d+)\/messages\?limit=(\d+)&after=(\d+)$/))) {
      if (this.forbidden.has(m[1])) return reply(403, { message: "Missing Access" });
      if (!this.messages.has(m[1])) return reply(404, { message: "Unknown Channel" });
      const after = BigInt(m[3]);
      const limit = Number(m[2]);
      const rows = (this.messages.get(m[1]) ?? [])
        .filter((r) => safeBigInt(r.id) > after)
        .slice(0, limit);
      // Discord answers newest first; the client sorts.
      return reply(200, [...rows].reverse());
    }
    return reply(404, { message: `no route for ${path}` });
  };
}

function archivedAt(t: DiscordChannel): string {
  return t.thread_metadata?.archive_timestamp ?? "";
}

/** Malformed fixture rows (a missing or junk id) sort first and are never "after" anything. */
function safeBigInt(id: unknown): bigint {
  return typeof id === "string" && /^\d+$/.test(id) ? BigInt(id) : -1n;
}

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}
