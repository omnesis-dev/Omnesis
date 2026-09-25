// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, retry } from "@omnesis/core";
import { SyncError } from "@omnesis/types";

const log = createLogger("provider:outlook:graph");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_HOST = "graph.microsoft.com";
const GRAPH_PATH_PREFIX = "/v1.0";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

export class DeltaExpiredError extends Error {
  constructor(message?: string) {
    super(message ?? "Delta token expired (410 Gone)");
    this.name = "DeltaExpiredError";
  }
}

/**
 * Raised either for a Graph 401 response or for a refresh token MSAL can no
 * longer redeem silently (`MicrosoftProvider.getAccessToken`). Both mean the
 * account's credential itself is dead, never that one particular request or
 * resource was unreadable.
 */
export class AuthError extends Error {
  constructor(message?: string) {
    super(message ?? "Authentication failed (401)");
    this.name = "AuthError";
  }
}

/**
 * One Microsoft account backs Outlook Email, Calendar, and OneDrive alike —
 * they read through the same access token (see `SCOPES` in `provider.ts`) —
 * so an `AuthError` from any of them means every sibling source sharing that
 * account is equally unable to sync until the operator re-authenticates.
 * Each source's `sync()` entry point converts an escaping `AuthError` with
 * this before it reaches the collector, so the host can park every source on
 * the account instead of letting each one spend a request rediscovering the
 * same dead credential.
 */
export function toConnectionAuthError(error: AuthError): SyncError {
  return new SyncError("auth", error.message, { scope: "connection", cause: error });
}

/**
 * Internal retry signal — thrown for the 429/502/503/504 statuses
 * Graph emits transiently. The `@omnesis/core` retry primitive
 * inspects the error class to decide whether to retry, and reads the
 * (optional) parsed `Retry-After` to override the exponential
 * default. Never escapes this module — the retry loop either
 * resolves the request or rethrows the underlying status as a plain
 * `Error` after the budget is exhausted.
 */
class TransientGraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | undefined,
  ) {
    super(`Graph API ${status} (transient)`);
    this.name = "TransientGraphError";
  }
}

/**
 * Parse a Graph `Retry-After` header. Microsoft Graph emits the value
 * either as integer seconds (`"30"`) or — less commonly — an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns milliseconds, or
 * undefined if absent / unparseable so the caller can fall back to
 * exponential backoff.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isGraphApiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === GRAPH_HOST &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === GRAPH_PATH_PREFIX || url.pathname.startsWith(`${GRAPH_PATH_PREFIX}/`))
  );
}

function resolveGraphUrl(path: string): string {
  if (path.startsWith("/")) return `${GRAPH_BASE}${path}`;

  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new Error(
      "Graph URL must be either a relative API path beginning with '/' or an absolute https://graph.microsoft.com/v1.0 URL.",
    );
  }

  if (!isGraphApiUrl(url)) {
    throw new Error(
      "Refusing to send a Graph API bearer token to a non-Graph URL. Expected https://graph.microsoft.com/v1.0/...",
    );
  }
  return url.toString();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Thin wrapper around fetch for Microsoft Graph API v1.0.
 *
 * Handles bearer token injection, 429 retry, 410 delta expiry, 401 auth
 * errors, **and 502/503/504 from Graph's gateway tier** with the same
 * `Retry-After`-aware backoff path. Previously every non-429 status was
 * fatal — a transient 503 during an Outlook delta walk would kill the
 * entire sync cycle and lose the per-folder progress.
 */
export class GraphClient {
  constructor(private getAccessToken: () => Promise<string>) {}

  async get<T>(
    path: string,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(resolveGraphUrl(path));
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const urlString = url.toString();

    return this.request(urlString, (res) => res.json() as Promise<T>, { headers });
  }

  /**
   * Download raw bytes from Graph (e.g. `/me/drive/items/{id}/content`, which
   * 302-redirects to a short-lived pre-authed download URL). The first request
   * is still constrained to Graph; a cross-origin download redirect is followed
   * without the Graph bearer token attached.
   */
  async getBytes(path: string): Promise<Uint8Array> {
    const urlString = resolveGraphUrl(path);
    return this.request(urlString, async (res) => new Uint8Array(await res.arrayBuffer()), {
      allowUnauthenticatedRedirect: true,
    });
  }

  private async request<T>(
    urlString: string,
    parse: (res: Response) => Promise<T>,
    opts: { allowUnauthenticatedRedirect?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return retry<T>(
      async () => {
        const token = await this.getAccessToken();
        const res = await fetch(urlString, {
          headers: {
            Authorization: `Bearer ${token}`,
            ...opts.headers,
          },
          redirect: opts.allowUnauthenticatedRedirect ? "manual" : "follow",
        });

        if (res.ok) return parse(res);

        if (opts.allowUnauthenticatedRedirect && isRedirect(res.status)) {
          const location = res.headers.get("Location");
          if (!location) throw new Error(`Graph API redirect ${res.status} without Location`);
          const redirectUrl = new URL(location, urlString);
          if (isGraphApiUrl(redirectUrl)) {
            return this.request(redirectUrl.toString(), parse, opts);
          }

          const redirected = await fetch(redirectUrl.toString(), { redirect: "follow" });
          if (redirected.ok) return parse(redirected);
          const body = await redirected.text().catch(() => "");
          throw new Error(`Graph download redirect error ${redirected.status}: ${body}`);
        }

        // 410 / 401 are non-retryable signals consumed by callers
        // (delta-token re-bootstrap; auth subprocess re-token). Throw
        // a typed error so `shouldRetry` immediately rejects them.
        if (res.status === 410) throw new DeltaExpiredError();
        if (res.status === 401) throw new AuthError();

        const transient =
          res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
        if (transient) {
          throw new TransientGraphError(
            res.status,
            parseRetryAfter(res.headers.get("Retry-After")),
          );
        }

        const body = await res.text().catch(() => "");
        throw new Error(`Graph API error ${res.status}: ${body}`);
      },
      {
        // `MAX_RETRIES = 3` previously meant 3 retries after the first
        // try — i.e. 4 attempts total. The core primitive counts the
        // first try as attempt 1, so `maxAttempts = MAX_RETRIES + 1`
        // preserves the budget exactly.
        maxAttempts: MAX_RETRIES + 1,
        baseBackoffMs: BASE_BACKOFF_MS,
        shouldRetry: (err) => err instanceof TransientGraphError,
        computeBackoff: (err, _attempt, defaultMs) =>
          err instanceof TransientGraphError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : defaultMs,
        onRetry: (err, attempt, delayMs) => {
          if (err instanceof TransientGraphError) {
            log.warn(
              `Graph ${err.status} on ${urlString}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`,
            );
          }
        },
      },
    );
  }
}
