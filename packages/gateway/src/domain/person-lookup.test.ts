// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Golden-equality net for the extracted {@link assemblePersonLookup}.
 *
 * The pure fn is now the single source of the `lookup_people` result body,
 * shared by the main-thread fallback and the io-worker (`io.lookupPeople`). This
 * asserts it produces byte-identical output to the person port's own path for
 * `experimental` ON and OFF, so the extraction can't silently drift.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { createOpenLoop } from "../brain/storage/open-loops.js";
import { createPersonAnnotation } from "../brain/storage/person-annotations.js";
import { createGatewayPersonPort } from "../agent/ports.js";
import { assemblePersonLookup } from "./person-lookup.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-person-lookup-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertPerson(id: string, name: string, email: string, score: number): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen,
                         created_at, updated_at, interaction_score_recent)
     VALUES (?, ?, 'extracted', '2026-01-01', '2026-04-01T12:00:00Z',
             '2026-01-01', '2026-01-01', ?)`,
  ).run(id, name, score);
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
     VALUES (?, ?, 'email', ?, '2026-01-01')`,
  ).run(randomUUID(), id, email);
}

function insertDoc(personId: string, docType: string, externalId: string, sourceId: string): void {
  const metadata = JSON.stringify({ documentType: docType });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Doc', 'body', 'hash-' || ?, ?, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(externalId, sourceId, externalId, externalId, metadata);
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, 'participant')`,
  ).run(externalId, personId);
}

/** A fixture rich enough to exercise every field the assembly overlays. */
function seedRichFixture(): void {
  insertPerson("p-maya", "Maya Reeves", "maya.reeves@example.com", 0.82);
  insertDoc("p-maya", "email", "doc-e-1", "gmail:self");
  insertDoc("p-maya", "conversation", "doc-c-1", "whatsapp:self");
  insertDoc("p-maya", "event", "doc-m-1", "google-calendar:self");
  insertPerson("p-maya2", "Maya Reeves", "maya@personal.example.org", 0.2);
}

const withExperimental = (on: boolean, fn: () => void): void => {
  const prev = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = on ? "1" : "0";
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = prev;
  }
};

describe("assemblePersonLookup — golden equality with the person port", () => {
  test("experimental OFF: assembly matches the port's results exactly", async () => {
    seedRichFixture();
    await withExperimental(false, async () => {
      const port = createGatewayPersonPort(db);
      const out = await port.lookup({ query: "Maya", limit: 5 });
      const assembled = assemblePersonLookup(db, "Maya", 5, { experimental: false });
      expect(out.results).toEqual(assembled);
      // No experimental overlays leaked in.
      expect(assembled[0]?.annotations).toBeUndefined();
      expect(assembled[0]?.openLoops).toBeUndefined();
      expect(assembled[0]?.temporalAnnotations).toBeUndefined();
      // Base fields present.
      expect(assembled[0]?.canonicalId).toBe("p-maya");
      expect(assembled[0]?.emailCount).toBe(1);
      expect(assembled[0]?.chatCount).toBe(1);
      expect(assembled[0]?.meetingCount).toBe(1);
    });
  });

  test("experimental ON: assembly matches the port's results exactly (with overlays)", async () => {
    seedRichFixture();
    createOpenLoop(
      db,
      {
        id: "olp_1",
        createdByRun: "r",
        title: "Send the signed lease",
        confidence: 0.9,
        importance: 0.7,
        actors: ["p-maya"],
      },
      3_000,
    );
    // A grounded annotation needs a live evidence doc.
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
         content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_ev', 'google', 'gmail-test', 'x1', 'Note', 'runs the reading group',
         'h1', '{}', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z',
         '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z')`,
    ).run();
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "p-maya",
        claimType: "role",
        claimText: "runs the reading group",
        evidenceDocId: "doc_ev",
        evidenceQuote: "runs the reading group",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "r",
      },
      5_000,
    );

    await withExperimental(true, async () => {
      const port = createGatewayPersonPort(db);
      const out = await port.lookup({ query: "Maya", limit: 5 });
      const assembled = assemblePersonLookup(db, "Maya", 5, { experimental: true });
      expect(out.results).toEqual(assembled);
      const maya = assembled.find((r) => r.canonicalId === "p-maya");
      expect(maya?.openLoops?.map((l) => l.loopId)).toEqual(["olp_1"]);
      expect(maya?.annotations?.[0]?.claim).toBe("runs the reading group");
    });
  });

  test("stable lookup includes grounded memory while hiding experimental connections", () => {
    seedRichFixture();
    createPersonAnnotation(
      db,
      {
        id: "memory_stable",
        personId: "p-maya",
        claimType: "role",
        claimText: "runs the reading group",
        evidenceDocId: "doc-e-1",
        evidenceQuote: "body",
        confidence: 0.8,
        createdByRun: "interactive_session",
        claimBasis: "quoted",
      },
      3000,
    );
    const result = assemblePersonLookup(db, "Maya", 5, { experimental: false }).find(
      (person) => person.canonicalId === "p-maya",
    );
    expect(result?.annotations).toEqual([
      expect.objectContaining({ claim: "runs the reading group", evidenceDocId: "doc-e-1" }),
    ]);
    expect(result?.openLoops).toBeUndefined();
    expect(result?.temporalAnnotations).toBeUndefined();
  });

  test("experimental ON adds fields OFF omits (the overlays are gated)", () => {
    seedRichFixture();
    createOpenLoop(
      db,
      {
        id: "olp_g",
        createdByRun: "r",
        title: "gated",
        confidence: 0.9,
        importance: 0.5,
        actors: ["p-maya"],
      },
      3_000,
    );
    const off = assemblePersonLookup(db, "Maya", 5, { experimental: false });
    const on = assemblePersonLookup(db, "Maya", 5, { experimental: true });
    expect(off.find((r) => r.canonicalId === "p-maya")?.openLoops).toBeUndefined();
    expect(on.find((r) => r.canonicalId === "p-maya")?.openLoops?.map((l) => l.loopId)).toEqual([
      "olp_g",
    ]);
  });
});
