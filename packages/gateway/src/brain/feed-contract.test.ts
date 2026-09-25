// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cross-surface briefs-feed DTO contract — the TS half.
 *
 * The iOS app decodes `GET /briefs/feed` with Swift `Decodable`
 * (`BriefsClient.feed()`), so a renamed/dropped/retyped field on the
 * gateway side breaks the client silently — the classic "green-but-broken"
 * wire drift the tool-result contract (`packages/agent/src/
 * tool-result-contract.test.ts`) exists to catch. Same pattern here:
 *
 *   1. ONE canonical, invented fixture
 *      (`__fixtures__/briefs-feed-contract.json`) carries a representative
 *      feed payload: both brief kinds, both feed states, every nullable
 *      field present on one brief and null on the other, and a resolved
 *      citation.
 *   2. The REAL feed route — `createServer` over a real SQLite database,
 *      seeded through the real storage writers — must emit exactly the
 *      fixture payload (deep-equal), so the fixture can never drift from
 *      the live DTO.
 *   3. The iOS mirror copy is asserted byte-identical to the canonical
 *      fixture, so the Swift decode half
 *      (`ios/Tests/OmnesisTests/BriefsFeedContractDecodeTests.swift`,
 *      run on the macOS lane) is guaranteed to be decoding the same bytes
 *      the gateway emits.
 *
 * Determinism: ids and timestamps are caller-chosen at seed time, and the
 * fixture's instants sit far in the past (created-at) or far in the future
 * (event-at / relevant-until) so the route's real `Date.now()` never flips
 * a ranking tier or expires a brief, in any timezone.
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
import { createBrief, markBriefRead } from "./storage/briefs.js";
import type Database from "better-sqlite3";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/briefs-feed-contract.json", import.meta.url),
);
// Mirror copy the Swift decode test loads — kept byte-identical by this
// test so both surfaces pin one logical fixture, never two drifting ones.
const IOS_MIRROR = fileURLToPath(
  new URL("../../../../ios/Tests/OmnesisTests/Fixtures/briefs-feed-contract.json", import.meta.url),
);

const canonicalRaw = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(canonicalRaw) as { briefs: unknown[] };

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-briefs-contract-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: "contract-test", kind: "cli" });
  ADMIN_TOKEN = createToken(db, device.id, [SCOPE_ADMIN]).token;
  app = createServer(db, dbPath, {
    getBriefsStatus: () => ({ visible: true, enabled: true, modelAssigned: true, active: true }),
  });

  // The cited document (invented). Citations resolve title/provider/source
  // by joining `documents`, so the row must exist before the feed GET.
  const iso = new Date(1000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES ('doc_contract_email', 'demo-mail', 'demo-mail:inbox', 'msg_contract',
             'Studio agreement — signature needed', 'body', 'hash', ?, ?, ?, ?)`,
  ).run(iso, iso, iso, iso);

  // The loop-kind brief: every nullable field populated + one citation.
  // event-at/relevant-until far future ⇒ showable and tier-stable forever.
  createBrief(
    db,
    {
      id: "brf_contract_loop",
      createdByRun: "run_contract",
      kind: "loop",
      title: "Send back the signed studio agreement",
      description: "Studio Northstar asked for the signed copy last week.",
      body: "The agreement arrived by email. Maya Reeves offered to co-sign; nothing has been sent back yet.",
      confidence: 0.9,
      urgency: 0.6,
      citations: ["doc_contract_email"],
      eventAt: Date.UTC(2100, 0, 1),
      relevantUntil: Date.UTC(2100, 0, 2),
    },
    1000,
  );

  // The info-kind brief: every nullable field null, marked read (so the
  // contract also pins the `read` sort-last state on the wire).
  createBrief(
    db,
    {
      id: "brf_contract_info",
      createdByRun: "run_contract",
      kind: "info",
      title: "Design review moved to Thursday",
      description: "The calendar invite was updated overnight.",
      confidence: 0.7,
      urgency: 0.3,
    },
    2000,
  );
  markBriefRead(db, "brf_contract_info", 3000);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("briefs-feed DTO contract", () => {
  test("the real feed route emits exactly the canonical fixture payload", async () => {
    const res = await app.request("/briefs/feed", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      briefs: unknown[];
      pageInfo: { hasMore: boolean; limit: number };
    };
    // Deep-equal the DTO array against the committed fixture; pageInfo is
    // pinned separately because the Swift fixture predates pagination metadata.
    expect(body.briefs).toEqual(fixture.briefs);
    expect(body.pageInfo).toEqual({ hasMore: false, limit: 30 });
  });

  test("the iOS mirror copy is byte-identical to the canonical fixture", () => {
    expect(readFileSync(IOS_MIRROR, "utf8")).toBe(canonicalRaw);
  });
});
