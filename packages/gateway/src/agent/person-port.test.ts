// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

type Db = Database.Database;

import { createDatabase } from "../db.js";
import { createOpenLoop } from "../brain/storage/open-loops.js";
import { createPersonAnnotation } from "../brain/storage/person-annotations.js";
import { createGatewayPersonPort } from "./ports.js";
import type { PersonLookupGate } from "../domain/person-lookup.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-person-port-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertPerson(args: {
  id: string;
  name: string;
  emails?: string[];
  phones?: string[];
  lastSeen?: string;
  interactionScoreRecent?: number;
}) {
  const lastSeen = args.lastSeen ?? "2026-04-01T12:00:00Z";
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen,
                         created_at, updated_at, interaction_score_recent)
     VALUES (?, ?, 'extracted', '2026-01-01', ?, '2026-01-01', '2026-01-01', ?)`,
  ).run(args.id, args.name, lastSeen, args.interactionScoreRecent ?? 0);
  for (const email of args.emails ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
       VALUES (?, ?, 'email', ?, '2026-01-01')`,
    ).run(randomUUID(), args.id, email);
  }
  for (const phone of args.phones ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
       VALUES (?, ?, 'phone', ?, '2026-01-01')`,
    ).run(randomUUID(), args.id, phone);
  }
}

function insertDocumentForPerson(
  personId: string,
  documentType: "email" | "conversation" | "event",
  externalId: string,
  sourceId: string,
) {
  const metadata = JSON.stringify({ documentType });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Doc', 'body', 'hash-' || ?, ?, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(externalId, sourceId, externalId, externalId, metadata);
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role)
     VALUES (?, ?, 'participant')`,
  ).run(externalId, personId);
}

describe("createGatewayPersonPort.lookup", () => {
  test("returns multiple candidates ordered by interactionScoreRecent", async () => {
    insertPerson({
      id: "p-maria-work",
      name: "Maria Smith",
      emails: ["maria.smith@acme.com"],
      phones: ["+15550133"],
      interactionScoreRecent: 0.82,
      lastSeen: "2026-04-15T10:00:00Z",
    });
    insertPerson({
      id: "p-maria-personal",
      name: "Maria Smith",
      emails: ["maria@smith.family"],
      interactionScoreRecent: 0.21,
      lastSeen: "2024-08-10T10:00:00Z",
    });

    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "maria" });

    expect(out.query).toBe("maria");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.canonicalId).toBe("p-maria-work");
    expect(out.results[0]?.aliases).toContain("maria.smith@acme.com");
    expect(out.results[0]?.aliases).toContain("+15550133");
    // Emails come first in the alias ordering.
    expect(out.results[0]?.aliases[0]).toBe("maria.smith@acme.com");
    expect(out.results[0]?.lastInteraction).toBe(Date.parse("2026-04-15T10:00:00Z"));
    expect(out.results[0]?.interactionScore).toBeCloseTo(0.82);
    expect(out.results[1]?.canonicalId).toBe("p-maria-personal");
  });

  test("matches by alias (email substring)", async () => {
    insertPerson({
      id: "p-alex",
      name: "Alex Doe",
      emails: ["alex@globex.io"],
      interactionScoreRecent: 0.5,
    });
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "globex.io" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.canonicalId).toBe("p-alex");
  });

  test("splits document counts across email/chat/meeting channels", async () => {
    insertPerson({
      id: "p-jane",
      name: "Jane Doe",
      emails: ["jane@acme.com"],
      interactionScoreRecent: 0.9,
    });
    insertDocumentForPerson("p-jane", "email", "doc-e-1", "gmail:self");
    insertDocumentForPerson("p-jane", "email", "doc-e-2", "gmail:self");
    insertDocumentForPerson("p-jane", "conversation", "doc-c-1", "whatsapp-messages:self");
    insertDocumentForPerson("p-jane", "event", "doc-m-1", "google-calendar:self");

    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Jane" });
    expect(out.results[0]?.emailCount).toBe(2);
    expect(out.results[0]?.chatCount).toBe(1);
    expect(out.results[0]?.meetingCount).toBe(1);
  });

  test("returns an empty results array on no match (not an error)", async () => {
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "nobody by that name" });
    expect(out.results).toHaveLength(0);
    expect(out.query).toBe("nobody by that name");
  });

  test("respects the explicit limit arg", async () => {
    for (let i = 0; i < 8; i++) {
      insertPerson({
        id: `p-d-${i}`,
        name: `Daniel Hayes ${i}`,
        emails: [`d${i}@test.com`],
        interactionScoreRecent: 1 - i * 0.1,
      });
    }
    const port = createGatewayPersonPort(db);
    const limited = await port.lookup({ query: "Daniel", limit: 3 });
    expect(limited.results).toHaveLength(3);
  });

  test("clamps a too-large limit down to LOOKUP_PEOPLE_MAX_LIMIT (12)", async () => {
    for (let i = 0; i < 25; i++) {
      insertPerson({
        id: `p-mass-${String(i).padStart(2, "0")}`,
        name: `Daniel Massey ${i}`,
        emails: [`mass${i}@test.com`],
        interactionScoreRecent: 1 - i * 0.01,
      });
    }
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Daniel", limit: 999 });
    // Even though we inserted 25 candidates and asked for 999, the
    // port clamps the underlying searchPeople call to 12.
    expect(out.results).toHaveLength(12);
  });

  test("includes a merged-loser's aliases in the canonical's alias list", async () => {
    insertPerson({
      id: "p-canonical",
      name: "Maria Smith",
      emails: ["maria.smith@acme.com"],
      interactionScoreRecent: 0.9,
    });
    insertPerson({
      id: "p-loser",
      name: "Maria Smith",
      emails: ["maria@smith.family"],
      phones: ["+15550133"],
      interactionScoreRecent: 0,
    });
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run("p-canonical", "p-loser");

    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Maria" });
    // Loser row is filtered out (searchPeople excludes merged_into IS NOT NULL);
    // canonical comes back with merged aliases unioned in.
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.canonicalId).toBe("p-canonical");
    expect(out.results[0]?.aliases).toEqual(
      expect.arrayContaining(["maria.smith@acme.com", "maria@smith.family", "+15550133"]),
    );
    // Emails come first, then phones — gateway-side ordering.
    const emailIdx = out.results[0]!.aliases.findIndex((a) => a.includes("@"));
    const phoneIdx = out.results[0]!.aliases.findIndex((a) => a.startsWith("+"));
    expect(emailIdx).toBeGreaterThanOrEqual(0);
    expect(phoneIdx).toBeGreaterThan(emailIdx);
  });

  test("caps alias list at 12 entries", async () => {
    insertPerson({
      id: "p-many",
      name: "Power Contact",
      emails: Array.from({ length: 8 }, (_, i) => `addr${i}@example.com`),
      phones: Array.from({ length: 8 }, (_, i) => `+1555010${String(i).padStart(2, "0")}`),
      interactionScoreRecent: 0.5,
    });
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Power" });
    expect(out.results[0]?.aliases.length).toBeLessThanOrEqual(12);
  });

  test("dedupes case-equivalent email aliases", async () => {
    insertPerson({
      id: "p-case",
      name: "Case Person",
      emails: ["alice@example.com", "Alice@Example.com", "ALICE@EXAMPLE.COM"],
      interactionScoreRecent: 0.5,
    });
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Case Person" });
    // Three insertions, one logical alias — only one survives.
    const emails = out.results[0]!.aliases.filter((a) => a.toLowerCase().includes("alice@"));
    expect(emails).toHaveLength(1);
  });

  test("rolls 'message' documentType into chatCount", async () => {
    insertPerson({
      id: "p-msg",
      name: "Group Chat",
      emails: ["chat@example.com"],
      interactionScoreRecent: 0.4,
    });
    insertDocumentForPerson("p-msg", "conversation", "doc-c-1", "whatsapp:self");
    insertDocumentForPerson("p-msg", "conversation", "doc-c-2", "whatsapp:self");
    const port = createGatewayPersonPort(db);
    const out = await port.lookup({ query: "Group Chat" });
    expect(out.results[0]?.chatCount).toBe(2);
  });

  describe("read-worker gate routing", () => {
    test("delegates to the gate with the CLAMPED limit and computed experimental flag", async () => {
      insertPerson({ id: "p-x", name: "Maya Reeves", emails: ["x@example.com"] });
      const gateResults = [{ canonicalId: "p-gate", displayName: "Jamie Lopez", aliases: [] }];
      const lookupPeople = vi.fn(async () => gateResults);
      const gate: PersonLookupGate = { lookupPeople };
      const port = createGatewayPersonPort(db, { lookupGate: gate });

      // Ask for 999 → clamped to LOOKUP_PEOPLE_MAX_LIMIT (12).
      const out = await port.lookup({ query: "anyone", limit: 999 });

      expect(lookupPeople).toHaveBeenCalledTimes(1);
      expect(lookupPeople).toHaveBeenCalledWith("anyone", 12, {
        experimental: expect.any(Boolean),
      });
      // The port surfaces exactly what the gate returned (no main-thread read).
      expect(out.results).toBe(gateResults);
      expect(out.query).toBe("anyone");
    });

    test("passes experimental=true when experimental mode is on", async () => {
      const prev = process.env.OMNESIS_EXPERIMENTAL;
      process.env.OMNESIS_EXPERIMENTAL = "1";
      try {
        const lookupPeople = vi.fn(async () => []);
        const port = createGatewayPersonPort(db, { lookupGate: { lookupPeople } });
        await port.lookup({ query: "q", limit: 3 });
        expect(lookupPeople).toHaveBeenCalledWith("q", 3, { experimental: true });
      } finally {
        if (prev === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
        else process.env.OMNESIS_EXPERIMENTAL = prev;
      }
    });

    test("falls back to the synchronous main-thread read when no gate is wired", async () => {
      insertPerson({
        id: "p-sync",
        name: "Sarah Mendez",
        emails: ["sync@example.com"],
        interactionScoreRecent: 0.5,
      });
      // No gate → the port assembles on the main thread and still returns rows.
      const out = await createGatewayPersonPort(db).lookup({ query: "Sarah" });
      expect(out.results).toHaveLength(1);
      expect(out.results[0]?.canonicalId).toBe("p-sync");
    });
  });

  describe("inline open loops (experimental)", () => {
    const prev = process.env.OMNESIS_EXPERIMENTAL;
    beforeEach(() => {
      process.env.OMNESIS_EXPERIMENTAL = "1";
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = prev;
    });

    test("lookup attaches the person's active open loops (actor OR involved), excluding terminal", async () => {
      insertPerson({ id: "p-a", name: "Maria Smith", emails: ["maria.a@example.com"] });
      createOpenLoop(
        db,
        {
          id: "olp_actor",
          createdByRun: "r",
          title: "Send the signed lease",
          confidence: 0.9,
          importance: 0.7,
          actors: ["p-a"],
        },
        3_000,
      );
      createOpenLoop(
        db,
        {
          id: "olp_done",
          createdByRun: "r",
          title: "handled",
          confidence: 0.9,
          importance: 0.5,
          state: "done",
          actors: ["p-a"],
        },
        4_000,
      );
      const out = await createGatewayPersonPort(db).lookup({ query: "Maria" });
      const summary = out.results.find((r) => r.canonicalId === "p-a");
      expect(summary?.openLoops?.map((l) => l.loopId)).toEqual(["olp_actor"]);
      expect(summary?.openLoops?.[0]?.title).toBe("Send the signed lease");
    });

    test("a person with no loops omits the field", async () => {
      insertPerson({ id: "p-b", name: "Maria Smith", emails: ["maria.b@example.com"] });
      const out = await createGatewayPersonPort(db).lookup({ query: "Maria" });
      expect(out.results.find((r) => r.canonicalId === "p-b")?.openLoops).toBeUndefined();
    });

    test("lookup attaches grounded annotation hints with their reground pointer, dropping dangling ones", async () => {
      insertPerson({ id: "p-c", name: "Maria Smith", emails: ["maria.c@example.com"] });
      // A live evidence doc for the grounded prior; the second prior's evidence
      // doc is never inserted, so the EXISTS guard must drop it from the hints.
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
          id: "panno_hint",
          personId: "p-c",
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
      createPersonAnnotation(
        db,
        {
          id: "panno_dangling",
          personId: "p-c",
          claimType: "role",
          claimText: "ungrounded leftover",
          evidenceDocId: "doc_gone",
          evidenceQuote: "no longer exists",
          confidence: 0.7,
          claimBasis: "quoted",
          createdByRun: "r",
        },
        6_000,
      );
      const out = await createGatewayPersonPort(db).lookup({ query: "Maria" });
      const summary = out.results.find((r) => r.canonicalId === "p-c");
      expect(summary?.annotations).toHaveLength(1);
      expect(summary?.annotations?.[0]?.claim).toBe("runs the reading group");
      expect(summary?.annotations?.[0]?.evidenceDocId).toBe("doc_ev");
    });
  });
});
