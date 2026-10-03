// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractLinks } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { extractLinksFromDocs } from "./LinkExtraction-cpu.js";
import {
  fetchLinksForBatch,
  processDocumentLinks,
  resolveExtractedLinks,
  upsertExtractedLinksBatch,
  withResolvedTargets,
} from "./LinkExtraction.js";
import { computeLinkResolutions, upsertLinkResolutions } from "./LinkGraphService.js";
import { hasRetainedUrlMetadata, retainAttachedUrls } from "./RetainedLinkUrls.js";

test("only explicit valid HTTP URLs receive retention", () => {
  const links = extractLinks("https://example.org/attached https://example.org/incidental");
  const result = retainAttachedUrls(links, {
    extra: {
      retainedLinkUrls: [
        null,
        "broken",
        "file:///tmp/example",
        "https://example.org/attached",
        "https://example.org/absent",
      ],
    },
  });
  expect(result.find((link) => link.rawTarget.endsWith("attached"))?.metadata).toEqual({
    retainTarget: true,
  });
  expect(result.find((link) => link.rawTarget.endsWith("incidental"))?.metadata).toBeUndefined();
  expect(result).toHaveLength(3);
  expect(result.find((link) => link.rawTarget.endsWith("absent"))?.metadata).toEqual({
    retainTarget: true,
  });
  expect(hasRetainedUrlMetadata("{broken")).toBe(false);
  expect(hasRetainedUrlMetadata('{"retainTarget":"true"}')).toBe(false);
});

describe("attached page links before capture", () => {
  let dir: string;
  let db: ReturnType<typeof createDatabase>;
  const url = "https://example.org/attached";
  const content = `${url}\nhttps://example.org/incidental`;
  function note(retained = true): DocumentInput {
    return {
      providerId: ProviderId("omnesis-notes"),
      sourceId: SourceId("omnesis-notes"),
      externalId: "2026-01-15",
      title: "Notes",
      content,
      contentHash: retained ? "with-attachment" : "without-attachment",
      metadata: { extra: { retainedLinkUrls: retained ? [url] : [] } },
      sourceCreatedAt: "2026-01-15T12:00:00Z",
      sourceUpdatedAt: "2026-01-15T12:00:00Z",
    };
  }
  function docId(externalId: string): string {
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }
  function edges() {
    return db
      .prepare<
        [],
        { normalized_target: string; target_doc_id: string | null }
      >("SELECT normalized_target, target_doc_id FROM document_links WHERE link_type = 'url'")
      .all();
  }
  function extract() {
    const entries = extractLinksFromDocs(fetchLinksForBatch(db, 10));
    upsertExtractedLinksBatch(
      db,
      withResolvedTargets(entries, resolveExtractedLinks(db, entries, [], [], true, [], true)),
    );
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-attached-links-"));
    db = createDatabase(join(dir, "store.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(["cpu", "legacy"])(
    "%s path keeps only the attached page and resolves when it arrives",
    (path) => {
      const input = note();
      upsertDocuments(db, [input]);
      if (path === "cpu") extract();
      else
        processDocumentLinks(
          db,
          docId(input.externalId),
          content,
          input.metadata,
          String(input.sourceId),
          input.externalId,
        );
      expect(edges()).toEqual([{ normalized_target: url, target_doc_id: null }]);
      for (let pass = 0; pass < 3; pass++) {
        upsertLinkResolutions(db, computeLinkResolutions(db, 10, [], [], true, [], true));
        expect(edges()).toEqual([{ normalized_target: url, target_doc_id: null }]);
      }
      upsertDocuments(db, [
        {
          ...input,
          providerId: ProviderId("web"),
          sourceId: SourceId("web"),
          externalId: "page",
          title: "Attached page",
          content: "Captured page content",
          contentHash: "page",
          metadata: { documentType: "webpage", sourceUrl: url },
        },
      ]);
      upsertLinkResolutions(db, computeLinkResolutions(db, 10, [], [], true, [], true));
      expect(edges()).toEqual([{ normalized_target: url, target_doc_id: docId("page") }]);
    },
  );

  test("removing the attachment removes its retention on re-extraction", () => {
    upsertDocuments(db, [note()]);
    extract();
    expect(edges()).toHaveLength(1);
    upsertDocuments(db, [note(false)]);
    extract();
    expect(edges()).toEqual([]);
  });

  test("editing prose does not detach structured page context", () => {
    upsertDocuments(db, [note()]);
    extract();
    upsertDocuments(db, [
      { ...note(), content: "An edited thought without a visible URL", contentHash: "edited" },
    ]);
    extract();
    expect(edges()).toEqual([{ normalized_target: url, target_doc_id: null }]);
    const row = db
      .prepare<[], { provenance_kind: string }>("SELECT provenance_kind FROM document_links")
      .get();
    expect(row?.provenance_kind).toBe("source-declared");
  });

  test("a stale pruning batch cannot delete a link that became explicitly attached", () => {
    upsertDocuments(db, [note()]);
    extract();
    db.prepare("UPDATE document_links SET metadata_json = NULL").run();
    const batch = computeLinkResolutions(db, 10, [], [], true, [], true);
    expect(batch.deletableLinkIds).toHaveLength(1);
    db.prepare("UPDATE document_links SET metadata_json = ?").run('{"retainTarget":true}');
    upsertLinkResolutions(db, batch);
    expect(edges()).toEqual([{ normalized_target: url, target_doc_id: null }]);
  });
});
