// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { beginLinkDeclarationUpdate, finishLinkDeclarationUpdate } from "../data/list-revisions.js";
import { getRecanonicalizeFingerprint } from "../data/repositories/CanonicalizationStateRepository.js";
import { computeUrlOwnershipRepairs } from "./UrlOwnershipReconciliation.js";
import {
  SourceUrlRecanonicalizationService,
  applySourceUrlRecanonicalizationPage,
  fingerprintCanonicalizerSpecs,
  finishSourceUrlRecanonicalization,
  planSourceUrlRecanonicalization,
} from "./SourceUrlRecanonicalization.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";

describe("source URL recanonicalization", () => {
  let path: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    path = `/tmp/omnesis-source-url-recanonicalization-${randomUUID()}.db`;
    db = createDatabase(path);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  });

  const specs = (rules: UrlCanonicalizerSpec["rules"]): UrlCanonicalizerSpec[] => [
    { hosts: ["example.com"], rules },
  ];

  const doc = (index: number): DocumentInput => ({
    providerId: ProviderId("synthetic-provider"),
    sourceId: SourceId("synthetic-source"),
    externalId: `document-${index}`,
    title: `Synthetic document ${index}`,
    content: "Invented content.",
    contentHash: `hash-${index}`,
    metadata: { sourceUrl: `https://example.com/legacy/${index}` },
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });

  test("fingerprints ignore spec/host set order but preserve first-match rule order", () => {
    const first = {
      match: "^https://example[.]com/(.*)$",
      replacement: "https://example.com/first/$1",
    };
    const second = {
      match: "^https://example[.]com/(.*)$",
      replacement: "https://example.com/second/$1",
    };
    const a = [
      { hosts: ["example.org", "example.com"], rules: [first, second] },
      { hosts: ["other.example"], rules: [] },
    ];
    const sameSetOrderChanged = [
      { hosts: ["other.example"], rules: [] },
      { hosts: ["example.com", "example.org"], rules: [first, second] },
    ];
    const rulesReordered = [
      { hosts: ["example.com", "example.org"], rules: [second, first] },
      { hosts: ["other.example"], rules: [] },
    ];

    expect(fingerprintCanonicalizerSpecs(a)).toBe(
      fingerprintCanonicalizerSpecs(sameSetOrderChanged),
    );
    expect(fingerprintCanonicalizerSpecs(a)).not.toBe(
      fingerprintCanonicalizerSpecs(rulesReordered),
    );
  });

  test("reordering first-match rules forces a rescan and changes the canonical URL", async () => {
    upsertDocuments(db, [doc(7)]);
    const first = {
      match: "^https://example[.]com/(.*)$",
      replacement: "https://example.com/first/$1",
    };
    const second = {
      match: "^https://example[.]com/(.*)$",
      replacement: "https://example.com/second/$1",
    };
    const service = new SourceUrlRecanonicalizationService({
      plan: async (input, cursor) => planSourceUrlRecanonicalization(db, input, cursor),
      apply: async (cursor, mutations) =>
        applySourceUrlRecanonicalizationPage(db, cursor, mutations),
      finish: async (cursor) => finishSourceUrlRecanonicalization(db, cursor),
    });

    await expect(service.recompute(specs([first, second]))).resolves.toEqual({
      scanned: 1,
      touched: 1,
    });
    expect(
      db.prepare("SELECT source_url FROM documents WHERE external_id = 'document-7'").pluck().get(),
    ).toBe("https://example.com/first/legacy/7");

    await expect(service.recompute(specs([second, first]))).resolves.toEqual({
      scanned: 1,
      touched: 1,
    });
    expect(
      db.prepare("SELECT source_url FROM documents WHERE external_id = 'document-7'").pluck().get(),
    ).toBe("https://example.com/second/legacy/7");
  });

  describe("url edges resolved to a recanonicalized document", () => {
    const DETAILS_URL = "https://example.com/notes/42/details";
    const CANONICAL_URL = "https://example.com/notes/42";
    const stripDetails = specs([
      { match: "^(https://example[.]com/notes/[0-9]+)/details$", replacement: "$1" },
    ]);

    const docId = (externalId: string): string =>
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(externalId)!.id;

    const capture = (): DocumentInput => ({
      providerId: ProviderId("web"),
      sourceId: SourceId("web"),
      externalId: "capture-42",
      title: "Saved page",
      content: "Invented capture content.",
      contentHash: "hash-capture-42",
      metadata: { sourceUrl: DETAILS_URL },
      sourceCreatedAt: "2026-01-01T00:00:00Z",
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });

    const citingDoc = (): DocumentInput => ({
      providerId: ProviderId("synthetic-provider"),
      sourceId: SourceId("synthetic-source"),
      externalId: "message-42",
      title: "Weekly digest",
      content: `Have a look at ${DETAILS_URL}`,
      contentHash: "hash-message-42",
      metadata: {},
      sourceCreatedAt: "2026-01-01T00:00:00Z",
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });

    /** The url edge link extraction wrote before the canonicalizer existed. */
    function linkTo(target: string, normalizedTarget: string): void {
      db.prepare(
        `INSERT INTO document_links
           (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at)
         VALUES (?, 'url', ?, ?, ?, ?, ?)`,
      ).run(
        docId("message-42"),
        DETAILS_URL,
        normalizedTarget,
        target,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    }

    async function recanonicalize(): Promise<void> {
      const service = new SourceUrlRecanonicalizationService({
        plan: async (input, cursor) => planSourceUrlRecanonicalization(db, input, cursor),
        apply: async (cursor, mutations) =>
          applySourceUrlRecanonicalizationPage(db, cursor, mutations),
        finish: async (cursor) => finishSourceUrlRecanonicalization(db, cursor),
      });
      await service.recompute(stripDetails);
    }

    const storedTargets = (): Array<{ normalized_target: string; target_doc_id: string | null }> =>
      db
        .prepare<
          [],
          { normalized_target: string; target_doc_id: string | null }
        >("SELECT normalized_target, target_doc_id FROM document_links ORDER BY id")
        .all();

    test("moves the edge's canonical form with the document's, so ownership repair can still reach it", async () => {
      upsertDocuments(db, [capture(), citingDoc()]);
      expect(
        db
          .prepare("SELECT source_url FROM documents WHERE external_id = 'capture-42'")
          .pluck()
          .get(),
      ).toBe(DETAILS_URL);
      linkTo(docId("capture-42"), DETAILS_URL);

      await recanonicalize();

      expect(
        db
          .prepare("SELECT source_url FROM documents WHERE external_id = 'capture-42'")
          .pluck()
          .get(),
      ).toBe(CANONICAL_URL);
      expect(storedTargets()).toEqual([
        { normalized_target: CANONICAL_URL, target_doc_id: docId("capture-42") },
      ]);

      // The owning source is added afterwards and claims the canonical URL. The
      // ownership repair only retargets an edge whose stored target text still
      // matches its target's `source_url`, so a stale edge would be skipped for
      // the life of the install.
      upsertDocuments(db, [
        {
          providerId: ProviderId("notes-provider"),
          sourceId: SourceId("notes-source"),
          externalId: "note-42",
          title: "Note 42",
          content: "Invented note content.",
          contentHash: "hash-note-42",
          metadata: { sourceUrl: CANONICAL_URL },
          sourceCreatedAt: "2026-01-02T00:00:00Z",
          sourceUpdatedAt: "2026-01-02T00:00:00Z",
        },
      ]);

      const plan = computeUrlOwnershipRepairs(db, 50, ["web"], [], true);
      expect(plan.retargets).toEqual([
        {
          linkId: 1,
          previousTargetDocId: docId("capture-42"),
          targetDocId: docId("note-42"),
          normalizedTarget: CANONICAL_URL,
          connectRepresentations: true,
        },
      ]);
    });

    test("drops the retired edge when the same document already holds the canonical one", async () => {
      upsertDocuments(db, [capture(), citingDoc()]);
      linkTo(docId("capture-42"), DETAILS_URL);
      // An additive-retention source never deletes on re-extraction, so the same
      // document can end up holding both flavours of one URL.
      linkTo(docId("capture-42"), CANONICAL_URL);

      await recanonicalize();

      expect(storedTargets()).toEqual([
        { normalized_target: CANONICAL_URL, target_doc_id: docId("capture-42") },
      ]);
    });

    test("leaves an edge resolved by url-pattern rather than by source_url alone", async () => {
      upsertDocuments(db, [capture(), citingDoc()]);
      // Resolved through strategy 2 (url-pattern → external_id): the target is
      // the capture, but the stored text was never its `source_url`.
      linkTo(docId("capture-42"), "https://example.com/notes/42/raw");

      await recanonicalize();

      expect(storedTargets()).toEqual([
        {
          normalized_target: "https://example.com/notes/42/raw",
          target_doc_id: docId("capture-42"),
        },
      ]);
    });
  });

  test("writer apply is capped, OCC guarded, and abandons a changed declaration", () => {
    upsertDocuments(db, [doc(1)]);
    const declaration = specs([
      {
        match: "^https://example[.]com/legacy/([0-9]+)$",
        replacement: "https://example.com/items/$1",
      },
    ]);
    const plan = planSourceUrlRecanonicalization(db, declaration);
    expect(plan.mutations).toHaveLength(1);

    db.prepare("UPDATE documents SET updated_at = ? WHERE external_id = ?").run(
      "2030-01-01T00:00:00.000Z",
      "document-1",
    );
    expect(applySourceUrlRecanonicalizationPage(db, plan.cursor, plan.mutations)).toEqual({
      touched: 0,
      abandoned: false,
    });

    beginLinkDeclarationUpdate(db);
    expect(applySourceUrlRecanonicalizationPage(db, plan.cursor, plan.mutations)).toEqual({
      touched: 0,
      abandoned: true,
    });
    expect(finishSourceUrlRecanonicalization(db, plan.cursor)).toBe(false);
    finishLinkDeclarationUpdate(db);
  });

  test("a failed later page never stamps a half-complete fingerprint", async () => {
    upsertDocuments(
      db,
      Array.from({ length: 51 }, (_, index) => doc(index)),
    );
    const declaration = specs([
      {
        match: "^https://example[.]com/legacy/([0-9]+)$",
        replacement: "https://example.com/items/$1",
      },
    ]);
    let applyCalls = 0;
    const service = new SourceUrlRecanonicalizationService({
      plan: async (input, cursor) => planSourceUrlRecanonicalization(db, input, cursor),
      apply: async (cursor, mutations) => {
        applyCalls += 1;
        if (applyCalls === 2) throw new Error("injected second-page failure");
        return applySourceUrlRecanonicalizationPage(db, cursor, mutations);
      },
      finish: async (cursor) => finishSourceUrlRecanonicalization(db, cursor),
    });

    await expect(service.recompute(declaration)).rejects.toThrow("injected second-page failure");
    expect(getRecanonicalizeFingerprint(db)).toBeNull();
  });

  test("reuses compiled canonicalizers while advancing through bounded pages", () => {
    upsertDocuments(
      db,
      Array.from({ length: 101 }, (_, index) => doc(index)),
    );
    const declaration = specs([
      ...Array.from({ length: 7 }, (_, index) => ({
        match: `[?&]route${index}=[^#&]*`,
        replacement: "",
      })),
      { match: "/legacy/([0-9]+)$", replacement: "/items/$1" },
    ]);

    const first = planSourceUrlRecanonicalization(db, declaration);
    const second = planSourceUrlRecanonicalization(db, declaration, first.cursor);
    const third = planSourceUrlRecanonicalization(db, declaration, second.cursor);

    expect(first.cursor.scanned).toBe(50);
    expect(second.cursor.scanned).toBe(100);
    expect(third.cursor.scanned).toBe(101);
    expect(third.done).toBe(true);
  });

  test("reports a declaration change at final commit as abandonment, not success", async () => {
    const service = new SourceUrlRecanonicalizationService({
      plan: async () => ({
        cursor: {
          fingerprint: "stale-generation",
          expectedDeclarationRevision: 2,
          cycleMaxRowid: 0,
          afterRowid: 0,
          scanned: 0,
        },
        mutations: [],
        done: true,
        alreadyCurrent: false,
        abandoned: false,
      }),
      apply: async () => ({ touched: 0, abandoned: false }),
      finish: async () => false,
    });

    await expect(service.recompute(specs([]))).rejects.toThrow(
      "source URL recanonicalization abandoned after declarations changed",
    );
  });

  test("serializes whole recomputes rather than interleaving declaration generations", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = new SourceUrlRecanonicalizationService({
      plan: async (input) => {
        const label = input[0]!.rules[0]!.replacement;
        started.push(label);
        if (label === "first") {
          markFirstStarted();
          await firstMayFinish;
        }
        return {
          cursor: {
            fingerprint: label,
            expectedDeclarationRevision: 0,
            cycleMaxRowid: 0,
            afterRowid: 0,
            scanned: 0,
          },
          mutations: [],
          done: true,
          alreadyCurrent: true,
          abandoned: false,
        };
      },
      apply: async () => ({ touched: 0, abandoned: false }),
      finish: async () => true,
    });
    const generation = (label: string): UrlCanonicalizerSpec[] =>
      specs([{ match: "^unused$", replacement: label }]);

    const first = service.recompute(generation("first"));
    await firstStarted;
    const second = service.recompute(generation("second"));
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { scanned: 0, touched: 0 },
      { scanned: 0, touched: 0 },
    ]);
    expect(started).toEqual(["first", "second"]);
  });
});
