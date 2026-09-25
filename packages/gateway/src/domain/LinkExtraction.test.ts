// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { resetKnownUrlPatterns, setKnownUrlPatterns } from "../known-url-patterns.js";
import { collectorRosterSnapshot } from "../collector-declaration-roster.js";
import { beginLinkDeclarationUpdate, finishLinkDeclarationUpdate } from "../data/list-revisions.js";
import { resetUrlCanonicalizers, setUrlCanonicalizers } from "../url-canonicalizers.js";
import { extractLinksFromDocs } from "./LinkExtraction-cpu.js";
import {
  extractLinksForBatch,
  fetchLinksForBatch,
  processDocumentLinks,
  type ExtractedLinkBatchEntry,
  LINK_APPLY_CHUNK_SIZE,
  resolveExtractedLinks,
  upsertExtractedLinksBatch,
  withResolvedTargets,
} from "./LinkExtraction.js";
import { linkExtractionInputDigest } from "./LinkExtractionInput.js";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  resetKnownUrlPatterns();
  resetUrlCanonicalizers();
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

// Phone fixtures use the NANP fiction block (555-0100..555-0199) inside a
// real area code. Extraction validates numbers, so a number whose AREA code
// is 555 — or one from a reserved range a carrier will never assign, like
// Ofcom's +44 7700 900xxx — is rejected and yields no `shares-phone` link
// at all, which reads as a broken test rather than a bad fixture.

function seedDoc(
  id: string,
  content: string,
  sourceId = "apple-call-log:test@icloud.example",
): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'apple', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(id, sourceId, id, `Title ${id}`, content, `h-${id}`, NOW, NOW, NOW, NOW);
}

function sharesPhoneRows(docId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM document_links WHERE source_doc_id = ? AND link_type = 'shares-phone'")
    .all(docId) as Array<Record<string, unknown>>;
}

function countLinks(docId: string): number {
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ?")
      .get(docId)?.n ?? 0
  );
}

function isExtracted(docId: string): boolean {
  return (
    db
      .prepare<
        [string],
        { t: string | null }
      >("SELECT links_extracted_at AS t FROM documents WHERE id = ?")
      .get(docId)?.t !== null
  );
}

describe("processDocumentLinks — shares-phone re-extraction", () => {
  test("re-extraction removes a shares-phone link whose phone is no longer in content", () => {
    seedDoc("day-1", "Call log: talked to +1 415 555 0142 for 12m.");
    processDocumentLinks(
      db,
      "day-1",
      "Call log: talked to +1 415 555 0142 for 12m.",
      undefined,
      "apple-call-log:test@icloud.example",
      "day-1",
      null,
    );
    expect(sharesPhoneRows("day-1")).toHaveLength(1);

    // Re-extraction with different content (e.g. the day's peer changed) —
    // the stale phone mention must be swept, not left dangling forever.
    const newContent = "Call log: talked to +44 20 7123 4567 instead.";
    db.prepare("UPDATE documents SET content = ? WHERE id = ?").run(newContent, "day-1");
    processDocumentLinks(
      db,
      "day-1",
      newContent,
      undefined,
      "apple-call-log:test@icloud.example",
      "day-1",
      null,
    );

    const rows = sharesPhoneRows("day-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].normalized_target).toBe("+442071234567");
  });

  test("re-extraction with unchanged content leaves the shares-phone link resolved", () => {
    seedDoc("webpage-a", "Contact us at +1 415 555 0142.");
    seedDoc("day-1", "Call log: talked to +1 415 555 0142 for 12m.");

    processDocumentLinks(
      db,
      "webpage-a",
      "Contact us at +1 415 555 0142.",
      undefined,
      "web:pages",
      "webpage-a",
      null,
    );
    processDocumentLinks(
      db,
      "day-1",
      "Call log: talked to +1 415 555 0142 for 12m.",
      undefined,
      "apple-call-log:test@icloud.example",
      "day-1",
      null,
    );
    expect(sharesPhoneRows("day-1")[0].target_doc_id).toBe("webpage-a");

    // Re-extract "day-1" again with the SAME content — the resolved edge
    // must survive the delete-then-reinsert cycle, not transiently or
    // permanently drop its target_doc_id.
    processDocumentLinks(
      db,
      "day-1",
      "Call log: talked to +1 415 555 0142 for 12m.",
      undefined,
      "apple-call-log:test@icloud.example",
      "day-1",
      null,
    );
    const rows = sharesPhoneRows("day-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_doc_id).toBe("webpage-a");
  });
});

describe("extractLinksForBatch — shares-phone within one batch", () => {
  test("a later document in the batch resolves to the batch's first claimant", () => {
    // Neither document has any `document_links` row yet, so neither can be
    // found by a lookup against the table. The batch's own claim map is the
    // only thing that can pair them before the periodic reconcile runs.
    seedDoc("day-1", "Call log: talked to +1 415 555 0142 for 12m.");
    seedDoc("day-2", "Call log: called +1 415 555 0142 back.");

    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    upsertExtractedLinksBatch(db, batch);

    // Directional by design: the claimant stays open, the later one points
    // at it. `document_links` allows one target per (source, type, target).
    expect(sharesPhoneRows("day-2")[0].target_doc_id).toBe("day-1");
    expect(sharesPhoneRows("day-1")[0].target_doc_id).toBeNull();
  });

  test("a document does not resolve its own phone mention to itself", () => {
    seedDoc("day-1", "Call log: +1 415 555 0142 rang twice; +1 415 555 0142 again.");

    const batch = extractLinksForBatch(db, 10, [], [], true, [], true);
    upsertExtractedLinksBatch(db, batch);

    const rows = sharesPhoneRows("day-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_doc_id).toBeNull();
  });
});

describe("upsertExtractedLinksBatch — preemption forward progress", () => {
  test("replacement deletion yields after bounded writer chunks", () => {
    seedDoc("many-old-links", "Replacement body", "notion:user@example.com");
    const insert = db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES (?, 'url', ?, ?, ?)`,
    );
    const oldCount = LINK_APPLY_CHUNK_SIZE * 2 + 17;
    for (let i = 0; i < oldCount; i += 1) {
      const url = `https://old.example.com/${i}`;
      insert.run("many-old-links", url, url, NOW);
    }

    let remaining: ExtractedLinkBatchEntry[] = [
      {
        docId: "many-old-links",
        contentHash: "h-many-old-links",
        sourceId: "notion:user@example.com",
        inputDigest: linkExtractionInputDigest({
          source_id: "notion:user@example.com",
          external_id: "many-old-links",
          content_hash: "h-many-old-links",
          metadata: "{}",
          extracted_content_hash: null,
        }),
        links: [],
      },
    ];
    let previousCount = countLinks("many-old-links");
    let attempts = 0;
    while (remaining.length > 0 && attempts < 10) {
      const result = upsertExtractedLinksBatch(db, remaining, {
        token: { requested: () => true },
      });
      const nextCount = countLinks("many-old-links");
      // One invocation may delete at most one bounded chunk before honoring
      // preemption. This includes DELETE trigger work on the single writer.
      expect(previousCount - nextCount).toBeLessThanOrEqual(LINK_APPLY_CHUNK_SIZE);
      previousCount = nextCount;
      remaining = result.remaining;
      attempts += 1;
    }

    expect(attempts).toBeGreaterThan(2);
    expect(remaining).toHaveLength(0);
    expect(countLinks("many-old-links")).toBe(0);
    expect(isExtracted("many-old-links")).toBe(true);
  });

  /**
   * A document whose links exceed one apply chunk, preempted on every chunk
   * boundary. Without a resume point each attempt would restart from the
   * delete and the document could never finish; with one, repeated attempts
   * advance a chunk at a time until it does.
   */
  test("a document interrupted mid-way resumes instead of restarting", () => {
    const urls = Array.from(
      { length: 130 },
      (_, i) => `https://example.com/page-${String(i).padStart(3, "0")}`,
    );
    seedDoc("linky", `Links: ${urls.join(" ")}`, "notion:user@example.com");
    // Give every url a target so none is dropped by the unresolvable-url gate.
    for (const [i, url] of urls.entries()) {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url, links_extracted_at)
         VALUES (?, 'notion', 'notion:user@example.com', ?, ?, '', ?, '{}', ?, ?, ?, ?, ?, ?)`,
      ).run(`t-${i}`, `t-${i}`, `T ${i}`, `h-t-${i}`, NOW, NOW, NOW, NOW, url, NOW);
    }

    // Always-preempting token: every chunk boundary yields.
    const token = { requested: () => true };
    let entries = extractLinksForBatch(db, 10, [], [], true, [], true).filter(
      (e) => e.docId === "linky",
    );
    expect(entries[0].links.length).toBe(urls.length);

    const attempts: number[] = [];
    for (let i = 0; i < 20 && entries.length > 0; i += 1) {
      const before = countLinks("linky");
      // Fed back the way the writer runner feeds it: the unfinished work
      // returned by one call is the argument to the next.
      const result = upsertExtractedLinksBatch(db, entries, { token });
      const after = countLinks("linky");
      attempts.push(after);
      // Every attempt must add rows — never re-do the same chunk forever.
      expect(after).toBeGreaterThan(before);
      if (isExtracted("linky")) break;
      entries = result.remaining;
    }

    expect(isExtracted("linky")).toBe(true);
    expect(countLinks("linky")).toBe(urls.length);
    // It genuinely took several passes — otherwise the test proves nothing.
    expect(attempts.length).toBeGreaterThan(1);
  });
  test("an interrupted document does not swallow the rest of its batch", () => {
    // `remaining` is the batch's continuation, so the interrupted document
    // has to come back WITH the documents queued behind it. Returning the
    // resume entry alone would silently drop them: they stay unmarked, so
    // the next tick re-fetches and redoes them — correct, but the batch's
    // work is thrown away every time a preempt lands mid-document.
    const urls = Array.from(
      { length: LINK_APPLY_CHUNK_SIZE + 10 },
      (_, i) => `https://example.com/wide-${String(i).padStart(4, "0")}`,
    );
    seedDoc("wide", `Links: ${urls.join(" ")}`, "notion:user@example.com");
    seedDoc("after-1", "Nothing to see", "notion:user@example.com");
    seedDoc("after-2", "Nothing here either", "notion:user@example.com");

    setKnownUrlPatterns("test", [{ regex: "example\\.com/wide-" }]);
    const entries = extractLinksForBatch(db, 10, [], [], true, ["example\\.com/wide-"], true);
    const wideAt = entries.findIndex((e) => e.docId === "wide");
    expect(wideAt, "the link-heavy document must be in the batch").toBeGreaterThanOrEqual(0);
    // Order it first so there is definitely a tail behind it.
    const ordered = [entries[wideAt], ...entries.filter((_, i) => i !== wideAt)];

    // Yield at the first chunk boundary inside the first document, which
    // is the case that has to carry both a resume offset and a tail.
    const result = upsertExtractedLinksBatch(db, ordered, {
      token: { requested: () => true },
    });

    expect(result.remaining.length).toBe(ordered.length);
    expect(result.remaining[0].docId).toBe("wide");
    expect(result.remaining[0].appliedLinks).toBeGreaterThan(0);
    // The tail comes back untouched — same documents, same order, and with
    // no resume offset, since none of them was started.
    expect(result.remaining.slice(1).map((e) => e.docId)).toEqual(
      ordered.slice(1).map((e) => e.docId),
    );
    for (const entry of result.remaining.slice(1)) {
      expect(entry.appliedLinks).toBeUndefined();
    }
  });
});

/**
 * The exact shape production runs: documents fetched by the io worker, links
 * extracted by the CPU worker (which has no database handle and therefore
 * resolves nothing), targets found by the io worker, and only then the write.
 *
 * Driving `extractLinksForBatch` instead would test a path production never
 * takes — it does its own fetching and extraction, so a batch that reached
 * the writer with no targets at all would still look resolved here.
 */
describe("link extraction across the io → cpu → io → writer pipeline", () => {
  function runPipeline(batchSize = 10): void {
    const docs = fetchLinksForBatch(db, batchSize);
    // The CPU worker's half, called exactly as the task calls it: one
    // document per invocation, no database in reach.
    const extracted = docs.flatMap((doc) => extractLinksFromDocs([doc]));
    for (const entry of extracted) {
      expect(entry.resolvedTargets, "the cpu phase must not resolve anything").toBeUndefined();
    }
    upsertExtractedLinksBatch(
      db,
      withResolvedTargets(extracted, resolveExtractedLinks(db, extracted, [])),
    );
  }

  test("a url link to an already-ingested document arrives resolved", () => {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url, links_extracted_at)
       VALUES ('target', 'notion', 'notion:user@example.com', 'target', 'Target', 'body', 'h-target', '{}', ?, ?, ?, ?, 'https://pages.example.com/plan', ?)`,
    ).run(NOW, NOW, NOW, NOW, NOW);
    seedDoc("src", "See https://pages.example.com/plan", "notion:user@example.com");

    runPipeline();

    const row = db
      .prepare<
        [string],
        { target_doc_id: string | null }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .get("src");
    expect(row?.target_doc_id).toBe("target");
  });

  test("reuses known-source matchers across more resolution batches than native RE2 can rebuild", () => {
    const knownPatterns = Array.from(
      { length: 8 },
      (_, index) => `reviews[.]example/items/${index}/([0-9]+)`,
    );

    for (let batch = 0; batch < 1_500; batch += 1) {
      expect(resolveExtractedLinks(db, [], [], [], true, knownPatterns, true)).toEqual([]);
    }
  });

  test("a url link whose target is ingested but matches no id pattern is kept, not dropped", () => {
    // The unresolvable-url gate drops a url that resolves to nothing AND
    // could never resolve. A link that resolves right now must survive it —
    // dropping the row is unrecoverable, since nothing later re-extracts it.
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url, links_extracted_at)
       VALUES ('page', 'web', 'web:reader', 'page', 'Page', 'body', 'h-page', '{}', ?, ?, ?, ?, 'https://notes.example.org/a-plain-page', ?)`,
    ).run(NOW, NOW, NOW, NOW, NOW);
    seedDoc("citer", "As set out in https://notes.example.org/a-plain-page", "web:reader");

    runPipeline();

    const rows = db
      .prepare<
        [string],
        { target_doc_id: string | null }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'url'")
      .all("citer");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_doc_id).toBe("page");
  });

  test("a same-source references link arrives resolved", () => {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, links_extracted_at)
       VALUES ('note-b', 'obsidian', 'obsidian:vault', 'Roadmap', 'Roadmap', 'body', 'h-note-b', '{}', ?, ?, ?, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('note-a', 'obsidian', 'obsidian:vault', 'note-a', 'Note A', 'body', 'h-note-a', ?, ?, ?, ?, ?)`,
    ).run(JSON.stringify({ extra: { links: ["Roadmap"] } }), NOW, NOW, NOW, NOW);

    runPipeline();

    const row = db
      .prepare<
        [string],
        { target_doc_id: string | null }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ? AND link_type = 'references'")
      .get("note-a");
    expect(row?.target_doc_id).toBe("note-b");
  });

  test("a metadata-only update invalidates a fetched extraction batch", () => {
    db.prepare(
      "INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at) VALUES ('race-doc', 'obsidian', 'obsidian:vault', 'race-doc', 'Race', 'body', 'h-race', ?, ?, ?, ?, ?)",
    ).run(JSON.stringify({ extra: { links: ["Old target"] } }), NOW, NOW, NOW, NOW);
    const fetched = fetchLinksForBatch(db, 10).filter((row) => row.id === "race-doc");
    const extracted = extractLinksFromDocs(fetched);

    db.prepare("UPDATE documents SET metadata = ?, updated_at = ? WHERE id = 'race-doc'").run(
      JSON.stringify({ extra: { links: ["New target"] } }),
      NOW,
    );
    const result = upsertExtractedLinksBatch(db, extracted);

    expect(result.skipped).toBe(1);
    expect(countLinks("race-doc")).toBe(0);
    expect(isExtracted("race-doc")).toBe(false);
  });

  test("an extracted-content change invalidates a fetched extraction batch", () => {
    seedDoc("extracted-race", "See https://before.example/item", "notion:maya@example.com");
    const extracted = extractLinksFromDocs(
      fetchLinksForBatch(db, 10).filter((row) => row.id === "extracted-race"),
    );

    db.prepare("UPDATE documents SET extracted_content_hash = ? WHERE id = 'extracted-race'").run(
      "new-extracted-content-hash",
    );
    const result = upsertExtractedLinksBatch(db, extracted);

    expect(result.skipped).toBe(1);
    expect(countLinks("extracted-race")).toBe(0);
    expect(isExtracted("extracted-race")).toBe(false);
  });

  test("reuses production-shaped canonicalizers across a large extraction backfill", () => {
    const canonicalizers = [
      {
        hosts: ["reviews.example"],
        rules: Array.from({ length: 8 }, (_, index) => ({
          match: `[?&]campaign${index}=[^#&]*`,
          replacement: "",
        })),
      },
    ];
    const row = {
      id: "canonicalizer-backfill",
      source_id: "notes:maya@example.com",
      external_id: "canonicalizer-backfill",
      content: "See https://reviews.example/item?campaign7=autumn",
      content_hash: "content-hash",
      metadata: "{}",
      extracted_content_hash: null,
    };

    // The scheduler invokes this CPU seam once per document. Recompiling all
    // eight native matchers for every call exhausts RE2-WASM during a backfill.
    for (let index = 0; index < 1_500; index += 1) {
      const [entry] = extractLinksFromDocs([row], canonicalizers);
      expect(entry.links[0]?.normalizedTarget).toBe("https://reviews.example/item");
    }
  });

  test("an unrelated updated_at change does not invalidate an otherwise exact extraction input", () => {
    seedDoc("timestamp-only", "No links", "notion:maya@example.com");
    const extracted = extractLinksFromDocs(
      fetchLinksForBatch(db, 10).filter((row) => row.id === "timestamp-only"),
    );

    db.prepare("UPDATE documents SET updated_at = ? WHERE id = 'timestamp-only'").run(
      "2026-01-01T00:00:01Z",
    );
    const result = upsertExtractedLinksBatch(db, extracted);

    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(isExtracted("timestamp-only")).toBe(true);
  });

  test("a newly paired collector invalidates a roster-bound writer batch", () => {
    seedDoc("roster-race", "No links", "notion:maya@example.com");
    const extracted = extractLinksFromDocs(
      fetchLinksForBatch(db, 10).filter((row) => row.id === "roster-race"),
    ).map((entry) => ({
      ...entry,
      expectedCollectorRosterRevision: collectorRosterSnapshot(db).revision,
    }));
    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('collector-race', 'Collector race', 'collector', 1)",
    ).run();

    const result = upsertExtractedLinksBatch(db, extracted);
    expect(result.skipped).toBe(1);
    expect(isExtracted("roster-race")).toBe(false);
  });

  test("a same-collector known-pattern replacement invalidates an extraction batch", () => {
    seedDoc("pattern-race", "See https://pattern.example/item", "notion:maya@example.com");
    const extracted = extractLinksFromDocs(
      fetchLinksForBatch(db, 10).filter((row) => row.id === "pattern-race"),
    ).map((entry) => ({
      ...entry,
      expectedCollectorRosterRevision: collectorRosterSnapshot(db).revision,
    }));
    beginLinkDeclarationUpdate(db);
    setKnownUrlPatterns("test", [{ regex: "pattern[.]example/items/([0-9]+)" }]);
    finishLinkDeclarationUpdate(db);

    const result = upsertExtractedLinksBatch(db, extracted);
    expect(result.skipped).toBe(1);
    expect(isExtracted("pattern-race")).toBe(false);
  });

  test("a canonicalizer replacement invalidates an extraction batch", () => {
    seedDoc(
      "canonicalizer-race",
      "See https://canon.example/item?ref=old",
      "notion:maya@example.com",
    );
    const extracted = extractLinksFromDocs(
      fetchLinksForBatch(db, 10).filter((row) => row.id === "canonicalizer-race"),
    ).map((entry) => ({
      ...entry,
      expectedCollectorRosterRevision: collectorRosterSnapshot(db).revision,
    }));
    beginLinkDeclarationUpdate(db);
    setUrlCanonicalizers([
      { hosts: ["canon.example"], rules: [{ match: "[?]ref=.*$", replacement: "" }] },
    ]);
    finishLinkDeclarationUpdate(db);

    const result = upsertExtractedLinksBatch(db, extracted);
    expect(result.skipped).toBe(1);
    expect(isExtracted("canonicalizer-race")).toBe(false);
  });

  test("two documents sharing a phone number pair within one batch", () => {
    seedDoc("day-1", "Call log: talked to +1 415 555 0142 for 12m.");
    seedDoc("day-2", "Call log: called +1 415 555 0142 back.");

    runPipeline();

    expect(sharesPhoneRows("day-2")[0].target_doc_id).toBe("day-1");
  });
});
