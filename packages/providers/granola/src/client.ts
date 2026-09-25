// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import type { GranolaNoteDetail, GranolaNotesListResponse } from "./types.js";

const GRANOLA_API_BASE = "https://public-api.granola.ai/v1";

/** Cap a server-advertised Retry-After we'll sleep through inline before deferring. */
const MAX_INLINE_RETRY_MS = 10_000;

export interface GranolaClientOptions {
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ListNotesParams {
  pageSize?: number;
  cursor?: string | null;
  updatedAfter?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin REST client for the Granola public API. Authenticates with a pasted
 * personal API key (`Authorization: Bearer grn_…`). Errors are mapped to
 * `SyncError` so the collector's scheduler can classify them: `auth` parks the
 * source in needs-auth, `rate-limit` carries `retryAfterMs` for backoff,
 * `transient`/`network` retry on the next tick.
 */
export class GranolaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string, opts: GranolaClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? GRANOLA_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** List notes, newest first. Pagination via the opaque `cursor`. */
  async listNotes(params: ListNotesParams = {}): Promise<GranolaNotesListResponse> {
    const query = new URLSearchParams();
    query.set("page_size", String(params.pageSize ?? 20));
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.updatedAfter) query.set("updated_after", params.updatedAfter);
    return this.request<GranolaNotesListResponse>(`/notes?${query.toString()}`);
  }

  /** Fetch a single note with its summary and (optionally) transcript. */
  async getNote(
    id: string,
    opts: { includeTranscript?: boolean } = {},
  ): Promise<GranolaNoteDetail> {
    const query = new URLSearchParams();
    if (opts.includeTranscript) query.set("include", "transcript");
    const suffix = query.toString() ? `?${query.toString()}` : "";
    // A 404 here names one note that vanished, not the account — see `request`.
    return this.request<GranolaNoteDetail>(`/notes/${encodeURIComponent(id)}${suffix}`, 0, {
      notFoundIsOneItem: true,
    });
  }

  /**
   * Liveness probe used by the auth flow: validates the API key and returns
   * the owner identity (derived from the first note's owner, when present).
   * Throws `SyncError("auth")` on 401/403 — the key is invalid.
   */
  async probe(): Promise<{ ownerName?: string; ownerEmail?: string }> {
    const res = await this.listNotes({ pageSize: 1 });
    const owner = res.notes[0]?.owner;
    return { ownerName: owner?.name ?? undefined, ownerEmail: owner?.email };
  }

  private async request<T>(
    path: string,
    attempt = 0,
    opts: { notFoundIsOneItem?: boolean } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new SyncError("network", `Granola request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (res.ok) {
      return (await res.json()) as T;
    }

    // 401 means the key itself is bad — re-auth can fix it. 403 means the key
    // authenticated but the workspace may not use the API (e.g. a lapsed
    // subscription, `SUBSCRIPTION_INACTIVE`); re-auth cannot fix that, so it is
    // classified `permission` and carries Granola's own explanation.
    if (res.status === 401 || res.status === 403) {
      const detail = await errorDetail(res);
      const kind = res.status === 401 ? "auth" : "permission";
      const prefix =
        res.status === 401
          ? "Granola rejected the API key (HTTP 401)"
          : "Granola refused the request (HTTP 403)";
      const message = detail ? `${prefix}: ${detail}` : `${prefix}.`;
      // A 401 means this account's own API key is invalid — the credential
      // behind the account, not just this request — so every source
      // configured on it is affected, not only this one.
      if (res.status === 401) {
        throw new SyncError(kind, message, { scope: "connection" });
      }
      throw new SyncError(kind, message);
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 5_000;
      // Sleep through a short Retry-After once; otherwise hand the deadline to
      // the scheduler so it backs off instead of blocking the sync.
      if (attempt === 0 && retryAfterMs <= MAX_INLINE_RETRY_MS) {
        await this.sleep(retryAfterMs);
        return this.request<T>(path, attempt + 1, opts);
      }
      // Granola issues one API key per account with no shared application
      // credential, so the ceiling is counted per key — another account's
      // key draws on a separate budget.
      throw new SyncError("rate-limit", "Granola rate limit exceeded.", {
        retryAfterMs,
        quota: { kind: "account" },
      });
    }

    if (res.status >= 500) {
      throw new SyncError("transient", `Granola server error (HTTP ${res.status}).`);
    }

    // A 404 on a single note's detail fetch (the owner deleted it mid-sweep)
    // is a fact about that one note, not about the account or the rest of the
    // page — the other notes in the page are still readable, so this is the
    // one status the caller may skip past. `notFoundIsOneItem` narrows this to
    // `getNote`: the list endpoint takes no resource id in its path, so a 404
    // there would mean the route itself is wrong, not that one item is gone,
    // and stays at the default `source` scope.
    if (res.status === 404) {
      throw new SyncError(
        "unknown",
        `Granola resource not found (HTTP 404): ${path}`,
        opts.notFoundIsOneItem ? { scope: "item" } : {},
      );
    }

    const body = await safeText(res);
    throw new SyncError(
      "unknown",
      `Granola request to ${path} failed (HTTP ${res.status}): ${body}`,
    );
  }
}

/** Retry-After is either delta-seconds or an HTTP date. We only honor seconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

/** Longest error detail we put in a SyncError message. */
const MAX_DETAIL_LEN = 200;

/**
 * Pull the human-readable reason out of a Granola error envelope
 * (`{code, message, requestId, timestamp}`), falling back to the raw body.
 * Without this the operator only sees the status code, which cannot
 * distinguish a bad key from a workspace that has lost API access.
 *
 * Parses the whole body before truncating: a real envelope carries a
 * requestId and timestamp that push it past the cap, and truncating first
 * would leave invalid JSON that only ever hits the raw-body fallback.
 */
async function errorDetail(res: Response): Promise<string | undefined> {
  const body = await safeText(res, Number.POSITIVE_INFINITY);
  if (!body) return undefined;
  return truncate(extractReason(body) ?? body);
}

function extractReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : undefined;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    if (message && code) return `${message} (${code})`;
    return message ?? code;
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LEN ? `${text.slice(0, MAX_DETAIL_LEN)}…` : text;
}

async function safeText(res: Response, limit = MAX_DETAIL_LEN): Promise<string> {
  try {
    const text = await res.text();
    return Number.isFinite(limit) ? text.slice(0, limit) : text;
  } catch {
    return "<unreadable body>";
  }
}
