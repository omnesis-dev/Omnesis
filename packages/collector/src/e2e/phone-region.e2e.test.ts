// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";

const UK_PHONE = "+447700000000";
const UNKNOWN_PHONE = "+447700000001";
const FR_PHONE = "+33639980033";
const INTERNATIONAL_PHONE = "+447700000002";
const GB_CONTEXT = { locale: "en-GB", phoneRegion: "GB", phoneRegionSource: "os" } as const;

describe("region-aware phone identity (e2e-minimal synthetic universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      ingestionContext: GB_CONTEXT,
    });
    await harness.start();

    await harness.pushDocument({
      sourceId: "synthetic-phone:test",
      providerId: "synthetic-phone:test",
      externalId: "phone-region-contact",
      documentType: "contact",
      title: "Priya Nair",
      content: "Priya Nair\nMobile: 07700 000000",
      metadata: {
        ingestionContext: GB_CONTEXT,
        people: [{ role: "contact", name: "Priya Nair", phones: [UK_PHONE] }],
      },
    });
    await waitForDb(harness, (db) => phoneAliasOwner(db, UK_PHONE) !== undefined);

    await harness.pushDocuments([
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-call",
        documentType: "call-log",
        title: "Calls",
        content: "17:50 incoming call ← 07700 000000, missed",
        metadata: {
          ingestionContext: GB_CONTEXT,
          people: [{ role: "participant", phones: [UK_PHONE] }],
        },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-email",
        documentType: "email",
        title: "A fictional signature",
        content: "Priya Nair\nM: 07700 000 000\nE: priya.nair@example.test",
        metadata: {
          ingestionContext: GB_CONTEXT,
          people: [
            { role: "sender", emails: ["sender@example.test"] },
            { role: "mentioned", phones: [UK_PHONE], allowPersonCreation: false },
          ],
        },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-bare-a",
        title: "Arbitrary prose A",
        content: "For reception call 07700 000001.",
        metadata: {
          ingestionContext: GB_CONTEXT,
          people: [{ role: "mentioned", phones: [UNKNOWN_PHONE], allowPersonCreation: false }],
        },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-bare-b",
        title: "Arbitrary prose B",
        content: "The footer also says 07700 000001.",
        metadata: {
          ingestionContext: GB_CONTEXT,
          people: [{ role: "mentioned", phones: [UNKNOWN_PHONE], allowPersonCreation: false }],
        },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-fr",
        title: "French regional parsing",
        content: "Téléphone : 06 39 98 00 33",
        metadata: { ingestionContext: { locale: "fr-FR", phoneRegion: "FR" } },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-international",
        title: "International parsing",
        content: "International: +44 7700 000002",
        metadata: { ingestionContext: { locale: "en-US", phoneRegion: "US" } },
      },
      {
        sourceId: "synthetic-phone:test",
        providerId: "synthetic-phone:test",
        externalId: "phone-region-invalid",
        title: "Invalid phone",
        content: "Reference: 1234",
        metadata: { ingestionContext: GB_CONTEXT },
      },
    ]);

    // While the full fictional universe syncs, the gateway's real background
    // workers have enough time to resolve the deliberately early phone docs.
    await harness.syncAllSources();

    // Gate on every target the tests below read, not on one of them as a
    // proxy for the rest: the extraction pipeline writes a document's links
    // when it reaches that document, so one phone being linked says nothing
    // about another's. Waiting on the union is what makes a read here a
    // statement about the pipeline's result rather than about its order.
    await waitForDb(
      harness,
      (db) => {
        const linked = (target: string): number =>
          db
            .prepare<
              [string],
              { n: number }
            >("SELECT COUNT(*) AS n FROM document_links WHERE link_type = 'shares-phone' AND normalized_target = ?")
            .get(target)?.n ?? 0;
        return (
          linked(UNKNOWN_PHONE) >= 2 &&
          linked(UK_PHONE) >= 3 &&
          linked(FR_PHONE) >= 1 &&
          linked(INTERNATIONAL_PHONE) >= 1
        );
      },
      90_000,
    );
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("collector persists its OS-derived region on synthetic-universe documents", () => {
    withDb(harness, (db) => {
      const row = db
        .prepare<
          [string],
          { metadata: string }
        >("SELECT metadata FROM documents WHERE external_id = ? LIMIT 1")
        .get("synth-apple-contact-001");
      expect(JSON.parse(row!.metadata).ingestionContext).toEqual(GB_CONTEXT);
    });
  });

  test("contact, call, and email phone mention resolve to one known person", () => {
    withDb(harness, (db) => {
      const owner = phoneAliasOwner(db, UK_PHONE);
      expect(owner).toBeDefined();
      const docs = db
        .prepare<[string], { external_id: string }>(
          `SELECT d.external_id
             FROM document_people dp JOIN documents d ON d.id = dp.document_id
            WHERE dp.person_id = ? AND d.external_id LIKE 'phone-region-%'
            ORDER BY d.external_id`,
        )
        .all(owner!);
      expect(docs.map((row) => row.external_id)).toEqual([
        "phone-region-call",
        "phone-region-contact",
        "phone-region-email",
      ]);
    });
  });

  // Known flaky: #1765 — these document_links reads race the link-backfill pipeline.
  test("national-format references create normalized, resolved shares-phone edges", () => {
    withDb(harness, (db) => {
      const rows = db
        .prepare<
          [string],
          { normalized_target: string; target_doc_id: string | null }
        >("SELECT normalized_target, target_doc_id FROM document_links WHERE link_type = 'shares-phone' AND normalized_target = ?")
        .all(UK_PHONE);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.some((row) => row.target_doc_id !== null)).toBe(true);
    });
  });

  test("a bare phone links documents without creating a person", () => {
    withDb(harness, (db) => {
      expect(phoneAliasOwner(db, UNKNOWN_PHONE)).toBeUndefined();
      const rows = db
        .prepare<
          [string],
          { target_doc_id: string | null }
        >("SELECT target_doc_id FROM document_links WHERE link_type = 'shares-phone' AND normalized_target = ?")
        .all(UNKNOWN_PHONE);
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.target_doc_id !== null)).toBe(true);
    });
  });

  test("each document's durable region is used independently", () => {
    withDb(harness, (db) => {
      const targets = db
        .prepare<[], { normalized_target: string }>(
          `SELECT normalized_target FROM document_links
            WHERE source_doc_id IN (
              SELECT id FROM documents WHERE external_id IN
                ('phone-region-fr', 'phone-region-international')
            ) AND link_type = 'shares-phone'
            ORDER BY normalized_target`,
        )
        .all()
        .map((row) => row.normalized_target);
      expect(targets).toEqual(["+33639980033", "+447700000002"]);
    });
  });

  test("invalid short digit sequences remain unresolved", () => {
    withDb(harness, (db) => {
      const count = db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM document_links
            WHERE source_doc_id = (SELECT id FROM documents WHERE external_id = 'phone-region-invalid')
              AND link_type = 'shares-phone'`,
        )
        .get()!.n;
      expect(count).toBe(0);
    });
  });
});

function phoneAliasOwner(db: Database.Database, phone: string): string | undefined {
  return db
    .prepare<
      [string],
      { person_id: string }
    >("SELECT person_id FROM person_aliases WHERE alias_type = 'phone' AND alias = ? LIMIT 1")
    .get(phone)?.person_id;
}

function withDb<T>(harness: SyntheticE2EHarness, read: (db: Database.Database) => T): T {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

async function waitForDb(
  harness: SyntheticE2EHarness,
  predicate: (db: Database.Database) => boolean,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (withDb(harness, predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`database condition did not become true within ${timeoutMs}ms`);
}
