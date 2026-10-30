// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import { isWellFormedMessage } from "./types.js";
import type { DiscordChannel, DiscordGuild, DiscordMessage, DiscordUser } from "./types.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord requires a bot User-Agent of this shape; unmarked clients get Cloudflare errors. */
const USER_AGENT = "DiscordBot (https://omnesis.dev, 1.0)";

/** Total rate-limit wait slept through inline per request before the tick is deferred. */
const MAX_INLINE_RETRY_MS = 10_000;

const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [1_000, 3_000];

/** Page size Discord caps message and thread listings at. */
const MESSAGE_PAGE_SIZE = 100;

/**
 * One page of a channel's messages. `full` says whether Discord filled the
 * page — counting rows the normalizer cannot read, which are dropped here —
 * and `after` is the id to continue from, the newest well-formed row.
 */
export type MessagesPage =
  | { kind: "ok"; rows: DiscordMessage[]; full: boolean; after: string | undefined }
  | { kind: "gone" }
  | { kind: "forbidden" };

export interface DiscordClientOptions {
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export const PERMISSION_REMEDIATION = {
  summary: "The bot cannot read this server or channel.",
  steps: [
    "Open the server's settings → Integrations → the Omnesis bot.",
    "Grant the bot View Channels and Read Message History, on the server or on each channel it should index.",
  ],
  restartRequired: false,
};

/**
 * The only two permissions the bot is ever asked for: View Channels
 * (`1 << 10`) and Read Message History (`1 << 16`). Sending, managing and
 * moderating are all deliberately absent — a reader needs none of them.
 */
export const INVITE_PERMISSIONS = (1 << 10) | (1 << 16);

/**
 * The URL that adds this application's bot to a server, asking for nothing
 * beyond `INVITE_PERMISSIONS`. Generating it is what replaces walking the
 * operator through the Developer Portal's OAuth2 URL Generator and hoping
 * they tick the same two boxes.
 */
export function botInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
    applicationId,
  )}&scope=bot&permissions=${INVITE_PERMISSIONS}`;
}

/**
 * Thin client for the Discord REST API, authenticated with a bot token.
 * Every escaping error is a typed `SyncError`: 401 is `auth`, 403 is
 * `permission` with the grant the operator has to make, 429 is `rate-limit`
 * with Discord's own `retry_after`, and 5xx / network failures are retried
 * twice before surfacing as `transient` / `network`.
 */
export class DiscordClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(token: string, opts: DiscordClientOptions = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? DISCORD_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Liveness probe used by the auth flow: validates the token, returns the bot user. */
  async getMe(signal?: AbortSignal): Promise<DiscordUser> {
    return this.get<DiscordUser>("/users/@me", signal);
  }

  /**
   * The application the token belongs to. Its id is the `client_id` an
   * invite URL needs — asked for rather than assumed equal to the bot user's
   * id, which holds only for applications created since 2020.
   */
  async getApplicationId(signal?: AbortSignal): Promise<string> {
    const app = await this.get<{ id: string }>("/oauth2/applications/@me", signal);
    return app.id;
  }

  /** This bot's invite URL, read-only permissions already selected. */
  async inviteUrl(signal?: AbortSignal): Promise<string> {
    return botInviteUrl(await this.getApplicationId(signal));
  }

  /** Every guild the bot is a member of. */
  async listGuilds(signal?: AbortSignal): Promise<DiscordGuild[]> {
    const guilds: DiscordGuild[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.get<DiscordGuild[]>(
        `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`,
        signal,
      );
      guilds.push(...page);
      if (page.length < 200) return guilds;
      after = page[page.length - 1].id;
    }
  }

  /** A guild's channels — categories, text, voice, forums; never threads. */
  async listGuildChannels(guildId: string, signal?: AbortSignal): Promise<DiscordChannel[]> {
    return this.get<DiscordChannel[]>(`/guilds/${guildId}/channels`, signal);
  }

  /** Every thread in the guild that is not archived. */
  async listActiveThreads(guildId: string, signal?: AbortSignal): Promise<DiscordChannel[]> {
    const body = await this.get<{ threads: DiscordChannel[] }>(
      `/guilds/${guildId}/threads/active`,
      signal,
    );
    return body.threads;
  }

  /**
   * One page of a channel's archived public threads, newest archive first.
   * `null` when the channel is gone or the bot may not read it — the caller
   * skips it.
   */
  async listPublicArchivedThreads(
    channelId: string,
    before: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ threads: DiscordChannel[]; hasMore: boolean } | null> {
    const res = await this.request(
      `/channels/${channelId}/threads/archived/public?limit=100${
        before ? `&before=${encodeURIComponent(before)}` : ""
      }`,
      signal,
      [403, 404],
    );
    if (res.status === 403 || res.status === 404) return null;
    const body = (await res.json()) as { threads: DiscordChannel[]; has_more: boolean };
    return { threads: body.threads, hasMore: body.has_more };
  }

  /**
   * Up to 100 messages with an id greater than `after`, oldest first, minus
   * any row the normalizer could not read. A deleted channel is `gone`; one
   * the bot may not read is `forbidden` — the caller treats the two apart.
   */
  async listMessages(
    channelId: string,
    after: string,
    signal?: AbortSignal,
  ): Promise<MessagesPage> {
    const res = await this.request(
      `/channels/${channelId}/messages?limit=${MESSAGE_PAGE_SIZE}&after=${after}`,
      signal,
      [403, 404],
    );
    if (res.status === 404) return { kind: "gone" };
    if (res.status === 403) return { kind: "forbidden" };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new SyncError(
        "unknown",
        `Discord returned a non-list for channel ${channelId} messages.`,
      );
    }
    const rows = body.filter(isWellFormedMessage).sort((a, b) => compareIds(a.id, b.id));
    const full = body.length >= MESSAGE_PAGE_SIZE;
    if (full && rows.length === 0) {
      throw new SyncError(
        "unknown",
        `Discord returned a full page for channel ${channelId} with no readable message.`,
      );
    }
    return { kind: "ok", rows, full, after: rows[rows.length - 1]?.id };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.request(path, signal, []);
    return (await res.json()) as T;
  }

  private async request(
    path: string,
    signal: AbortSignal | undefined,
    allowStatuses: number[],
    attempt = 0,
    sleptMs = 0,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        signal,
        headers: {
          Authorization: `Bot ${this.token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < TRANSIENT_RETRIES) {
        await this.sleep(TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]);
        signal?.throwIfAborted();
        return this.request(path, signal, allowStatuses, attempt + 1, sleptMs);
      }
      throw new SyncError("network", `Discord request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (res.ok || allowStatuses.includes(res.status)) return res;

    if (res.status === 429) {
      // Per-route buckets refill in well under a second; sleep those through
      // inline, up to a budget per request, and defer only a long wait.
      const retryAfterMs = await retryAfterMsOf(res);
      if (sleptMs + retryAfterMs <= MAX_INLINE_RETRY_MS) {
        await this.sleep(retryAfterMs);
        signal?.throwIfAborted();
        return this.request(path, signal, allowStatuses, attempt, sleptMs + retryAfterMs);
      }
      throw new SyncError("rate-limit", "Discord rate limit exceeded.", { retryAfterMs });
    }

    if (res.status >= 500) {
      if (attempt < TRANSIENT_RETRIES) {
        await this.sleep(TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]);
        signal?.throwIfAborted();
        return this.request(path, signal, allowStatuses, attempt + 1, sleptMs);
      }
      throw new SyncError("transient", `Discord server error (HTTP ${res.status}).`);
    }

    if (res.status === 401) {
      throw new SyncError(
        "auth",
        "Discord rejected the token (HTTP 401): it was reset, revoked, mistyped, or is a user-account " +
          "token. Only a bot token from the application's Bot page works.",
      );
    }

    if (res.status === 403) {
      throw new SyncError(
        "permission",
        `Discord refused ${redactPath(path)} (HTTP 403): ${await safeText(res)}`,
        { remediation: PERMISSION_REMEDIATION },
      );
    }

    throw new SyncError(
      "unknown",
      `Discord request to ${redactPath(path)} failed (HTTP ${res.status}): ${await safeText(res)}`,
    );
  }
}

/** Discord's 429 body carries `retry_after` in seconds; the header is the fallback. */
async function retryAfterMsOf(res: Response): Promise<number> {
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // Not JSON — fall through to the header.
  }
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header * 1000) : 60_000;
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const MAX_DETAIL_LEN = 200;

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, MAX_DETAIL_LEN);
  } catch {
    return "<unreadable body>";
  }
}

/** Strip query strings from paths quoted in errors. */
function redactPath(path: string): string {
  return path.split("?")[0];
}
