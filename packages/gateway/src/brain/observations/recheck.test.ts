// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning recheck over a real gateway store and the direct write gate,
 * with a scripted decision model and a scripted entailment verifier (no model
 * inference): expiry, stale evidence, resolved loops, salience
 * ship/hold/already_known, fail-open judgements, the claim check, ranking
 * and the day's item list.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  createLogger,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
  type EntailCapability,
  type EntailVerdict,
} from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { listDecisionsForRun } from "../storage/decisions.js";
import {
  listMorningBriefItems,
  markMorningBriefSent,
  replaceMorningBriefItems,
} from "../storage/morning-brief-items.js";
import {
  createObservation,
  getObservation,
  transitionObservation,
  type CreateObservationInput,
} from "../storage/observations.js";
import { appendOpenLoopLedger, createOpenLoop } from "../storage/open-loops.js";
import {
  observationSources,
  recheckObservations,
  sinceNoted,
  type ObservationRecheckDeps,
} from "./recheck.js";
import { DEFAULT_SALIENCE_THRESHOLDS } from "./salience.js";
import type { ObservationScores } from "../storage/types.js";
import type { OwnerInterest } from "../interest/lookup.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("observation-recheck");
const T0 = Date.parse("2026-07-01T12:00:00.000Z");
const NOW = Date.parse("2026-07-02T07:00:00.000Z");
const DAY = "2026-07-02";
const RUN = "run_morning";

function doc(externalId: string, content: string, title = `Message ${externalId}`): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("mail-fixture"),
    externalId,
    title,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "email" },
  };
}

type Levels = { consequence: number; timing: number; already_known: number };

/** A decision model scripted per observation summary. */
function scriptedDecision(bySummary: Record<string, Levels | Error>) {
  const requests: DecisionRequest[] = [];
  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    async decide(request): Promise<DecisionResult> {
      requests.push(request);
      const summary = (request.state as { observation: string }).observation;
      const levels = bySummary[summary];
      if (!levels) throw new Error(`no script for ${summary}`);
      if (levels instanceof Error) throw levels;
      return {
        model: "scripted-decision",
        inputTokens: 10,
        answers: Object.fromEntries(
          Object.entries(levels).map(([k, score]) => [k, { type: "score" as const, score }]),
        ),
      };
    },
    dispose() {},
  };
  return { decision, requests };
}

function verifier(verdict: EntailVerdict | Error) {
  const verify = vi.fn(async (_input: Parameters<EntailCapability["verify"]>[0]) => {
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const capability: EntailCapability = { verify, dispose() {} };
  return { capability, verify };
}

function noted(consequence: number, timing = 0, alreadyKnown = 0): ObservationScores {
  return { consequence, timing, alreadyKnown, modelId: "scripted-decision", at: T0 };
}

describe("recheckObservations", () => {
  let path: string;
  let db: Db;
  let docA: string;
  let docB: string;
  let recordSpend: Mock<ObservationRecheckDeps["recordSpend"]>;

  function docId(externalId: string): string {
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  function note(id: string, input: Partial<CreateObservationInput> = {}, at = T0) {
    return createObservation(
      db,
      { id, createdByRun: "run_note", summary: id, citations: [docA], ...input },
      at,
    );
  }

  function loop(id: string, state: "open" | "snoozed" | "done" | "dismissed" = "open") {
    createOpenLoop(
      db,
      {
        id,
        createdByRun: "run_loop",
        title: `Task ${id}`,
        confidence: 0.8,
        importance: 0.5,
        state,
      },
      T0 - 1000,
    );
  }

  function deps(overrides: Partial<ObservationRecheckDeps> = {}): ObservationRecheckDeps {
    return {
      db,
      writes: directWriteGate(db),
      getDecision: () => null,
      recordSpend,
      thresholds: () => DEFAULT_SALIENCE_THRESHOLDS,
      clock: () => NOW,
      log,
      ...overrides,
    };
  }

  const run = (d: ObservationRecheckDeps, signal?: AbortSignal) =>
    recheckObservations(d, { runId: RUN, day: DAY, ...(signal ? { signal } : {}) });

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    recordSpend = vi.fn(async () => {});
    upsertDocuments(db, [
      doc("a", "The studio rent invoice is due on Friday the 3rd.", "Rent invoice"),
      doc("b", "Workshop venue confirmed for the 14th."),
    ]);
    docA = docId("a");
    docB = docId("b");
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  describe("deterministic drops", () => {
    test("expires observations whose window ended", async () => {
      note("obs_expired", { relevantUntil: NOW - 1 });
      note("obs_edge", { relevantUntil: NOW });
      note("obs_current", { relevantUntil: NOW + 1 });
      const result = await run(deps());
      expect(result.dropped).toEqual(
        expect.arrayContaining([
          { id: "obs_expired", reason: "expired" },
          { id: "obs_edge", reason: "expired" },
        ]),
      );
      expect(result.dropped).toHaveLength(2);
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_current"]);
      expect(getObservation(db, "obs_edge")?.closeReason).toBe("expired");
    });

    test("leaves an observation whose window opens on a later day live and unjudged", async () => {
      const laterDay = new Date(2026, 6, 3, 9).getTime();
      note("obs_later", { windowStart: laterDay });
      note("obs_later_today", { windowStart: new Date(2026, 6, 2, 18).getTime() });
      note("obs_open", { windowStart: T0 });
      const { decision, requests } = scriptedDecision({
        obs_later_today: { consequence: 4, timing: 3, already_known: 0 },
        obs_open: { consequence: 4, timing: 3, already_known: 0 },
      });
      const result = await run(deps({ getDecision: () => decision }));
      expect(result.shipped.map((o) => o.id).sort()).toEqual(["obs_later_today", "obs_open"]);
      expect(getObservation(db, "obs_later")?.state).toBe("live");
      expect(requests.map((r) => (r.state as { observation: string }).observation)).not.toContain(
        "obs_later",
      );
      expect(listMorningBriefItems(db, DAY).map((i) => i.observationId)).not.toContain("obs_later");
      const next = await recheckObservations(
        deps({ getDecision: () => decision, clock: () => laterDay }),
        {
          runId: "run_next",
          day: "2026-07-03",
        },
      );
      expect(next.shipped.map((o) => o.id)).toContain("obs_later");
    });

    test("drops as stale when a cited document is gone", async () => {
      note("obs_gone", { citations: [docA, docB] });
      note("obs_ok", { citations: [docA] });
      db.prepare("DELETE FROM documents WHERE id = ?").run(docB);
      const result = await run(deps());
      expect(result.dropped).toEqual([{ id: "obs_gone", reason: "stale" }]);
      expect(getObservation(db, "obs_gone")).toMatchObject({
        state: "dropped",
        closeReason: "stale",
      });
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_ok"]);
    });

    test("drops as stale when a cited document is pending removal", async () => {
      note("obs_removed", { citations: [docB] });
      db.prepare(
        "INSERT OR REPLACE INTO knowledge_source_revisions (document_id, content_hash, deleted, updated_at) VALUES (?, 'h', 1, ?)",
      ).run(docB, NOW);
      const result = await run(deps());
      expect(result.dropped).toEqual([{ id: "obs_removed", reason: "stale" }]);
    });

    test("drops as stale when a claim's quote is gone from its edited document", async () => {
      note("obs_edited", {
        claims: [{ docId: docA, quote: "due on Friday the 3rd", verification: "unverified" }],
      });
      note("obs_quote_kept", {
        claims: [{ docId: docA, quote: "studio rent invoice", verification: "unverified" }],
      });
      upsertDocuments(db, [doc("a", "The studio rent invoice has been paid.", "Rent invoice")]);
      const result = await run(deps());
      expect(result.dropped).toEqual([{ id: "obs_edited", reason: "stale" }]);
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_quote_kept"]);
    });

    test("drops as stale when its knowledge node went stale", async () => {
      note("obs_node");
      note("obs_current_node");
      // Knowledge nodes are materialised asynchronously; place both directly.
      const insertNode = db.prepare<[string, string, string]>(
        `INSERT INTO knowledge_nodes (id, kind, owner_id, title, markdown, plain_text, revision,
           meaning_revision, meaning_hash, validity, metadata_json, fields_json, created_at, updated_at)
         VALUES (?, 'observation', ?, 't', 't', 't', 1, 1, 'h', ?, '{}', '{}', 0, 0)`,
      );
      insertNode.run("node_stale", "obs_node", "stale");
      insertNode.run("node_current", "obs_current_node", "current");
      const result = await run(deps());
      expect(result.dropped).toEqual([{ id: "obs_node", reason: "stale" }]);
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_current_node"]);
    });

    test("drops as superseded when every related loop resolved or vanished", async () => {
      loop("loop_done", "done");
      loop("loop_dismissed", "dismissed");
      loop("loop_open", "open");
      loop("loop_snoozed", "snoozed");
      note("obs_resolved", { relatedLoopIds: ["loop_done", "loop_dismissed"] });
      note("obs_vanished", { relatedLoopIds: ["loop_missing"] });
      note("obs_one_open", { relatedLoopIds: ["loop_done", "loop_open"] });
      note("obs_snoozed", { relatedLoopIds: ["loop_snoozed"] });
      note("obs_no_loops");
      const result = await run(deps());
      expect(result.dropped.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "obs_resolved", reason: "superseded" },
        { id: "obs_vanished", reason: "superseded" },
      ]);
      expect(result.shipped.map((o) => o.id).sort()).toEqual([
        "obs_no_loops",
        "obs_one_open",
        "obs_snoozed",
      ]);
    });

    test("closed observations are never rechecked", async () => {
      note("obs_shipped");
      transitionObservation(
        db,
        "obs_shipped",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        T0 + 1,
      );
      const { decision, requests } = scriptedDecision({});
      const result = await run(deps({ getDecision: () => decision }));
      expect(result).toEqual({ shipped: [], held: [], dropped: [] });
      expect(requests).toHaveLength(0);
      expect(listMorningBriefItems(db, DAY)).toEqual([]);
    });
  });

  describe("salience", () => {
    test("asks the interest ledger about each observation and shows the model what it finds", async () => {
      note("obs_rent", { why: "A late payment adds a fee." });
      note("obs_plain", { why: "" });
      const ownerInterest: OwnerInterest = {
        positive: [],
        negative: [
          {
            text: "Rent invoice reminder",
            note: "I pay these on the day",
            source: "brief_not_interested",
            ageDays: 7,
            similarity: 0.63,
          },
        ],
        statements: [],
      };
      const lookup = vi.fn(async ({ text }: { text: string }) =>
        text.startsWith("obs_rent") ? ownerInterest : null,
      );
      const { decision, requests } = scriptedDecision({
        obs_rent: { consequence: 1, timing: 0, already_known: 0 },
        obs_plain: { consequence: 3, timing: 2, already_known: 0 },
      });
      await run(deps({ getDecision: () => decision, interest: { lookup } }));
      expect(lookup.mock.calls.map(([q]) => q.text).sort()).toEqual([
        "obs_plain",
        "obs_rent\nA late payment adds a fee.",
      ]);
      const byObservation = Object.fromEntries(
        requests.map((r) => [
          (r.state as { observation: string }).observation,
          r.state as { owner_interest?: unknown },
        ]),
      );
      expect(byObservation.obs_rent!.owner_interest).toEqual(ownerInterest);
      expect(byObservation.obs_plain).not.toHaveProperty("owner_interest");
    });

    test("rescores with the decision model and ships, holds or drops by the policy", async () => {
      note("obs_ship");
      note("obs_hold");
      note("obs_known");
      const { decision } = scriptedDecision({
        obs_ship: { consequence: 3, timing: 2, already_known: 0 },
        obs_hold: { consequence: 1, timing: 0, already_known: 0 },
        obs_known: { consequence: 4, timing: 3, already_known: 1 },
      });
      const result = await run(deps({ getDecision: () => decision }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_ship"]);
      expect(result.held).toEqual(["obs_hold"]);
      expect(result.dropped).toEqual([{ id: "obs_known", reason: "already_known" }]);
      expect(getObservation(db, "obs_ship")).toMatchObject({
        state: "live",
        scores: {
          consequence: 3,
          timing: 2,
          alreadyKnown: 0,
          modelId: "scripted-decision",
          at: NOW,
        },
      });
      expect(getObservation(db, "obs_hold")).toMatchObject({
        state: "held",
        closeReason: "below_bar",
        scores: { consequence: 1 },
      });
      expect(getObservation(db, "obs_known")).toMatchObject({
        state: "dropped",
        closeReason: "already_known",
        scores: { alreadyKnown: 1 },
      });
      expect(recordSpend).toHaveBeenCalledTimes(3);
      expect(listMorningBriefItems(db, DAY).map((i) => i.observationId)).toEqual(["obs_ship"]);
    });

    test("a held observation whose scores rose ships the next morning", async () => {
      note("obs_rising");
      transitionObservation(
        db,
        "obs_rising",
        { state: "held", reason: "below_bar", scores: noted(1) },
        T0 + 1,
      );
      const { decision } = scriptedDecision({
        obs_rising: { consequence: 3, timing: 3, already_known: 0 },
      });
      const result = await run(deps({ getDecision: () => decision }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_rising"]);
      expect(result.held).toEqual([]);
      expect(getObservation(db, "obs_rising")?.state).toBe("held");
      expect(listMorningBriefItems(db, DAY).map((i) => i.observationId)).toEqual(["obs_rising"]);
    });

    test("a held observation still below the bar is reported held again", async () => {
      note("obs_flat");
      transitionObservation(db, "obs_flat", { state: "held", reason: "below_bar" }, T0 + 1);
      const { decision } = scriptedDecision({
        obs_flat: { consequence: 0, timing: 0, already_known: 0 },
      });
      const result = await run(deps({ getDecision: () => decision }));
      expect(result.held).toEqual(["obs_flat"]);
      expect(getObservation(db, "obs_flat")?.scores?.at).toBe(NOW);
    });

    test("without a decision model, ranks by the scores taken when noted", async () => {
      note("obs_high", { notedScores: noted(4, 1) });
      note("obs_low", { notedScores: noted(0, 0) });
      note("obs_unscored");
      const result = await run(deps());
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_high", "obs_unscored"]);
      expect(result.held).toEqual(["obs_low"]);
    });

    test("prefers the latest recheck scores over the noted scores without a decision model", async () => {
      note("obs_rescored", { notedScores: noted(4) });
      transitionObservation(
        db,
        "obs_rescored",
        { state: "held", reason: "below_bar", scores: noted(0) },
        T0 + 1,
      );
      const result = await run(deps());
      expect(result.held).toEqual(["obs_rescored"]);
    });

    test("an unavailable judgement fails open: falls back to noted scores, else ships", async () => {
      note("obs_noted_low", { notedScores: noted(0) });
      note("obs_unscored");
      const { decision } = scriptedDecision({
        obs_noted_low: new Error("scripted outage"),
        obs_unscored: new Error("scripted outage"),
      });
      const result = await run(deps({ getDecision: () => decision }));
      expect(result.held).toEqual(["obs_noted_low"]);
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_unscored"]);
      expect(getObservation(db, "obs_unscored")).toMatchObject({ state: "live", scores: null });
      const ledger = listDecisionsForRun(db, RUN);
      expect(ledger).toHaveLength(2);
      expect(ledger.every((d) => d.verdict === "unavailable" && d.score === null)).toBe(true);
    });

    test("ledgers every judgement, against the first cited document when there is one", async () => {
      note("obs_ship", { citations: [docB, docA] });
      note("obs_hold");
      note("obs_uncited", { citations: [] });
      const { decision } = scriptedDecision({
        obs_ship: { consequence: 2, timing: 0, already_known: 0 },
        obs_hold: { consequence: 0, timing: 0, already_known: 0 },
        obs_uncited: { consequence: 2, timing: 0, already_known: 0 },
      });
      await run(deps({ getDecision: () => decision }));
      const ledger = listDecisionsForRun(db, RUN);
      expect(ledger).toHaveLength(3);
      expect(ledger.find((d) => d.recordId === "obs_uncited")).toMatchObject({
        documentId: null,
        subjectDocumentId: null,
        requestJson: null,
        verdict: "pass",
      });
      expect(ledger.find((d) => d.recordId === "obs_ship")).toMatchObject({
        purpose: "observation-salience",
        lane: "recheck",
        documentId: docB,
        subjectDocumentId: docB,
        score: 2,
        threshold: DEFAULT_SALIENCE_THRESHOLDS.minConsequence,
        verdict: "pass",
        modelId: "scripted-decision",
        enforced: true,
      });
      expect(ledger.find((d) => d.recordId === "obs_hold")).toMatchObject({ verdict: "skip" });
    });

    test("tells the decision model what happened since the observation was noted", async () => {
      loop("loop_rent");
      appendOpenLoopLedger(db, "loop_rent", { runId: "r", note: "Before noting." }, T0 - 10);
      note("obs_rent", { relatedLoopIds: ["loop_rent", "loop_gone"] });
      appendOpenLoopLedger(
        db,
        "loop_rent",
        { runId: "r", note: "Invoice paid by card." },
        T0 + 60_000,
      );
      const { decision, requests } = scriptedDecision({
        obs_rent: { consequence: 2, timing: 0, already_known: 0 },
      });
      await run(deps({ getDecision: () => decision }));
      const state = requests[0]!.state as {
        sinceNoted: string[];
        sources: Array<{ title: string }>;
        now: string;
      };
      expect(state.now).toBe(new Date(NOW).toISOString());
      expect(state.sources).toEqual([
        { title: "Rent invoice", source: "mail-fixture", date: "2026-07-01T09:00:00.000Z" },
      ]);
      expect(state.sinceNoted).toContain("Related loop loop_gone no longer exists.");
      expect(state.sinceNoted.some((l) => l.includes("Invoice paid by card."))).toBe(true);
      expect(state.sinceNoted.some((l) => l.includes("Before noting."))).toBe(false);
    });
  });

  describe("claim verification", () => {
    const claims = () => [
      { docId: docA, quote: "rent invoice is due on Friday", verification: "unverified" as const },
    ];

    test("an entailed observation ships with its claims marked entailed", async () => {
      note("obs_claim", { claims: claims() });
      const v = verifier({ label: "entailment" });
      const result = await run(deps({ getEntailmentVerifier: async () => v.capability }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_claim"]);
      expect(result.shipped[0]!.claims[0]!.verification).toBe("entailed");
      expect(getObservation(db, "obs_claim")?.claims[0]!.verification).toBe("entailed");
      expect(v.verify).toHaveBeenCalledTimes(1);
      const input = v.verify.mock.calls[0]![0];
      expect(input.claim).toContain("obs_claim");
      expect(input.evidence).toContain("rent invoice");
      expect(input.signal).toBeInstanceOf(AbortSignal);
    });

    test.each<EntailVerdict["label"]>(["neutral", "contradiction"])(
      "a %s verdict drops the observation as unsupported",
      async (label) => {
        note("obs_claim", { claims: claims(), notedScores: noted(3) });
        const v = verifier({ label });
        const result = await run(deps({ getEntailmentVerifier: async () => v.capability }));
        expect(result.shipped).toEqual([]);
        expect(result.dropped).toEqual([{ id: "obs_claim", reason: "unsupported" }]);
        expect(getObservation(db, "obs_claim")).toMatchObject({
          state: "dropped",
          closeReason: "unsupported",
          scores: { consequence: 3 },
        });
        expect(listMorningBriefItems(db, DAY)).toEqual([]);
      },
    );

    test("an unconfigured verifier ships unverified", async () => {
      note("obs_claim", { claims: claims() });
      const result = await run(deps({ getEntailmentVerifier: async () => null }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_claim"]);
      expect(getObservation(db, "obs_claim")?.claims[0]!.verification).toBe("unverified");
    });

    test("a failing verifier fails open and ships unverified", async () => {
      note("obs_claim", { claims: claims() });
      const v = verifier(new Error("scripted verifier outage"));
      const result = await run(deps({ getEntailmentVerifier: async () => v.capability }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_claim"]);
      expect(getObservation(db, "obs_claim")?.claims[0]!.verification).toBe("unverified");
    });

    test("a verifier resolution that throws fails open", async () => {
      note("obs_claim", { claims: claims() });
      const result = await run(
        deps({
          getEntailmentVerifier: () => Promise.reject(new Error("scripted resolution failure")),
        }),
      );
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_claim"]);
    });

    test("an uncited observation is not verified", async () => {
      note("obs_uncited", { citations: [] });
      const v = verifier({ label: "contradiction" });
      const result = await run(deps({ getEntailmentVerifier: async () => v.capability }));
      expect(result.shipped.map((o) => o.id)).toEqual(["obs_uncited"]);
      expect(v.verify).not.toHaveBeenCalled();
    });

    test("held and already-known observations are never sent to the verifier", async () => {
      note("obs_hold", { notedScores: noted(0) });
      note("obs_known", { notedScores: noted(4, 3, 1) });
      const v = verifier({ label: "entailment" });
      await run(deps({ getEntailmentVerifier: async () => v.capability }));
      expect(v.verify).not.toHaveBeenCalled();
    });
  });

  describe("ranking and the day's list", () => {
    test("ranks survivors by consequence, timing and age, and writes the list", async () => {
      note("obs_old_minor", { notedScores: noted(2, 0) }, T0);
      note("obs_urgent", { notedScores: noted(2, 3) }, T0 + 2);
      note("obs_severe", { notedScores: noted(4, 0) }, T0 + 3);
      note("obs_unscored", {}, T0 + 1);
      note("obs_new_minor", { notedScores: noted(2, 0) }, T0 + 4);
      const result = await run(deps());
      const ranked = ["obs_severe", "obs_urgent", "obs_old_minor", "obs_new_minor", "obs_unscored"];
      expect(result.shipped.map((o) => o.id)).toEqual(ranked);
      expect(listMorningBriefItems(db, DAY).map((i) => [i.rank, i.observationId, i.runId])).toEqual(
        ranked.map((id, i) => [i + 1, id, RUN]),
      );
    });

    test("a rerun the same morning replaces the unsent list", async () => {
      replaceMorningBriefItems(db, DAY, "run_earlier", ["obs_stale_entry"]);
      note("obs_1");
      await run(deps());
      expect(listMorningBriefItems(db, DAY).map((i) => i.observationId)).toEqual(["obs_1"]);
    });

    test("an already-sent day's list is left untouched", async () => {
      note("obs_sent");
      replaceMorningBriefItems(db, DAY, "run_earlier", ["obs_sent"]);
      markMorningBriefSent(
        db,
        { day: DAY, runId: "run_earlier", conversationId: "c", messageId: "m" },
        NOW - 1,
      );
      note("obs_new", {}, NOW - 1);
      await run(deps());
      expect(listMorningBriefItems(db, DAY).map((i) => i.observationId)).toEqual(["obs_sent"]);
    });

    test("an empty store writes an empty list", async () => {
      expect(await run(deps())).toEqual({ shipped: [], held: [], dropped: [] });
      expect(listMorningBriefItems(db, DAY)).toEqual([]);
    });

    test("an aborted run stops before judging", async () => {
      note("obs_1");
      const { decision, requests } = scriptedDecision({
        obs_1: { consequence: 2, timing: 0, already_known: 0 },
      });
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(run(deps({ getDecision: () => decision }), controller.signal)).rejects.toThrow();
      expect(requests).toHaveLength(0);
    });
  });
});

describe("recheck helpers", () => {
  let path: string;
  let db: Db;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("observationSources reads at most eight documents, skipping missing ones and bounding titles", () => {
    upsertDocuments(db, [
      doc("long", "Body text one.", "T".repeat(300)),
      ...Array.from({ length: 9 }, (_, i) => doc(`d${i}`, `Body text ${i}.`)),
    ]);
    const ids = db
      .prepare<[], { id: string; external_id: string }>("SELECT id, external_id FROM documents")
      .all();
    const long = ids.find((r) => r.external_id === "long")!.id;
    const others = ids.filter((r) => r.external_id !== "long").map((r) => r.id);
    const sources = observationSources(db, [long, "doc_missing", ...others]);
    expect(sources).toHaveLength(7);
    expect(sources[0]!.title).toHaveLength(200);
    expect(sources[0]).toMatchObject({ source: "mail-fixture", date: "2026-07-01T09:00:00.000Z" });
  });

  test("sinceNoted reports ledger notes after noting, state changes and vanished loops, capped at twelve", () => {
    createOpenLoop(
      db,
      { id: "loop_a", createdByRun: "r", title: "Task A", confidence: 0.8, importance: 0.5 },
      T0 - 100,
    );
    const observation = createObservation(
      db,
      { id: "obs", createdByRun: "r", summary: "s", relatedLoopIds: ["loop_a", "loop_x"] },
      T0,
    );
    expect(sinceNoted(db, observation)).toEqual(["Related loop loop_x no longer exists."]);

    for (let i = 0; i < 7; i++)
      appendOpenLoopLedger(db, "loop_a", { runId: "r", note: `Update ${i}` }, T0 + 1000 + i);
    db.prepare("UPDATE open_loops SET state = 'done', last_update = ? WHERE id = 'loop_a'").run(
      T0 + 5000,
    );
    const lines = sinceNoted(db, observation);
    // The five newest ledger notes, then the state line, then the vanished loop.
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain('loop "Task A": Update 6');
    expect(lines[4]).toContain("Update 2");
    expect(lines[5]).toBe('Loop "Task A" is now done.');
    expect(lines[6]).toBe("Related loop loop_x no longer exists.");

    const many = {
      ...observation,
      relatedLoopIds: Array.from({ length: 20 }, (_, i) => `gone_${i}`),
    };
    expect(sinceNoted(db, many)).toHaveLength(12);
  });
});
