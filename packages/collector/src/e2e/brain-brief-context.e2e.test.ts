// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createBrief } from "@omnesis/gateway/src/brain/storage/briefs.js";
import { convertKnowledgeOwner } from "@omnesis/gateway/src/brain/knowledge/owner-adapters.js";
import { enqueueKnowledgeWork } from "@omnesis/gateway/src/brain/knowledge/work.js";
import { afterEach, expect, test } from "vitest";
import {
  BrainBench,
  waitFor,
  call,
  email,
  sourceInterpretations,
  preserveCurrentOwner,
  compressCognitionCadences,
} from "./brain-bench/index.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);

test("brief writes validate displayed associations and relative-time context through the real writer", async () => {
  const cases = [
    { title: "Two exhibit notices", body: "Exhibit B opens on 4 July.", accepted: false },
    {
      title: "Exhibit booking window",
      body: "The booking window closes in two days.",
      accepted: false,
    },
    {
      title: "Dated exhibit plan",
      body: "The 1 July notice says the booking window closes two days later; consider checking availability.",
      accepted: true,
    },
  ];
  const judged: Array<{ claim: string; evidence: string; context?: string }> = [];
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
    },
    entailment: ({ claim, evidence, context }) => {
      if (context) judged.push({ claim, evidence, context });
      return context && (claim.includes("Exhibit B opens") || claim.includes("closes in two days"))
        ? "neutral"
        : "entailment";
    },
    judge: "ship-all",
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: cases.map((c) => ({
          docTitle: c.title,
          expectedRefusals: c.accepted
            ? []
            : [{ tool: "brief_create", code: "evidence_does_not_entail_claim" }],
          plan: (ctx) => ({
            calls: [
              call("brief_list", {}),
              call("brief_create", {
                kind: "info",
                title: c.title,
                body: c.body,
                citations: [ctx.subject],
                confidence: 0.9,
                urgency: 0.5,
                assertedClaims: [
                  {
                    claimText: "Exhibit A opens on 4 July.",
                    evidenceDocId: ctx.subject,
                    evidenceQuote: "Exhibit A opens on 4 July.",
                    claimBasis: "quoted",
                    confidence: 0.9,
                  },
                ],
              }),
            ],
          }),
        })),
      }),
    },
  });
  for (const [i, c] of cases.entries()) {
    await bench.pushAndSettle([
      email({
        externalId: `exhibit-context-${i}`,
        title: c.title,
        content:
          "Notice dated 1 July 2026. Exhibit A opens on 4 July. Exhibit B is still being planned. The booking window closes two days after this notice.",
      }),
    ]);
  }
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const rows = bench.sql
    .prepare("SELECT title FROM briefs WHERE title IN (?,?,?) ORDER BY title")
    .all(...cases.map((c) => c.title));
  expect(rows).toEqual([{ title: "Dated exhibit plan" }]);
  for (const c of cases) expect(judged.some((input) => input.claim.includes(c.title))).toBe(true);
  expect(judged.every((input) => JSON.parse(input.context!).asOf)).toBe(true);
  // Inspect the actual production verifier boundary, not a separately built frame.
  for (const c of cases) {
    const input = judged.find((entry) => JSON.parse(entry.claim).title === c.title)!;
    const frame = JSON.parse(input.evidence);
    expect(frame.sources).toHaveLength(1);
    const source = frame.sources[0];
    const stored = bench.sql
      .prepare("SELECT content,source_created_at,source_updated_at FROM documents WHERE id=?")
      .get(source.id) as { content: string; source_created_at: string; source_updated_at: string };
    expect(stored.source_created_at).toBeTruthy();
    expect(source).toMatchObject({
      authority: "whole_source",
      text: stored.content,
      selectedQuotes: ["Exhibit A opens on 4 July."],
      sourceCreatedAt: stored.source_created_at,
      sourceUpdatedAt: stored.source_updated_at,
      truncated: false,
    });
  }
}, 180_000);

test("brief verifier outage diagnostics reach the transcript while repeated refusal preserves review debt", async () => {
  let refusals = 0;
  let refusedRunId = "";
  let refusedRevision = -1;
  const policy = sourceInterpretations({ maintainNode: preserveCurrentOwner, sources: [] });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
    },
    entailment: "accept-all",
    behaviors: {
      dynamic: (ctx, steps) => {
        const last = steps.at(-1);
        const result = last?.result as
          | { kind?: string; code?: string; message?: string }
          | undefined;
        if (
          last?.name === "knowledge_save" &&
          result?.kind === "error" &&
          result.message?.includes("Brief verification is unavailable")
        ) {
          refusals++;
          refusedRunId = ctx.runId;
          refusedRevision = Number(
            (last.args?.node as { expectedRevision?: number })?.expectedRevision,
          );
          if (refusals === 1) return { kind: "tool", name: last.name, args: last.args! };
          return {
            kind: "final",
            text: "Verification unavailable; preserve the existing brief and pending review.",
          };
        }
        return policy(ctx, steps);
      },
    },
  });
  const [sourceId] = await bench.pushAndSettle([
    email({
      externalId: "gallery-verifier-outage",
      title: "Gallery opening",
      content: "The gallery opens on 12 August.",
    }),
  ]);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 60_000 });
  bench.refuseEntailmentWith(503, "private-provider-response-must-not-leak");
  const at = Date.now();
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        createBrief(
          db,
          {
            id: "outage-card",
            createdByRun: "seed",
            kind: "info",
            title: "Gallery opening",
            body: "The gallery opens on 12 August.",
            citations: [sourceId!],
            confidence: 0.9,
            urgency: 0.4,
          },
          at,
        );
        const converted = convertKnowledgeOwner(db, "brief", "outage-card", at);
        enqueueKnowledgeWork(
          db,
          {
            id: "outage-review",
            subjectId: "outage-card",
            subjectKind: "node",
            reason: "review",
            inputRevision: String(converted.node.revision),
            tier: "immediate",
            dueAt: at,
          },
          at,
        );
      })
      .immediate(),
  );
  await waitFor("two brief verification refusals", () => (refusals >= 2 ? true : null), 60_000);
  const work = bench.sql
    .prepare("SELECT status,batch_id FROM knowledge_work WHERE id='outage-review'")
    .get() as { status: string; batch_id: string };
  expect(work.status).not.toBe("completed");
  const { id: refusedBatchId } = bench.sql
    .prepare("SELECT id FROM knowledge_batches WHERE run_id=?")
    .get(refusedRunId) as { id: string };
  expect(
    bench.sql
      .prepare("SELECT status FROM knowledge_frontier WHERE batch_id=? AND node_id='outage-card'")
      .get(refusedBatchId),
  ).toEqual({ status: "offered" });
  expect(
    bench.sql.prepare("SELECT revision FROM knowledge_nodes WHERE id='outage-card'").get(),
  ).toEqual({ revision: refusedRevision });
  expect(refusedRevision).toBeGreaterThan(0);
  expect(bench.sql.prepare("SELECT title,body FROM briefs WHERE id='outage-card'").get()).toEqual({
    title: "Gallery opening",
    body: "The gallery opens on 12 August.",
  });
  const runId = refusedRunId;
  await waitFor(
    "failed attempt transcript",
    async () => ((await bench!.obs.transcripts({ runId })).items.length > 0 ? true : null),
    30_000,
  );
  const tools = await bench.obs.executedTools(runId);
  const errors = tools.filter(
    (step) => step.tool === "knowledge_save" && (step.result as { kind?: string }).kind === "error",
  );
  expect(errors).toHaveLength(2);
  for (const step of errors) {
    expect(step.result).toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining("category=unknown"),
    });
    expect(JSON.stringify(step.result)).not.toContain("private-provider-response");
  }
}, 120_000);
