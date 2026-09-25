// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the brief-claims sidecar store: insert-set / list-live /
 * invalidate / atomic replace-set, the composition into the brief
 * create/update writer ops (one transaction), the brief-delete cascade, and
 * the evidence-document lifecycle — the content-change invalidation
 * (quote-broken claims soft-drop, survivors untouched) and the privacy
 * cascade (claims citing a deleted doc hard-purge, live and invalidated
 * alike).
 *
 * Fixture data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { createBrief, deleteBriefsAttachedToLoops, retireBrief, updateBrief } from "./briefs.js";
import {
  cascadeBriefClaimPrivacyDelete,
  hasAnyBriefClaims,
  hasLiveBriefClaimsForDoc,
  insertBriefClaimSet,
  invalidateBriefClaimsForBrief,
  invalidateBriefClaimsForDoc,
  listLiveBriefClaims,
  replaceBriefClaimSet,
  type BriefClaimInput,
} from "./brief-claims.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function claim(id: string, over: Partial<BriefClaimInput> = {}): BriefClaimInput {
  return {
    id,
    claimText: "the venue deposit was paid on 30 June",
    evidenceDocId: "doc_ev1",
    evidenceQuote: "we paid the venue deposit this morning",
    claimBasis: "quoted",
    confidence: 0.8,
    verificationState: "verified",
    ...over,
  };
}

function seedBrief(
  db: Db,
  id: string,
  claims?: BriefClaimInput[],
  relatedLoopIds?: string[],
): void {
  createBrief(
    db,
    {
      id,
      createdByRun: "run_seed",
      kind: "info",
      title: "Deposit confirmed",
      confidence: 0.7,
      urgency: 0.4,
      ...(claims !== undefined ? { claims } : {}),
      ...(relatedLoopIds !== undefined ? { relatedLoopIds } : {}),
    },
    NOW,
  );
}

/** Insert a documents row directly — the evidence the lifecycle ops read. */
function seedDoc(db: Db, id: string, content: string): void {
  const iso = new Date(NOW - 60_000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test-provider', 'test-source', ?, 'Deposit thread', ?, 'hash-a', ?, ?, ?, ?)`,
  ).run(id, id, content, iso, iso, iso, iso);
}

function setDocContent(db: Db, id: string, content: string): void {
  db.prepare("UPDATE documents SET content = ? WHERE id = ?").run(content, id);
}

function claimRow(db: Db, id: string): { invalidated_at: number | null } | undefined {
  return db
    .prepare<
      [string],
      { invalidated_at: number | null }
    >("SELECT invalidated_at FROM brief_claims WHERE id = ?")
    .get(id);
}

describe("brief claims store", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("insert-set + list-live round-trips every field, in insert order", () => {
    seedBrief(db, "brf_1");
    insertBriefClaimSet(
      db,
      "brf_1",
      [
        claim("bclaim_a"),
        claim("bclaim_b", {
          claimText: "the caterer asked for a headcount by Friday",
          claimBasis: "inferred",
          confidence: 0.6,
          verificationState: "unverified",
        }),
      ],
      NOW,
    );
    const live = listLiveBriefClaims(db, "brf_1");
    expect(live.map((c) => c.id)).toEqual(["bclaim_a", "bclaim_b"]);
    expect(live[0]).toMatchObject({
      briefId: "brf_1",
      claimText: "the venue deposit was paid on 30 June",
      evidenceDocId: "doc_ev1",
      evidenceQuote: "we paid the venue deposit this morning",
      claimBasis: "quoted",
      confidence: 0.8,
      verificationState: "verified",
      createdAt: NOW,
      invalidatedAt: null,
    });
    expect(live[1]).toMatchObject({ claimBasis: "inferred", verificationState: "unverified" });
  });

  test("invalidate-by-brief soft-drops every live claim, keeping the rows for audit", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a"), claim("bclaim_b")]);
    expect(invalidateBriefClaimsForBrief(db, "brf_1", NOW + 10)).toBe(2);
    expect(listLiveBriefClaims(db, "brf_1")).toEqual([]);
    const audit = db
      .prepare<
        [],
        { invalidated_at: number | null }
      >("SELECT invalidated_at FROM brief_claims ORDER BY id")
      .all();
    expect(audit).toEqual([{ invalidated_at: NOW + 10 }, { invalidated_at: NOW + 10 }]);
    // Idempotent: nothing left to invalidate.
    expect(invalidateBriefClaimsForBrief(db, "brf_1", NOW + 20)).toBe(0);
  });

  test("replace-set retires the standing set and installs the new one atomically", () => {
    seedBrief(db, "brf_1", [claim("bclaim_old")]);
    const res = replaceBriefClaimSet(
      db,
      "brf_1",
      [claim("bclaim_new", { claimText: "the deposit receipt arrived on 1 July" })],
      NOW + 50,
    );
    expect(res.invalidated).toBe(1);
    const live = listLiveBriefClaims(db, "brf_1");
    expect(live.map((c) => c.id)).toEqual(["bclaim_new"]);
    // The retired claim is audit-kept, not deleted.
    const total = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM brief_claims").get();
    expect(total?.n).toBe(2);
  });

  test("replace-set with an empty set clears the live claims", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a")]);
    replaceBriefClaimSet(db, "brf_1", [], NOW + 50);
    expect(listLiveBriefClaims(db, "brf_1")).toEqual([]);
  });

  test("a failed insert inside replace-set rolls the invalidation back (one transaction)", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a")]);
    // The second row's duplicate PRIMARY KEY makes the insert half throw
    // after the invalidation half already ran — the transaction must undo both.
    expect(() =>
      replaceBriefClaimSet(db, "brf_1", [claim("bclaim_x"), claim("bclaim_x")], NOW + 50),
    ).toThrow(/UNIQUE/);
    const live = listLiveBriefClaims(db, "brf_1");
    expect(live.map((c) => c.id)).toEqual(["bclaim_a"]);
    expect(live[0]!.invalidatedAt).toBeNull();
  });

  test("createBrief persists the claim set with the brief in one write", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a")]);
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_a"]);
  });

  test("updateBrief with claims replaces the live set; without claims leaves it untouched", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a")]);
    // No `claims` on the update → the set is untouched.
    updateBrief(db, "brf_1", { title: "Deposit confirmed (updated)" }, NOW + 10);
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_a"]);
    // A supplied `claims` replaces it.
    updateBrief(
      db,
      "brf_1",
      { claims: [claim("bclaim_b", { claimText: "the balance is due on 15 July" })] },
      NOW + 20,
    );
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_b"]);
  });

  test("deleting a brief hard-deletes its claims (FK cascade — quotes must not outlive the brief)", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a"), claim("bclaim_b")], ["olp_1"]);
    // The loop-delete cascade is the hard-delete path a brief can still take.
    expect(deleteBriefsAttachedToLoops(db, ["olp_1"], { includeTerminal: true })).toEqual([
      "brf_1",
    ]);
    const total = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM brief_claims").get();
    expect(total?.n).toBe(0);
  });

  test("retiring a brief keeps its claims — the record is the point of retiring", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a"), claim("bclaim_b")]);
    expect(retireBrief(db, "brf_1", NOW + 10)).toBe(true);
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_a", "bclaim_b"]);
  });

  test("a null verification state (no verifier configured) round-trips as null", () => {
    seedBrief(db, "brf_1", [claim("bclaim_a", { verificationState: null })]);
    expect(listLiveBriefClaims(db, "brf_1")[0]!.verificationState).toBeNull();
  });

  // ── evidence-document lifecycle ─────────────────────────────────────────

  const SURVIVING_QUOTE = "moved our session to Saturday morning";
  const BREAKING_QUOTE = "the fee is unchanged";

  test("content change soft-drops quote-broken claims and leaves quote-survivors untouched", () => {
    seedDoc(db, "doc_ev", `Update: they ${SURVIVING_QUOTE}, and ${BREAKING_QUOTE}.`);
    seedBrief(db, "brf_1", [
      claim("bclaim_keep", { evidenceDocId: "doc_ev", evidenceQuote: SURVIVING_QUOTE }),
      claim("bclaim_drop", { evidenceDocId: "doc_ev", evidenceQuote: BREAKING_QUOTE }),
    ]);
    setDocContent(db, "doc_ev", `Update: they ${SURVIVING_QUOTE}; new fee schedule attached.`);
    expect(invalidateBriefClaimsForDoc(db, "doc_ev", NOW + 10)).toBe(1);
    expect(claimRow(db, "bclaim_drop")?.invalidated_at).toBe(NOW + 10);
    const live = listLiveBriefClaims(db, "brf_1");
    expect(live.map((c) => c.id)).toEqual(["bclaim_keep"]);
    // The survivor keeps its write-time stamp — there is no re-verification
    // lane for brief claims, so nothing re-flags it.
    expect(live[0]!.verificationState).toBe("verified");
    // Idempotent: a re-run finds nothing left to drop.
    expect(invalidateBriefClaimsForDoc(db, "doc_ev", NOW + 20)).toBe(0);
  });

  test("content-change invalidation only touches claims that existed at the event time", () => {
    seedDoc(db, "doc_ev", `Original: ${BREAKING_QUOTE}.`);
    seedBrief(db, "brf_1", [
      claim("bclaim_old", { evidenceDocId: "doc_ev", evidenceQuote: BREAKING_QUOTE }),
    ]);
    // The content change breaks the old quote…
    setDocContent(db, "doc_ev", "Revised: a new fee schedule applies from August.");
    // …and a later write lands a claim quoting the NEW content before the
    // queued invalidation runs.
    insertBriefClaimSet(
      db,
      "brf_1",
      [
        claim("bclaim_new", {
          evidenceDocId: "doc_ev",
          evidenceQuote: "a new fee schedule applies from August",
        }),
      ],
      NOW + 2000,
    );
    expect(invalidateBriefClaimsForDoc(db, "doc_ev", NOW + 1000)).toBe(1);
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_new"]);
  });

  test("a vanished evidence document invalidates every touched claim (un-regroundable)", () => {
    seedBrief(db, "brf_1", [
      claim("bclaim_a", { evidenceDocId: "doc_gone" }),
      claim("bclaim_b", { evidenceDocId: "doc_gone" }),
    ]);
    expect(invalidateBriefClaimsForDoc(db, "doc_gone", NOW + 10)).toBe(2);
    expect(listLiveBriefClaims(db, "brf_1")).toEqual([]);
  });

  test("privacy cascade HARD-purges live AND invalidated claims — and only those citing the deleted doc", () => {
    seedBrief(db, "brf_1", [
      claim("bclaim_a_old", { evidenceDocId: "doc_a" }),
      claim("bclaim_b_old", { evidenceDocId: "doc_b" }),
    ]);
    // A replace-set retires the first generation; both docs stay cited.
    replaceBriefClaimSet(
      db,
      "brf_1",
      [
        claim("bclaim_a_live", { evidenceDocId: "doc_a" }),
        claim("bclaim_b_live", { evidenceDocId: "doc_b" }),
      ],
      NOW + 10,
    );
    const purged = cascadeBriefClaimPrivacyDelete(db, ["doc_a"]);
    // Gone entirely — live and audit-kept alike: the quote IS the deleted
    // document's content.
    expect([...purged].sort()).toEqual(["bclaim_a_live", "bclaim_a_old"]);
    expect(claimRow(db, "bclaim_a_live")).toBeUndefined();
    expect(claimRow(db, "bclaim_a_old")).toBeUndefined();
    // Claims citing the other document are untouched, in both generations.
    expect(claimRow(db, "bclaim_b_live")?.invalidated_at).toBeNull();
    expect(claimRow(db, "bclaim_b_old")?.invalidated_at).toBe(NOW + 10);
    expect(listLiveBriefClaims(db, "brf_1").map((c) => c.id)).toEqual(["bclaim_b_live"]);
    // Empty input is a no-op.
    expect(cascadeBriefClaimPrivacyDelete(db, [])).toEqual([]);
  });

  test("the cheap guards: hasAnyBriefClaims and hasLiveBriefClaimsForDoc", () => {
    seedBrief(db, "brf_1");
    expect(hasAnyBriefClaims(db)).toBe(false);
    expect(hasLiveBriefClaimsForDoc(db, "doc_a")).toBe(false);
    insertBriefClaimSet(db, "brf_1", [claim("bclaim_a", { evidenceDocId: "doc_a" })], NOW);
    expect(hasAnyBriefClaims(db)).toBe(true);
    expect(hasLiveBriefClaimsForDoc(db, "doc_a")).toBe(true);
    expect(hasLiveBriefClaimsForDoc(db, "doc_other")).toBe(false);
    // An invalidated claim no longer trips the live guard, but the store
    // still holds rows (the privacy guard stays true).
    invalidateBriefClaimsForBrief(db, "brf_1", NOW + 5);
    expect(hasLiveBriefClaimsForDoc(db, "doc_a")).toBe(false);
    expect(hasAnyBriefClaims(db)).toBe(true);
  });
});
