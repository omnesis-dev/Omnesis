// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 174 — a platform identifier says which platform issued it.
 *
 * Two properties matter. The rewrite must touch only the values it can name,
 * because an identifier rewritten on a guess stops matching the person it
 * names. And the pair tables must come out in the order their keys are
 * computed in, because a stored pair in the wrong order no longer matches
 * what a detector computes — which for a refused candidate is an operator's
 * permanent veto quietly ceasing to veto.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { computeAutoMergePairs, findOrCreatePerson } from "../people.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import { namespaceWhatsappLids } from "./migration-174-lid-namespace.js";

describe("platform identifiers gain their platform", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig174-"));
    db = new Database(join(dir, "test.db"));
    // The real schema, not a hand-written subset. Every collision this
    // migration has to survive is defined by a unique index, so a fixture
    // without them is green on a migration that cannot open a real database.
    runSchemaSetup(db as never);
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'whatsapp', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const alias = (id: string, value: string, type = "lid") =>
    db
      .prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
         VALUES (?, 'p1', ?, ?, 's:1', '2026-01-01')`,
      )
      .run(id, value, type);

  const aliases = () =>
    (
      db.prepare("SELECT id, alias FROM person_aliases ORDER BY id").all() as {
        id: string;
        alias: string;
      }[]
    ).map((r) => `${r.id}=${r.alias}`);

  test("takes its place in the list, contiguously", () => {
    expect(MIGRATIONS.filter((m) => m.version === 174)).toHaveLength(1);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(174);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  test("names the one producer that wrote none, and leaves the two that did", () => {
    alias("a1", "229969796026444");
    alias("a2", "github:jlopez");
    alias("a3", "strava-athlete:412");

    namespaceWhatsappLids(db);

    expect(aliases()).toEqual([
      "a1=whatsapp:229969796026444",
      "a2=github:jlopez",
      "a3=strava-athlete:412",
    ]);
  });

  test("leaves a value it cannot name, rather than guessing one", () => {
    // Neither all digits nor prefixed. Lookup is exact-match on the value, so
    // an untouched row keeps resolving; rewriting it on a guess is how an
    // identifier stops matching the person it names.
    alias("a4", "not-a-known-shape");
    namespaceWhatsappLids(db);
    expect(aliases()).toEqual(["a4=not-a-known-shape"]);
  });

  test("touches no other alias type", () => {
    // A phone number is all digits too.
    alias("a5", "15550100123", "phone");
    namespaceWhatsappLids(db);
    expect(aliases()).toEqual(["a5=15550100123"]);
  });

  test("runs twice without prefixing twice", () => {
    alias("a6", "229969796026444");
    namespaceWhatsappLids(db);
    namespaceWhatsappLids(db);
    expect(aliases()).toEqual(["a6=whatsapp:229969796026444"]);
  });

  test("a prefixed alias on another person cannot turn a spelling migration into a merge", () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
      VALUES ('p2', 'Fixture person two', 'extracted', '2030-01-01', '2030-01-01', '2030-01-01', '2030-01-01')`,
    ).run();
    alias("ambiguous-bare", "991234");
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
      VALUES ('ambiguous-prefixed', 'p2', 'whatsapp:991234', 'lid', 's:2', '2030-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
      VALUES ('ambiguous-bare', 's:1', '2030-01-01', '2030-01-01'),
             ('ambiguous-prefixed', 's:2', '2030-01-01', '2030-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO merge_rules (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, winner_side, created_at)
      VALUES ('manual-bare', 'user', 'email', 'fixture@example.org', 'lid', '991234', 'b', '2030-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO merge_candidates (id, status, detection_kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, score, detected_at)
      VALUES ('denied-bare', 'denied', 'shared-identifier', 'email', 'fixture@example.org', 'lid', '991234', 1, '2030-01-01')`,
    ).run();
    const before = [
      "person_aliases",
      "person_alias_assertions",
      "merge_rules",
      "merge_candidates",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    expect(computeAutoMergePairs(db)).toEqual([]);

    namespaceWhatsappLids(db);
    namespaceWhatsappLids(db);

    expect(
      ["person_aliases", "person_alias_assertions", "merge_rules", "merge_candidates"].map(
        (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    ).toEqual(before);
    expect(computeAutoMergePairs(db)).toEqual([]);
    for (const [value, person] of [
      ["991234", "p1"],
      ["whatsapp:991234", "p2"],
    ]) {
      expect(
        findOrCreatePerson(
          db,
          { role: "sender", identifiers: [{ kind: "lid", value }] },
          "s:replay",
          "2030-01-02",
        ),
      ).toBe(person);
    }
    expect(computeAutoMergePairs(db)).toEqual([]);
  });

  test("re-sorts a pair the rewrite put out of order, and carries the winner across", () => {
    // `229…` sorted before `github:…`; `whatsapp:229…` sorts after it. A rule
    // left in the old order would no longer match the key its evaluator builds.
    db.prepare(
      `INSERT INTO merge_rules (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, winner_side, created_at)
       VALUES ('r1', 'user', 'lid', '229969796026444', 'lid', 'github:jlopez', 'a', '2026-01-01')`,
    ).run();

    namespaceWhatsappLids(db);

    expect(
      db.prepare("SELECT side_a_alias, side_b_alias, winner_side FROM merge_rules").get(),
    ).toEqual({
      side_a_alias: "github:jlopez",
      side_b_alias: "whatsapp:229969796026444",
      winner_side: "b",
    });
  });

  test("leaves a cross-type pair alone, because the type decides its order", () => {
    // The reason this is a value convention and not a new alias type: nothing
    // that compares on the type can move.
    db.prepare(
      `INSERT INTO merge_rules (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, winner_side, created_at)
       VALUES ('r2', 'user', 'email', 'maya@example.org', 'lid', '229969796026444', 'a', '2026-01-01')`,
    ).run();

    namespaceWhatsappLids(db);

    expect(
      db.prepare("SELECT side_a_alias, side_b_alias, winner_side FROM merge_rules").get(),
    ).toEqual({
      side_a_alias: "maya@example.org",
      side_b_alias: "whatsapp:229969796026444",
      winner_side: "a",
    });
  });

  test("a refusal survives a collision with a proposal nobody answered", () => {
    // Both rows become the same pair. The operator's answer outlives the
    // question.
    db.prepare(
      `INSERT INTO merge_candidates (id, status, detection_kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, score, detected_at)
       VALUES ('c1', 'denied', 'shared-identifier', 'lid', '229969796026444', 'lid', 'github:jlopez', 1.0, '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO merge_candidates (id, status, detection_kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, score, detected_at)
       VALUES ('c2', 'pending', 'shared-identifier', 'lid', 'github:jlopez', 'lid', 'whatsapp:229969796026444', 1.0, '2026-01-01')`,
    ).run();

    namespaceWhatsappLids(db);

    const rows = db
      .prepare("SELECT id, status, side_a_alias, side_b_alias FROM merge_candidates")
      .all();
    expect(rows).toEqual([
      {
        id: "c1",
        status: "denied",
        side_a_alias: "github:jlopez",
        side_b_alias: "whatsapp:229969796026444",
      },
    ]);
  });

  const candidate = (id: string, status: string, a: string, b: string) =>
    db
      .prepare(
        `INSERT INTO merge_candidates (id, status, detection_kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, score, detected_at)
         VALUES (?, ?, 'shared-identifier', 'lid', ?, 'lid', ?, 1.0, '2026-01-01')`,
      )
      .run(id, status, a, b);

  const rule = (id: string, a: string, b: string, createdAt: string, winner = "a") =>
    db
      .prepare(
        `INSERT INTO merge_rules (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, winner_side, created_at)
         VALUES (?, 'user', 'lid', ?, 'lid', ?, ?, ?)`,
      )
      .run(id, a, b, winner, createdAt);

  /**
   * The gateway and the collector are updated separately, so a collector that
   * already namespaces its identifiers writes the prefixed spelling into a
   * gateway that still holds the bare one. Every rewrite below is then asked
   * to turn one into a value that is already stored — and a migration that
   * throws does not fail once, it fails every boot after.
   */
  describe("a value the rewrite would produce is already stored", () => {
    test("a person holding both spellings keeps one, and keeps every voucher", () => {
      alias("a1", "229969796026444");
      alias("a2", "whatsapp:229969796026444");
      const vouch = db.prepare(
        `INSERT INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
         VALUES (?, ?, '2026-01-01', '2026-01-01')`,
      );
      vouch.run("a1", "whatsapp-messages:+000");
      vouch.run("a2", "apple-contacts:local");

      expect(() => namespaceWhatsappLids(db)).not.toThrow();

      expect(aliases()).toEqual(["a2=whatsapp:229969796026444"]);
      // The bare row's voucher moved rather than going with it: a source's
      // claim on the identifier must not disappear with a spelling.
      const vouchers = db
        .prepare<[], { source_id: string }>(
          "SELECT source_id FROM person_alias_assertions ORDER BY source_id",
        )
        .all()
        .map((r) => r.source_id);
      expect(vouchers).toEqual(["apple-contacts:local", "whatsapp-messages:+000"]);
    });

    test("a pair whose prefixed twin already exists folds into it", () => {
      candidate("c1", "pending", "229969796026444", "github:jlopez");
      candidate("c2", "denied", "github:jlopez", "whatsapp:229969796026444");

      expect(() => namespaceWhatsappLids(db)).not.toThrow();

      const rows = db
        .prepare<[], { id: string; status: string }>("SELECT id, status FROM merge_candidates")
        .all();
      expect(rows).toEqual([{ id: "c2", status: "denied" }]);
    });

    test("an acceptance outlives a refusal, because a live rule points at it", () => {
      // Dropping the acceptance would leave that rule merging two people while
      // the surviving row reads `denied`.
      candidate("c1", "accepted", "229969796026444", "github:jlopez");
      candidate("c2", "denied", "github:jlopez", "whatsapp:229969796026444");

      namespaceWhatsappLids(db);

      const rows = db
        .prepare<[], { id: string; status: string }>("SELECT id, status FROM merge_candidates")
        .all();
      expect(rows).toEqual([{ id: "c1", status: "accepted" }]);
    });

    test("a bare pair whose prefixed twin exists folds before the rewrite", () => {
      // Same tuple after prefixing, so the rewrite itself would collide —
      // before any re-sorting is involved.
      candidate("c1", "pending", "229969796026444", "github:jlopez");
      candidate("c2", "pending", "whatsapp:229969796026444", "github:jlopez");

      expect(() => namespaceWhatsappLids(db)).not.toThrow();

      const rows = db
        .prepare<
          [],
          { id: string; side_a_alias: string; side_b_alias: string }
        >("SELECT id, side_a_alias, side_b_alias FROM merge_candidates")
        .all();
      // One row, and in the order a detector will compute next time: the fold
      // leaves the survivor for the re-sort below to put right.
      expect(rows).toEqual([
        {
          id: "c2",
          side_a_alias: "github:jlopez",
          side_b_alias: "whatsapp:229969796026444",
        },
      ]);
    });

    test("the decision on the folded row moves to the survivor", () => {
      // The bare spelling is the one the operator answered. Losing it would
      // turn a refusal back into an open proposal.
      candidate("c1", "denied", "229969796026444", "github:jlopez");
      candidate("c2", "pending", "whatsapp:229969796026444", "github:jlopez");

      namespaceWhatsappLids(db);

      const rows = db
        .prepare<[], { id: string; status: string }>("SELECT id, status FROM merge_candidates")
        .all();
      expect(rows).toEqual([{ id: "c2", status: "denied" }]);
    });

    test("a bare rule whose prefixed twin exists keeps the older decision and both audit rows", () => {
      rule("r1", "229969796026444", "github:jlopez", "2026-01-01");
      rule("r2", "whatsapp:229969796026444", "github:jlopez", "2026-02-01");

      expect(() => namespaceWhatsappLids(db)).not.toThrow();

      const rows = db.prepare("SELECT id, active FROM merge_rules ORDER BY id").all();
      expect(rows).toEqual([
        { id: "r1", active: 1 },
        { id: "r2", active: 0 },
      ]);
    });

    test("an inactive prefixed twin never withdraws an active bare rule", () => {
      rule("r1", "229969796026444", "github:jlopez", "2026-02-01");
      rule("r2", "whatsapp:229969796026444", "github:jlopez", "2026-01-01");
      db.exec("UPDATE merge_rules SET active = 0 WHERE id = 'r2'");

      namespaceWhatsappLids(db);
      namespaceWhatsappLids(db);

      expect(db.prepare("SELECT id, active FROM merge_rules ORDER BY id").all()).toEqual([
        { id: "r1", active: 1 },
        { id: "r2", active: 0 },
      ]);
      expect(
        db.prepare("SELECT side_a_alias, side_b_alias FROM merge_rules WHERE id = 'r1'").get(),
      ).toEqual({
        side_a_alias: "github:jlopez",
        side_b_alias: "whatsapp:229969796026444",
      });
    });

    test("canonicalizing an inactive older rule leaves the active decision in force", () => {
      rule("r1", "229969796026444", "github:jlopez", "2026-01-01");
      rule("r2", "github:jlopez", "whatsapp:229969796026444", "2026-02-01");
      db.exec("UPDATE merge_rules SET active = 0 WHERE id = 'r1'");

      namespaceWhatsappLids(db);

      expect(db.prepare("SELECT id, active FROM merge_rules ORDER BY id").all()).toEqual([
        { id: "r1", active: 0 },
        { id: "r2", active: 1 },
      ]);
    });

    test("two active rules for one pair keep the older and deactivate the newer", () => {
      rule("r1", "229969796026444", "github:jlopez", "2026-01-01");
      rule("r2", "github:jlopez", "whatsapp:229969796026444", "2026-02-01");

      expect(() => namespaceWhatsappLids(db)).not.toThrow();

      const rows = db
        .prepare<
          [],
          { id: string; active: number }
        >("SELECT id, active FROM merge_rules ORDER BY id")
        .all();
      // Deactivated, not deleted: a merge the operator made stays auditable.
      expect(rows).toEqual([
        { id: "r1", active: 1 },
        { id: "r2", active: 0 },
      ]);
    });

    test("a deactivated newer rule is canonical on the first pass and stable on replay", () => {
      rule("r1", "100000000000007", "github:example-account", "2026-02-01");
      rule("r2", "github:example-account", "whatsapp:100000000000007", "2026-01-01");

      namespaceWhatsappLids(db);

      const rows = db.prepare("SELECT * FROM merge_rules ORDER BY id").all();
      expect(rows[0]).toMatchObject({
        active: 0,
        side_a_alias: "github:example-account",
        side_b_alias: "whatsapp:100000000000007",
        winner_side: "b",
      });
      expect(rows[1]).toMatchObject({ active: 1 });
      namespaceWhatsappLids(db);
      expect(db.prepare("SELECT * FROM merge_rules ORDER BY id").all()).toEqual(rows);
    });
  });
});
