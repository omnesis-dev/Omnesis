// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrainBench, call, compressCognitionCadences, email } from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { structuredData } from "./brain-bench/puppet-plan.js";

compressCognitionCadences();
const document = email({
  externalId: "claim-scope-workshop",
  title: "Fictional workshop plan",
  content: "The workshop is on Friday. Bring a notebook.",
});
const pageId = "claim-scope-project";
let bench: BrainBench;
let sourceId = "",
  sourceRevision = "",
  revised = false;
const offers: Array<{ pending: string[]; markdown: string }> = [];
const markup = (day: string) =>
  `<claim id="date" refs="source:${sourceId}">The workshop is on ${day}.</claim>\n<claim id="supplies" refs="source:${sourceId}">Bring a notebook.</claim>`;

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    judge: "hold-all",
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "1s" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, _ctx, steps) {
          if (item.source) {
            sourceId = item.source.id;
            sourceRevision = item.source.contentHash;
            revised = item.source.content.includes("Saturday");
            const calls = [call("knowledge_fetch", { id: pageId, editing: true })];
            const fetched = [...steps]
              .reverse()
              .find((step) => step.name === "knowledge_fetch" && step.args?.id === pageId);
            if (!fetched || structuredData(fetched.result) !== null) return { calls };
            calls.push(
              call("knowledge_propose_page", {
                identityKey: "claim-scope-project",
                title: "Workshop context",
                scope: "Workshop date and supplies",
                evidenceVersions: { [sourceId]: sourceRevision },
              }),
            );
            const candidateStep = [...steps]
              .reverse()
              .find((step) => step.name === "knowledge_propose_page");
            const candidate = candidateStep ? structuredData(candidateStep.result) : null;
            if (candidate && typeof candidate === "object" && "id" in candidate)
              calls.push(
                call("knowledge_save", {
                  candidateId: candidate.id,
                  node: {
                    id: pageId,
                    kind: "wiki",
                    title: "Workshop context",
                    markdown: markup("Friday"),
                    expectedRevision: 0,
                    inputVersions: { [`source:${sourceId}`]: sourceRevision },
                  },
                }),
              );
            return { calls };
          }
          const node = item.node!;
          if (node.id !== pageId)
            return {
              calls: [
                call("knowledge_save", {
                  inputFingerprint: item.inputFingerprint,
                  node: {
                    id: node.id,
                    kind: node.kind,
                    title: node.title,
                    markdown: node.markdown,
                    expectedRevision: node.revision,
                    inputVersions: {},
                  },
                }),
              ],
            };
          offers.push({ pending: [...(item.pendingClaimIds ?? [])], markdown: node.markdown });
          const firstPartial = revised && node.markdown.includes("Friday");
          return {
            calls: [
              call("knowledge_save", {
                inputFingerprint: item.inputFingerprint,
                reviewedClaimIds: firstPartial ? [] : item.pendingClaimIds,
                node: {
                  id: pageId,
                  kind: "wiki",
                  title: node.title,
                  markdown: markup(revised ? "Saturday" : "Friday"),
                  expectedRevision: node.revision,
                  inputVersions: { [`source:${sourceId}`]: sourceRevision },
                },
              }),
            ],
          };
        },
      }),
    },
  });
}, 300_000);
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("keeps an untouched assertion pending until its own explicit review", async () => {
  await bench.pushAndSettle([document]);
  offers.length = 0;
  await bench.update(document, "The workshop is on Saturday. Bring a notebook.");
  await bench.drainUntilQuiet({ includeUpcoming: true });
  expect(offers).toEqual(
    expect.arrayContaining([
      { pending: ["date", "supplies"], markdown: markup("Friday") },
      { pending: ["supplies"], markdown: markup("Saturday") },
    ]),
  );
  const records = bench.sql
    .prepare<
      { nodeId: string },
      { claim_id: string; status: string; input_fingerprint: string }
    >("SELECT claim_id,status,input_fingerprint FROM knowledge_claim_outcomes WHERE node_id=@nodeId ORDER BY rowid")
    .all({ nodeId: pageId });
  const deferred = [...records]
    .reverse()
    .find((row) => row.claim_id === "supplies" && row.status === "deferred");
  expect(deferred).toBeDefined();
  expect(
    records.some(
      (row) =>
        row.claim_id === "date" &&
        row.status === "changed" &&
        row.input_fingerprint === deferred!.input_fingerprint,
    ),
  ).toBe(true);
  expect(
    records
      .slice(records.indexOf(deferred!) + 1)
      .some(
        (row) =>
          row.claim_id === "supplies" &&
          row.status === "unchanged" &&
          row.input_fingerprint !== deferred!.input_fingerprint,
      ),
  ).toBe(true);
  expect(records.some((row) => row.status === "pending")).toBe(false);
  const page = await bench.harness.gatewayJson<{ plainText: string; validity: string }>(
    `/admin/brain/knowledge/${pageId}`,
  );
  expect(page).toMatchObject({
    plainText: "The workshop is on Saturday.\nBring a notebook.",
    validity: "current",
  });
}, 180_000);
