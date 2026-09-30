// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — the worth gate on the retrospective bootstrap lane.
 *
 * The lane buys historical documents that still point at a future date. The
 * worth gate sits after that selection, at claim time: a bought email the
 * decision model scores below the threshold is settled with no agent turn,
 * marked covered, and shown in the Bootstrap timeline's `gated` band rather
 * than as reviewed — so gating is never mistaken for reading.
 *
 * The decision model is the scripted System One stand-in, scoring by subject.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  waitFor,
  worthAnswersFor,
  worthMailDoc,
  worthRequestFor,
  type DecisionServerRequest,
  type WorthMail,
} from "./brain-bench/index.js";

compressCognitionCadences();

const HOUR = 3_600_000;
const DAY = 86_400_000;

function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local noon today: the anchor every instant below derives from. */
const D0_NOON = localMidnight(Date.now()) + 12 * HOUR;
/** D+1 noon — past the lane's boot hold whatever hour the suite starts. */
const PAST_HOLD_AT = localMidnight(D0_NOON + DAY) + 12 * HOUR;

const SRC = "synthetic:archive@example.com";

/**
 * Two historical emails, both carrying an explicit future date so the lane
 * buys them whenever the suite runs.
 */
const PROMO: WorthMail = {
  key: "bs-promo",
  externalId: "wg-bs-promo",
  title: "Winter clearance ends 31 January 2029",
  content:
    "Our winter clearance runs until 31 January 2029. Everything in the outlet is half price while stocks last at Stellar Outfitters.",
  sender: { name: "Stellar Outfitters", email: "offers@stellar-outfitters.example.com" },
  score: 0.3,
};
const STAY: WorthMail = {
  key: "bs-stay",
  externalId: "wg-bs-stay",
  title: "Your cottage at Riverside Estate is booked for 12 March 2029",
  content:
    "Thank you for booking the Willow cottage at Riverside Estate. Your stay begins on 12 March 2029 with check-in from 3pm. The balance is due two weeks before arrival.",
  sender: { name: "Riverside Estate", email: "stays@riverside-estate.example.com" },
  score: 2.6,
};
const MAILS = [PROMO, STAY];

function scoreBySubject(request: DecisionServerRequest) {
  const subject = (request.state as { subject?: unknown }).subject;
  const mail = MAILS.find((m) => m.title === subject);
  return mail
    ? worthAnswersFor(mail)
    : { httpError: 422, message: `unscripted subject: ${String(subject)}` };
}

interface BootstrapRun {
  id: string;
  status: string;
  docId: string;
}

function bootstrapRuns(bench: BrainBench): BootstrapRun[] {
  return bench.sql
    .prepare<[], { id: string; status: string; payload_json: string }>(
      "SELECT id, status, payload_json FROM cognition_runs WHERE kind = 'bootstrap' ORDER BY enqueued_at, id",
    )
    .all()
    .map((r) => ({
      id: r.id,
      status: r.status,
      docId: (JSON.parse(r.payload_json) as { docId: string }).docId,
    }));
}

async function awaitExtractedDates(bench: BrainBench, docId: string, label: string): Promise<void> {
  await waitFor(
    `extracted dates for ${label}`,
    () =>
      (bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_extracted_dates WHERE document_id = ?")
        .get(docId)?.n ?? 0) > 0
        ? true
        : null,
    90_000,
  );
}

describe("worth gate: the bootstrap lane", () => {
  let bench: BrainBench;
  const ids = new Map<string, string>();
  const at = new Map<string, number>([
    [PROMO.key, D0_NOON - 8 * DAY],
    [STAY.key, D0_NOON - 9 * DAY],
  ]);

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      decision: { policy: scoreBySubject, inputTokens: 300 },
      brain: {
        mergeAdjudication: { enabled: false },
        // A frozen clock never advances past a deferred run's due time.
        derivationBarrier: "0s",
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 5,
          maxRunsPerDay: 5,
          maxRuns: 50,
          batchSize: 10,
        },
      },
    });
    await bench.obs.startBootstrap();
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v !== undefined, 60_000);

    // Outside the waker's recency window, so only the bootstrap lane reaches them.
    for (const mail of MAILS) {
      await bench.push(
        worthMailDoc(mail, { sourceId: SRC, providerId: SRC, at: at.get(mail.key)! }),
      );
      ids.set(mail.key, await bench.docId(mail.externalId));
      await awaitExtractedDates(bench, ids.get(mail.key)!, mail.key);
    }

    await bench.clock.set(PAST_HOLD_AT);
    await bench.markers.waitFor("bootstrap_hold_since", (v) => v === "0", 60_000);
    await waitFor(
      "bootstrap runs for both emails",
      () => {
        const bought = new Set(bootstrapRuns(bench).map((r) => r.docId));
        return MAILS.every((m) => bought.has(ids.get(m.key)!)) ? true : null;
      },
      90_000,
    );
    await bench.drainUntilQuiet();
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  function runFor(mail: WorthMail): BootstrapRun {
    const run = bootstrapRuns(bench).find((r) => r.docId === ids.get(mail.key));
    if (!run) throw new Error(`no bootstrap run for ${mail.key}`);
    return run;
  }

  test("the gate is asked about both bought emails with the rubric's exact state", () => {
    for (const mail of MAILS) {
      const calls = bench.decision.callsForSubject(mail.title);
      expect(calls, mail.key).toHaveLength(1);
      expect(calls[0]!.request).toEqual({
        model: bench.decision.modelId,
        ...worthRequestFor(mail),
      });
    }
  });

  test("the low-worth email's bootstrap run is gated: completed, no agent turn", async () => {
    const run = runFor(PROMO);
    expect(run.status).toBe("completed");
    expect(bench.puppetCalls.filter((c) => c.runId === run.id)).toHaveLength(0);
    const detail = await bench.obs.run(run.id);
    expect(detail.run.usage).toBeNull();
    expect(detail.decisions).toHaveLength(1);
    expect(detail.decisions[0]).toMatchObject({
      lane: "bootstrap",
      verdict: "skip",
      score: PROMO.score,
      documentId: ids.get(PROMO.key),
    });
    const listed = (await bench.obs.runs({ kind: "bootstrap" })).items.find((r) => r.id === run.id);
    expect(listed?.gateVerdict).toBe("skip");
  });

  test("the worthwhile email's bootstrap run executes the agent", async () => {
    const run = runFor(STAY);
    expect(run.status).toBe("completed");
    expect(bench.puppetCalls.filter((c) => c.runId === run.id).length).toBeGreaterThan(0);
    const detail = await bench.obs.run(run.id);
    expect(detail.decisions[0]).toMatchObject({ lane: "bootstrap", verdict: "pass" });
  });

  test("the gated email is covered: marked processed and counted in the timeline's gated band", async () => {
    const marked = bench.sql
      .prepare<
        [string],
        { marked: string | null }
      >("SELECT bootstrap_processed_at AS marked FROM documents WHERE id = ?")
      .get(ids.get(PROMO.key)!);
    expect(marked?.marked).not.toBeNull();

    const timeline = await bench.obs.bootstrapTimeline();
    expect(timeline.pending).toBe(false);
    const monthOf = (mail: WorthMail) => new Date(at.get(mail.key)!).toISOString().slice(0, 7);
    const row = (month: string) => timeline.months.find((m) => m.month === month);

    const promoMonth = row(monthOf(PROMO));
    const stayMonth = row(monthOf(STAY));
    expect(promoMonth, `timeline month ${monthOf(PROMO)}`).toBeDefined();
    expect(stayMonth, `timeline month ${monthOf(STAY)}`).toBeDefined();
    const gatedTotal = timeline.months.reduce((sum, m) => sum + m.gated, 0);
    // Only the promotion was gated; the stay is reviewed, never gated.
    expect(gatedTotal).toBe(1);
    expect(promoMonth!.gated).toBe(1);
    expect(stayMonth!.reviewed).toBeGreaterThanOrEqual(1);
  });
});
