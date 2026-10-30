// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { tlsErrorCode } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import type {
  PaperlessCustomField,
  PaperlessCustomFieldInstance,
  PaperlessDocument,
  PaperlessLookups,
  PaperlessNamed,
  PaperlessPage,
  PaperlessUiSettings,
} from "./types.js";

/**
 * The REST API version every request pins, so an upgrade cannot change the
 * shapes this package reads under it. Paperless-ngx serves only a window of
 * recent versions (3.x accepts 9 and 10); 9 is the oldest that window still
 * holds and was first served by 2.16.
 */
export const PAPERLESS_API_VERSION = 9;

/** Ids per listing request; each entry is a few dozen bytes. */
const LISTING_PAGE_SIZE = 10_000;
/** Bound on one listing, so a server that never stops paging cannot loop forever. */
const MAX_LISTED = 2_000_000;
/** Page size for the lookup tables, which are small. */
const LOOKUP_PAGE_SIZE = 1_000;
/** Bound on lookup pages, so a server that never stops paging cannot loop forever. */
const MAX_LOOKUP_PAGES = 1_000;

/**
 * The fields a document fetch asks for. `fields=` keeps the payload to what
 * the normalizer reads — the default serializer also computes permissions
 * and sharing state per document, which is work a NAS does for nothing.
 */
const DOCUMENT_FIELDS = [
  "id",
  "title",
  "content",
  "correspondent",
  "document_type",
  "tags",
  "created",
  "added",
  "modified",
  "archive_serial_number",
  "original_file_name",
  "page_count",
  "mime_type",
  "notes",
  "custom_fields",
  "owner",
].join(",");

export interface PaperlessClientOptions {
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Ids per listing request. Injectable so tests can cross a page boundary. */
  listingPageSize?: number;
}

/** One entry of a sweep's listing. */
export interface DocumentListingEntry {
  id: number;
  modified: string;
  /** Present when the listing asked for custom fields. */
  custom_fields?: PaperlessCustomFieldInstance[] | null;
}

/**
 * Normalize what an operator pastes as the instance address: no trailing
 * slash, no `/api` suffix, `http` or `https` only. Returns `undefined` for
 * anything that is not such a URL.
 */
export function normalizeBaseUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

/**
 * Thin REST client for one Paperless-ngx instance, authenticated with a
 * per-user API token (`Authorization: Token …`). Failures are mapped to
 * `SyncError` so the collector can classify them: `auth` parks the source in
 * needs-auth, `permission` names what the operator has to grant, and
 * `network` / `transient` retry on the next tick.
 */
export class PaperlessClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly listingPageSize: number;

  constructor(baseUrl: string, token: string, opts: PaperlessClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.listingPageSize = opts.listingPageSize ?? LISTING_PAGE_SIZE;
  }

  /** The Paperless UI's address for one document. */
  documentUrl(id: number): string {
    return `${this.baseUrl}/documents/${id}/details`;
  }

  /** Who the token belongs to. Doubles as the auth flow's liveness probe. */
  async whoami(signal?: AbortSignal): Promise<{ id: number; username: string }> {
    const body = await this.request<PaperlessUiSettings>("/api/ui_settings/", signal);
    const user = body?.user;
    if (!user || typeof user.username !== "string" || !user.username) {
      throw new SyncError(
        "unknown",
        "Paperless-ngx answered, but not with the user the token belongs to. Check that the address points at Paperless-ngx itself.",
      );
    }
    return { id: user.id, username: user.username };
  }

  /**
   * Every document id a sweep should visit, with each one's `modified`.
   *
   * Paged by id (`id__gt` the last id seen, ascending) rather than by page
   * number: a page-numbered walk over a live query skips a document whenever
   * one ahead of it disappears mid-walk, and an id keyset does not move.
   */
  async listDocuments(
    filter: { modifiedAfter?: string; createdFrom?: string; withCustomFields?: boolean },
    signal?: AbortSignal,
  ): Promise<DocumentListingEntry[]> {
    const out: DocumentListingEntry[] = [];
    let after = 0;
    for (;;) {
      const query = new URLSearchParams({
        page_size: String(this.listingPageSize),
        ordering: "id",
        id__gt: String(after),
        fields: filter.withCustomFields ? "id,modified,custom_fields" : "id,modified",
      });
      if (filter.modifiedAfter) query.set("modified__gt", filter.modifiedAfter);
      if (filter.createdFrom) query.set("created__gte", filter.createdFrom);
      const page = await this.request<PaperlessPage<DocumentListingEntry>>(
        `/api/documents/?${query.toString()}`,
        signal,
      );
      if (!isPage(page)) throw invalid("document listing");
      for (const entry of page.results) {
        // Ascending and past the keyset, or the next request would not move.
        if (!entry || typeof entry.id !== "number" || entry.id <= after) {
          throw invalid("document listing");
        }
        after = entry.id;
        out.push(entry);
      }
      if (page.results.length < this.listingPageSize) return out;
      if (out.length >= MAX_LISTED) {
        throw new SyncError(
          "unknown",
          `Paperless-ngx kept listing documents past ${MAX_LISTED}, more than one sweep can hold.`,
        );
      }
    }
  }

  /** Fetch the named documents in full. Ids that no longer exist are simply absent. */
  async getDocuments(ids: readonly number[], signal?: AbortSignal): Promise<PaperlessDocument[]> {
    if (ids.length === 0) return [];
    const query = new URLSearchParams({
      id__in: ids.join(","),
      page_size: String(ids.length),
      fields: DOCUMENT_FIELDS,
    });
    const page = await this.request<PaperlessPage<PaperlessDocument>>(
      `/api/documents/?${query.toString()}`,
      signal,
    );
    if (!isPage(page)) throw invalid("document page");
    return page.results;
  }

  /** The tables a document's tag, correspondent, type and field ids resolve against. */
  async lookups(signal?: AbortSignal): Promise<PaperlessLookups> {
    const [tags, correspondents, documentTypes, customFields] = await Promise.all([
      this.listAll<PaperlessNamed>("/api/tags/", signal),
      this.listAll<PaperlessNamed>("/api/correspondents/", signal),
      this.listAll<PaperlessNamed>("/api/document_types/", signal),
      this.listAll<PaperlessCustomField>("/api/custom_fields/", signal),
    ]);
    return {
      tags: new Map(tags.map((t) => [t.id, t.name])),
      correspondents: new Map(correspondents.map((c) => [c.id, c.name])),
      documentTypes: new Map(documentTypes.map((d) => [d.id, d.name])),
      customFields: new Map(customFields.map((f) => [f.id, f])),
    };
  }

  private async listAll<T extends PaperlessNamed>(
    path: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page++) {
      const query = new URLSearchParams({
        page: String(page),
        page_size: String(LOOKUP_PAGE_SIZE),
        ordering: "id",
      });
      const body = await this.request<PaperlessPage<T>>(`${path}?${query.toString()}`, signal);
      if (!isPage(body)) throw invalid(path);
      for (const item of body.results) {
        if (!item || typeof item.id !== "number" || typeof item.name !== "string") {
          throw invalid(path);
        }
        out.push(item);
      }
      if (!body.next || body.results.length === 0 || out.length >= body.count) return out;
    }
    throw new SyncError("unknown", `Paperless-ngx kept paging ${path} past its safe page limit`);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: `application/json; version=${PAPERLESS_API_VERSION}`,
        },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // A certificate this host cannot verify will not clear by waiting, so
      // it says what to change rather than reading as an outage.
      const tlsCode = tlsErrorCode(err);
      if (tlsCode) {
        throw new SyncError(
          "network",
          `The certificate Paperless-ngx at ${this.baseUrl} presented could not be verified (${tlsCode}).`,
          {
            cause: err,
            remediation: {
              summary: "Paperless-ngx's certificate is not trusted on this host",
              steps: [
                "Give Paperless-ngx a certificate from a public authority, or add the authority that signed it to NODE_EXTRA_CA_CERTS for the collector.",
              ],
              restartRequired: true,
            },
          },
        );
      }
      throw new SyncError(
        "network",
        `Could not reach Paperless-ngx at ${this.baseUrl}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        // A login page or a reverse proxy's error page, served with 200.
        throw new SyncError(
          "unknown",
          `Paperless-ngx at ${this.baseUrl} did not answer with JSON. Check that the address points at Paperless-ngx itself.`,
          { cause: err },
        );
      }
    }

    // 401 is the token itself: every source on this connection is affected,
    // and a new token is the fix.
    if (res.status === 401) {
      throw new SyncError("auth", "Paperless-ngx rejected the API token (HTTP 401).", {
        scope: "connection",
      });
    }
    // 403 is a valid token whose user may not read what was asked. A new
    // token for the same user changes nothing; a permission in Paperless does.
    if (res.status === 403) {
      throw new SyncError(
        "permission",
        `Paperless-ngx refused ${pathOnly(path)} (HTTP 403). The token's user needs permission to view documents, tags, correspondents, document types, custom fields and UI settings.`,
        {
          remediation: {
            summary: "The Paperless-ngx user cannot view everything Omnesis reads",
            steps: [
              "In Paperless-ngx, give the token's user the View permission on documents, tags, correspondents, document types, custom fields and UI settings.",
            ],
            restartRequired: false,
          },
        },
      );
    }
    // 406 is a version this build and that server do not share: either side
    // may be the one out of date.
    if (res.status === 406) {
      throw new SyncError(
        "unknown",
        `Paperless-ngx at ${this.baseUrl} does not serve API version ${PAPERLESS_API_VERSION} (HTTP 406).`,
        {
          remediation: {
            summary: `Omnesis reads Paperless-ngx API version ${PAPERLESS_API_VERSION}, which this server does not serve`,
            steps: [
              "If Paperless-ngx is older than 2.16, upgrade it.",
              "If it is newer, update Omnesis.",
            ],
            restartRequired: false,
          },
        },
      );
    }
    if (res.status === 404) {
      throw new SyncError(
        "unknown",
        `Paperless-ngx has no ${pathOnly(path)} at ${this.baseUrl} (HTTP 404). Check the address, including any path Paperless-ngx is served under.`,
        {
          remediation: {
            summary: "The address does not lead to Paperless-ngx's API",
            steps: [
              "Re-authenticate the source with the address you open Paperless-ngx at, including any path it is served under.",
            ],
            restartRequired: false,
          },
        },
      );
    }
    if (res.status === 429) {
      // Paperless itself does not rate-limit; a reverse proxy in front of it may.
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 60_000;
      throw new SyncError("rate-limit", "Paperless-ngx asked Omnesis to slow down (HTTP 429).", {
        retryAfterMs,
        quota: { kind: "account" },
      });
    }
    if (res.status >= 500) {
      throw new SyncError("transient", `Paperless-ngx server error (HTTP ${res.status}).`);
    }
    throw new SyncError(
      "unknown",
      `Paperless-ngx request to ${pathOnly(path)} failed (HTTP ${res.status}).`,
    );
  }
}

function isPage(v: unknown): v is PaperlessPage<unknown> {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.count === "number" && Array.isArray(p.results);
}

function invalid(what: string): SyncError {
  return new SyncError("unknown", `Paperless-ngx returned an invalid ${what}`);
}

/** A request path without its query, for error messages. */
function pathOnly(path: string): string {
  return path.split("?")[0] ?? path;
}

/** Retry-After is either delta-seconds or an HTTP date. Only seconds are honoured. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
