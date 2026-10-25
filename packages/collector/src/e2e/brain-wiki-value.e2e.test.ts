// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { parseClaimMarkup } from "../../../gateway/src/brain/knowledge/claims.js";
import { enqueueKnowledgeWork } from "../../../gateway/src/brain/knowledge/work.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  structuredData,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("enforces the actual wiki draft verdict before entailment, retains the candidate, and publishes an admitted draft", async () => {
  const rejected = "The workshop map and access notice are listed here.";
  const accepted = "Use the east entrance before dusk to reach the workshop.";
  let deferCuration = false;
  let repairCuration = false;
  const corrected = "The east entrance leads to the workshop and closes at dusk.";
  let routeSource: { id: string; contentHash: string } | undefined;
  const maintain = knowledgePuppet({
    expectedRefusals: (item) =>
      item.source?.title === "Workshop map"
        ? [{ tool: "knowledge_save", code: "claim_invalid" }]
        : [],
    plan(item, ctx, steps) {
      if (item.node?.id === "workshop-route") {
        const registered = steps.find((step) => step.name === "knowledge_evidence");
        const evidence = registered
          ? (structuredData(registered.result) as { ref?: string })
          : null;
        const needsCorrection = repairCuration && item.node.markdown.includes(accepted);
        const repaired =
          deferCuration && evidence?.ref && routeSource
            ? item.node.markdown.replace(
                `refs="source:${routeSource.id} `,
                `refs="${evidence.ref} `,
              )
            : item.node.markdown;
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            ...(deferCuration && routeSource
              ? [
                  // Changed support invalidates inherited receipts for the entire claim.
                  // Read retained dependencies too, rather than borrowing a prior run's versions.
                  call("knowledge_reference", {
                    refs: [
                      ...new Set(
                        parseClaimMarkup(item.node.markdown).claims.flatMap((claim) =>
                          claim.refs.map((ref) => ref.raw),
                        ),
                      ),
                    ],
                  }),
                  call("knowledge_evidence", {
                    documentId: routeSource.id,
                    contentHash: routeSource.contentHash,
                    quote: "The east entrance leads to the workshop.",
                  }),
                ]
              : []),
            call("knowledge_save", {
              inputFingerprint: item.inputFingerprint,
              reviewedClaimIds: item.pendingClaimIds,
              ...(deferCuration
                ? {
                    curationDeferral: {
                      reasonCode: "insufficient_useful_context",
                      ...(needsCorrection ? { factualRepair: { claimIds: ["access"] } } : {}),
                      reason:
                        "The inspected sources support the retained route but no further useful account.",
                    },
                  }
                : {
                    placementAssessment: {
                      status: "standalone",
                      reason: "The workshop route and entrance hours form a self-contained scope.",
                    },
                  }),
              node: {
                id: item.id,
                kind: "wiki",
                title: item.node.title,
                markdown: needsCorrection ? repaired.replace(accepted, corrected) : repaired,
                expectedRevision: item.node.revision,
              },
            }),
          ],
        };
      }
      if (!item.source) return preserveCurrentOwner(item, ctx, steps);
      if (item.source.title === "Workshop access notice") return { calls: [] };
      const support = complementaryEvidence("Workshop access notice", steps);
      if (!support.evidence) return { calls: support.calls };
      const source = item.source;
      routeSource = { id: source.id, contentHash: source.contentHash };
      const reads = [
        ...support.calls,
        call("knowledge_list", { kind: "wiki" }),
        call("knowledge_candidates", {}),
      ];
      const listed = steps.find((step) => step.name === "knowledge_list");
      const candidates = steps.find((step) => step.name === "knowledge_candidates");
      if (!listed || !candidates) return { calls: reads };
      const pages = structuredData(listed.result) as unknown as Array<{ id: string }>;
      const candidateItems = structuredData(candidates.result)?.items as Array<{
        identityKey: string;
      }>;
      if (!Array.isArray(pages) || !Array.isArray(candidateItems))
        throw new Error("Expected actual wiki and candidate inventory");
      // A source can legitimately be offered again after publication catch-up.
      // Reconcile durable outcomes instead of replaying publication attempts.
      const attempts = [false, true].filter((admit) =>
        admit
          ? !pages.some((page) => page.id === "workshop-route")
          : !candidateItems.some((candidate) => candidate.identityKey === "workshop-list"),
      );
      const versions = {
        [`source:${source.id}`]: source.sourceRevision ?? source.contentHash,
        [support.evidence.ref]: support.evidence.revision,
      };
      return {
        calls: [
          ...reads,
          ...(pages.some((page) => page.id === "workshop-route")
            ? [call("knowledge_fetch", { id: "workshop-route" })]
            : []),
          ...attempts.flatMap((admit, attemptIndex) => [
            call("knowledge_propose_page", {
              identityKey: admit ? "workshop-route" : "workshop-list",
              title: admit ? "Workshop route" : "Workshop source list",
              scope: admit ? "Workshop entrance and access limits" : "Workshop document labels",
              evidenceVersions: {
                [source.id]: source.sourceRevision ?? source.contentHash,
                [support.evidence!.id]: support.evidence!.revision,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id", attemptIndex),
              creationAssessment: {
                reason: "No matching workshop scope in the inspected library.",
                relatedPageIds: [],
              },
              node: {
                id: admit ? "workshop-route" : "workshop-list",
                kind: "wiki",
                title: admit ? "Workshop route" : "Workshop source list",
                markdown: `<claim id="access" refs="source:${source.id} ${support.evidence!.ref}">${admit ? accepted : rejected}</claim>`,
                expectedRevision: 0,
                inputVersions: versions,
              },
            }),
          ]),
        ],
      };
    },
    targets: (_item, steps) =>
      steps.some(
        (step) =>
          (step.name === "knowledge_save" &&
            (structuredData(step.result)?.node as { id?: string } | undefined)?.id ===
              "workshop-route") ||
          (step.name === "knowledge_fetch" && structuredData(step.result)?.id === "workshop-route"),
      )
        ? ["workshop-route"]
        : [],
  });
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: () => "entailment",
    decision: {
      policy: (request) => {
        const state = request.state as {
          record_type?: string;
          record?: string;
          wiki_context?: { factualRepair?: unknown };
        };
        return Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error("Expected score question");
            return [
              key,
              {
                type: "score" as const,
                score:
                  state.record_type === "wiki" &&
                  (state.record === rejected ||
                    (state.record === corrected && !state.wiki_context?.factualRepair))
                    ? 0.1
                    : question.criteria.length - 1,
              },
            ];
          }),
        );
      },
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      annotations: { recordCheck: "enforce" },
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: { dynamic: maintain },
  });
  await bench.pushAndSettle([
    email({
      externalId: "workshop-access",
      title: "Workshop access notice",
      content: "The east entrance closes at dusk.",
    }),
  ]);
  await waitForComplementaryEvidence(bench, "Workshop access notice");
  await bench.push(
    email({
      externalId: "workshop-map",
      title: "Workshop map",
      content: "The east entrance leads to the workshop.",
    }),
  );
  await expect
    .poll(
      () => bench!.sql.prepare("SELECT id FROM knowledge_nodes WHERE id='workshop-route'").get(),
      { timeout: 90_000 },
    )
    .toEqual({ id: "workshop-route" });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(
    bench.sql.prepare("SELECT id FROM knowledge_nodes WHERE id='workshop-list'").get(),
  ).toBeUndefined();
  expect(
    bench.sql
      .prepare("SELECT status FROM knowledge_candidates WHERE identity_key='workshop-list'")
      .get(),
  ).toEqual({ status: "proposed" });
  expect(bench.entailmentCalls.some((entry) => entry.claim === rejected)).toBe(false);
  expect(bench.entailmentCalls.some((entry) => entry.claim === accepted)).toBe(true);
  const rows = bench.sql
    .prepare(
      "SELECT verdict,enforced,score,threshold FROM cognition_decisions WHERE record_id='workshop-list' AND purpose='record-check'",
    )
    .all();
  expect(rows).toEqual([{ verdict: "skip", enforced: 1, score: 0.1, threshold: 0.81 }]);
  const valueChecksBefore = bench.sql
    .prepare(
      "SELECT COUNT(*) AS n FROM cognition_decisions WHERE record_id='workshop-route' AND purpose='record-check'",
    )
    .get();
  deferCuration = true;
  const before = bench.sql
    .prepare("SELECT metadata_json FROM knowledge_nodes WHERE id='workshop-route'")
    .get() as { metadata_json: string };
  const reviewedBefore = JSON.parse(before.metadata_json).lastReviewedAt;
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        const node = db
          .prepare("SELECT revision FROM knowledge_nodes WHERE id='workshop-route'")
          .get() as { revision: number };
        enqueueKnowledgeWork(
          db,
          {
            id: "curation-review",
            subjectId: "workshop-route",
            subjectKind: "node",
            reason: "review",
            inputRevision: String(node.revision),
            tier: "immediate",
            dueAt: Date.now(),
          },
          Date.now(),
        );
      })
      .immediate(),
  );
  try {
    await expect
      .poll(
        () =>
          bench!.sql.prepare("SELECT status FROM knowledge_work WHERE id='curation-review'").get(),
        { timeout: 60_000 },
      )
      .toEqual({ status: "deferred" });
  } catch (cause) {
    const runs = (await bench.obs.runs({ limit: 12 })).items;
    const diagnostics = await Promise.all(
      runs.map(async (run) => ({
        id: run.id,
        status: run.status,
        error: run.lastError,
        tools: (await bench!.obs.executedTools(run.id))
          .filter((step) => step.result?.kind === "error")
          .map((step) => ({ tool: step.tool, result: step.result })),
      })),
    );
    throw new Error(`Curation review did not defer: ${JSON.stringify(diagnostics)}`, { cause });
  }
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 90_000 });
  const after = bench.sql
    .prepare("SELECT plain_text,metadata_json FROM knowledge_nodes WHERE id='workshop-route'")
    .get() as { plain_text: string; metadata_json: string };
  expect(after.plain_text).toBe(accepted);
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM cognition_decisions WHERE record_id='workshop-route' AND purpose='record-check'",
      )
      .get(),
  ).toEqual(valueChecksBefore);
  expect(
    bench.sql.prepare("SELECT markdown FROM knowledge_nodes WHERE id='workshop-route'").get(),
  ).toMatchObject({ markdown: expect.stringContaining("#evidence:") });
  expect(
    bench.sql
      .prepare("SELECT verification FROM knowledge_claims WHERE node_id='workshop-route'")
      .all(),
  ).toEqual([{ verification: "verified" }]);
  expect(JSON.parse(after.metadata_json).lastReviewedAt).toBe(reviewedBefore);
  expect(JSON.parse(after.metadata_json).reviewReason).toBe("curation_insufficient_context");
  expect(JSON.parse(after.metadata_json).nextReviewAt).toBeGreaterThan(Date.now() + 60_000);
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id='workshop-route' AND reason='review' AND status='pending' AND due_at>?",
      )
      .get(Date.now()),
  ).toEqual({ n: 1 });
  // A correction is judged for integrity, not forced to add editorial padding.
  repairCuration = true;
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        const node = db
          .prepare("SELECT revision FROM knowledge_nodes WHERE id='workshop-route'")
          .get() as { revision: number };
        enqueueKnowledgeWork(
          db,
          {
            id: "factual-review",
            subjectId: "workshop-route",
            subjectKind: "node",
            reason: "review",
            inputRevision: String(node.revision),
            tier: "immediate",
            dueAt: Date.now(),
          },
          Date.now(),
        );
      })
      .immediate(),
  );
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare("SELECT plain_text FROM knowledge_nodes WHERE id='workshop-route'")
          .get(),
      { timeout: 60_000 },
    )
    .toEqual({ plain_text: corrected });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 90_000 });
  expect(
    bench.sql
      .prepare(
        "SELECT rubric_version,verdict,enforced FROM cognition_decisions WHERE record_id='workshop-route' AND rubric_version='wiki-repair-integrity-v1'",
      )
      .all(),
  ).toEqual([{ rubric_version: "wiki-repair-integrity-v1", verdict: "pass", enforced: 1 }]);
  const repairedPage = bench.sql
    .prepare("SELECT metadata_json FROM knowledge_nodes WHERE id='workshop-route'")
    .get() as { metadata_json: string };
  expect(JSON.parse(repairedPage.metadata_json).lastReviewedAt).toBe(reviewedBefore);
  expect(JSON.parse(repairedPage.metadata_json).reviewReason).toBe("curation_insufficient_context");
  expect(
    bench.sql
      .prepare("SELECT verification FROM knowledge_claims WHERE node_id='workshop-route'")
      .all(),
  ).toEqual([{ verification: "verified" }]);
}, 240_000);
