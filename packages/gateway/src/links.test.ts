// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { buildCanonicalizerRegistry } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import {
  createDatabase,
  upsertDocuments,
  deleteDocuments,
  deleteAllBySource,
  setSyncState,
  invalidateUrlIdPatternCache,
} from "./db.js";
import {
  setUrlCanonicalizers,
  resetUrlCanonicalizers,
  getUrlCanonicalizerSpecs,
} from "./url-canonicalizers.js";
import { setKnownUrlPatterns, resetKnownUrlPatterns } from "./known-url-patterns.js";
import { resetUrlGraphRoles, setUrlGraphRoles } from "./url-graph-roles.js";
import {
  resolveInboundLinks,
  getDocumentRefs,
  getDocumentRefsPage,
  getInboundRefCounts,
  reconcileUnresolvedLinks as reconcileUnresolvedLinksWithRoles,
  computeLinkResolutions,
  DIRECT_RESOLVABLE_SCAN_SQL,
  DIRECT_URL_OWNER_LOOKUP_SQL,
  OWNERSHIP_LINK_SCAN_SQL,
  OWNERSHIP_DOCUMENT_SCAN_SQL,
  PATTERN_OWNER_LOOKUP_SQL,
  upsertLinkResolutions,
  upsertLinkResolutionsYieldable,
  LINK_RECONCILE_APPLY_CHUNK_SIZE,
  type LinkReconcileBatch,
  type LinkReconcileApplyState,
  extractLinksForBatch,
  resolveExtractedLinks,
  withResolvedTargets,
  upsertExtractedLinksBatch,
  getLinkStats,
  computeLinkStats,
  upsertLinkStats,
  markLinkStatsDirty,
} from "./links.js";
import { sourcePrefixPredicate } from "./data/source-addressing.js";
import {
  backfillOneDocument,
  backfillSomeDocuments,
  processDocumentLinks,
} from "./domain/LinkExtraction.js";
import { collectorRosterSnapshot } from "./collector-declaration-roster.js";
import { beginLinkDeclarationUpdate, finishLinkDeclarationUpdate } from "./data/list-revisions.js";
import { linkExtractionInputDigest } from "./domain/LinkExtractionInput.js";

import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DocumentInput } from "@omnesis/types";

const reconcileUnresolvedLinks = (database: Db, limit?: number): number =>
  reconcileUnresolvedLinksWithRoles(database, limit, true);

const STRESS_KNOWN_URL_PATTERNS = Array.from(
  { length: 8 },
  (_, index) => `records[.]example/items/${index}/([0-9]+)`,
);

let db: Db;
let dbPath: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("gmail:user@gmail.com"),
    externalId: `msg-${randomUUID().slice(0, 8)}`,
    title: "Test Email",
    content: "Hello world",
    contentHash: `hash-${randomUUID().slice(0, 8)}`,
    metadata: {},
    sourceCreatedAt: "2024-01-15T10:00:00Z",
    sourceUpdatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

function getDocId(db: Db, externalId: string): string {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  return row!.id;
}

function getSourceUrl(db: Db, externalId: string): string | null {
  const row = db
    .prepare<
      [string],
      { source_url: string | null }
    >("SELECT source_url FROM documents WHERE external_id = ?")
    .get(externalId);
  return row?.source_url ?? null;
}

/**
 * Register a permissive url-id pattern so that any http(s) url link is
 * treated as "could resolve later" by the #570 storage gate — kept
 * stored (unresolved) instead of dropped at extraction. The capture
 * group is the whole url, so Strategy-2 (`external_id = <captured-url>
 * AND source_id LIKE 'google-drive%'`) never matches a real doc unless a
 * test deliberately creates one with that external_id: the pattern only
 * flips the gate, it does not fabricate resolutions. Tests asserting a
 * *specific* resolution strategy register their own pattern and/or create
 * the target doc instead of calling this.
 */
function keepUrlLinks(db: Db): void {
  setSyncState(
    db,
    "google-drive:gate@example.com",
    {},
    { urlPatterns: [{ regex: "(https?://.+)" }] },
  );
  invalidateUrlIdPatternCache();
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-links-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

describe("known-source matcher lifecycle on periodic reconciliation", () => {
  test("reuses matchers across more batches than native RE2 can rebuild", () => {
    for (let batch = 0; batch < 1_500; batch += 1) {
      const result = computeLinkResolutions(db, 1, [], [], true, STRESS_KNOWN_URL_PATTERNS, true);
      expect(result.resolutions).toEqual([]);
    }
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("processDocumentLinks — preserved link types", () => {
  // Keep extracted url links stored (unresolved) rather than dropped by
  // the #570 gate, so the pre-gate assertions about re-extraction hold.
  beforeEach(() => keepUrlLinks(db));

  test("does NOT wipe rows whose link_type is in PRESERVED_LINK_TYPES", () => {
    // The omnesis-chat citation writer inserts edges with
    // link_type='cited' that arrive pre-resolved (target_doc_id set
    // at INSERT). Those edges must survive any link backfill cycle
    // triggered by a downstream content change — otherwise an agent
    // conversation loses every citation it ever made the first time
    // the periodic backfill sees the doc.
    const owner = makeDoc({ externalId: "owner", content: "no urls here" });
    const target = makeDoc({ externalId: "target", content: "hi" });
    upsertDocuments(db, [owner, target]);
    const ownerId = getDocId(db, "owner");
    const targetId = getDocId(db, "target");

    // Hand-write a cited edge mimicking the omnesis-chat citation writer.
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
                                   target_doc_id, resolved_at, created_at, metadata_json)
       VALUES (?, 'cited', ?, ?, ?, ?, ?, ?)`,
    ).run(
      ownerId,
      `omnesis://doc/${targetId}#0`,
      `omnesis://doc/${targetId}#0`,
      targetId,
      "2026-05-23T10:00:00Z",
      "2026-05-23T10:00:00Z",
      JSON.stringify({ quote: "kept" }),
    );

    // Now drive a normal link-extraction over the same doc. With the
    // bug, this DELETE clears the cited row before re-extraction
    // finds nothing to insert (no URLs in body).
    processDocumentLinks(
      db,
      ownerId,
      owner.content,
      owner.metadata,
      String(owner.sourceId),
      owner.externalId,
      null,
    );

    const row = db
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM document_links WHERE source_doc_id = ? AND link_type = 'cited'")
      .get(ownerId);
    expect(row?.c).toBe(1);
  });

  test("URL-derived edges are still re-extracted alongside preserved cited edges", () => {
    const owner = makeDoc({
      externalId: "owner-url",
      content: "see https://example.com/article",
    });
    const cited = makeDoc({ externalId: "cited-doc" });
    upsertDocuments(db, [owner, cited]);
    const ownerId = getDocId(db, "owner-url");
    const citedId = getDocId(db, "cited-doc");

    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
                                   target_doc_id, resolved_at, created_at)
       VALUES (?, 'cited', ?, ?, ?, ?, ?)`,
    ).run(
      ownerId,
      `omnesis://doc/${citedId}#0`,
      `omnesis://doc/${citedId}#0`,
      citedId,
      "2026-05-23T10:00:00Z",
      "2026-05-23T10:00:00Z",
    );

    processDocumentLinks(
      db,
      ownerId,
      owner.content,
      owner.metadata,
      String(owner.sourceId),
      owner.externalId,
      null,
    );

    const byType = db
      .prepare<
        [string],
        { link_type: string; n: number }
      >("SELECT link_type, COUNT(*) AS n FROM document_links WHERE source_doc_id = ? GROUP BY link_type")
      .all(ownerId);
    const m = new Map(byType.map((r) => [r.link_type, r.n]));
    expect(m.get("cited")).toBe(1);
    expect(m.get("url")).toBe(1);
  });
});

describe("processDocumentLinks", () => {
  // Keep extracted url links stored (unresolved) rather than dropped by
  // the #570 gate, so the pre-gate extraction/count assertions hold.
  beforeEach(() => keepUrlLinks(db));

  test("extracts URL links from content", () => {
    const doc = makeDoc({
      externalId: "doc-1",
      content: "Check https://example.com for more.",
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "doc-1");

    const result = processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    expect(result.extracted).toBe(1);
    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].linkType).toBe("url");
    expect(refs.outbound[0].normalizedTarget).toBe("https://example.com/");
  });

  test("extracts URLs from apple-notes-style auto-link markdown", () => {
    // Reproduces apple-notes-document-links-not-extracted: the original
    // Apple Notes parser emitted `[https://x](https://x)` self-linked
    // markdown for any URL in a note. The extractor must still find the URL
    // inside that shape (it's a regular `[text](url)` form).
    const doc = makeDoc({
      externalId: "note-auto",
      sourceId: SourceId("apple-notes:test"),
      providerId: ProviderId("apple:test"),
      content:
        "# Note\n\n[https://www.theguardian.com/world/article](https://www.theguardian.com/world/article)",
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "note-auto");

    const result = processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);
    expect(result.extracted).toBe(1);
    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound[0].normalizedTarget).toBe("https://www.theguardian.com/world/article");
  });

  test("extracts bare URLs from whatsapp-style chat content", () => {
    // Reproduces whatsapp-messages-document-links-not-extracted: WhatsApp
    // day-chat docs render as `**10:30** Alice: <url>`. The bare URL must
    // be picked up by extractUrls outside any markdown link wrapper.
    const doc = makeDoc({
      externalId: "wa-day-1",
      sourceId: SourceId("whatsapp-messages:+15551234567"),
      providerId: ProviderId("whatsapp:+15551234567"),
      content:
        "# Chat — 2026-04-26\n\n**10:30** Alice: https://maps.app.goo.gl/bmJDS8cpPDcQzgPx5\nRegistration at 9:15",
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "wa-day-1");

    const result = processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);
    expect(result.extracted).toBe(1);
    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound[0].normalizedTarget).toBe("https://maps.app.goo.gl/bmJDS8cpPDcQzgPx5");
  });

  test("backfillOneDocument processes apple-notes + whatsapp docs end-to-end", async () => {
    // End-to-end: confirms the drip-feed picks up these source types and
    // populates document_links — the production complaint from both
    // findings.
    upsertDocuments(db, [
      makeDoc({
        externalId: "note-bf",
        sourceId: SourceId("apple-notes:test"),
        providerId: ProviderId("apple:test"),
        content: "# x\n\nVisit https://example.com today",
      }),
      makeDoc({
        externalId: "wa-bf",
        sourceId: SourceId("whatsapp-messages:+447700000000"),
        providerId: ProviderId("whatsapp:+447700000000"),
        content: "**11:00** Bob: https://example.org/b",
      }),
    ]);

    let processed = 0;
    while (backfillOneDocument(db) !== null) processed++;
    expect(processed).toBeGreaterThanOrEqual(2);

    const noteId = getDocId(db, "note-bf");
    const waId = getDocId(db, "wa-bf");
    expect(getDocumentRefs(db, noteId).outbound).toHaveLength(1);
    expect(getDocumentRefs(db, waId).outbound).toHaveLength(1);
  });

  test("extracts intra-source links from metadata.extra.links", () => {
    const doc = makeDoc({
      externalId: "note-1",
      sourceId: SourceId("obsidian:vault"),
      content: "Some note content",
      metadata: { extra: { links: ["Other Note", "Third Note"] } },
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "note-1");

    const result = processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    expect(result.extracted).toBe(2);
    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(2);
    expect(refs.outbound[0].linkType).toBe("references");
    expect(refs.outbound[0].normalizedTarget).toBe("other note");
  });

  test("extracts email thread links from metadata.extra.threadId", () => {
    const doc = makeDoc({
      externalId: "msg-1",
      content: "Email content",
      metadata: { extra: { threadId: "thread-abc" } },
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "msg-1");

    const result = processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    expect(result.extracted).toBe(1);
    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].linkType).toBe("part-of-thread");
  });

  test("resolves URL link via source_url match", () => {
    // First insert the target doc with a sourceUrl
    const target = makeDoc({
      externalId: "target-1",
      metadata: { sourceUrl: "https://example.com/page" },
    });
    upsertDocuments(db, [target]);

    // Insert source doc linking to that URL
    const source = makeDoc({
      externalId: "source-1",
      content: "See https://example.com/page for details.",
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "source-1");
    const targetId = getDocId(db, "target-1");

    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
    expect(refs.outbound[0].targetTitle).toBe("Test Email");
  });

  test("resolves intra-source link within same source", () => {
    // Target doc with matching external_id
    const target = makeDoc({
      externalId: "My Note",
      sourceId: SourceId("obsidian:vault"),
    });
    upsertDocuments(db, [target]);

    // Source doc referencing the target
    const source = makeDoc({
      externalId: "source-note",
      sourceId: SourceId("obsidian:vault"),
      content: "Linking to another note",
      metadata: { extra: { links: ["My Note"] } },
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "source-note");
    const targetId = getDocId(db, "My Note");

    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
  });

  test("resolves intra-source link by title when externalId has .md extension (Obsidian)", () => {
    // Target doc with .md extension in externalId but title without extension
    const target = makeDoc({
      externalId: "TargetNote.md",
      title: "TargetNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
    });
    upsertDocuments(db, [target]);

    // Source doc with wikilink [[TargetNote]] (no .md extension)
    const source = makeDoc({
      externalId: "SourceNote.md",
      title: "SourceNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
      content: "She has a cat [[TargetNote]]",
      metadata: { extra: { links: ["TargetNote"] } },
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "SourceNote.md");
    const targetId = getDocId(db, "TargetNote.md");

    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
  });

  test("resolves intra-source link by title for subfolder paths (Obsidian)", () => {
    // Target doc in subfolder
    const target = makeDoc({
      externalId: "Pets/TargetNote.md",
      title: "TargetNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
    });
    upsertDocuments(db, [target]);

    // Source doc with wikilink [[TargetNote]]
    const source = makeDoc({
      externalId: "People/SourceNote.md",
      title: "SourceNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
      content: "She has a cat [[TargetNote]]",
      metadata: { extra: { links: ["TargetNote"] } },
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "People/SourceNote.md");
    const targetId = getDocId(db, "Pets/TargetNote.md");

    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
  });

  test("does not resolve intra-source link across different sources", () => {
    const target = makeDoc({
      externalId: "My Note",
      sourceId: SourceId("obsidian:other-vault"),
    });
    upsertDocuments(db, [target]);

    const source = makeDoc({
      externalId: "source-note",
      sourceId: SourceId("obsidian:vault"),
      metadata: { extra: { links: ["My Note"] } },
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "source-note");

    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBeNull();
  });

  test("resolves email thread link to another email in same thread", () => {
    // Two emails in the same thread
    const email1 = makeDoc({
      externalId: "email-1",
      metadata: { extra: { threadId: "thread-xyz" } },
    });
    const email2 = makeDoc({
      externalId: "email-2",
      metadata: { extra: { threadId: "thread-xyz" } },
    });
    upsertDocuments(db, [email1, email2]);
    const id1 = getDocId(db, "email-1");
    const id2 = getDocId(db, "email-2");

    // Process email-1's links
    processDocumentLinks(
      db,
      id1,
      email1.content,
      email1.metadata,
      String(email1.sourceId),
      email1.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, id1);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].linkType).toBe("part-of-thread");
    expect(refs.outbound[0].targetDocId).toBe(id2);
  });

  test("does not self-link for email thread", () => {
    const email = makeDoc({
      externalId: "email-solo",
      metadata: { extra: { threadId: "thread-solo" } },
    });
    upsertDocuments(db, [email]);
    const docId = getDocId(db, "email-solo");

    processDocumentLinks(
      db,
      docId,
      email.content,
      email.metadata,
      String(email.sourceId),
      email.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBeNull();
  });

  test("re-extracts links on content update (deletes old)", () => {
    const doc = makeDoc({
      externalId: "doc-update",
      content: "Link to https://example.com",
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "doc-update");

    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);
    let refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].normalizedTarget).toBe("https://example.com/");

    // Update content with different URL
    processDocumentLinks(
      db,
      docId,
      "Link to https://other.com",
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);
    refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].normalizedTarget).toBe("https://other.com/");
  });

  test("sets links_extracted_at on the document", () => {
    const doc = makeDoc({ externalId: "ts-check", content: "no links here" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "ts-check");

    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const row = db
      .prepare<
        [string],
        { links_extracted_at: string | null }
      >("SELECT links_extracted_at FROM documents WHERE id = ?")
      .get(docId);
    expect(row!.links_extracted_at).not.toBeNull();
  });

  test("sets links_extracted_at even when doc has links", () => {
    const doc = makeDoc({ externalId: "ts-links", content: "See https://example.com" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "ts-links");

    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const row = db
      .prepare<
        [string],
        { links_extracted_at: string | null }
      >("SELECT links_extracted_at FROM documents WHERE id = ?")
      .get(docId);
    expect(row!.links_extracted_at).not.toBeNull();
  });
});

describe("resolveInboundLinks", () => {
  // Keep the source's url link stored (unresolved) so the later
  // target-arrival resolution path has a row to resolve (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("leaves URL target arrival to the role-aware read-side reconciler", () => {
    // Source doc with URL link (target doesn't exist yet)
    const source = makeDoc({
      externalId: "source-1",
      content: "See https://example.com/page",
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "source-1");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Verify unresolved
    let refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound[0].targetDocId).toBeNull();

    // Now insert the target doc
    const target = makeDoc({
      externalId: "target-1",
      metadata: { sourceUrl: "https://example.com/page" },
    });
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "target-1");
    const targetSourceUrl = getSourceUrl(db, "target-1");

    const resolved = resolveInboundLinks(
      db,
      targetId,
      targetSourceUrl,
      String(target.sourceId),
      target.externalId,
    );
    expect(resolved).toBe(0);

    const batch = computeLinkResolutions(db, 50);
    expect(batch.resolutions).toContainEqual({
      linkId: expect.any(Number),
      targetDocId: targetId,
    });
    expect(upsertLinkResolutions(db, batch).updated).toBe(1);

    // Verify resolved
    refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
  });

  test("resolves inbound intra-source link by title when target doc arrives (Obsidian)", () => {
    // Source doc with wikilink [[TargetNote]] — target doesn't exist yet
    const source = makeDoc({
      externalId: "SourceNote.md",
      title: "SourceNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
      providerId: ProviderId("obsidian:MyVault"),
      content: "She has a cat [[TargetNote]]",
      metadata: { extra: { links: ["TargetNote"] } },
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "SourceNote.md");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Verify unresolved
    let refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBeNull();

    // Now the target doc arrives with .md extension in externalId
    const target = makeDoc({
      externalId: "TargetNote.md",
      title: "TargetNote",
      sourceId: SourceId("obsidian-notes:MyVault"),
      providerId: ProviderId("obsidian:MyVault"),
      content: "I am a cat",
    });
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "TargetNote.md");

    const resolved = resolveInboundLinks(
      db,
      targetId,
      null,
      String(target.sourceId),
      target.externalId,
    );
    expect(resolved).toBe(1);

    // Verify resolved
    refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound[0].targetDocId).toBe(targetId);
  });
});

describe("getDocumentRefs", () => {
  test("returns both outbound and inbound refs", () => {
    const doc1 = makeDoc({ externalId: "d1", content: "Link to https://target.com" });
    const doc2 = makeDoc({
      externalId: "d2",
      metadata: { sourceUrl: "https://target.com" },
      content: "I am the target",
    });
    upsertDocuments(db, [doc1, doc2]);
    const id1 = getDocId(db, "d1");
    const id2 = getDocId(db, "d2");

    processDocumentLinks(
      db,
      id1,
      doc1.content,
      doc1.metadata,
      String(doc1.sourceId),
      doc1.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);
    processDocumentLinks(
      db,
      id2,
      doc2.content,
      doc2.metadata,
      String(doc2.sourceId),
      doc2.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refsD1 = getDocumentRefs(db, id1);
    expect(refsD1.outbound).toHaveLength(1);
    expect(refsD1.outbound[0].targetDocId).toBe(id2);
    expect(refsD1.inbound).toHaveLength(0);

    const refsD2 = getDocumentRefs(db, id2);
    expect(refsD2.inbound).toHaveLength(1);
    expect(refsD2.inbound[0].sourceDocId).toBe(id1);
  });

  test("refs carry each document's published link, not its canonical key", () => {
    // The canonical `source_url` strips tracking params; the refs must hand
    // clients the link the source published, which is what opens.
    const doc1 = makeDoc({
      externalId: "pub-1",
      content: "Link to https://target.com/page",
      metadata: { sourceUrl: "https://origin.com/post?utm_campaign=launch" },
    });
    const doc2 = makeDoc({
      externalId: "pub-2",
      metadata: { sourceUrl: "https://target.com/page?utm_source=news" },
      content: "I am the target",
    });
    upsertDocuments(db, [doc1, doc2]);
    const id1 = getDocId(db, "pub-1");
    const id2 = getDocId(db, "pub-2");
    expect(getSourceUrl(db, "pub-2")).toBe("https://target.com/page");
    for (const [id, doc] of [
      [id1, doc1],
      [id2, doc2],
    ] as const) {
      processDocumentLinks(
        db,
        id,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
      reconcileUnresolvedLinks(db, 1000);
    }

    const out = getDocumentRefs(db, id1).outbound[0];
    expect(out.targetDocId).toBe(id2);
    expect(out.targetSourceUrl).toBe("https://target.com/page?utm_source=news");
    expect(getDocumentRefs(db, id2).inbound[0].sourceSourceUrl).toBe(
      "https://origin.com/post?utm_campaign=launch",
    );
    const outPage = getDocumentRefsPage(db, id1, "outbound", { limit: 10 }).items[0];
    expect(outPage).toMatchObject({ targetSourceUrl: "https://target.com/page?utm_source=news" });
    const inPage = getDocumentRefsPage(db, id2, "inbound", { limit: 10 }).items[0];
    expect(inPage).toMatchObject({
      sourceSourceUrl: "https://origin.com/post?utm_campaign=launch",
    });
  });

  test("returns empty refs for doc with no links", () => {
    const doc = makeDoc({ externalId: "lonely" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "lonely");

    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(0);
    expect(refs.inbound).toHaveLength(0);
  });
});

describe("getInboundRefCounts", () => {
  test("returns counts for docs with inbound refs", () => {
    const source1 = makeDoc({ externalId: "s1", content: "Link to https://target.com" });
    const source2 = makeDoc({ externalId: "s2", content: "Also https://target.com" });
    const target = makeDoc({
      externalId: "t1",
      metadata: { sourceUrl: "https://target.com" },
    });
    upsertDocuments(db, [source1, source2, target]);
    const targetId = getDocId(db, "t1");

    for (const ext of ["s1", "s2"]) {
      const id = getDocId(db, ext);
      const doc = ext === "s1" ? source1 : source2;
      processDocumentLinks(
        db,
        id,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
      reconcileUnresolvedLinks(db, 1000);
    }

    const counts = getInboundRefCounts(db, [targetId, "nonexistent"]);
    expect(counts.get(targetId)).toBe(2);
    expect(counts.has("nonexistent")).toBe(false);
  });

  test("returns empty map for empty input", () => {
    const counts = getInboundRefCounts(db, []);
    expect(counts.size).toBe(0);
  });
});

describe("reconcileUnresolvedLinks", () => {
  // Keep extracted url links stored (unresolved) so the reconcile pass
  // has rows to resolve once their targets arrive (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("resolves links that can now be matched", () => {
    // Create source doc with unresolved URL link
    const source = makeDoc({ externalId: "s1", content: "See https://example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "s1");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Insert target (without triggering resolveInboundLinks)
    const target = makeDoc({ externalId: "t1", metadata: { sourceUrl: "https://example.com" } });
    upsertDocuments(db, [target]);

    // Run reconciliation
    const resolved = reconcileUnresolvedLinks(db);
    expect(resolved).toBe(1);

    const refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound[0].targetDocId).toBe(getDocId(db, "t1"));
  });

  test("respects limit parameter", () => {
    // Create 5 source docs with unresolved links
    for (let i = 0; i < 5; i++) {
      const doc = makeDoc({ externalId: `lim-${i}`, content: `See https://nonexistent-${i}.com` });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, `lim-${i}`);
      processDocumentLinks(
        db,
        docId,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
      reconcileUnresolvedLinks(db, 1000);
    }

    // Insert targets for all of them
    for (let i = 0; i < 5; i++) {
      const target = makeDoc({
        externalId: `lim-t-${i}`,
        metadata: { sourceUrl: `https://nonexistent-${i}.com` },
      });
      upsertDocuments(db, [target]);
    }

    // Reconcile with limit 2
    const resolved = reconcileUnresolvedLinks(db, 2);
    expect(resolved).toBeLessThanOrEqual(2);
  });

  test("returns 0 when nothing to resolve", () => {
    expect(reconcileUnresolvedLinks(db)).toBe(0);
  });

  test("unknown persisted link types remain inert at the database boundary", () => {
    const source = makeDoc({ externalId: "future-edge-source", content: "No links." });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, source.externalId);
    db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES (?, 'future-edge-kind', 'future-target', 'future-target', ?)`,
    ).run(sourceId, "2026-01-01T00:00:00.000Z");

    expect(() => computeLinkResolutions(db, 50, [])).not.toThrow();
    expect(computeLinkResolutions(db, 50, []).resolutions).toContainEqual({
      linkId: db
        .prepare<
          [],
          { id: number }
        >("SELECT id FROM document_links WHERE link_type = 'future-edge-kind'")
        .get()!.id,
      targetDocId: null,
    });
  });
});

describe("computeLinkResolutions / upsertLinkResolutions (split path)", () => {
  // Keep extracted url links stored (unresolved) so the compute/upsert
  // split path has rows to resolve and report (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  // The direct scan is the safety net for links both eager (#569) and
  // inbound resolution missed. Its cost must track the unresolved backlog,
  // never the corpus: driven from `documents`, it pays a full corpus pass
  // every tick precisely when there is nothing to find, which is the steady
  // state. A result assertion cannot see that — both directions return the
  // same rows — so the plan itself is the thing under test.
  test("the direct safety-net scan is driven from links and probes documents by url", () => {
    const plan = db
      .prepare<[number, number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN ${DIRECT_RESOLVABLE_SCAN_SQL}`,
      )
      .all(20_000, 50)
      .map((row) => row.detail);

    // The unresolved-link partial index drives.
    expect(
      plan.some((d) =>
        /document_links USING (COVERING )?INDEX idx_document_links_unresolved/.test(d),
      ),
    ).toBe(true);
    // Documents are probed one indexed lookup at a time, never walked.
    expect(
      plan.some((d) => /SEARCH d USING (COVERING )?INDEX idx_documents_source_url/.test(d)),
    ).toBe(true);
    expect(plan.some((d) => /^SCAN documents\b/.test(d) || /^SCAN d\b/.test(d))).toBe(false);
  });

  test("the ownership scans advance by rowid without a corpus scan or temp sort", () => {
    const linkPlan = db
      .prepare<[number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN ${OWNERSHIP_LINK_SCAN_SQL}`,
      )
      .all(0, 100_000, 20_000)
      .map((row) => row.detail);
    expect(linkPlan.some((d) => /SEARCH dl USING INTEGER PRIMARY KEY \(rowid>\?/.test(d))).toBe(
      true,
    );
    expect(linkPlan.some((d) => /TEMP B-TREE/.test(d))).toBe(false);

    const documentPlan = db
      .prepare<[number, number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN ${OWNERSHIP_DOCUMENT_SCAN_SQL}`,
      )
      .all(0, 100_000, 20_000)
      .map((row) => row.detail);
    expect(
      documentPlan.some((d) => /SEARCH documents USING INTEGER PRIMARY KEY \(rowid>\?/.test(d)),
    ).toBe(true);
    expect(documentPlan.some((d) => /TEMP B-TREE/.test(d))).toBe(false);
  });

  test("URL ownership target probes are index-backed and bounded", () => {
    const directSql = DIRECT_URL_OWNER_LOOKUP_SQL.replace(
      "/*FALLBACK_PREDICATE*/",
      "source_id = ?",
    ).replace("/*REFERENCE_PREDICATE*/", "source_id = ?");
    const direct = db
      .prepare<[string, string, string], { detail: string }>(`EXPLAIN QUERY PLAN ${directSql}`)
      .all("https://code.example.org/item/1", "web", "chrome")
      .map((row) => row.detail);
    expect(direct.some((detail) => detail.includes("idx_documents_source_url"))).toBe(true);
    expect(direct.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);

    const patternSource = sourcePrefixPredicate("source_id", ["test-issues"]);
    const patternSql = PATTERN_OWNER_LOOKUP_SQL.replace(
      "/*SOURCE_PREDICATE*/",
      patternSource.sql,
    ).replace("/*REFERENCE_PREDICATE*/", "0");
    const pattern = db
      .prepare<[string, string, string], { detail: string }>(`EXPLAIN QUERY PLAN ${patternSql}`)
      .all("17", ...patternSource.params)
      .map((row) => row.detail);
    expect(pattern.some((detail) => detail.includes("idx_documents_external_id_source"))).toBe(
      true,
    );
    expect(pattern.some((detail) => /^SCAN documents\b/.test(detail))).toBe(false);
  });

  test("the direct scan resolves a link the cursor has not reached yet", () => {
    // A link created first, its target ingested later, and a reconcile
    // cursor already advanced past the link. Only the direct scan can see
    // this one before the cursor wraps.
    const source = makeDoc({ externalId: "net-s", content: "See https://net.example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "net-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    // Push the cursor past every existing link, so scan (1) is exhausted.
    const maxLinkId = db
      .prepare<[], { m: number }>("SELECT MAX(id) AS m FROM document_links")
      .get();
    db.prepare(
      "INSERT INTO link_reconcile_state (id, cursor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
    ).run((maxLinkId?.m ?? 0) + 1000);

    const target = makeDoc({
      externalId: "net-t",
      metadata: { sourceUrl: "https://net.example.com" },
    });
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "net-t");

    const batch = computeLinkResolutions(db, 50);
    const resolved = batch.resolutions.filter((r) => r.targetDocId !== null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetDocId).toBe(targetId);
    // The cursor belongs to scan (1) and must not be moved by this path.
    expect(batch.scannedMaxId).toBe(0);
  });

  test("duplicate documents for one URL cannot consume the direct-scan result budget", () => {
    const refs = [
      makeDoc({ externalId: "fanout-ref-a", content: "See https://a.fanout.example/item" }),
      makeDoc({ externalId: "fanout-ref-b", content: "See https://b.fanout.example/item" }),
    ];
    upsertDocuments(db, refs);
    for (const ref of refs) {
      processDocumentLinks(
        db,
        getDocId(db, ref.externalId),
        ref.content,
        ref.metadata,
        String(ref.sourceId),
        ref.externalId,
        null,
      );
    }
    const duplicateTargets = Array.from({ length: 20 }, (_, i) =>
      makeDoc({
        externalId: `fanout-target-a-${i}`,
        metadata: { sourceUrl: "https://a.fanout.example/item" },
      }),
    );
    const targetB = makeDoc({
      externalId: "fanout-target-b",
      metadata: { sourceUrl: "https://b.fanout.example/item" },
    });
    upsertDocuments(db, [...duplicateTargets, targetB]);
    const maxLinkId = db
      .prepare<[], { value: number }>("SELECT MAX(id) AS value FROM document_links")
      .get()!.value;
    db.prepare(
      "INSERT INTO link_reconcile_state (id, cursor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
    ).run(maxLinkId + 100);

    const resolved = computeLinkResolutions(db, 2).resolutions.filter(
      (row) => row.targetDocId !== null,
    );
    expect(resolved.map((row) => row.linkId).sort((a, b) => a - b)).toEqual(
      db
        .prepare<[], { id: number }>(
          "SELECT id FROM document_links WHERE source_doc_id IN (?, ?) ORDER BY id",
        )
        .all(getDocId(db, "fanout-ref-a"), getDocId(db, "fanout-ref-b"))
        .map((row) => row.id),
    );
  });

  test("the unresolved URL cursor wraps at a fixed cycle maximum under continuous ingest", () => {
    const insertUnresolved = (label: string): number => {
      const source = makeDoc({ externalId: `moving-tail-${label}` });
      upsertDocuments(db, [source]);
      return Number(
        db
          .prepare(
            `INSERT INTO document_links
               (source_doc_id, link_type, raw_target, normalized_target, created_at)
             VALUES (?, 'url', ?, ?, ?)`,
          )
          .run(
            getDocId(db, source.externalId),
            `https://unresolved.example/${label}`,
            `https://unresolved.example/${label}`,
            "2026-01-01T00:00:00Z",
          ).lastInsertRowid,
      );
    };

    const initialIds = [
      insertUnresolved("initial-a"),
      insertUnresolved("initial-b"),
      insertUnresolved("initial-c"),
    ];
    const initialMax = initialIds.at(-1)!;
    const tailIds: number[] = [];
    for (const expectedId of initialIds) {
      const batch = computeLinkResolutions(db, 1, [], [], true, ["(https?://.+)"]);
      expect(batch.scannedMaxId).toBe(expectedId);
      expect(batch.urlCycleMaxId).toBe(initialMax);
      upsertLinkResolutions(db, batch);
      tailIds.push(insertUnresolved(`new-${tailIds.length}`));
    }

    const wrap = computeLinkResolutions(db, 1, [], [], true, ["(https?://.+)"]);
    expect(wrap.scannedMaxId).toBe(0);
    expect(
      wrap.urlCycleMaxId,
      JSON.stringify(db.prepare("SELECT * FROM link_reconcile_state WHERE id = 1").get()),
    ).toBe(initialMax);
    upsertLinkResolutions(db, wrap);
    expect(
      db
        .prepare<
          [],
          { cursor: number; max: number; cycles: number }
        >("SELECT cursor, url_cycle_max_id AS max, cycle_count AS cycles FROM link_reconcile_state WHERE id = 1")
        .get(),
    ).toEqual({ cursor: 0, max: 0, cycles: 1 });

    const nextCycle = computeLinkResolutions(db, 1, [], [], true, ["(https?://.+)"]);
    // A fresh cycle legitimately revisits the still-unresolved original rows,
    // but its fixed maximum now includes everything that arrived during the
    // preceding cycle. It will therefore reach the old tail and wrap again
    // even if more rows continue to arrive behind that boundary.
    expect(nextCycle.scannedMaxId).toBe(initialIds[0]);
    expect(nextCycle.urlCycleMaxId).toBe(tailIds.at(-1));
  });

  test("a migration-seeded quiet cycle wraps and revisits unresolved links behind its cursor", () => {
    const source = makeDoc({ externalId: "quiet-upgrade-source" });
    upsertDocuments(db, [source]);
    const linkId = Number(
      db
        .prepare(
          `INSERT INTO document_links
             (source_doc_id, link_type, raw_target, normalized_target, created_at)
           VALUES (?, 'url', ?, ?, ?)`,
        )
        .run(
          getDocId(db, source.externalId),
          "https://quiet.example/item",
          "https://quiet.example/item",
          "2026-01-01T00:00:00Z",
        ).lastInsertRowid,
    );
    // Migration 145 seeds url_cycle_max_id from the preserved legacy cursor.
    db.prepare("UPDATE link_reconcile_state SET cursor = ?, url_cycle_max_id = ? WHERE id = 1").run(
      linkId,
      linkId,
    );

    const wrap = computeLinkResolutions(db, 1, [], [], true, ["quiet[.]example"]);
    expect(wrap.scannedMaxId).toBe(0);
    expect(wrap.urlCycleMaxId).toBe(linkId);
    upsertLinkResolutions(db, wrap);
    expect(
      db.prepare("SELECT cursor, url_cycle_max_id FROM link_reconcile_state WHERE id = 1").get(),
    ).toEqual({ cursor: 0, url_cycle_max_id: 0 });

    expect(computeLinkResolutions(db, 1, [], [], true, ["quiet[.]example"]).scannedMaxId).toBe(
      linkId,
    );
  });

  test("writer refuses a reconcile batch computed before a collector joined", () => {
    keepUrlLinks(db);
    const target = makeDoc({
      externalId: "roster-target",
      metadata: { sourceUrl: "https://roster.example/item" },
    });
    const source = makeDoc({
      externalId: "roster-source",
      content: "See https://roster.example/item",
    });
    upsertDocuments(db, [target, source]);
    const sourceId = getDocId(db, "roster-source");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    const batch = computeLinkResolutions(db, 50, [], [], true, [], true, []);
    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('collector-new', 'New collector', 'collector', 1)",
    ).run();

    expect(upsertLinkResolutions(db, batch)).toEqual({ updated: 0, deleted: 0, retargeted: 0 });
    const stored = db
      .prepare<
        [string],
        { target_doc_id: string | null }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .get(sourceId);
    expect(stored?.target_doc_id).toBeNull();
  });

  test("writer refuses a reconcile batch after the same collector replaces URL roles", () => {
    const target = makeDoc({ externalId: "role-race-target" });
    const source = makeDoc({
      externalId: "role-race-source",
      content: "See https://role-race.example/item",
    });
    upsertDocuments(db, [target, source]);
    const sourceId = getDocId(db, source.externalId);
    const targetId = getDocId(db, target.externalId);
    const link = db
      .prepare(
        `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES (?, 'url', ?, ?, ?)`,
      )
      .run(
        sourceId,
        "https://role-race.example/item",
        "https://role-race.example/item",
        "2026-01-01T00:00:00Z",
      );
    const revision = collectorRosterSnapshot(db).revision;
    const batch: LinkReconcileBatch = {
      resolutions: [{ linkId: Number(link.lastInsertRowid), targetDocId: targetId }],
      deletableLinkIds: [],
      scannedMaxId: Number(link.lastInsertRowid),
      expectedCollectorRosterRevision: revision,
    };

    beginLinkDeclarationUpdate(db);
    setUrlGraphRoles("test", ["replacement-hub"], [], []);
    finishLinkDeclarationUpdate(db);

    expect(upsertLinkResolutions(db, batch)).toEqual({ updated: 0, deleted: 0, retargeted: 0 });
    expect(getDocumentRefs(db, sourceId).outbound[0].targetDocId).toBeNull();
    expect(
      db
        .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
        .get()!.cursor,
    ).toBe(0);
  });

  test("writer reconciliation yields after each bounded mutation chunk and advances its cursor last", () => {
    const target = makeDoc({ externalId: "bounded-target" });
    const sources = Array.from({ length: LINK_RECONCILE_APPLY_CHUNK_SIZE * 2 + 17 }, (_, i) =>
      makeDoc({ externalId: `bounded-source-${i}` }),
    );
    upsertDocuments(db, [target, ...sources]);
    const targetId = getDocId(db, "bounded-target");
    const insertLink = db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES (?, 'url', 'https://bounded.example/item', 'https://bounded.example/item', ?)`,
    );
    const resolutions = sources.map((source) => {
      const sourceId = getDocId(db, source.externalId);
      const info = insertLink.run(sourceId, "2026-01-01T00:00:00Z");
      return { linkId: Number(info.lastInsertRowid), targetDocId: targetId };
    });
    const scannedMaxId = resolutions.at(-1)!.linkId;
    const token = { requested: () => true };
    let input: LinkReconcileBatch | LinkReconcileApplyState = {
      resolutions,
      deletableLinkIds: [],
      scannedMaxId,
    };
    let calls = 0;
    for (;;) {
      const before = db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE target_doc_id IS NOT NULL")
        .get()!.n;
      const result = upsertLinkResolutionsYieldable(db, input, { token });
      const after = db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE target_doc_id IS NOT NULL")
        .get()!.n;
      expect(after - before).toBeLessThanOrEqual(LINK_RECONCILE_APPLY_CHUNK_SIZE);
      calls += 1;
      if (result.remaining === null) break;
      expect(
        db
          .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
          .get()!.cursor,
      ).toBe(0);
      input = result.remaining;
    }

    expect(calls).toBeGreaterThan(2);
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE target_doc_id IS NOT NULL")
        .get()!.n,
    ).toBe(resolutions.length);
    expect(
      db
        .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
        .get()!.cursor,
    ).toBe(scannedMaxId);
  });

  test("a collector-roster change between writer chunks stops the continuation without advancing cursors", () => {
    const target = makeDoc({ externalId: "roster-chunk-target" });
    const sources = Array.from({ length: LINK_RECONCILE_APPLY_CHUNK_SIZE + 7 }, (_, i) =>
      makeDoc({ externalId: `roster-chunk-source-${i}` }),
    );
    upsertDocuments(db, [target, ...sources]);
    const targetId = getDocId(db, "roster-chunk-target");
    const insertLink = db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES (?, 'url', 'https://roster-chunk.example/item', 'https://roster-chunk.example/item', ?)`,
    );
    const resolutions = sources.map((source) => {
      const info = insertLink.run(getDocId(db, source.externalId), "2026-01-01T00:00:00Z");
      return { linkId: Number(info.lastInsertRowid), targetDocId: targetId };
    });
    const first = upsertLinkResolutionsYieldable(
      db,
      {
        resolutions,
        deletableLinkIds: [],
        scannedMaxId: resolutions.at(-1)!.linkId,
        expectedCollectorRosterRevision: collectorRosterSnapshot(db).revision,
      },
      { token: { requested: () => true } },
    );
    expect(first.remaining).not.toBeNull();
    expect(first.updated).toBe(LINK_RECONCILE_APPLY_CHUNK_SIZE);

    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('collector-mid-chunk', 'Collector', 'collector', 1)",
    ).run();
    const stopped = upsertLinkResolutionsYieldable(db, first.remaining!, {
      token: { requested: () => true },
    });
    expect(stopped.remaining).toBeNull();
    expect(stopped.updated).toBe(LINK_RECONCILE_APPLY_CHUNK_SIZE);
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE target_doc_id IS NOT NULL")
        .get()!.n,
    ).toBe(LINK_RECONCILE_APPLY_CHUNK_SIZE);
    expect(
      db
        .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
        .get()!.cursor,
    ).toBe(0);
  });

  test("compute returns the same set of resolutions reconcile would apply", () => {
    // Source doc with unresolved URL link
    const source = makeDoc({ externalId: "split-s", content: "See https://split.example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "split-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Insert target so the link is now resolvable
    const target = makeDoc({
      externalId: "split-t",
      metadata: { sourceUrl: "https://split.example.com" },
    });
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "split-t");

    const batch = computeLinkResolutions(db, 50);
    expect(batch.resolutions.length).toBeGreaterThanOrEqual(1);
    const resolved = batch.resolutions.filter((r) => r.targetDocId !== null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetDocId).toBe(targetId);

    // compute is read-only — no DB state should have changed
    const refsBefore = getDocumentRefs(db, sourceId);
    expect(refsBefore.outbound[0].targetDocId).toBeNull();
  });

  test("upsert applied to compute output produces same final state as reconcile", () => {
    // Run two parallel scenarios in the same DB: process sources first
    // (so links are unresolved), then insert targets WITHOUT triggering
    // resolveInboundLinks, then reconcile via the split path.
    const sourceA = makeDoc({ externalId: "splitA-s", content: "See https://splitA.example.com" });
    const sourceB = makeDoc({ externalId: "splitB-s", content: "See https://splitB.example.com" });
    upsertDocuments(db, [sourceA, sourceB]);

    for (const ext of ["splitA-s", "splitB-s"]) {
      const id = getDocId(db, ext);
      const doc = ext === "splitA-s" ? sourceA : sourceB;
      processDocumentLinks(
        db,
        id,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
      reconcileUnresolvedLinks(db, 1000);
    }

    // Insert targets after processing (so resolveInboundLinks doesn't fire here)
    const targetA = makeDoc({
      externalId: "splitA-t",
      metadata: { sourceUrl: "https://splitA.example.com" },
    });
    const targetB = makeDoc({
      externalId: "splitB-t",
      metadata: { sourceUrl: "https://splitB.example.com" },
    });
    upsertDocuments(db, [targetA, targetB]);

    // Apply split path
    const batch = computeLinkResolutions(db, 50);
    const { updated } = upsertLinkResolutions(db, batch);
    expect(updated).toBe(2);

    // Both A and B should be resolved
    const refsA = getDocumentRefs(db, getDocId(db, "splitA-s"));
    const refsB = getDocumentRefs(db, getDocId(db, "splitB-s"));
    expect(refsA.outbound[0].targetDocId).toBe(getDocId(db, "splitA-t"));
    expect(refsB.outbound[0].targetDocId).toBe(getDocId(db, "splitB-t"));
  });

  test("compute returns null targetDocId for links that still can't resolve", () => {
    // Source doc with link to a target that doesn't exist
    const source = makeDoc({
      externalId: "unresolved-s",
      content: "See https://no-target.example.com",
    });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "unresolved-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const batch = computeLinkResolutions(db, 50);
    expect(batch.resolutions).toHaveLength(1);
    expect(batch.resolutions[0].targetDocId).toBeNull();

    // upsert should skip null rows, no writes
    const { updated } = upsertLinkResolutions(db, batch);
    expect(updated).toBe(0);
  });

  test("upsert is idempotent and skips rows already resolved", () => {
    // Process source first (link unresolved), then insert target so the
    // outbound link is still NULL after upsertDocuments (we don't pass
    // sourceUrl to processDocumentLinks → no resolveInboundLinks here).
    const source = makeDoc({ externalId: "idem-s", content: "See https://idem.example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "idem-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Now insert target — target's processDocumentLinks isn't called,
    // but upsertDocuments doesn't auto-resolve inbound either, so the
    // source's link stays unresolved until reconcile.
    const target = makeDoc({
      externalId: "idem-t",
      metadata: { sourceUrl: "https://idem.example.com" },
    });
    upsertDocuments(db, [target]);

    const batch = computeLinkResolutions(db, 50);
    expect(batch.resolutions.filter((r) => r.targetDocId !== null)).toHaveLength(1);

    const first = upsertLinkResolutions(db, batch);
    expect(first.updated).toBe(1);

    // Re-applying the same batch: rows already have target_doc_id set,
    // the WHERE clause `target_doc_id IS NULL` skips them.
    const second = upsertLinkResolutions(db, batch);
    expect(second.updated).toBe(0);
  });

  test("upsert with empty batch is a no-op", () => {
    const result = upsertLinkResolutions(db, {
      resolutions: [],
      scannedMaxId: 0,
      deletableLinkIds: [],
    });
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test("split path produces same final state as reconcileUnresolvedLinks", async () => {
    // Build identical scenarios in two separate DBs and verify
    // document_links converges to the same state.
    const otherPath = `/tmp/omnesis-links-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      // Seed both DBs identically. We deliberately do NOT call
      // reconcileUnresolvedLinks here — this test's whole point is to
      // compare the legacy `reconcileUnresolvedLinks(db, N)` path against
      // the explicit `compute + upsert` split. Both DBs need the same
      // unresolved starting state.
      for (const target of [db, otherDb]) {
        const source = makeDoc({ externalId: "conv-s", content: "Visit https://conv.example.com" });
        const targetDoc = makeDoc({
          externalId: "conv-t",
          metadata: { sourceUrl: "https://conv.example.com" },
        });
        upsertDocuments(target, [source, targetDoc]);
        const id = target
          .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
          .get("conv-s")!.id;
        processDocumentLinks(
          target,
          id,
          source.content,
          source.metadata,
          String(source.sourceId),
          source.externalId,
          null,
        );
      }

      // Apply legacy path to db, split path to otherDb
      const legacyResolved = reconcileUnresolvedLinks(db, 50);
      const otherBatch = computeLinkResolutions(otherDb, 50);
      const { updated: splitResolved } = upsertLinkResolutions(otherDb, otherBatch);

      expect(legacyResolved).toBe(splitResolved);

      // Compare final state — both should have identical resolved links
      const dbState = db
        .prepare<
          [],
          {
            source_doc_id: string;
            link_type: string;
            normalized_target: string;
            target_doc_id: string | null;
          }
        >(
          "SELECT source_doc_id, link_type, normalized_target, target_doc_id FROM document_links ORDER BY id",
        )
        .all();
      const otherState = otherDb
        .prepare<
          [],
          {
            source_doc_id: string;
            link_type: string;
            normalized_target: string;
            target_doc_id: string | null;
          }
        >(
          "SELECT source_doc_id, link_type, normalized_target, target_doc_id FROM document_links ORDER BY id",
        )
        .all();

      // source_doc_id and target_doc_id are random UUIDs and won't match
      // across DBs, but the resolution shape (count, link_type, normalized_target,
      // and "did target_doc_id end up non-null?") must be identical.
      expect(dbState.length).toBe(otherState.length);
      for (let i = 0; i < dbState.length; i++) {
        expect(dbState[i].link_type).toBe(otherState[i].link_type);
        expect(dbState[i].normalized_target).toBe(otherState[i].normalized_target);
        expect(dbState[i].target_doc_id !== null).toBe(otherState[i].target_doc_id !== null);
      }
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("resolves a URL link whose target exists even when the cursor is past it", () => {
    // Regression for the URL-backlog starvation finding: a URL link that
    // points at an already-ingested doc must resolve on the next tick via
    // the direct source_url join (3), not wait for the cursor to walk the
    // whole external-URL backlog. We simulate "cursor far ahead of the
    // link" by manually advancing link_reconcile_state past the link id.
    const target = makeDoc({
      externalId: "cursor-t",
      metadata: { sourceUrl: "https://cursor.example.com" },
    });
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "cursor-t");

    const source = makeDoc({ externalId: "cursor-s", content: "See https://cursor.example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "cursor-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    // #569 resolves url links eagerly at extraction; un-resolve here to
    // exercise the reconcile DIRECT SCAN / cursor scan on the historical
    // backlog of links inserted before eager resolution existed.
    db.prepare(
      "UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL WHERE link_type = 'url'",
    ).run();

    const linkId = db
      .prepare<
        [string],
        { id: number }
      >("SELECT id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .get(sourceId)!.id;
    // Advance the cursor well past the link so the cursor scan (1) returns
    // nothing for it this tick.
    db.prepare("UPDATE link_reconcile_state SET cursor = ? WHERE id = 1").run(linkId + 1_000_000);

    const batch = computeLinkResolutions(db, 50);
    const resolved = batch.resolutions.filter((r) => r.targetDocId !== null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].linkId).toBe(linkId);
    expect(resolved[0].targetDocId).toBe(targetId);
    // The cursor scan was empty, so scannedMaxId stays 0 (cursor wraps on
    // upsert) — the direct scan is what produced the resolution.
    expect(batch.scannedMaxId).toBe(0);

    const { updated } = upsertLinkResolutions(db, batch);
    expect(updated).toBe(1);
    expect(getDocumentRefs(db, sourceId).outbound[0].targetDocId).toBe(targetId);
  });

  test("upsert skips a resolution whose target was deleted between compute and apply", () => {
    // FK-poison regression: computeLinkResolutions runs on the read handle
    // and may resolve a link to a doc that the writer deletes before
    // upsertLinkResolutions applies the batch. Without the EXISTS guard the
    // dangling target_doc_id would violate the FK, throw, and roll back the
    // ENTIRE batch (every sibling resolution + the cursor advance), and the
    // cursor-independent direct scan would re-derive the same poison every
    // tick. The guard degrades it to a no-op so the rest of the batch
    // commits.
    const targetGone = makeDoc({
      externalId: "fk-gone-t",
      metadata: { sourceUrl: "https://fk-gone.example.com" },
    });
    const targetOk = makeDoc({
      externalId: "fk-ok-t",
      metadata: { sourceUrl: "https://fk-ok.example.com" },
    });
    upsertDocuments(db, [targetGone, targetOk]);
    const okTargetId = getDocId(db, "fk-ok-t");

    const srcGone = makeDoc({
      externalId: "fk-gone-s",
      content: "See https://fk-gone.example.com",
    });
    const srcOk = makeDoc({ externalId: "fk-ok-s", content: "See https://fk-ok.example.com" });
    upsertDocuments(db, [srcGone, srcOk]);
    for (const [ext, doc] of [
      ["fk-gone-s", srcGone],
      ["fk-ok-s", srcOk],
    ] as const) {
      processDocumentLinks(
        db,
        getDocId(db, ext),
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
    }

    // #569 resolves url links eagerly at extraction; un-resolve here to
    // exercise the reconcile DIRECT SCAN / cursor scan on the historical
    // backlog of links inserted before eager resolution existed.
    db.prepare(
      "UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL WHERE link_type = 'url'",
    ).run();

    // Compute the batch while both targets exist — both links resolve.
    const batch = computeLinkResolutions(db, 50);
    expect(batch.resolutions.filter((r) => r.targetDocId !== null).length).toBeGreaterThanOrEqual(
      2,
    );

    // Delete one target between compute and apply.
    deleteDocuments(db, "google", String(srcGone.sourceId), ["fk-gone-t"]);

    // Apply must not throw despite the now-dangling targetDocId in the batch.
    let updated = 0;
    expect(() => {
      updated = upsertLinkResolutions(db, batch).updated;
    }).not.toThrow();
    // The surviving resolution committed; the dangling one was skipped.
    expect(updated).toBe(1);
    expect(getDocumentRefs(db, getDocId(db, "fk-ok-s")).outbound[0].targetDocId).toBe(okTargetId);
    expect(getDocumentRefs(db, getDocId(db, "fk-gone-s")).outbound[0].targetDocId).toBeNull();
  });

  test("compute respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const doc = makeDoc({
        externalId: `clim-${i}`,
        content: `See https://clim-${i}.example.com`,
      });
      upsertDocuments(db, [doc]);
      const id = getDocId(db, `clim-${i}`);
      processDocumentLinks(
        db,
        id,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );
      reconcileUnresolvedLinks(db, 1000);
    }

    const batch = computeLinkResolutions(db, 2);
    expect(batch.resolutions.length).toBeLessThanOrEqual(2);
  });
});

describe("retroactive URL ownership", () => {
  const sharedUrl = "https://code.example.org/projects/northstar/issues/17";
  const fallbackSourceId = SourceId("test-url-capture:local");
  const referenceSourceId = SourceId("test-url-reference:local");
  const ownerSourceId = SourceId("test-issues:local");
  const fallbackPrefixes = ["test-url-capture"] as const;
  const referencePrefixes = ["test-url-reference"] as const;

  beforeEach(() => {
    keepUrlLinks(db);
    setUrlGraphRoles("test", [], ["test-url-capture"], []);
  });

  afterEach(() => resetUrlGraphRoles());

  function insertHubCapture(externalId = "captured-issue-17", sourceUrl = sharedUrl): string {
    const capture = makeDoc({
      providerId: ProviderId("test-browser"),
      sourceId: fallbackSourceId,
      externalId,
      title: "Captured issue page",
      content: "Rendered page text retained from a browser visit.",
      contentHash: `capture-content-hash-${externalId}`,
      metadata: { documentType: "webpage", sourceUrl },
    });
    upsertDocuments(db, [capture]);
    return getDocId(db, capture.externalId);
  }

  function insertInboundLink(externalId: string): { referrerId: string; linkId: number } {
    const referrer = makeDoc({
      sourceId: SourceId("test-messages:local"),
      externalId,
      content: `Review ${sharedUrl}`,
    });
    upsertDocuments(db, [referrer]);
    const referrerId = getDocId(db, referrer.externalId);
    processDocumentLinks(
      db,
      referrerId,
      referrer.content,
      referrer.metadata,
      String(referrer.sourceId),
      referrer.externalId,
      null,
    );

    const link = db
      .prepare<
        [string],
        { id: number; target_doc_id: string | null }
      >("SELECT id, target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .get(referrerId)!;
    const resolved = resolveExtractedLinks(
      db,
      [
        {
          docId: referrerId,
          contentHash: `hash-${externalId}`,
          sourceId: String(referrer.sourceId),
          links: [{ type: "url", rawTarget: sharedUrl, normalizedTarget: sharedUrl }],
        },
      ],
      fallbackPrefixes,
    )[0]?.resolvedTargets?.[`url\u0000${sharedUrl}`];
    if (resolved) {
      db.prepare("UPDATE document_links SET target_doc_id = ?, resolved_at = ? WHERE id = ?").run(
        resolved,
        new Date().toISOString(),
        link.id,
      );
    }
    return { referrerId, linkId: link.id };
  }

  function insertOwningDocument(externalId = "owning-issue-17", sourceUrl = sharedUrl): string {
    const owner = makeDoc({
      providerId: ProviderId("test-issues"),
      sourceId: ownerSourceId,
      externalId,
      title: "Issue 17",
      content: "Structured issue body and discussion.",
      contentHash: `owner-content-hash-${externalId}`,
      metadata: { documentType: "issue", sourceUrl },
    });
    upsertDocuments(db, [owner]);
    return getDocId(db, owner.externalId);
  }

  function insertReferenceDocument(externalId = "bookmark-issue-17"): string {
    const reference = makeDoc({
      providerId: ProviderId("test-browser"),
      sourceId: referenceSourceId,
      externalId,
      title: "Issue bookmark",
      content: "A saved pointer to the issue.",
      metadata: { documentType: "bookmark", sourceUrl: sharedUrl },
    });
    upsertDocuments(db, [reference]);
    return getDocId(db, reference.externalId);
  }

  test("an unresolved URL chooses an owner over an existing fallback capture", () => {
    const captureId = insertHubCapture();
    const ownerId = insertOwningDocument();
    expect(
      resolveExtractedLinks(
        db,
        [
          {
            docId: "synthetic-referrer",
            contentHash: "synthetic-referrer-hash",
            sourceId: "test-messages:local",
            links: [{ type: "url", rawTarget: sharedUrl, normalizedTarget: sharedUrl }],
          },
        ],
        fallbackPrefixes,
      )[0]?.resolvedTargets,
    ).toEqual({ [`url\u0000${sharedUrl}`]: ownerId });
    const { referrerId, linkId } = insertInboundLink("new-unresolved-link");
    // Model a link inserted by the split batch path: extraction has landed,
    // but its read-side resolution has not yet been applied.
    db.prepare(
      "UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL WHERE id = ?",
    ).run(linkId);

    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));

    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(ownerId);
    expect(ownerId).not.toBe(captureId);
  });

  test("an owner is found even after hundreds of reference-only documents share its URL", () => {
    for (let i = 0; i < 300; i += 1) insertReferenceDocument(`many-bookmarks-${i}`);
    const ownerId = insertOwningDocument("owner-after-many-bookmarks");
    const resolved = resolveExtractedLinks(
      db,
      [
        {
          docId: "many-bookmarks-referrer",
          contentHash: "many-bookmarks-referrer-hash",
          sourceId: "test-messages:local",
          links: [{ type: "url", rawTarget: sharedUrl, normalizedTarget: sharedUrl }],
        },
      ],
      fallbackPrefixes,
      referencePrefixes,
    )[0]?.resolvedTargets?.[`url\u0000${sharedUrl}`];

    expect(resolved).toBe(ownerId);
  });

  test("a reference-only document never claims a newly resolved URL", () => {
    insertReferenceDocument();
    const ownerId = insertOwningDocument();
    const entry = {
      docId: "synthetic-referrer",
      contentHash: "synthetic-reference-test-hash",
      sourceId: "test-messages:local",
      links: [{ type: "url" as const, rawTarget: sharedUrl, normalizedTarget: sharedUrl }],
    };

    expect(
      resolveExtractedLinks(db, [entry], fallbackPrefixes, referencePrefixes, false)[0]
        ?.resolvedTargets,
    ).toBeUndefined();

    expect(
      resolveExtractedLinks(db, [entry], fallbackPrefixes, referencePrefixes)[0]?.resolvedTargets,
    ).toEqual({ [`url\u0000${sharedUrl}`]: ownerId });

    db.prepare("DELETE FROM documents WHERE id = ?").run(ownerId);
    expect(
      resolveExtractedLinks(db, [entry], fallbackPrefixes, referencePrefixes)[0]?.resolvedTargets,
    ).toBeUndefined();
  });

  test("a reference-only document cannot claim a URL through its own ID pattern", () => {
    const patternedUrl = "https://reference.example/items/item-17";
    setSyncState(
      db,
      String(referenceSourceId),
      {},
      {
        urlPatterns: [{ regex: "reference[.]example/items/(item-[0-9]+)" }],
      },
    );
    invalidateUrlIdPatternCache();
    const reference = makeDoc({
      providerId: ProviderId("test-browser"),
      sourceId: referenceSourceId,
      externalId: "item-17",
      title: "Saved item pointer",
      content: "A saved reference.",
      metadata: { documentType: "bookmark", sourceUrl: patternedUrl },
    });
    upsertDocuments(db, [reference]);
    const entry = {
      docId: "pattern-referrer",
      contentHash: "pattern-referrer-hash",
      sourceId: "test-messages:local",
      links: [{ type: "url" as const, rawTarget: patternedUrl, normalizedTarget: patternedUrl }],
    };

    expect(
      resolveExtractedLinks(db, [entry], fallbackPrefixes, referencePrefixes)[0]?.resolvedTargets,
    ).toBeUndefined();
  });

  test("periodic URL resolution pauses until the complete target roles arrive", () => {
    insertReferenceDocument();
    const ownerId = insertOwningDocument();
    const { referrerId, linkId } = insertInboundLink("roles-not-ready");
    db.prepare(
      "UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL WHERE id = ?",
    ).run(linkId);

    const beforeRoles = computeLinkResolutions(db, 50, [], [], false);
    expect(beforeRoles.resolutions).not.toContainEqual({ linkId, targetDocId: ownerId });
    upsertLinkResolutions(db, beforeRoles);
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBeNull();

    upsertLinkResolutions(
      db,
      computeLinkResolutions(db, 50, fallbackPrefixes, referencePrefixes, true),
    );
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(ownerId);
  });

  test("extraction keeps a URL until both role and pattern declarations are ready", () => {
    db.prepare("DELETE FROM sync_state").run();
    invalidateUrlIdPatternCache();
    const entry = {
      docId: "startup-race-referrer",
      contentHash: "startup-race-hash",
      sourceId: "test-messages:local",
      links: [{ type: "url" as const, rawTarget: sharedUrl, normalizedTarget: sharedUrl }],
    };

    const rolesMissing = resolveExtractedLinks(db, [entry], [], [], false, [], true);
    expect(rolesMissing[0]?.discardedUrlTargets).toBeUndefined();

    const patternsMissing = resolveExtractedLinks(db, [entry], [], [], true, [], false);
    expect(patternsMissing[0]?.discardedUrlTargets).toBeUndefined();

    const bothReady = resolveExtractedLinks(db, [entry], [], [], true, [], true);
    expect(bothReady[0]?.discardedUrlTargets).toEqual([sharedUrl]);
  });

  test("historical URL targets on a reference are cleared until a real target exists", () => {
    const referenceId = insertReferenceDocument();
    const { referrerId, linkId } = insertInboundLink("historical-reference-only");
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run(referenceId, linkId);

    const batch = computeLinkResolutions(db, 50, fallbackPrefixes, referencePrefixes);
    expect(batch.retargets).toEqual([
      {
        linkId,
        previousTargetDocId: referenceId,
        targetDocId: null,
        normalizedTarget: sharedUrl,
        connectRepresentations: false,
      },
    ]);
    expect(upsertLinkResolutions(db, batch).retargeted).toBe(1);
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBeNull();
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
        .get(referenceId)?.n,
    ).toBe(0);
  });

  test("historical URL targets move from a reference to the owner without identity-linking them", () => {
    const referenceId = insertReferenceDocument();
    const { referrerId, linkId } = insertInboundLink("historical-reference-with-owner");
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run(referenceId, linkId);
    const ownerId = insertOwningDocument();

    const batch = computeLinkResolutions(db, 50, fallbackPrefixes, referencePrefixes);
    expect(batch.retargets).toContainEqual({
      linkId,
      previousTargetDocId: referenceId,
      targetDocId: ownerId,
      normalizedTarget: sharedUrl,
      connectRepresentations: false,
    });
    upsertLinkResolutions(db, batch);

    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(ownerId);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
        .get(referenceId)?.n,
    ).toBe(0);
  });

  test("representations are connected even when no inbound URL link exists", () => {
    const captureId = insertHubCapture();
    const ownerId = insertOwningDocument();

    const batch = computeLinkResolutions(db, 50, fallbackPrefixes);
    expect(batch.retargets).toEqual([]);
    expect(batch.sameResourceUpdates).toEqual([
      {
        sourceDocId: captureId,
        normalizedTarget: sharedUrl,
        targetDocId: ownerId,
        expectedSourceUrl: sharedUrl,
        expectedPriorNormalizedTarget: null,
        expectedPriorTargetDocId: null,
        expectedPriorTargetSourceUrl: null,
      },
    ]);
    upsertLinkResolutions(db, batch);

    expect(
      db
        .prepare<[string], { normalized_target: string; target_doc_id: string | null }>(
          `SELECT normalized_target, target_doc_id FROM document_links
            WHERE source_doc_id = ? AND link_type = 'same-resource'`,
        )
        .get(captureId),
    ).toEqual({ normalized_target: sharedUrl, target_doc_id: ownerId });
  });

  test("a source declassified as a fallback loses its derived representation edge", () => {
    const captureId = insertHubCapture();
    insertOwningDocument();
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));

    db.prepare(
      "UPDATE link_reconcile_state SET ownership_document_cursor = 0, ownership_document_max_rowid = 0 WHERE id = 1",
    ).run();
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, ["web"]));

    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
        .get(captureId)?.n,
    ).toBe(0);
  });

  test("a stale owner change cannot be applied and a reinserted owner heals the identity edge", () => {
    const captureId = insertHubCapture();
    const { referrerId } = insertInboundLink("ownership-race-link");
    const ownerId = insertOwningDocument();
    const batch = computeLinkResolutions(db, 50, fallbackPrefixes);

    db.prepare("UPDATE documents SET source_url = ? WHERE id = ?").run(
      "https://code.example.org/projects/northstar/issues/18",
      ownerId,
    );
    expect(upsertLinkResolutions(db, batch).retargeted).toBe(0);
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(captureId);

    db.prepare("UPDATE documents SET source_url = ? WHERE id = ?").run(sharedUrl, ownerId);
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    db.prepare("DELETE FROM documents WHERE id = ?").run(ownerId);
    db.prepare(
      "UPDATE link_reconcile_state SET ownership_document_cursor = 0, ownership_document_max_rowid = 0 WHERE id = 1",
    ).run();
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    expect(
      db
        .prepare<
          [string],
          { target_doc_id: string | null }
        >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
        .get(captureId),
    ).toBeUndefined();

    const replacementId = insertOwningDocument("replacement-owner");
    db.prepare(
      "UPDATE link_reconcile_state SET ownership_document_cursor = 0, ownership_document_max_rowid = 0 WHERE id = 1",
    ).run();
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    expect(getDocumentRefs(db, captureId).outbound[0].targetDocId).toBe(replacementId);
  });

  test("ownership changes wait for the complete target-role declaration set", () => {
    const captureId = insertHubCapture();
    resetUrlGraphRoles();
    const { referrerId } = insertInboundLink("offline-collector-link");
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(captureId);
    insertOwningDocument();

    upsertLinkResolutions(db, computeLinkResolutions(db, 50, []));
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(captureId);

    setUrlGraphRoles("test", [], ["test-url-capture"], []);
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).not.toBe(captureId);
  });

  test("an existing owner is never stolen by another owner claimant", () => {
    const firstOwnerId = insertOwningDocument("first-owner");
    const { referrerId } = insertInboundLink("stable-non-hub-link");
    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(firstOwnerId);

    const secondOwnerId = insertOwningDocument("second-owner");
    expect(secondOwnerId).not.toBe(firstOwnerId);
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));

    expect(getDocumentRefs(db, referrerId).outbound[0].targetDocId).toBe(firstOwnerId);
  });

  test("ownership cursors neither skip a capped batch nor chase a growing tail", () => {
    const captureId = insertHubCapture();
    const first = insertInboundLink("cursor-link-a");
    const second = insertInboundLink("cursor-link-b");
    const ownerId = insertOwningDocument();

    const firstBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(firstBatch.retargets?.map((row) => row.linkId)).toEqual([first.linkId]);
    upsertLinkResolutions(db, firstBatch);

    const third = insertInboundLink("cursor-link-new-tail");
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run(
      captureId,
      third.linkId,
    );

    const secondBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(secondBatch.retargets?.map((row) => row.linkId)).toEqual([second.linkId]);
    expect(secondBatch.ownershipLinkCycleMaxId).toBe(firstBatch.ownershipLinkCycleMaxId);
    upsertLinkResolutions(db, secondBatch);

    const wrapBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(wrapBatch.retargets).toEqual([]);
    expect(wrapBatch.ownershipLinkScannedMaxId).toBe(0);
    upsertLinkResolutions(db, wrapBatch);

    const nextCycle = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(nextCycle.retargets?.map((row) => row.linkId)).toEqual([third.linkId]);
    upsertLinkResolutions(db, nextCycle);
    expect(getDocumentRefs(db, third.referrerId).outbound[0].targetDocId).toBe(ownerId);
  });

  test("ownership planning caps each writer mutation kind even when runtime batch is large", () => {
    for (let i = 0; i < 60; i++) {
      const url = `${sharedUrl}/bounded-${i}`;
      const captureId = insertHubCapture(`bounded-capture-${i}`, url);
      const referrer = makeDoc({
        sourceId: SourceId("test-messages:local"),
        externalId: `bounded-referrer-${i}`,
        content: `Review ${url}`,
      });
      upsertDocuments(db, [referrer]);
      const referrerId = getDocId(db, referrer.externalId);
      processDocumentLinks(
        db,
        referrerId,
        referrer.content,
        referrer.metadata,
        String(referrer.sourceId),
        referrer.externalId,
        null,
      );
      db.prepare(
        `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
          WHERE source_doc_id = ? AND link_type = 'url'`,
      ).run(captureId, "2026-01-01T00:00:00.000Z", referrerId);
      insertOwningDocument(`bounded-owner-${i}`, url);
    }
    db.prepare(
      `UPDATE link_reconcile_state
          SET ownership_link_cursor = 0, ownership_link_max_id = 0,
              ownership_document_cursor = 0, ownership_document_max_rowid = 0
        WHERE id = 1`,
    ).run();

    const batch = computeLinkResolutions(db, 5_000, fallbackPrefixes);
    expect(batch.retargets).toHaveLength(50);
    expect(batch.sameResourceUpdates).toHaveLength(50);
  });

  test("document ownership cursor neither skips a capped batch nor chases a growing tail", () => {
    const firstUrl = `${sharedUrl}/representation-a`;
    const secondUrl = `${sharedUrl}/representation-b`;
    const thirdUrl = `${sharedUrl}/representation-new-tail`;
    const firstCaptureId = insertHubCapture("cursor-capture-a", firstUrl);
    const firstOwnerId = insertOwningDocument("cursor-owner-a", firstUrl);
    const secondCaptureId = insertHubCapture("cursor-capture-b", secondUrl);
    const secondOwnerId = insertOwningDocument("cursor-owner-b", secondUrl);

    const firstBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(firstBatch.sameResourceUpdates).toEqual([
      expect.objectContaining({ sourceDocId: firstCaptureId, targetDocId: firstOwnerId }),
    ]);
    upsertLinkResolutions(db, firstBatch);

    const thirdCaptureId = insertHubCapture("cursor-capture-new-tail", thirdUrl);
    const thirdOwnerId = insertOwningDocument("cursor-owner-new-tail", thirdUrl);

    const secondBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(secondBatch.sameResourceUpdates).toEqual([
      expect.objectContaining({ sourceDocId: secondCaptureId, targetDocId: secondOwnerId }),
    ]);
    expect(secondBatch.ownershipDocumentCycleMaxRowid).toBe(
      firstBatch.ownershipDocumentCycleMaxRowid,
    );
    upsertLinkResolutions(db, secondBatch);

    const finishCycleBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(finishCycleBatch.sameResourceUpdates).toEqual([]);
    expect(finishCycleBatch.ownershipDocumentScannedMaxRowid).toBe(
      firstBatch.ownershipDocumentCycleMaxRowid,
    );
    upsertLinkResolutions(db, finishCycleBatch);

    const wrapBatch = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(wrapBatch.sameResourceUpdates).toEqual([]);
    expect(wrapBatch.ownershipDocumentScannedMaxRowid).toBe(0);
    upsertLinkResolutions(db, wrapBatch);

    const nextCycle = computeLinkResolutions(db, 1, fallbackPrefixes);
    expect(nextCycle.sameResourceUpdates).toEqual([
      expect.objectContaining({ sourceDocId: thirdCaptureId, targetDocId: thirdOwnerId }),
    ]);
  });

  test("retarget apply is idempotent and CAS-safe and creates one same-resource edge", () => {
    const captureId = insertHubCapture();
    const first = insertInboundLink("retarget-link-a");
    const second = insertInboundLink("retarget-link-b");
    expect(getDocumentRefs(db, first.referrerId).outbound[0].targetDocId).toBe(captureId);
    expect(getDocumentRefs(db, second.referrerId).outbound[0].targetDocId).toBe(captureId);

    const firstOwnerId = insertOwningDocument("preferred-owner");
    const secondOwnerId = insertOwningDocument("concurrent-owner");
    const batch = computeLinkResolutions(db, 50, fallbackPrefixes);
    expect(batch.retargets).toHaveLength(2);
    const ownerId = batch.retargets![0].targetDocId;
    expect([firstOwnerId, secondOwnerId]).toContain(ownerId);
    expect(batch.retargets!.every((row) => row.targetDocId === ownerId)).toBe(true);
    const competingOwnerId = ownerId === firstOwnerId ? secondOwnerId : firstOwnerId;

    // Simulate another writer choosing a different owner after compute.
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run(
      competingOwnerId,
      second.linkId,
    );

    const firstApply = upsertLinkResolutions(db, batch);
    expect(firstApply.retargeted).toBe(1);
    expect(getDocumentRefs(db, first.referrerId).outbound[0].targetDocId).toBe(ownerId);
    expect(getDocumentRefs(db, second.referrerId).outbound[0].targetDocId).toBe(competingOwnerId);

    const sameResourceRows = () =>
      db
        .prepare<[string], { target_doc_id: string | null }>(
          `SELECT target_doc_id FROM document_links
            WHERE source_doc_id = ? AND link_type = 'same-resource'`,
        )
        .all(captureId);
    expect(sameResourceRows()).toEqual([{ target_doc_id: ownerId }]);

    const secondApply = upsertLinkResolutions(db, batch);
    expect(secondApply.retargeted).toBe(0);
    expect(sameResourceRows()).toEqual([{ target_doc_id: ownerId }]);
  });

  test("a stale representation batch cannot overwrite a newer valid edge", () => {
    const captureId = insertHubCapture();
    const firstOwnerId = insertOwningDocument("race-owner-a");
    const secondOwnerId = insertOwningDocument("race-owner-b");
    upsertLinkResolutions(db, computeLinkResolutions(db, 50, fallbackPrefixes));
    const current = db
      .prepare<
        [string],
        { target_doc_id: string }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
      .get(captureId)!.target_doc_id;
    const alternate = current === firstOwnerId ? secondOwnerId : firstOwnerId;

    const temporaryUrl = "https://code.example.org/projects/northstar/issues/temporary";
    db.prepare("UPDATE documents SET source_url = ? WHERE id = ?").run(temporaryUrl, current);
    db.prepare(
      "UPDATE link_reconcile_state SET ownership_document_cursor = 0, ownership_document_max_rowid = 0 WHERE id = 1",
    ).run();
    const stale = computeLinkResolutions(db, 50, fallbackPrefixes);
    expect(
      stale.sameResourceUpdates?.find((row) => row.sourceDocId === captureId)?.targetDocId,
    ).toBe(alternate);

    db.prepare("UPDATE documents SET source_url = ? WHERE id = ?").run(sharedUrl, current);
    upsertLinkResolutions(db, stale);
    expect(
      db
        .prepare<
          [string],
          { target_doc_id: string }
        >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'same-resource'")
        .get(captureId)?.target_doc_id,
    ).toBe(current);
  });
});

describe("backfillOneDocument", () => {
  // Keep extracted url links stored (unresolved) so backfill's `extracted`
  // count reflects the pre-gate behavior (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("processes one unprocessed document", () => {
    const doc = makeDoc({ externalId: "b1", content: "Link to https://example.com" });
    upsertDocuments(db, [doc]);

    const result = backfillOneDocument(db);
    expect(result).not.toBeNull();
    expect(result!.extracted).toBe(1);
  });

  test("returns null when no unprocessed documents remain", () => {
    const doc = makeDoc({ externalId: "already", content: "Link to https://example.com" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "already");
    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const result = backfillOneDocument(db);
    expect(result).toBeNull();
  });

  test("marks docs with no links so they aren't re-processed", () => {
    const doc = makeDoc({ externalId: "no-links", content: "Plain text, no URLs" });
    upsertDocuments(db, [doc]);

    const result1 = backfillOneDocument(db);
    expect(result1).not.toBeNull();
    expect(result1!.extracted).toBe(0);

    // Second call should not find anything
    const result2 = backfillOneDocument(db);
    expect(result2).toBeNull();
  });

  test("processes multiple docs one at a time", () => {
    for (let i = 0; i < 3; i++) {
      upsertDocuments(db, [
        makeDoc({ externalId: `multi-${i}`, content: `Link https://example.com/${i}` }),
      ]);
    }

    let count = 0;
    while (backfillOneDocument(db) !== null) {
      count++;
    }
    expect(count).toBe(3);
  });
});

describe("getLinkStats", () => {
  // Keep extracted url links stored (unresolved) so the link-count stats
  // include them as the pre-gate assertions expect (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("returns correct stats", () => {
    const source = makeDoc({
      externalId: "stats-s",
      content: "Link to https://example.com and https://other.com",
      metadata: { extra: { links: ["Note A"] } },
    });
    const target = makeDoc({
      externalId: "stats-t",
      metadata: { sourceUrl: "https://example.com" },
    });
    upsertDocuments(db, [source, target]);
    const sourceId = getDocId(db, "stats-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const stats = getLinkStats(db);
    expect(stats.totalLinks).toBe(3); // 2 URLs + 1 references
    expect(stats.resolvedLinks).toBe(1); // only the example.com URL
    expect(stats.unresolvedLinks).toBe(2);
    expect(stats.byType["url"].total).toBe(2);
    expect(stats.byType["url"].resolved).toBe(1);
    expect(stats.byType["references"].total).toBe(1);
  });

  test("returns zeros when no links exist", () => {
    const stats = getLinkStats(db);
    expect(stats.totalLinks).toBe(0);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(0);
  });
});

describe("CASCADE/SET NULL behavior", () => {
  // Keep extracted url links stored so there's a row to CASCADE/SET NULL
  // when the source/target doc is deleted (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("deleting source doc cascades to its outbound links", () => {
    const source = makeDoc({ externalId: "cascade-s", content: "See https://example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "cascade-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Verify link exists
    let stats = getLinkStats(db);
    expect(stats.totalLinks).toBe(1);

    // Delete source doc directly (bypassing `deleteDocuments`, so the
    // link_stats mark-dirty doesn't fire automatically — emulate it
    // here so the materialized row's `getLinkStats` re-reads).
    db.prepare("DELETE FROM documents WHERE id = ?").run(sourceId);
    db.prepare(
      "UPDATE refresh_meta SET needs_refresh = 1, dirty_version = dirty_version + 1 WHERE job = 'link_graph'",
    ).run();

    // Link should be gone (CASCADE)
    stats = getLinkStats(db);
    expect(stats.totalLinks).toBe(0);
  });

  test("deleting target doc sets target_doc_id to NULL", () => {
    const target = makeDoc({
      externalId: "setnull-t",
      metadata: { sourceUrl: "https://example.com" },
    });
    const source = makeDoc({ externalId: "setnull-s", content: "See https://example.com" });
    upsertDocuments(db, [target, source]);
    const sourceId = getDocId(db, "setnull-s");
    const targetId = getDocId(db, "setnull-t");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Verify resolved
    let refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound[0].targetDocId).toBe(targetId);

    // Delete target
    db.prepare("DELETE FROM documents WHERE id = ?").run(targetId);

    // Link should still exist but with null target
    refs = getDocumentRefs(db, sourceId);
    expect(refs.outbound).toHaveLength(1);
    expect(refs.outbound[0].targetDocId).toBeNull();
  });
});

describe("source_url backfill and storage", () => {
  test("stores normalized source_url on insert", () => {
    const doc = makeDoc({
      externalId: "url-store",
      metadata: { sourceUrl: "https://EXAMPLE.COM/Path?utm_source=test" },
    });
    upsertDocuments(db, [doc]);

    const sourceUrl = getSourceUrl(db, "url-store");
    expect(sourceUrl).toBe("https://example.com/Path");
  });

  test("stores null source_url when no sourceUrl in metadata", () => {
    const doc = makeDoc({ externalId: "no-url" });
    upsertDocuments(db, [doc]);

    const sourceUrl = getSourceUrl(db, "no-url");
    expect(sourceUrl).toBeNull();
  });
});

describe("deduplication", () => {
  // Keep the (duplicated) url link stored so the dedup-to-one assertion
  // has a row to assert on (#570 gate).
  beforeEach(() => keepUrlLinks(db));

  test("deduplicates links by (type, normalizedTarget)", () => {
    const doc = makeDoc({
      externalId: "dedup",
      content: "Link: https://example.com and again https://example.com",
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "dedup");

    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    const refs = getDocumentRefs(db, docId);
    expect(refs.outbound).toHaveLength(1);
  });
});

describe("attachment links", () => {
  test("attachment doc links to parent email via parentExternalId", () => {
    // Create parent email first
    const email = makeDoc({
      externalId: "msg-123",
      title: "Test Email",
      content: "Email body",
      metadata: {
        documentType: "email",
        extra: { threadId: "thread-1", attachments: [{ filename: "report.pdf", extracted: true }] },
      },
    });
    upsertDocuments(db, [email]);
    const emailId = getDocId(db, "msg-123");
    processDocumentLinks(
      db,
      emailId,
      email.content,
      email.metadata,
      String(email.sourceId),
      email.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Create attachment doc with parentExternalId
    const attachment = makeDoc({
      externalId: "msg-123/att/att-1",
      title: "report.pdf",
      content: "PDF extracted text",
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: "msg-123" },
      },
    });
    upsertDocuments(db, [attachment]);
    const attId = getDocId(db, "msg-123/att/att-1");
    processDocumentLinks(
      db,
      attId,
      attachment.content,
      attachment.metadata,
      String(attachment.sourceId),
      attachment.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Attachment should have outbound link to parent
    const attRefs = getDocumentRefs(db, attId);
    expect(attRefs.outbound).toHaveLength(1);
    expect(attRefs.outbound[0].linkType).toBe("contains");
    expect(attRefs.outbound[0].targetDocId).toBe(emailId);

    // Parent should have inbound ref from attachment
    const emailRefs = getDocumentRefs(db, emailId);
    expect(emailRefs.inbound).toHaveLength(1);
    expect(emailRefs.inbound[0].sourceDocId).toBe(attId);
    expect(emailRefs.inbound[0].linkType).toBe("contains");
  });

  test("attachment link resolves when parent arrives after attachment", () => {
    // Create attachment doc first (parent doesn't exist yet)
    const attachment = makeDoc({
      externalId: "msg-456/att/att-1",
      title: "invoice.pdf",
      content: "Invoice text",
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: "msg-456" },
      },
    });
    upsertDocuments(db, [attachment]);
    const attId = getDocId(db, "msg-456/att/att-1");
    processDocumentLinks(
      db,
      attId,
      attachment.content,
      attachment.metadata,
      String(attachment.sourceId),
      attachment.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Verify unresolved
    let attRefs = getDocumentRefs(db, attId);
    expect(attRefs.outbound).toHaveLength(1);
    expect(attRefs.outbound[0].targetDocId).toBeNull();

    // Now parent arrives
    const email = makeDoc({
      externalId: "msg-456",
      title: "Email with invoice",
      content: "See attached",
    });
    upsertDocuments(db, [email]);
    const emailId = getDocId(db, "msg-456");

    // resolveInboundLinks should resolve the attachment link
    const resolved = resolveInboundLinks(
      db,
      emailId,
      null,
      String(email.sourceId),
      email.externalId,
    );
    expect(resolved).toBe(1);

    // Verify resolved
    attRefs = getDocumentRefs(db, attId);
    expect(attRefs.outbound[0].targetDocId).toBe(emailId);
  });

  test("attachment link does not resolve across different source IDs", () => {
    const attachment = makeDoc({
      sourceId: SourceId("gmail:user1@gmail.com"),
      externalId: "msg-789/att/att-1",
      content: "PDF text",
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: "msg-789" },
      },
    });
    upsertDocuments(db, [attachment]);
    const attId = getDocId(db, "msg-789/att/att-1");
    processDocumentLinks(
      db,
      attId,
      attachment.content,
      attachment.metadata,
      String(attachment.sourceId),
      attachment.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Parent exists but under different source
    const wrongSource = makeDoc({
      sourceId: SourceId("outlook-email:user@outlook.com"),
      externalId: "msg-789",
      content: "Different email",
    });
    upsertDocuments(db, [wrongSource]);
    const wrongId = getDocId(db, "msg-789");
    resolveInboundLinks(db, wrongId, null, String(wrongSource.sourceId), wrongSource.externalId);

    // Should NOT resolve — different source
    const attRefs = getDocumentRefs(db, attId);
    expect(attRefs.outbound[0].targetDocId).toBeNull();
  });

  test("reconciliation resolves attachment links", () => {
    const attachment = makeDoc({
      externalId: "msg-recon/att/att-1",
      content: "PDF text",
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: "msg-recon" },
      },
    });
    upsertDocuments(db, [attachment]);
    const attId = getDocId(db, "msg-recon/att/att-1");
    processDocumentLinks(
      db,
      attId,
      attachment.content,
      attachment.metadata,
      String(attachment.sourceId),
      attachment.externalId,
      null,
    );
    reconcileUnresolvedLinks(db, 1000);

    // Insert parent without resolveInboundLinks
    const email = makeDoc({
      externalId: "msg-recon",
      content: "Parent email",
    });
    upsertDocuments(db, [email]);

    // Run reconciliation
    const resolved = reconcileUnresolvedLinks(db);
    expect(resolved).toBe(1);

    const attRefs = getDocumentRefs(db, attId);
    expect(attRefs.outbound[0].targetDocId).toBe(getDocId(db, "msg-recon"));
  });
});

describe("extractLinksForBatch + upsertExtractedLinksBatch (split path)", () => {
  test("extractLinksForBatch returns same set of links as backfillSomeDocuments would have inserted", () => {
    const otherPath = `/tmp/omnesis-links-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      // Seed identical docs in both DBs.
      const docs: DocumentInput[] = [
        makeDoc({ externalId: "split-1", content: "Visit https://a.example.com/x" }),
        makeDoc({
          externalId: "split-2",
          content: "Two URLs: https://b.example.com and https://c.example.com",
        }),
        makeDoc({
          externalId: "split-3",
          sourceId: SourceId("obsidian:vault"),
          metadata: { extra: { links: ["Other Note"] } },
        }),
      ];
      for (const target of [db, otherDb]) {
        upsertDocuments(target, docs);
      }

      // Legacy path: in-line extraction inside writer.
      const legacyResult = backfillSomeDocuments(db, docs.length);
      expect(legacyResult.processed).toBe(docs.length);

      // Split path: compute on read handle, upsert on write handle.
      const batch = extractLinksForBatch(otherDb, docs.length, [], [], true, [], true);
      expect(batch.length).toBe(docs.length);
      const upsertResult = upsertExtractedLinksBatch(otherDb, batch);
      expect(upsertResult.applied).toBe(docs.length);
      expect(upsertResult.skipped).toBe(0);
      expect(upsertResult.extracted).toBe(legacyResult.extracted);

      // Compare resulting document_links rows: same shape, modulo the
      // random doc IDs. Compare (link_type, normalized_target) sets per
      // external_id; target_doc_id stays NULL on the split path because
      // resolution is deferred to the periodic compute reconcile.
      type Row = { external_id: string; link_type: string; normalized_target: string };
      const fetch = (target: Db): Row[] =>
        target
          .prepare<[], Row>(
            `SELECT d.external_id, dl.link_type, dl.normalized_target
           FROM document_links dl JOIN documents d ON dl.source_doc_id = d.id
           ORDER BY d.external_id, dl.link_type, dl.normalized_target`,
          )
          .all();
      const legacyRows = fetch(db);
      const splitRows = fetch(otherDb);
      expect(splitRows).toEqual(legacyRows);
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("resolves a url link to an existing target eagerly on the read handle (#569)", () => {
    const otherPath = `/tmp/omnesis-links-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      const target = makeDoc({
        externalId: "eager-t",
        metadata: { sourceUrl: "https://eager.example.com" },
      });
      const source = makeDoc({ externalId: "eager-s", content: "See https://eager.example.com" });
      upsertDocuments(otherDb, [target, source]);
      const targetId = getDocId(otherDb, "eager-t");
      const sourceDocId = getDocId(otherDb, "eager-s");

      // The compute phase resolves the url link on the read handle.
      const batch = extractLinksForBatch(otherDb, 10, [], [], true, [], true);
      const entry = batch.find((e) => e.docId === sourceDocId)!;
      expect(Object.values(entry.resolvedTargets ?? {})).toContain(targetId);

      // The writer applies the precomputed target — resolved immediately,
      // not deferred to the periodic reconcile.
      upsertExtractedLinksBatch(otherDb, batch);
      expect(getDocumentRefs(otherDb, sourceDocId).outbound[0].targetDocId).toBe(targetId);
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  // Resolution is a read, and the writer is the one thread that may write.
  // These cover the move of every link type's lookup onto the read handle,
  // and the bound that keeps one document's writes interruptible.
  test("resolves a references link on the read handle, not in the writer", () => {
    const otherPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      // A same-source `references` link: the kind a chatty source emits by
      // the hundred, so its resolution belongs on the read handle.
      const target = makeDoc({ externalId: "ref-target" });
      const source = makeDoc({
        externalId: "ref-source",
        metadata: { extra: { links: ["ref-target"] } },
      });
      upsertDocuments(otherDb, [target, source]);
      const targetId = getDocId(otherDb, "ref-target");
      const sourceDocId = getDocId(otherDb, "ref-source");

      const batch = extractLinksForBatch(otherDb, 10, [], [], true, [], true);
      const entry = batch.find((e) => e.docId === sourceDocId)!;
      // The read phase found it.
      expect(Object.values(entry.resolvedTargets ?? {})).toContain(targetId);

      upsertExtractedLinksBatch(otherDb, batch);
      const refs = otherDb
        .prepare<
          [string],
          { target_doc_id: string | null; link_type: string }
        >("SELECT target_doc_id, link_type FROM document_links WHERE source_doc_id = ?")
        .all(sourceDocId);
      expect(refs.some((r) => r.link_type === "references" && r.target_doc_id === targetId)).toBe(
        true,
      );
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("the writer resolves nothing the read phase did not", () => {
    const otherPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      const target = makeDoc({ externalId: "noop-target" });
      const source = makeDoc({
        externalId: "noop-source",
        metadata: { extra: { links: ["noop-target"] } },
      });
      upsertDocuments(otherDb, [target, source]);
      const sourceDocId = getDocId(otherDb, "noop-source");

      const batch = extractLinksForBatch(otherDb, 10, [], [], true, [], true);
      // Strip what the read phase found. If the writer still resolves this,
      // it is doing lookups of its own — which is the whole cost this moved.
      const stripped = batch.map((entry) => ({ ...entry, resolvedTargets: undefined }));
      upsertExtractedLinksBatch(otherDb, stripped);

      const refs = otherDb
        .prepare<
          [string],
          { target_doc_id: string | null }
        >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'references'")
        .all(sourceDocId);
      expect(refs).toHaveLength(1);
      expect(refs[0].target_doc_id).toBeNull();
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("EXISTS-guard skips a references target deleted between compute and apply", () => {
    const otherPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      const target = makeDoc({ externalId: "gone-target" });
      const source = makeDoc({
        externalId: "gone-source",
        metadata: { extra: { links: ["gone-target"] } },
      });
      upsertDocuments(otherDb, [target, source]);
      const targetId = getDocId(otherDb, "gone-target");
      const sourceDocId = getDocId(otherDb, "gone-source");

      const batch = extractLinksForBatch(otherDb, 10, [], [], true, [], true);
      expect(
        Object.values(batch.find((e) => e.docId === sourceDocId)!.resolvedTargets ?? {}),
      ).toContain(targetId);
      // The gap the move opens for non-url types: the target goes away
      // before the writer applies what the reader found.
      otherDb.prepare("DELETE FROM documents WHERE external_id = 'gone-target'").run();
      upsertExtractedLinksBatch(otherDb, batch);

      const refs = otherDb
        .prepare<
          [string],
          { target_doc_id: string | null }
        >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'references'")
        .all(sourceDocId);
      expect(refs).toHaveLength(1);
      // Unresolved, never dangling.
      expect(refs[0].target_doc_id).toBeNull();
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("a link-heavy document yields part-way and finishes identically on retry", () => {
    const linkCount = 130; // spans three sub-batches
    const build = (dbHandle: Db) => {
      const targets = Array.from({ length: linkCount }, (_, n) =>
        makeDoc({ externalId: `chunk-t-${n}` }),
      );
      const source = makeDoc({
        externalId: "chunk-source",
        metadata: { extra: { links: targets.map((_, n) => `chunk-t-${n}`) } },
      });
      upsertDocuments(dbHandle, [...targets, source]);
      return getDocId(dbHandle, "chunk-source");
    };
    // Document ids are per-database, so compare the shape that is not:
    // which links exist, and whether each one found its target.
    const linkRows = (dbHandle: Db, docId: string) =>
      dbHandle
        .prepare<
          [string],
          { link_type: string; normalized_target: string; target_doc_id: string | null }
        >(
          "SELECT link_type, normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY normalized_target",
        )
        .all(docId)
        .map((r) => ({
          link_type: r.link_type,
          normalized_target: r.normalized_target,
          resolved: r.target_doc_id !== null,
        }));

    // Reference run: no yielding.
    const refPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const refDb = createDatabase(refPath);
    let expectedRows: ReturnType<typeof linkRows>;
    try {
      const docId = build(refDb);
      upsertExtractedLinksBatch(refDb, extractLinksForBatch(refDb, 500, [], [], true, [], true));
      expectedRows = linkRows(refDb, docId);
      expect(expectedRows.length).toBe(linkCount);
    } finally {
      refDb.close();
      cleanupDb(refPath);
    }

    // Same work, interrupted after the first sub-batch.
    const yieldPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const yieldDb = createDatabase(yieldPath);
    try {
      const docId = build(yieldDb);
      // Only the link-heavy document, so the yield lands inside it rather
      // than between it and one of its targets.
      const batch = extractLinksForBatch(yieldDb, 500, [], [], true, [], true).filter(
        (e) => e.docId === docId,
      );
      let calls = 0;
      const first = upsertExtractedLinksBatch(yieldDb, batch, {
        token: { requested: () => ++calls >= 1 },
      });
      // The document is handed back whole and left un-extracted, so the
      // retry redoes it from the delete onward rather than appending.
      expect(first.applied).toBe(0);
      expect(first.remaining.map((r) => r.docId)).toContain(docId);
      const markedEarly = yieldDb
        .prepare<
          [string],
          { links_extracted_at: string | null }
        >("SELECT links_extracted_at FROM documents WHERE id = ?")
        .get(docId);
      expect(markedEarly?.links_extracted_at).toBeNull();

      // Retry to completion.
      const second = upsertExtractedLinksBatch(yieldDb, first.remaining);
      expect(second.applied).toBe(1);
      expect(linkRows(yieldDb, docId)).toEqual(expectedRows);
    } finally {
      yieldDb.close();
      cleanupDb(yieldPath);
    }
  });

  test("EXISTS-guard skips a url target deleted between compute and apply (#569)", () => {
    const otherPath = `/tmp/omnesis-links-test-${randomUUID()}.db`;
    const otherDb = createDatabase(otherPath);
    try {
      const target = makeDoc({
        externalId: "race-t",
        metadata: { sourceUrl: "https://race-del.example.com" },
      });
      const source = makeDoc({
        externalId: "race-s2",
        content: "See https://race-del.example.com",
      });
      upsertDocuments(otherDb, [target, source]);
      const sourceDocId = getDocId(otherDb, "race-s2");

      // Compute resolves the link to the target on the read handle…
      const batch = extractLinksForBatch(otherDb, 10, [], [], true, [], true);
      // …but the writer deletes the target before applying the batch.
      otherDb.prepare("DELETE FROM documents WHERE external_id = 'race-t'").run();

      // The EXISTS guard degrades the apply to a no-op rather than writing a
      // dangling FK (which would throw and roll back the row).
      expect(() => upsertExtractedLinksBatch(otherDb, batch)).not.toThrow();
      expect(getDocumentRefs(otherDb, sourceDocId).outbound[0].targetDocId).toBeNull();
    } finally {
      otherDb.close();
      cleanupDb(otherPath);
    }
  });

  test("upsertExtractedLinksBatch skips docs whose content_hash changed since extraction", () => {
    const doc = makeDoc({ externalId: "race-hash", content: "Visit https://race.example.com" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "race-hash");

    setKnownUrlPatterns("test", [{ regex: "race\\.example\\.com" }]);
    const batch = extractLinksForBatch(db, 10, [], [], true, ["race\\.example\\.com"], true);
    resetKnownUrlPatterns();
    expect(batch).toHaveLength(1);
    expect(batch[0].links.length).toBeGreaterThan(0);

    // Simulate a concurrent re-upsert by mutating the doc's content_hash
    // out from under our snapshot. The writer's optimistic-concurrency
    // check must skip this row.
    db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run("changed-under-us", docId);

    const result = upsertExtractedLinksBatch(db, batch);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.extracted).toBe(0);

    // Doc must remain unprocessed so the next periodic re-extracts.
    const row = db
      .prepare<
        [string],
        { links_extracted_at: string | null }
      >("SELECT links_extracted_at FROM documents WHERE id = ?")
      .get(docId);
    expect(row!.links_extracted_at).toBeNull();
    // No links should have been inserted.
    const linkCount = db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ?")
      .get(docId)!.n;
    expect(linkCount).toBe(0);
  });

  test("upsertExtractedLinksBatch skips docs already marked links_extracted_at", () => {
    const doc = makeDoc({ externalId: "race-marked", content: "Visit https://marked.example.com" });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "race-marked");

    const batch = extractLinksForBatch(db, 10, [], [], true, ["marked\\.example\\.com"], true);
    expect(batch).toHaveLength(1);

    // Simulate a concurrent processor (e.g. legacy in-line path) that
    // marked the doc processed between our compute scan and the writer.
    db.prepare("UPDATE documents SET links_extracted_at = ? WHERE id = ?").run(
      "2026-01-01T00:00:00Z",
      docId,
    );

    const result = upsertExtractedLinksBatch(db, batch);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);

    // The pre-existing mark stays — we didn't overwrite it.
    const row = db
      .prepare<
        [string],
        { links_extracted_at: string | null }
      >("SELECT links_extracted_at FROM documents WHERE id = ?")
      .get(docId);
    expect(row!.links_extracted_at).toBe("2026-01-01T00:00:00Z");
  });

  test("upsertExtractedLinksBatch with empty input is a no-op", () => {
    const result = upsertExtractedLinksBatch(db, []);
    expect(result).toEqual({ applied: 0, skipped: 0, extracted: 0, remaining: [] });
  });

  test("upsertExtractedLinksBatch returns empty remaining when fully processed", () => {
    // Builds a single-row batch (using the same fixture setup as the
    // tests above) and asserts the new `remaining` field is `[]` on
    // success. Backwards-compatibility check: legacy destructuring
    // `{ applied, skipped, extracted }` continues to work.
    const docId = randomUUID();
    const contentHash = "hh1";
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at) VALUES (?, 'p', 's', ?, 't', 'b', ?, '{}', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')`,
    ).run(docId, `e-${docId}`, contentHash);
    const batch: Parameters<typeof upsertExtractedLinksBatch>[1] = [
      {
        docId,
        contentHash,
        sourceId: "s",
        inputDigest: linkExtractionInputDigest({
          source_id: "s",
          external_id: `e-${docId}`,
          content_hash: contentHash,
          metadata: "{}",
          extracted_content_hash: null,
        }),
        links: [
          {
            type: "url",
            rawTarget: "https://example.com/x",
            normalizedTarget: "https://example.com/x",
          },
        ],
      },
    ];
    const result = upsertExtractedLinksBatch(db, batch);
    expect(result.applied).toBe(1);
    expect(result.remaining).toEqual([]);
  });

  test("upsertExtractedLinksBatch yields mid-batch when token requests preemption", () => {
    // Three-doc batch with a token that returns true after the first
    // row's per-row poll. Expectations:
    //   - At least one row is applied (its per-row transaction
    //     committed before the yield check).
    //   - `remaining` is non-empty so the caller can re-enqueue.
    //   - applied + skipped + remaining.length === batch.length
    //     (every input row accounted for, nothing lost).
    const insertOne = (i: number): string => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at) VALUES (?, 'p', 's2', ?, ?, ?, ?, '{}', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')`,
      ).run(id, `yield-${i}`, `t${i}`, `body ${i}`, `hh-y-${i}`);
      return id;
    };
    const ids = [insertOne(0), insertOne(1), insertOne(2)];
    const batch: Parameters<typeof upsertExtractedLinksBatch>[1] = ids.map((id, i) => ({
      docId: id,
      contentHash: `hh-y-${i}`,
      sourceId: "s2",
      inputDigest: linkExtractionInputDigest({
        source_id: "s2",
        external_id: `yield-${i}`,
        content_hash: `hh-y-${i}`,
        metadata: "{}",
        extracted_content_hash: null,
      }),
      links: [
        { type: "url" as const, rawTarget: `https://e/${i}`, normalizedTarget: `https://e/${i}` },
      ],
    }));
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        return polls >= 1;
      },
    };
    const result = upsertExtractedLinksBatch(db, batch, { token });
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(result.applied + result.skipped + result.remaining.length).toBe(batch.length);
  });
});

// ───────────────────────────────────────────────────────────────────────
// link_stats materialization (compute / upsert / mark-dirty / convergence)
// ───────────────────────────────────────────────────────────────────────

describe("link_stats materialization", () => {
  // Read the raw row; bypasses getLinkStats's inline-refresh fallback
  // so tests can assert needs_refresh / dirty_version state directly.
  // The OCC plumbing now lives on refresh_meta; the data
  // columns stay on link_stats.
  function rawLinkStatsRow(d: Db) {
    const data = d
      .prepare<
        [],
        {
          total_links: number;
          resolved_links: number;
          by_type_json: string;
          last_computed_at: number | null;
        }
      >(
        "SELECT total_links, resolved_links, by_type_json, last_computed_at FROM link_stats WHERE id = 1",
      )
      .get()!;
    const meta = d
      .prepare<
        [],
        { needs_refresh: number; dirty_version: number }
      >("SELECT needs_refresh, dirty_version FROM refresh_meta WHERE job = 'link_graph'")
      .get()!;
    return { ...data, needs_refresh: meta.needs_refresh, dirty_version: meta.dirty_version };
  }

  test("fresh DB has the singleton row with needs_refresh=1 and dirty_version=0", () => {
    const row = rawLinkStatsRow(db);
    expect(row.dirty_version).toBe(0);
    expect(row.needs_refresh).toBe(1);
    expect(row.last_computed_at).toBeNull();
  });

  test("first compute+upsert succeeds at version=0 and clears needs_refresh", () => {
    // Boot state: nothing's been mutated, dirty_version=0,
    // needs_refresh=1 (from the migration default). computeLinkStats
    // reads the row inside BEGIN, sees needs_refresh=1, runs the
    // COUNTs (table is empty), returns capturedVersion=0. Upsert
    // applies (WHERE dirty_version=0 matches), sets needs_refresh=0.
    const agg = computeLinkStats(db);
    expect(agg.skipped).toBeFalsy();
    expect(agg.capturedVersion).toBe(0);
    const { updated } = upsertLinkStats(db, agg);
    expect(updated).toBe(1);
    const row = rawLinkStatsRow(db);
    expect(row.needs_refresh).toBe(0);
    expect(row.last_computed_at).not.toBeNull();
  });

  test("computeLinkStats short-circuits when needs_refresh=0", () => {
    // Settle the row first.
    upsertLinkStats(db, computeLinkStats(db));
    // Second compute should skip the heavy COUNTs.
    const agg = computeLinkStats(db);
    expect(agg.skipped).toBe(true);
  });

  test("OCC: mark-dirty between compute and upsert makes upsert no-op", () => {
    // Keep the url link stored (unresolved) so compute has a real link to
    // count toward total_links (#570 gate).
    keepUrlLinks(db);
    // Settle once so we have a known starting point.
    upsertLinkStats(db, computeLinkStats(db));
    // Add a doc + link to give compute something real to count.
    const source = makeDoc({ externalId: "occ-s", content: "See https://example.com" });
    upsertDocuments(db, [source]);
    const sourceId = getDocId(db, "occ-s");
    processDocumentLinks(
      db,
      sourceId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    // processDocumentLinks bumped dirty_version. Compute now snapshots it.
    const agg = computeLinkStats(db);
    expect(agg.skipped).toBeFalsy();
    const versionAtCompute = rawLinkStatsRow(db).dirty_version;
    expect(agg.capturedVersion).toBe(versionAtCompute);

    // Simulate a concurrent mark-dirty fired between compute and upsert.
    markLinkStatsDirty(db);
    expect(rawLinkStatsRow(db).dirty_version).toBe(versionAtCompute + 1);

    // Upsert with the stale captured version — should be a no-op.
    const { updated } = upsertLinkStats(db, agg);
    expect(updated).toBe(0);
    // needs_refresh stays 1 — the next refresh tick recomputes.
    expect(rawLinkStatsRow(db).needs_refresh).toBe(1);

    // Re-running the full cycle converges to the correct state.
    const agg2 = computeLinkStats(db);
    expect(upsertLinkStats(db, agg2).updated).toBe(1);
    const finalRow = rawLinkStatsRow(db);
    expect(finalRow.needs_refresh).toBe(0);
    expect(finalRow.total_links).toBe(1);
  });

  test("convergence: materialized path matches direct COUNT(*) over the same DB", () => {
    // Seed a varied corpus so byType has multiple buckets.
    const docs = [
      makeDoc({
        externalId: "c-1",
        content: "https://a.com and https://b.com",
        metadata: { extra: { links: ["Note A"] } },
      }),
      makeDoc({
        externalId: "c-2",
        content: "https://a.com again",
        metadata: { extra: { links: ["Note B", "Note A"] } },
      }),
      makeDoc({ externalId: "c-3", content: "no links here" }),
      makeDoc({ externalId: "c-target-a", metadata: { sourceUrl: "https://a.com" } }),
    ];
    upsertDocuments(db, docs);
    for (const d of docs.slice(0, 3)) {
      const id = getDocId(db, d.externalId);
      processDocumentLinks(db, id, d.content, d.metadata, String(d.sourceId), d.externalId, null);
    }
    reconcileUnresolvedLinks(db, 1000);

    // Direct heavy aggregation (the pre-materialization path).
    const directTotal = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_links")
      .get()!.n;
    const directResolved = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_links WHERE target_doc_id IS NOT NULL")
      .get()!.n;

    // Refresh the materialized path.
    const agg = computeLinkStats(db);
    upsertLinkStats(db, agg);
    const stats = getLinkStats(db);

    expect(stats.totalLinks).toBe(directTotal);
    expect(stats.resolvedLinks).toBe(directResolved);
    expect(stats.unresolvedLinks).toBe(directTotal - directResolved);
  });
});

describe("link_stats mark-dirty audit (every mutation site bumps dirty_version)", () => {
  // Helper: read the dirty_version, ignoring everything else.
  // The dirty version now lives on refresh_meta.
  function ver(d: Db): number {
    return d
      .prepare<
        [],
        { dirty_version: number }
      >("SELECT dirty_version FROM refresh_meta WHERE job = 'link_graph'")
      .get()!.dirty_version;
  }

  function settle(d: Db) {
    upsertLinkStats(d, computeLinkStats(d));
  }

  test("processDocumentLinks bumps dirty_version", () => {
    const doc = makeDoc({ externalId: "audit-pdl", content: "https://example.com" });
    upsertDocuments(db, [doc]);
    const id = getDocId(db, "audit-pdl");
    settle(db);
    const before = ver(db);
    processDocumentLinks(
      db,
      id,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    expect(ver(db)).toBeGreaterThan(before);
  });

  test("upsertLinkResolutions bumps dirty_version when at least one row resolves", () => {
    // Keep the url link stored (unresolved) so the later reconcile has a
    // row to resolve, which is what bumps dirty_version (#570 gate).
    keepUrlLinks(db);
    const target = makeDoc({ externalId: "audit-tgt", metadata: { sourceUrl: "https://x.com" } });
    const source = makeDoc({ externalId: "audit-src", content: "See https://x.com" });
    upsertDocuments(db, [source]);
    const sId = getDocId(db, "audit-src");
    processDocumentLinks(
      db,
      sId,
      source.content,
      source.metadata,
      String(source.sourceId),
      source.externalId,
      null,
    );
    upsertDocuments(db, [target]); // arrives later → unresolved at this point
    settle(db);
    const before = ver(db);
    const batch = computeLinkResolutions(db, 100);
    upsertLinkResolutions(db, batch);
    expect(ver(db)).toBeGreaterThan(before);
  });

  test("upsertExtractedLinksBatch bumps dirty_version when any row applies", () => {
    const doc = makeDoc({ externalId: "audit-batch", content: "https://example.com/batch" });
    upsertDocuments(db, [doc]);
    settle(db);
    const before = ver(db);
    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    upsertExtractedLinksBatch(db, batch);
    expect(ver(db)).toBeGreaterThan(before);
  });

  test("deleteDocuments bumps dirty_version (CASCADE deletes document_links rows)", () => {
    const doc = makeDoc({ externalId: "audit-del", content: "https://example.com/del" });
    upsertDocuments(db, [doc]);
    const dId = getDocId(db, "audit-del");
    processDocumentLinks(
      db,
      dId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    settle(db);
    const before = ver(db);
    deleteDocuments(db, "google", String(doc.sourceId), [doc.externalId]);
    expect(ver(db)).toBeGreaterThan(before);
  });

  test("deleteAllBySource bumps dirty_version", () => {
    const doc = makeDoc({ externalId: "audit-dabs", content: "https://example.com/dabs" });
    upsertDocuments(db, [doc]);
    const dId = getDocId(db, "audit-dabs");
    processDocumentLinks(
      db,
      dId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    settle(db);
    const before = ver(db);
    deleteAllBySource(db, String(doc.sourceId));
    expect(ver(db)).toBeGreaterThan(before);
  });

  test("markLinkStatsDirty alone bumps dirty_version", () => {
    settle(db);
    const before = ver(db);
    markLinkStatsDirty(db);
    expect(ver(db)).toBe(before + 1);
  });
});

describe("#264 — duplicate-content links between attachment docs", () => {
  function makeAttDoc(
    externalId: string,
    contentHash: string,
    content = "att body",
  ): DocumentInput {
    return {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail:user@gmail.com"),
      externalId,
      title: "att.pdf",
      content,
      contentHash,
      // Attachment docs render the raw extracted text, so the dedup key
      // collapses to the same value as `contentHash`.
      extractedContentHash: contentHash,
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: externalId.split("/")[0] },
      },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
    };
  }

  function makeEmail(externalId: string, content: string, contentHash: string): DocumentInput {
    return {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail:user@gmail.com"),
      externalId,
      title: externalId,
      content,
      contentHash,
      metadata: { documentType: "email" },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
    };
  }

  test("two attachment docs with same content_hash get linked via duplicate-content", () => {
    const sharedHash = "deadbeef-shared-hash";
    const a = makeAttDoc("msg-A/att/aaaaaaaaaaaaaaaa", sharedHash);
    const b = makeAttDoc("msg-B/att/aaaaaaaaaaaaaaaa", sharedHash);

    upsertDocuments(db, [a]);
    processDocumentLinks(
      db,
      getDocId(db, a.externalId),
      a.content,
      a.metadata,
      a.sourceId,
      a.externalId,
      null,
    );

    upsertDocuments(db, [b]);
    processDocumentLinks(
      db,
      getDocId(db, b.externalId),
      b.content,
      b.metadata,
      b.sourceId,
      b.externalId,
      null,
    );

    // B's outbound includes a duplicate-content link to A.
    const bRefs = getDocumentRefs(db, getDocId(db, b.externalId));
    const dupLinks = bRefs.outbound.filter((r) => r.linkType === "duplicate-content");
    expect(dupLinks).toHaveLength(1);
    expect(dupLinks[0].targetDocId).toBe(getDocId(db, a.externalId));

    // A's inbound includes B (the link goes B → A).
    const aRefs = getDocumentRefs(db, getDocId(db, a.externalId));
    const aInbound = aRefs.inbound.filter((r) => r.linkType === "duplicate-content");
    expect(aInbound).toHaveLength(1);
    expect(aInbound[0].sourceDocId).toBe(getDocId(db, b.externalId));
  });

  test("does NOT link non-attachment docs even with matching content_hash", () => {
    // Two emails with identical content (e.g. mailing-list resends) must
    // NOT trigger duplicate-content links — the feature is scoped to
    // attachments by design.
    const sharedHash = "shared-email-hash";
    const e1 = makeEmail("email-1", "Same body", sharedHash);
    const e2 = makeEmail("email-2", "Same body", sharedHash);

    upsertDocuments(db, [e1]);
    processDocumentLinks(
      db,
      getDocId(db, e1.externalId),
      e1.content,
      e1.metadata,
      e1.sourceId,
      e1.externalId,
      null,
    );

    upsertDocuments(db, [e2]);
    processDocumentLinks(
      db,
      getDocId(db, e2.externalId),
      e2.content,
      e2.metadata,
      e2.sourceId,
      e2.externalId,
      null,
    );

    const e2Refs = getDocumentRefs(db, getDocId(db, e2.externalId));
    expect(e2Refs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(0);
  });

  test("does NOT self-link an attachment to itself", () => {
    const a = makeAttDoc("msg-self/att/sss", "self-only-hash");
    upsertDocuments(db, [a]);
    processDocumentLinks(
      db,
      getDocId(db, a.externalId),
      a.content,
      a.metadata,
      a.sourceId,
      a.externalId,
      null,
    );

    const refs = getDocumentRefs(db, getDocId(db, a.externalId));
    expect(refs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(0);
    expect(refs.inbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(0);
  });

  test("re-processing same attachment doc is idempotent (no duplicate links inserted)", () => {
    const sharedHash = "rerun-hash";
    const a = makeAttDoc("msg-X/att/xxx", sharedHash);
    const b = makeAttDoc("msg-Y/att/yyy", sharedHash);
    upsertDocuments(db, [a, b]);
    processDocumentLinks(
      db,
      getDocId(db, a.externalId),
      a.content,
      a.metadata,
      a.sourceId,
      a.externalId,
      null,
    );
    processDocumentLinks(
      db,
      getDocId(db, b.externalId),
      b.content,
      b.metadata,
      b.sourceId,
      b.externalId,
      null,
    );
    // Force re-extraction by clearing links_extracted_at, then re-run.
    db.prepare("UPDATE documents SET links_extracted_at = NULL WHERE id = ?").run(
      getDocId(db, b.externalId),
    );
    processDocumentLinks(
      db,
      getDocId(db, b.externalId),
      b.content,
      b.metadata,
      b.sourceId,
      b.externalId,
      null,
    );

    const bRefs = getDocumentRefs(db, getDocId(db, b.externalId));
    const dupLinks = bRefs.outbound.filter((r) => r.linkType === "duplicate-content");
    expect(dupLinks).toHaveLength(1); // not 2
  });

  test("third doc with the same hash links to BOTH previous docs", () => {
    const sharedHash = "triple-hash";
    const a = makeAttDoc("msg-A/att/a", sharedHash);
    const b = makeAttDoc("msg-B/att/b", sharedHash);
    const c = makeAttDoc("msg-C/att/c", sharedHash);

    upsertDocuments(db, [a, b]);
    processDocumentLinks(
      db,
      getDocId(db, a.externalId),
      a.content,
      a.metadata,
      a.sourceId,
      a.externalId,
      null,
    );
    processDocumentLinks(
      db,
      getDocId(db, b.externalId),
      b.content,
      b.metadata,
      b.sourceId,
      b.externalId,
      null,
    );

    upsertDocuments(db, [c]);
    processDocumentLinks(
      db,
      getDocId(db, c.externalId),
      c.content,
      c.metadata,
      c.sourceId,
      c.externalId,
      null,
    );

    const cRefs = getDocumentRefs(db, getDocId(db, c.externalId));
    expect(cRefs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(2);
  });
});

describe("#271 — duplicate-content links broadened to file (Drive) docs", () => {
  function makeAttDoc(
    externalId: string,
    contentHash: string,
    content = "shared body",
  ): DocumentInput {
    return {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail:user@gmail.com"),
      externalId,
      title: "att.pdf",
      content,
      contentHash,
      extractedContentHash: contentHash,
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: externalId.split("/")[0] },
      },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
    };
  }

  function makeDriveDoc(
    externalId: string,
    contentHash: string,
    content = "shared body",
    extractedContentHash?: string,
  ): DocumentInput {
    return {
      providerId: ProviderId("google:user@gmail.com"),
      sourceId: SourceId("google-drive:user@gmail.com"),
      externalId,
      title: "report.pdf",
      content,
      contentHash,
      // Real Drive docs hash a wrapped `content` (markdown header + extracted
      // text) for `contentHash` and the raw extracted text for
      // `extractedContentHash`. The default keeps them equal for tests that
      // don't care about the wrapping; pass an explicit value to model the
      // realistic split.
      extractedContentHash: extractedContentHash ?? contentHash,
      metadata: { documentType: "file", extra: { mimeType: "application/pdf" } },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
    };
  }

  function makeNoteDoc(
    externalId: string,
    contentHash: string,
    content = "shared body",
  ): DocumentInput {
    return {
      providerId: ProviderId("apple:local"),
      sourceId: SourceId("apple-notes:local"),
      externalId,
      title: "Note",
      content,
      contentHash,
      metadata: { documentType: "note" },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
    };
  }

  test("Drive file ↔ Gmail attachment with same content_hash links bidirectionally", () => {
    // The headline use case behind #271: the same PDF lives in your Drive
    // AND was attached to an email. Both surfaces should cross-reference.
    const sharedHash = "drive-and-att-hash";
    const att = makeAttDoc("msg-A/att/pdf", sharedHash);
    const file = makeDriveDoc("drive-file-1", sharedHash);

    upsertDocuments(db, [att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    upsertDocuments(db, [file]);
    processDocumentLinks(
      db,
      getDocId(db, file.externalId),
      file.content,
      file.metadata,
      file.sourceId,
      file.externalId,
      null,
    );

    // Drive file's outbound links → email attachment.
    const fileRefs = getDocumentRefs(db, getDocId(db, file.externalId));
    const fileOutbound = fileRefs.outbound.filter((r) => r.linkType === "duplicate-content");
    expect(fileOutbound).toHaveLength(1);
    expect(fileOutbound[0].targetDocId).toBe(getDocId(db, att.externalId));

    // Email attachment's inbound includes the Drive file.
    const attRefs = getDocumentRefs(db, getDocId(db, att.externalId));
    const attInbound = attRefs.inbound.filter((r) => r.linkType === "duplicate-content");
    expect(attInbound).toHaveLength(1);
    expect(attInbound[0].sourceDocId).toBe(getDocId(db, file.externalId));
  });

  test("two Drive files with same content_hash link to each other", () => {
    const sharedHash = "two-drive-files";
    const f1 = makeDriveDoc("drive-1", sharedHash);
    const f2 = makeDriveDoc("drive-2", sharedHash);

    upsertDocuments(db, [f1]);
    processDocumentLinks(
      db,
      getDocId(db, f1.externalId),
      f1.content,
      f1.metadata,
      f1.sourceId,
      f1.externalId,
      null,
    );

    upsertDocuments(db, [f2]);
    processDocumentLinks(
      db,
      getDocId(db, f2.externalId),
      f2.content,
      f2.metadata,
      f2.sourceId,
      f2.externalId,
      null,
    );

    const f2Refs = getDocumentRefs(db, getDocId(db, f2.externalId));
    expect(f2Refs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(1);
  });

  test("notes / authored content with matching hash do NOT trigger duplicate-content links", () => {
    // Notes, emails, messages, contacts are all out of scope — duplicate
    // bodies in those sources are usually intentional. Only file-bytes-
    // backed docs cross-link.
    const sharedHash = "notes-shared";
    const n1 = makeNoteDoc("note-1", sharedHash);
    const n2 = makeNoteDoc("note-2", sharedHash);

    upsertDocuments(db, [n1]);
    processDocumentLinks(
      db,
      getDocId(db, n1.externalId),
      n1.content,
      n1.metadata,
      n1.sourceId,
      n1.externalId,
      null,
    );

    upsertDocuments(db, [n2]);
    processDocumentLinks(
      db,
      getDocId(db, n2.externalId),
      n2.content,
      n2.metadata,
      n2.sourceId,
      n2.externalId,
      null,
    );

    const n2Refs = getDocumentRefs(db, getDocId(db, n2.externalId));
    expect(n2Refs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(0);
  });

  test("Drive file ↔ attachment with diverging contentHash but matching extractedContentHash links", () => {
    // The realistic case the user hit: Drive wraps the extracted text with
    // a `# title\n**Type:** ...\n---\n` header before hashing `content`,
    // while attachment-pipeline producers hash the raw text. So the same
    // PDF has different `contentHash` values across the two surfaces — the
    // dedup link only fires because we key on `extractedContentHash`,
    // which is identical.
    const sharedExtracted = "extracted-pdf-text-hash";
    const att = makeAttDoc("msg-A/att/pdf-real", "att-rendered-hash");
    // Force the att's dedup key to match the Drive doc's; in production
    // the att's `content` IS the extracted text so this happens naturally,
    // but the factory above sets contentHash = extractedContentHash.
    att.extractedContentHash = sharedExtracted;
    att.contentHash = "att-rendered-hash";
    const file = makeDriveDoc(
      "drive-file-real",
      "drive-rendered-hash-with-header",
      "# report.pdf\n**Type:** Pdf\n---\nextracted body",
      sharedExtracted,
    );

    upsertDocuments(db, [att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    upsertDocuments(db, [file]);
    processDocumentLinks(
      db,
      getDocId(db, file.externalId),
      file.content,
      file.metadata,
      file.sourceId,
      file.externalId,
      null,
    );

    const fileRefs = getDocumentRefs(db, getDocId(db, file.externalId));
    expect(fileRefs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(1);
    const attRefs = getDocumentRefs(db, getDocId(db, att.externalId));
    expect(attRefs.inbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(1);
  });

  test("Drive file does NOT link to a note even with identical content_hash", () => {
    // Mixed cross-type: a Drive file shouldn't link to a note (note isn't
    // in scope), even though the file itself is. The whitelist applies
    // to BOTH endpoints — both source and target must be in it.
    const sharedHash = "file-vs-note";
    const file = makeDriveDoc("drive-file", sharedHash);
    const note = makeNoteDoc("note-1", sharedHash);

    upsertDocuments(db, [note]);
    processDocumentLinks(
      db,
      getDocId(db, note.externalId),
      note.content,
      note.metadata,
      note.sourceId,
      note.externalId,
      null,
    );

    upsertDocuments(db, [file]);
    processDocumentLinks(
      db,
      getDocId(db, file.externalId),
      file.content,
      file.metadata,
      file.sourceId,
      file.externalId,
      null,
    );

    const fileRefs = getDocumentRefs(db, getDocId(db, file.externalId));
    expect(fileRefs.outbound.filter((r) => r.linkType === "duplicate-content")).toHaveLength(0);
  });
});

describe("#266 — calendar-event links via ICS UID ↔ event iCalUID", () => {
  function makeIcsAttachment(externalId: string, uid: string): DocumentInput {
    return {
      providerId: ProviderId("microsoft"),
      sourceId: SourceId("outlook-email:user@outlook.com"),
      externalId,
      title: "invite.ics",
      content: "## Event: Whatever",
      contentHash: `h-${externalId}`,
      metadata: {
        documentType: "attachment",
        extra: {
          parentExternalId: externalId.split("/")[0],
          iCalUIDs: [uid],
        },
      },
      sourceCreatedAt: "2026-01-15T10:00:00Z",
      sourceUpdatedAt: "2026-01-15T10:00:00Z",
    };
  }

  function makeCalendarEvent(externalId: string, uid: string): DocumentInput {
    return {
      providerId: ProviderId("google:user@gmail.com"),
      sourceId: SourceId("google-calendar:user@gmail.com"),
      externalId,
      title: "Whatever",
      content: "# Whatever",
      contentHash: `eh-${externalId}`,
      metadata: {
        documentType: "event",
        extra: { iCalUID: uid, calendarId: "user@gmail.com" },
      },
      sourceCreatedAt: "2026-01-15T10:00:00Z",
      sourceUpdatedAt: "2026-01-15T10:00:00Z",
    };
  }

  test("ICS attachment that lands AFTER its calendar event resolves the link inline", () => {
    const uid = "uid-event-after@google.com";
    const event = makeCalendarEvent("user@gmail.com:eid123", uid);
    upsertDocuments(db, [event]);

    const att = makeIcsAttachment("msg-1/att/aaa", uid);
    upsertDocuments(db, [att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    const refs = getDocumentRefs(db, getDocId(db, att.externalId));
    const calLinks = refs.outbound.filter((r) => r.linkType === "calendar-event");
    expect(calLinks).toHaveLength(1);
    expect(calLinks[0].targetDocId).toBe(getDocId(db, event.externalId));
  });

  test("ICS attachment that lands BEFORE its calendar event gets resolved when the event arrives", () => {
    const uid = "uid-event-later@google.com";
    const att = makeIcsAttachment("msg-2/att/bbb", uid);
    upsertDocuments(db, [att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    // Pre-event the link is unresolved.
    let refs = getDocumentRefs(db, getDocId(db, att.externalId));
    expect(refs.outbound.find((r) => r.linkType === "calendar-event")?.targetDocId).toBeFalsy();

    // Event arrives → resolveInboundLinks fires for the new doc.
    const event = makeCalendarEvent("user@gmail.com:eid456", uid);
    upsertDocuments(db, [event]);
    resolveInboundLinks(db, getDocId(db, event.externalId), null, event.sourceId, event.externalId);

    refs = getDocumentRefs(db, getDocId(db, att.externalId));
    const calLinks = refs.outbound.filter((r) => r.linkType === "calendar-event");
    expect(calLinks).toHaveLength(1);
    expect(calLinks[0].targetDocId).toBe(getDocId(db, event.externalId));
  });

  test("event doc shows the ICS attachment as inbound", () => {
    const uid = "uid-bidirectional@google.com";
    const event = makeCalendarEvent("user@gmail.com:eid789", uid);
    const att = makeIcsAttachment("msg-3/att/ccc", uid);
    upsertDocuments(db, [event, att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    const eventRefs = getDocumentRefs(db, getDocId(db, event.externalId));
    const inbound = eventRefs.inbound.filter((r) => r.linkType === "calendar-event");
    expect(inbound).toHaveLength(1);
    expect(inbound[0].sourceDocId).toBe(getDocId(db, att.externalId));
  });

  test("link is cross-source (outlook attachment → google calendar event)", () => {
    // Smoke test: confirms the resolver doesn't accidentally constrain
    // by source_id like email-thread does.
    const uid = "uid-cross-source@google.com";
    const event = makeCalendarEvent("user@gmail.com:eidXS", uid);
    const att = makeIcsAttachment("msg-xs/att/xs", uid);
    upsertDocuments(db, [event, att]);
    processDocumentLinks(
      db,
      getDocId(db, att.externalId),
      att.content,
      att.metadata,
      att.sourceId,
      att.externalId,
      null,
    );

    const refs = getDocumentRefs(db, getDocId(db, att.externalId));
    const link = refs.outbound.find((r) => r.linkType === "calendar-event");
    expect(link?.targetDocId).toBe(getDocId(db, event.externalId));
    expect(link?.targetSourceId).toBe(event.sourceId);
  });

  test("two ICS attachments for the SAME event both resolve to the same event doc", () => {
    const uid = "uid-shared@google.com";
    const event = makeCalendarEvent("user@gmail.com:eidShared", uid);
    const att1 = makeIcsAttachment("msg-A/att/aa", uid);
    const att2 = makeIcsAttachment("msg-B/att/bb", uid);
    upsertDocuments(db, [event, att1, att2]);
    processDocumentLinks(
      db,
      getDocId(db, att1.externalId),
      att1.content,
      att1.metadata,
      att1.sourceId,
      att1.externalId,
      null,
    );
    processDocumentLinks(
      db,
      getDocId(db, att2.externalId),
      att2.content,
      att2.metadata,
      att2.sourceId,
      att2.externalId,
      null,
    );

    const eventRefs = getDocumentRefs(db, getDocId(db, event.externalId));
    expect(eventRefs.inbound.filter((r) => r.linkType === "calendar-event")).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// URL-canonicalizer-aware link extraction (Fix 1)
//
// Verifies that when a per-host canonicalizer is registered (the way
// each provider does via `defineSource`), `processDocumentLinks`
// collapses URL variants to canonical form at extraction time. Strategy
// 1 (`resolveUrlLink` exact `source_url` match) then resolves them
// inline on insert — without depending on the periodic reconciler's
// Strategy-2 fallback.
// ─────────────────────────────────────────────────────────────────────

describe("processDocumentLinks with URL canonicalizer (Fix 1)", () => {
  beforeEach(() => {
    setUrlCanonicalizers([
      {
        hosts: ["drive.google.com"],
        rules: [
          {
            match: "^https://drive\\.google\\.com/file/d/([^/]+).*$",
            replacement: "https://drive.google.com/file/d/$1",
          },
        ],
      },
    ]);
    // Keep the canonicalized url link stored (unresolved) so the
    // extraction-form and Strategy-1-on-arrival assertions have a row to
    // inspect. The permissive pattern only flips the #570 gate — it
    // captures the whole url, so its Strategy-2 lookup never matches the
    // Drive doc's external_id and can't cause a false resolve-now (which
    // the "stored unresolved" assertions rely on).
    keepUrlLinks(db);
  });

  afterEach(() => {
    resetUrlCanonicalizers();
  });

  test("/edit-variant URL is stored in canonical form at extraction time", () => {
    // WhatsApp doc whose content mentions the file with `/edit`.
    const message = makeDoc({
      providerId: ProviderId("whatsapp"),
      sourceId: SourceId("whatsapp-messages:+447700000000"),
      externalId: "msg-1",
      content: "Here's the contract: https://drive.google.com/file/d/116UrX/edit",
    });
    upsertDocuments(db, [message]);
    const messageId = getDocId(db, "msg-1");

    processDocumentLinks(
      db,
      messageId,
      message.content,
      message.metadata,
      String(message.sourceId),
      message.externalId,
      null,
      getUrlCanonicalizerSpecs(),
    );

    // The link normalized_target should be the canonical Drive URL —
    // `/edit` is stripped at extraction time via the canonicalizer.
    const linkRow = db
      .prepare<
        [string],
        { normalized_target: string }
      >("SELECT normalized_target FROM document_links WHERE source_doc_id = ?")
      .get(messageId);
    expect(linkRow?.normalized_target).toBe("https://drive.google.com/file/d/116UrX");
  });

  test("canonical form lets Strategy 1 (source_url exact match) resolve on Drive-doc arrival", () => {
    // WhatsApp arrives first (canonicalized link, unresolved).
    const message = makeDoc({
      providerId: ProviderId("whatsapp"),
      sourceId: SourceId("whatsapp-messages:+447700000000"),
      externalId: "msg-pre-drive-canonical",
      content: "Contract: https://drive.google.com/file/d/116UrX/edit",
    });
    upsertDocuments(db, [message]);
    const messageId = getDocId(db, "msg-pre-drive-canonical");
    processDocumentLinks(
      db,
      messageId,
      message.content,
      message.metadata,
      String(message.sourceId),
      message.externalId,
      null,
      getUrlCanonicalizerSpecs(),
    );

    // Drive doc arrives. Its source_url normalizes to the same canonical
    // form (`/file/d/<id>` without `/edit`) via the same canonicalizer
    // path inside `upsertDocuments`.
    const drive = makeDoc({
      providerId: ProviderId("google"),
      sourceId: SourceId("google-drive:jamesbond@gmail.com"),
      externalId: "116UrX",
      metadata: { sourceUrl: "https://drive.google.com/file/d/116UrX" },
    });
    upsertDocuments(db, [drive]);
    const driveId = getDocId(db, "116UrX");
    const driveSourceUrl = getSourceUrl(db, "116UrX");
    expect(driveSourceUrl).toBe("https://drive.google.com/file/d/116UrX");

    // URL arrival stays unresolved in the writer hook; the role-aware
    // read-side reconcile sees the same canonical form on both sides.
    const resolved = resolveInboundLinks(
      db,
      driveId,
      driveSourceUrl,
      drive.sourceId,
      drive.externalId,
    );
    expect(resolved).toBe(0);
    upsertLinkResolutions(db, computeLinkResolutions(db, 50));

    const refs = getDocumentRefs(db, messageId);
    expect(refs.outbound[0].targetDocId).toBe(driveId);
  });

  test("two variants of the same Drive URL collapse to one link", () => {
    upsertDocuments(db, [
      makeDoc({
        sourceId: SourceId("google-drive:x@gmail.com"),
        externalId: "ABC",
        metadata: { sourceUrl: "https://drive.google.com/file/d/ABC" },
      }),
    ]);

    const msg = makeDoc({
      sourceId: SourceId("whatsapp-messages:+1"),
      externalId: "wa-1",
      content:
        "Here: https://drive.google.com/file/d/ABC/edit\nAlso: https://drive.google.com/file/d/ABC/view?usp=drivesdk",
    });
    upsertDocuments(db, [msg]);
    const msgId = getDocId(db, "wa-1");
    processDocumentLinks(
      db,
      msgId,
      msg.content,
      msg.metadata,
      msg.sourceId,
      msg.externalId,
      null,
      getUrlCanonicalizerSpecs(),
    );

    const links = db
      .prepare<
        [string],
        { normalized_target: string }
      >("SELECT normalized_target FROM document_links WHERE source_doc_id = ?")
      .all(msgId);
    expect(links).toHaveLength(1);
    expect(links[0].normalized_target).toBe("https://drive.google.com/file/d/ABC");
  });

  test("upsertDocuments canonicalizes source_url when specs are passed", () => {
    // Simulates the production path: Drive provider emits a raw
    // `sourceUrl` with `/view?usp=drivesdk`; the writer handler
    // rebuilds the canonicalizer registry from specs and forwards it
    // to `upsertDocuments`, which stores the canonical form.
    const drive = makeDoc({
      providerId: ProviderId("google"),
      sourceId: SourceId("google-drive:jamesbond@gmail.com"),
      externalId: "CANON-TEST-1",
      metadata: {
        sourceUrl: "https://drive.google.com/file/d/CANON-TEST-1/view?usp=drivesdk",
      },
    });
    const registry = buildCanonicalizerRegistry(getUrlCanonicalizerSpecs());
    upsertDocuments(db, [drive], {}, registry);

    const stored = getSourceUrl(db, "CANON-TEST-1");
    expect(stored).toBe("https://drive.google.com/file/d/CANON-TEST-1");
  });

  test("upsertDocuments stores raw source_url when no canonicalizers are passed", () => {
    // Without canonicalizers the `/view?usp=drivesdk` suffix survives
    // generic normalization (only tracking params like utm_* are
    // stripped; `usp` is not a tracking param).
    const drive = makeDoc({
      providerId: ProviderId("google"),
      sourceId: SourceId("google-drive:jamesbond@gmail.com"),
      externalId: "RAW-URL-TEST-1",
      metadata: {
        sourceUrl: "https://drive.google.com/file/d/RAW-URL-TEST-1/view?usp=drivesdk",
      },
    });
    upsertDocuments(db, [drive]);

    const stored = getSourceUrl(db, "RAW-URL-TEST-1");
    // Without canonicalizer the URL keeps the `/view` and `?usp=drivesdk`.
    expect(stored).toBe("https://drive.google.com/file/d/RAW-URL-TEST-1/view?usp=drivesdk");
  });

  test("Strategy-1 resolves when Drive doc has raw /view?usp=drivesdk URL but source_url is canonicalized at ingest", () => {
    // WhatsApp message mentions a Drive link with ?usp=sharing.
    const message = makeDoc({
      providerId: ProviderId("whatsapp"),
      sourceId: SourceId("whatsapp-messages:+1"),
      externalId: "wa-drive-raw",
      content: "Check this: https://drive.google.com/file/d/DRIVE-RAW-1/view?usp=sharing",
    });
    upsertDocuments(db, [message]);
    const messageId = getDocId(db, "wa-drive-raw");
    processDocumentLinks(
      db,
      messageId,
      message.content,
      message.metadata,
      message.sourceId,
      message.externalId,
      null,
      getUrlCanonicalizerSpecs(),
    );

    // Verify the extracted link is canonical.
    const linkRow = db
      .prepare<
        [string],
        { normalized_target: string }
      >("SELECT normalized_target FROM document_links WHERE source_doc_id = ?")
      .get(messageId);
    expect(linkRow?.normalized_target).toBe("https://drive.google.com/file/d/DRIVE-RAW-1");

    // Drive doc arrives with a raw, non-canonical sourceUrl (as the
    // Drive API actually returns). With canonicalizers, the stored
    // source_url should match the link's normalized_target.
    const drive = makeDoc({
      providerId: ProviderId("google"),
      sourceId: SourceId("google-drive:jamesbond@gmail.com"),
      externalId: "DRIVE-RAW-1",
      metadata: {
        sourceUrl: "https://drive.google.com/file/d/DRIVE-RAW-1/view?usp=drivesdk",
      },
    });
    const registry = buildCanonicalizerRegistry(getUrlCanonicalizerSpecs());
    upsertDocuments(db, [drive], {}, registry);

    const driveId = getDocId(db, "DRIVE-RAW-1");
    const driveSourceUrl = getSourceUrl(db, "DRIVE-RAW-1");
    expect(driveSourceUrl).toBe("https://drive.google.com/file/d/DRIVE-RAW-1");

    // The writer-side inbound hook deliberately skips URLs; reconciliation
    // resolves the canonical match with the complete URL target roles.
    const resolved = resolveInboundLinks(
      db,
      driveId,
      driveSourceUrl,
      drive.sourceId,
      drive.externalId,
    );
    expect(resolved).toBe(0);
    upsertLinkResolutions(db, computeLinkResolutions(db, 50));

    const refs = getDocumentRefs(db, messageId);
    expect(refs.outbound.some((r) => r.targetDocId === driveId)).toBe(true);
  });

  test("without a canonicalizer, /edit-variant link is stored in non-canonical form", () => {
    resetUrlCanonicalizers();

    upsertDocuments(db, [
      makeDoc({
        sourceId: SourceId("google-drive:x@gmail.com"),
        externalId: "ABC",
        metadata: { sourceUrl: "https://drive.google.com/file/d/ABC" },
      }),
    ]);

    const msg = makeDoc({
      sourceId: SourceId("whatsapp-messages:+1"),
      externalId: "wa-no-canon",
      content: "Link: https://drive.google.com/file/d/ABC/edit",
    });
    upsertDocuments(db, [msg]);
    const msgId = getDocId(db, "wa-no-canon");
    processDocumentLinks(db, msgId, msg.content, msg.metadata, msg.sourceId, msg.externalId, null);

    const linkRow = db
      .prepare<
        [string],
        { normalized_target: string; target_doc_id: string | null }
      >("SELECT normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ?")
      .get(msgId);
    // The `/edit` survives normalization without a canonicalizer.
    expect(linkRow?.normalized_target).toBe("https://drive.google.com/file/d/ABC/edit");
    // Strategy 1 (exact source_url match) fails; resolution would now
    // depend on the periodic reconciler's Strategy 2 (structured ID).
    expect(linkRow?.target_doc_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cursor-paginated URL reconciler (Fix 2)
//
// Verifies the scheduler-driven `computeLinkResolutions` +
// `upsertLinkResolutions` pair advances a persistent cursor across
// the URL link backlog, wraps to 0 on empty scan, and (critically)
// keeps the non-URL plain scan active every tick so attachments /
// email threads / intra-source links don't regress in retry latency.
// ─────────────────────────────────────────────────────────────────────

describe("cursor-paginated URL reconciler (Fix 2)", () => {
  function readCursor(db: Db): {
    cursor: number;
    cycle_count: number;
    last_wrapped_at: string | null;
  } {
    return db
      .prepare<
        [],
        { cursor: number; cycle_count: number; last_wrapped_at: string | null }
      >("SELECT cursor, cycle_count, last_wrapped_at FROM link_reconcile_state WHERE id = 1")
      .get()!;
  }

  function seedUnresolvedUrl(content: string): number {
    // Keep the (unresolvable) url link stored so the cursor scan has rows
    // to walk — without this the #570 gate drops them at extraction. The
    // permissive pattern flips the gate only; these urls match no doc so
    // they stay unresolved, exercising the cursor/wrap behavior.
    keepUrlLinks(db);
    const doc = makeDoc({
      externalId: `cursor-${randomUUID().slice(0, 8)}`,
      content,
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, doc.externalId);
    processDocumentLinks(
      db,
      docId,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    const link = db
      .prepare<[string], { id: number }>("SELECT id FROM document_links WHERE source_doc_id = ?")
      .get(docId);
    return link!.id;
  }

  test("scanner reads only rows whose id is strictly greater than the cursor", () => {
    // 5 unresolved URL links — none can resolve (no matching target docs).
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(seedUnresolvedUrl(`See https://unresolvable-${i}.example.com`));
    }
    ids.sort((a, b) => a - b);

    // First tick reads up to 2 URL rows (limit = 2 for URL).
    const batch1 = computeLinkResolutions(db, 2);
    const urlIds1 = batch1.resolutions.map((r) => r.linkId).filter((id) => ids.includes(id));
    expect(urlIds1).toEqual(ids.slice(0, 2));
    expect(batch1.scannedMaxId).toBe(ids[1]);

    upsertLinkResolutions(db, batch1);
    expect(readCursor(db).cursor).toBe(ids[1]);

    // Second tick picks up where the first left off.
    const batch2 = computeLinkResolutions(db, 2);
    const urlIds2 = batch2.resolutions.map((r) => r.linkId).filter((id) => ids.includes(id));
    expect(urlIds2).toEqual(ids.slice(2, 4));
    upsertLinkResolutions(db, batch2);
    expect(readCursor(db).cursor).toBe(ids[3]);
  });

  test("cursor wraps to 0 and bumps cycle_count on an empty URL scan", () => {
    seedUnresolvedUrl("See https://wrap-test.example.com");
    // Drain the only row past the cursor.
    const first = computeLinkResolutions(db, 4);
    upsertLinkResolutions(db, first);
    const afterFirst = readCursor(db);
    expect(afterFirst.cursor).toBeGreaterThan(0);
    expect(afterFirst.cycle_count).toBe(0);

    // Second tick: no URL rows past cursor → wrap.
    const second = computeLinkResolutions(db, 4);
    expect(second.scannedMaxId).toBe(0);
    upsertLinkResolutions(db, second);
    const afterWrap = readCursor(db);
    expect(afterWrap.cursor).toBe(0);
    expect(afterWrap.cycle_count).toBe(1);
    expect(afterWrap.last_wrapped_at).not.toBeNull();
  });

  test("wrap is idempotent when cursor is already 0", () => {
    // Fresh DB — cursor starts at 0, no unresolved rows.
    const batch = computeLinkResolutions(db, 4);
    upsertLinkResolutions(db, batch);
    const after = readCursor(db);
    // No prior cursor → no wrap (cycle_count stays 0).
    expect(after.cursor).toBe(0);
    expect(after.cycle_count).toBe(0);
  });

  test("a newer URL link is visited within one full cursor cycle", () => {
    // 3 stuck (unresolvable) links, then advance cursor past them by
    // running scans; insert a newer link; verify the cursor wraps and
    // the new link is found on the next tick.
    const stuckIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      stuckIds.push(seedUnresolvedUrl(`See https://stuck-${i}.example.com`));
    }
    // Drain past all stuck rows.
    while (true) {
      const batch = computeLinkResolutions(db, 4);
      upsertLinkResolutions(db, batch);
      if (batch.scannedMaxId === 0) break;
    }
    expect(readCursor(db).cursor).toBe(0); // wrapped

    // Add a newer link — same kind of unresolvable URL — and verify the
    // next tick scans from 0 and visits it.
    const newerId = seedUnresolvedUrl("See https://new-tail.example.com");
    const batch = computeLinkResolutions(db, 8);
    const scannedIds = batch.resolutions.map((r) => r.linkId);
    expect(scannedIds).toContain(newerId);
    expect(scannedIds).toContain(stuckIds[0]); // also re-scanned this cycle
  });

  test("non-URL links scan independently — no cursor regression vs pre-cursor behavior", () => {
    // Set up an attachment with unresolved parent link, advance the
    // URL cursor by running a tick that scans no URL rows (because we
    // have none), then ingest the parent. The next tick MUST still
    // resolve the attachment link — the non-URL scan does not consult
    // the cursor.
    const attachment = makeDoc({
      externalId: "msg-cursor-parent/att/att-1",
      content: "PDF text",
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: "msg-cursor-parent" },
      },
    });
    upsertDocuments(db, [attachment]);
    const attId = getDocId(db, "msg-cursor-parent/att/att-1");
    processDocumentLinks(
      db,
      attId,
      attachment.content,
      attachment.metadata,
      String(attachment.sourceId),
      attachment.externalId,
      null,
    );
    // Run a tick — no URL rows so the URL half is empty; the non-URL
    // half scans the attachment link but parent doesn't exist yet.
    upsertLinkResolutions(db, computeLinkResolutions(db, 10));

    // Now insert parent (no resolveInboundLinks call — periodic
    // reconciler is the only path to resolve this).
    const email = makeDoc({ externalId: "msg-cursor-parent", content: "Parent" });
    upsertDocuments(db, [email]);
    const emailId = getDocId(db, "msg-cursor-parent");

    // Next tick MUST resolve via the non-URL scan, regardless of the
    // (URL) cursor state.
    const batch = computeLinkResolutions(db, 10);
    const { updated } = upsertLinkResolutions(db, batch);
    expect(updated).toBe(1);
    const refs = getDocumentRefs(db, attId);
    expect(refs.outbound[0].targetDocId).toBe(emailId);
  });

  test("URL link resolves via Strategy 2 (structured ID) on the next tick that scans it", () => {
    // Register a Drive URL pattern in sync_state so Strategy 2 fires.
    setSyncState(
      db,
      "google-drive:jamesbond@gmail.com",
      {},
      {
        urlPatterns: [{ regex: "drive\\.google\\.com/file/d/([^/]+)" }],
      },
    );
    invalidateUrlIdPatternCache();

    // Drive doc with external_id matching the file ID.
    upsertDocuments(db, [
      makeDoc({
        providerId: ProviderId("google"),
        sourceId: SourceId("google-drive:jamesbond@gmail.com"),
        externalId: "FILE_XYZ",
        metadata: { sourceUrl: "https://drive.google.com/file/d/FILE_XYZ" },
      }),
    ]);
    const driveId = getDocId(db, "FILE_XYZ");

    // Message with a non-canonical `/edit` variant — won't match Drive
    // doc's source_url verbatim, but the URL pattern can extract the ID.
    const msg = makeDoc({
      sourceId: SourceId("whatsapp-messages:+1"),
      externalId: "wa-strat2",
      content: "Link: https://drive.google.com/file/d/FILE_XYZ/edit",
    });
    upsertDocuments(db, [msg]);
    const msgId = getDocId(db, "wa-strat2");
    processDocumentLinks(db, msgId, msg.content, msg.metadata, msg.sourceId, msg.externalId, null);

    // #569 resolves url links eagerly at extraction; un-resolve here to
    // exercise the reconcile DIRECT SCAN / cursor scan on the historical
    // backlog of links inserted before eager resolution existed.
    db.prepare(
      "UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL WHERE link_type = 'url'",
    ).run();

    const batch = computeLinkResolutions(db, 10);
    const { updated } = upsertLinkResolutions(db, batch);
    expect(updated).toBe(1);
    const refs = getDocumentRefs(db, msgId);
    expect(refs.outbound[0].targetDocId).toBe(driveId);
  });

  test("a resolvable URL link below the cursor stays starved until the cycle wraps", () => {
    // Register a Drive URL pattern so Strategy 2 will resolve once a
    // Drive doc with matching external_id exists.
    setSyncState(
      db,
      "google-drive:test@example.com",
      {},
      {
        urlPatterns: [{ regex: "drive\\.google\\.com/file/d/([^/]+)" }],
      },
    );
    invalidateUrlIdPatternCache();

    // Insert three /edit-variant URL links, none yet resolvable.
    const msgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = makeDoc({
        sourceId: SourceId("whatsapp-messages:+1"),
        externalId: `wa-starve-${i}`,
        content: `Link: https://drive.google.com/file/d/FILE_${i}/edit`,
      });
      upsertDocuments(db, [msg]);
      const id = getDocId(db, msg.externalId);
      processDocumentLinks(db, id, msg.content, msg.metadata, msg.sourceId, msg.externalId, null);
      msgIds.push(id);
    }

    // Advance the cursor past all three by draining (none resolve).
    let safety = 0;
    while (true) {
      const b = computeLinkResolutions(db, 50);
      upsertLinkResolutions(db, b);
      if (b.scannedMaxId === 0) break;
      if (++safety > 10) throw new Error("drain did not converge");
    }
    expect(
      db
        .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
        .get()!.cursor,
    ).toBe(0); // Wrapped.

    // NOW the FILE_0 target arrives — its link is at the head of the
    // backlog (lowest id). Advance the cursor past it WITHOUT resolving
    // by registering a Drive doc that matches only FILE_2 (highest id)
    // first, draining one tick. Easier: re-advance cursor past FILE_0
    // by running one tick BEFORE inserting the target.
    const tickBeforeTarget = computeLinkResolutions(db, 1);
    upsertLinkResolutions(db, tickBeforeTarget);
    const cursorAfterFirstTick = db
      .prepare<[], { cursor: number }>("SELECT cursor FROM link_reconcile_state WHERE id = 1")
      .get()!.cursor;
    expect(cursorAfterFirstTick).toBeGreaterThan(0); // Cursor is past FILE_0's link.

    // Insert the target for FILE_0. Its link sits at id < cursor.
    upsertDocuments(db, [
      makeDoc({
        providerId: ProviderId("google"),
        sourceId: SourceId("google-drive:test@example.com"),
        externalId: "FILE_0",
        metadata: { sourceUrl: "https://drive.google.com/file/d/FILE_0" },
      }),
    ]);

    // Next tick — cursor scan returns rows with id > cursor; FILE_0's
    // link (id <= cursor) is NOT visited. resolveInboundLinks is not
    // wired into upsertDocuments, so no other path resolves it either.
    const tickAfterTarget = computeLinkResolutions(db, 1);
    upsertLinkResolutions(db, tickAfterTarget);
    const refsStillUnresolved = getDocumentRefs(db, msgIds[0]);
    expect(refsStillUnresolved.outbound[0].targetDocId).toBeNull();

    // Drain to wrap-around. After wrap, the next tick scans from id=0
    // and finally finds FILE_0's link.
    safety = 0;
    while (true) {
      const b = computeLinkResolutions(db, 50);
      upsertLinkResolutions(db, b);
      if (b.scannedMaxId === 0) break;
      if (++safety > 10) throw new Error("drain did not converge");
    }
    // Cursor wrapped; one more tick from id=0 visits and resolves FILE_0.
    const finalBatch = computeLinkResolutions(db, 50);
    const finalUpsert = upsertLinkResolutions(db, finalBatch);
    expect(finalUpsert.updated).toBe(1);
    const refsAfterWrap = getDocumentRefs(db, msgIds[0]);
    expect(refsAfterWrap.outbound[0].targetDocId).toBe(getDocId(db, "FILE_0"));
  });

  test("limit <= 0 returns an empty batch without scanning (SQLite LIMIT -1 means unbounded)", () => {
    // Seed an unresolved URL — without the `limit <= 0` guard, calling
    // `computeLinkResolutions(db, -1)` would bind LIMIT to -1, which
    // SQLite treats as "no limit" and would return this row.
    seedUnresolvedUrl("See https://nothing.example.com");

    const batchNeg = computeLinkResolutions(db, -1);
    expect(batchNeg.resolutions).toHaveLength(0);
    expect(batchNeg.scannedMaxId).toBe(0);

    const batchZero = computeLinkResolutions(db, 0);
    expect(batchZero.resolutions).toHaveLength(0);
    expect(batchZero.scannedMaxId).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additive-only link extraction for best-effort content retention (#481)
// ---------------------------------------------------------------------------
describe("additive-only link extraction (best-effort content retention)", () => {
  // Keep extracted url links stored (unresolved) so the additive
  // preserve/accumulate assertions have rows to count (#570 gate). The
  // permissive pattern is registered under a separate source_id, so it
  // doesn't disturb the best-effort `content_retention` row.
  beforeEach(() => keepUrlLinks(db));

  const whatsappSourceId = "whatsapp-messages:+1234567890";
  const whatsappProviderId = "whatsapp:+1234567890";

  function makeWhatsAppDoc(overrides: Partial<DocumentInput> = {}): DocumentInput {
    return {
      providerId: ProviderId(whatsappProviderId),
      sourceId: SourceId(whatsappSourceId),
      externalId: `chat:2024-01-15`,
      title: "Alice — 2024-01-15",
      content: "Hello world",
      contentHash: `hash-${randomUUID().slice(0, 8)}`,
      metadata: { documentType: "conversation" },
      sourceCreatedAt: "2024-01-15T10:00:00Z",
      sourceUpdatedAt: "2024-01-15T10:00:00Z",
      ...overrides,
    };
  }

  function registerBestEffortSource() {
    setSyncState(
      db,
      whatsappSourceId,
      {},
      {
        contentRetention: "best-effort",
      },
    );
  }

  function allLinks(docId: string) {
    return db
      .prepare<
        [string],
        { link_type: string; normalized_target: string; target_doc_id: string | null }
      >("SELECT link_type, normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY normalized_target")
      .all(docId);
  }

  test("preserves existing links when content shrinks (buffer rollover)", () => {
    registerBestEffortSource();

    // First sync: doc has two URLs
    const doc1 = makeWhatsAppDoc({
      content: "Check https://example.com and https://other.org",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");

    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    const linksV1 = allLinks(docId);
    expect(linksV1).toHaveLength(2);
    expect(linksV1.map((l) => l.normalized_target).sort()).toEqual([
      "https://example.com/",
      "https://other.org/",
    ]);

    // Second sync: buffer rolled over, only a reaction remains — no URLs
    const doc2 = makeWhatsAppDoc({
      content: "👍 _(reaction)_",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);

    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    // Both original links must survive
    const linksV2 = allLinks(docId);
    expect(linksV2).toHaveLength(2);
    expect(linksV2.map((l) => l.normalized_target).sort()).toEqual([
      "https://example.com/",
      "https://other.org/",
    ]);
  });

  test("adds new links without removing existing ones", () => {
    registerBestEffortSource();

    // First sync: doc has URL A
    const doc1 = makeWhatsAppDoc({
      content: "See https://alpha.com",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(1);

    // Second sync: buffer rolled over, now has URL B (A is gone from content)
    const doc2 = makeWhatsAppDoc({
      content: "See https://beta.com",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    // Both A and B should be present
    const links = allLinks(docId);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.normalized_target).sort()).toEqual([
      "https://alpha.com/",
      "https://beta.com/",
    ]);
  });

  test("preserves resolved target_doc_id on existing links", () => {
    registerBestEffortSource();

    // Insert a target document that has a matching source_url
    const targetDoc = makeDoc({
      sourceId: SourceId("web"),
      externalId: "page-1",
      content: "Captured page",
      contentHash: "captured-hash",
      sourceUrl: "https://example.com/",
    });
    upsertDocuments(db, [targetDoc]);
    const targetDocId = getDocId(db, "page-1");

    // Insert WhatsApp doc with a URL matching the target
    const doc1 = makeWhatsAppDoc({
      content: "Check https://example.com for more.",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    // Manually resolve the link (simulating the reconcile pass)
    db.prepare(
      "UPDATE document_links SET target_doc_id = ?, resolved_at = ? WHERE source_doc_id = ? AND normalized_target = ?",
    ).run(targetDocId, new Date().toISOString(), docId, "https://example.com/");

    const linksBefore = allLinks(docId);
    expect(linksBefore).toHaveLength(1);
    expect(linksBefore[0].target_doc_id).toBe(targetDocId);

    // Re-sync with same URL still in content — DO NOTHING should preserve resolution
    const doc2 = makeWhatsAppDoc({
      content: "Check https://example.com for more. Also new stuff.",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    const linksAfter = allLinks(docId);
    expect(linksAfter).toHaveLength(1);
    expect(linksAfter[0].target_doc_id).toBe(targetDocId);
  });

  test("normal source (no best-effort) still deletes old links", () => {
    // Don't register as best-effort — use a normal gmail source
    const doc1 = makeDoc({
      externalId: "email-1",
      content: "See https://example.com and https://other.org",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "email-1");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      String(doc1.sourceId),
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(2);

    // Re-sync with one URL removed
    const doc2 = makeDoc({
      externalId: "email-1",
      content: "See https://example.com",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      String(doc2.sourceId),
      doc2.externalId,
      null,
    );

    // Only one link should remain (old behavior)
    const links = allLinks(docId);
    expect(links).toHaveLength(1);
    expect(links[0].normalized_target).toBe("https://example.com/");
  });

  test("upsertExtractedLinksBatch respects additive mode", () => {
    registerBestEffortSource();

    // Insert doc with URL A
    const doc1 = makeWhatsAppDoc({
      content: "See https://alpha.com",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(1);

    // Simulate content update: buffer rolled, only URL B
    const doc2 = makeWhatsAppDoc({
      content: "See https://beta.com",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);
    // Clear links_extracted_at so the batch path picks it up
    db.prepare("UPDATE documents SET links_extracted_at = NULL WHERE id = ?").run(docId);

    // Extract links for batch (compute side)
    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    expect(batch).toHaveLength(1);
    expect(batch[0].links).toHaveLength(1);
    expect(batch[0].links[0].normalizedTarget).toBe("https://beta.com/");

    // Apply batch (writer side)
    const result = upsertExtractedLinksBatch(db, batch);
    expect(result.applied).toBe(1);

    // Both A and B should be present (additive)
    const links = allLinks(docId);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.normalized_target).sort()).toEqual([
      "https://alpha.com/",
      "https://beta.com/",
    ]);
  });

  test("backfillOneDocument respects additive mode", () => {
    registerBestEffortSource();

    // Insert doc with URL A
    const doc1 = makeWhatsAppDoc({
      content: "See https://alpha.com",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(1);

    // Update content: buffer rolled, only URL B
    const doc2 = makeWhatsAppDoc({
      content: "See https://beta.com",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);

    // backfillOneDocument should use additive mode
    const result = backfillOneDocument(db);
    expect(result).not.toBeNull();

    // Both A and B should be present
    const links = allLinks(docId);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.normalized_target).sort()).toEqual([
      "https://alpha.com/",
      "https://beta.com/",
    ]);
  });

  test("duplicate links are not inserted twice", () => {
    registerBestEffortSource();

    // First sync: doc has URL A
    const doc1 = makeWhatsAppDoc({
      content: "See https://example.com",
      contentHash: "hash-v1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    // Second sync: same URL still in content
    const doc2 = makeWhatsAppDoc({
      content: "See https://example.com plus more text",
      contentHash: "hash-v2",
    });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    // Only one link row (UNIQUE constraint + DO NOTHING)
    expect(allLinks(docId)).toHaveLength(1);
  });

  test("multiple syncs accumulate links correctly", () => {
    registerBestEffortSource();

    // Sync 1: URL A
    const doc1 = makeWhatsAppDoc({ content: "https://a.com", contentHash: "h1" });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    // Sync 2: URL B (buffer rolled, A is gone)
    const doc2 = makeWhatsAppDoc({ content: "https://b.com", contentHash: "h2" });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    // Sync 3: URL C (buffer rolled, B is gone)
    const doc3 = makeWhatsAppDoc({ content: "https://c.com", contentHash: "h3" });
    upsertDocuments(db, [doc3]);
    processDocumentLinks(
      db,
      docId,
      doc3.content,
      doc3.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc3.externalId,
      null,
    );

    // All three links should be preserved
    const links = allLinks(docId);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.normalized_target).sort()).toEqual([
      "https://a.com/",
      "https://b.com/",
      "https://c.com/",
    ]);
  });

  test("empty content sync preserves all existing links", () => {
    registerBestEffortSource();

    const doc1 = makeWhatsAppDoc({
      content: "https://a.com https://b.com",
      contentHash: "h1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "chat:2024-01-15");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(2);

    // Sync with no URLs at all
    const doc2 = makeWhatsAppDoc({ content: "just a reaction 👍", contentHash: "h2" });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      doc2.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(2);
  });

  test("unregistered source defaults to destructive mode", () => {
    // No registerBestEffortSource() — no sync_state row at all
    const unknownSourceId = "unknown-source:foo";
    const doc1 = makeDoc({
      sourceId: SourceId(unknownSourceId),
      externalId: "unknown-1",
      content: "https://a.com https://b.com",
      contentHash: "h1",
    });
    upsertDocuments(db, [doc1]);
    const docId = getDocId(db, "unknown-1");
    processDocumentLinks(
      db,
      docId,
      doc1.content,
      doc1.metadata as { extra?: Record<string, unknown> },
      unknownSourceId,
      doc1.externalId,
      null,
    );

    expect(allLinks(docId)).toHaveLength(2);

    // Re-sync with one URL removed
    const doc2 = makeDoc({
      sourceId: SourceId(unknownSourceId),
      externalId: "unknown-1",
      content: "https://a.com",
      contentHash: "h2",
    });
    upsertDocuments(db, [doc2]);
    processDocumentLinks(
      db,
      docId,
      doc2.content,
      doc2.metadata as { extra?: Record<string, unknown> },
      unknownSourceId,
      doc2.externalId,
      null,
    );

    // Old link should be deleted (destructive mode)
    expect(allLinks(docId)).toHaveLength(1);
    expect(allLinks(docId)[0].normalized_target).toBe("https://a.com/");
  });

  test("mixed batch: best-effort and normal docs in same upsertExtractedLinksBatch", () => {
    registerBestEffortSource();

    // Insert a WhatsApp doc with URL A
    const waDoc = makeWhatsAppDoc({
      externalId: "wa-chat:2024-01-15",
      content: "https://alpha.com",
      contentHash: "wa-h1",
    });
    upsertDocuments(db, [waDoc]);
    const waDocId = getDocId(db, "wa-chat:2024-01-15");
    processDocumentLinks(
      db,
      waDocId,
      waDoc.content,
      waDoc.metadata as { extra?: Record<string, unknown> },
      whatsappSourceId,
      waDoc.externalId,
      null,
    );

    // Insert a Gmail doc with URL X
    const gmailDoc = makeDoc({
      externalId: "gmail-1",
      content: "https://x-site.com",
      contentHash: "gm-h1",
    });
    upsertDocuments(db, [gmailDoc]);
    const gmailDocId = getDocId(db, "gmail-1");
    processDocumentLinks(
      db,
      gmailDocId,
      gmailDoc.content,
      gmailDoc.metadata as { extra?: Record<string, unknown> },
      String(gmailDoc.sourceId),
      gmailDoc.externalId,
      null,
    );

    expect(allLinks(waDocId)).toHaveLength(1);
    expect(allLinks(gmailDocId)).toHaveLength(1);

    // Update both docs: WhatsApp gets URL B (A rolled off), Gmail gets URL Y (X removed)
    const waDoc2 = makeWhatsAppDoc({
      externalId: "wa-chat:2024-01-15",
      content: "https://beta.com",
      contentHash: "wa-h2",
    });
    upsertDocuments(db, [waDoc2]);
    db.prepare("UPDATE documents SET links_extracted_at = NULL WHERE id = ?").run(waDocId);

    const gmailDoc2 = makeDoc({
      externalId: "gmail-1",
      content: "https://y-site.com",
      contentHash: "gm-h2",
    });
    upsertDocuments(db, [gmailDoc2]);
    db.prepare("UPDATE documents SET links_extracted_at = NULL WHERE id = ?").run(gmailDocId);

    // Extract and apply as one batch
    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    expect(batch).toHaveLength(2);
    const result = upsertExtractedLinksBatch(db, batch);
    expect(result.applied).toBe(2);

    // WhatsApp: additive — both A and B preserved
    const waLinks = allLinks(waDocId);
    expect(waLinks).toHaveLength(2);
    expect(waLinks.map((l) => l.normalized_target).sort()).toEqual([
      "https://alpha.com/",
      "https://beta.com/",
    ]);

    // Gmail: destructive — only Y remains
    const gmLinks = allLinks(gmailDocId);
    expect(gmLinks).toHaveLength(1);
    expect(gmLinks[0].normalized_target).toBe("https://y-site.com/");
  });
});

// ---------------------------------------------------------------------------
// #570 — url-link storage gate: a `url` link is stored only if it resolves
// now (source_url / url-pattern → already-ingested doc) OR its target could
// resolve later (matches a registered url-id pattern). Otherwise it's a
// permanent external dead-end and is dropped at extraction; the periodic
// reconcile prunes any such historical rows it walks. These tests register
// NO matching pattern on purpose — that's the whole point of the gate.
//
// The "drops a url with no target and no matching pattern" cases below also
// lock the INTENTIONAL #570 trade-off: a url whose target would only ever
// resolve via the deferred strategy-1 path (a `source_url` host with no
// url-id pattern — e.g. a browser-history or bookmark page that
// lands AFTER the link is extracted) is dropped, not kept. See the
// `urlTargetCouldResolve` doc-comment for why that's acceptable.
// ---------------------------------------------------------------------------
describe("#570 — url-link storage gate", () => {
  function allLinks(docId: string) {
    return db
      .prepare<
        [string],
        { link_type: string; normalized_target: string; target_doc_id: string | null }
      >("SELECT link_type, normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY normalized_target")
      .all(docId);
  }

  beforeEach(() => {
    // No url-id patterns registered for this db — start from a clean cache
    // so the gate's "drop" path is exercised deterministically.
    invalidateUrlIdPatternCache();
  });

  describe("processDocumentLinks", () => {
    test("drops a url with no target and no matching pattern, but keeps an intra-source link in the same doc", () => {
      // The doc carries a permanent external dead-end url AND a source-declared
      // intra-source link. The url is dropped; the intra-source link survives.
      const doc = makeDoc({
        externalId: "gate-pdl-drop",
        sourceId: SourceId("obsidian:vault"),
        content: "Dead end: https://no-such-target.example.com/article",
        metadata: { extra: { links: ["Other Note"] } },
      });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-pdl-drop");

      const result = processDocumentLinks(
        db,
        docId,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );

      const links = allLinks(docId);
      // The url row is absent; only the references link is stored.
      expect(links.filter((l) => l.link_type === "url")).toHaveLength(0);
      expect(
        db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM pending_edges WHERE source_doc_id = ?")
          .get(docId)?.count ?? 0,
      ).toBe(0);
      const intra = links.filter((l) => l.link_type === "references");
      expect(intra).toHaveLength(1);
      expect(intra[0].normalized_target).toBe("other note");
      // `extracted` counts only stored links — the dropped url isn't counted.
      expect(result.extracted).toBe(1);
    });

    test("keeps a direct source_url match for role-aware reconciliation", () => {
      // The target doc exists first with a matching source_url, so the url
      // resolves at extraction (Strategy 1) and is kept regardless of patterns.
      const target = makeDoc({
        externalId: "gate-pdl-target",
        metadata: { sourceUrl: "https://resolve-now.example.com/page" },
      });
      upsertDocuments(db, [target]);
      const targetId = getDocId(db, "gate-pdl-target");

      const source = makeDoc({
        externalId: "gate-pdl-resolves",
        content: "See https://resolve-now.example.com/page",
      });
      upsertDocuments(db, [source]);
      const sourceDocId = getDocId(db, "gate-pdl-resolves");

      processDocumentLinks(
        db,
        sourceDocId,
        source.content,
        source.metadata,
        String(source.sourceId),
        source.externalId,
        null,
      );

      const links = allLinks(sourceDocId);
      const url = links.filter((l) => l.link_type === "url");
      expect(url).toHaveLength(1);
      expect(url[0].target_doc_id).toBeNull();

      upsertLinkResolutions(db, computeLinkResolutions(db, 50));
      expect(allLinks(sourceDocId).find((l) => l.link_type === "url")?.target_doc_id).toBe(
        targetId,
      );
    });

    test("keeps (unresolved) a url that matches a registered pattern even though its target isn't ingested", () => {
      // Register a Drive url-id pattern. A /edit-variant link matches it, so
      // it could resolve later — kept stored but unresolved (no Drive doc yet).
      setSyncState(
        db,
        "google-drive:adrien@example.com",
        {},
        { urlPatterns: [{ regex: "drive\\.google\\.com/file/d/([^/]+)" }] },
      );
      invalidateUrlIdPatternCache();

      const doc = makeDoc({
        sourceId: SourceId("whatsapp-messages:+15550100001"),
        externalId: "gate-pdl-pattern",
        content: "Link: https://drive.google.com/file/d/FILE_KEEP/edit",
      });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-pdl-pattern");

      processDocumentLinks(
        db,
        docId,
        doc.content,
        doc.metadata,
        String(doc.sourceId),
        doc.externalId,
        null,
      );

      const url = allLinks(docId).filter((l) => l.link_type === "url");
      expect(url).toHaveLength(1);
      expect(url[0].target_doc_id).toBeNull();
    });
  });

  describe("upsertExtractedLinksBatch", () => {
    test("drops a url with no target and no matching pattern", () => {
      const doc = makeDoc({
        externalId: "gate-batch-drop",
        content: "Dead end: https://no-such-target.example.com/x",
      });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-batch-drop");

      const extracted = extractLinksForBatch(db, 10, [], [], false, [], false);
      const batch = withResolvedTargets(
        extracted,
        resolveExtractedLinks(db, extracted, [], [], true, [], true),
      );
      const result = upsertExtractedLinksBatch(db, batch);
      expect(result.applied).toBe(1);
      // No url row stored, so nothing counted as extracted.
      expect(result.extracted).toBe(0);
      expect(allLinks(docId).filter((l) => l.link_type === "url")).toHaveLength(0);
      expect(
        db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM pending_edges WHERE source_doc_id = ?")
          .get(docId)?.count ?? 0,
      ).toBe(0);
    });

    test("keeps and resolves a url that resolves now via source_url, with no pattern registered", () => {
      const target = makeDoc({
        externalId: "gate-batch-target",
        metadata: { sourceUrl: "https://batch-resolve.example.com" },
      });
      const source = makeDoc({
        externalId: "gate-batch-resolves",
        content: "See https://batch-resolve.example.com",
      });
      upsertDocuments(db, [target, source]);
      const targetId = getDocId(db, "gate-batch-target");
      const sourceDocId = getDocId(db, "gate-batch-resolves");

      const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
      const result = upsertExtractedLinksBatch(db, batch);
      expect(result.applied).toBe(2);
      const url = allLinks(sourceDocId).filter((l) => l.link_type === "url");
      expect(url).toHaveLength(1);
      expect(url[0].target_doc_id).toBe(targetId);
    });

    test("keeps (unresolved) a url that matches a registered pattern even though its target isn't ingested", () => {
      setSyncState(
        db,
        "google-drive:adrien@example.com",
        {},
        { urlPatterns: [{ regex: "drive\\.google\\.com/file/d/([^/]+)" }] },
      );
      invalidateUrlIdPatternCache();

      const doc = makeDoc({
        sourceId: SourceId("whatsapp-messages:+15550100002"),
        externalId: "gate-batch-pattern",
        content: "Link: https://drive.google.com/file/d/FILE_BATCH/edit",
      });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-batch-pattern");

      const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
      upsertExtractedLinksBatch(db, batch);
      const url = allLinks(docId).filter((l) => l.link_type === "url");
      expect(url).toHaveLength(1);
      expect(url[0].target_doc_id).toBeNull();
    });
  });

  describe("prune via computeLinkResolutions + upsertLinkResolutions", () => {
    // Insert a historical unresolved url link directly (bypassing the
    // extraction gate) to model a backlog row written before #570 landed.
    function insertHistoricalUrlLink(sourceDocId: string, url: string): number {
      const now = new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at)
           VALUES (?, 'url', ?, ?, NULL, NULL, ?)`,
        )
        .run(sourceDocId, url, url, now);
      return Number(info.lastInsertRowid);
    }

    test("deletes a permanently-unresolvable historical url link (no target, no pattern)", () => {
      const doc = makeDoc({ externalId: "gate-prune-drop", content: "body" });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-prune-drop");
      const linkId = insertHistoricalUrlLink(docId, "https://example.com/article/123");

      const batch = computeLinkResolutions(db, 50);
      expect(batch.deletableLinkIds).toContain(linkId);

      const { deleted } = upsertLinkResolutions(db, batch);
      expect(deleted).toBe(1);
      const row = db
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM document_links WHERE id = ?")
        .get(linkId);
      expect(row?.c).toBe(0);
    });

    test("does not delete a historical url link that matches a registered pattern", () => {
      // A Drive pattern makes the link "could-resolve-later", so the prune
      // must leave it in place even though no target is ingested yet.
      setSyncState(
        db,
        "google-drive:adrien@example.com",
        {},
        { urlPatterns: [{ regex: "drive\\.google\\.com/file/d/([^/]+)" }] },
      );
      invalidateUrlIdPatternCache();

      const doc = makeDoc({ externalId: "gate-prune-keep", content: "body" });
      upsertDocuments(db, [doc]);
      const docId = getDocId(db, "gate-prune-keep");
      const linkId = insertHistoricalUrlLink(
        docId,
        "https://drive.google.com/file/d/FILE_PRUNE/edit",
      );

      const batch = computeLinkResolutions(db, 50);
      expect(batch.deletableLinkIds).not.toContain(linkId);

      const { deleted } = upsertLinkResolutions(db, batch);
      expect(deleted).toBe(0);
      const row = db
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM document_links WHERE id = ?")
        .get(linkId);
      expect(row?.c).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// #668 — cross-source links to not-yet-added sources survive the #570 gate.
//
// The #570 keep-gate keys on the KNOWN-source-type url-id pattern set
// (pushed by the collector from every loaded source definition), not just
// the *registered* (added) sources from `sync_state`. So a link whose target
// matches a source the user hasn't added yet is kept unresolved at
// extraction and survives the periodic prune — then resolves via the
// reconcile path once that source is added and its target doc is ingested.
// Pre-#668 it was dropped permanently (re-extraction only re-fires on the
// SOURCE doc changing, so the link never came back on its own).
// ---------------------------------------------------------------------------
describe("#668 — known-but-not-added source link survives the #570 gate", () => {
  // A pattern for a source type that is NOT registered in sync_state — it is
  // only known via the descriptor set the collector pushed. The capture group
  // is the page-id so the eventual resolution (Strategy 2) has something to
  // match against once the target doc is ingested.
  const NOTION_PATTERN = "notion\\.so/[^?#]*([a-f0-9]{32})(?:[?].*|)$";
  const NOTION_URL = "https://notion.so/Project-Plan-0123456789abcdef0123456789abcdef";
  const NOTION_PAGE_ID = "0123456789abcdef0123456789abcdef";

  function allLinks(docId: string) {
    return db
      .prepare<
        [string],
        { link_type: string; normalized_target: string; target_doc_id: string | null }
      >("SELECT link_type, normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY normalized_target")
      .all(docId);
  }

  beforeEach(() => {
    // No url-id patterns *registered* — the target source isn't added yet.
    invalidateUrlIdPatternCache();
    resetKnownUrlPatterns();
  });

  afterEach(() => {
    resetKnownUrlPatterns();
  });

  test("dropped when the pattern is neither registered nor known (baseline)", () => {
    const doc = makeDoc({
      sourceId: SourceId("gmail:user@gmail.com"),
      externalId: "x668-baseline",
      content: `See the plan: ${NOTION_URL}`,
    });
    upsertDocuments(db, [doc]);
    const docId = getDocId(db, "x668-baseline");

    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    upsertExtractedLinksBatch(db, batch);

    // Without the known-pattern set, the gate treats the Notion URL as a
    // permanent external dead-end and drops it.
    expect(allLinks(docId).filter((l) => l.link_type === "url")).toHaveLength(0);
  });

  test("kept (unresolved) once the target source's pattern is known, then resolves after the source is added and ingested", () => {
    // 1. The collector pushes the full known-source-type pattern set —
    //    including Notion's — even though Notion is not an added source yet.
    setKnownUrlPatterns("test", [{ regex: NOTION_PATTERN }]);

    // 2. A Gmail email links to a Notion page. Extraction runs.
    const email = makeDoc({
      sourceId: SourceId("gmail:user@gmail.com"),
      externalId: "x668-email",
      content: `See the plan: ${NOTION_URL}`,
    });
    upsertDocuments(db, [email]);
    const emailId = getDocId(db, "x668-email");

    const batch = extractLinksForBatch(db, 10, [], [], true, [NOTION_PATTERN], true);
    upsertExtractedLinksBatch(db, batch);

    // The url link is KEPT (unresolved) — the known pattern flips the gate.
    const url = allLinks(emailId).filter((l) => l.link_type === "url");
    expect(url).toHaveLength(1);
    expect(url[0].target_doc_id).toBeNull();

    // 3. The periodic prune must NOT delete it — it could still resolve.
    const pruneBatch = computeLinkResolutions(db, 50);
    const linkId = db
      .prepare<
        [string],
        { id: number }
      >("SELECT id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .get(emailId)!.id;
    expect(pruneBatch.deletableLinkIds).not.toContain(linkId);
    const { deleted } = upsertLinkResolutions(db, pruneBatch);
    expect(deleted).toBe(0);

    // 4. The user adds Notion — its patterns now register in sync_state — and
    //    the linked page is ingested with the matching external_id.
    setSyncState(db, "notion:user@example.com", {}, { urlPatterns: [{ regex: NOTION_PATTERN }] });
    invalidateUrlIdPatternCache();
    const notionDoc = makeDoc({
      providerId: ProviderId("notion"),
      sourceId: SourceId("notion:user@example.com"),
      externalId: NOTION_PAGE_ID,
      content: "Project plan body",
    });
    upsertDocuments(db, [notionDoc]);
    const notionDocId = getDocId(db, NOTION_PAGE_ID);

    // 5. The reconcile cursor advanced past this link during the step-3
    //    prune scan; on the next full cycle it wraps back to the start (the
    //    real reconcile loops the backlog). Reset it to model that wrap so the
    //    cursor scan re-visits the kept link.
    db.prepare("UPDATE link_reconcile_state SET cursor = 0 WHERE id = 1").run();

    // The reconcile path now resolves the previously-kept link (Strategy 2:
    // url-pattern → external_id) — recovery, instead of a permanent loss.
    const resolveBatch = computeLinkResolutions(db, 50);
    upsertLinkResolutions(db, resolveBatch);

    const resolved = allLinks(emailId).filter((l) => l.link_type === "url");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].target_doc_id).toBe(notionDocId);
  });
});

describe("references resolved through declared link keys", () => {
  const VAULT = SourceId("obsidian-notes:vault");

  /** A note the way the Obsidian source emits it: an opaque id, a bare title, its path as a key. */
  function note(externalId: string, title: string, path: string, links: string[] = []) {
    return makeDoc({
      providerId: ProviderId("obsidian"),
      sourceId: VAULT,
      externalId,
      title,
      content: `Body of ${title}`,
      metadata: { extra: { linkKeys: [path], ...(links.length > 0 ? { links } : {}) } },
    });
  }

  function linkFrom(doc: DocumentInput): string {
    upsertDocuments(db, [doc]);
    const id = getDocId(db, doc.externalId);
    processDocumentLinks(
      db,
      id,
      doc.content,
      doc.metadata,
      String(doc.sourceId),
      doc.externalId,
      null,
    );
    return id;
  }

  function targetOf(sourceDocId: string): string | null {
    return (
      db
        .prepare<
          [string],
          { target_doc_id: string | null }
        >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'references'")
        .get(sourceDocId)?.target_doc_id ?? null
    );
  }

  test("a folder-qualified link reaches the note that declares that path", () => {
    // The note is linked by `projects/roadmap`, which is neither its opaque id
    // nor its bare title. Before keys were declared, this never resolved.
    linkFrom(note("inode:2", "roadmap", "projects/roadmap"));
    const fromId = linkFrom(note("inode:1", "index", "index", ["projects/roadmap"]));

    expect(targetOf(fromId)).toBe(getDocId(db, "inode:2"));
  });

  test("a link written before its target arrives is resolved when the target lands", () => {
    // The inbound direction runs on the writer when a document is stored; it
    // must know the declared keys too, or the order two notes sync in would
    // decide whether they are linked.
    const fromId = linkFrom(note("inode:1", "index", "index", ["projects/roadmap"]));
    expect(targetOf(fromId)).toBeNull();

    const target = note("inode:2", "roadmap", "projects/roadmap");
    upsertDocuments(db, [target]);
    const targetId = getDocId(db, "inode:2");
    const resolved = resolveInboundLinks(db, targetId, null, String(VAULT), target.externalId);

    expect(resolved).toBe(1);
    expect(targetOf(fromId)).toBe(targetId);
  });

  test("a key declared in another source does not answer", () => {
    // Keys are scoped to the declaring source, like titles: two vaults may
    // both have a `projects/roadmap`.
    upsertDocuments(db, [
      makeDoc({
        providerId: ProviderId("obsidian"),
        sourceId: SourceId("obsidian-notes:other-vault"),
        externalId: "inode:9",
        title: "roadmap",
        metadata: { extra: { linkKeys: ["projects/roadmap"] } },
      }),
    ]);
    const fromId = linkFrom(note("inode:1", "index", "index", ["projects/roadmap"]));

    expect(targetOf(fromId)).toBeNull();
  });
});

describe("duplicate-content edges whose other copy is deleted", () => {
  const now = "2026-01-10T09:00:00.000Z";

  function duplicateEdge(fromId: string, toId: string): void {
    db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at,
          created_at, provenance_kind, provenance_origin, provenance_version, declared_at)
       VALUES (?, 'duplicate-content', ?, ?, ?, ?, ?, 'cross-source-derived', 'test', NULL, ?)`,
    ).run(fromId, "hash-shared", toId, toId, now, now, now);
  }

  function edgesFrom(docId: string, type: string): Array<{ target: string | null }> {
    return db
      .prepare<
        [string, string],
        { target: string | null }
      >("SELECT target_doc_id AS target FROM document_links WHERE source_doc_id = ? AND link_type = ?")
      .all(docId, type);
  }

  function reconcile(): void {
    upsertLinkResolutions(db, computeLinkResolutions(db, 500));
  }

  test("an edge stranded by deleting its other copy is removed on the next reconcile", () => {
    // The edge names its target by document id, so nothing can resolve it
    // again, and nothing re-derives it while the surviving copy is unchanged.
    // Removing a source that held one copy of many files stranded an edge on
    // every other copy.
    upsertDocuments(db, [
      makeDoc({ externalId: "copy-a", title: "Quarterly plan.pdf" }),
      makeDoc({ externalId: "copy-b", title: "Quarterly plan.pdf" }),
    ]);
    const a = getDocId(db, "copy-a");
    const b = getDocId(db, "copy-b");
    duplicateEdge(a, b);

    db.prepare("DELETE FROM documents WHERE id = ?").run(b);
    expect(edgesFrom(a, "duplicate-content")).toEqual([{ target: null }]);

    reconcile();
    expect(edgesFrom(a, "duplicate-content")).toEqual([]);
  });

  test("in the same pass, an edge whose other copy still exists is left alone", () => {
    // Stranding one edge makes the pass run the prune; the live edge beside it
    // is what shows the prune picks only the edge whose target is gone.
    upsertDocuments(db, [
      makeDoc({ externalId: "copy-a", title: "Quarterly plan.pdf" }),
      makeDoc({ externalId: "copy-b", title: "Quarterly plan.pdf" }),
      makeDoc({ externalId: "copy-c", title: "Quarterly plan.pdf" }),
    ]);
    const a = getDocId(db, "copy-a");
    const b = getDocId(db, "copy-b");
    const c = getDocId(db, "copy-c");
    duplicateEdge(a, b);
    duplicateEdge(a, c);

    db.prepare("DELETE FROM documents WHERE id = ?").run(b);
    reconcile();

    expect(edgesFrom(a, "duplicate-content")).toEqual([{ target: c }]);
  });

  test("a link that can find a new target keeps waiting for one", () => {
    // A reference names its target by something another document can carry,
    // so an empty target means "not yet", not "never" — it must survive.
    const note = makeDoc({
      externalId: "note-1",
      sourceId: SourceId("obsidian:vault"),
      metadata: { extra: { links: ["Quarterly plan"] } },
    });
    upsertDocuments(db, [note]);
    const noteId = getDocId(db, "note-1");
    processDocumentLinks(
      db,
      noteId,
      note.content,
      note.metadata,
      String(note.sourceId),
      note.externalId,
      null,
    );

    reconcile();
    expect(edgesFrom(noteId, "references")).toEqual([{ target: null }]);
  });
});
