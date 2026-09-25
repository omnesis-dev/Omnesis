// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import type { RestCommitDetail, RestCommitListRow, RestCommentRow, RestRepoRow } from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";

/** Cap a server-advertised Retry-After we'll sleep through inline before deferring. */
const MAX_INLINE_RETRY_MS = 10_000;

/**
 * Transient-failure retries per request (5xx and network errors). GitHub
 * 504s heavy GraphQL queries routinely; without a retry a single 504 aborts
 * the whole sync tick and parks the source in `error` for a full interval.
 */
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [1_000, 3_000];

/**
 * Conditional-request cache size. Keyed by URL — the since-lanes poll the
 * same URL while their watermark is idle, so a 304 answers the common
 * "nothing changed" poll without spending rate budget (GitHub does not count
 * 304s against the core limit).
 */
const ETAG_CACHE_MAX = 2048;

export interface GithubClientOptions {
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface EtagEntry {
  etag: string;
  body: unknown;
  /** Value of the `link` header captured alongside the body. */
  link?: string;
}

export interface RestPage<T> {
  rows: T[];
  hasNextPage: boolean;
}

/**
 * Thin client for the GitHub REST + GraphQL APIs, authenticated with a
 * personal access token. Every escaping error is a typed `SyncError` — this
 * matters more for GitHub than most providers because a 403 is ambiguous
 * upstream: primary/secondary rate limits and missing token scopes share the
 * status code, and only the rate-limit headers tell them apart. Substring
 * classification in the collector would file both as `permission`.
 */
export class GithubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly etags = new Map<string, EtagEntry>();

  constructor(token: string, opts: GithubClientOptions = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? GITHUB_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Probes / identity
  // -------------------------------------------------------------------------

  /** Liveness probe used by the auth flow: validates the token, returns identity. */
  async getUser(): Promise<{ login: string; name?: string }> {
    const user = await this.rest<{ login: string; name?: string | null }>("/user");
    return { login: user.login, name: user.name ?? undefined };
  }

  /** Every repository the token can access. Paginated to completion. */
  async listAccessibleRepos(): Promise<RestRepoRow[]> {
    const repos: RestRepoRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const { rows, hasNextPage } = await this.restPage<RestRepoRow>(
        `/user/repos?per_page=100&page=${page}&sort=full_name`,
      );
      repos.push(...rows);
      if (!hasNextPage) return repos;
    }
    // Silently truncating would make the next snapshot sweep every document
    // of the repos past the cap — refuse loudly instead.
    throw new SyncError(
      "unknown",
      "More than 2000 repositories are accessible to this token — configure a `repos` filter or scope the token's repository grant.",
    );
  }

  // -------------------------------------------------------------------------
  // Discovery lanes (REST)
  // -------------------------------------------------------------------------

  /**
   * Repo-wide issue comments updated since the watermark. This is the lane
   * that catches comment *edits*, which do not reliably bump the parent
   * issue's `updated_at`. Each row names its parent via `issue_url`.
   */
  async listIssueCommentsSince(repo: string, since: string, page: number) {
    return this.restPage<RestCommentRow>(
      `/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=100&page=${page}&since=${encodeURIComponent(since)}`,
    );
  }

  /** Repo-wide PR review comments updated since the watermark. */
  async listReviewCommentsSince(repo: string, since: string, page: number) {
    return this.restPage<RestCommentRow>(
      `/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=100&page=${page}&since=${encodeURIComponent(since)}`,
    );
  }

  /**
   * Commits on the default branch with committer date ≥ `since`, newest
   * first (the API offers no ascending sort). A repository with no commits
   * answers 409 "Git Repository is empty" — surfaced as an empty listing so
   * one fresh repo cannot wedge the source.
   */
  async listCommits(
    repo: string,
    since: string | undefined,
    page: number,
  ): Promise<RestPage<RestCommitListRow>> {
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
    const path = `/repos/${repo}/commits?per_page=100&page=${page}${sinceParam}`;
    const cached = this.etags.get(path);
    const res = await this.rawRequest(path, {
      headers: cached ? { "If-None-Match": cached.etag } : undefined,
      allowStatuses: [409],
    });
    if (res.status === 409) return { rows: [], hasNextPage: false };
    if (res.status === 304 && cached) {
      return {
        rows: cached.body as RestCommitListRow[],
        hasNextPage: cached.link?.includes('rel="next"') ?? false,
      };
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new SyncError("unknown", `GitHub returned a non-list for ${redactPath(path)}.`);
    }
    this.cacheEtag(path, res, body);
    return {
      rows: body as RestCommitListRow[],
      hasNextPage: res.headers.get("link")?.includes('rel="next"') ?? false,
    };
  }

  /** Full commit detail: message, identities, stats, changed-file paths. */
  async getCommit(repo: string, sha: string): Promise<RestCommitDetail> {
    return this.rest<RestCommitDetail>(`/repos/${repo}/commits/${sha}`);
  }

  // -------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------

  /**
   * Run a GraphQL query. `tolerateNotFound` swallows NOT_FOUND errors (an
   * aliased thread deleted between discovery and materialization) and
   * returns whatever partial data GitHub produced.
   */
  async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    opts: { tolerateNotFound?: boolean } = {},
  ): Promise<T> {
    const res = await this.rawRequest("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await res.json()) as {
      data?: T;
      errors?: Array<{ type?: string; message?: string }>;
    };
    if (payload.errors && payload.errors.length > 0) {
      const rateLimited = payload.errors.find((e) => e.type === "RATE_LIMITED");
      if (rateLimited) {
        // GitHub's GraphQL budget is a separate bucket from the REST budget,
        // but both are counted against the authenticated token — a
        // fine-grained or classic PAT is this account's own credential (see
        // credentials-spec.ts), never a secret shared across users of a
        // registered app, so a throttled account never implies another
        // account's token is also throttled.
        throw new SyncError("rate-limit", "GitHub GraphQL rate limit exceeded.", {
          retryAfterMs: this.resetDelayMs(res.headers) ?? 60_000,
          quota: { kind: "account" },
        });
      }
      const tolerable = opts.tolerateNotFound
        ? payload.errors.every((e) => e.type === "NOT_FOUND")
        : false;
      if (!tolerable) {
        const forbidden = payload.errors.some((e) => e.type === "FORBIDDEN");
        const message = payload.errors
          .map((e) => e.message ?? e.type ?? "unknown error")
          .join("; ")
          .slice(0, 300);
        throw new SyncError(
          forbidden ? "permission" : "unknown",
          `GitHub GraphQL error: ${message}`,
        );
      }
    }
    if (payload.data === undefined || payload.data === null) {
      throw new SyncError("unknown", "GitHub GraphQL returned no data.");
    }
    return payload.data;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async rest<T>(path: string): Promise<T> {
    const { body } = await this.conditionalGet(path);
    return body as T;
  }

  /** GET with pagination signal read from the `link` header. */
  private async restPage<T>(path: string): Promise<RestPage<T>> {
    const { body, link } = await this.conditionalGet(path);
    if (!Array.isArray(body)) {
      throw new SyncError("unknown", `GitHub returned a non-list for ${redactPath(path)}.`);
    }
    return { rows: body as T[], hasNextPage: link?.includes('rel="next"') ?? false };
  }

  /**
   * GET with an If-None-Match round trip. A 304 replays the cached body and
   * costs no rate budget — the common case for an idle since-lane.
   */
  private async conditionalGet(path: string): Promise<{ body: unknown; link?: string }> {
    const cached = this.etags.get(path);
    const res = await this.rawRequest(path, {
      headers: cached ? { "If-None-Match": cached.etag } : undefined,
    });
    if (res.status === 304 && cached) {
      return { body: cached.body, link: cached.link };
    }
    const body: unknown = await res.json();
    this.cacheEtag(path, res, body);
    return { body, link: res.headers.get("link") ?? undefined };
  }

  private cacheEtag(path: string, res: Response, body: unknown): void {
    const etag = res.headers.get("etag");
    if (!etag) return;
    if (this.etags.size >= ETAG_CACHE_MAX) {
      const oldest = this.etags.keys().next().value;
      if (oldest !== undefined) this.etags.delete(oldest);
    }
    this.etags.delete(path);
    this.etags.set(path, { etag, body, link: res.headers.get("link") ?? undefined });
  }

  private async rawRequest(
    path: string,
    init: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      /** Statuses handed back to the caller instead of raising a SyncError. */
      allowStatuses?: number[];
    } = {},
    attempt = 0,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "omnesis",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      if (attempt < TRANSIENT_RETRIES) {
        await this.sleep(TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]);
        return this.rawRequest(path, init, attempt + 1);
      }
      throw new SyncError("network", `GitHub request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (res.ok || res.status === 304 || init.allowStatuses?.includes(res.status)) return res;

    if (res.status >= 500 && attempt < TRANSIENT_RETRIES) {
      await this.sleep(TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]);
      return this.rawRequest(path, init, attempt + 1);
    }

    if (res.status === 401) {
      // The token is this account's whole credential (credentials-spec.ts) —
      // both source entries this provider registers (`github`, `github-commits`)
      // share the one client built from it in `createContext`, so a token
      // GitHub rejects outright takes both down, not just whichever request
      // hit it first.
      throw new SyncError(
        "auth",
        "GitHub rejected the token (HTTP 401) — it was revoked, expired, or mistyped.",
        { scope: "connection" },
      );
    }

    if (res.status === 403 || res.status === 429) {
      // Rate limits and missing scopes share 403; the headers disambiguate.
      const retryAfterMs = this.retryAfterMs(res.headers);
      if (retryAfterMs !== undefined) {
        if (attempt === 0 && retryAfterMs <= MAX_INLINE_RETRY_MS) {
          await this.sleep(retryAfterMs);
          return this.rawRequest(path, init, attempt + 1);
        }
        // Same per-token budget as the GraphQL rate limit above.
        throw new SyncError("rate-limit", "GitHub rate limit exceeded.", {
          retryAfterMs,
          quota: { kind: "account" },
        });
      }
      const detail = await safeText(res);
      throw new SyncError(
        "permission",
        `GitHub refused the request (HTTP ${res.status}) — the token likely lacks a scope or repository grant: ${detail}`,
      );
    }

    if (res.status >= 500) {
      throw new SyncError("transient", `GitHub server error (HTTP ${res.status}).`);
    }

    if (res.status === 404) {
      throw new SyncError(
        "permission",
        `GitHub returned 404 for ${redactPath(path)} — the resource is gone or the token cannot see it.`,
      );
    }

    const body = await safeText(res);
    throw new SyncError(
      "unknown",
      `GitHub request to ${redactPath(path)} failed (HTTP ${res.status}): ${body}`,
    );
  }

  /** Retry delay from rate-limit headers, if the response is a rate limit. */
  private retryAfterMs(headers: Headers): number | undefined {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    if (headers.get("x-ratelimit-remaining") === "0") {
      return this.resetDelayMs(headers) ?? 60_000;
    }
    return undefined;
  }

  private resetDelayMs(headers: Headers): number | undefined {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return undefined;
    return Math.max(1000, reset * 1000 - this.now());
  }
}

/** Longest error detail we put in a SyncError message. */
const MAX_DETAIL_LEN = 200;

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_DETAIL_LEN);
  } catch {
    return "<unreadable body>";
  }
}

/** Strip query strings from paths quoted in errors (they can carry timestamps). */
function redactPath(path: string): string {
  return path.split("?")[0];
}
