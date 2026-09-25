// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area E: the verification lane and consumption provenance.
 *
 * Two mechanisms meet here, and neither had an end-to-end net before:
 *
 *  - the RE-VERIFICATION lane (`brain/rhythm/reverification-sweep.ts`): a
 *    daily pass that selects live annotations whose grounding check is stale
 *    or missing and enqueues them as `verification` agent runs, one store per
 *    run, so the agent re-grounds each against its cited evidence. Plus the
 *    push half that keeps it honest — the content-change invalidator
 *    (`brain/annotation-invalidator.ts`), which breaks evidence atoms whose
 *    quote no longer appears, promotes the next atom into the scalar mirror,
 *    and soft-invalidates an annotation that lost its last grounding.
 *
 *  - CONSUMPTION PROVENANCE (`brain/storage/consumption-edges.ts`): the edges
 *    recording which briefs/loops were built on which annotation priors, and
 *    the teeth that re-examine a dependent once a prior it rested on dies.
 *
 * Three of the tests here are LIVELOCK probes. A background lane whose
 * progress marker only moves under a condition it does not control — an
 * optional model role, a batch that never shrinks, a queue row that can never
 * be claimed — stops making progress without ever failing, which is the
 * failure shape that never shows up in a unit test.
 *
 * All example data is invented: fictional vendors, fictional bookings.
 */

import Database from "better-sqlite3";
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  note,
  ref,
  sleep,
  waitFor,
  type BenchDoc,
  type PlanCall,
  type PuppetPlan,
  type RunContext,
} from "./brain-bench/index.js";

compressCognitionCadences();

// ── shared probe shapes ─────────────────────────────────────────────────────

interface AnnotationProbeRow {
  id: string;
  doc_id: string;
  claim_type: string;
  claim_text: string;
  evidence_doc_id: string;
  evidence_quote: string;
  confidence: number;
  verification_state: string | null;
  last_verified_at: number | null;
  invalidated_at: number | null;
  created_at: number;
}

interface RunProbeRow {
  id: string;
  kind: string;
  status: string;
  dedupe_key: string | null;
  payload_json: string;
  attempts: number;
}

interface EvidenceProbeRow {
  position: number;
  evidence_doc_id: string;
  evidence_quote: string;
  broken_at: number | null;
}

const ANNOTATION_COLUMNS =
  "id, doc_id, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, " +
  "verification_state, last_verified_at, invalidated_at, created_at";

const RUN_COLUMNS = "id, kind, status, dedupe_key, payload_json, attempts";

/**
 * The re-verification sweep's progress marker
 * (`COGNITION_REVERIFICATION_LAST_RUN_KEY`). Read straight from
 * `cognition_engine_state` — no route exposes it.
 */
const REVERIFICATION_MARKER_KEY = "reverification_last_run_at";

// ── the verification steward ────────────────────────────────────────────────

/**
 * Every annotation line the verification prompt renders, as the prompt
 * builder writes it:
 *
 *   `- <id> (<claimType>, basis <basis>, conf <0.00>, <checked>) about
 *      document <docId>: "<claimText>" — evidence doc <docId>: "<quote>"`
 *
 * Reading the ids back out of the prompt is what lets one behavior drive
 * every verification run without knowing which annotations the sweep batched
 * — the batch is the sweep's choice, not the test's.
 */
const PROMPT_ANNOTATION_LINE = /^- (anno_\S+) \([^)]*conf ([0-9.]+)[^)]*\).*$/gm;

/** claimType marking the one annotation whose verification must RETRACT it. */
const RETRACT_MARKER_CLAIM_TYPE = "retract-me-marker";

interface PromptAnnotation {
  id: string;
  confidence: number;
  line: string;
}

function annotationsNamedInPrompt(prompt: string): PromptAnnotation[] {
  const out: PromptAnnotation[] = [];
  PROMPT_ANNOTATION_LINE.lastIndex = 0;
  for (;;) {
    const m = PROMPT_ANNOTATION_LINE.exec(prompt);
    if (m === null) break;
    out.push({ id: m[1]!, confidence: Number(m[2]!), line: m[0]! });
  }
  return out;
}

/**
 * The scripted re-grounding verdict: re-affirm every annotation by
 * re-supplying its standing confidence unchanged (the prompt's own
 * "still supported" arm), except the one flagged for retraction.
 */
function verificationPlan(ctx: RunContext): PuppetPlan {
  const calls: PlanCall[] = [];
  for (const a of annotationsNamedInPrompt(ctx.prompt)) {
    if (a.line.includes(RETRACT_MARKER_CLAIM_TYPE)) {
      calls.push(call("annotation_retract", { id: a.id }));
    } else {
      calls.push(call("annotation_revise", { id: a.id, confidence: a.confidence }));
    }
  }
  return { calls, finalText: "Re-grounded the flagged annotations against their evidence." };
}

// ═══════════════════════════════════════════════════════════════════════════
// Bench A — the re-verification lane (virtual clock, no entailment verifier)
// ═══════════════════════════════════════════════════════════════════════════

/** One seeded annotation: the document that carries it and the claim it makes. */
interface Seed {
  doc: BenchDoc;
  claimType: string;
  claimText: string;
  quote: string;
}

const QUOTE_HOLD = "The rehearsal room at Studio Northstar is held for the first week of April.";
const QUOTE_TERMS = "Invoices from Cedar Grove Supplies are payable within thirty days of issue.";
const QUOTE_VISIT = "The site visit window at Riverside Estate runs from the ninth to the twelfth.";
const QUOTE_COLLECT =
  "Equipment from Stellar Sound must be collected before the bay closes at six.";
const QUOTE_PROVISIONAL = "The provisional hold on the small studio expires unless confirmed.";

const SEEDS: Seed[] = [
  {
    doc: note({
      externalId: "verify-hold-northstar",
      title: "Rehearsal room hold at Studio Northstar",
      content: `Hello Alex,\n\n${QUOTE_HOLD}\n\nStudio Northstar`,
    }),
    claimType: "booking",
    claimText: "A rehearsal room at Studio Northstar is held for the first week of April.",
    quote: QUOTE_HOLD,
  },
  {
    doc: note({
      externalId: "verify-terms-cedar",
      title: "Cedar Grove Supplies payment terms",
      content: `Hello Alex,\n\n${QUOTE_TERMS}\n\nCedar Grove Supplies`,
    }),
    claimType: "payment-terms",
    claimText: "Cedar Grove Supplies invoices are payable within thirty days of issue.",
    quote: QUOTE_TERMS,
  },
  {
    doc: note({
      externalId: "verify-visit-riverside",
      title: "Riverside Estate site visit window",
      content: `Hello Alex,\n\n${QUOTE_VISIT}\n\nRiverside Estate`,
    }),
    claimType: "site-visit-window",
    claimText: "The Riverside Estate site visit window runs from the ninth to the twelfth.",
    quote: QUOTE_VISIT,
  },
  {
    doc: note({
      externalId: "verify-collect-stellar",
      title: "Stellar Sound equipment collection",
      content: `Hello Alex,\n\n${QUOTE_COLLECT}\n\nStellar Sound`,
    }),
    claimType: "collection-deadline",
    claimText: "Stellar Sound equipment must be collected before the loading bay closes at six.",
    quote: QUOTE_COLLECT,
  },
  {
    doc: note({
      externalId: "verify-provisional-hold",
      title: "Provisional hold on the small studio",
      content: `Hello Alex,\n\n${QUOTE_PROVISIONAL}\n\nStudio Northstar`,
    }),
    claimType: RETRACT_MARKER_CLAIM_TYPE,
    claimText: "The provisional hold on the small studio expires unless it is confirmed.",
    quote: QUOTE_PROVISIONAL,
  },
];

describe("Brain Bench — the re-verification lane", () => {
  let bench: BrainBench;
  /** The marker's value once the boot-time pass has anchored it. */
  let markerAtStart = 0;
  /** Every distinct `verify:` dedupe key the sweep minted, in mint order. */
  const seenVerificationKeys: string[] = [];
  /**
   * The seeded annotations as they were born. Held by value because a
   * verification run may RETRACT one — a hard delete — so the row a later
   * assertion needs may no longer exist to be read back.
   */
  let seeded: AnnotationProbeRow[] = [];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      // No `entailment:` — the verifier role is deliberately UNASSIGNED, so
      // the entailment gate returns `state: null` on every annotation write.
      // That is the livelock setup: nothing but the tool layer's own
      // mechanical quote re-check can advance a last-checked stamp.
      brain: {
        reverification: { enabled: true, intervalDays: 1, maxPerSweep: 1, batchSize: 2 },
        // Every other producer off: this bench asserts on the verification
        // queue, and a bootstrap/digest/sweep backlog would drown it.
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
        digest: { enabled: false },
        synthesis: { enabled: false },
        sweepsEnabled: false,
      },
      behaviors: {
        behaviors: [
          ...SEEDS.map((s) => ({
            flavour: "data.created" as const,
            docTitle: s.doc.title,
            plan: (ctx: RunContext): PuppetPlan => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: s.claimType,
                  claimText: s.claimText,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: s.quote,
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
              ],
              finalText: "Recorded one durable observation.",
            }),
          })),
          { flavour: "verification" as const, plan: verificationPlan },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  // ── local probes (no route exposes engine state or evidence sidecars) ────

  const engineState = (key: string): number =>
    Number(
      bench.sql
        .prepare<
          [string],
          { value: string }
        >("SELECT value FROM cognition_engine_state WHERE key = ?")
        .get(key)?.value ?? "0",
    );

  const annotations = (): AnnotationProbeRow[] =>
    bench.sql
      .prepare<
        [],
        AnnotationProbeRow
      >(`SELECT ${ANNOTATION_COLUMNS} FROM doc_annotations ORDER BY created_at ASC`)
      .all();

  const annotationById = (id: string): AnnotationProbeRow | undefined =>
    bench.sql
      .prepare<
        [string],
        AnnotationProbeRow
      >(`SELECT ${ANNOTATION_COLUMNS} FROM doc_annotations WHERE id = ?`)
      .get(id);

  const verificationRuns = (): RunProbeRow[] =>
    bench.sql
      .prepare<
        [],
        RunProbeRow
      >(`SELECT ${RUN_COLUMNS} FROM cognition_runs WHERE kind = 'verification' ORDER BY enqueued_at ASC, id ASC`)
      .all();

  const runById = (id: string): RunProbeRow | undefined =>
    bench.sql
      .prepare<[string], RunProbeRow>(`SELECT ${RUN_COLUMNS} FROM cognition_runs WHERE id = ?`)
      .get(id);

  const batchOf = (run: RunProbeRow): { annotationIds: string[]; store: string } =>
    JSON.parse(run.payload_json) as { annotationIds: string[]; store: string };

  /**
   * The cognition clock, in ms. `GET /admin/brain/clock` renders `now` as an
   * ISO-8601 string while the POST accepts either form, so the read is
   * normalized here rather than trusted to be numeric.
   */
  async function virtualNow(): Promise<number> {
    const r = await bench.harness.gatewayJson<{ virtual: boolean; now: string | number }>(
      "/admin/brain/clock",
    );
    expect(r.virtual).toBe(true);
    const ms = typeof r.now === "number" ? r.now : Date.parse(r.now);
    expect(Number.isFinite(ms)).toBe(true);
    return ms;
  }

  async function advanceVirtualClock(ms: number): Promise<number> {
    const next = (await virtualNow()) + ms;
    await bench.harness.gatewayJson("/admin/brain/clock", {
      method: "POST",
      body: JSON.stringify({ now: next }),
    });
    return next;
  }

  /**
   * Advance virtual time past the sweep's daily cadence and wait for the pass
   * to actually fire — the marker is written LAST in a pass, so its movement
   * is proof every enqueue of that pass has landed. Then drain.
   */
  async function runSweepPass(days = 1): Promise<void> {
    const before = engineState(REVERIFICATION_MARKER_KEY);
    await advanceVirtualClock(days * 86_400_000);
    await waitFor(
      () =>
        `the re-verification sweep to fire (marker still ${engineState(REVERIFICATION_MARKER_KEY)})`,
      () => {
        const now = engineState(REVERIFICATION_MARKER_KEY);
        return now > before ? now : null;
      },
      60_000,
    );
    await bench.drainUntilQuiet();
    for (const r of verificationRuns()) {
      if (r.dedupe_key !== null && !seenVerificationKeys.includes(r.dedupe_key)) {
        seenVerificationKeys.push(r.dedupe_key);
      }
    }
  }

  /** Seed a queue row directly — the crash-residue shape the drainer abandoned. */
  function seedExhaustedVerificationRun(opts: {
    runId: string;
    annotationId: string;
    now: number;
  }): void {
    const db = new Database(bench.harness.getDbPath(), { fileMustExist: true });
    db.pragma("busy_timeout = 10000");
    try {
      db.prepare(
        `INSERT INTO cognition_runs (
           id, kind, payload_json, dedupe_key, status, attempts, next_attempt_at, enqueued_at
         ) VALUES (?, 'verification', ?, ?, 'pending', 5, ?, ?)`,
      ).run(
        opts.runId,
        JSON.stringify({ annotationIds: [opts.annotationId], store: "doc" }),
        `verify:doc:${opts.annotationId}`,
        opts.now,
        opts.now,
      );
    } finally {
      db.close();
    }
  }

  // ── tests ────────────────────────────────────────────────────────────────

  test("five never-checked annotations land, and no verifier is assigned", async () => {
    // The boot-time pass has already anchored the marker (no annotations
    // existed then, so it enqueued nothing).
    markerAtStart = await waitFor(
      "the re-verification sweep's first pass to anchor its marker",
      () => {
        const v = engineState(REVERIFICATION_MARKER_KEY);
        return v > 0 ? v : null;
      },
      60_000,
    );
    expect(verificationRuns()).toHaveLength(0);

    await bench.pushAll(SEEDS.map((s) => s.doc));
    await waitFor(
      () =>
        `${SEEDS.length} data runs to be enqueued (saw ${bench.puppetCalls.length} model calls)`,
      async () => {
        const runs = await bench.obs.runs({ kind: "data", limit: 200 });
        return runs.items.length >= SEEDS.length ? runs.items.length : null;
      },
      90_000,
    );
    await bench.drainUntilQuiet();

    seeded = annotations();
    const rows = seeded;
    expect(rows.map((r) => r.claim_type).sort()).toEqual(SEEDS.map((s) => s.claimType).sort());
    // With the entailment role unassigned the gate stamps nothing, so every
    // annotation is born NEVER CHECKED — the whole due pool of the sweep.
    for (const r of rows) {
      expect(r.verification_state).toBeNull();
      expect(r.last_verified_at).toBeNull();
      expect(r.invalidated_at).toBeNull();
    }
  }, 180_000);

  test("the sweep enqueues a verification run keyed on its sorted batch", async () => {
    await runSweepPass(2);

    const runs = verificationRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;

    const batch = batchOf(run);
    expect(batch.store).toBe("doc");
    // maxPerSweep=1, batchSize=2 → exactly one run of two annotations.
    expect(batch.annotationIds).toHaveLength(2);
    const seededById = new Map(seeded.map((r) => [r.id, r]));
    for (const id of batch.annotationIds) expect(seededById.has(id)).toBe(true);

    // `verificationRunDedupeKey`: the store plus the SORTED id batch, so an
    // identically re-detected batch folds instead of duplicating.
    expect(run.dedupe_key).toBe(`verify:doc:${[...batch.annotationIds].sort().join(",")}`);

    expect(run.status).toBe("completed");

    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain("Re-verification pass over the doc annotation store.");
    for (const id of batch.annotationIds) {
      expect(prompt).toContain(id);
      // The prompt loads LIVE state at claim time, so it must carry the
      // claim itself — not just the id the payload named.
      expect(prompt).toContain(seededById.get(id)!.claim_text);
    }
    expect(prompt).toContain("never checked");

    // The puppet recognized the run from its envelope.
    const verificationCalls = bench.puppetCalls.filter((c) => c.kind === "verification");
    expect(verificationCalls.length).toBeGreaterThan(0);
    expect(verificationCalls[0]!.flavour).toBe("verification");
    expect(verificationCalls[0]!.subject).toBe("doc");
  }, 180_000);

  test("a re-affirming revise advances the last-checked stamp", async () => {
    const run = verificationRuns()[0]!;
    const reAffirmed = new Set(
      seeded.filter((s) => s.claim_type !== RETRACT_MARKER_CLAIM_TYPE).map((s) => s.id),
    );
    const affirmed = batchOf(run)
      .annotationIds.filter((id) => reAffirmed.has(id))
      .map((id) => annotationById(id))
      .filter((r): r is AnnotationProbeRow => r !== undefined);
    expect(affirmed.length).toBeGreaterThan(0);

    for (const row of affirmed) {
      // The contract the prompt states: "a successful revise always advances
      // the last-checked stamp". It was NULL before this pass.
      expect(row.last_verified_at).not.toBeNull();
      expect(row.last_verified_at!).toBeGreaterThan(markerAtStart);
      // …while the VERDICT stays unset, because no verifier judged it.
      expect(row.verification_state).toBeNull();
      // Confidence was re-supplied unchanged; the revise must not launder it.
      expect(row.confidence).toBeCloseTo(0.8, 5);
      expect(row.invalidated_at).toBeNull();
    }
  }, 60_000);

  test("a retract on broken evidence removes the annotation from the served set", async () => {
    const marked = seeded.find((r) => r.claim_type === RETRACT_MARKER_CLAIM_TYPE);
    expect(marked).toBeDefined();
    const markedId = marked!.id;
    const markedDocId = marked!.doc_id;

    // Drive sweep passes until the batching reaches it. `maxPerSweep=1,
    // batchSize=2` over five annotations needs three passes at minimum.
    for (let i = 0; i < 6 && annotationById(markedId) !== undefined; i++) {
      await runSweepPass();
    }

    // `annotation_retract` is a HARD delete by contract (the tool's own
    // description, and `listDeadPriorDependents`' "hard retracts leave no row
    // to join"): the derived claim text is removed outright, not tombstoned.
    expect(annotationById(markedId)).toBeUndefined();

    const served = await bench.obs.docAnnotations(markedDocId);
    expect(served.annotations.map((a) => a.id)).not.toContain(markedId);
    expect(served.annotations).toHaveLength(0);
  }, 300_000);

  test("livelock: capped passes over an equally-due pool keep making progress", async () => {
    // Every seed was created never-checked, so they are all equally due —
    // the shape where a cap that re-selects the same head would spin forever.
    for (let i = 0; i < 4; i++) {
      const unchecked = annotations().filter((r) => r.last_verified_at === null);
      if (unchecked.length === 0) break;
      await runSweepPass();
    }

    const rows = annotations();
    // One was retracted; every survivor has been re-grounded at least once.
    expect(rows).toHaveLength(SEEDS.length - 1);
    for (const r of rows) {
      expect(r.last_verified_at).not.toBeNull();
    }

    // Progress, not repetition: the sweep minted DISTINCT batches rather than
    // re-detecting one head batch every pass.
    expect(new Set(seenVerificationKeys).size).toBeGreaterThanOrEqual(3);
    const runs = verificationRuns();
    expect(runs.length).toBe(new Set(runs.map((r) => r.dedupe_key)).size);
    // Five annotations at two per pass cannot honestly need many more than
    // three runs; a much larger number is the re-enqueue spin this asserts on.
    expect(runs.length).toBeLessThanOrEqual(8);
    for (const r of runs) expect(r.status).toBe("completed");

    // Union coverage: every annotation the sweep ever selected, exactly once.
    const covered = new Set(runs.flatMap((r) => batchOf(r).annotationIds));
    expect(covered.size).toBe(SEEDS.length);
  }, 300_000);

  test("livelock: the lane's progress marker advances with no verifier configured", async () => {
    // The recurring failure shape: a lane whose progress stamp only moves
    // when an optional model role is assigned. This bench never assigned
    // `entailment-verifier`, so nothing here ever produced a verdict…
    for (const r of annotations()) expect(r.verification_state).toBeNull();

    // …yet BOTH progress stamps moved: the sweep's own marker,
    const marker = engineState(REVERIFICATION_MARKER_KEY);
    expect(marker).toBeGreaterThan(markerAtStart);

    // …and the per-annotation last-checked stamp, which is what actually
    // takes a row OUT of the due pool. If only a configured verifier could
    // advance it, every annotation would stay permanently due and the lane
    // would re-enqueue the same work every day forever.
    for (const r of annotations()) {
      expect(r.last_verified_at).not.toBeNull();
      // Born NULL at boot; only a verification run could have stamped it.
      expect(r.last_verified_at!).toBeGreaterThan(markerAtStart);
    }
  }, 60_000);

  test("livelock: attempts-exhausted residue does not shadow its annotation", async () => {
    // Nothing is due right now (the previous test's pass just re-grounded
    // everything), so the residue can be planted without racing a live pass.
    expect(
      verificationRuns().filter((r) => r.status === "pending"),
      "no verification run may be pending when the residue is planted",
    ).toHaveLength(0);

    const target = annotations()[0]!;
    const stampBefore = target.last_verified_at!;
    const now = await virtualNow();
    const residueId = "run_residue_verify_probe";
    seedExhaustedVerificationRun({ runId: residueId, annotationId: target.id, now });
    expect(runById(residueId)).toBeDefined();

    // A row at the drainer's attempts cap can never be claimed again. If the
    // sweep counted it as coverage, `target` would be shadowed from
    // re-verification forever.
    await runSweepPass(2);
    expect(
      runById(residueId),
      "the sweep must CANCEL attempts-exhausted residue, not leave it shadowing its annotation",
    ).toBeUndefined();

    for (let i = 0; i < 5; i++) {
      const row = annotationById(target.id);
      if (
        row !== undefined &&
        row.last_verified_at !== null &&
        row.last_verified_at > stampBefore
      ) {
        break;
      }
      await runSweepPass();
    }

    const after = annotationById(target.id);
    expect(after).toBeDefined();
    expect(after!.last_verified_at!).toBeGreaterThan(stampBefore);

    const carrying = verificationRuns().filter(
      (r) => r.id !== residueId && batchOf(r).annotationIds.includes(target.id),
    );
    expect(carrying.length).toBeGreaterThanOrEqual(2);
    expect(carrying.at(-1)!.status).toBe("completed");
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Bench B — consumption provenance and the evidence firewall (real clock)
// ═══════════════════════════════════════════════════════════════════════════

const ANCHOR_QUOTE = "The stage door access code stays unchanged until the end of the season.";
const PRIOR_QUOTE = "The rehearsal room at Studio Northstar is reserved for the first week of May.";
const BREAKER_QUOTE = "The pallet delivery window is the third week of May.";
const MULTI_QUOTE = "The site visit is scheduled for the second Tuesday of June.";

const ANCHOR_DOC = note({
  externalId: "prov-anchor-access",
  title: "Stage door access notice",
  content: `Hello Alex,\n\n${ANCHOR_QUOTE}\n\nStudio Northstar`,
});

const PRIOR_DOC = note({
  externalId: "prov-prior-booking",
  title: "Northstar rehearsal confirmation",
  content: `Hello Alex,\n\n${PRIOR_QUOTE}\n\nStudio Northstar`,
});

const DEPENDENT_DOC = note({
  externalId: "prov-dependent-question",
  title: "Northstar schedule question",
  content:
    "Hello Alex,\n\nWhat is already on the studio calendar for May? I want to plan around it.\n\nMaya Reeves",
});

const KILLER_DOC = note({
  externalId: "prov-killer-withdrawal",
  title: "Northstar booking withdrawn",
  content:
    "Hello Alex,\n\nThe reservation was entered against the wrong account and nothing is held for you.\n\nStudio Northstar",
});

const BREAKER_DOC = note({
  externalId: "prov-breaker-delivery",
  title: "Cedar Grove delivery window",
  content: `Hello Alex,\n\n${BREAKER_QUOTE}\n\nCedar Grove Supplies`,
});

const MULTI_DOC = note({
  externalId: "prov-multi-site-visit",
  title: "Riverside Estate site visit",
  content: `Hello Alex,\n\n${MULTI_QUOTE}\n\nRiverside Estate`,
});

const BRIEF_TITLE = "The studio calendar for May";
const REPAIR_TEXT = "Re-checked after a supporting prior was retracted.";

describe("Brain Bench — consumption provenance and the evidence firewall", () => {
  let bench: BrainBench;
  // Ids minted by the gateway, captured as the arc advances. The behavior
  // table closes over them because a run's plan may need a document the
  // TRIGGERING document does not name.
  let anchorDocId = "";
  let priorDocId = "";
  let priorAnnotationId = "";
  let briefId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        provenanceRecheck: { enabled: true },
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
        digest: { enabled: false },
        synthesis: { enabled: false },
        sweepsEnabled: false,
      },
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: PRIOR_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "booking",
                  claimText:
                    "A rehearsal room at Studio Northstar is reserved for the first week of May.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: PRIOR_QUOTE,
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
              ],
              finalText: "Recorded the booking as a durable prior.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: DEPENDENT_DOC.title,
            plan: () => ({
              calls: [
                // The read that makes the prior eligible to be declared.
                call("annotation_search", { docId: priorDocId }),
                call("brief_create", {
                  kind: "info",
                  title: BRIEF_TITLE,
                  description: "One rehearsal booking already sits on the studio calendar.",
                  citations: [priorDocId],
                  confidence: 0.7,
                  urgency: 0.3,
                  annotationDependencies: [
                    { store: "doc", annotationId: ref("annotation_search", "annotations.0.id") },
                  ],
                }),
              ],
              finalText: "Raised one card resting on the recorded booking.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: KILLER_DOC.title,
            plan: () => ({
              calls: [
                call("annotation_search", { docId: priorDocId }),
                call("annotation_retract", {
                  id: ref("annotation_search", "annotations.0.id"),
                }),
              ],
              finalText: "The booking never existed; retracted the prior.",
            }),
          },
          {
            flavour: "feedback.provenance",
            plan: (ctx) => ({
              calls: [
                call("brief_fetch", { id: ctx.subject }),
                call("brief_update", {
                  id: ctx.subject,
                  description: REPAIR_TEXT,
                  annotationDependencies: [],
                }),
              ],
              finalText: "Repaired the card that rested on the dead prior.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: BREAKER_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "delivery-window",
                  claimText: "The Cedar Grove pallet delivery window is the third week of May.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: BREAKER_QUOTE,
                  confidence: 0.8,
                  claimBasis: "quoted",
                }),
              ],
              finalText: "Recorded the delivery window.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: MULTI_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "site-visit",
                  claimText:
                    "A Riverside Estate site visit is scheduled while the season access arrangements still stand.",
                  evidenceDocId: ctx.subject,
                  evidenceQuote: MULTI_QUOTE,
                  additionalEvidence: [{ docId: anchorDocId, quote: ANCHOR_QUOTE }],
                  confidence: 0.5,
                  claimBasis: "synthesized",
                }),
              ],
              finalText: "Recorded the site visit against two grounding atoms.",
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  const annotationById = (id: string): AnnotationProbeRow | undefined =>
    bench.sql
      .prepare<
        [string],
        AnnotationProbeRow
      >(`SELECT ${ANNOTATION_COLUMNS} FROM doc_annotations WHERE id = ?`)
      .get(id);

  const evidenceOf = (annotationId: string): EvidenceProbeRow[] =>
    bench.sql
      .prepare<[string], EvidenceProbeRow>(
        `SELECT position, evidence_doc_id, evidence_quote, broken_at
           FROM doc_annotation_evidence WHERE annotation_id = ? ORDER BY position ASC`,
      )
      .all(annotationId);

  const runByDedupeKey = (key: string): RunProbeRow | undefined =>
    bench.sql
      .prepare<
        [string],
        RunProbeRow
      >(`SELECT ${RUN_COLUMNS} FROM cognition_runs WHERE dedupe_key = ? ORDER BY enqueued_at DESC LIMIT 1`)
      .get(key);

  /** Push documents, wait for their data runs to be enqueued, then drain. */
  async function pushAndDrain(docs: readonly BenchDoc[]): Promise<string[]> {
    const before = (await bench.obs.runs({ kind: "data", limit: 200 })).items.length;
    await bench.pushAll(docs);
    await waitFor(
      () => `${docs.length} more data run(s) to be enqueued (had ${before})`,
      async () => {
        const runs = await bench.obs.runs({ kind: "data", limit: 200 });
        return runs.items.length >= before + docs.length ? runs.items.length : null;
      },
      90_000,
    );
    await bench.drainUntilQuiet();
    const ids: string[] = [];
    for (const d of docs) ids.push(await bench.docId(d.externalId));
    return ids;
  }

  /**
   * A content change invalidates annotations off the event bus, deliberately
   * NOT awaited by ingest. Wait on the sidecar instead, then let the debounced
   * `data.updated` run settle so the queue is clean for the next test.
   */
  async function breakEvidence(doc: BenchDoc, replacement: string, annotationId: string) {
    await bench.update(doc, replacement);
    const broken = await waitFor(
      () => `evidence of ${annotationId} to be re-judged against the changed document`,
      () => {
        const rows = evidenceOf(annotationId);
        return rows.some((r) => r.broken_at !== null) ? rows : null;
      },
      60_000,
    );
    // The update debounce is 2s; give the waker its window before draining so
    // the follow-on run does not surface inside the next test.
    await sleep(3_000);
    await bench.drainUntilQuiet();
    return broken;
  }

  test("a declared dependency records a consumption edge", async () => {
    [anchorDocId] = (await pushAndDrain([ANCHOR_DOC])) as [string];
    [priorDocId] = (await pushAndDrain([PRIOR_DOC])) as [string];

    const priors = await bench.obs.docAnnotations(priorDocId);
    expect(priors.annotations).toHaveLength(1);
    priorAnnotationId = priors.annotations[0]!.id;

    await pushAndDrain([DEPENDENT_DOC]);
    const briefs = (await bench.obs.briefs()).items.filter((b) => b.title === BRIEF_TITLE);
    expect(briefs).toHaveLength(1);
    briefId = briefs[0]!.id;

    const edges = bench.sql
      .prepare<
        [string],
        { prior_store: string; prior_annotation_id: string; dependent_kind: string }
      >(
        `SELECT prior_store, prior_annotation_id, dependent_kind
           FROM cognition_consumption_edges WHERE dependent_id = ?`,
      )
      .all(briefId);
    expect(edges).toEqual([
      { prior_store: "doc", prior_annotation_id: priorAnnotationId, dependent_kind: "brief" },
    ]);

    // The same edge, through the production read surface.
    const dependents = await bench.obs.dependents("doc", priorAnnotationId);
    expect(dependents.items.map((d) => ({ kind: d.kind, id: d.id }))).toEqual([
      { kind: "brief", id: briefId },
    ]);
  }, 180_000);

  test("killing the prior enqueues a provenance recheck that repairs the dependent", async () => {
    await pushAndDrain([KILLER_DOC]);

    // A retract is a hard delete; the edge deliberately survives it as the
    // claim-time signal that the prior was hard-retracted.
    expect(annotationById(priorAnnotationId)).toBeUndefined();

    const key = `feedback:provenance:brief:${briefId}`;
    const recheck = await waitFor(
      () => `a provenance recheck run keyed ${key}`,
      () => runByDedupeKey(key) ?? null,
      60_000,
    );
    await bench.drainUntilQuiet();
    const settled = runByDedupeKey(key)!;
    expect(settled.kind).toBe("feedback");
    expect(settled.status).toBe("completed");

    const prompt = await bench.obs.promptFor(recheck.id);
    expect(prompt).toContain(`Provenance re-check for brief ${briefId}`);
    expect(prompt).toContain(priorAnnotationId);
    // A hard-retracted prior has no claim text left to render.
    expect(prompt).toContain("(hard-retracted)");

    const repaired = await bench.obs.brief(briefId);
    expect(repaired.brief.description).toBe(REPAIR_TEXT);

    const calls = bench.puppetCalls.filter((c) => c.flavour === "feedback.provenance");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.subject).toBe(briefId);
  }, 180_000);

  test("a changed document breaks the evidence and invalidates the annotation", async () => {
    const [breakerDocId] = (await pushAndDrain([BREAKER_DOC])) as [string];
    const before = await bench.obs.docAnnotations(breakerDocId);
    expect(before.annotations).toHaveLength(1);
    const annotationId = before.annotations[0]!.id;
    expect(evidenceOf(annotationId)).toHaveLength(1);

    const broken = await breakEvidence(
      BREAKER_DOC,
      "Hello Alex,\n\nThe pallet is now with a different carrier and no window has been agreed.\n\nCedar Grove Supplies",
      annotationId,
    );

    // Per-atom teeth: the one grounding atom is stamped broken…
    expect(broken).toHaveLength(1);
    expect(broken[0]!.broken_at).not.toBeNull();

    // …and with no live atom left the annotation soft-invalidates, kept for
    // audit rather than deleted.
    const row = annotationById(annotationId);
    expect(row).toBeDefined();
    expect(row!.invalidated_at).not.toBeNull();
    expect(row!.claim_text).toContain("pallet delivery window");

    const served = await bench.obs.docAnnotations(breakerDocId);
    expect(served.annotations).toHaveLength(0);
  }, 180_000);

  test("a multi-evidence annotation survives a break by promoting the next atom", async () => {
    const [multiDocId] = (await pushAndDrain([MULTI_DOC])) as [string];
    const before = await bench.obs.docAnnotations(multiDocId);
    expect(before.annotations).toHaveLength(1);
    const annotationId = before.annotations[0]!.id;

    const atoms = evidenceOf(annotationId);
    expect(atoms.map((a) => a.evidence_doc_id)).toEqual([multiDocId, anchorDocId]);
    expect(annotationById(annotationId)!.evidence_doc_id).toBe(multiDocId);

    const after = await breakEvidence(
      MULTI_DOC,
      "Hello Alex,\n\nThe visit has moved and the estate will send a new date in writing.\n\nRiverside Estate",
      annotationId,
    );

    expect(after[0]!.broken_at).not.toBeNull();
    expect(after[1]!.broken_at).toBeNull();

    const row = annotationById(annotationId)!;
    // The annotation survives on its remaining atom…
    expect(row.invalidated_at).toBeNull();
    // …and evidence[0]'s break promoted the next atom into the scalar mirror,
    // so the mirror always names a live, servable grounding.
    expect(row.evidence_doc_id).toBe(anchorDocId);
    expect(row.evidence_quote).toBe(ANCHOR_QUOTE);
    // Every touched survivor goes back to the FRONT of the re-verification
    // backlog: the verdict is dropped and the stamp cleared.
    expect(row.verification_state).toBe("unverified");
    expect(row.last_verified_at).toBeNull();

    const served = await bench.obs.docAnnotations(multiDocId);
    expect(served.annotations.map((a) => a.id)).toEqual([annotationId]);
    expect(served.annotations[0]!.evidenceDocId).toBe(anchorDocId);
  }, 180_000);
});
