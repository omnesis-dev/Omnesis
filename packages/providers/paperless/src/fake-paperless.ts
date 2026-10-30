// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Paperless-ngx REST API for tests: the endpoints the source
 * reads, with the filters, ordering, paging and `fields=` projection it
 * relies on. Every value in it is invented.
 */

import type { PaperlessCustomField, PaperlessDocument, PaperlessNamed } from "./types.js";

export const FAKE_BASE_URL = "http://paperless.example.com:8000";
export const FAKE_TOKEN = "0123456789abcdef0123456789abcdef01234567";

export class FakePaperless {
  readonly documents = new Map<number, PaperlessDocument>();
  readonly tags = new Map<number, PaperlessNamed>();
  readonly correspondents = new Map<number, PaperlessNamed>();
  readonly documentTypes = new Map<number, PaperlessNamed>();
  readonly customFields = new Map<number, PaperlessCustomField>();
  username = "maya";
  userId = 3;
  /** Every request path served, with its query. */
  readonly requests: string[] = [];
  /** Answer the next matching request with this status instead. */
  failNext: { match: string; status: number; body?: string } | undefined;
  /** Ids to leave out of the next document fetch, as if deleted in between. */
  vanishOnFetch = new Set<number>();
  /** Ids the server cannot serialize: any fetch naming one fails with HTTP 500. */
  readonly poison = new Set<number>();
  /** While set, every request fails with HTTP 502, as when Paperless is down behind a proxy. */
  outage = false;
  private tick = 0;

  /** A strictly increasing `modified`, with microseconds like the real server. */
  nextModified(): string {
    this.tick += 1;
    const ms = Date.UTC(2026, 2, 1, 9, 0, 0) + this.tick * 1000;
    return `${new Date(ms).toISOString().slice(0, 19)}.${String(this.tick).padStart(6, "0")}+00:00`;
  }

  addDocument(doc: Partial<PaperlessDocument> & { id: number }): PaperlessDocument {
    const full: PaperlessDocument = {
      title: `Document ${doc.id}`,
      content: `Text of document ${doc.id}`,
      correspondent: null,
      document_type: null,
      tags: [],
      created: "2026-02-14",
      added: "2026-02-15T10:00:00+00:00",
      archive_serial_number: null,
      original_file_name: `scan-${doc.id}.pdf`,
      page_count: 1,
      mime_type: "application/pdf",
      notes: [],
      custom_fields: [],
      ...doc,
      modified: doc.modified ?? this.nextModified(),
    };
    this.documents.set(full.id, full);
    return full;
  }

  /** Edit a document the way Paperless does: every change bumps `modified`. */
  editDocument(id: number, patch: Partial<PaperlessDocument>): void {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`no document ${id}`);
    this.documents.set(id, { ...doc, ...patch, modified: this.nextModified() });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(`${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers);
    if (this.outage) return json({ detail: "Bad Gateway" }, 502);
    if (this.failNext && url.pathname.includes(this.failNext.match)) {
      const { status, body } = this.failNext;
      this.failNext = undefined;
      return new Response(body ?? JSON.stringify({ detail: "failure" }), { status });
    }
    if (headers.get("authorization") !== `Token ${FAKE_TOKEN}`) {
      return json({ detail: "Invalid token." }, 401);
    }
    // Paperless-ngx 3.x serves only API versions 9 and 10.
    if (!/version=(9|10)\b/.test(headers.get("accept") ?? "")) {
      return json({ detail: 'Invalid version in "Accept" header.' }, 406);
    }
    const q = url.searchParams;
    const path = url.pathname.replace(/^\/[^/]*?(?=\/api\/)/, "");
    switch (path) {
      case "/api/ui_settings/":
        return json({ user: { id: this.userId, username: this.username }, settings: {} });
      case "/api/tags/":
        return json(this.lookupPage(this.tags, q));
      case "/api/correspondents/":
        return json(this.lookupPage(this.correspondents, q));
      case "/api/document_types/":
        return json(this.lookupPage(this.documentTypes, q));
      case "/api/custom_fields/":
        return json(this.lookupPage(this.customFields, q));
      case "/api/documents/": {
        const page = this.documentPage(q);
        return "poisoned" in page ? json({ detail: "Server Error" }, 500) : json(page);
      }
      default:
        return json({ detail: "Not found." }, 404);
    }
  };

  private lookupPage<T extends PaperlessNamed>(table: Map<number, T>, q: URLSearchParams) {
    const all = [...table.values()].sort((a, b) => a.id - b.id);
    const size = Number(q.get("page_size") ?? 25);
    const page = Number(q.get("page") ?? 1);
    const results = all.slice((page - 1) * size, page * size);
    return {
      count: all.length,
      next: page * size < all.length ? `${FAKE_BASE_URL}/api/x/?page=${page + 1}` : null,
      previous: null,
      results,
    };
  }

  private documentPage(q: URLSearchParams) {
    let docs = [...this.documents.values()];
    const modifiedAfter = q.get("modified__gt");
    if (modifiedAfter) docs = docs.filter((d) => d.modified > modifiedAfter);
    const createdFrom = q.get("created__gte");
    if (createdFrom) docs = docs.filter((d) => d.created.slice(0, 10) >= createdFrom);
    const idGt = q.get("id__gt");
    if (idGt) docs = docs.filter((d) => d.id > Number(idGt));
    const idIn = q.get("id__in");
    if (idIn) {
      const ids = new Set(idIn.split(",").map(Number));
      if ([...ids].some((id) => this.poison.has(id))) return { poisoned: true };
      docs = docs.filter((d) => ids.has(d.id) && !this.vanishOnFetch.has(d.id));
      this.vanishOnFetch.clear();
    }
    const ordering = q.get("ordering");
    docs.sort((a, b) =>
      ordering === "-modified" ? b.modified.localeCompare(a.modified) : a.id - b.id,
    );
    const size = Number(q.get("page_size") ?? 25);
    const fields = q.get("fields")?.split(",");
    const results = docs
      .slice(0, size)
      .map((d) =>
        fields
          ? Object.fromEntries(fields.map((f) => [f, (d as unknown as Record<string, unknown>)[f]]))
          : d,
      );
    return { count: docs.length, next: null, previous: null, all: docs.map((d) => d.id), results };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
