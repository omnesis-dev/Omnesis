// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record check on real source interpretation batches, on the brain bench.
 *
 * Before a background run saves a new annotation, the gateway asks the
 * `decision` model whether the record belongs in life memory. The model is a
 * scripted stand-in for TypeSafe's decision API, reached through the production client,
 * so the assignment, the per-run binding, the tool integration, the ledger,
 * the spend record and the run detail all run for real; only the score is
 * scripted, by record sentence. Maintenance decisions admit each source, so
 * every source interpretation reaches its agent turn.
 *
 * Covered, on one gateway whose mode is switched through the live config:
 *  - enforce: a low-scored timeline entry and doc-fact record are not saved
 *    and the agent is told not to retry; a high-scored one is saved;
 *  - shadow: the same low-scored record is saved at once and its verdict
 *    recorded afterwards as not enforced;
 *  - off: nothing is asked;
 *  - a refusing model fails open: the record is saved and the verdict is
 *    unavailable;
 *  - the run detail serves every record-check decision with its record id,
 *    and the tokens land under the record-check mechanism without counting a
 *    run; the runs list keeps maintenance admission separate from record checks.
 *
 * Correctness only: whether a score is a GOOD judgement of a record is the
 * rubric's evaluation, not this suite's. The suite is order-dependent: each
 * test switches the mode and pushes its own email.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  waitFor,
  type BenchDoc,
  type DecisionPolicyReply,
  type DecisionServerRequest,
  sourceInterpretations,
  preserveCurrentOwner,
  type SourceInterpretation,
} from "./brain-bench/index.js";

compressCognitionCadences();

const QUOTE = "the new cycle studio opens on the third of October 2027";
const NOISE = "Studio Northstar says its new cycle studio opens on 3 October 2027.";
const KEEP = "The owner booked the first cycle class for 3 October 2027.";
const NOISE_FACT = "The message announces the Studio Northstar cycle studio opening.";
const OUTAGE = "Studio Northstar lists its new opening hours from 3 October 2027.";

/** Scores by record sentence; the worth gate's email questions all pass. */
function policy(request: DecisionServerRequest): DecisionPolicyReply {
  const maintenancePurpose = ["urgency", "impact", "discovery", "review"].find(
    (key) => key in request.questions,
  );
  if (maintenancePurpose) return { [maintenancePurpose]: { type: "score", score: 2 } };
  const state = request.state as { subject?: string; record?: string };
  if (typeof state.subject === "string") {
    return { worth_score: { type: "score" as const, score: 3 } };
  }
  if (state.record === OUTAGE) return { httpError: 400, message: "invalid request" };
  const score = state.record === NOISE || state.record === NOISE_FACT ? 0.1 : 2.6;
  return { belongs: { type: "score" as const, score } };
}

function memberMail(n: number): BenchDoc {
  return email({
    externalId: `rc-members-${n}`,
    title: `Members update ${n}`,
    content: `Hi,\n\nA quick members update: ${QUOTE}. Classes can be booked from today.\n\nStudio Northstar`,
  });
}

/** What each source interpretation writes, all grounded on the same quote. */
function writes(title: string, records: readonly string[], docFact = false): SourceInterpretation {
  return {
    docTitle: title,
    plan: (ctx) => ({
      calls: [
        call("temporal_query", { from: "2027-10-03", to: "2027-10-04" }),
        ...records.map((sentence, i) =>
          call("temporal_annotation_add", {
            // Distinct days so the reconcile refusal never fires between them.
            when: `2027-10-0${3 + i}`,
            sentence,
            kind: "event",
            force: true,
            evidence: { docId: ctx.subject, quote: QUOTE },
          }),
        ),
        ...(docFact
          ? [
              call("annotation_search", { docId: ctx.subject }),
              call("annotate_durable", {
                docId: ctx.subject,
                claimType: "topic",
                claimText: NOISE_FACT,
                evidenceDocId: ctx.subject,
                evidenceQuote: QUOTE,
                confidence: 0.6,
                claimBasis: "quoted",
              }),
            ]
          : []),
      ],
    }),
  };
}

const MAIL = [1, 2, 3, 4].map(memberMail);

describe("record check: a scripted decision model on source interpretation", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
        mergeAdjudication: { enabled: false },
        annotations: { recordCheck: "enforce" },
      },
      decision: { policy, inputTokens: 90 },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            writes(MAIL[0]!.title, [NOISE, KEEP], true),
            writes(MAIL[1]!.title, [NOISE]),
            writes(MAIL[2]!.title, [NOISE]),
            writes(MAIL[3]!.title, [OUTAGE]),
          ],
        }),
      },
    });
    await bench.drainUntilQuiet();
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  const sentences = (): string[] =>
    bench.sql
      .prepare<[], { sentence: string }>(
        "SELECT sentence FROM temporal_annotations ORDER BY sentence",
      )
      .all()
      .map((r) => r.sentence);

  /** The run's write calls, without the document read the puppet opens every data run with. */
  const writeSteps = async (runId: string) =>
    (await bench.obs.executedTools(runId)).filter((step) =>
      ["temporal_annotation_add", "annotate_durable"].includes(step.tool),
    );

  const recordChecks = (runId: string) =>
    bench.obs.run(runId).then((d) => d.decisions.filter((x) => x.purpose === "record-check"));

  test("enforce: a low-scored record is not saved and the agent is told not to retry", async () => {
    const [docId] = await bench.pushAndSettle([MAIL[0]!]);
    const run = await bench.obs.interpretationForSource(docId!);
    const steps = await writeSteps(run.id);
    const results = steps.map((s) => [s.tool, s.result?.resultType]);
    expect(results).toEqual([
      ["temporal_annotation_add", "record.not_saved"],
      ["temporal_annotation_add", "temporal_annotation.added"],
      ["annotate_durable", "record.not_saved"],
    ]);
    expect(String(steps[0]!.result?.data?.guidance)).toContain("Do not retry");
    expect(sentences()).toEqual([KEEP]);
    expect((await bench.obs.docAnnotations(docId!)).annotations).toEqual([]);

    const decisions = await recordChecks(run.id);
    expect(decisions.map((d) => [d.verdict, d.enforced, d.score])).toEqual([
      ["skip", true, 0.1],
      ["pass", true, 2.6],
      ["skip", true, 0.1],
    ]);
    const kept = steps[1]!.result?.data?.id;
    expect(decisions[1]!.recordId).toBe(kept);
    expect(decisions[0]!.request?.state).toEqual({
      record_type: "timeline",
      record_kind: "event",
      record: NOISE,
    });
    expect(decisions[2]!.request?.state).toMatchObject({
      record_type: "doc-fact",
      record: NOISE_FACT,
      document_context: { redacted: true, replayable: false, other_source_count: 0 },
    });
    const docCheck = bench.decision.calls.find(
      (c) => (c.request.state as { record?: string }).record === NOISE_FACT,
    )!;
    expect(docCheck.request.state).toMatchObject({
      document_context: {
        subject_text: expect.stringContaining(QUOTE),
        subject_truncated: false,
        evidence: [{ source: 0, is_subject: true, quote: QUOTE }],
      },
    });
    expect(JSON.stringify(decisions[2]!.request)).not.toContain(QUOTE);
    for (const d of decisions) {
      expect(d).toMatchObject({
        lane: "synthesis",
        documentId: docId,
        rubricVersion: "record-value-v3",
      });
    }
    // Discovery decisions belong to the knowledge ledger, independently of record checks.
    expect(run.gateVerdict).toBeNull();
  });

  test("shadow: the same record is saved and its verdict recorded as not enforced", async () => {
    await bench.patchConfig({ brain: { annotations: { recordCheck: "shadow" } } });
    const [docId] = await bench.pushAndSettle([MAIL[1]!]);
    const run = await bench.obs.interpretationForSource(docId!);
    const [step] = await writeSteps(run.id);
    expect(step!.result?.resultType).toBe("temporal_annotation.added");
    expect(sentences()).toEqual([NOISE, KEEP].sort());
    // Shadow judges after the write, so the verdict lands shortly after the run.
    const { value: decisions } = await waitFor(
      () => `a record-check decision for ${run.id}`,
      async () => {
        const found = await recordChecks(run.id);
        return found.length > 0 ? { value: found } : null;
      },
      30_000,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      verdict: "skip",
      enforced: false,
      recordId: step!.result?.data?.id,
    });
  });

  test("off: nothing is asked about the run's records", async () => {
    await bench.patchConfig({ brain: { annotations: { recordCheck: "off" } } });
    const before = bench.decision.calls.filter(
      (c) => "record" in (c.request.state as object),
    ).length;
    const [docId] = await bench.pushAndSettle([MAIL[2]!]);
    const run = await bench.obs.interpretationForSource(docId!);
    expect(await recordChecks(run.id)).toEqual([]);
    expect(
      bench.decision.calls.filter((c) => "record" in (c.request.state as object)),
    ).toHaveLength(before);
    expect(sentences().filter((s) => s === NOISE)).toHaveLength(2);
  });

  test("an outage fails open under enforce: the record is saved and the verdict is unavailable", async () => {
    await bench.patchConfig({ brain: { annotations: { recordCheck: "enforce" } } });
    const [docId] = await bench.pushAndSettle([MAIL[3]!]);
    const run = await bench.obs.interpretationForSource(docId!);
    const [step] = await writeSteps(run.id);
    expect(step!.result?.resultType).toBe("temporal_annotation.added");
    expect(sentences()).toContain(OUTAGE);
    const [decision] = await recordChecks(run.id);
    expect(decision).toMatchObject({ verdict: "unavailable", score: null, enforced: true });
    expect(decision!.error).toMatch(/400/);
  });

  test("the check's tokens are recorded as record-check spend, never as runs", async () => {
    const { rows } = await bench.obs.mechanismSpend();
    const spend = rows.filter((r) => r.mechanism === "record-check");
    const answered = bench.decision.calls.filter(
      (c) => c.status === 200 && "record" in (c.request.state as object),
    ).length;
    // Enforce (3) + shadow (1).
    expect(answered).toBe(4);
    expect(spend.reduce((sum, r) => sum + r.promptTokens, 0)).toBe(90 * answered);
    expect(spend.reduce((sum, r) => sum + r.runs, 0)).toBe(0);
  });
});
