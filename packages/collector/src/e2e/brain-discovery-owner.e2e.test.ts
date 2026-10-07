// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { structuredData } from "./brain-bench/puppet-plan.js";

compressCognitionCadences();
const description = "Prepare twelve notebooks for the workshop.";
const document = email({
  externalId: "discovery-fresh-owner",
  title: "Workshop preparation request",
  content: description,
});
const title = "Prepare workshop notebooks";
const createdLoop = z.object({ loop: z.object({ id: z.string() }) });
let bench: BrainBench;
let sourceId = "";
let sourceRevision = "";
let loopId = "";
let briefId = "";
const nodeOffers: Array<{ kind: string; matchesLoop: boolean; validity: unknown }> = [];

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    judge: "ship-all",
    decision: {
      policy(request) {
        const purpose = Object.keys(request.questions)[0]!;
        return { [purpose]: { type: "score" as const, score: purpose === "impact" ? 0 : 2 } };
      },
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "1s" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, ctx, steps) {
          if (item.source) {
            if (item.source.title !== document.title) return { calls: [] };
            sourceId = item.source.id;
            sourceRevision = item.source.contentHash;
            return {
              calls: [
                call("fetch_many", { documents: [{ documentId: sourceId }] }),
                call("open_loop_search", { query: title }),
                call("open_loop_create", {
                  title,
                  description,
                  confidence: 0.9,
                  importance: 0.6,
                  docs: [sourceId],
                }),
                call("brief_list", {}),
                call("brief_create", {
                  kind: "info",
                  title: "Workshop preparation",
                  description,
                  confidence: 0.9,
                  urgency: 0.3,
                  citations: [sourceId],
                }),
              ],
            };
          }
          if (item.node)
            nodeOffers.push({
              kind: item.node.kind,
              matchesLoop: item.node.id === loopId,
              validity: item.node.validity,
            });
          if (!item.node || ![loopId, briefId].includes(item.node.id))
            return preserveCurrentOwner(item, ctx, steps);
          const isBrief = item.node.id === briefId;
          return {
            calls: [
              call("knowledge_save", {
                inputFingerprint: item.inputFingerprint,
                node: {
                  id: item.node.id,
                  kind: isBrief ? "brief" : "loop",
                  ownerId: item.node.id,
                  title: item.node.title,
                  markdown: isBrief
                    ? `<claim id="outcome" refs="source:${sourceId}">## Description\n${description}\n\n## Body\n</claim>`
                    : `<claim id="outcome" refs="source:${sourceId}">${description}</claim>`,
                  expectedRevision: item.node.revision,
                  inputVersions: { [`source:${sourceId}`]: sourceRevision },
                },
              }),
            ],
          };
        },
        targets(item, steps) {
          if (item.source?.title !== document.title) return [];
          const created = steps.find((step) => step.name === "open_loop_create");
          loopId = createdLoop.parse(structuredData(created?.result)).loop.id;
          const brief = steps.find((step) => step.name === "brief_create");
          briefId = z
            .object({ brief: z.object({ id: z.string() }) })
            .parse(structuredData(brief?.result)).brief.id;
          return [];
        },
      }),
    },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("automatically discovers a fresh canonical loop without explicit targets and grounds it in the same run", async () => {
  await bench.push(document);
  try {
    await bench.drainUntilQuiet();
  } catch (error) {
    const attempts = await bench.obs.runs({ kind: "synthesis" });
    const calls = await Promise.all(attempts.items.map((run) => bench.obs.executedTools(run.id)));
    const refused = calls.flat().filter((step) => step.result?.kind === "error");
    throw new Error(
      `${String(error)}; refused tools=${JSON.stringify(refused)}; node offers=${JSON.stringify(nodeOffers)}; gateway tail=${readFileSync(bench.harness.getGatewayLogPath(), "utf8").split("\n").slice(-60).join("\n")}`,
      { cause: error },
    );
  }
  const documentId = sourceId;
  const runs = await bench.obs.runsForSource(documentId);
  const executions = await Promise.all(runs.map((run) => bench.obs.executedTools(run.id)));
  const steps = executions.find((items) => items.some((step) => step.tool === "open_loop_create"));
  expect(steps).toBeDefined();
  expect(steps!.some((step) => step.result?.kind === "error")).toBe(false);
  const createdAt = steps!.findIndex((step) => step.tool === "open_loop_create");
  const completedAt = steps!.findIndex((step) => step.tool === "knowledge_discovery_complete");
  expect(completedAt).toBeGreaterThan(createdAt);
  expect(steps![completedAt]!.args.targets ?? []).toEqual([]);
  const savedAt = steps!.findIndex(
    (step) =>
      step.tool === "knowledge_save" &&
      typeof step.args.node === "object" &&
      step.args.node !== null &&
      "id" in step.args.node &&
      step.args.node.id === loopId,
  );
  expect(savedAt).toBeGreaterThan(completedAt);
  expect(
    steps!.slice(completedAt + 1, savedAt).some((step) => step.tool === "knowledge_next_frontier"),
  ).toBe(true);
  const page = await bench.harness.gatewayJson<{
    kind: string;
    ownerId: string;
    plainText: string;
    validity: string;
    claims: Array<{ id: string; refs: string[]; verification: string }>;
  }>(`/admin/brain/knowledge/${encodeURIComponent(loopId)}`);
  expect(page).toMatchObject({
    kind: "loop",
    ownerId: loopId,
    plainText: description,
    validity: "current",
  });
  expect(page.claims).toEqual([
    expect.objectContaining({
      id: "outcome",
      refs: [`source:${documentId}`],
      verification: "verified",
    }),
  ]);
  const brief = await bench.harness.gatewayJson<{ claims: Array<{ verification: string }> }>(
    `/admin/brain/knowledge/${encodeURIComponent(briefId)}`,
  );
  expect(brief.claims).toEqual([expect.objectContaining({ verification: "verified" })]);
  expect(
    steps!.some(
      (step, index) =>
        index > completedAt &&
        step.tool === "knowledge_save" &&
        typeof step.args.node === "object" &&
        step.args.node !== null &&
        "id" in step.args.node &&
        step.args.node.id === briefId,
    ),
  ).toBe(true);
  expect(await bench.obs.loopsMatching(title)).toHaveLength(1);
  // A first root with usable orientation must be offered despite a gate that
  // rejects every impact request. The puppet may legitimately keep it empty.
  expect(nodeOffers.some((node) => node.kind === "root")).toBe(true);
  expect(
    bench.sql
      .prepare(
        `SELECT 1 FROM cognition_runs WHERE kind='synthesis'
    AND json_extract(payload_json,'$.schedulingClass')='initial-root'
    AND attempts>0 LIMIT 1`,
      )
      .get(),
  ).toBeDefined();
}, 180_000);
