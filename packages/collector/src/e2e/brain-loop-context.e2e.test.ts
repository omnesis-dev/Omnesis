// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { expect, test } from "vitest";
import { scheduleKnowledgeReview } from "../../../gateway/src/brain/knowledge/work-lifecycle.js";
import { updateOpenLoop } from "../../../gateway/src/brain/storage/open-loops.js";
import { KnowledgeReferenceReader } from "../../../gateway/src/brain/knowledge/reference-reader.js";
import { createGatewayLoopReadPort } from "../../../gateway/src/brain/interactive-loop-port.js";
import { CONTEXTUAL_VERIFIER } from "../../../gateway/src/brain/knowledge/claim-context.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  sourceInterpretations,
} from "./brain-bench/index.js";

compressCognitionCadences();
test("split outcome claims retain final interpretation context through real terminal saves", async () => {
  let refused = false;
  let unchangedAtRefusal = false;
  let sourceId = "";
  const title = "Prepare the exhibition display";
  const description = "Assembly was proposed Monday. The display was approved Friday.";
  const mail = email({
    externalId: "display-sequence",
    title: "Exhibition display sequence",
    content: description,
  });
  const maintain = sourceInterpretations({
    maintainNode(item, ctx, steps) {
      if (item.node?.kind !== "loop" || item.node.title !== title)
        return preserveCurrentOwner(item, ctx, steps);
      return {
        calls: [
          call("knowledge_reference", { ref: `source:${sourceId}` }),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            reviewedClaimIds: item.pendingClaimIds,
            node: {
              id: item.id,
              ownerId: item.node.ownerId,
              kind: "loop",
              title,
              expectedRevision: item.node.revision,
              markdown: `<claim id="approval" refs="source:${sourceId}">The display was approved Friday.</claim>\n<claim id="assembly" refs="source:${sourceId}">${refused ? "Earlier" : "Later"}, assembly was proposed.</claim>`,
            },
          }),
        ],
      };
    },
    sources: [
      {
        docTitle: mail.title,
        plan(ctx) {
          if (!ctx.subject) throw new Error("Source maintenance requires a subject");
          sourceId = ctx.subject;
          return {
            calls: [
              call("open_loop_search", { query: "exhibition display" }),
              call("open_loop_create", {
                title,
                description,
                confidence: 0.8,
                importance: 0.5,
                docs: [ctx.subject],
                annotationDependencies: [],
              }),
            ],
          };
        },
      },
    ],
  });
  const bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: ({ claim, context }) => {
      if (claim.startsWith("Later,")) {
        expect(JSON.parse(context!).outcome.text).toContain("approved Friday");
        return "neutral";
      }
      return "entailment";
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
      mergeAdjudication: { enabled: false },
    },
    behaviors: {
      dynamic(ctx, steps) {
        const last = steps.at(-1);
        if (
          last?.name === "knowledge_save" &&
          last.result &&
          typeof last.result === "object" &&
          "code" in last.result &&
          last.result.code === "claim_invalid"
        ) {
          refused = true;
          unchangedAtRefusal =
            (
              bench.sql.prepare("SELECT description FROM open_loops WHERE title=?").get(title) as {
                description: string;
              }
            ).description === description;
          return { kind: "tool", name: "knowledge_next_frontier", args: {} };
        }
        return maintain(ctx, steps);
      },
    },
  });
  try {
    await bench.pushAndSettle([mail]);
    expect(
      refused,
      JSON.stringify({
        loops: bench.sql.prepare("SELECT title FROM open_loops").all(),
        work: bench.sql.prepare("SELECT subject_kind,status,last_error FROM knowledge_work").all(),
        runs: bench.sql.prepare("SELECT status,last_error FROM cognition_runs").all(),
      }),
    ).toBe(true);
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120000 });
    expect(unchangedAtRefusal).toBe(true);
    expect(
      bench.sql.prepare("SELECT description FROM open_loops WHERE title=?").all(title),
    ).toEqual([
      { description: "The display was approved Friday.\nEarlier, assembly was proposed." },
    ]);
    const proofs = bench.sql
      .prepare(
        "SELECT c.verifier FROM knowledge_claims c JOIN knowledge_nodes n ON n.id=c.node_id WHERE n.kind='loop' AND n.title=?",
      )
      .all(title);
    expect(proofs).toEqual([{ verifier: CONTEXTUAL_VERIFIER }, { verifier: CONTEXTUAL_VERIFIER }]);
    // A retained completed owner still owes proof-policy maintenance, not reopening.
    bench.withWriteHandle((db) => {
      // The live owner reconciler may advance the projection after closing the
      // canonical outcome. Seed the legacy proof and its review atomically.
      db.transaction(() => {
        const node = db
          .prepare("SELECT id FROM knowledge_nodes WHERE kind='loop' AND title=?")
          .get(title) as { id: string };
        const now = Date.now();
        updateOpenLoop(db, node.id, { state: "done" }, now);
        db.prepare(
          "UPDATE knowledge_claims SET verifier='entailment-verifier' WHERE node_id=?",
        ).run(node.id);
        expect(
          new KnowledgeReferenceReader(db).reference(`loop:${node.id}#claim:assembly`).verified,
        ).toBe(false);
        const current = db
          .prepare("SELECT revision FROM knowledge_nodes WHERE id=?")
          .get(node.id) as { revision: number };
        scheduleKnowledgeReview(
          db,
          {
            id: node.id,
            expectedRevision: current.revision,
            nextReviewAt: now,
            decision: "now",
            workId: "closed-loop-proof-repair",
          },
          now,
        );
      }).immediate();
    });
    await expect
      .poll(
        () =>
          bench.sql
            .prepare("SELECT status FROM knowledge_work WHERE id='closed-loop-proof-repair'")
            .get(),
        { timeout: 90000 },
      )
      .toMatchObject({ status: "completed" });
    expect(bench.sql.prepare("SELECT state FROM open_loops WHERE title=?").get(title)).toEqual({
      state: "done",
    });
    expect(
      bench.sql
        .prepare(
          "SELECT c.verifier FROM knowledge_claims c JOIN knowledge_nodes n ON n.id=c.node_id WHERE n.kind='loop' AND n.title=?",
        )
        .all(title),
    ).toEqual([{ verifier: CONTEXTUAL_VERIFIER }, { verifier: CONTEXTUAL_VERIFIER }]);
    const repaired = bench.sql
      .prepare("SELECT id FROM knowledge_nodes WHERE kind='loop' AND title=?")
      .get(title) as { id: string };
    expect(
      new KnowledgeReferenceReader(bench.sql).reference(`loop:${repaired.id}#claim:assembly`),
    ).toMatchObject({ verified: true, text: "Earlier, assembly was proposed." });
    await expect
      .poll(async () => {
        const detail = await createGatewayLoopReadPort(bench.sql).fetch(repaired.id);
        return detail?.knowledgeContext?.verifiedSupport;
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ref: `loop:${repaired.id}#claim:assembly`,
            interpretationContext: expect.stringContaining("Earlier, assembly was proposed."),
          }),
        ]),
      );
    expect(
      bench.entailmentCalls.some(
        (c) => c.claim?.startsWith("Later,") && c.answer.includes('"verdict":"unsupported"'),
      ),
    ).toBe(true);
  } finally {
    await bench.destroy();
  }
}, 240000);
