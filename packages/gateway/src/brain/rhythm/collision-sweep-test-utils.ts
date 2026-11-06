// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invented fixtures for the collision sweep's parity and worker tests: the
 * ledgers its three arms read (loops with their people and documents,
 * observations over loops, temporal annotations, doc and person annotations,
 * settled judge runs), seeded with raw rows on the full gateway schema so the
 * shapes the finders see are the shapes production stores hold. Every value is
 * generated; nothing is taken from any real corpus.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import {
  synthesisAnnotationContradictionDedupeKey,
  synthesisCollisionDedupeKey,
} from "../run-payloads.js";
import {
  runCollisionSweepPass,
  type CollisionSweepDeps,
  type CollisionSweepPassResult,
} from "./collision-sweep-enqueuer.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export const FIXTURE_NOW = Date.parse("2026-07-02T10:00:00.000Z");
export const FIXTURE_SELF = "person-self";
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A deterministic PRNG, so the large fixture is the same rows on every run. */
export function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw-row writers over the full gateway schema. */
export function fixtureWriter(db: Db) {
  const insDoc = db.prepare(
    `INSERT OR IGNORE INTO documents (id, provider_id, source_id, external_id, title, content,
       content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'example', 'source-notes', ?, 'Invented note', 'invented body', 'h', ?, ?, ?, ?)`,
  );
  const insPerson = db.prepare(
    `INSERT OR IGNORE INTO people (id, canonical_name, merged_into, source, is_self, first_seen,
       last_seen, created_at, updated_at)
     VALUES (?, 'Invented Person', ?, 'example', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  );
  const insLoop = db.prepare(
    `INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title,
       deadline_json, created_at, last_update)
     VALUES (?, 'run-seed', ?, 0.8, ?, 'Invented task', ?, ?, ?)`,
  );
  const insLoopPerson = db.prepare(
    "INSERT OR IGNORE INTO open_loop_people (loop_id, person_id, role) VALUES (?, ?, ?)",
  );
  const insLoopDoc = db.prepare(
    "INSERT OR IGNORE INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)",
  );
  const insNode = db.prepare(
    `INSERT INTO knowledge_nodes (id, kind, owner_id, title, markdown, plain_text, revision,
       meaning_revision, meaning_hash, validity, metadata_json, fields_json, created_at, updated_at)
     VALUES (?, 'loop', ?, 'Invented task', '', '', 1, 1, 'h', 'current', '{}', '{}', 0, 0)`,
  );
  const insTomb = db.prepare(
    "INSERT INTO knowledge_node_tombstones (id, deleted_at) VALUES (?, 0)",
  );
  const insObs = db.prepare(
    `INSERT INTO observations (id, created_by_run, summary, state, shipped_at, created_at, updated_at)
     VALUES (?, 'run-seed', 'Invented observation', ?, ?, ?, ?)`,
  );
  const insObsLoop = db.prepare(
    "INSERT OR IGNORE INTO observation_related_loops (observation_id, loop_id) VALUES (?, ?)",
  );
  const insTemporal = db.prepare(
    `INSERT INTO temporal_annotations (id, interval_start_ms, interval_end_ms, precision,
       canonical, sentence, kind, created_by_run, created_at, updated_at, invalidated_at)
     VALUES (?, ?, ?, ?, NULL, 'Invented moment', NULL, 'run-seed', ?, ?, ?)`,
  );
  const insTemporalDoc = db.prepare(
    "INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, ?)",
  );
  const insAnno = (table: "doc_annotations" | "person_annotations", subjectColumn: string) =>
    db.prepare(
      `INSERT INTO ${table} (id, ${subjectColumn}, claim_type, claim_text, evidence_doc_id,
         evidence_quote, confidence, created_by_run, created_at, updated_at, invalidated_at)
       VALUES (?, ?, ?, ?, ?, 'an invented quote', 0.7, 'run-seed', ?, ?, ?)`,
    );
  const insDocAnno = insAnno("doc_annotations", "doc_id");
  const insPersonAnno = insAnno("person_annotations", "person_id");
  const insRun = db.prepare(
    `INSERT INTO cognition_runs (id, kind, payload_json, dedupe_key, status, next_attempt_at,
       enqueued_at, completed_at) VALUES (?, ?, '{}', ?, ?, 0, 0, ?)`,
  );
  let runSeq = 0;

  return {
    doc(id: string): void {
      insDoc.run(id, id, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);
    },
    person(id: string, mergedInto: string | null = null, isSelf = false): void {
      insPerson.run(id, mergedInto, isSelf ? 1 : 0);
    },
    loop(
      id: string,
      opts: {
        state?: string;
        importance?: number;
        deadline?: unknown;
        people?: Array<[string, "actor" | "involved"]>;
        docs?: string[];
        lastUpdate?: number;
      } = {},
    ): void {
      const touched = opts.lastUpdate ?? FIXTURE_NOW - DAY;
      insLoop.run(
        id,
        opts.state ?? "open",
        opts.importance ?? 0.5,
        opts.deadline === undefined ? null : JSON.stringify(opts.deadline),
        touched,
        touched,
      );
      for (const [personId, role] of opts.people ?? []) insLoopPerson.run(id, personId, role);
      for (const docId of opts.docs ?? []) insLoopDoc.run(id, docId);
    },
    /** A knowledge mirror for a loop, and optionally its tombstone (hidden). */
    mirror(loopId: string, tombstoned = false): void {
      insNode.run(loopId, loopId);
      if (tombstoned) insTomb.run(loopId);
    },
    observation(
      id: string,
      state: string,
      loopIds: string[],
      shippedAt: number | null = null,
    ): void {
      insObs.run(id, state, shippedAt, FIXTURE_NOW - DAY, FIXTURE_NOW - DAY);
      for (const loopId of loopIds) insObsLoop.run(id, loopId);
    },
    temporal(
      id: string,
      startMs: number,
      endMs: number,
      opts: {
        precision?: string;
        docs?: string[];
        updatedAt?: number;
        invalidatedAt?: number | null;
      } = {},
    ): void {
      const updated = opts.updatedAt ?? FIXTURE_NOW - DAY;
      insTemporal.run(
        id,
        startMs,
        endMs,
        opts.precision ?? "range",
        updated,
        updated,
        opts.invalidatedAt ?? null,
      );
      for (const docId of opts.docs ?? []) insTemporalDoc.run(id, docId);
    },
    docAnnotation(
      id: string,
      docId: string,
      claimType: string,
      claimText: string,
      opts: {
        evidence?: string;
        at?: number;
        updatedAt?: number | null;
        invalidatedAt?: number | null;
      } = {},
    ): void {
      insDocAnno.run(
        id,
        docId,
        claimType,
        claimText,
        opts.evidence ?? "doc-evidence",
        opts.at ?? FIXTURE_NOW - DAY,
        opts.updatedAt ?? null,
        opts.invalidatedAt ?? null,
      );
    },
    personAnnotation(
      id: string,
      personId: string,
      claimType: string,
      claimText: string,
      opts: {
        evidence?: string;
        at?: number;
        updatedAt?: number | null;
        invalidatedAt?: number | null;
      } = {},
    ): void {
      insPersonAnno.run(
        id,
        personId,
        claimType,
        claimText,
        opts.evidence ?? "doc-evidence",
        opts.at ?? FIXTURE_NOW - DAY,
        opts.updatedAt ?? null,
        opts.invalidatedAt ?? null,
      );
    },
    /** A settled (completed) collision judge run over a member set. */
    judged(memberIds: string[], completedAt: number, status = "completed"): void {
      insRun.run(
        `run-judged-${++runSeq}`,
        "synthesis",
        synthesisCollisionDedupeKey([...memberIds].sort().join(",")),
        status,
        completedAt,
      );
    },
    /** A settled annotation-contradiction judge run over a member set. */
    judgedContradiction(memberIds: string[], completedAt: number): void {
      insRun.run(
        `run-judged-${++runSeq}`,
        "synthesis",
        synthesisAnnotationContradictionDedupeKey([...memberIds].sort().join(",")),
        "completed",
        completedAt,
      );
    },
    otherRun(kind: string, dedupeKey: string, status: string): void {
      insRun.run(`run-other-${++runSeq}`, kind, dedupeKey, status, FIXTURE_NOW - DAY);
    },
  };
}

/**
 * The small fixture: one candidate on every key of every arm, plus the
 * exclusions each arm makes — self on a loop, a covering observation, a
 * settled verdict, a shared-document temporal pair, a coarse period, a dead
 * annotation.
 */
export function seedSmallFixture(db: Db): void {
  const w = fixtureWriter(db);
  w.person(FIXTURE_SELF, null, true);
  for (const id of ["doc-evidence", "doc-shared", "doc-a", "doc-b"]) w.doc(id);
  w.loop("loop-a", {
    importance: 0.9,
    people: [
      [FIXTURE_SELF, "actor"],
      ["person-p", "actor"],
    ],
  });
  w.loop("loop-b", {
    importance: 0.4,
    people: [
      [FIXTURE_SELF, "actor"],
      ["person-p", "involved"],
    ],
  });
  w.loop("loop-c", { importance: 0.6, docs: ["doc-shared"] });
  w.loop("loop-d", { importance: 0.3, docs: ["doc-shared"] });
  w.loop("loop-e", { importance: 0.7, deadline: { type: "by", date: "2026-07-20" } });
  w.loop("loop-f", { importance: 0.2, deadline: { type: "on_day", date: "2026-07-20" } });
  w.loop("loop-done", { state: "done", importance: 1, docs: ["doc-shared"] });
  w.observation("obs-covering", "live", ["loop-e", "loop-f"]);
  w.temporal("ta-trip", FIXTURE_NOW + 10 * DAY, FIXTURE_NOW + 17 * DAY);
  w.temporal("ta-deadline", FIXTURE_NOW + 12 * DAY, FIXTURE_NOW + 13 * DAY - 1, {
    precision: "day",
  });
  w.temporal("ta-same-1", FIXTURE_NOW + 3 * DAY, FIXTURE_NOW + 4 * DAY, { docs: ["doc-a"] });
  w.temporal("ta-same-2", FIXTURE_NOW + 3 * DAY, FIXTURE_NOW + 4 * DAY, { docs: ["doc-a"] });
  w.temporal("ta-year", FIXTURE_NOW, FIXTURE_NOW + 365 * DAY, { precision: "year" });
  w.docAnnotation("da-1", "doc-a", "status", "paid");
  w.docAnnotation("da-2", "doc-a", "Status", "unpaid", { at: FIXTURE_NOW - 2 * DAY });
  w.docAnnotation("da-dead", "doc-a", "status", "overdue", { invalidatedAt: FIXTURE_NOW });
  w.person("person-old", "person-p");
  w.person("person-p");
  w.personAnnotation("pa-1", "person-old", "role", "treasurer");
  w.personAnnotation("pa-2", "person-p", "role", "secretary");
}

/**
 * The edge fixture: every boundary the arms compare against, on both sides —
 * the horizon's ends, the span cap, invalidation, precision, hidden and
 * resolved loops, a shipped observation inside and past its cover, settled
 * verdicts before and after a member's update, a failed verdict, the group
 * member cap, dangling evidence, a three-hop merge chain.
 */
export function seedEdgeFixture(db: Db): void {
  const w = fixtureWriter(db);
  const H = FIXTURE_NOW + 60 * DAY;
  w.person(FIXTURE_SELF, null, true);
  for (const id of ["doc-evidence", "doc-x", "doc-y", "doc-z"]) w.doc(id);

  // Temporal boundaries. Each pair overlaps only its own partner.
  w.temporal("ta-end-at-now-a", FIXTURE_NOW - DAY, FIXTURE_NOW);
  w.temporal("ta-end-at-now-b", FIXTURE_NOW - 2 * HOUR, FIXTURE_NOW + HOUR);
  w.temporal("ta-end-before-now-a", FIXTURE_NOW - 3 * DAY, FIXTURE_NOW - 1);
  w.temporal("ta-end-before-now-b", FIXTURE_NOW - 2 * DAY, FIXTURE_NOW - 1);
  w.temporal("ta-start-at-horizon-a", H, H + DAY);
  w.temporal("ta-start-at-horizon-b", H - DAY, H + HOUR);
  w.temporal("ta-start-past-horizon-a", H + 1, H + DAY);
  w.temporal("ta-start-past-horizon-b", H + 1, H + 2 * DAY);
  w.temporal("ta-span-cap-a", FIXTURE_NOW + 70 * DAY - 35 * DAY, FIXTURE_NOW + 70 * DAY);
  w.temporal("ta-span-cap-b", FIXTURE_NOW + 50 * DAY, FIXTURE_NOW + 51 * DAY);
  w.temporal("ta-span-over-a", FIXTURE_NOW + 80 * DAY - 35 * DAY - 1, FIXTURE_NOW + 80 * DAY);
  w.temporal("ta-span-over-b", FIXTURE_NOW + 46 * DAY, FIXTURE_NOW + 46 * DAY + HOUR);
  w.temporal("ta-touch-a", FIXTURE_NOW + 20 * DAY, FIXTURE_NOW + 21 * DAY);
  w.temporal("ta-touch-b", FIXTURE_NOW + 21 * DAY, FIXTURE_NOW + 22 * DAY);
  w.temporal("ta-gap-a", FIXTURE_NOW + 24 * DAY, FIXTURE_NOW + 25 * DAY);
  w.temporal("ta-gap-b", FIXTURE_NOW + 25 * DAY + 1, FIXTURE_NOW + 26 * DAY);
  w.temporal("ta-invalid-a", FIXTURE_NOW + 30 * DAY, FIXTURE_NOW + 31 * DAY, {
    invalidatedAt: FIXTURE_NOW,
  });
  w.temporal("ta-invalid-b", FIXTURE_NOW + 30 * DAY, FIXTURE_NOW + 31 * DAY);
  w.temporal("ta-month-a", FIXTURE_NOW + 33 * DAY, FIXTURE_NOW + 34 * DAY, { precision: "month" });
  w.temporal("ta-month-b", FIXTURE_NOW + 33 * DAY, FIXTURE_NOW + 34 * DAY);
  w.temporal("ta-settled-a", FIXTURE_NOW + 36 * DAY, FIXTURE_NOW + 37 * DAY, {
    updatedAt: FIXTURE_NOW - 5 * DAY,
  });
  w.temporal("ta-settled-b", FIXTURE_NOW + 36 * DAY, FIXTURE_NOW + 37 * DAY, {
    updatedAt: FIXTURE_NOW - 5 * DAY,
  });
  w.judged(["ta-settled-a", "ta-settled-b"], FIXTURE_NOW - 4 * DAY);
  w.temporal("ta-reopened-a", FIXTURE_NOW + 38 * DAY, FIXTURE_NOW + 39 * DAY, {
    updatedAt: FIXTURE_NOW - DAY,
  });
  w.temporal("ta-reopened-b", FIXTURE_NOW + 38 * DAY, FIXTURE_NOW + 39 * DAY, {
    updatedAt: FIXTURE_NOW - 5 * DAY,
  });
  w.judged(["ta-reopened-a", "ta-reopened-b"], FIXTURE_NOW - 2 * DAY);
  w.temporal("ta-failed-a", FIXTURE_NOW + 40 * DAY, FIXTURE_NOW + 41 * DAY);
  w.temporal("ta-failed-b", FIXTURE_NOW + 40 * DAY, FIXTURE_NOW + 41 * DAY);
  w.judged(["ta-failed-a", "ta-failed-b"], FIXTURE_NOW, "failed");
  w.temporal("ta-doc-a", FIXTURE_NOW + 42 * DAY, FIXTURE_NOW + 43 * DAY, {
    docs: ["doc-x", "doc-y"],
  });
  w.temporal("ta-doc-b", FIXTURE_NOW + 42 * DAY, FIXTURE_NOW + 43 * DAY, { docs: ["doc-y"] });
  w.temporal("ta-doc-c", FIXTURE_NOW + 42 * DAY, FIXTURE_NOW + 43 * DAY, { docs: ["doc-z"] });
  // Ties on the overlap start order by id.
  for (const id of ["ta-tie-c", "ta-tie-a", "ta-tie-b"])
    w.temporal(id, FIXTURE_NOW + 44 * DAY, FIXTURE_NOW + 44 * DAY + HOUR);

  // Loops: a group past the member cap, hidden and resolved members, a
  // shipped observation inside and past its cover, settled verdicts.
  for (let i = 0; i < 11; i++)
    w.loop(`loop-wide-${String(i).padStart(2, "0")}`, {
      importance: (i % 6) / 10,
      people: [["person-landlord", i % 2 === 0 ? "actor" : "involved"]],
    });
  w.loop("loop-hidden-1", { importance: 1, docs: ["doc-z"] });
  w.loop("loop-hidden-2", { importance: 1, docs: ["doc-z"] });
  w.mirror("loop-hidden-1", true);
  w.mirror("loop-hidden-2");
  w.loop("loop-snoozed", { state: "snoozed", importance: 0.95, docs: ["doc-x"] });
  w.loop("loop-dismissed", { state: "dismissed", importance: 1, docs: ["doc-x"] });
  w.loop("loop-open-x", { importance: 0.1, docs: ["doc-x"] });
  w.loop("loop-ship-a", { importance: 0.85, docs: ["doc-y"] });
  w.loop("loop-ship-b", { importance: 0.85, docs: ["doc-y"] });
  w.observation(
    "obs-shipped-recent",
    "shipped",
    ["loop-ship-a", "loop-ship-b"],
    FIXTURE_NOW - 14 * DAY,
  );
  w.loop("loop-old-a", { importance: 0.84, deadline: { type: "by", date: "2026-08-01" } });
  w.loop("loop-old-b", { importance: 0.84, deadline: { type: "on_day", date: "2026-08-01" } });
  w.observation(
    "obs-shipped-old",
    "shipped",
    ["loop-old-a", "loop-old-b"],
    FIXTURE_NOW - 14 * DAY - 1,
  );
  w.loop("loop-drop-a", { importance: 0.83, people: [["person-q", "actor"]] });
  w.loop("loop-drop-b", { importance: 0.83, people: [["person-q", "actor"]] });
  w.observation("obs-dropped", "dropped", ["loop-drop-a", "loop-drop-b"]);
  w.loop("loop-v-a", {
    importance: 0.82,
    people: [["person-v", "actor"]],
    lastUpdate: FIXTURE_NOW - 5 * DAY,
  });
  w.loop("loop-v-b", {
    importance: 0.82,
    people: [["person-v", "actor"]],
    lastUpdate: FIXTURE_NOW - 5 * DAY,
  });
  w.judged(["loop-v-a", "loop-v-b"], FIXTURE_NOW - 5 * DAY);
  w.loop("loop-w-a", {
    importance: 0.81,
    people: [["person-w", "actor"]],
    lastUpdate: FIXTURE_NOW - DAY,
  });
  w.loop("loop-w-b", {
    importance: 0.81,
    people: [["person-w", "actor"]],
    lastUpdate: FIXTURE_NOW - 5 * DAY,
  });
  w.judged(["loop-w-a", "loop-w-b"], FIXTURE_NOW - 2 * DAY);
  w.loop("loop-self-a", { importance: 0.99, people: [[FIXTURE_SELF, "actor"]] });
  w.loop("loop-self-b", { importance: 0.99, people: [[FIXTURE_SELF, "involved"]] });
  w.loop("loop-bad-deadline", { importance: 0.5, deadline: "not a deadline" });

  // Annotations: a group past the member cap whose freshest rows agree, a
  // dangling evidence document, a three-hop merge chain, a settled group.
  for (let i = 0; i < 10; i++)
    w.docAnnotation(`da-cap-${i}`, "doc-x", "owner", i < 9 ? "the studio" : "the venue", {
      at: FIXTURE_NOW - (i < 9 ? 10 - i : 30) * DAY,
    });
  w.docAnnotation("da-dangling-1", "doc-y", "amount", "40", { evidence: "doc-gone" });
  w.docAnnotation("da-dangling-2", "doc-y", "amount", "45");
  w.docAnnotation("da-settled-1", "doc-z", "due date", "Friday", { at: FIXTURE_NOW - 9 * DAY });
  w.docAnnotation("da-settled-2", "doc-z", "due date", "Monday", { at: FIXTURE_NOW - 9 * DAY });
  w.judgedContradiction(["da-settled-1", "da-settled-2"], FIXTURE_NOW - 8 * DAY);
  w.person("person-c");
  w.person("person-b", "person-c");
  w.person("person-a", "person-b");
  w.person("person-z", "person-a");
  w.personAnnotation("pa-chain-1", "person-z", "location", "north office");
  w.personAnnotation("pa-chain-2", "person-c", "location", "south office", {
    at: FIXTURE_NOW - 3 * DAY,
  });
  w.personAnnotation("pa-chain-3", "person-b", "location", "north office", {
    updatedAt: FIXTURE_NOW,
  });
}

/** The large fixture: hundreds of loops, a long temporal history, many groups. */
export function seedLargeFixture(db: Db, scale = 1): void {
  const w = fixtureWriter(db);
  const random = seededRandom(0x0c0111de);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const n = (count: number) => Math.max(1, Math.round(count * scale));
  const docs = n(600);
  const people = n(200);
  w.person(FIXTURE_SELF, null, true);
  for (let i = 0; i < docs; i++) w.doc(`doc-${i}`);
  for (let i = 0; i < people; i++)
    w.person(`person-${i}`, i > 5 && i % 9 === 0 ? `person-${int(i)}` : null);

  const loopIds: string[] = [];
  for (let i = 0; i < n(400); i++) {
    const id = `loop-${i}`;
    loopIds.push(id);
    w.loop(id, {
      state: pick(["open", "open", "open", "snoozed", "done", "dismissed"]),
      importance: Math.round(random() * 20) / 20,
      deadline:
        random() < 0.4
          ? {
              type: pick(["by", "on_day"]),
              date: new Date(FIXTURE_NOW + (int(90) - 20) * DAY).toISOString().slice(0, 10),
            }
          : undefined,
      people: [
        [FIXTURE_SELF, "actor"],
        ...Array.from(
          { length: 1 + int(2) },
          () =>
            [`person-${int(people)}`, pick(["actor", "involved"] as const)] as [
              string,
              "actor" | "involved",
            ],
        ),
      ],
      docs: Array.from({ length: 1 + int(2) }, () => `doc-${int(docs)}`),
      lastUpdate: FIXTURE_NOW - int(30) * DAY,
    });
    if (random() < 0.2) w.mirror(id, random() < 0.1);
  }
  for (let i = 0; i < n(40); i++)
    w.observation(
      `obs-${i}`,
      pick(["live", "held", "shipped", "dropped"]),
      Array.from({ length: 2 + int(3) }, () => pick(loopIds)),
      FIXTURE_NOW - int(30) * DAY,
    );
  for (let i = 0; i < n(80); i++)
    w.judged([pick(loopIds), pick(loopIds)].sort(), FIXTURE_NOW - int(30) * DAY);

  const temporalIds: string[] = [];
  for (let i = 0; i < n(1500); i++) {
    const id = `ta-${i}`;
    temporalIds.push(id);
    const future = random() < 0.15;
    const start = future
      ? FIXTURE_NOW - 2 * DAY + int(80 * 24) * HOUR
      : FIXTURE_NOW - int(3 * 365 * 24) * HOUR;
    const precision = pick(["day", "day", "hour", "week", "range", "month", "year"]);
    const span =
      precision === "hour"
        ? HOUR
        : precision === "day"
          ? DAY - 1
          : precision === "week"
            ? 7 * DAY
            : precision === "range"
              ? (1 + int(40)) * DAY
              : precision === "month"
                ? 30 * DAY
                : 365 * DAY;
    w.temporal(id, start, start + span, {
      precision,
      docs: Array.from({ length: int(3) }, () => `doc-${int(docs)}`),
      updatedAt: FIXTURE_NOW - int(20) * DAY,
      invalidatedAt: random() < 0.05 ? FIXTURE_NOW - DAY : null,
    });
  }
  for (let i = 0; i < n(60); i++)
    w.judged([pick(temporalIds), pick(temporalIds)].sort(), FIXTURE_NOW - int(20) * DAY);

  const claimTypes = ["status", "Status", "owner", "amount", "due date", "location"];
  const docAnnotationIds: string[] = [];
  for (let i = 0; i < n(500); i++) {
    const id = `da-${i}`;
    docAnnotationIds.push(id);
    const at = FIXTURE_NOW - int(200) * DAY;
    w.docAnnotation(
      id,
      `doc-${int(Math.round(docs / 5))}`,
      pick(claimTypes),
      `${pick(["paid", "unpaid", "the studio", "Friday"])}`,
      {
        evidence: random() < 0.04 ? `doc-missing-${i}` : `doc-${int(docs)}`,
        at,
        updatedAt: random() < 0.5 ? at + DAY : null,
        invalidatedAt: random() < 0.1 ? at + 2 * DAY : null,
      },
    );
  }
  for (let i = 0; i < n(300); i++) {
    const at = FIXTURE_NOW - int(200) * DAY;
    w.personAnnotation(
      `pa-${i}`,
      `person-${int(people)}`,
      pick(claimTypes),
      `${pick(["north", "south", "treasurer"])}`,
      {
        evidence: `doc-${int(docs)}`,
        at,
        updatedAt: random() < 0.5 ? at + DAY : null,
        invalidatedAt: random() < 0.1 ? at + 2 * DAY : null,
      },
    );
  }
  for (let i = 0; i < n(30); i++)
    w.judgedContradiction(
      [pick(docAnnotationIds), pick(docAnnotationIds)],
      FIXTURE_NOW - int(100) * DAY,
    );
  for (let i = 0; i < n(200); i++)
    w.otherRun(pick(["daily", "event", "decay"]), `example:${i}`, pick(["completed", "failed"]));
}

export interface RecordedRun {
  id: string;
  kind: string;
  payload: unknown;
  dedupeKey: string | undefined;
  now: number;
}

/** A write gate that records what the sweep enqueues and the marker it stamps. */
export function recordingWriteGate(): {
  gate: CollisionSweepDeps["writeGate"];
  runs: RecordedRun[];
  markers: Array<[string, string]>;
} {
  const runs: RecordedRun[] = [];
  const markers: Array<[string, string]> = [];
  const gate = {
    enqueueCognitionRun: (
      input: { id: string; kind: string; payload?: unknown; dedupeKey?: string },
      now: number,
    ) => {
      runs.push({
        id: input.id,
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        now,
      });
      return Promise.resolve({ outcome: "inserted", runId: input.id, nextAttemptAt: now });
    },
    setCognitionEngineState: (key: string, value: string) => {
      markers.push([key, value]);
      return Promise.resolve();
    },
  } as unknown as CollisionSweepDeps["writeGate"];
  return { gate, runs, markers };
}

export interface SweepArms {
  loops: boolean;
  contradictions: boolean;
  maxPerSweep: number;
  contradictionsMax: number;
  horizonDays?: number;
}

/** One sweep pass with deterministic run ids, as the rhythm task calls it. */
export async function recordSweep(
  db: Db,
  arms: SweepArms,
  extra: Partial<CollisionSweepDeps> = {},
): Promise<{
  result: CollisionSweepPassResult;
  runs: RecordedRun[];
  markers: Array<[string, string]>;
}> {
  const { gate, runs, markers } = recordingWriteGate();
  let seq = 0;
  const result = await runCollisionSweepPass({
    db,
    writeGate: gate,
    clock: () => FIXTURE_NOW,
    getCadenceHours: () => 24,
    getMaxPerSweep: () => arms.maxPerSweep,
    getSelfPersonId: () => FIXTURE_SELF,
    getTimeHorizonDays: () => arms.horizonDays ?? 60,
    getLoopCollisionsEnabled: () => arms.loops,
    getAnnotationContradictionsEnabled: () => arms.contradictions,
    getAnnotationContradictionsMaxPerSweep: () => arms.contradictionsMax,
    log: createLogger("test").child("collision-parity"),
    idGen: () => `p${++seq}`,
    ...extra,
  });
  return { result, runs, markers };
}

/** A list summarized for a golden: its size, a digest, and its head. */
export function digestList(
  items: readonly unknown[],
  head = 8,
): {
  count: number;
  sha256: string;
  head: unknown[];
} {
  return {
    count: items.length,
    sha256: createHash("sha256").update(JSON.stringify(items)).digest("hex"),
    head: items.slice(0, head),
  };
}
