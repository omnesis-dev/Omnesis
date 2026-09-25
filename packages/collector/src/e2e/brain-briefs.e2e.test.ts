// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — briefs.
 *
 * The correctness net over the card the user actually sees: what
 * `brief_create` persists (the row, its citations, its grounded claims),
 * what the push bar does to a candidate before it is persisted, what the
 * product surface shows and counts, and what a user's dismissal sets in
 * motion.
 *
 * Nothing here judges whether a brief SHOULD have been written — the
 * steward's decisions are scripted. It asserts that, given the decision,
 * the machine stored, gated, served and learned from it correctly.
 *
 * Two gateways, because one gateway cannot both have and not have a brief
 * judge: the first describe leaves the `brief-judge` role unassigned (the
 * production default), the second wires a scripted one and can deliberately
 * make that configured provider unavailable.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  ref,
  type BriefDto,
  type ToolResultView,
} from "./brain-bench/index.js";

compressCognitionCadences();

// ── markers ────────────────────────────────────────────────────────────────
// Stable tokens every assertion attributes rows back to. Titles may be
// reworded; a marker is what a test keys on.

const CLAIMS_MARKER = "invoice-4471";
const FAIL_OPEN_MARKER = "storage-renewal";
const HANDLED_MARKER = "estate-balance";
const IRRELEVANT_MARKER = "supplier-newsletter";
const DATED_MARKER = "rehearsal-slot";
const READ_MARKER = "permit-window";
const SUPERSEDE_MARKER = "van-hire";
const JUDGE_OUTAGE_MARKER = "permit-review";

/**
 * The one brief title the scripted judge in the second describe HOLDS.
 * Both benches raise a card with it, so the pair is a real A/B: unjudged
 * it is created, judged it is not.
 */
const JUDGE_HOLD_TITLE = `Renew the ${FAIL_OPEN_MARKER} plan this month`;
const JUDGE_SHIP_TITLE = `Wire the ${HANDLED_MARKER} before Friday`;
const JUDGE_OUTAGE_TITLE = `Review the ${JUDGE_OUTAGE_MARKER} requirements`;

// ── documents ──────────────────────────────────────────────────────────────
// Every quote a claim rests on appears verbatim in the content below; the
// quote-in-document gate refuses anything else.

const INVOICE_QUOTE = "Invoice 4471 is due on 14 November and the balance is 1,280.";
const PAYMENT_QUOTE = "Payment by bank transfer only; card payments are not accepted.";

const CLAIMS_DOC = email({
  externalId: "brain-briefs-invoice-4471",
  title: "Invoice 4471 from Cedar Grove Supplies",
  content: ["Hi Alex,", "", INVOICE_QUOTE, "", PAYMENT_QUOTE, "", "Cedar Grove Supplies"].join(
    "\n",
  ),
});

const FAIL_OPEN_DOC = email({
  externalId: "brain-briefs-storage-renewal",
  title: "Studio Northstar storage plan renewal",
  content:
    "Hi Alex,\n\nYour storage plan renews next month at the same rate. No action is needed unless you want to change tier.\n\nStudio Northstar",
});

const HANDLED_DOC = email({
  externalId: "brain-briefs-estate-balance",
  title: "Riverside Estate balance reminder",
  content:
    "Hi Alex,\n\nThe remaining balance for the Riverside Estate booking is due before Friday. Bank details are unchanged.\n\nRiverside Estate",
});

const IRRELEVANT_DOC = email({
  externalId: "brain-briefs-supplier-newsletter",
  title: "Cedar Grove Supplies quarterly round-up",
  content:
    "Hi Alex,\n\nHere is our quarterly round-up of new lines and depot opening hours.\n\nCedar Grove Supplies",
});

const DATED_DOC = email({
  externalId: "brain-briefs-rehearsal-slot",
  title: "Stellar Sound rehearsal slot confirmation",
  content:
    "Hi Alex,\n\nYour rehearsal slot is confirmed. Load-in opens ninety minutes before the slot starts.\n\nStellar Sound",
});

const READ_DOC = email({
  externalId: "brain-briefs-permit-window",
  title: "Street permit application window",
  content:
    "Hi Alex,\n\nThe application window for the street permit opens next week and closes fourteen days later.\n\nRiverside Estate",
});

const SUPERSEDE_DOC = email({
  externalId: "brain-briefs-van-hire",
  title: "Van hire quote from Cedar Grove Supplies",
  content:
    "Hi Alex,\n\nOur first quote for the van hire was provisional. The corrected quote is attached and supersedes it.\n\nCedar Grove Supplies",
});

const JUDGE_OUTAGE_DOC = email({
  externalId: "brain-briefs-permit-review",
  title: "Studio Northstar permit review",
  content:
    "Hi Alex,\n\nThe permit requirements are ready for review in the project workspace.\n\nStudio Northstar",
});

// ── local helpers ──────────────────────────────────────────────────────────

/**
 * The one brief carrying `marker`.
 *
 * A bare read is enough because `pushAndSettle` waits out the document
 * debounce as well as the queue, so by the time it returns the run the push
 * caused has already executed. Fails loudly with the marker rather than
 * handing back a null that fails an assertion two lines later.
 */
async function briefWith(bench: BrainBench, marker: string): Promise<BriefDto> {
  const matches = await bench.obs.briefsMatching(marker);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one brief for "${marker}", got ${matches.length}`);
  }
  return matches[0]!;
}

/** Every brief carrying `marker`, whatever its state. */
async function briefsWith(bench: BrainBench, marker: string): Promise<BriefDto[]> {
  return bench.obs.briefsMatching(marker);
}

/**
 * Every tool result a run recorded — the only place a STRUCTURED refusal
 * (which leaves no row behind) is observable after the fact.
 */
async function toolResultsOf(
  bench: BrainBench,
  runId: string,
): Promise<NonNullable<ToolResultView>[]> {
  const calls = await bench.obs.executedTools(runId);
  return calls.flatMap((c) => (c.result ? [c.result] : []));
}

/** POST a product route and return the raw status — for the 409 arms. */
async function postStatus(bench: BrainBench, path: string, body?: unknown): Promise<number> {
  const res = await bench.harness.gatewayFetch(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

// ── the unjudged bench ─────────────────────────────────────────────────────

describe("Brain Bench — briefs (no brief judge)", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // A configured verifier, so brief claims are born `verified` and the
      // claim path's gate is exercised rather than skipped.
      entailment: "accept-all",
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: CLAIMS_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: `Invoice 4471 is due (${CLAIMS_MARKER})`,
                  description: "Cedar Grove Supplies invoice 4471 is due, balance 1,280.",
                  body: "Balance 1,280 on invoice 4471, due 14 November. Bank transfer only.",
                  citations: [ctx.subject],
                  confidence: 0.9,
                  urgency: 0.6,
                  assertedClaims: [
                    {
                      claimText: "Invoice 4471 is due on 14 November and its balance is 1,280.",
                      evidenceDocId: ctx.subject,
                      evidenceQuote: INVOICE_QUOTE,
                      claimBasis: "quoted",
                      confidence: 0.9,
                    },
                    {
                      claimText: "Invoice 4471 cannot be settled with a card payment.",
                      evidenceDocId: ctx.subject,
                      evidenceQuote: PAYMENT_QUOTE,
                      claimBasis: "inferred",
                      confidence: 0.7,
                    },
                  ],
                }),
              ],
              finalText: "Raised the invoice card with its grounded claims.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: FAIL_OPEN_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: JUDGE_HOLD_TITLE,
                  description: "The storage plan renews next month at the same rate.",
                  citations: [ctx.subject],
                  confidence: 0.6,
                  urgency: 0.2,
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: HANDLED_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "loop",
                  title: JUDGE_SHIP_TITLE,
                  description: "The Riverside Estate balance is due before Friday.",
                  citations: [ctx.subject],
                  confidence: 0.9,
                  urgency: 0.8,
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: IRRELEVANT_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: `Depot hours changed (${IRRELEVANT_MARKER})`,
                  description: "Cedar Grove Supplies published new depot opening hours.",
                  citations: [ctx.subject],
                  confidence: 0.5,
                  urgency: 0.2,
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DATED_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: `Load-in opens early for the rehearsal (${DATED_MARKER})`,
                  description: "Load-in opens ninety minutes before the slot.",
                  citations: [ctx.subject],
                  confidence: 0.8,
                  urgency: 0.5,
                  nextShow: new Date(Date.now() + 2 * 86_400_000).toISOString(),
                  eventAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: READ_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: `Street permit window opens soon (${READ_MARKER})`,
                  description: "The permit window opens next week and closes fourteen days later.",
                  citations: [ctx.subject],
                  confidence: 0.8,
                  urgency: 0.6,
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: SUPERSEDE_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: `Provisional van hire quote (${SUPERSEDE_MARKER})`,
                  description: "The first van hire quote was provisional.",
                  citations: [ctx.subject],
                  confidence: 0.6,
                  urgency: 0.3,
                }),
                // Same run, so the replacement can reference the id the
                // first create actually minted.
                call("brief_create", {
                  kind: "info",
                  title: `Corrected van hire quote (${SUPERSEDE_MARKER})`,
                  description: "The corrected van hire quote replaces the provisional one.",
                  citations: [ctx.subject],
                  confidence: 0.9,
                  urgency: 0.4,
                  supersedes: [ref("brief_create", "brief.id")],
                }),
              ],
            }),
          },
          // The two dismissal reactions. Keyed on the state the prompt
          // reports, so each asserts the guidance branch it belongs to.
          {
            flavour: "feedback.dismissal",
            promptContains: "Its state is now: dismissed_already_handled.",
            plan: {
              calls: [
                call("notes_append", {
                  text: `Lesson (${HANDLED_MARKER}): the balance card was already handled; stop resurfacing it.`,
                }),
              ],
              finalText: "Recorded the already-handled lesson.",
            },
          },
          {
            flavour: "feedback.dismissal",
            promptContains: "Its state is now: dismissed_not_relevant.",
            plan: {
              calls: [
                call("notes_append", {
                  text: `Lesson (${IRRELEVANT_MARKER}): depot-hours round-ups are not worth a card.`,
                }),
              ],
              finalText: "Recorded the not-relevant lesson.",
            },
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a brief's asserted claims persist with their evidence and are served live", async () => {
    const [docId] = await bench.pushAndSettle([CLAIMS_DOC]);
    const listed = await briefWith(bench, CLAIMS_MARKER);

    // The sidecar really holds the rows — the served set is not synthesized
    // from the tool arguments.
    const rows = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM brief_claims WHERE brief_id = ? AND invalidated_at IS NULL")
      .get(listed.id);
    expect(rows?.n).toBe(2);

    const detail = await bench.obs.brief(listed.id);
    expect(detail.brief.citations.map((c) => c.id)).toEqual([docId]);
    expect(detail.claims).toHaveLength(2);

    const [quoted, inferred] = detail.claims;
    expect(quoted!.claimText).toContain("Invoice 4471 is due on 14 November");
    expect(quoted!.evidenceQuote).toBe(INVOICE_QUOTE);
    expect(quoted!.claimBasis).toBe("quoted");
    expect(quoted!.confidence).toBeCloseTo(0.9, 5);
    expect(quoted!.evidenceDoc).not.toBeNull();
    expect(quoted!.evidenceDoc!.id).toBe(docId);
    expect(quoted!.evidenceDoc!.title).toBe(CLAIMS_DOC.title);

    expect(inferred!.evidenceQuote).toBe(PAYMENT_QUOTE);
    expect(inferred!.claimBasis).toBe("inferred");
    // The inferred ceiling holds — nothing about a claim's confidence is
    // taken on the model's word.
    expect(inferred!.confidence).toBeLessThanOrEqual(0.7);

    // A configured verifier ran, so both claims are born verified.
    expect(bench.entailmentCalls.length).toBeGreaterThanOrEqual(2);
    expect(detail.claims.map((c) => c.verificationState)).toEqual(["verified", "verified"]);
  }, 120_000);

  test("with no judge assigned the gate is absent and the brief is created unjudged", async () => {
    await bench.pushAndSettle([FAIL_OPEN_DOC]);
    const brief = await briefWith(bench, FAIL_OPEN_MARKER);
    expect(brief.title).toBe(JUDGE_HOLD_TITLE);

    // Not vacuous: the same title is HELD by the scripted judge in the second
    // describe. Here the production spend surface says no judge call was ever
    // made, so the card cleared an absent bar rather than a lenient one.
    const spend = await bench.obs.mechanismSpend();
    expect(spend.rows.filter((r) => r.mechanism === "brief-judge")).toHaveLength(0);
  }, 120_000);

  test("dismissing a brief settles a feedback run whose lesson lands", async () => {
    await bench.pushAndSettle([HANDLED_DOC, IRRELEVANT_DOC]);
    const handled = await briefWith(bench, HANDLED_MARKER);
    const irrelevant = await briefWith(bench, IRRELEVANT_MARKER);

    // `already_handled` is a loop-kind reason, `not_relevant` applies to
    // either — two states, two guidance branches, one bench.
    const handledDismissal = await bench.obs.dismissBrief(handled.id, {
      reason: "already_handled",
      feedback: "Paid it this morning.",
    });
    expect(handledDismissal.state).toBe("dismissed_already_handled");
    expect(handledDismissal.feedbackRunId).toBeTruthy();

    const irrelevantDismissal = await bench.obs.dismissBrief(irrelevant.id, {
      reason: "not_relevant",
    });
    expect(irrelevantDismissal.state).toBe("dismissed_not_relevant");

    await bench.drainUntilQuiet();

    // The id the route returned resolves in the runs ledger, as the run the
    // dismissal enqueued — and it settled.
    for (const [dismissal, briefId] of [
      [handledDismissal, handled.id],
      [irrelevantDismissal, irrelevant.id],
    ] as const) {
      const { run } = await bench.obs.run(dismissal.feedbackRunId!);
      expect(run.kind).toBe("feedback");
      expect(run.dedupeKey).toBe(`feedback:brief:${briefId}`);
      expect(run.status).toBe("completed");
    }

    // The state flip is durable and terminal on the brief itself.
    expect((await bench.obs.brief(handled.id)).brief.state).toBe("dismissed_already_handled");
    expect((await bench.obs.brief(irrelevant.id)).brief.state).toBe("dismissed_not_relevant");
    const feed = await bench.obs.feed({ limit: 100 });
    expect(feed.briefs.map((b) => b.id)).not.toContain(handled.id);
    expect(feed.briefs.map((b) => b.id)).not.toContain(irrelevant.id);

    // Each run was given the guidance for ITS state, and the scripted
    // reaction's mutation landed.
    const handledPrompt = await bench.obs.promptFor(handledDismissal.feedbackRunId!);
    expect(handledPrompt).toContain("ALREADY HANDLED");
    expect(handledPrompt).toContain('They also typed: "Paid it this morning."');
    const irrelevantPrompt = await bench.obs.promptFor(irrelevantDismissal.feedbackRunId!);
    expect(irrelevantPrompt).toContain("NOT RELEVANT");
    expect(irrelevantPrompt).toContain("They typed no free text.");

    const notes = await bench.obs.notes();
    expect(notes).toContain(HANDLED_MARKER);
    expect(notes).toContain(IRRELEVANT_MARKER);
    expect(notes).toContain("already handled; stop resurfacing it");
    expect(notes).toContain("not worth a card");
  }, 180_000);

  test("a brief scheduled for later is stored but withheld from the product feed", async () => {
    await bench.pushAndSettle([DATED_DOC]);
    const brief = await briefWith(bench, DATED_MARKER);

    // Admin sees the row, with both dates it was created with.
    expect(brief.state).toBe("unread");
    expect(brief.nextShow).not.toBeNull();
    expect(brief.eventAt).not.toBeNull();
    expect(Date.parse(brief.nextShow!)).toBeGreaterThan(Date.now());
    expect(Date.parse(brief.eventAt!)).toBeGreaterThan(Date.parse(brief.nextShow!));

    // The product feed does not — it is not due.
    const feed = await bench.obs.feed({ limit: 100 });
    expect(feed.briefs.map((b) => b.id)).not.toContain(brief.id);
    // And it is not counted as awaiting the user either.
    const withheld = await bench.obs.unreadCount();
    const showable = (await bench.obs.feed({ limit: 100 })).briefs.filter(
      (b) => b.state === "unread",
    );
    expect(withheld).toBe(showable.length);
  }, 120_000);

  test("the unread count tracks creation and read, and a dismissed brief cannot be read", async () => {
    const before = await bench.obs.unreadCount();

    await bench.pushAndSettle([READ_DOC]);
    const brief = await briefWith(bench, READ_MARKER);
    expect(await bench.obs.unreadCount()).toBe(before + 1);

    await bench.obs.readBrief(brief.id);
    expect(await bench.obs.unreadCount()).toBe(before);
    expect((await bench.obs.brief(brief.id)).brief.state).toBe("read");
    // Read is idempotent, and a read brief still shows.
    await bench.obs.readBrief(brief.id);
    expect(await bench.obs.unreadCount()).toBe(before);
    expect((await bench.obs.feed({ limit: 100 })).briefs.map((b) => b.id)).toContain(brief.id);

    await bench.obs.dismissBrief(brief.id, { reason: "acknowledged" });
    expect(await bench.obs.unreadCount()).toBe(before);
    // The feed never shows a dismissed card, so marking one read is a
    // client bug the route refuses loudly rather than absorbing.
    expect(await postStatus(bench, `/briefs/${brief.id}/read`)).toBe(409);
    // Dismissals are one-way too.
    expect(await postStatus(bench, `/briefs/${brief.id}/dismiss`, { reason: "not_relevant" })).toBe(
      409,
    );

    await bench.drainUntilQuiet();
  }, 180_000);

  test("a superseding brief retires the card it replaces", async () => {
    const [docId] = await bench.pushAndSettle([SUPERSEDE_DOC]);
    const both = await briefsWith(bench, SUPERSEDE_MARKER);
    expect(both).toHaveLength(2);
    const provisional = both.find((b) => b.title.startsWith("Provisional"))!;
    const corrected = both.find((b) => b.title.startsWith("Corrected"))!;
    expect(provisional).toBeDefined();
    expect(corrected).toBeDefined();

    // The tool reported the supersede against the id the first create minted.
    const run = await bench.obs.runForDoc(docId);
    const created = (await toolResultsOf(bench, run.id)).filter(
      (r) => r.resultType === "brief.created",
    );
    expect(created).toHaveLength(2);
    expect(created[1]!.data?.supersededBriefIds).toEqual([provisional.id]);

    // The replaced card keeps its row and its history, but is stamped out of
    // relevance so it leaves the feed at once.
    const retired = await bench.obs.brief(provisional.id);
    expect(retired.brief.relevantUntil).not.toBeNull();
    expect(Date.parse(retired.brief.relevantUntil!)).toBeLessThanOrEqual(Date.now());
    // No dismissal reason is minted — a supersede is the agent refreshing
    // its own card, not user feedback.
    expect(retired.brief.userFeedback).toBeNull();

    const feedIds = (await bench.obs.feed({ limit: 100 })).briefs.map((b) => b.id);
    expect(feedIds).toContain(corrected.id);
    expect(feedIds).not.toContain(provisional.id);
  }, 120_000);
});

// ── the judged bench ───────────────────────────────────────────────────────

describe("Brain Bench — briefs (brief judge assigned)", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // One judge, two verdicts: the bar is per-candidate, so a single
      // bench covers both arms.
      judge: ({ prompt }) => (prompt.includes(JUDGE_HOLD_TITLE) ? "hold" : "ship"),
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: FAIL_OPEN_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: JUDGE_HOLD_TITLE,
                  description: "The storage plan renews next month at the same rate.",
                  citations: [ctx.subject],
                  confidence: 0.6,
                  urgency: 0.2,
                }),
                // Deliberately after the held create: the run must carry on
                // past a HOLD, which is a verdict, not a failure.
                call("notes_append", {
                  text: `Lesson (${FAIL_OPEN_MARKER}): the renewal card did not clear the bar.`,
                }),
              ],
              finalText: "The renewal did not clear the bar; noted instead.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: HANDLED_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "loop",
                  title: JUDGE_SHIP_TITLE,
                  description: "The Riverside Estate balance is due before Friday.",
                  citations: [ctx.subject],
                  confidence: 0.9,
                  urgency: 0.8,
                }),
              ],
              finalText: "Raised the balance card.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: JUDGE_OUTAGE_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("brief_create", {
                  kind: "info",
                  title: JUDGE_OUTAGE_TITLE,
                  description: "The permit requirements are ready for review.",
                  citations: [ctx.subject],
                  confidence: 0.7,
                  urgency: 0.4,
                }),
              ],
              finalText: "Attempted the permit-review card.",
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a HELD candidate is never persisted, and the run completes anyway", async () => {
    const [docId] = await bench.pushAndSettle([FAIL_OPEN_DOC]);

    const run = await bench.obs.runForDoc(docId!);
    // A hold is a verdict, not an error: the run finished normally.
    expect(run.status).toBe("completed");

    // Nothing was written — not through the admin list, and not in the table
    // underneath it.
    expect(await briefsWith(bench, FAIL_OPEN_MARKER)).toHaveLength(0);
    const rows = bench.sql
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM briefs WHERE title = ?")
      .get(JUDGE_HOLD_TITLE);
    expect(rows?.n).toBe(0);

    // The refusal reached the agent as a STRUCTURED result, not a tool error.
    const results = await toolResultsOf(bench, run.id);
    const held = results.find((r) => r.resultType === "brief.held_by_judge");
    expect(held).toBeDefined();
    expect(held!.kind).toBe("structured");
    expect(String(held!.data?.reason)).toContain("scripted bench verdict");
    expect(results.some((r) => r.kind === "error")).toBe(false);

    // The judge was genuinely asked, about this candidate.
    expect(bench.judgeCalls.length).toBeGreaterThanOrEqual(1);
    const asked = bench.judgeCalls.filter((c) => c.prompt.includes(JUDGE_HOLD_TITLE));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.answer).toContain("VERDICT: HOLD");

    // And the run carried on past the hold.
    const notes = await bench.obs.notes();
    expect(notes).toContain(FAIL_OPEN_MARKER);
    expect(notes).toContain("did not clear the bar");
  }, 180_000);

  test("a configured judge outage holds the candidate instead of shipping unreviewed", async () => {
    bench.refuseJudgeWith(503, "scripted review outage");
    try {
      const [docId] = await bench.pushAndSettle([JUDGE_OUTAGE_DOC]);
      const run = await bench.obs.runForDoc(docId!);
      expect(run.status).toBe("completed");
      expect(await briefsWith(bench, JUDGE_OUTAGE_MARKER)).toHaveLength(0);

      const results = await toolResultsOf(bench, run.id);
      const held = results.find((r) => r.resultType === "brief.held_by_judge");
      expect(held).toBeDefined();
      expect(String(held!.data?.reason)).toContain("held rather than shipped without review");
      expect(results.some((r) => r.kind === "error")).toBe(false);
    } finally {
      bench.refuseJudgeWith(null);
    }
  }, 180_000);

  test("a SHIPPED candidate is created, and the judge's spend is recorded", async () => {
    await bench.pushAndSettle([HANDLED_DOC]);
    const brief = await briefWith(bench, HANDLED_MARKER);
    expect(brief.title).toBe(JUDGE_SHIP_TITLE);
    expect(brief.state).toBe("unread");
    expect((await bench.obs.feed({ limit: 100 })).briefs.map((b) => b.id)).toContain(brief.id);

    const asked = bench.judgeCalls.filter((c) => c.prompt.includes(JUDGE_SHIP_TITLE));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.answer).toContain("VERDICT: SHIP");
    // The judge's prompt carries the timing/grounding signals it cannot read
    // off the prose.
    expect(asked[0]!.prompt).toContain("grounded in 1 cited document(s)");
    expect(asked[0]!.prompt).toContain("would surface now");

    // Every verdict costs a model call, folded into the cognition spend
    // ledger under its own mechanism — the operator-visible proof the bar
    // ran at all.
    const spend = await bench.obs.mechanismSpend();
    const judgeRows = spend.rows.filter((r) => r.mechanism === "brief-judge");
    expect(judgeRows.length).toBeGreaterThan(0);
    expect(judgeRows[0]!.promptTokens).toBeGreaterThan(0);
    expect(judgeRows.reduce((n, r) => n + r.runs, 0)).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
