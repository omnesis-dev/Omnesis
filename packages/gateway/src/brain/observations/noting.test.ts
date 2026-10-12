// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scoring an observation at note time with a scripted decision model (no
 * model inference): the noted scores, the "would have pushed" time, the
 * decision ledger entry, and the unavailable paths.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  createLogger,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { createObservationScorer, type ObservationScorerDeps } from "./noting.js";
import { DEFAULT_SALIENCE_THRESHOLDS } from "./salience.js";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("observation-noting");
const NOTED_AT = Date.parse("2026-07-02T15:00:00.000Z");
const NEXT_BRIEF = Date.parse("2026-07-03T07:00:00.000Z");

function scripted(levels: Record<string, number> | Error) {
  const requests: DecisionRequest[] = [];
  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    async decide(request): Promise<DecisionResult> {
      requests.push(request);
      if (levels instanceof Error) throw levels;
      return {
        model: "scripted-decision",
        inputTokens: 7,
        answers: Object.fromEntries(
          Object.entries(levels).map(([k, score]) => [k, { type: "score" as const, score }]),
        ),
      };
    },
    dispose() {},
  };
  return { decision, requests };
}

describe("createObservationScorer", () => {
  let path: string;
  let db: Database.Database;
  let docId: string;
  let decisions: CognitionDecisionRecord[];
  let recordSpend: Mock<ObservationScorerDeps["recordSpend"]>;
  let nextBriefAt: Mock<ObservationScorerDeps["nextBriefAt"]>;

  function deps(decision: DecisionCapability | null): ObservationScorerDeps {
    return {
      db,
      getDecision: () => decision,
      recordSpend,
      recordDecision: async (record) => {
        decisions.push(record);
      },
      thresholds: () => DEFAULT_SALIENCE_THRESHOLDS,
      nextBriefAt,
      log,
    };
  }

  const input = (overrides: { relevantUntil?: number | null; citations?: string[] } = {}) => ({
    id: "obs_new",
    summary: "The parking permit expires tonight.",
    why: "A fine applies tomorrow.",
    userAuthored: false,
    citations: overrides.citations ?? [docId],
    windowStart: null,
    relevantUntil:
      overrides.relevantUntil === undefined ? NOTED_AT + 6 * 3_600_000 : overrides.relevantUntil,
    notedAt: NOTED_AT,
  });

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    decisions = [];
    recordSpend = vi.fn(async () => {});
    nextBriefAt = vi.fn(() => NEXT_BRIEF);
    const content = "Your parking permit expires at midnight tonight.";
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("mail-fixture"),
        externalId: "permit",
        title: "Permit notice",
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        sourceCreatedAt: "2026-07-02T09:00:00.000Z",
        sourceUpdatedAt: "2026-07-02T09:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    docId = db.prepare<[], { id: string }>("SELECT id FROM documents").get()!.id;
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("no decision model: unscored, no ledger entry", async () => {
    const score = createObservationScorer(deps(null), "run_note");
    expect(await score(input())).toEqual({ scores: null, wouldPushAt: null });
    expect(decisions).toEqual([]);
    expect(nextBriefAt).not.toHaveBeenCalled();
  });

  test("a top-level, urgent observation due before the next brief would have pushed", async () => {
    const { decision, requests } = scripted({ consequence: 4, timing: 3, already_known: 0 });
    const score = createObservationScorer(deps(decision), "run_note");
    const result = await score(input());
    expect(result).toEqual({
      scores: {
        consequence: 4,
        timing: 3,
        alreadyKnown: 0,
        modelId: "scripted-decision",
        at: NOTED_AT,
      },
      wouldPushAt: NOTED_AT,
    });
    expect(nextBriefAt).toHaveBeenCalledExactlyOnceWith(NOTED_AT);
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith("scripted-decision", 7);
    expect(requests[0]!.state).toMatchObject({
      observation: "The parking permit expires tonight.",
      now: new Date(NOTED_AT).toISOString(),
      sources: [{ title: "Permit notice", source: "mail-fixture" }],
      sinceNoted: null,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      runId: "run_note",
      documentId: docId,
      purpose: "observation-salience",
      lane: "note",
      recordId: "obs_new",
      score: 4,
      verdict: "pass",
      threshold: DEFAULT_SALIENCE_THRESHOLDS.minConsequence,
      createdAt: NOTED_AT,
    });
  });

  test("a deadline after the next brief would not have pushed", async () => {
    const { decision } = scripted({ consequence: 4, timing: 3, already_known: 0 });
    const score = createObservationScorer(deps(decision), "run_note");
    const result = await score(input({ relevantUntil: NEXT_BRIEF + 1 }));
    expect(result.scores?.consequence).toBe(4);
    expect(result.wouldPushAt).toBeNull();
  });

  test("a below-top consequence is scored but would not have pushed, and ledgers as skip when held", async () => {
    const { decision } = scripted({ consequence: 1, timing: 0, already_known: 0 });
    const score = createObservationScorer(deps(decision), "run_note");
    const result = await score(input());
    expect(result).toMatchObject({ scores: { consequence: 1 }, wouldPushAt: null });
    expect(decisions[0]).toMatchObject({ verdict: "skip", score: 1 });
  });

  test("an unavailable judgement stores the observation unscored and ledgers it as unavailable", async () => {
    const { decision } = scripted(new Error("scripted outage"));
    const score = createObservationScorer(deps(decision), "run_note");
    expect(await score(input())).toEqual({ scores: null, wouldPushAt: null });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ verdict: "unavailable", score: null, modelId: null });
  });

  test("an uncited observation is scored but not ledgered", async () => {
    const { decision } = scripted({ consequence: 2, timing: 1, already_known: 0 });
    const score = createObservationScorer(deps(decision), "run_note");
    const result = await score(input({ citations: [] }));
    expect(result.scores?.consequence).toBe(2);
    expect(decisions).toEqual([]);
  });

  test("the decision model is resolved fresh on every call", async () => {
    let current: DecisionCapability | null = null;
    const d: ObservationScorerDeps = { ...deps(null), getDecision: () => current };
    const score = createObservationScorer(d, "run_note");
    expect((await score(input())).scores).toBeNull();
    current = scripted({ consequence: 2, timing: 1, already_known: 0 }).decision;
    expect((await score(input())).scores?.consequence).toBe(2);
  });
});
