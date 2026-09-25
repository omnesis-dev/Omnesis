// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Time-index window DTO contract for the legacy annotation-only endpoint.
 *
 *   1. ONE canonical, invented fixture
 *      (`__fixtures__/time-index-window-contract.json`) carries a
 *      representative window payload: all four calendar shapes (instant,
 *      multi-day range, month, day), a null and a non-null kind, and a
 *      resolved document.
 *   2. The REAL window route — `createServer` over a real SQLite database,
 *      seeded through the real storage writers — must emit exactly the
 *      fixture's entries (deep-equal). `nowMs` is the one wall-clock field:
 *      asserted to be a number, then normalized to the fixture's value
 *      before the deep-equal.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { insertTemporalAnnotation } from "../enrichment/temporal-annotations/storage.js";
import type Database from "better-sqlite3";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/time-index-window-contract.json", import.meta.url),
);
const canonicalRaw = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(canonicalRaw) as { nowMs: number; entries: unknown[] };

const WINDOW_FROM = Date.UTC(2026, 6, 1);
const WINDOW_TO = Date.UTC(2026, 9, 30);

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-tix-contract-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: "contract-test", kind: "cli" });
  ADMIN_TOKEN = createToken(db, device.id, [SCOPE_ADMIN]).token;
  app = createServer(db, dbPath, {
    getBriefsStatus: () => ({ visible: true, enabled: true, modelAssigned: true, active: true }),
  });

  // The grounding document (invented). The window resolves title/provider/
  // source by joining `documents`, so the row must exist before the GET.
  const iso = new Date(1000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES ('doc_contract_policy', 'demo-mail', 'demo-mail:inbox', 'msg_contract_policy',
             'Travel insurance policy — confirmation', 'body', 'hash', ?, ?, ?, ?)`,
  ).run(iso, iso, iso, iso);

  const seed = (input: Parameters<typeof insertTemporalAnnotation>[1]) =>
    insertTemporalAnnotation(db, input, 1000);

  // All four calendar shapes, seeded through the real writer. Interval
  // bounds are fixed unix-ms so the fixture stays timezone-independent.
  seed({
    id: "tix_contract_instant",
    intervalStartMs: Date.UTC(2026, 6, 16, 9, 30),
    intervalEndMs: Date.UTC(2026, 6, 16, 9, 30),
    precision: "instant",
    canonical: "2026-07-16T09:30:00.000Z",
    sentence: "Dentist follow-up appointment at the Riverside practice.",
    kind: "appointment",
    documentIds: [],
    createdByRun: "run_contract",
  });
  seed({
    id: "tix_contract_range",
    intervalStartMs: Date.UTC(2026, 6, 20),
    intervalEndMs: Date.UTC(2026, 7, 3) - 1,
    precision: "range",
    canonical: "2026-07-20 .. 2026-08-02",
    sentence: "Lisbon trip — flights and apartment are booked.",
    kind: null,
    documentIds: [],
    createdByRun: "run_contract",
  });
  seed({
    id: "tix_contract_month",
    intervalStartMs: Date.UTC(2026, 7, 1),
    intervalEndMs: Date.UTC(2026, 8, 1) - 1,
    precision: "month",
    canonical: "2026-08",
    sentence: "The landlord expects a renewal decision sometime in August.",
    kind: "event",
    documentIds: [],
    createdByRun: "run_contract",
  });
  seed({
    id: "tix_contract_day",
    intervalStartMs: Date.UTC(2026, 8, 14),
    intervalEndMs: Date.UTC(2026, 8, 15) - 1,
    precision: "day",
    canonical: "2026-09-14",
    sentence: "Travel insurance for the Lisbon trip lapses.",
    kind: "expiry",
    documentIds: ["doc_contract_policy"],
    createdByRun: "run_contract",
  });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("time-index window DTO contract", () => {
  test("the real window route emits exactly the canonical fixture payload", async () => {
    const res = await app.request(`/briefs/time-index/window?from=${WINDOW_FROM}&to=${WINDOW_TO}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nowMs: number; entries: unknown[] };
    // `nowMs` is the route's wall clock — the one legitimately dynamic
    // field. Everything else deep-equals the committed fixture: a field
    // the gateway renames, drops, retypes, or starts serializing
    // differently fails loudly here.
    expect(typeof body.nowMs).toBe("number");
    expect({ ...body, nowMs: fixture.nowMs }).toEqual(fixture);
  });
});
