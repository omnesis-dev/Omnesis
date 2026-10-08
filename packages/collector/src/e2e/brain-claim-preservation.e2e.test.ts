// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterEach, expect, it } from "vitest";
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
import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import type { PuppetKnowledgeItem } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);
const pageId = "workshop-storage-reference";
const markup = (sourceId: string, both: boolean, toolSourceId = sourceId) =>
  `<claim id="labels" refs="source:${sourceId}">Blue labels identify the first cabinet.</claim>` +
  (both
    ? `<claim id="tools" refs="source:${toolSourceId}">Tools belong in the second cabinet.</claim>`
    : "");

it("refuses destructive replacements and unavailable navigation, then accepts deliberate narrow removal", async () => {
  let sourceId = "";
  let supportId = "";
  let supportRevision = "";
  const edit = (item: PuppetKnowledgeItem, markdown: string) => ({
    inputFingerprint: item.inputFingerprint,
    reviewedClaimIds: ["labels", "tools"],
    node: {
      id: pageId,
      kind: "wiki",
      title: "Workshop storage reference",
      expectedRevision: item.node!.revision,
      markdown,
      inputVersions: {
        [`source:${sourceId}`]: item.inputVersions[`source:${sourceId}`],
        [`source:${supportId}`]: supportRevision,
      },
    },
  });
  const maintain = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source) {
        if (item.source.title === "Tool storage allocation") return { calls: [] };
        const support = complementaryEvidence("Tool storage allocation", steps);
        if (!support.evidence) return { calls: support.calls };
        supportId = support.evidence.id;
        supportRevision = support.evidence.revision;
        sourceId = item.source.id;
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: "workshop-storage-reference",
              title: "Workshop storage reference",
              scope: "Reference locations for workshop materials",
              evidenceVersions: {
                [sourceId]: item.source.contentHash,
                [supportId]: supportRevision,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              creationAssessment: {
                reason:
                  "A distinct reference combines label identification and separate equipment allocation.",
                relatedPageIds: [],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Workshop storage reference",
                expectedRevision: 0,
                markdown: markup(sourceId, true, supportId),
                inputVersions: {
                  [`source:${sourceId}`]: item.source.contentHash,
                  [`source:${supportId}`]: supportRevision,
                },
              },
            }),
          ],
        };
      }
      if (item.id === pageId) {
        const args = edit(item, markup(sourceId, false, supportId));
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_history", { id: pageId, revision: item.node!.revision }),
            call("knowledge_save", {
              ...args,
              placementAssessment: {
                status: "standalone",
                reason: "Self-contained workshop storage reference.",
              },
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
    targets: (item) =>
      item.source && item.source.title !== "Tool storage allocation" ? [pageId] : [],
  });
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
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
        if (item && refused.length < 3)
          return {
            kind: "tool",
            name: "knowledge_save",
            args: edit(
              item,
              refused.length === 0
                ? ""
                : refused.length === 1
                  ? '<claim id="review" refs="">Existing context remains current.</claim>'
                  : markup(sourceId, true, supportId).replace(
                      "Blue labels identify the first cabinet.",
                      "Blue labels identify the first cabinet. [Related reference](wiki:wiki_missing_reference)",
                    ),
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
      externalId: "tool-storage-allocation",
      title: "Tool storage allocation",
      content: "Tools belong in the second cabinet.",
    }),
  );
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, "Tool storage allocation");
  await bench.push(
    email({
      externalId: "storage-reference",
      title: "Workshop storage instructions",
      content: "Blue labels identify the first cabinet.",
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
  expect(errors).toHaveLength(3);
  expect(errors[0]!.result).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("cannot be saved empty"),
  });
  expect(errors[1]!.result).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("omits existing claims"),
  });
  expect(errors[2]!.result).toMatchObject({
    code: "reference_invalid",
    message: expect.stringContaining("Internal navigation target is unavailable"),
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

it("reviews published pages with omitted discovery targets and both hierarchy endpoints", async () => {
  const parentId = "wiki_fixture_workshop_program";
  const childId = "wiki_fixture_workshop_equipment";
  const titles = new Map([
    ["Workshop program", parentId],
    ["Equipment inventory", childId],
  ]);
  let hierarchyRequested = false;
  let omissionTested = false;
  const maintain = knowledgePuppet({
    targets: () => [],
    maxRevisionConflictRetries: 4,
    plan(item, ctx, steps) {
      if (item.source) {
        if (["Workshop participation", "Equipment calibration"].includes(item.source.title))
          return { calls: [] };
        const id = titles.get(item.source.title);
        if (!id) hierarchyRequested = true;
      }
      return placementPlan(item, ctx, steps);
    },
  });
  const placementPlan: Parameters<typeof knowledgePuppet>[0]["plan"] = (item, ctx, steps) => {
    if (item.source) {
      const id = titles.get(item.source.title);
      if (!id)
        return {
          calls: [
            call("knowledge_fetch", { id: childId }),
            call("knowledge_fetch", { id: parentId }),
            call("knowledge_link", {
              fromId: childId,
              toId: parentId,
              kind: "part_of",
              fromRevision: ref("knowledge_fetch", "revision", 0),
              toRevision: ref("knowledge_fetch", "revision", 1),
            }),
          ],
        };
      const support = complementaryEvidence(
        id === parentId ? "Workshop participation" : "Equipment calibration",
        steps,
      );
      if (!support.evidence) return { calls: support.calls };
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: id,
            title: item.source.title,
            scope: item.source.content,
            evidenceVersions: {
              [item.source.id]: item.source.contentHash,
              [support.evidence.id]: support.evidence.revision,
            },
          }),
          call("knowledge_save", {
            candidateId: ref("knowledge_propose_page", "id"),
            creationAssessment: {
              reason:
                "A distinct reusable scope combines the subject record and its separate operational requirements.",
              relatedPageIds: [],
            },
            node: {
              id,
              kind: "wiki",
              title: item.source.title,
              expectedRevision: 0,
              markdown: `<claim id="summary" refs="source:${item.source.id}">${item.source.content}</claim><claim id="requirements" refs="${support.evidence.ref}">${support.evidence.text}</claim>`,
              inputVersions: {
                [`source:${item.source.id}`]: item.source.contentHash,
                [support.evidence.ref]: support.evidence.revision,
              },
            },
          }),
        ],
      };
    }
    if (item.node && (item.id === parentId || item.id === childId))
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_links", { id: item.id }),
          ...(hierarchyRequested
            ? [
                call("knowledge_fetch", { id: item.id, editing: true }),
                call("knowledge_fetch", {
                  id: item.id === parentId ? childId : parentId,
                }),
              ]
            : []),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            reviewedClaimIds: item.pendingClaimIds,
            placementAssessment: hierarchyRequested
              ? {
                  status: "integrated",
                  reason: "Detail page belongs to the workshop program.",
                  links: [
                    {
                      fromId: childId,
                      toId: parentId,
                      kind: "part_of",
                      otherRevision: ref("knowledge_fetch", "revision", 1),
                    },
                  ],
                }
              : { status: "standalone", reason: "Distinct workshop reference scope." },
            node: {
              id: item.id,
              kind: "wiki",
              title: item.node.title,
              expectedRevision: item.node.revision,
              markdown: item.node.markdown,
              inputVersions: item.inputVersions,
            },
          }),
        ],
      };
    return preserveCurrentOwner(item, ctx, steps);
  };
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
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
        const last = steps.at(-1);
        const fetched = z
          .object({ id: z.string(), title: z.string(), markdown: z.string(), revision: z.number() })
          .safeParse(last ? structuredData(last.result) : null);
        const frontierStep = [...steps]
          .reverse()
          .find((step) => step.name === "knowledge_next_frontier");
        const frontier = z
          .object({
            items: z.array(
              z.object({
                id: z.string(),
                inputFingerprint: z.string(),
                inputVersions: z.record(z.string(), z.union([z.string(), z.number()])),
                pendingClaimIds: z.array(z.string()).optional(),
              }),
            ),
          })
          .safeParse(frontierStep ? structuredData(frontierStep.result) : null);
        const item = frontier.success
          ? frontier.data.items.find((item) => item.id === parentId)
          : undefined;
        if (
          !omissionTested &&
          item &&
          last?.name === "knowledge_fetch" &&
          fetched.success &&
          fetched.data.id === parentId
        ) {
          omissionTested = true;
          return {
            kind: "tool",
            name: "knowledge_save",
            args: {
              inputFingerprint: item.inputFingerprint,
              reviewedClaimIds: item.pendingClaimIds,
              node: {
                id: parentId,
                kind: "wiki",
                title: fetched.data.title,
                markdown: fetched.data.markdown,
                expectedRevision: fetched.data.revision,
                inputVersions: item.inputVersions,
              },
            },
          };
        }
        return maintain(
          ctx,
          steps.filter(
            (step) =>
              !(
                step.name === "knowledge_save" &&
                step.result &&
                typeof step.result === "object" &&
                "kind" in step.result &&
                step.result.kind === "error" &&
                "message" in step.result &&
                typeof step.result.message === "string" &&
                step.result.message.includes("placementAssessment")
              ),
          ),
        );
      },
    },
  });
  const reviews = (id: string) =>
    bench!.sql
      .prepare<
        [string],
        { count: number }
      >("SELECT count(*) AS count FROM knowledge_work WHERE subject_id=? AND reason='review' AND tier='soon' AND status='completed'")
      .get(id)!.count;
  await bench.push(
    email({
      externalId: "workshop-participation",
      title: "Workshop participation",
      content: "Workshop participants must register before joining a repair session.",
    }),
  );
  await bench.push(
    email({
      externalId: "equipment-calibration",
      title: "Equipment calibration",
      content: "The soldering stations require a calibration check before use.",
    }),
  );
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, "Workshop participation");
  await waitForComplementaryEvidence(bench, "Equipment calibration");
  for (const [externalId, title, content, id] of [
    [
      "program-placement",
      "Workshop program",
      "The community workshop runs a weekly repair session.",
      parentId,
    ],
    [
      "equipment-placement",
      "Equipment inventory",
      "The equipment inventory lists two soldering stations.",
      childId,
    ],
  ]) {
    await bench.push(email({ externalId: externalId!, title: title!, content: content! }));
    await expect.poll(() => reviews(id!), { timeout: 90_000 }).toBeGreaterThan(0);
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  }
  const before = [reviews(parentId), reviews(childId)];
  await bench.push(
    email({
      externalId: "workshop-hierarchy",
      title: "Workshop organization",
      content: "The equipment inventory is a section of the community workshop program.",
    }),
  );
  await expect
    .poll(() => [reviews(parentId), reviews(childId)], { timeout: 90_000 })
    .toEqual(before.map((count) => count + 1));
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(
    bench.sql
      .prepare("SELECT kind FROM knowledge_links WHERE from_id=? AND to_id=?")
      .get(childId, parentId),
  ).toEqual({ kind: "part_of" });
  const runs = bench.sql
    .prepare<
      [],
      { run_id: string }
    >("SELECT run_id FROM knowledge_batches WHERE status='completed'")
    .all();
  const tools = (await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))).flat();
  const errors = tools.filter((step) => step.result?.kind === "error");
  const placementErrors = errors.filter((step) => step.result?.code === "claim_invalid");
  expect(placementErrors).toHaveLength(1);
  expect(placementErrors[0]!.result).toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("placementAssessment"),
  });
  expect(
    errors
      .filter((step) => step.result?.code !== "claim_invalid")
      .every((step) => step.result?.code === "revision_conflict"),
  ).toBe(true);
  expect(tools.filter((step) => step.tool === "knowledge_link")).toHaveLength(1);
  for (const id of [parentId, childId]) {
    const latest = bench.sql
      .prepare<
        [string],
        { diff_json: string }
      >("SELECT diff_json FROM knowledge_revisions WHERE node_id=? ORDER BY revision DESC LIMIT 1")
      .get(id)!;
    expect(JSON.parse(latest.diff_json).placementAssessment.status).toBe("integrated");
  }
}, 300_000);
