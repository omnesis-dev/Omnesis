// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A call-log document stamps self and each peer with
// `role: "participant"` (symmetric co-consumption), exactly like a WhatsApp
// 1:1 chat document does. This asserts that choice plugs into the existing
// interaction-scoring pipeline with ZERO new scoring logic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { computeInteractionScores } from "./InteractionScoreService.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-interaction-call-log-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedPerson(id: string, name: string, opts: { isSelf?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    "test",
    opts.isSelf ? 1 : 0,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

function seedDoc(id: string, sourceCreatedAt = "2026-07-04T12:00:00Z"): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    `src:${id}`,
    id,
    `title-${id}`,
    "body",
    `ch-${id}`,
    "{}",
    sourceCreatedAt,
    sourceCreatedAt,
    sourceCreatedAt,
    sourceCreatedAt,
  );
}

function seedDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(docId, personId, role, `src:${docId}`);
}

describe("InteractionScoreService — call-log participant/participant", () => {
  test("a call-log day-document contributes co-consumption scoring like a WhatsApp 1:1 chat", () => {
    seedPerson("self-1", "Me", { isSelf: true });
    seedPerson("peer-1", "Maya Reeves");
    seedDoc("call-log:2026-07-04");
    seedDocPerson("call-log:2026-07-04", "self-1", "participant");
    seedDocPerson("call-log:2026-07-04", "peer-1", "participant");

    const snapshot = computeInteractionScores(db);
    const row = snapshot.rows.find((r) => r.personId === "peer-1");
    expect(row).toBeDefined();
    // Symmetric co-consumption: counts as BOTH inbound and outbound, per
    // `CONSUMER_ROLES`/`roleKind`'s doc comment — no producer/consumer
    // asymmetry for a mutual phone call the way a one-sided newsletter has.
    expect(row!.inboundCount).toBeGreaterThan(0);
    expect(row!.outboundCount).toBeGreaterThan(0);
    expect(row!.interactionScore).toBeGreaterThan(0);
  });

  test("produces an identical score contribution to a WhatsApp-shaped participant/participant document", () => {
    seedPerson("self-1", "Me", { isSelf: true });
    seedPerson("call-peer", "Maya Reeves");
    seedPerson("chat-peer", "David Lin");

    seedDoc("call-log:2026-07-04");
    seedDocPerson("call-log:2026-07-04", "self-1", "participant");
    seedDocPerson("call-log:2026-07-04", "call-peer", "participant");

    // Same shape, different source — a WhatsApp 1:1 chat day-document.
    seedDoc("whatsapp-jid:2026-07-04");
    seedDocPerson("whatsapp-jid:2026-07-04", "self-1", "participant");
    seedDocPerson("whatsapp-jid:2026-07-04", "chat-peer", "participant");

    const snapshot = computeInteractionScores(db);
    const callRow = snapshot.rows.find((r) => r.personId === "call-peer");
    const chatRow = snapshot.rows.find((r) => r.personId === "chat-peer");
    expect(callRow).toBeDefined();
    expect(chatRow).toBeDefined();
    // Zero new scoring logic: one document, one participant/participant
    // pair each — the call-log peer and the WhatsApp peer score identically.
    expect(callRow!.inboundCount).toBe(chatRow!.inboundCount);
    expect(callRow!.outboundCount).toBe(chatRow!.outboundCount);
    expect(callRow!.interactionScore).toBeCloseTo(chatRow!.interactionScore, 10);
  });
});
