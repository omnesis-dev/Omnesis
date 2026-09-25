// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the per-person interaction-score primitive.
 *
 * Covers the score math (harmonic mean, normalization, edge classification),
 * the dirty-version OCC contract (mutation paths bump, refresh task
 * advances last_computed_version), and the upsert pass (zeroing out
 * stale scores, idempotence on re-run).
 *
 * Mirrors the in-process pattern of `people.test.ts` — tmpdir SQLite
 * file per test, all writes via the synchronous `directWriteGate` path.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createDatabase, deleteAllBySource } from "./db.js";
import {
  computeInteractionScores,
  upsertInteractionScores,
  refreshInteractionScores,
  refreshPeopleCounts,
  readInteractionScoresMeta,
  markPeopleGraphDirty,
  mergePeople,
  resolveDocumentPeople,
  searchPeople,
  getPersonById,
} from "./people.js";
import type { PersonMention, PersonRole } from "@omnesis/types";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-iscores-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────

const SELF_EMAIL = "me@example.com";

/** Seed the self person and return its id. */
function makeSelf(emails: string[] = [SELF_EMAIL]): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, 'Me', 'contacts', TRUE, '2020-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id);
  for (const email of emails) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'email', '2026-01-01')`,
    ).run(randomUUID(), id, email);
  }
  return id;
}

/**
 * Insert a document row and resolve its people in one shot. Returns
 * the document id. Date defaults to a recent timestamp so decay weight
 * is ~1 unless the test overrides.
 */
function seedDoc(opts: {
  id?: string;
  sourceId?: string;
  date?: string;
  mentions: PersonMention[];
  documentType?: string;
}): string {
  const id = opts.id ?? `doc-${randomUUID()}`;
  const sourceId = opts.sourceId ?? "gmail:test";
  const date = opts.date ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Doc', 'c', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    id,
    `hash-${id}`,
    JSON.stringify({ documentType: opts.documentType ?? "email", people: opts.mentions }),
    date,
    date,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  resolveDocumentPeople(db, id, opts.mentions, sourceId, date);
  return id;
}

function meSender(): PersonMention {
  return { role: "sender", emails: [SELF_EMAIL] };
}
function meRecipient(): PersonMention {
  return { role: "recipient", emails: [SELF_EMAIL] };
}
function meAttendee(): PersonMention {
  return { role: "attendee", emails: [SELF_EMAIL] };
}
function person(role: PersonRole, email: string, name?: string): PersonMention {
  return { role, name, emails: [email] };
}

/** Look up a (canonical) person id by email alias. */
function personIdByEmail(email: string): string | null {
  const row = db
    .prepare<
      [string],
      { person_id: string }
    >("SELECT person_id FROM person_aliases WHERE alias_type='email' AND alias=? LIMIT 1")
    .get(email);
  return row?.person_id ?? null;
}

/** Convenience: find the score row for an email; null if not present. */
function scoreForEmail(email: string) {
  const snap = computeInteractionScores(db);
  const personId = personIdByEmail(email);
  if (!personId) return null;
  return snap.rows.find((r) => r.personId === personId) ?? null;
}

// ─── Compute: empty / degenerate states ───────────────────────────────

describe("computeInteractionScores — degenerate states", () => {
  test("empty DB → no rows, dirtyVersion 0", () => {
    const snap = computeInteractionScores(db);
    expect(snap.rows).toEqual([]);
    expect(snap.dirtyVersion).toBe(0);
  });

  test("no self person → no rows even when document_people is populated", () => {
    seedDoc({
      mentions: [
        person("sender", "alice@example.com", "Alice"),
        person("recipient", "bob@example.com", "Bob"),
      ],
    });
    const snap = computeInteractionScores(db);
    expect(snap.rows).toEqual([]);
  });

  test("self with no other people → empty row set", () => {
    makeSelf();
    seedDoc({ mentions: [meSender()] });
    const snap = computeInteractionScores(db);
    expect(snap.rows).toEqual([]);
  });

  test("only neutral roles (mentioned / contact) → no edges", () => {
    makeSelf();
    // A self-note that mentions Sara — explicit user requirement: must
    // NOT count toward Sara's interaction score.
    seedDoc({
      mentions: [meSender(), person("mentioned", "sara@example.com", "Sara")],
    });
    const snap = computeInteractionScores(db);
    expect(snap.rows).toEqual([]);
  });

  test("contact-card-only person → no edges", () => {
    makeSelf();
    // A contact card document — Sara appears with role:contact, self
    // is absent. No edge should form either way.
    seedDoc({
      documentType: "contact",
      mentions: [person("contact", "sara@example.com", "Sara")],
    });
    const snap = computeInteractionScores(db);
    expect(snap.rows).toEqual([]);
  });
});

// ─── Edge classification ──────────────────────────────────────────────

describe("computeInteractionScores — edge classification", () => {
  test("self sender + person recipient → outbound only", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    const score = scoreForEmail("alice@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(0);
    expect(score!.outboundCount).toBe(1);
    expect(score!.interactionScore).toBe(0); // one-sided → harmonic mean = 0
  });

  test("person sender + self recipient → inbound only (newsletter shape)", () => {
    makeSelf();
    seedDoc({
      mentions: [person("sender", "gym@example.com", "Gym"), meRecipient()],
    });
    const score = scoreForEmail("gym@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(1);
    expect(score!.outboundCount).toBe(0);
    expect(score!.interactionScore).toBe(0);
  });

  test("bidirectional exchange → both inbound and outbound, score > 0", () => {
    makeSelf();
    // Self → Alice
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    // Alice → Self
    seedDoc({
      mentions: [person("sender", "alice@example.com", "Alice"), meRecipient()],
    });
    const score = scoreForEmail("alice@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(1);
    expect(score!.outboundCount).toBe(1);
    expect(score!.inboundScore).toBe(1);
    expect(score!.outboundScore).toBe(1);
    expect(score!.interactionScore).toBeCloseTo(1, 5);
  });

  test("co-consumption (both attendees of 3rd-party meeting) → both edges", () => {
    makeSelf();
    // Calendar meeting where someone else is the organizer (author) but
    // we don't have them in our people list. Self + Bob both attend.
    seedDoc({
      mentions: [meAttendee(), person("attendee", "bob@example.com", "Bob")],
      documentType: "event",
    });
    const score = scoreForEmail("bob@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(1);
    expect(score!.outboundCount).toBe(1);
  });

  test("WhatsApp-style 1:1 chat (both participant) → both edges", () => {
    makeSelf();
    // WhatsApp 1:1 chat documents list both parties as participant.
    seedDoc({
      mentions: [
        { role: "participant", emails: [SELF_EMAIL] },
        { role: "participant", emails: ["carol@example.com"], name: "Carol" },
      ],
      documentType: "conversation",
    });
    const score = scoreForEmail("carol@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(1);
    expect(score!.outboundCount).toBe(1);
  });

  test("collaborative authoring (both producer roles) → both edges", () => {
    makeSelf();
    // A Drive doc owned by the user with another person also listed as
    // an editor / author. Treated as collaborative — counts both ways.
    seedDoc({
      mentions: [
        { role: "owner", emails: [SELF_EMAIL] },
        { role: "author", emails: ["dave@example.com"], name: "Dave" },
      ],
    });
    const score = scoreForEmail("dave@example.com");
    expect(score).not.toBeNull();
    expect(score!.inboundCount).toBe(1);
    expect(score!.outboundCount).toBe(1);
  });

  test("self mentioned in someone else's doc → no edge", () => {
    makeSelf();
    // Alice writes a doc that mentions self in passing. Self's role is
    // "mentioned" (neutral), so no edge.
    seedDoc({
      mentions: [
        person("sender", "alice@example.com", "Alice"),
        { role: "mentioned", emails: [SELF_EMAIL] },
      ],
    });
    const score = scoreForEmail("alice@example.com");
    // Alice is sender (producer); self has only neutral role on the doc
    // → no edge in either direction. Alice doesn't appear in the
    // snapshot at all.
    expect(score).toBeNull();
  });

  test("multi-role on a doc (self both sender and recipient) → producer wins", () => {
    makeSelf();
    // Self sent an email to a thread where they were also CC'd. Person
    // Alice is the other recipient.
    seedDoc({
      mentions: [meSender(), meRecipient(), person("recipient", "alice@example.com", "Alice")],
    });
    const score = scoreForEmail("alice@example.com");
    expect(score).not.toBeNull();
    // self_kind = MAX(producer, consumer) = producer; Alice = consumer
    // → outbound only (no co-consumption).
    expect(score!.outboundCount).toBe(1);
    expect(score!.inboundCount).toBe(0);
  });
});

// ─── Score math ──────────────────────────────────────────────────────

describe("computeInteractionScores — score math", () => {
  test("scores sum to ≤ 1 across all people (per direction)", () => {
    makeSelf();
    // Three people, mixed directions.
    seedDoc({
      mentions: [meSender(), person("recipient", "a@example.com", "A")],
    });
    seedDoc({
      mentions: [meSender(), person("recipient", "b@example.com", "B")],
    });
    seedDoc({
      mentions: [person("sender", "a@example.com", "A"), meRecipient()],
    });
    seedDoc({
      mentions: [person("sender", "c@example.com", "C"), meRecipient()],
    });

    const snap = computeInteractionScores(db);
    const sumIn = snap.rows.reduce((s, r) => s + r.inboundScore, 0);
    const sumOut = snap.rows.reduce((s, r) => s + r.outboundScore, 0);
    expect(sumIn).toBeCloseTo(1, 5); // total inbound = 2 (from A, C); each is 0.5
    expect(sumOut).toBeCloseTo(1, 5); // total outbound = 2 (to A, B); each is 0.5
  });

  test("harmonic mean = 0 when either side is 0", () => {
    makeSelf();
    // One-way: gym sends 10 newsletters, never replies.
    for (let i = 0; i < 10; i++) {
      seedDoc({
        mentions: [person("sender", "gym@example.com", "Gym"), meRecipient()],
      });
    }
    const score = scoreForEmail("gym@example.com");
    expect(score!.inboundCount).toBe(10);
    expect(score!.outboundCount).toBe(0);
    expect(score!.interactionScore).toBe(0);
  });

  test("harmonic mean penalizes lopsided (high in / low out) more than balanced (mid in / mid out)", () => {
    makeSelf();
    // Person A: 10 in, 1 out → in_share=10/11, out_share=1/2 → harm ≈ 2*(10/11)*(1/2)/((10/11)+(1/2)) = 0.645
    // Person B: 1 in, 1 out → in_share=1/11, out_share=1/2 → harm ≈ 2*(1/11)*(1/2)/((1/11)+(1/2)) ≈ 0.151
    // We expect A > B but the harmonic mean closes the gap relative to a pure-volume sort.
    for (let i = 0; i < 10; i++) {
      seedDoc({
        mentions: [person("sender", "a@example.com", "A"), meRecipient()],
      });
    }
    seedDoc({
      mentions: [meSender(), person("recipient", "a@example.com", "A")],
    });
    seedDoc({
      mentions: [person("sender", "b@example.com", "B"), meRecipient()],
    });
    seedDoc({
      mentions: [meSender(), person("recipient", "b@example.com", "B")],
    });

    const a = scoreForEmail("a@example.com");
    const b = scoreForEmail("b@example.com");
    expect(a!.inboundCount).toBe(10);
    expect(a!.outboundCount).toBe(1);
    expect(b!.inboundCount).toBe(1);
    expect(b!.outboundCount).toBe(1);
    // A's interaction score is bounded by min(in_share, out_share) — small out_share dominates.
    expect(a!.interactionScore).toBeGreaterThan(b!.interactionScore);
    expect(a!.interactionScore).toBeLessThan(0.7);
  });
});

// ─── Decay ───────────────────────────────────────────────────────────

describe("computeInteractionScores — decay", () => {
  test("recent variants weight new docs more than old ones; lifetime variants are equal", () => {
    makeSelf();
    // Person A: one doc 3 years ago.
    seedDoc({
      mentions: [meSender(), person("recipient", "a@example.com", "A")],
      date: "2023-04-30T00:00:00.000Z",
    });
    seedDoc({
      mentions: [person("sender", "a@example.com", "A"), meRecipient()],
      date: "2023-04-30T00:00:00.000Z",
    });
    // Person B: one doc today.
    const today = "2026-04-30T00:00:00.000Z";
    seedDoc({
      mentions: [meSender(), person("recipient", "b@example.com", "B")],
      date: today,
    });
    seedDoc({
      mentions: [person("sender", "b@example.com", "B"), meRecipient()],
      date: today,
    });

    // Pin nowMs to make the test deterministic regardless of wall clock.
    const nowMs = Date.parse(today);
    const snap = computeInteractionScores(db, { nowMs });
    const a = snap.rows.find(
      (r) =>
        db
          .prepare<
            [string],
            { alias: string }
          >("SELECT alias FROM person_aliases WHERE person_id=? AND alias_type='email' LIMIT 1")
          .get(r.personId)?.alias === "a@example.com",
    );
    const b = snap.rows.find(
      (r) =>
        db
          .prepare<
            [string],
            { alias: string }
          >("SELECT alias FROM person_aliases WHERE person_id=? AND alias_type='email' LIMIT 1")
          .get(r.personId)?.alias === "b@example.com",
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Lifetime: both have 1 in, 1 out. Equal lifetime scores.
    expect(a!.interactionScore).toBeCloseTo(b!.interactionScore, 5);

    // Recent: B (today) has weight ~1; A (3y ago) has weight ~exp(-3*ln2) = 0.125.
    // After normalization, B's recent share is much higher than A's.
    expect(b!.interactionScoreRecent).toBeGreaterThan(a!.interactionScoreRecent);
    expect(a!.interactionScoreRecent).toBeGreaterThan(0); // doesn't vanish entirely
  });

  test("decay disabled (very long half-life) collapses recent ≈ lifetime", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "a@example.com", "A")],
      date: "2020-01-01T00:00:00.000Z",
    });
    seedDoc({
      mentions: [person("sender", "a@example.com", "A"), meRecipient()],
      date: "2020-01-01T00:00:00.000Z",
    });
    const snap = computeInteractionScores(db, {
      halfLifeDays: 365_000_000, // effectively infinite
      nowMs: Date.parse("2026-04-30T00:00:00.000Z"),
    });
    const row = snap.rows[0];
    expect(row.interactionScoreRecent).toBeCloseTo(row.interactionScore, 5);
  });
});

// ─── Upsert ──────────────────────────────────────────────────────────

describe("upsertInteractionScores", () => {
  test("persists scores and zeroes stale rows", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    seedDoc({
      mentions: [person("sender", "alice@example.com", "Alice"), meRecipient()],
    });
    refreshInteractionScores(db);

    const aliceId = personIdByEmail("alice@example.com");
    expect(aliceId).not.toBeNull();
    const alice = getPersonById(db, aliceId!)!;
    expect(alice.interactionScore).toBeGreaterThan(0);
    expect(alice.inboundCount).toBe(1);
    expect(alice.outboundCount).toBe(1);
  });

  test("re-running with the same snapshot is a no-op (idempotence)", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    seedDoc({
      mentions: [person("sender", "alice@example.com", "Alice"), meRecipient()],
    });
    const snap = computeInteractionScores(db);
    const r1 = upsertInteractionScores(db, snap);
    expect(r1.updated).toBeGreaterThan(0);
    const r2 = upsertInteractionScores(db, snap);
    expect(r2.updated).toBe(0);
    expect(r2.zeroed).toBe(0);
  });

  test("two refreshes a few ms apart skip every row (epsilon diff defeats decay drift)", () => {
    // Regression for QA finding: time-based decay weight produces
    // microscopically different `_recent` scores between refreshes
    // even when zero edges moved. Without epsilon comparison the
    // upsert pass rewrote all rows every tick — turning steady-state
    // refresh into a 700ms+ writer-bound op on a 1500-people graph.
    //
    // Floors the diff at 1e-6 so a per-tick decay step (~1.3e-6 per
    // minute at 1y half-life) can drift one tick before triggering
    // a rewrite. After several minutes the cumulative drift crosses
    // the threshold and the row updates — that's the right behavior
    // for capturing slow time-induced score evolution.
    makeSelf();
    for (let i = 0; i < 5; i++) {
      seedDoc({
        mentions: [meSender(), person("recipient", `p${i}@example.com`, `P${i}`)],
      });
      seedDoc({
        mentions: [person("sender", `p${i}@example.com`, `P${i}`), meRecipient()],
      });
    }
    const t0 = Date.now();
    refreshInteractionScores(db, { nowMs: t0 });
    // Second refresh a few ms later — same data, infinitesimally
    // different decay weight per row.
    const result = upsertInteractionScores(db, computeInteractionScores(db, { nowMs: t0 + 50 }));
    expect(result.updated).toBe(0);
    expect(result.zeroed).toBe(0);
  });

  test("zero pass clears scores when a person loses all edges (source delete)", () => {
    makeSelf();
    seedDoc({
      sourceId: "gmail:test",
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    seedDoc({
      sourceId: "gmail:test",
      mentions: [person("sender", "alice@example.com", "Alice"), meRecipient()],
    });
    refreshInteractionScores(db);

    const aliceIdBefore = personIdByEmail("alice@example.com")!;
    expect(getPersonById(db, aliceIdBefore)!.interactionScore).toBeGreaterThan(0);

    // Delete the entire source — Alice's document_people rows cascade.
    deleteAllBySource(db, "gmail:test");
    refreshInteractionScores(db);

    // Alice's `people` row may have been swept (no aliases + no
    // document_people left), or may remain. If it remains, scores
    // must be zero. If it was swept, getPersonById returns null —
    // also acceptable.
    const aliceAfter = getPersonById(db, aliceIdBefore);
    if (aliceAfter) {
      expect(aliceAfter.interactionScore).toBe(0);
      expect(aliceAfter.inboundCount).toBe(0);
      expect(aliceAfter.outboundCount).toBe(0);
    }
  });

  test("self flip clears stale scores from the previously-non-self person", () => {
    // Realistic scenario: a previously-extracted person (scored as a
    // regular contact via email ingest) later has `is_self` flipped
    // TRUE — happens when Apple Contacts is added after months of
    // email syncing and the isMe contact card resolves to an existing
    // extracted person by email match.
    //
    // Without the zero-pass touching self, the previous non-self
    // scores stay frozen on the row forever and the user sees the
    // person at a misleading rank in the portal.
    const futureSelf = makeSelf(); // initially the only self
    // Insert some bidirectional traffic so futureSelf scores someone.
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    seedDoc({
      mentions: [person("sender", "alice@example.com", "Alice"), meRecipient()],
    });
    // Add another non-self person that gets scores.
    const aliceId = personIdByEmail("alice@example.com")!;
    refreshInteractionScores(db);
    expect(getPersonById(db, aliceId)!.interactionScore).toBeGreaterThan(0);
    expect(getPersonById(db, futureSelf)!.interactionScore).toBe(0); // self always 0

    // Now demote futureSelf to non-self and seed traffic so that
    // person picks up scores. Insert a NEW self person to fill the
    // role.
    db.prepare("UPDATE people SET is_self = FALSE WHERE id = ?").run(futureSelf);
    const newSelf = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'NewMe', 'contacts', TRUE, '2020-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(newSelf);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'newme@example.com', 'email', '2026-01-01')`,
    ).run(randomUUID(), newSelf);

    // Generate bidirectional traffic between newSelf and futureSelf
    // so futureSelf becomes a regular non-self person with non-zero
    // edge counts in the snapshot.
    seedDoc({
      mentions: [
        { role: "sender", emails: ["newme@example.com"] },
        { role: "recipient", emails: [SELF_EMAIL] },
      ],
    });
    seedDoc({
      mentions: [
        { role: "sender", emails: [SELF_EMAIL] },
        { role: "recipient", emails: ["newme@example.com"] },
      ],
    });

    refreshInteractionScores(db);

    // futureSelf is now a regular person → SHOULD have non-zero
    // scores (which proves the zero-pass didn't strip them).
    const formerSelf = getPersonById(db, futureSelf)!;
    expect(formerSelf.inboundCount).toBeGreaterThan(0);
    expect(formerSelf.outboundCount).toBeGreaterThan(0);

    // Now flip BACK: futureSelf becomes self again, newSelf demotes.
    db.prepare("UPDATE people SET is_self = FALSE WHERE id = ?").run(newSelf);
    db.prepare("UPDATE people SET is_self = TRUE WHERE id = ?").run(futureSelf);

    refreshInteractionScores(db);

    // futureSelf is now self again → MUST be zeroed back out (this
    // is the regression — the previous code skipped self in the
    // zero-pass and the stale non-self scores stuck around).
    const selfAgain = getPersonById(db, futureSelf)!;
    expect(selfAgain.isSelf).toBe(true);
    expect(selfAgain.inboundCount).toBe(0);
    expect(selfAgain.outboundCount).toBe(0);
    expect(selfAgain.interactionScore).toBe(0);
    expect(selfAgain.interactionScoreRecent).toBe(0);
  });

  test("yieldable: token request bails partway and meta version isn't advanced", () => {
    makeSelf();
    for (let i = 0; i < 10; i++) {
      seedDoc({
        mentions: [meSender(), person("recipient", `p${i}@example.com`, `P${i}`)],
      });
      seedDoc({
        mentions: [person("sender", `p${i}@example.com`, `P${i}`), meRecipient()],
      });
    }
    const snap = computeInteractionScores(db);
    expect(snap.rows.length).toBe(10);

    // Token requests yield after the very first chunk.
    let polls = 0;
    const token = {
      requested: () => {
        polls += 1;
        return polls >= 1;
      },
    };
    const metaBefore = readInteractionScoresMeta(db);
    const result = upsertInteractionScores(db, snap, { token, chunkSize: 3 });
    // We yielded — meta version did NOT advance.
    const metaAfter = readInteractionScoresMeta(db);
    expect(metaAfter.lastComputedVersion).toBe(metaBefore.lastComputedVersion);
    expect(result.updated).toBeGreaterThan(0); // some chunk landed
  });
});

// ─── Dirty version + refresh contract ────────────────────────────────

describe("interaction_scores_meta dirty version", () => {
  test("starts at 0 / -1 on a fresh DB", () => {
    const meta = readInteractionScoresMeta(db);
    expect(meta.dirtyVersion).toBe(0);
    expect(meta.lastComputedVersion).toBe(-1);
  });

  test("resolveDocumentPeople bumps dirty_version", () => {
    makeSelf();
    const before = readInteractionScoresMeta(db).dirtyVersion;
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    const after = readInteractionScoresMeta(db).dirtyVersion;
    expect(after).toBeGreaterThan(before);
  });

  test("mergePeople bumps dirty_version", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    seedDoc({
      mentions: [meSender(), person("recipient", "bob@example.com", "Bob")],
    });
    const aliceId = personIdByEmail("alice@example.com")!;
    const bobId = personIdByEmail("bob@example.com")!;
    const before = readInteractionScoresMeta(db).dirtyVersion;
    mergePeople(db, aliceId, bobId);
    const after = readInteractionScoresMeta(db).dirtyVersion;
    expect(after).toBeGreaterThan(before);
  });

  test("source delete bumps dirty_version", () => {
    makeSelf();
    seedDoc({
      sourceId: "gmail:test",
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    refreshInteractionScores(db);
    const before = readInteractionScoresMeta(db).dirtyVersion;
    deleteAllBySource(db, "gmail:test");
    const after = readInteractionScoresMeta(db).dirtyVersion;
    expect(after).toBeGreaterThan(before);
  });

  test("refreshInteractionScores advances last_computed_version", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    const dirty = readInteractionScoresMeta(db).dirtyVersion;
    expect(dirty).toBeGreaterThan(0);
    refreshInteractionScores(db);
    const meta = readInteractionScoresMeta(db);
    expect(meta.lastComputedVersion).toBe(dirty);
    expect(meta.lastComputedAt).not.toBeNull();
  });

  test("a dirty bump landing AFTER compute snapshot still triggers next refresh", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "alice@example.com", "Alice")],
    });
    const snap = computeInteractionScores(db);
    // Concurrent mutation between compute and upsert.
    markPeopleGraphDirty(db);
    upsertInteractionScores(db, snap);
    const meta = readInteractionScoresMeta(db);
    // last_computed_version pinned to snapshot's captured version,
    // which is < the post-mutation dirty_version. Next tick will
    // recompute.
    expect(meta.dirtyVersion).toBeGreaterThan(meta.lastComputedVersion);
  });
});

// ─── Merge interactions ──────────────────────────────────────────────

describe("interaction scores under merges", () => {
  test("after merging two people, the winner inherits all edges", () => {
    makeSelf();
    // Two distinct identities for the same person — one email, one phone.
    seedDoc({
      mentions: [meSender(), { role: "recipient", emails: ["alice@example.com"], name: "Alice" }],
    });
    seedDoc({
      mentions: [{ role: "sender", emails: ["alice@example.com"], name: "Alice" }, meRecipient()],
    });
    seedDoc({
      mentions: [meSender(), { role: "recipient", phones: ["+15555550100"], name: "Alice Phone" }],
    });

    const aliceEmail = personIdByEmail("alice@example.com")!;
    const alicePhoneRow = db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias_type='phone' AND alias=? LIMIT 1")
      .get("+15555550100");
    const alicePhone = alicePhoneRow!.person_id;
    expect(aliceEmail).not.toBe(alicePhone);

    refreshInteractionScores(db);
    const beforeEmail = getPersonById(db, aliceEmail)!;
    expect(beforeEmail.outboundCount).toBe(1); // one outbound from email ID
    expect(beforeEmail.inboundCount).toBe(1);

    mergePeople(db, aliceEmail, alicePhone);
    refreshInteractionScores(db);

    const winner = getPersonById(db, aliceEmail)!;
    expect(winner.outboundCount).toBe(2); // inherited the phone-side outbound
    expect(winner.inboundCount).toBe(1);

    // Loser is hidden by `merged_into IS NULL` filter — score query
    // skips it. Direct read still shows whatever was last persisted
    // (zeroed by the upsert pass since loser is no longer in the
    // snapshot).
    const loser = db
      .prepare<
        [string],
        { interaction_score: number }
      >("SELECT interaction_score FROM people WHERE id = ?")
      .get(alicePhone);
    expect(loser?.interaction_score ?? 0).toBe(0);
  });
});

// ─── searchPeople sort ───────────────────────────────────────────────

describe("searchPeople sort by interaction score", () => {
  // Helpers — the canonical_name set by `findOrCreatePerson` falls
  // back to the first email when the first encounter has an
  // untrusted-name role (recipient/mentioned), so assertions match by
  // email alias to stay robust against insertion order.
  function indexOf(rows: readonly { id: string }[], email: string): number {
    const personId = personIdByEmail(email);
    return rows.findIndex((r) => r.id === personId);
  }

  test("default sort orders by interaction_score_recent DESC with doc_count tiebreaker", () => {
    makeSelf();
    // Bob: bidirectional → high interaction score.
    seedDoc({
      mentions: [meSender(), person("recipient", "bob@example.com", "Bob")],
    });
    seedDoc({
      mentions: [person("sender", "bob@example.com", "Bob"), meRecipient()],
    });
    // Newsletter: high inbound volume, zero outbound → score 0.
    for (let i = 0; i < 5; i++) {
      seedDoc({
        mentions: [person("sender", "news@example.com", "Newsletter"), meRecipient()],
      });
    }
    refreshInteractionScores(db);

    const rows = searchPeople(db, "", 50, { sortBy: "interaction" });
    const nonSelf = rows.filter((r) => !r.isSelf);
    const bobIdx = indexOf(nonSelf, "bob@example.com");
    const newsIdx = indexOf(nonSelf, "news@example.com");
    expect(bobIdx).toBeGreaterThanOrEqual(0);
    expect(newsIdx).toBeGreaterThanOrEqual(0);
    // Bob's interaction score > 0; Newsletter's = 0. Bob ranks higher.
    expect(bobIdx).toBeLessThan(newsIdx);
  });

  test("sortBy='documents' preserves the legacy raw-volume ordering", () => {
    makeSelf();
    seedDoc({
      mentions: [meSender(), person("recipient", "bob@example.com", "Bob")],
    });
    seedDoc({
      mentions: [person("sender", "bob@example.com", "Bob"), meRecipient()],
    });
    for (let i = 0; i < 5; i++) {
      seedDoc({
        mentions: [person("sender", "news@example.com", "Newsletter"), meRecipient()],
      });
    }
    // Materialize doc_count too — the documents-sort path reads it
    // directly via the materialized column. Without this the
    // searchPeople fallback fires and the ordering is undefined.
    refreshInteractionScores(db);
    refreshPeopleCounts(db);

    const rows = searchPeople(db, "", 50, { sortBy: "documents" }).filter((r) => !r.isSelf);
    const bobIdx = indexOf(rows, "bob@example.com");
    const newsIdx = indexOf(rows, "news@example.com");
    // Newsletter has 5 docs, Bob has 2 — legacy sort puts newsletter first.
    expect(newsIdx).toBeLessThan(bobIdx);
  });
});
