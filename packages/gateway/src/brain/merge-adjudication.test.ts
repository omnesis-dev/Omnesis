// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the merge-adjudication steward surface:
 *
 *   - runMergeAdjudicationEnqueuePass: per-candidate dedupe key,
 *     adjudicated/re-detected filtering, self skip, cadence gate,
 *     per-pass cap
 *   - buildMergeAdjudicationTool: deps-scoped candidate/run ids,
 *     structured result, arg validation
 *   - buildMergeAdjudicationEvidence: candidate + side markers,
 *     contact-card co-occurrence count, multi-resolution note
 *
 * applyMergeAdjudication itself (writer guards, rule creation) is
 * covered in merge-candidates.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";

import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import {
  currentEvidenceFingerprint,
  listAllMergeCandidates,
  upsertMergeCandidates,
  MERGE_ADJUDICATION_MAX_PER_CANDIDATE,
  type ApplyMergeAdjudicationInput,
  type MergeCandidateRow,
} from "../merge-candidates.js";
import { listCognitionRuns } from "./storage/run-queue.js";
import { mergeAdjudicationRunDedupeKey } from "./run-payloads.js";
import {
  buildMergeAdjudicationEvidence,
  buildMergeAdjudicationTool,
  runMergeAdjudicationEnqueuePass,
  MERGE_ADJUDICATION_CADENCE_MS,
  MERGE_ADJUDICATION_MAX_PER_PASS,
} from "./merge-adjudication.js";

const log = createLogger("test").child("merge-adjudication");

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-madj-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

function makePerson(opts: { name?: string; emails?: string[]; isSelf?: boolean }): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people
       (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, opts.name ?? "Unknown", opts.isSelf ? 1 : 0);
  for (const email of opts.emails ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'email', '2026-01-01')`,
    ).run(randomUUID(), id, email);
  }
  if (opts.name) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', '2026-01-01', 1, 1)`,
    ).run(randomUUID(), id, opts.name);
  }
  return id;
}

/** Upsert one pending candidate between two email aliases; returns its row. */
function makeCandidate(aliasA: string, aliasB: string): MergeCandidateRow {
  upsertMergeCandidates(db, [
    {
      sideA: { aliasType: "email", alias: aliasA },
      sideB: { aliasType: "email", alias: aliasB },
      score: 0.8,
      matchedTokens: ["shared"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    },
  ]);
  // The upsert canonicalizes side order, so the pair may come back flipped.
  const cand = listAllMergeCandidates(db, "pending").find(
    (c) =>
      (c.sideA.alias === aliasA && c.sideB.alias === aliasB) ||
      (c.sideA.alias === aliasB && c.sideB.alias === aliasA),
  );
  if (!cand) throw new Error(`candidate ${aliasA} ↔ ${aliasB} not found after upsert`);
  return cand;
}

/**
 * Model a settled adjudication: the verdict, and the fingerprint of the
 * evidence it was passed on. `evidenceFingerprint: null` models a row judged
 * before the column existed.
 */
function stampAdjudication(
  candidateId: string,
  detectedAt: string,
  adjudicatedAt: string,
  opts: { evidenceFingerprint?: string | null; count?: number } = {},
): void {
  const cand = listAllMergeCandidates(db, "pending").find((c) => c.id === candidateId);
  if (!cand) throw new Error(`candidate ${candidateId} not found`);
  const fingerprint =
    opts.evidenceFingerprint === undefined
      ? currentEvidenceFingerprint(cand)
      : opts.evidenceFingerprint;
  db.prepare(
    `UPDATE merge_candidates
        SET detected_at = ?, adjudicated_at = ?, adjudication_verdict = 'unsure',
            adjudication_reason = 'stamped by test',
            adjudication_evidence_fingerprint = ?, adjudication_count = ?
      WHERE id = ?`,
  ).run(detectedAt, adjudicatedAt, fingerprint, opts.count ?? 1, candidateId);
}

/** Rewrite a candidate's evidence in place, as a later detector pass would. */
function restateEvidence(
  candidateId: string,
  evidence: { score?: number; matchedTokens?: string[]; matchStrength?: number | null },
): void {
  const cand = listAllMergeCandidates(db, "pending").find((c) => c.id === candidateId);
  if (!cand) throw new Error(`candidate ${candidateId} not found`);
  db.prepare(
    "UPDATE merge_candidates SET score = ?, matched_tokens = ?, match_strength = ? WHERE id = ?",
  ).run(
    evidence.score ?? cand.score,
    JSON.stringify(evidence.matchedTokens ?? cand.matchedTokens),
    evidence.matchStrength === undefined ? cand.matchStrength : evidence.matchStrength,
    candidateId,
  );
}

function insertDoc(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', 'test', ?, 'Shared Contact Card', 'c', ?, '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, id, `hash-${id}`);
}

function insertDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, 'test')`,
  ).run(docId, personId, role);
}

function enqueuePassDeps(nowRef: { now: number }) {
  return {
    db,
    writeGate: directWriteGate(db),
    clock: () => nowRef.now,
    log,
  };
}

function adjudicationRuns() {
  return listCognitionRuns(db, { kinds: ["merge_adjudication"] });
}

// ─── runMergeAdjudicationEnqueuePass ────────────────────────────────

describe("runMergeAdjudicationEnqueuePass", () => {
  test("enqueues one run per pending candidate, keyed on the candidate id", async () => {
    makePerson({ name: "Maya Reeves", emails: ["maya@example.com"] });
    makePerson({ name: "Maya R", emails: ["m.reeves@example.org"] });
    const cand = makeCandidate("maya@example.com", "m.reeves@example.org");

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(1);

    const runs = adjudicationRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("merge_adjudication");
    expect(runs[0].dedupeKey).toBe(mergeAdjudicationRunDedupeKey(cand.id));
    expect(runs[0].dedupeKey).toBe(`merge-adjudication:candidate:${cand.id}`);
    expect(runs[0].payload).toEqual({ candidateId: cand.id });
    expect(runs[0].status).toBe("pending");
  });

  test("skips an already-adjudicated candidate; re-enqueues one whose evidence changed", async () => {
    const settled = makeCandidate("david@example.com", "d.lin@example.org");
    const changed = makeCandidate("nora@example.com", "n.bond@example.org");
    stampAdjudication(settled.id, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    stampAdjudication(changed.id, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    // A second shared name token is new evidence about this pair.
    restateEvidence(changed.id, { matchedTokens: ["shared", "bond"] });

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(1);

    const runs = adjudicationRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].payload).toEqual({ candidateId: changed.id });
  });

  test("a judged candidate re-detected with the same evidence is NOT re-enqueued", async () => {
    // The live loop this closes: a corpus-wide IDF score drifts in its far
    // decimals on every detector pass, detected_at was bumped, and one
    // candidate the agent could only answer `unsure` was re-judged 26 times
    // in a week. Nothing about the pair had changed.
    const cand = makeCandidate("aria@example.com", "a.stone@example.org");
    stampAdjudication(cand.id, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    // Detector runs again: detected_at moves forward, evidence does not.
    db.prepare("UPDATE merge_candidates SET detected_at = ? WHERE id = ?").run(
      "2026-06-09T00:00:00.000Z",
      cand.id,
    );

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(0);
    expect(adjudicationRuns()).toHaveLength(0);
  });

  test("sub-precision score drift alone does not re-open a verdict", async () => {
    const cand = makeCandidate("theo@example.com", "t.marsh@example.org");
    restateEvidence(cand.id, { score: 0.9424916782930021, matchStrength: 1.4 });
    stampAdjudication(cand.id, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    restateEvidence(cand.id, { score: 0.9424916782930044, matchStrength: 1.4000000000000004 });

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(0);
  });

  test("a verdict from before fingerprints existed covers the current evidence", async () => {
    const cand = makeCandidate("kai@example.com", "k.oduya@example.org");
    stampAdjudication(cand.id, "2026-06-09T00:00:00.000Z", "2026-06-02T00:00:00.000Z", {
      evidenceFingerprint: null,
    });

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(0);
  });

  test("the per-candidate ceiling stops re-judging even when evidence keeps moving", async () => {
    const cand = makeCandidate("rue@example.com", "r.calder@example.org");
    stampAdjudication(cand.id, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z", {
      count: MERGE_ADJUDICATION_MAX_PER_CANDIDATE,
    });
    restateEvidence(cand.id, { matchedTokens: ["shared", "calder"] });

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(0);
  });

  test("skips a candidate whose side resolves to the self person", async () => {
    makePerson({ name: "Jamie Lopez", emails: ["jamie@example.com"], isSelf: true });
    makePerson({ name: "Carla Vance", emails: ["carla@example.com"] });
    makePerson({ name: "Carla V", emails: ["c.vance@example.org"] });
    const selfCand = makeCandidate("jamie@example.com", "j.lopez@example.org");
    const normalCand = makeCandidate("carla@example.com", "c.vance@example.org");

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(1);

    const runs = adjudicationRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].payload).toEqual({ candidateId: normalCand.id });
    expect(runs.find((r) => r.dedupeKey === mergeAdjudicationRunDedupeKey(selfCand.id))).toBe(
      undefined,
    );
  });

  test("cadence gate: a second pass inside the cadence window fires 0", async () => {
    makeCandidate("maya@example.com", "m.reeves@example.org");
    const nowRef = { now: 5_000_000 };
    const deps = enqueuePassDeps(nowRef);

    expect((await runMergeAdjudicationEnqueuePass(deps)).fired).toBe(1);
    // Immediately after — and just under the cadence — nothing fires.
    expect((await runMergeAdjudicationEnqueuePass(deps)).fired).toBe(0);
    nowRef.now += MERGE_ADJUDICATION_CADENCE_MS - 1;
    expect((await runMergeAdjudicationEnqueuePass(deps)).fired).toBe(0);
    expect(adjudicationRuns()).toHaveLength(1);

    // At the cadence boundary the pass runs again; the still-pending
    // candidate folds into its existing pending row.
    nowRef.now += 1;
    expect((await runMergeAdjudicationEnqueuePass(deps)).fired).toBe(1);
    expect(adjudicationRuns()).toHaveLength(1);
  });

  test("per-pass cap: cap+2 due candidates yield exactly cap runs", async () => {
    const cap = MERGE_ADJUDICATION_MAX_PER_PASS;
    for (let i = 0; i < cap + 2; i++) {
      makeCandidate(`person${i}@example.com`, `person.${i}@example.org`);
    }

    const res = await runMergeAdjudicationEnqueuePass(enqueuePassDeps({ now: 1_000_000 }));
    expect(res.fired).toBe(cap);
    expect(listCognitionRuns(db, { kinds: ["merge_adjudication"], limit: cap + 10 })).toHaveLength(
      cap,
    );
  });
});

// ─── buildMergeAdjudicationTool ─────────────────────────────────────

describe("buildMergeAdjudicationTool", () => {
  function makeTool(candidateId = "cand_test_1") {
    const captured: ApplyMergeAdjudicationInput[] = [];
    const tool = buildMergeAdjudicationTool({
      db,
      writeGate: {
        applyMergeAdjudication: async (input) => {
          captured.push(input);
          return { outcome: "merged" as const, ruleId: "r1" };
        },
      },
      runId: "run_test_1",
      candidateId,
      log,
    });
    return { tool, captured };
  }

  test("passes the deps candidate + run ids through and returns the outcome", async () => {
    const pa = makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    const pb = makePerson({ name: "Maya Reeves", emails: ["maya.reeves@northstar.example"] });
    const cand = makeCandidate("mreeves@example.com", "maya.reeves@northstar.example");
    const { tool, captured } = makeTool(cand.id);
    const res = await tool.invoke({
      verdict: "merge",
      reason: "Both handles share the same distinctive surname and thread history.",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].candidateId).toBe(cand.id);
    expect(captured[0].runId).toBe("run_test_1");
    expect(captured[0].verdict).toBe("merge");
    // The verdict-time resolution fingerprint rides along, so the writer can
    // refuse the merge if the alias resolution drifts before apply.
    expect(new Set(captured[0].expectedPersonIds)).toEqual(new Set([pa, pb]));

    expect(res.kind).toBe("structured");
    if (res.kind !== "structured") throw new Error("expected structured result");
    expect(res.data).toMatchObject({
      candidateId: cand.id,
      verdict: "merge",
      outcome: "merged",
    });
  });

  test("rejects a too-short reason without touching the write gate", async () => {
    const { tool, captured } = makeTool();
    const res = await tool.invoke({ verdict: "distinct", reason: "nope" });
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error result");
    expect(res.code).toBe("invalid_args");
    expect(captured).toHaveLength(0);
  });

  test("rejects model-supplied extra keys (candidate id is not model-selectable)", async () => {
    const { tool, captured } = makeTool();
    const res = await tool.invoke({
      verdict: "merge",
      reason: "A long enough rationale for the schema.",
      candidateId: "cand_someone_elses",
    });
    expect(res.kind).toBe("error");
    expect(captured).toHaveLength(0);
  });
});

// ─── buildMergeAdjudicationEvidence ─────────────────────────────────

describe("buildMergeAdjudicationEvidence", () => {
  test("contains the candidate id, both side aliases, and the co-occurrence line", () => {
    makePerson({ name: "Maya Reeves", emails: ["maya@example.com"] });
    makePerson({ name: "M Reeves", emails: ["m.reeves@example.org"] });
    const cand = makeCandidate("maya@example.com", "m.reeves@example.org");

    const evidence = buildMergeAdjudicationEvidence(db, cand);
    expect(evidence).toContain(cand.id);
    expect(evidence).toContain("maya@example.com");
    expect(evidence).toContain("m.reeves@example.org");
    expect(evidence).toContain("Cross-side co-occurrence");
    expect(evidence).toContain("0 shared contact-card doc(s)");
  });

  test("counts a shared contact-role document as SAME-person co-occurrence", () => {
    const a = makePerson({ name: "David Lin", emails: ["david@example.com"] });
    const b = makePerson({ name: "D Lin", emails: ["d.lin@example.org"] });
    const cand = makeCandidate("david@example.com", "d.lin@example.org");

    insertDoc("doc-contact-1");
    insertDocPerson("doc-contact-1", a, "contact");
    insertDocPerson("doc-contact-1", b, "to");

    const evidence = buildMergeAdjudicationEvidence(db, cand);
    expect(evidence).toContain("1 shared contact-card doc(s)");
  });

  test("flags a side resolving to multiple people with the NOTE line", () => {
    makePerson({ name: "Nora Bond", emails: ["shared@example.com"] });
    makePerson({ name: "Nora B", emails: ["shared@example.com"] });
    makePerson({ name: "Carla Vance", emails: ["carla@example.com"] });
    const cand = makeCandidate("shared@example.com", "carla@example.com");

    const evidence = buildMergeAdjudicationEvidence(db, cand);
    expect(evidence).toContain("NOTE");
    expect(evidence).toContain("2 SEPARATE people");
  });
});
