// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import type {
  ImmichAlbum,
  ImmichApiKey,
  ImmichMetadataSearch,
  ImmichSearchResponse,
  ImmichServerVersion,
  ImmichUser,
} from "./types.js";

/** The oldest Immich this source reads. See `checkServerVersion`. */
export const MIN_IMMICH_MAJOR = 3;

/** Longest server-supplied detail carried into an error message. */
const MAX_DETAIL_LEN = 200;

/** Sent on every request so a server operator can tell this client apart in their logs. */
const USER_AGENT = "Omnesis-Immich-Source";

export interface ImmichClientOptions {
  /** Injectable for tests and the synthetic twin. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * The form an operator's base URL is stored in: scheme and host, any path
 * prefix a reverse proxy adds, no trailing slash and no trailing `/api` —
 * people paste either the web address or the API address, and both name the
 * same server.
 *
 * Returns null for anything that is not an http(s) URL. Plain http is
 * accepted on purpose: most instances live on a home network without a
 * certificate.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * Whether a server is new enough. v3.0 is the floor because it is where
 * search began returning archived assets without a separate query, where
 * `duration` became a number of milliseconds, and where the album shape this
 * source reads settled; supporting v2 would mean a second code path for each.
 */
export function isSupportedVersion(version: ImmichServerVersion): boolean {
  return Number.isInteger(version.major) && version.major >= MIN_IMMICH_MAJOR;
}

export function formatVersion(version: ImmichServerVersion): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Thin REST client for one user's view of one Immich server, authenticated
 * with that user's API key (`x-api-key`). Errors become `SyncError`s so the
 * collector can classify them: `auth` parks the source in needs-auth,
 * `permission` names the API-key permission to grant, `transient`/`network`
 * retry on the next tick.
 */
export class ImmichClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    opts: ImmichClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async version(opts: RequestOptions = {}): Promise<ImmichServerVersion> {
    return (await this.serverClock(opts)).version;
  }

  /**
   * The server's version and, from the response's `Date` header, its clock.
   * A sync window ends at the server's "now", not the collector's: Immich
   * stamps `updatedAt` by its own clock, and a collector running ahead of it
   * would close a window on edits the server has not made yet.
   */
  async serverClock(
    opts: RequestOptions = {},
  ): Promise<{ version: ImmichServerVersion; serverTime?: string }> {
    const { body: version, date } = await this.exchange<ImmichServerVersion>(
      "GET",
      "/server/version",
      undefined,
      opts,
    );
    // A JSON body from something that is not Immich would otherwise read as
    // "Immich vundefined.undefined.undefined is too old".
    if (!Number.isInteger(version?.major) || !Number.isInteger(version?.minor)) {
      throw new SyncError(
        "unknown",
        `${this.baseUrl} answered, but not with an Immich server version.`,
      );
    }
    const serverMs = date ? Date.parse(date) : NaN;
    return {
      version: { major: version.major, minor: version.minor, patch: Number(version.patch) || 0 },
      ...(Number.isFinite(serverMs) ? { serverTime: new Date(serverMs).toISOString() } : {}),
    };
  }

  me(opts: RequestOptions = {}): Promise<ImmichUser> {
    return this.request<ImmichUser>("GET", "/users/me", undefined, opts);
  }

  apiKeyMe(opts: RequestOptions = {}): Promise<ImmichApiKey> {
    return this.request<ImmichApiKey>("GET", "/api-keys/me", undefined, opts);
  }

  listAlbums(opts: RequestOptions = {}): Promise<ImmichAlbum[]> {
    return this.request<ImmichAlbum[]>("GET", "/albums", undefined, opts);
  }

  searchAssets(
    body: ImmichMetadataSearch,
    opts: RequestOptions = {},
  ): Promise<ImmichSearchResponse> {
    return this.request<ImmichSearchResponse>("POST", "/search/metadata", body, opts);
  }

  /**
   * Every asset id in one album. Paged through metadata search with an album
   * filter: the album endpoint itself no longer lists its assets (v3).
   */
  async albumAssetIds(
    albumId: string,
    pageSize: number,
    opts: RequestOptions = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    const seenPages = new Set<number>();
    let page = 1;
    for (;;) {
      if (seenPages.has(page)) {
        throw new SyncError("unknown", `Immich album paging did not advance for album ${albumId}`);
      }
      seenPages.add(page);
      const res = await this.searchAssets(
        { albumIds: [albumId], page, size: pageSize, order: "asc" },
        opts,
      );
      for (const asset of res.assets?.items ?? []) {
        if (typeof asset?.id === "string") ids.push(asset.id);
      }
      const next = parseNextPage(res.assets?.nextPage);
      if (next === null) return ids;
      page = next;
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    return (await this.exchange<T>(method, path, body, opts)).body;
  }

  private async exchange<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<{ body: T; date: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          Accept: "application/json",
          // Never a cached answer: the version response's Date is read as
          // the server's clock.
          "Cache-Control": "no-cache",
          "User-Agent": USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new SyncError(
        "network",
        `Could not reach Immich at ${this.baseUrl}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (res.ok) {
      try {
        return { body: (await res.json()) as T, date: res.headers.get("date") };
      } catch (err) {
        throw new SyncError("unknown", `Immich returned a body that is not JSON for ${path}`, {
          cause: err,
        });
      }
    }

    const detail = await errorDetail(res);
    if (res.status === 401) {
      // The key itself was refused, so every source on this account is
      // affected, not only this one.
      throw new SyncError(
        "auth",
        `Immich rejected the API key (HTTP 401)${detail ? `: ${detail}` : "."}`,
        { scope: "connection" },
      );
    }
    if (res.status === 403) {
      const permission = missingPermission(detail);
      throw new SyncError(
        "permission",
        `Immich refused the request (HTTP 403)${detail ? `: ${detail}` : "."}`,
        permission
          ? {
              remediation: {
                summary: `The Immich API key is missing the ${permission} permission`,
                steps: [
                  "In Immich open Account Settings, then API Keys.",
                  `Edit the key Omnesis uses and grant ${permission}, or create a new key with it and reconnect the source.`,
                ],
                restartRequired: false,
              },
            }
          : {},
      );
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 30_000;
      // A key belongs to one user, so whatever a proxy counts, it counts per account.
      throw new SyncError("rate-limit", "Immich (or a proxy in front of it) is rate limiting.", {
        retryAfterMs,
        quota: { kind: "account" },
      });
    }
    if (res.status >= 500) {
      throw new SyncError("transient", `Immich server error (HTTP ${res.status}) on ${path}.`);
    }
    throw new SyncError(
      "unknown",
      `Immich request to ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : "."}`,
    );
  }
}

/** Immich's `nextPage` is a page number written as a string, or null on the last page. */
export function parseNextPage(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new SyncError("unknown", "Immich returned a page token that is not a page number");
  }
  return n;
}

/** The permission named in `Missing required permission: asset.read`, if it is that message. */
export function missingPermission(detail: string | undefined): string | undefined {
  return detail?.match(/missing required permission:\s*([a-z][a-zA-Z.]*)/i)?.[1];
}

/** Retry-After is either delta-seconds or an HTTP date. Only seconds are honoured. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * The human-readable reason in an Immich error body (`{"message": …}`), or
 * the raw body when it has none. v3 sends a string; v2 could send an array of
 * validation messages, joined here.
 */
async function errorDetail(res: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") reason = parsed.message;
    else if (Array.isArray(parsed.message)) reason = parsed.message.map(String).join("; ");
  } catch {
    reason = undefined;
  }
  const out = reason ?? text;
  return out.length > MAX_DETAIL_LEN ? `${out.slice(0, MAX_DETAIL_LEN)}…` : out;
}
