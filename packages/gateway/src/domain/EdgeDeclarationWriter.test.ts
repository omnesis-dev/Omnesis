// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { webPageEdgeTarget, type EdgeDeclaration } from "@omnesis/core";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { WEB_SOURCE_ID } from "../web-dataset.js";
import { applyDeclaredEdges, drainPendingEdges } from "./EdgeDeclarationWriter.js";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

/** Insert a document; `sourceId` defaults to `gmail:me`, externalId = id. */
function seedDoc(
  id: string,
  opts: { sourceId?: string; externalId?: string; streamId?: string } = {},
): void {
  const sourceId = opts.sourceId ?? "gmail:me";
  const externalId = opts.externalId ?? id;
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'google', ?, ?, ?, ?, '', ?, '{}', ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    externalId,
    opts.streamId ?? "",
    `Title ${id}`,
    `h-${id}`,
    NOW,
    NOW,
    NOW,
    NOW,
  );
}

function internalEdge(
  fromExt: string,
  toExt: string,
  type: EdgeDeclaration["type"],
  extra: Partial<EdgeDeclaration> = {},
): EdgeDeclaration {
  return {
    from: { kind: "internal", sourceDocumentId: fromExt },
    to: { kind: "internal", sourceDocumentId: toExt },
    type,
    ...extra,
  };
}

function linkRows(sourceDocId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM document_links WHERE source_doc_id = ? ORDER BY id")
    .all(sourceDocId) as Array<Record<string, unknown>>;
}

function pendingRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM pending_edges ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

describe("applyDeclaredEdges", () => {
  test("resolves an edge whose target exists into document_links with source-declared provenance", () => {
    seedDoc("child");
    seedDoc("parent");

    const res = applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("child", "parent", "replies-to")],
      NOW,
    );

    expect(res).toMatchObject({ written: 1, pending: 0, removed: 0, skipped: 0 });
    const rows = linkRows("child");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      link_type: "replies-to",
      target_doc_id: "parent",
      provenance_kind: "source-declared",
      provenance_origin: "gmail:me",
      declared_at: NOW,
    });
  });

  test("an endpoint in the declaring page's stream wins over a namesake in another stream", () => {
    seedDoc("from-b", { externalId: "day-2", streamId: "device-b" });
    seedDoc("day-1-a", { externalId: "day-1", streamId: "device-a" });
    seedDoc("day-1-b", { externalId: "day-1", streamId: "device-b" });
    const res = applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("day-2", "day-1", "references")],
      NOW,
      "device-b",
    );
    expect(res.written).toBe(1);
    const link = db
      .prepare<
        [],
        { source_doc_id: string; target_doc_id: string }
      >("SELECT source_doc_id, target_doc_id FROM document_links")
      .get();
    expect(link).toEqual({ source_doc_id: "from-b", target_doc_id: "day-1-b" });
  });

  test("parks a forward reference (target not yet ingested) in pending_edges, not document_links", () => {
    seedDoc("child");
    // 'parent' does not exist yet.

    const res = applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("child", "parent", "replies-to")],
      NOW,
    );

    expect(res).toMatchObject({ written: 0, pending: 1 });
    expect(linkRows("child")).toHaveLength(0);
    const pending = pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      link_type: "replies-to",
      target_source_id: "gmail:me",
      target_external_id: "parent",
      provenance_origin: "gmail:me",
    });
  });

  test("persists ordering + metadata into metadata_json", () => {
    seedDoc("a");
    seedDoc("b");
    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("a", "b", "succeeds", { ordering: 3, metadata: { note: "v2" } })],
      NOW,
    );
    const meta = JSON.parse(linkRows("a")[0].metadata_json as string);
    expect(meta).toEqual({ note: "v2", ordering: 3 });
  });

  test("resolves an external (cross-source) reference against the other source", () => {
    seedDoc("bookmark", { sourceId: "chrome:me", externalId: "bm-1" });
    seedDoc("page", { sourceId: "web", externalId: "page-1" });

    const edge: EdgeDeclaration = {
      from: { kind: "internal", sourceDocumentId: "bm-1" },
      to: { kind: "external", sourceId: "web", sourceDocumentId: "page-1" },
      type: "references",
    };
    const res = applyDeclaredEdges(db, "chrome:me", [edge], NOW);
    expect(res.written).toBe(1);
    expect(linkRows("bookmark")[0]).toMatchObject({
      target_doc_id: "page",
      link_type: "references",
    });
  });

  test("skips an edge whose declaring (from) document does not exist", () => {
    seedDoc("parent");
    const res = applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("ghost", "parent", "replies-to")],
      NOW,
    );
    expect(res).toMatchObject({ written: 0, skipped: 1 });
  });

  test("diff-deletes a source-declared edge of the same type that is not re-declared", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");

    // First sync: a → b and a → c, both 'accompanies'.
    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("a", "b", "accompanies"), internalEdge("a", "c", "accompanies")],
      NOW,
    );
    expect(linkRows("a")).toHaveLength(2);

    // Second sync re-declares only a → b. a → c must be removed.
    const res = applyDeclaredEdges(db, "gmail:me", [internalEdge("a", "b", "accompanies")], NOW);
    expect(res.removed).toBe(1);
    const rows = linkRows("a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_doc_id: "b" });
  });

  test("diff-delete is scoped to the declared types — other-type edges (incl. convention/content) survive", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    // A content-derived url edge the diff must NEVER touch (it is not a declared
    // edge — it belongs to the extractLinks pipeline). This is the regression
    // guard for the convention/explicit coexistence: both are source-/content-
    // provenance rows in the same table, and a declared-edge sync must not wipe
    // edges of types it didn't declare.
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, created_at, provenance_kind, provenance_origin, declared_at)
       VALUES ('a', 'url', 'http://x', 'http://x', 'c', ?, 'content-derived', 'gmail:me', ?)`,
    ).run(NOW, NOW);

    applyDeclaredEdges(db, "gmail:me", [internalEdge("a", "b", "replies-to")], NOW);
    // A later sync declares only `succeeds`. Its diff is scoped to {succeeds},
    // so it reconciles no other type: the url AND the replies-to both survive.
    applyDeclaredEdges(db, "gmail:me", [internalEdge("a", "c", "succeeds")], NOW);

    const types = linkRows("a").map((r) => r.link_type);
    expect(types).toContain("url");
    expect(types).toContain("succeeds");
    expect(types).toContain("replies-to");
  });

  test("re-declaring a type with a different target reconciles WITHIN that type", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    applyDeclaredEdges(db, "gmail:me", [internalEdge("a", "b", "replies-to")], NOW);
    // The reply's parent changes to c: the old replies-to→b is retracted.
    applyDeclaredEdges(db, "gmail:me", [internalEdge("a", "c", "replies-to")], NOW);
    const rows = linkRows("a").filter((r) => r.link_type === "replies-to");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_doc_id: "c" });
  });

  test("re-emitting an identical resolved edge updates the row in place (ON CONFLICT), not duplicates", () => {
    seedDoc("a");
    seedDoc("b");
    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("a", "b", "replies-to", { metadata: { v: 1 } })],
      NOW,
    );
    const first = linkRows("a");
    expect(first).toHaveLength(1);

    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("a", "b", "replies-to", { metadata: { v: 2 } })],
      NOW,
    );
    const second = linkRows("a");
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id); // same row, updated
    expect(JSON.parse(second[0].metadata_json as string)).toEqual({ v: 2 });
  });

  test("re-emitting an identical forward reference updates the pending row in place (ON CONFLICT)", () => {
    seedDoc("child");
    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("child", "ghost", "replies-to", { metadata: { v: 1 } })],
      NOW,
    );
    const first = pendingRows();
    expect(first).toHaveLength(1);

    applyDeclaredEdges(
      db,
      "gmail:me",
      [internalEdge("child", "ghost", "replies-to", { metadata: { v: 2 } })],
      NOW,
    );
    const second = pendingRows();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(JSON.parse(second[0].metadata_json as string)).toEqual({ v: 2 });
  });
});

describe("drainPendingEdges", () => {
  test("promotes a forward reference once its target is ingested", () => {
    seedDoc("child");
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "parent", "replies-to")], NOW);
    expect(pendingRows()).toHaveLength(1);

    // Target arrives.
    seedDoc("parent");
    const res = drainPendingEdges(db, { now: new Date(NOW) });
    expect(res.promoted).toBe(1);
    expect(pendingRows()).toHaveLength(0);
    expect(linkRows("child")[0]).toMatchObject({
      link_type: "replies-to",
      target_doc_id: "parent",
      provenance_kind: "source-declared",
    });
  });

  test("retries (keeps) a pending edge whose target is still missing and within TTL", () => {
    seedDoc("child");
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "parent", "replies-to")], NOW);
    const res = drainPendingEdges(db, { now: new Date("2026-01-01T01:00:00Z") });
    expect(res).toMatchObject({ promoted: 0, dropped: 0, retried: 1 });
    expect(pendingRows()[0].attempt_count).toBe(1);
  });

  test("drops a pending edge whose target never arrives within the TTL", () => {
    seedDoc("child");
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "parent", "replies-to")], NOW);
    // 48h later, target still missing → dropped.
    const res = drainPendingEdges(db, { now: new Date("2026-01-03T00:00:00Z") });
    expect(res).toMatchObject({ promoted: 0, dropped: 1 });
    expect(pendingRows()).toHaveLength(0);
    expect(linkRows("child")).toHaveLength(0);
  });

  test("unresolvable rows at the head do not starve resolvable rows behind the limit", () => {
    // Two never-resolving forward references, then one whose target exists.
    seedDoc("child");
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "ghost-a", "replies-to")], NOW);
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "ghost-b", "succeeds")], NOW);
    applyDeclaredEdges(db, "gmail:me", [internalEdge("child", "parent", "accompanies")], NOW);
    seedDoc("parent");

    // limit 2 per tick: the first tick retries the two ghosts; because each
    // attempt bumps last_attempt_at, the second tick must reach the
    // resolvable row instead of re-retrying the same head forever.
    const first = drainPendingEdges(db, { limit: 2, now: new Date("2026-01-01T01:00:00Z") });
    expect(first).toMatchObject({ promoted: 0, retried: 2 });
    const second = drainPendingEdges(db, { limit: 2, now: new Date("2026-01-01T01:05:00Z") });
    expect(second.promoted).toBe(1);
    expect(linkRows("child").some((r) => r.target_doc_id === "parent")).toBe(true);
  });
});

describe("web-page declared edges — bookmarks / visited", () => {
  const BOOKMARK_URL = "https://example.com/article";

  /** Seed the canonical `web` page document the URL resolves to. */
  function seedWebPage(url: string): string {
    const to = webPageEdgeTarget(url);
    if (to.kind !== "external") throw new Error("unreachable");
    const id = `web-${to.sourceDocumentId.slice(0, 12)}`;
    seedDoc(id, { sourceId: WEB_SOURCE_ID, externalId: to.sourceDocumentId });
    return id;
  }

  test("a `bookmarks` edge parks in pending_edges when the page isn't captured yet", () => {
    seedDoc("bm", { sourceId: "chrome-bookmarks:me", externalId: BOOKMARK_URL });
    const edge: EdgeDeclaration = {
      from: { kind: "internal", sourceDocumentId: BOOKMARK_URL },
      to: webPageEdgeTarget(BOOKMARK_URL),
      type: "bookmarks",
    };
    const res = applyDeclaredEdges(db, "chrome-bookmarks:me", [edge], NOW);
    expect(res).toMatchObject({ written: 0, pending: 1 });
    expect(linkRows("bm")).toHaveLength(0);
    const pending = pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      link_type: "bookmarks",
      target_source_id: WEB_SOURCE_ID,
    });
  });

  test("a deferred `bookmarks` edge resolves once the extension captures the page", () => {
    seedDoc("bm", { sourceId: "chrome-bookmarks:me", externalId: BOOKMARK_URL });
    applyDeclaredEdges(
      db,
      "chrome-bookmarks:me",
      [
        {
          from: { kind: "internal", sourceDocumentId: BOOKMARK_URL },
          to: webPageEdgeTarget(BOOKMARK_URL),
          type: "bookmarks",
        },
      ],
      NOW,
    );
    expect(pendingRows()).toHaveLength(1);

    // The extension later captures the page under source `web`.
    const webId = seedWebPage(BOOKMARK_URL);
    const res = drainPendingEdges(db, { now: new Date(NOW) });
    expect(res).toMatchObject({ promoted: 1 });
    expect(pendingRows()).toHaveLength(0);
    const rows = linkRows("bm");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      link_type: "bookmarks",
      target_doc_id: webId,
      provenance_kind: "source-declared",
    });
  });

  test("a `bookmarks` edge resolves immediately when the page already exists", () => {
    seedDoc("bm", { sourceId: "chrome-bookmarks:me", externalId: BOOKMARK_URL });
    const webId = seedWebPage(BOOKMARK_URL);
    const res = applyDeclaredEdges(
      db,
      "chrome-bookmarks:me",
      [
        {
          from: { kind: "internal", sourceDocumentId: BOOKMARK_URL },
          to: webPageEdgeTarget(BOOKMARK_URL),
          type: "bookmarks",
        },
      ],
      NOW,
    );
    expect(res).toMatchObject({ written: 1, pending: 0 });
    expect(pendingRows()).toHaveLength(0);
    expect(linkRows("bm")[0]).toMatchObject({ link_type: "bookmarks", target_doc_id: webId });
  });

  test("a day document's `visited` edges resolve to the same web page a bookmark points at", () => {
    // The bookmark and the history day both declare an edge to the SAME page —
    // proving the canonical identity joins independent producers onto one node.
    seedDoc("bm", { sourceId: "chrome-bookmarks:me", externalId: BOOKMARK_URL });
    seedDoc("chrome:2026-04-16", {
      sourceId: "browser-history:chrome",
      externalId: "chrome:2026-04-16",
    });
    const webId = seedWebPage(BOOKMARK_URL);

    applyDeclaredEdges(
      db,
      "chrome-bookmarks:me",
      [
        {
          from: { kind: "internal", sourceDocumentId: BOOKMARK_URL },
          to: webPageEdgeTarget(BOOKMARK_URL),
          type: "bookmarks",
        },
      ],
      NOW,
    );
    applyDeclaredEdges(
      db,
      "browser-history:chrome",
      [
        {
          from: { kind: "internal", sourceDocumentId: "chrome:2026-04-16" },
          to: webPageEdgeTarget(BOOKMARK_URL),
          type: "visited",
        },
      ],
      NOW,
    );

    // Both resolved to the one web node.
    expect(linkRows("bm")[0]).toMatchObject({ link_type: "bookmarks", target_doc_id: webId });
    expect(linkRows("chrome:2026-04-16")[0]).toMatchObject({
      link_type: "visited",
      target_doc_id: webId,
    });
  });
});
