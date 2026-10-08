// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
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
import type { PuppetKnowledgeItem } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);
const pageId = "workshop-storage-reference";
const markup = (sourceId: string, both: boolean) =>
  `<claim id="labels" refs="source:${sourceId}">Blue labels identify the first cabinet.</claim>` +
  (both
    ? `<claim id="tools" refs="source:${sourceId}">Tools belong in the second cabinet.</claim>`
    : "");

it("refuses empty and placeholder wiki replacements, then accepts deliberate narrow removal", async () => {
  let sourceId = "";
  const edit = (item: PuppetKnowledgeItem, markdown: string) => ({
    inputFingerprint: item.inputFingerprint,
    reviewedClaimIds: ["labels", "tools"],
    node: {
      id: pageId,
      kind: "wiki",
      title: "Workshop storage reference",
      expectedRevision: item.node!.revision,
      markdown,
      inputVersions: { [`source:${sourceId}`]: item.inputVersions[`source:${sourceId}`] },
    },
  });
  const maintain = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source) {
        sourceId = item.source.id;
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: "workshop-storage-reference",
              title: "Workshop storage reference",
              scope: "Reference locations for workshop materials",
              evidenceVersions: { [sourceId]: item.source.contentHash },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              node: {
                id: pageId,
                kind: "wiki",
                title: "Workshop storage reference",
                expectedRevision: 0,
                markdown: markup(sourceId, true),
                inputVersions: { [`source:${sourceId}`]: item.source.contentHash },
              },
            }),
          ],
        };
      }
      if (item.id === pageId) {
        const args = edit(item, markup(sourceId, false));
        return {
          calls: [
            call("knowledge_history", { id: pageId, revision: item.node!.revision }),
            call("knowledge_save", {
              ...args,
              node: {
                ...args.node,
                claimRemovals: [
                  { id: "tools", reason: "Retired material-location section after review." },
                ],
              },
            }),
          ],
        };
      }
      return preserveCurrentOwner(item, ctx, steps);
    },
    targets: (item) => (item.source ? [pageId] : []),
  });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    judge: "hold-all",
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            return [
              key,
              { type: "score" as const, score: question.criteria.length - 1, confidence: 1 },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic(ctx, steps) {
        const lastFrontier = [...steps]
          .reverse()
          .find((step) => step.name === "knowledge_next_frontier");
        const data = z
          .object({ items: z.array(z.unknown()) })
          .safeParse(lastFrontier ? structuredData(lastFrontier.result) : null);
        const item = data.success
          ? (data.data.items.find(
              (item) =>
                typeof item === "object" && item !== null && "id" in item && item.id === pageId,
            ) as PuppetKnowledgeItem | undefined)
          : undefined;
        const refused = steps.filter(
          (step) =>
            step.name === "knowledge_save" &&
            step.result &&
            typeof step.result === "object" &&
            "kind" in step.result &&
            step.result.kind === "error",
        );
        if (item && refused.length < 2)
          return {
            kind: "tool",
            name: "knowledge_save",
            args: edit(
              item,
              refused.length === 0
                ? ""
                : '<claim id="review" refs="">Existing context remains current.</claim>',
            ),
          };
        return maintain(
          ctx,
          steps.filter((step) => !refused.includes(step)),
        );
      },
    },
  });
  await bench.push(
    email({
      externalId: "storage-reference",
      title: "Workshop storage instructions",
      content: "Blue labels identify the first cabinet. Tools belong in the second cabinet.",
    }),
  );
  const id = await bench.docId("storage-reference");
  await expect
    .poll(() => bench!.sql.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 60_000,
    })
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const runs = bench.sql
    .prepare<
      [string],
      { run_id: string }
    >("SELECT DISTINCT b.run_id FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id WHERE w.subject_id=?")
    .all(id);
  const tools = (await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))).flat();
  expect(
    tools.some((step) => step.tool === "knowledge_history" && step.result?.kind === "structured"),
  ).toBe(true);
  const errors = tools.filter(
    (step) => step.tool === "knowledge_save" && step.result?.kind === "error",
  );
  expect(errors).toHaveLength(2);
  expect(errors[0]!.result).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("cannot be saved empty"),
  });
  expect(errors[1]!.result).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("omits existing claims"),
  });
  expect(
    bench.sql.prepare("SELECT revision,markdown FROM knowledge_nodes WHERE id=?").get(pageId),
  ).toEqual({ revision: 2, markdown: markup(id, false) });
  const audit = bench.sql
    .prepare<
      [string],
      { diff_json: string }
    >("SELECT diff_json FROM knowledge_revisions WHERE node_id=? AND revision=2")
    .get(pageId)!;
  expect(JSON.parse(audit.diff_json).claimRemovals).toEqual([
    { id: "tools", reason: "Retired material-location section after review." },
  ]);
}, 180_000);
