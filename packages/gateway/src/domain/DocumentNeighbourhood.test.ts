// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The neighbourhood read: grouping by edge type, the per-type cap, and the
 * honest total behind it. The cap exists so a hub document costs a few lines
 * of prompt instead of hundreds, and the total exists so the caller can say
 * what it withheld rather than silently truncating.
 */

import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import { readDocumentNeighbourhood } from "./DocumentNeighbourhood.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const NOW = "2026-08-09T12:00:00.000Z";

describe("document neighbourhood", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      /* already gone */
    }
  });

  function seedDoc(id: string, opts: { documentType?: string; createdAt?: string } = {}): void {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'google', 'gmail:maya@example.com', ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      id,
      `Title ${id}`,
      `h-${id}`,
      JSON.stringify({ documentType: opts.documentType ?? "attachment" }),
      opts.createdAt ?? NOW,
      opts.createdAt ?? NOW,
      NOW,
      NOW,
    );
  }

  function link(from: string, type: string, to: string | null): void {
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(from, type, to ?? "https://example.com/x", to ?? "https://example.com/x", to, NOW, NOW);
  }

  test("groups edges by type and counts them", () => {
    seedDoc("subject");
    seedDoc("dup-1");
    seedDoc("dup-2");
    seedDoc("thread-1");
    link("subject", "duplicate-content", "dup-1");
    link("subject", "duplicate-content", "dup-2");
    link("subject", "thread", "thread-1");

    const n = readDocumentNeighbourhood(db, "subject");
    expect(n.total).toBe(3);
    expect(n.groups.map((g) => [g.linkType, g.total])).toEqual([
      ["duplicate-content", 2],
      ["thread", 1],
    ]);
  });

  test("caps each type but reports the true total", () => {
    seedDoc("subject");
    for (let i = 0; i < 38; i++) {
      seedDoc(`dup-${i}`);
      link("subject", "duplicate-content", `dup-${i}`);
    }

    const n = readDocumentNeighbourhood(db, "subject", { capPerType: 5 });
    const group = n.groups.find((g) => g.linkType === "duplicate-content")!;
    expect(group.edges).toHaveLength(5);
    expect(group.total).toBe(38);
    // The caller must be able to state what it withheld — a silently
    // truncated list reads as "these are all of them".
    expect(n.total).toBe(38);
  });

  test("includes inbound edges, marked by direction", () => {
    seedDoc("subject");
    seedDoc("mentioner");
    link("mentioner", "mention", "subject");

    const n = readDocumentNeighbourhood(db, "subject");
    expect(n.groups).toHaveLength(1);
    const edge = n.groups[0].edges[0];
    expect(edge.direction).toBe("inbound");
    expect(edge.docId).toBe("mentioner");
  });

  test("omits unresolved edges", () => {
    // An edge pointing outside the corpus adds no neighbour, and its raw
    // target is already in the document's own body.
    seedDoc("subject");
    link("subject", "url", null);

    expect(readDocumentNeighbourhood(db, "subject").total).toBe(0);
  });

  test("omits self-edges", () => {
    seedDoc("subject");
    link("subject", "duplicate-content", "subject");

    expect(readDocumentNeighbourhood(db, "subject").total).toBe(0);
  });

  test("orders neighbours newest first within a type", () => {
    seedDoc("subject");
    seedDoc("older", { createdAt: "2026-01-01T00:00:00.000Z" });
    seedDoc("newer", { createdAt: "2026-08-01T00:00:00.000Z" });
    link("subject", "duplicate-content", "older");
    link("subject", "duplicate-content", "newer");

    const edges = readDocumentNeighbourhood(db, "subject").groups[0].edges;
    expect(edges.map((e) => e.docId)).toEqual(["newer", "older"]);
  });

  test("orders groups densest first", () => {
    seedDoc("subject");
    seedDoc("thread-1");
    link("subject", "thread", "thread-1");
    for (let i = 0; i < 3; i++) {
      seedDoc(`dup-${i}`);
      link("subject", "duplicate-content", `dup-${i}`);
    }

    const n = readDocumentNeighbourhood(db, "subject");
    expect(n.groups[0].linkType).toBe("duplicate-content");
  });

  test("a document with no edges reads as empty, not as an error", () => {
    seedDoc("lonely");
    const n = readDocumentNeighbourhood(db, "lonely");
    expect(n.total).toBe(0);
    expect(n.groups).toEqual([]);
  });
});
