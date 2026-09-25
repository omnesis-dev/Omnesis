// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for the browser capture policy.
 *
 * Auth posture under test: every route is reachable with the browser's own
 * `write:web` token and by an operator identity; a read-only token and an
 * unauthenticated request are refused. The settings live on the web source's
 * own row, the removed-pages list mirrors the source's privacy tombstones, and
 * a purge deletes the excluded domain's pages for good.
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  REMOVED_PAGES_RESPONSE_CAP,
  type WebCapturePolicy,
} from "@omnesis/provider-web/capture-policy";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, SourceType, writeScope } from "@omnesis/types";
import { SourceId, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { resetOwnedWebDomains, setOwnedWebDomains } from "../../owned-web-domains.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { getSource } from "../../data/repositories/SourceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let analyticsPath: string;
let analyticsDb: AnalyticsDb;
let browserToken: string;
let adminToken: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(kind: "browser" | "cli", scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind });
  return createToken(db, dev.id, scopes).token;
}

function call(path: string, token: string | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function policyFor(token: string): Promise<WebCapturePolicy> {
  const res = await call("/web-capture-policy", token);
  expect(res.status).toBe(200);
  return (await res.json()) as WebCapturePolicy;
}

function webPage(url: string) {
  return {
    providerId: "web",
    sourceId: "web",
    externalId: `id-${url}`,
    documentType: "webpage",
    title: `Page at ${url}`,
    content: "Invented readable text of a fictional page, long enough to keep.",
    contentHash: `hash-${url}`,
    metadata: { sourceUrl: url },
    sourceCreatedAt: "2026-01-15T10:00:00Z",
    sourceUpdatedAt: "2026-01-15T10:00:00Z",
  };
}

async function pushPages(...urls: string[]) {
  const res = await call("/documents", browserToken, {
    method: "POST",
    body: JSON.stringify({ documents: urls.map(webPage) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { ingested: number; suppressed?: string[] };
}

function webDocUrls(): string[] {
  return db
    .prepare<[], { source_url: string }>(
      "SELECT source_url FROM documents WHERE source_id = 'web' ORDER BY source_url",
    )
    .all()
    .map((row) => row.source_url);
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-capture-policy-test-${randomUUID()}.db`;
  analyticsPath = `/tmp/omnesis-capture-policy-test-${randomUUID()}.duckdb`;
  db = createDatabase(dbPath);
  analyticsDb = new AnalyticsDb(analyticsPath);
  await analyticsDb.open();
  app = createServer(db, undefined, { analyticsDb });
  resetOwnedWebDomains();
  browserToken = mintToken("browser", [writeScope(SourceType("web"))]);
  adminToken = mintToken("cli", [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
});

afterEach(async () => {
  await analyticsDb.close();
  db.close();
  cleanupDb(dbPath);
  rmSync(analyticsPath, { force: true });
  rmSync(`${analyticsPath}.wal`, { force: true });
  resetOwnedWebDomains();
});

describe("GET /web-capture-policy", () => {
  test("a fresh install reads the defaults, with the collector's owned domains folded in", async () => {
    setOwnedWebDomains(["mail.example.com", "notes.example"]);
    const policy = await policyFor(browserToken);
    expect(policy).toEqual({
      updatedAt: "",
      pause: null,
      excludedDomains: [],
      ownedDomains: ["mail.example.com", "notes.example"],
      rules: DEFAULT_WEB_CAPTURE_RULES,
      removedPages: [],
      removedPagesTruncated: false,
    });
  });

  test("refuses a read-only token, a write token for another source, and no token", async () => {
    const readOnly = mintToken("cli", [SCOPE_READ]);
    const otherWriter = mintToken("cli", [writeScope(SourceType("gmail"))]);
    expect((await call("/web-capture-policy", readOnly)).status).toBe(403);
    expect((await call("/web-capture-policy", otherWriter)).status).toBe(403);
    expect((await call("/web-capture-policy", null)).status).toBe(401);
  });

  test("an operator identity reads and edits the same policy the browser sees", async () => {
    await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "bank.example" }),
    });
    const res = await call("/web-capture-policy/excluded-domains", adminToken, {
      method: "POST",
      body: JSON.stringify({ domain: "https://Shop.Example/checkout" }),
    });
    expect(res.status).toBe(200);
    expect((await policyFor(browserToken)).excludedDomains).toEqual([
      "bank.example",
      "shop.example",
    ]);
  });
});

describe("excluded domains", () => {
  test("a browser's first edit registers the source row and stores the setting on it", async () => {
    expect(getSource(db, SourceId("web"))).toBeNull();
    const res = await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "https://www.Bank.Example/login?x=1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: WebCapturePolicy; purged: number };
    expect(body.purged).toBe(0);
    expect(body.policy.excludedDomains).toEqual(["www.bank.example"]);
    expect(body.policy.updatedAt).not.toBe("");

    const row = getSource(db, SourceId("web"));
    expect(row?.config).toMatchObject({
      capture: { excludedDomains: ["www.bank.example"], pause: null },
    });
  });

  test("adding twice is idempotent and removing takes the entry out again", async () => {
    for (let i = 0; i < 2; i += 1) {
      await call("/web-capture-policy/excluded-domains", browserToken, {
        method: "POST",
        body: JSON.stringify({ domain: "bank.example" }),
      });
    }
    expect((await policyFor(browserToken)).excludedDomains).toEqual(["bank.example"]);

    const removed = await call("/web-capture-policy/excluded-domains/bank.example", browserToken, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as WebCapturePolicy).excludedDomains).toEqual([]);
  });

  test("an operator identity cannot edit before any browser has paired", async () => {
    const res = await call("/web-capture-policy/excluded-domains", adminToken, {
      method: "POST",
      body: JSON.stringify({ domain: "bank.example" }),
    });
    expect(res.status).toBe(409);
    expect(getSource(db, SourceId("web"))).toBeNull();
  });

  test("two browsers adding different domains at the same instant both land", async () => {
    const [a, b] = await Promise.all([
      call("/web-capture-policy/excluded-domains", browserToken, {
        method: "POST",
        body: JSON.stringify({ domain: "one.example" }),
      }),
      call("/web-capture-policy/excluded-domains", browserToken, {
        method: "POST",
        body: JSON.stringify({ domain: "two.example" }),
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await policyFor(browserToken)).excludedDomains).toEqual(["one.example", "two.example"]);
  });

  test("the remove route normalizes its domain the way the add route does", async () => {
    await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "bank.example" }),
    });
    const removed = await call(
      `/web-capture-policy/excluded-domains/${encodeURIComponent("Bank.Example.")}`,
      browserToken,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as WebCapturePolicy).excludedDomains).toEqual([]);
  });

  test("rejects input that is not a domain", async () => {
    const res = await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "not a host" }),
    });
    expect(res.status).toBe(400);
    expect(
      (
        await call("/web-capture-policy/excluded-domains/localhost", browserToken, {
          method: "DELETE",
        })
      ).status,
    ).toBe(400);
  });

  test("purge deletes the domain's captured pages for good, subdomains included, nothing else", async () => {
    await pushPages(
      "https://bank.example/statement",
      "https://online.bank.example/accounts",
      "https://notbank.example/article",
      "https://blog.example.org/post",
      // Names the domain in its path only: the host check must keep it.
      "https://blog.example.org/reviews/bank.example",
    );
    expect(webDocUrls()).toHaveLength(5);

    const res = await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "bank.example", purge: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: WebCapturePolicy; purged: number };
    expect(body.purged).toBe(2);
    expect(webDocUrls()).toEqual([
      "https://blog.example.org/post",
      "https://blog.example.org/reviews/bank.example",
      "https://notbank.example/article",
    ]);
    expect(body.policy.removedPages.sort()).toEqual(
      ["id-https://bank.example/statement", "id-https://online.bank.example/accounts"].sort(),
    );

    // The purged pages stay gone if a browser pushes them again, and the
    // browser is told so.
    const again = await pushPages(
      "https://bank.example/statement",
      "https://blog.example.org/post",
    );
    expect(again).toEqual({ ingested: 1, suppressed: ["id-https://bank.example/statement"] });
  });
});

describe("pause", () => {
  test("a timed pause is shared, reads as resumed once lapsed, and can be cleared", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    const set = await call("/web-capture-policy/pause", browserToken, {
      method: "PUT",
      body: JSON.stringify({ until }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as WebCapturePolicy).pause).toEqual({ until });
    expect((await policyFor(adminToken)).pause).toEqual({ until });

    const cleared = await call("/web-capture-policy/pause", adminToken, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as WebCapturePolicy).pause).toBeNull();
  });

  test("an indefinite pause is `until: null`; a deadline in the past is refused", async () => {
    const set = await call("/web-capture-policy/pause", browserToken, {
      method: "PUT",
      body: JSON.stringify({ until: null }),
    });
    expect(((await set.json()) as WebCapturePolicy).pause).toEqual({ until: null });
    const past = await call("/web-capture-policy/pause", browserToken, {
      method: "PUT",
      body: JSON.stringify({ until: Date.now() - 1000 }),
    });
    expect(past.status).toBe(400);
  });

  test("a lapsed stored deadline is served as no pause", async () => {
    await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "seed.example" }),
    });
    const row = getSource(db, SourceId("web"));
    const capture = (row?.config.capture ?? {}) as Record<string, unknown>;
    db.prepare("UPDATE sources SET config = ? WHERE id = 'web'").run(
      JSON.stringify({ ...row?.config, capture: { ...capture, pause: { until: 1 } } }),
    );
    expect((await policyFor(browserToken)).pause).toBeNull();
  });
});

describe("removed pages", () => {
  test("the list is cut at the response cap and says so", async () => {
    const insert = db.prepare(
      "INSERT INTO removed_documents (provider_id, source_id, external_id, stream_id, removed_at) VALUES ('web', 'web', ?, '', ?)",
    );
    db.transaction(() => {
      for (let i = 0; i <= REMOVED_PAGES_RESPONSE_CAP; i += 1) insert.run(`page-${i}`, i);
    })();
    const policy = await policyFor(browserToken);
    expect(policy.removedPages).toHaveLength(REMOVED_PAGES_RESPONSE_CAP);
    expect(policy.removedPagesTruncated).toBe(true);
    // Newest tombstones first, so the oldest one is the one left out.
    expect(policy.removedPages).not.toContain("page-0");
  });

  test("a page deleted for good is listed; one deleted as a copy only is not, and comes back", async () => {
    await pushPages("https://a.example/one", "https://a.example/two");
    const ids = db
      .prepare<
        [],
        { id: string; external_id: string }
      >("SELECT id, external_id FROM documents WHERE source_id = 'web' ORDER BY external_id")
      .all();
    const [one, two] = ids;

    expect((await call(`/documents/${one.id}`, browserToken, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(
      (await call(`/documents/${two.id}?tombstone=0`, browserToken, { method: "DELETE" })).status,
    ).toBe(200);
    expect(webDocUrls()).toEqual([]);

    const policy = await policyFor(browserToken);
    expect(policy.removedPages).toEqual([one.external_id]);
    expect(policy.removedPagesTruncated).toBe(false);

    // Re-pushing both: the tombstoned page is refused and named, the other returns.
    expect(await pushPages("https://a.example/one", "https://a.example/two")).toEqual({
      ingested: 1,
      suppressed: [one.external_id],
    });
    expect(webDocUrls()).toEqual(["https://a.example/two"]);
  });

  test("a page deleted for good takes its visit rows with it; a copy-only delete keeps them", async () => {
    await pushPages("https://a.example/one", "https://a.example/two");
    const visitsSchema: AnalyticsTableSchema = {
      tableName: "page_visits",
      displayName: "Page visits",
      description: "Invented visits",
      columns: [
        { name: "url", type: "VARCHAR", description: "Page URL", references: "url" },
        { name: "visited_at", type: "TIMESTAMPTZ", description: "When" },
      ],
      primaryKey: ["url", "visited_at"],
      semanticTimeColumn: "visited_at",
      record: { titleColumns: ["url"], keyColumns: ["url", "visited_at"] },
    };
    await analyticsDb.ingestPage({
      tableName: "page_visits",
      records: [
        { url: "https://a.example/one", visited_at: "2026-01-15T10:00:00Z" },
        { url: "https://a.example/one", visited_at: "2026-01-15T11:00:00Z" },
        { url: "https://a.example/two", visited_at: "2026-01-15T12:00:00Z" },
      ],
      schema: visitsSchema,
      sourceId: "web",
    });
    const visitUrls = async () =>
      (
        await analyticsDb.executeQuery("SELECT url FROM page_visits ORDER BY url", { limit: 10 })
      ).rows.map((row) => String(row[0]));
    expect(await visitUrls()).toEqual([
      "https://a.example/one",
      "https://a.example/one",
      "https://a.example/two",
    ]);

    // Another source's table citing the same URL is not this source's record of the page.
    await analyticsDb.ingestPage({
      tableName: "bookmark_visits",
      records: [{ url: "https://a.example/one", visited_at: "2026-01-15T10:00:00Z" }],
      schema: { ...visitsSchema, tableName: "bookmark_visits", displayName: "Bookmark visits" },
      sourceId: "chrome-bookmarks:invented",
    });

    const ids = db
      .prepare<
        [],
        { id: string; external_id: string }
      >("SELECT id, external_id FROM documents WHERE source_id = 'web' ORDER BY external_id")
      .all();
    await call(`/documents/${ids[0].id}?tombstone=true`, browserToken, { method: "DELETE" });
    expect(await visitUrls()).toEqual(["https://a.example/two"]);
    await call(`/documents/${ids[1].id}?tombstone=0`, browserToken, { method: "DELETE" });
    expect(await visitUrls()).toEqual(["https://a.example/two"]);
    const bookmarks = await analyticsDb.executeQuery("SELECT url FROM bookmark_visits", {
      limit: 10,
    });
    expect(bookmarks.rows.map((row) => String(row[0]))).toEqual(["https://a.example/one"]);
  });
});

describe("a browser token's reach", () => {
  test("cannot wipe the whole source", async () => {
    await pushPages("https://a.example/one");
    const res = await call("/documents/delete-all/source/web", browserToken, { method: "POST" });
    expect(res.status).toBe(403);
    expect(webDocUrls()).toEqual(["https://a.example/one"]);
  });
});
