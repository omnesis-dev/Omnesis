// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit coverage for the delta-prime block builders. Asserts the two hard
 * contracts (own-state only, never raw source data — enforced structurally
 * by the projections) plus the source filter, active-state filter, the
 * display caps, and the due-soon prime's due/touched windows.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { createOpenLoop, updateOpenLoop, appendOpenLoopLedger } from "../storage/open-loops.js";
import { createBrief } from "../storage/briefs.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { createPersonAnnotation } from "../storage/person-annotations.js";
import { resolveBrainSettings, type ResolvedBrainSettings } from "../config.js";
import { cognitionSpendDay } from "../storage/spend.js";
import {
  buildSourceDeltaPrime,
  buildDueSoonDeltaPrime,
  buildSynthesisDeltaPrime,
} from "./delta-prime.js";
import type Database from "better-sqlite3";
import type { OpenLoopState } from "../storage/types.js";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function cfgWith(overrides: Partial<ResolvedBrainSettings> = {}): ResolvedBrainSettings {
  return { ...resolveBrainSettings(), ...overrides };
}

describe("delta-prime builders", () => {
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

  /** Insert a source document and return its internal id. */
  function insertDoc(externalId: string, sourceId: string, content = "c"): string {
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId(sourceId),
        externalId,
        title: "src-doc",
        content,
        contentHash: `h-${externalId}`,
        sourceCreatedAt: "2026-07-01T09:00:00.000Z",
        sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId);
    if (!row) throw new Error("insert failed");
    return row.id;
  }

  function seedLoop(opts: {
    id: string;
    title: string;
    docs: string[];
    importance?: number;
    state?: OpenLoopState;
    deadline?: unknown;
    at?: number;
  }): void {
    createOpenLoop(
      db,
      {
        id: opts.id,
        createdByRun: "run_prior",
        title: opts.title,
        confidence: 0.7,
        importance: opts.importance ?? 0.5,
        docs: opts.docs,
        ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      },
      opts.at ?? NOW - 2 * DAY,
    );
    if (opts.state && opts.state !== "open") {
      updateOpenLoop(db, opts.id, { state: opts.state }, opts.at ?? NOW - 2 * DAY);
    }
  }

  test("a source loop appears for its source; a different source's loop is excluded", () => {
    const docX = insertDoc("x1", "source-x");
    const docY = insertDoc("y1", "source-y");
    seedLoop({ id: "loop_x", title: "Reconcile the invoice", docs: [docX] });
    seedLoop({ id: "loop_y", title: "Reply to the landlord", docs: [docY] });

    // An empty decisions window isolates the source-scoped tracked-loops
    // section (recent decisions are deliberately cross-source).
    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-x",
      fromMs: 1,
      toMs: 2,
      now: NOW,
      cfg: cfgWith(),
    });
    expect(prime).toContain("Your current model");
    expect(prime).toContain("loop_x");
    expect(prime).toContain("Reconcile the invoice");
    expect(prime).not.toContain("loop_y");
    expect(prime).not.toContain("Reply to the landlord");
  });

  test("done and dismissed loops are excluded from a source prime", () => {
    const doc = insertDoc("d1", "source-x");
    seedLoop({ id: "loop_open", title: "Still open loop", docs: [doc], state: "open" });
    seedLoop({ id: "loop_done", title: "Finished loop", docs: [doc], state: "done" });
    seedLoop({ id: "loop_dismissed", title: "Dropped loop", docs: [doc], state: "dismissed" });
    // A snoozed loop is still part of the live model — it must appear.
    seedLoop({ id: "loop_snoozed", title: "Snoozed loop", docs: [doc], state: "snoozed" });

    // Empty decisions window: assert purely on the active-state tracked-loops
    // filter (a just-resolved loop can legitimately show as a recent decision).
    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-x",
      fromMs: 1,
      toMs: 2,
      now: NOW,
      cfg: cfgWith(),
    });
    expect(prime).toContain("loop_open");
    expect(prime).toContain("loop_snoozed");
    expect(prime).not.toContain("loop_done");
    expect(prime).not.toContain("loop_dismissed");
  });

  test("primeMaxLoops caps how many loops are listed (most important first)", () => {
    const doc = insertDoc("c1", "source-x");
    seedLoop({ id: "loop_hi", title: "High importance", docs: [doc], importance: 0.9 });
    seedLoop({ id: "loop_mid", title: "Mid importance", docs: [doc], importance: 0.8 });
    seedLoop({ id: "loop_lo", title: "Low importance", docs: [doc], importance: 0.7 });

    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-x",
      fromMs: 1,
      toMs: 2, // an empty decisions window, so only loop lines are present
      now: NOW,
      cfg: cfgWith({ primeMaxLoops: 2 }),
    });
    expect(prime).toContain("loop_hi");
    expect(prime).toContain("loop_mid");
    expect(prime).not.toContain("loop_lo");
  });

  test("primeLedgerChars truncates a loop's ledger tail", () => {
    const doc = insertDoc("l1", "source-x");
    seedLoop({ id: "loop_l", title: "Loop with a long ledger", docs: [doc] });
    const longNote = `BEGIN-${"x".repeat(400)}-END`;
    appendOpenLoopLedger(db, "loop_l", { runId: "run_prior", note: longNote }, NOW - DAY);

    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-x",
      fromMs: 1,
      toMs: 2,
      now: NOW,
      cfg: cfgWith({ primeLedgerChars: 20 }),
    });
    // The tail is present but truncated with an ellipsis; the full note is not.
    expect(prime).toContain("BEGIN-");
    expect(prime).toContain("…");
    expect(prime).not.toContain(longNote);
    expect(prime).not.toContain("-END");
  });

  test("recent decisions list in-window loop touches and brief creations, capped", () => {
    const doc = insertDoc("r1", "source-x");
    // A loop touched inside the window (created there).
    seedLoop({ id: "loop_recent", title: "Touched this window", docs: [doc], at: NOW - DAY });
    // A brief created inside the window.
    createBrief(
      db,
      {
        id: "brief_recent",
        createdByRun: "run_prior",
        kind: "info",
        title: "Fresh awareness brief",
        confidence: 0.5,
        urgency: 0.5,
      },
      NOW - DAY,
    );
    // A loop touched OUTSIDE the window (30 days ago) — not a recent decision.
    seedLoop({ id: "loop_old", title: "Old touch", docs: [doc], at: NOW - 30 * DAY });

    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-x",
      fromMs: NOW - 3 * DAY,
      toMs: NOW,
      now: NOW,
      cfg: cfgWith(),
    });
    expect(prime).toContain("Recent decisions in this window:");
    expect(prime).toContain("updated loop [loop_recent]");
    expect(prime).toContain("created info brief [brief_recent]");
    // loop_old was touched before the window — it is not a recent DECISION,
    // though it still appears in the tracked-loops section for the source.
    expect(prime).not.toContain("updated loop [loop_old]");
  });

  test("a source with no loops or decisions yields a clean minimal block, not a crash", () => {
    const prime = buildSourceDeltaPrime(db, {
      sourceId: "source-empty",
      fromMs: NOW - 3 * DAY,
      toMs: NOW,
      now: NOW,
      cfg: cfgWith(),
    });
    expect(prime).toContain("Your current model");
    expect(prime).toContain('source "source-empty"');
    // Both sections render "(none)".
    expect(prime.match(/- \(none\)/g)?.length).toBe(2);
  });

  test("the due-soon prime includes a due-in-3-days loop and excludes a due-in-60-days one", () => {
    const doc = insertDoc("m1", "source-x");
    seedLoop({
      id: "loop_soon",
      title: "Renew the parking permit",
      docs: [doc],
      importance: 0.8,
      deadline: { type: "by", date: cognitionSpendDay(NOW + 3 * DAY) },
      at: NOW - 30 * DAY, // stale: only the near deadline pulls it in
    });
    seedLoop({
      id: "loop_far",
      title: "Plan the winter ski trip",
      docs: [doc],
      importance: 0.9,
      deadline: { type: "by", date: cognitionSpendDay(NOW + 60 * DAY) },
      at: NOW - 30 * DAY,
    });
    // No deadline, touched yesterday — pulled in by the recency window.
    seedLoop({
      id: "loop_touched",
      title: "Follow up with the caterer",
      docs: [doc],
      at: NOW - DAY,
    });

    const prime = buildDueSoonDeltaPrime(db, { now: NOW, cfg: cfgWith() });
    expect(prime).toContain("Your current model");
    expect(prime).toContain("loop_soon");
    expect(prime).toContain("Renew the parking permit");
    expect(prime).toContain("loop_touched");
    expect(prime).not.toContain("loop_far");
    expect(prime).not.toContain("winter ski trip");
  });

  test("buildSynthesisDeltaPrime lists loops cross-source; the annotation-priors block is gated", () => {
    const gmailDoc = insertDoc("g1", "gmail-main");
    const bankDoc = insertDoc("b1", "bank-main");
    seedLoop({ id: "loop_g", title: "Reply to the notaire", docs: [gmailDoc], importance: 0.8 });
    seedLoop({ id: "loop_b", title: "Reconcile the statement", docs: [bankDoc], importance: 0.6 });

    const off = buildSynthesisDeltaPrime(db, { now: NOW, cfg: cfgWith() });
    expect(off).toContain("All tracked loops");
    expect(off).toContain("loop_g");
    expect(off).toContain("loop_b"); // cross-source, unlike the source-scoped prime
    expect(off).not.toContain("durable observations"); // no annotations in the corpus yet

    const evidence = insertDoc("e1", "gmail-main", "the notaire needs the signed devis by Friday");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: gmailDoc,
        claimType: "commitment-status",
        claimText: "devis due Friday",
        evidenceDocId: evidence,
        evidenceQuote: "signed devis by Friday",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "r",
      },
      NOW,
    );
    const on = buildSynthesisDeltaPrime(db, {
      now: NOW,
      cfg: cfgWith({ annotations: { enabled: true } }),
    });
    expect(on).toContain("Recent durable observations");
    expect(on).toContain("annotation doc:anno_1");
    expect(on).toContain("devis due Friday");
    expect(on).toContain(`re-read doc ${gmailDoc} before use`);
  });

  test("buildSynthesisDeltaPrime renders the person-observations section, gated + evidence-referenced", () => {
    const evidence = insertDoc("e1", "gmail-main", "chairs the finance review each quarter");
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_a",
        claimType: "role",
        claimText: "chairs the finance review",
        evidenceDocId: evidence,
        evidenceQuote: "chairs the finance review each quarter",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "r",
      },
      NOW,
    );
    // Gated off with the same knob as doc annotations (explicitly disabled —
    // the knob now defaults on after graduation).
    const off = buildSynthesisDeltaPrime(db, {
      now: NOW,
      cfg: cfgWith({ annotations: { enabled: false } }),
    });
    expect(off).not.toContain("observations about people");
    // On: the person section renders and references the evidence doc to reground.
    const on = buildSynthesisDeltaPrime(db, {
      now: NOW,
      cfg: cfgWith({ annotations: { enabled: true } }),
    });
    expect(on).toContain("Recent observations about people");
    expect(on).toContain("annotation person:panno_1");
    expect(on).toContain("chairs the finance review");
    expect(on).toContain(`re-read doc ${evidence} before use`);
  });

  test("buildSynthesisDeltaPrime windows annotation priors by lookback and honours the cap", () => {
    const doc = insertDoc("d1", "gmail-main");
    const evidence = insertDoc("e1", "gmail-main", "alpha beta gamma delta epsilon");
    const cfg = cfgWith({
      annotations: { enabled: true },
      synthesisLookbackMs: 7 * DAY,
      primeMaxAnnotations: 2,
    });
    const seeds: ReadonlyArray<readonly [number, number]> = [
      [1, NOW],
      [2, NOW - DAY],
      [3, NOW - 2 * DAY],
      [4, NOW - 30 * DAY],
    ];
    for (const [i, at] of seeds) {
      createDocAnnotation(
        db,
        {
          id: `anno_${i}`,
          docId: doc,
          claimType: "topic",
          claimText: `claim-${i}`,
          evidenceDocId: evidence,
          evidenceQuote: "alpha beta gamma",
          confidence: 0.5,
          claimBasis: "quoted",
          createdByRun: "r",
        },
        at,
      );
    }
    const prime = buildSynthesisDeltaPrime(db, { now: NOW, cfg });
    expect(prime).toContain("claim-1");
    expect(prime).toContain("claim-2");
    expect(prime).not.toContain("claim-3"); // beyond the cap of 2 (newest kept)
    expect(prime).not.toContain("claim-4"); // beyond the 7d lookback window
  });
});
