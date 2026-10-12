// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createPersonAnnotation } from "@omnesis/gateway/src/brain/storage/person-annotations.js";
import { convertKnowledgeOwner } from "@omnesis/gateway/src/brain/knowledge/owner-adapters.js";
import { enqueueKnowledgeWork } from "@omnesis/gateway/src/brain/knowledge/work.js";
import { afterEach, expect, it } from "vitest";
import {
  BrainBench,
  waitFor,
  call,
  compressCognitionCadences,
  email,
  ref,
  sourceInterpretations,
  preserveCurrentOwner,
  type DecisionServerRequest,
} from "./brain-bench/index.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);

const preference = "Maya Reeves prefers written agendas for meetings.";
const extra = "Maya Reeves prefers morning calls.";
const firstDoc = email({
  externalId: "profile-agenda-first",
  title: "Observatory agenda preference",
  content: preference,
});
const secondDoc = email({
  externalId: "profile-agenda-second",
  title: "Observatory agenda confirmation",
  content: preference,
});
const thirdDoc = email({
  externalId: "profile-compact",
  title: "Observatory profile review",
  content: extra,
});

it("requires a complete profile read, blocks growth before verification and atomically consolidates supported observations", async () => {
  const judged: DecisionServerRequest["state"][] = [];
  const declinedRevision = "Maya prefers written agendas.";
  let firstSource = "",
    secondSource = "",
    firstId = "",
    secondId = "";
  const person = ref("lookup_people", "results.0.canonicalId");
  const lookup = () => call("lookup_people", { query: "Maya Reeves" });
  const annotation = (source: string, claimType: string, claimText: string, quote: string) => ({
    personId: person,
    claimType,
    claimText,
    evidenceDocId: source,
    evidenceQuote: quote,
    confidence: 0.8,
    claimBasis: "quoted",
  });
  bench = await BrainBench.start({
    experimental: true,
    brain: {
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
      annotations: {
        enabled: true,
        recordCheck: "enforce",
        personProfile: { maxFacts: 2, maxCharacters: 1000 },
      },
    },
    entailment: () => "entailment",
    decision: {
      policy: (request) => {
        const purpose = ["urgency", "impact", "discovery", "review"].find(
          (key) => key in request.questions,
        );
        if (purpose) return { [purpose]: { type: "score", score: 2 } };
        judged.push(request.state);
        const state = request.state as { record?: string };
        return Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            {
              type: "score" as const,
              score: id === "profile_distillation" && state.record === declinedRevision ? 0 : 3,
            },
          ]),
        );
      },
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: firstDoc.title,
            plan: (ctx) => ({
              calls: [
                lookup(),
                call("annotation_search", { personId: person }),
                call(
                  "annotate_person",
                  annotation(ctx.subject!, "agenda-observation-a", preference, preference),
                ),
              ],
            }),
          },
          {
            docTitle: secondDoc.title,
            plan: (ctx) => ({
              calls: [
                lookup(),
                call("annotation_search", { personId: person }),
                call(
                  "annotate_person",
                  annotation(ctx.subject!, "agenda-observation-b", preference, preference),
                ),
              ],
            }),
          },
          {
            docTitle: thirdDoc.title,
            expectedRefusals: [
              { tool: "annotate_person", code: "revision_conflict" },
              { tool: "annotate_person", code: "profile_budget_exceeded" },
            ],
            plan: (ctx) => ({
              calls: [
                lookup(),
                call("fetch_many", {
                  documents: [{ documentId: firstSource }, { documentId: secondSource }],
                }),
                call("annotation_search", { personId: person, limit: 1 }),
                call("annotate_person", {
                  ...annotation(firstSource, "meeting-preference", preference, preference),
                  supersedes: [firstId, secondId],
                }),
                call("annotation_search", {
                  personId: person,
                  limit: 1,
                  cursor: ref("annotation_search", "nextCursor"),
                }),
                call("annotate_person", annotation(ctx.subject!, "call-preference", extra, extra)),
                call("person_annotation_revise", {
                  id: firstId,
                  claimText: declinedRevision,
                  reconciliationReason: "Proposed wording reduction for review.",
                }),
                call("annotate_person", {
                  ...annotation(firstSource, "meeting-preference", preference, preference),
                  additionalEvidence: [{ docId: secondSource, quote: preference }],
                  supersedes: [firstId, secondId],
                  reconciliationReason:
                    "Both observations independently record the same preference; retain both source supports in one fact.",
                }),
                call("annotation_search", { personId: person }),
                call("annotate_person", {
                  ...annotation(firstSource, "meeting-preference", preference, preference),
                  additionalEvidence: [{ docId: secondSource, quote: preference }],
                  supersedes: ref("annotate_person", "id", 2),
                }),
              ],
            }),
          },
        ],
      }),
    },
  });
  const personId = bench.withWriteHandle(
    (db) =>
      db
        .prepare<
          [],
          { id: string }
        >("SELECT id FROM people WHERE canonical_name='Maya Reeves' AND merged_into IS NULL")
        .get()!.id,
  );
  firstSource = (await bench.pushAndSettle([firstDoc]))[0]!;
  const initialRun = await bench.obs.interpretationForSource(firstSource);
  const initialTools = await bench.obs.executedTools(initialRun.id);
  const initialProfile = (await bench.obs.personAnnotations(personId)).annotations;
  expect(initialProfile, JSON.stringify({ personId, tools: initialTools })).toHaveLength(1);
  firstId = initialProfile[0]!.id;
  secondSource = (await bench.pushAndSettle([secondDoc]))[0]!;
  secondId = (await bench.obs.personAnnotations(personId)).annotations.find(
    (a) => a.id !== firstId,
  )!.id;
  const [thirdSource] = await bench.pushAndSettle([thirdDoc]);
  const run = await bench.obs.interpretationForSource(thirdSource!);
  expect(run.status).toBe("completed");
  const calls = await bench.obs.executedTools(run.id);
  expect(
    calls.filter((c) => c.tool === "annotation_search").map((c) => c.result?.data?.profile),
  ).toMatchObject([
    { totalFacts: 2, readComplete: false },
    { totalFacts: 2, readComplete: true },
    { totalFacts: 1, readComplete: true },
  ]);
  const creates = calls.filter((c) => c.tool === "annotate_person");
  expect(creates.map((c) => c.result?.code ?? c.result?.resultType)).toEqual([
    "revision_conflict",
    "profile_budget_exceeded",
    "person_annotation.created",
    "person_annotation.unchanged",
  ]);
  expect(bench.entailmentCalls.filter((c) => c.claim === extra)).toHaveLength(0);
  const active = (await bench.obs.personAnnotations(personId)).annotations;
  expect(active).toHaveLength(1);
  expect(active[0]!.claimText).toBe(preference);
  expect(calls.find((c) => c.tool === "person_annotation_revise")?.result?.resultType).toBe(
    "record.not_saved",
  );
  expect(creates[3]!.result?.data?.id).toBe(active[0]!.id);
  const admissions = judged.filter(
    (state) =>
      !(
        state as { person_context?: { reconciliation?: { reason?: string } } }
      ).person_context?.reconciliation?.reason?.startsWith("Explicit scheduled review:"),
  );
  expect(admissions).toHaveLength(4); // two creates, refused revision, accepted consolidation; no-op asks nothing
  expect(admissions.at(-1)).toMatchObject({
    person_context: {
      reconciliation: {
        operation: "replace",
        predecessors: expect.arrayContaining([
          { id: firstId, kind: "agenda-observation-a", text: preference },
          { id: secondId, kind: "agenda-observation-b", text: preference },
        ]),
        retained_profile: [],
      },
    },
  });
  expect(
    bench.withWriteHandle((db) =>
      db.prepare("SELECT COUNT(*) AS n FROM person_annotations WHERE person_id=?").get(personId),
    ),
  ).toEqual({ n: 3 });
  expect(creates[2]!.result?.data?.supersededIds).toEqual([firstId, secondId]);
  const retired = bench.withWriteHandle((db) =>
    db
      .prepare<
        [string, string],
        { invalidated_at: number; superseded_by: string }
      >("SELECT invalidated_at,superseded_by FROM person_annotations WHERE id IN (?,?)")
      .all(firstId, secondId),
  );
  expect(retired).toHaveLength(2);
  for (const row of retired)
    expect(row).toMatchObject({ invalidated_at: expect.any(Number), superseded_by: active[0]!.id });
  expect(
    bench.withWriteHandle(
      (db) =>
        db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM person_annotation_evidence WHERE annotation_id=? AND broken_at IS NULL")
          .get(active[0]!.id)?.n,
    ),
  ).toBe(2);
}, 120_000);

it.each(["irrelevant", "mixed"] as const)(
  "reviews %s person context without deleting useful meaning before replacement",
  async (scenario) => {
    let personId = "";
    const factId = "editorial-review-fact";
    const fact =
      scenario === "irrelevant"
        ? "Maya Reeves selected the blue marker during the workshop."
        : "Workshop notices on Monday and Thursday identify Maya Reeves as the workshop accessibility coordinator.";
    const replacement = "Maya Reeves is the workshop accessibility coordinator.";
    let evidenceId = "";
    const judgments: DecisionServerRequest["state"][] = [];
    const statesAtRefusal: string[] = [];
    const editorialQuestions: DecisionServerRequest["questions"][] = [];
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
        annotations: { enabled: true, recordCheck: "enforce" },
      },
      entailment: () => "entailment",
      decision: {
        policy: (request) => {
          const purpose = ["urgency", "impact", "discovery", "review"].find(
            (key) => key in request.questions,
          );
          if (purpose) return { [purpose]: { type: "score", score: 2 } };
          judgments.push(request.state);
          editorialQuestions.push(request.questions);
          return Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              {
                type: "score" as const,
                score:
                  id === "withdrawal_preservation"
                    ? scenario === "mixed"
                      ? 0
                      : 3
                    : id === "profile_distillation" &&
                        (request.state as { record?: string }).record === fact
                      ? 0
                      : 3,
              },
            ]),
          );
        },
      },
      behaviors: {
        dynamic: (
          (
            policy: ReturnType<typeof sourceInterpretations>,
          ): ReturnType<typeof sourceInterpretations> =>
          (ctx, steps) => {
            const last = steps.at(-1);
            const result = last?.result as {
              kind?: string;
              code?: string;
              message?: string;
            } | null;
            const savedNode = last?.args?.node as { id?: string } | undefined;
            if (
              last?.name === "knowledge_save" &&
              savedNode?.id === factId &&
              result?.kind === "error" &&
              result.code === "claim_invalid" &&
              result.message?.includes("Person review refused retention")
            ) {
              const pending = bench!.sql
                .prepare<
                  [string, string, string],
                  { status: string }
                >("SELECT f.status FROM knowledge_frontier f JOIN knowledge_batches b ON b.id=f.batch_id WHERE f.node_id=? AND f.input_fingerprint=? AND b.run_id=?")
                .get(factId, String(last.args?.inputFingerprint), ctx.runId);
              statesAtRefusal.push(pending?.status ?? "missing");
              return { kind: "tool", name: "person_annotation_retract", args: { id: factId } };
            }
            if (
              last?.name === "person_annotation_retract" &&
              result?.code === "person_withdrawal_refused"
            ) {
              expect(
                bench!.sql
                  .prepare("SELECT claim_text FROM person_annotations WHERE id=?")
                  .get(factId),
              ).toMatchObject({ claim_text: fact });
              return {
                kind: "tool",
                name: "annotate_person",
                args: {
                  personId,
                  claimType: "coordination-role",
                  claimText: replacement,
                  evidenceDocId: evidenceId,
                  evidenceQuote: fact,
                  confidence: 0.8,
                  claimBasis: "synthesized",
                  supersedes: [factId],
                  reconciliationReason:
                    "Retain the supported role while dropping repeated observations.",
                },
              };
            }
            if (last?.name === "annotate_person" && result?.kind === "structured")
              return { kind: "tool", name: "knowledge_next_frontier", args: {} };
            if (
              last?.name === "person_annotation_retract" &&
              last.args?.id === factId &&
              result?.kind === "structured"
            )
              return { kind: "tool", name: "knowledge_next_frontier", args: {} };
            return policy(ctx, steps);
          }
        )(sourceInterpretations({ sources: [], maintainNode: preserveCurrentOwner })),
      },
    });
    personId = bench.withWriteHandle(
      (db) =>
        db
          .prepare<
            [],
            { id: string }
          >("SELECT id FROM people WHERE canonical_name='Maya Reeves' AND merged_into IS NULL")
          .get()!.id,
    );
    const [sourceId] = await bench.pushAndSettle([
      email({
        externalId: "marker-observation",
        title: "Workshop materials observation",
        content: fact,
      }),
    ]);
    evidenceId = sourceId!;
    const now = Date.now();
    bench.withWriteHandle((db) =>
      db
        .transaction(() => {
          createPersonAnnotation(
            db,
            {
              id: factId,
              personId,
              claimType: "workshop-marker",
              claimText: fact,
              evidenceDocId: sourceId!,
              evidenceQuote: fact,
              confidence: 0.8,
              claimBasis: "quoted",
              createdByRun: "legacy-seed",
            },
            now,
          );
          const converted = convertKnowledgeOwner(db, "person_annotation", factId, now);
          enqueueKnowledgeWork(
            db,
            {
              id: "person-editorial-review",
              subjectId: factId,
              subjectKind: "node",
              reason: "review",
              inputRevision: String(converted.node.revision),
              tier: "immediate",
              dueAt: now,
            },
            now,
          );
        })
        .immediate(),
    );
    await waitFor(
      () =>
        `person review to complete after retraction: ${JSON.stringify(bench!.sql.prepare("SELECT status,batch_id FROM knowledge_work WHERE id='person-editorial-review'").get())}; frontier ${JSON.stringify(bench!.sql.prepare("SELECT status FROM knowledge_frontier WHERE node_id=?").all(factId))}`,
      () =>
        (
          bench!.sql
            .prepare("SELECT status FROM knowledge_work WHERE id='person-editorial-review'")
            .get() as { status: string } | undefined
        )?.status === "completed"
          ? true
          : null,
      60_000,
    );
    await bench.drainUntilQuiet();
    const run = bench.sql
      .prepare<
        [],
        { run_id: string }
      >("SELECT b.run_id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE w.id='person-editorial-review'")
      .get()!;
    const tools = await bench.obs.executedTools(run.run_id);
    const save = tools.find((step) => step.tool === "knowledge_save");
    expect(save?.result).toMatchObject({
      kind: "error",
      code: "claim_invalid",
      message: expect.stringContaining("Person review refused retention (profile_distillation"),
    });
    expect(tools.find((step) => step.tool === "person_annotation_retract")?.result).toMatchObject(
      scenario === "irrelevant"
        ? { resultType: "person_annotation.retracted" }
        : { kind: "error", code: "person_withdrawal_refused" },
    );
    expect(judgments[0]).toEqual(
      expect.objectContaining({
        record: fact,
        person_context: expect.objectContaining({
          reconciliation: expect.objectContaining({
            predecessors: [expect.objectContaining({ id: factId, text: fact })],
          }),
        }),
      }),
    );
    // Inspect the real production request; scripted scores test enforcement, not quality.
    for (const questions of editorialQuestions) {
      const question = questions.withdrawal_preservation ?? questions.belongs;
      if (!question) continue;
      expect(question.instructions).toContain("Truth or accurate attribution alone");
      expect(question.instructions).toContain(
        "Generic boilerplate, routine transactions and incidental episode associations",
      );
    }
    expect(judgments[1]).toMatchObject({
      person_context: { reconciliation: { operation: "withdraw" } },
    });
    if (scenario === "irrelevant") {
      expect(
        bench.sql.prepare("SELECT 1 FROM person_annotations WHERE id=?").get(factId),
      ).toBeUndefined();
      expect(
        bench.sql
          .prepare("SELECT 1 FROM person_annotation_evidence WHERE annotation_id=?")
          .all(factId),
      ).toEqual([]);
    } else {
      expect(
        bench.sql
          .prepare("SELECT invalidated_at,superseded_by FROM person_annotations WHERE id=?")
          .get(factId),
      ).toMatchObject({ invalidated_at: expect.any(Number), superseded_by: expect.any(String) });
      expect(
        bench.sql
          .prepare(
            "SELECT claim_text FROM person_annotations WHERE person_id=? AND invalidated_at IS NULL",
          )
          .all(personId),
      ).toContainEqual({ claim_text: replacement });
      expect(tools.find((step) => step.tool === "annotate_person")?.result?.kind).toBe(
        "structured",
      );
    }
    expect(statesAtRefusal).toEqual(["offered"]);
    expect(
      tools.filter(
        (step) =>
          step.tool === "knowledge_save" &&
          (step.args.node as { id?: string } | undefined)?.id === factId &&
          step.result?.kind === "structured",
      ),
    ).toEqual([]);
    // Once the owner is retracted, the engine legitimately settles its vanished
    // frontier as unchanged; the rejected save itself must not settle retention.
  },
  120_000,
);
