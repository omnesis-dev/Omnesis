// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area D: durable document and person annotations, and the
 * grounding gate that decides whether the agent is allowed to remember.
 *
 * Everything here runs through the real tool layer: the quote-in-document
 * firewall, the per-basis confidence clamp and its abstention floor, the
 * one-belief-per-(subject, claimType) invariant, the entailment gate in all
 * three of its arms (reject / accept / unassigned), the supersession and
 * revise/retract lifecycles, the multi-evidence sidecar, and the consumption
 * edges that record which brief was built on which prior.
 *
 * Two gateways, split only where the entailment policy has to differ: the
 * first leaves the `entailment-verifier` role unassigned (the state every
 * other suite implicitly runs in), the second wires a scripted verifier that
 * rejects one claim and accepts the other.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  note,
  ref,
  type ExecutedTool,
  type ToolResultView,
} from "./brain-bench/index.js";

compressCognitionCadences();

// ── fixtures (invented from scratch: fictional people, vendors, amounts) ────

const DOC_CLAMP = email({
  externalId: "brain-anno-clamp",
  title: "Cedar Grove Supplies order confirmation",
  content: [
    "Hi Alex,",
    "",
    "Your order for the workshop benches is confirmed under reference CG-4417.",
    "The agreed delivery window is fourteen business days from today.",
    "Payment terms remain net thirty on every open account.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});
const CLAMP_QUOTED = "Your order for the workshop benches is confirmed under reference CG-4417.";
const CLAMP_INFERRED = "The agreed delivery window is fourteen business days from today.";
const CLAMP_SYNTHESIZED = "Payment terms remain net thirty on every open account.";

const DOC_QUOTE_GATE = email({
  externalId: "brain-anno-quote-gate",
  title: "Studio Northstar rehearsal slot",
  content: [
    "Hi Alex,",
    "",
    "The rehearsal room is free on the first Tuesday of next month.",
    "",
    "Studio Northstar",
  ].join("\n"),
});
/** Nowhere in the document — the reground teeth must refuse it. */
const QUOTE_NOT_IN_DOC = "The rehearsal room is booked for the whole of next month.";

const DOC_FLOOR = note({
  externalId: "brain-anno-floor",
  title: "Riverside Estate site visit notes",
  content: "The access road is unpaved for the final two hundred metres.",
});

const DOC_FAIL_OPEN = email({
  externalId: "brain-anno-fail-open",
  title: "Riverside Estate parking arrangements",
  content: [
    "Hi Alex,",
    "",
    "Parking for the weekend is limited to twelve vehicles.",
    "",
    "Riverside Estate",
  ].join("\n"),
});

const DOC_PERSON = email({
  externalId: "brain-anno-person",
  title: "Handover of the supplier account",
  content: [
    "Hi Alex,",
    "",
    "Maya Reeves now runs the supplier account for Cedar Grove Supplies.",
    "",
    "Jamie Lopez",
  ].join("\n"),
});
const PERSON_QUOTE = "Maya Reeves now runs the supplier account for Cedar Grove Supplies.";

const DOC_SUPERSEDE = email({
  externalId: "brain-anno-supersede",
  title: "Riverside Estate booking status",
  content: [
    "Hi Alex,",
    "",
    "The hall is provisionally held for the autumn weekend.",
    "A signed contract is still outstanding on our side.",
    "We will confirm the catering headcount separately.",
    "",
    "Riverside Estate",
  ].join("\n"),
});

const DOC_REVISE = email({
  externalId: "brain-anno-revise",
  title: "Stellar Sound equipment quote",
  content: [
    "Hi Alex,",
    "",
    "The quote for the monitor pair comes to four hundred and ten.",
    "We can hold that price until the end of the quarter.",
    "",
    "Stellar Sound",
  ].join("\n"),
});

const DOC_MULTI_EVIDENCE = note({
  externalId: "brain-anno-multi-evidence",
  title: "Workshop attendance log",
  content: "Attendance for the winter workshop reached sixty two people.",
});
const DOC_MULTI = email({
  externalId: "brain-anno-multi",
  title: "Winter workshop wrap-up",
  content: [
    "Hi Alex,",
    "",
    "The winter workshop filled every available seat this year.",
    "",
    "Studio Northstar",
  ].join("\n"),
});

const DOC_PRIOR = email({
  externalId: "brain-anno-consume-prior",
  title: "Cedar Grove Supplies account review notice",
  content: [
    "Hi Alex,",
    "",
    "The annual account review is due before the end of next month.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});
const PRIOR_QUOTE = "The annual account review is due before the end of next month.";
const DOC_CONSUME = email({
  externalId: "brain-anno-consume",
  title: "Cedar Grove Supplies account review follow-up",
  content: [
    "Hi Alex,",
    "",
    "Please confirm who is attending the account review from your side.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});

// Set once the evidence-only documents have gateway ids; the plans close over
// them, and the plan body is evaluated per turn (well after the push).
let multiEvidenceDocId = "";
let priorDocId = "";

// ── local helpers ──────────────────────────────────────────────────────────

/** A tool result the gateway actually answered with. */
type ToolResult = NonNullable<ToolResultView>;

/** The settled data run a pushed document caused. */
async function runIdFor(bench: BrainBench, docId: string): Promise<string> {
  const run = await bench.obs.runForDoc(docId);
  expect(run.status).toBe("completed");
  return run.id;
}

/** The results of one tool in a run, in call order. */
function resultsOf(calls: readonly ExecutedTool[], tool: string): ToolResult[] {
  return calls.filter((c) => c.tool === tool).map((c) => c.result ?? {});
}

/** The `data` payload of a structured tool result. */
function structured(result: ToolResult): Record<string, unknown> {
  expect(result.kind).toBe("structured");
  return result.data as Record<string, unknown>;
}

/** The `id` a structured create result minted. */
function mintedId(result: ToolResult): string {
  const id = structured(result).id;
  expect(typeof id).toBe("string");
  return id as string;
}

interface RawAnnotationRow {
  id: string;
  invalidated_at: number | null;
  superseded_by: string | null;
}

/** The stored row behind an annotation id — including one no read route serves. */
function rawAnnotation(bench: BrainBench, id: string): RawAnnotationRow | undefined {
  return bench.sql
    .prepare<
      [string],
      RawAnnotationRow
    >("SELECT id, invalidated_at, superseded_by FROM doc_annotations WHERE id = ?")
    .get(id);
}

// ── the main bench: no entailment verifier assigned ─────────────────────────

describe("annotations with the entailment role unassigned", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: DOC_CLAMP.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "order-status",
                  claimText: "The workshop bench order is confirmed under reference CG-4417.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: CLAMP_QUOTED,
                  confidence: 0.99,
                  claimBasis: "quoted",
                }),
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "delivery-window",
                  claimText: "The benches should arrive within fourteen business days.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: CLAMP_INFERRED,
                  confidence: 0.99,
                  claimBasis: "inferred",
                }),
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "payment-terms",
                  claimText: "Cedar Grove Supplies bills this account on net-thirty terms.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: CLAMP_SYNTHESIZED,
                  confidence: 0.99,
                  claimBasis: "synthesized",
                }),
              ],
              finalText: "Recorded three grounded observations at three claim bases.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_QUOTE_GATE.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "availability",
                  claimText: "The rehearsal room is unavailable next month.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: QUOTE_NOT_IN_DOC,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
              ],
              finalText: "The quote did not hold up; recorded nothing.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_FLOOR.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "access",
                  claimText: "The site is probably hard to reach in winter.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "The access road is unpaved for the final two hundred metres.",
                  confidence: 0.2,
                  claimBasis: "synthesized",
                }),
              ],
              finalText: "Too weak to keep as a prior.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_FAIL_OPEN.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "capacity",
                  claimText: "Weekend parking is capped at twelve vehicles.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "Parking for the weekend is limited to twelve vehicles.",
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_PERSON.title,
            plan: (ctx) => ({
              calls: [
                call("lookup_people", { query: "Maya Reeves" }),
                call("annotate_person", {
                  personId: ref("lookup_people", "results.0.canonicalId"),
                  claimType: "role",
                  claimText: "Maya Reeves runs the Cedar Grove Supplies account.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: PERSON_QUOTE,
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_SUPERSEDE.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "booking-status",
                  claimText: "The hall is provisionally held for the autumn weekend.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "The hall is provisionally held for the autumn weekend.",
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
                // Replaces the belief above with a corrected one, in one call.
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "booking-status",
                  claimText: "The hall hold is unconfirmed until the contract is signed.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "A signed contract is still outstanding on our side.",
                  confidence: 0.7,
                  claimBasis: "inferred",
                  supersedes: ref("annotate_durable", "id", 0),
                }),
                // A second live belief, under its own claim type, retired by a
                // pure supersede in favour of the one above.
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "catering",
                  claimText: "The catering headcount will be confirmed separately.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "We will confirm the catering headcount separately.",
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
                call("annotation_supersede", {
                  id: ref("annotate_durable", "id", 2),
                  supersededBy: ref("annotate_durable", "id", 1),
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_REVISE.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "quote-status",
                  claimText: "Alex asked Stellar Sound about a monitor pair.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "The quote for the monitor pair comes to four hundred and ten.",
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
                // Wording only: identity, basis and confidence must survive.
                call("annotation_revise", {
                  id: ref("annotate_durable", "id", 0),
                  claimText: "Stellar Sound quoted four hundred and ten for the monitor pair.",
                }),
                // A basis downgrade with NO new confidence must still pull the
                // standing 0.9 under the synthesized ceiling.
                call("annotation_revise", {
                  id: ref("annotate_durable", "id", 0),
                  claimBasis: "synthesized",
                }),
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "price-hold",
                  claimText: "The quoted price holds until the end of the quarter.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "We can hold that price until the end of the quarter.",
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
                call("annotation_retract", { id: ref("annotate_durable", "id", 1) }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_MULTI.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "attendance",
                  claimText: "The winter workshop ran at full capacity.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: "The winter workshop filled every available seat this year.",
                  confidence: 0.9,
                  claimBasis: "synthesized",
                  additionalEvidence: [
                    {
                      docId: multiEvidenceDocId,
                      quote: "Attendance for the winter workshop reached sixty two people.",
                    },
                  ],
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_PRIOR.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "review-due",
                  claimText: "Cedar Grove Supplies expects the account review before month end.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: PRIOR_QUOTE,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_CONSUME.title,
            plan: (ctx) => ({
              calls: [
                // The prior was written by an EARLIER run, so only this read
                // can put it in front of the model this run.
                call("annotation_search", { docId: priorDocId }),
                call("brief_create", {
                  kind: "info",
                  title: "Cedar Grove Supplies review needs attendees",
                  description: "The review is due next month and needs names from your side.",
                  citations: [ctx.subject],
                  confidence: 0.8,
                  urgency: 0.4,
                  annotationDependencies: [
                    { store: "doc", annotationId: ref("annotation_search", "annotations.0.id") },
                  ],
                }),
                // The negative arm: a prior this run never saw cannot be
                // declared as a dependency.
                call("open_loop_create", {
                  title: "Confirm the account review attendees",
                  confidence: 0.8,
                  importance: 0.5,
                  docs: [ctx.subject],
                  annotationDependencies: [
                    { store: "doc", annotationId: "anno_never_surfaced_in_this_run" },
                  ],
                }),
              ],
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a durable annotation lands, clamped to its claim basis' ceiling", async () => {
    const [docId] = await bench.pushAndSettle([DOC_CLAMP]);

    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations).toHaveLength(3);

    const byType = new Map(annotations.map((a) => [a.claimType, a]));

    const quoted = byType.get("order-status");
    expect(quoted).toBeDefined();
    expect(quoted!.claimBasis).toBe("quoted");
    expect(quoted!.evidenceQuote).toBe(CLAMP_QUOTED);
    expect(quoted!.evidenceDocId).toBe(docId);
    expect(quoted!.claimText).toContain("CG-4417");
    // 0.99 requested; the quoted ceiling is 0.9.
    expect(quoted!.confidence).toBeCloseTo(0.9, 6);

    const inferred = byType.get("delivery-window");
    expect(inferred!.claimBasis).toBe("inferred");
    expect(inferred!.evidenceQuote).toBe(CLAMP_INFERRED);
    expect(inferred!.confidence).toBeCloseTo(0.7, 6);

    const synthesized = byType.get("payment-terms");
    expect(synthesized!.claimBasis).toBe("synthesized");
    expect(synthesized!.evidenceQuote).toBe(CLAMP_SYNTHESIZED);
    expect(synthesized!.confidence).toBeCloseTo(0.55, 6);

    // The clamp is reported back to the model, not applied silently.
    const runId = await runIdFor(bench, docId!);
    const results = resultsOf(await bench.obs.executedTools(runId), "annotate_durable");
    expect(results).toHaveLength(3);
    expect(structured(results[0]!).confidenceCappedTo).toBeCloseTo(0.9, 6);
    expect(structured(results[2]!).confidenceCappedTo).toBeCloseTo(0.55, 6);
  }, 120_000);

  test("a quote absent from the cited document is refused and nothing persists", async () => {
    const [docId] = await bench.pushAndSettle([DOC_QUOTE_GATE]);

    const runId = await runIdFor(bench, docId!);
    const [result] = resultsOf(await bench.obs.executedTools(runId), "annotate_durable");
    expect(result).toBeDefined();
    expect(result!.kind).toBe("error");
    expect(result!.code).toBe("evidence_not_found");

    expect((await bench.obs.docAnnotations(docId!)).annotations).toHaveLength(0);
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM doc_annotations WHERE doc_id = ?")
        .get(docId!)?.n,
    ).toBe(0);
    // The refusal is re-askable, not fatal: the run still settles cleanly.
    const runs = await bench.obs.runs({ kind: "data" });
    expect(runs.items.find((r) => r.id === runId)!.status).toBe("completed");
    expect((await bench.obs.pulse()).counts.failedRuns24h).toBe(0);
  }, 120_000);

  test("a claim below the abstention floor is refused outright", async () => {
    const [docId] = await bench.pushAndSettle([DOC_FLOOR]);

    const runId = await runIdFor(bench, docId!);
    const [result] = resultsOf(await bench.obs.executedTools(runId), "annotate_durable");
    expect(result!.kind).toBe("error");
    expect(result!.code).toBe("insufficient_confidence_to_persist");
    expect(String(result!.message)).toContain("0.25");

    expect((await bench.obs.docAnnotations(docId!)).annotations).toHaveLength(0);
  }, 120_000);

  test("with no verifier configured the entailment gate fails open, unstamped", async () => {
    const [docId] = await bench.pushAndSettle([DOC_FAIL_OPEN]);
    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations).toHaveLength(1);
    // The write lands, and carries NO verification stamp — "no verifier" is
    // distinguishable from "verified" and from "checked but unavailable".
    expect(annotations[0]!.verificationState).toBeNull();
    expect(annotations[0]!.lastVerifiedAt).toBeNull();

    // Not vacuous: the gateway's own spend ledger agrees the verifier was
    // never consulted, so the unstamped row is a gate that fell open rather
    // than a verdict that happened to be silent.
    const spend = await bench.obs.mechanismSpend();
    expect(spend.rows.filter((r) => r.mechanism === "entailment-verifier")).toHaveLength(0);
  }, 120_000);

  test("a person annotation lands on the canonical person id", async () => {
    const person = bench.sql
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM people WHERE canonical_name = 'Maya Reeves' AND merged_into IS NULL")
      .get();
    expect(person?.id).toBeTruthy();

    const [docId] = await bench.pushAndSettle([DOC_PERSON]);

    const runId = await runIdFor(bench, docId!);
    const calls = await bench.obs.executedTools(runId);
    const lookup = calls.find((c) => c.tool === "lookup_people");
    expect(lookup?.result?.kind).toBe("person.results");
    const [created] = resultsOf(calls, "annotate_person");
    expect(created).toBeDefined();
    const data = structured(created!);
    expect(data.personId).toBe(person!.id);

    const { annotations } = await bench.obs.personAnnotations(person!.id);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.id).toBe(data.id);
    expect(annotations[0]!.claimType).toBe("role");
    expect(annotations[0]!.evidenceDocId).toBe(docId);
    expect(annotations[0]!.evidenceQuote).toBe(PERSON_QUOTE);
    expect(annotations[0]!.confidence).toBeCloseTo(0.8, 6);
  }, 120_000);

  test("only the live head of a supersede chain is served", async () => {
    const [docId] = await bench.pushAndSettle([DOC_SUPERSEDE]);

    const runId = await runIdFor(bench, docId!);
    const calls = await bench.obs.executedTools(runId);
    const creates = resultsOf(calls, "annotate_durable");
    expect(creates).toHaveLength(3);
    const [first, second, third] = creates.map((r) => mintedId(r));

    // The superseding create reports what it retired.
    expect(structured(creates[1]!).supersededId).toBe(first);
    const [pureSupersede] = resultsOf(calls, "annotation_supersede");
    expect(structured(pureSupersede!)).toMatchObject({ id: third, supersededBy: second });

    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations.map((a) => a.id)).toEqual([second]);
    expect(annotations[0]!.claimText).toContain("unconfirmed until the contract is signed");

    // Both retired rows are kept for audit, pointing at their successor.
    const retiredFirst = rawAnnotation(bench, first!);
    expect(retiredFirst?.invalidated_at).toEqual(expect.any(Number));
    expect(retiredFirst?.superseded_by).toBe(second);
    const retiredThird = rawAnnotation(bench, third!);
    expect(retiredThird?.invalidated_at).toEqual(expect.any(Number));
    expect(retiredThird?.superseded_by).toBe(second);
  }, 120_000);

  test("revise edits in place and re-clamps; retract removes the derived text", async () => {
    const [docId] = await bench.pushAndSettle([DOC_REVISE]);

    const runId = await runIdFor(bench, docId!);
    const calls = await bench.obs.executedTools(runId);
    const creates = resultsOf(calls, "annotate_durable");
    expect(creates).toHaveLength(2);
    const revisedId = mintedId(creates[0]!);
    const retractedId = mintedId(creates[1]!);

    const revises = resultsOf(calls, "annotation_revise");
    expect(revises).toHaveLength(2);
    // A wording-only revise edits the row in place and touches nothing else.
    expect(structured(revises[0]!)).toMatchObject({
      id: revisedId,
      claimType: "quote-status",
      claimBasis: "quoted",
    });
    expect(structured(revises[0]!).confidence).toBeCloseTo(0.9, 6);
    expect(structured(revises[0]!).confidenceCappedTo).toBeUndefined();
    // The basis downgrade re-clamps the STANDING confidence, unasked.
    expect(structured(revises[1]!).claimBasis).toBe("synthesized");
    expect(structured(revises[1]!).confidence).toBeCloseTo(0.55, 6);
    expect(structured(revises[1]!).confidenceCappedTo).toBeCloseTo(0.55, 6);

    const [retract] = resultsOf(calls, "annotation_retract");
    expect(structured(retract!).id).toBe(retractedId);

    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations.map((a) => a.id)).toEqual([revisedId]);
    // Same row, new claim — a revise is an edit, not a replacement.
    expect(annotations[0]!.claimText).toBe(
      "Stellar Sound quoted four hundred and ten for the monitor pair.",
    );
    expect(annotations[0]!.claimType).toBe("quote-status");
    expect(annotations[0]!.claimBasis).toBe("synthesized");
    expect(annotations[0]!.confidence).toBeCloseTo(0.55, 6);
    // The grounding quote is immutable across revises.
    expect(annotations[0]!.evidenceQuote).toBe(
      "The quote for the monitor pair comes to four hundred and ten.",
    );
    // The quote firewall re-ran, so the row is no longer permanently due.
    expect(annotations[0]!.lastVerifiedAt).not.toBeNull();

    // `annotation_retract` is a HARD delete (see `deleteDocAnnotation`): the
    // row and its evidence sidecar go, rather than being invalidated in place.
    expect(rawAnnotation(bench, retractedId)).toBeUndefined();
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM doc_annotation_evidence WHERE annotation_id = ?")
        .get(retractedId)?.n,
    ).toBe(0);
  }, 120_000);

  test("additional evidence is written to the evidence sidecar", async () => {
    const [evidenceDocId] = await bench.pushAndSettle([DOC_MULTI_EVIDENCE]);
    multiEvidenceDocId = evidenceDocId!;
    // The DOC_MULTI plan grounds its second evidence atom in this id, so a
    // blank here would silently degrade the write it is meant to exercise.
    expect(multiEvidenceDocId).not.toBe("");
    const [docId] = await bench.pushAndSettle([DOC_MULTI]);

    const runId = await runIdFor(bench, docId!);
    const [created] = resultsOf(await bench.obs.executedTools(runId), "annotate_durable");
    expect(created!.kind).toBe("structured");
    const data = structured(created!);
    expect(data.evidenceCount).toBe(2);
    const annotationId = data.id as string;

    const atoms = bench.sql
      .prepare<[string], { position: number; evidence_doc_id: string; evidence_quote: string }>(
        `SELECT position, evidence_doc_id, evidence_quote
           FROM doc_annotation_evidence WHERE annotation_id = ? ORDER BY position`,
      )
      .all(annotationId);
    expect(atoms).toHaveLength(2);
    // Position 0 always mirrors the parent's scalar pair.
    expect(atoms[0]).toMatchObject({
      position: 0,
      evidence_doc_id: docId,
      evidence_quote: "The winter workshop filled every available seat this year.",
    });
    expect(atoms[1]).toMatchObject({
      position: 1,
      evidence_doc_id: evidenceDocId,
      evidence_quote: "Attendance for the winter workshop reached sixty two people.",
    });

    // A synthesized claim asking for 0.9 is still clamped to 0.55.
    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.confidence).toBeCloseTo(0.55, 6);
  }, 120_000);

  test("a declared dependency on a surfaced prior records a consumption edge", async () => {
    const [seededDocId] = await bench.pushAndSettle([DOC_PRIOR]);
    priorDocId = seededDocId!;
    // The DOC_CONSUME plan reads this document's annotations, so a blank here
    // would turn the dependency arm into a search over nothing.
    expect(priorDocId).not.toBe("");
    const priorAnnotations = (await bench.obs.docAnnotations(priorDocId)).annotations;
    expect(priorAnnotations).toHaveLength(1);
    const priorId = priorAnnotations[0]!.id;
    expect(priorAnnotations[0]!.dependentCount).toBe(0);

    const [docId] = await bench.pushAndSettle([DOC_CONSUME]);
    const runId = await runIdFor(bench, docId!);
    const calls = await bench.obs.executedTools(runId);

    // The read really surfaced the prior written by the EARLIER run.
    const [search] = resultsOf(calls, "annotation_search");
    const surfaced = structured(search!).annotations as Array<{ id: string }>;
    expect(surfaced.map((a) => a.id)).toEqual([priorId]);

    const [briefResult] = resultsOf(calls, "brief_create");
    expect(briefResult!.kind).toBe("structured");
    const briefId = (structured(briefResult!).brief as { id: string }).id;

    const dependents = await bench.obs.dependents("doc", priorId);
    expect(dependents.items).toHaveLength(1);
    expect(dependents.items[0]).toMatchObject({ kind: "brief", id: briefId, runId });

    const edges = bench.sql
      .prepare<
        [string],
        { prior_store: string; dependent_kind: string; dependent_id: string; run_id: string }
      >(
        `SELECT prior_store, dependent_kind, dependent_id, run_id
           FROM cognition_consumption_edges WHERE prior_annotation_id = ?`,
      )
      .all(priorId);
    expect(edges).toEqual([
      { prior_store: "doc", dependent_kind: "brief", dependent_id: briefId, run_id: runId },
    ]);

    // And the per-entity read route reports the same dependency.
    expect((await bench.obs.docAnnotations(priorDocId)).annotations[0]!.dependentCount).toBe(1);

    // The negative: an id this run never saw is refused, and the write with it
    // never lands.
    const [loopResult] = resultsOf(calls, "open_loop_create");
    expect(loopResult!.kind).toBe("error");
    expect(loopResult!.code).toBe("invalid_args");
    expect(String(loopResult!.message)).toContain("doc:anno_never_surfaced_in_this_run");
    expect((await bench.obs.loops()).items).toHaveLength(0);
  }, 180_000);
});

// ── the entailment gate, driven into both arms ─────────────────────────────

const DOC_ENTAIL_REJECT = email({
  externalId: "brain-anno-entail-reject",
  title: "Cedar Grove Supplies catering status",
  content: [
    "Hi Alex,",
    "",
    "The catering order has not been scheduled yet.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});
const REJECT_QUOTE = "The catering order has not been scheduled yet.";
const REJECT_CLAIM = "The catering order is scheduled and paid in full.";

const DOC_ENTAIL_ACCEPT = email({
  externalId: "brain-anno-entail-accept",
  title: "Studio Northstar rehearsal confirmation",
  content: [
    "Hi Alex,",
    "",
    "The rehearsal is confirmed for the second Thursday of the month.",
    "",
    "Studio Northstar",
  ].join("\n"),
});
const ACCEPT_QUOTE = "The rehearsal is confirmed for the second Thursday of the month.";
const ACCEPT_CLAIM = "The rehearsal is confirmed for the second Thursday of the month.";

const DOC_ENTAIL_MULTI = email({
  externalId: "brain-anno-entail-multi",
  title: "Studio Northstar monthly schedule",
  content: [
    "Hi Alex,",
    "",
    "The monthly slot has been reserved under your name since the spring.",
    "",
    "Studio Northstar",
  ].join("\n"),
});
const MULTI_QUOTE = "The monthly slot has been reserved under your name since the spring.";
const MULTI_CLAIM = "Alex holds a standing monthly rehearsal slot at Studio Northstar.";

/** Set by the accept test; the multi-evidence plan grounds a second atom in it. */
let entailAcceptDocId = "";

describe("the entailment gate decides whether a grounded claim may persist", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // One verifier, both arms: the quote that denies its claim is judged
      // NEUTRAL, everything else ENTAILMENT — so a single gateway covers the
      // refuse and the accept paths.
      entailment: ({ evidence }) =>
        evidence.includes("has not been scheduled") ? "neutral" : "entailment",
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: DOC_ENTAIL_REJECT.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "catering-status",
                  claimText: REJECT_CLAIM,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: REJECT_QUOTE,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_ENTAIL_ACCEPT.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "rehearsal-status",
                  claimText: ACCEPT_CLAIM,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: ACCEPT_QUOTE,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: DOC_ENTAIL_MULTI.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "standing-booking",
                  claimText: MULTI_CLAIM,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: MULTI_QUOTE,
                  confidence: 0.9,
                  claimBasis: "synthesized",
                  additionalEvidence: [{ docId: entailAcceptDocId, quote: ACCEPT_QUOTE }],
                }),
              ],
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a claim the verifier does not accept is refused and never persists", async () => {
    const [docId] = await bench.pushAndSettle([DOC_ENTAIL_REJECT]);

    const runId = await runIdFor(bench, docId!);
    const [result] = resultsOf(await bench.obs.executedTools(runId), "annotate_durable");
    expect(result!.kind).toBe("error");
    expect(result!.code).toBe("evidence_does_not_entail_claim");
    expect(String(result!.message)).toContain("neutral");

    expect((await bench.obs.docAnnotations(docId!)).annotations).toHaveLength(0);
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM doc_annotations WHERE doc_id = ?")
        .get(docId!)?.n,
    ).toBe(0);

    // The verifier was really consulted — with this claim, about this quote.
    const consulted = bench.entailmentCalls.filter((c) => c.claim === REJECT_CLAIM);
    expect(consulted).toHaveLength(1);
    expect(consulted[0]!.evidence).toBe(REJECT_QUOTE);
    expect(consulted[0]!.answer).toBe("NEUTRAL");
  }, 120_000);

  test("an entailed claim persists born-verified with a check timestamp", async () => {
    const before = bench.entailmentCalls.length;
    const [docId] = await bench.pushAndSettle([DOC_ENTAIL_ACCEPT]);
    entailAcceptDocId = docId!;

    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.verificationState).toBe("verified");
    expect(annotations[0]!.lastVerifiedAt).not.toBeNull();
    expect(Date.parse(annotations[0]!.lastVerifiedAt!)).toBeGreaterThan(0);

    const consulted = bench.entailmentCalls.slice(before).filter((c) => c.claim === ACCEPT_CLAIM);
    expect(consulted).toHaveLength(1);
    expect(consulted[0]!.evidence).toBe(ACCEPT_QUOTE);
    expect(consulted[0]!.answer).toBe("ENTAILMENT");
  }, 120_000);

  test("a multi-atom grounding is judged jointly, in one verifier call", async () => {
    expect(entailAcceptDocId).not.toBe("");
    const before = bench.entailmentCalls.length;
    const [docId] = await bench.pushAndSettle([DOC_ENTAIL_MULTI]);

    // ONE call for the whole write, not one per atom.
    const consulted = bench.entailmentCalls.slice(before);
    expect(consulted).toHaveLength(1);
    expect(consulted[0]!.claim).toBe(MULTI_CLAIM);
    // Both quotes reach the verifier, enumerated and jointly judged.
    expect(consulted[0]!.prompt).toContain(`[1] ${MULTI_QUOTE}`);
    expect(consulted[0]!.prompt).toContain(`[2] ${ACCEPT_QUOTE}`);

    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.verificationState).toBe("verified");
    // Synthesized ceiling still applies on top of the gate's verdict.
    expect(annotations[0]!.confidence).toBeCloseTo(0.55, 6);

    const atoms = bench.sql
      .prepare<[string], { position: number; evidence_doc_id: string }>(
        `SELECT position, evidence_doc_id FROM doc_annotation_evidence
           WHERE annotation_id = ? ORDER BY position`,
      )
      .all(annotations[0]!.id);
    expect(atoms).toEqual([
      { position: 0, evidence_doc_id: docId },
      { position: 1, evidence_doc_id: entailAcceptDocId },
    ]);
  }, 120_000);
});
