// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
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
const pageId = "archive-cabinet-reference";

it("inherits unchanged dependency versions from a real editing read, reads new evidence, and refuses explicit stale overrides", async () => {
  let sourceId = "";
  let supportMarkup = "";
  const original = () =>
    `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>` +
    supportMarkup;
  const maintain = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source) {
        if (item.source.title === "Archive cabinet storage rules") return { calls: [] };
        const support = complementaryEvidence("Archive cabinet storage rules", steps);
        if (!support.evidence) return { calls: support.calls };
        supportMarkup = `<claim id="storage" refs="${support.evidence.ref}">${support.evidence.text}</claim>`;
        sourceId = item.source.id;
        return {
          calls: [
            ...support.calls,
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: pageId,
              title: "Archive cabinet reference",
              scope: "Cabinet labels and shelf organization",
              evidenceVersions: {
                [sourceId]: item.source.contentHash,
                [support.evidence.id]: support.evidence.revision,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              creationAssessment: {
                reason:
                  "The cabinet layout and storage restrictions form one reference topic not present in the inspected library.",
                relatedPageIds: [],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Archive cabinet reference",
                markdown: original(),
                expectedRevision: 0,
                inputVersions: {
                  [`source:${sourceId}`]: item.source.contentHash,
                  [support.evidence.ref]: support.evidence.revision,
                },
              },
            }),
          ],
        };
      }
      if (item.id === pageId) {
        const registered = steps.find((step) => step.name === "knowledge_evidence");
        const evidence = registered
          ? (structuredData(registered.result) as { ref?: string } | null)
          : null;
        const exactRef = evidence?.ref ?? "source:pending#evidence:pending";
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_evidence", {
              documentId: sourceId,
              contentHash: item.inputVersions[`source:${sourceId}`],
              quote: "Blue labels mark the upper shelf.",
            }),
            call("knowledge_reference", { ref: exactRef }),
            call("knowledge_save", {
              inputFingerprint: item.inputFingerprint,
              reviewedClaimIds: item.pendingClaimIds,
              placementAssessment: {
                status: "standalone",
                reason: "Self-contained cabinet reference without an existing broader topic page.",
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Archive cabinet reference",
                expectedRevision: item.node!.revision,
                markdown:
                  original() +
                  `<claim id="labels" refs="${exactRef}">Blue labels mark the upper shelf.</claim>`,
              },
            }),
          ],
        };
      }
      return preserveCurrentOwner(item, ctx, steps);
    },
    targets: () => [],
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
        const staleAttempts = steps.filter(
          (step) =>
            step.name === "knowledge_save" &&
            (step.args?.node as { inputVersions?: Record<string, string> } | undefined)
              ?.inputVersions?.[`source:${sourceId}`] === "stale",
        );
        const next = maintain(
          ctx,
          steps.filter((step) => !staleAttempts.includes(step)),
        );
        if (next?.kind === "tool" && next.name === "knowledge_save") {
          const args = next.args as {
            node: { id: string; expectedRevision: number; inputVersions?: Record<string, string> };
            inputFingerprint?: string;
          };
          if (args.node.id === pageId && args.node.expectedRevision > 0 && !staleAttempts.length)
            return {
              ...next,
              args: {
                ...args,
                node: { ...args.node, inputVersions: { [`source:${sourceId}`]: "stale" } },
              },
            };
        }
        return next;
      },
    },
  });
  await bench.pushAndSettle([
    email({
      externalId: "archive-cabinet-storage",
      title: "Archive cabinet storage rules",
      content: "Store only dry folders in the cabinet; liquids belong in the utility cupboard.",
    }),
  ]);
  await waitForComplementaryEvidence(bench, "Archive cabinet storage rules");
  await bench.push(
    email({
      externalId: "archive-cabinet-note",
      title: "Archive cabinet guide",
      content: "The cabinet has three shelves. Blue labels mark the upper shelf.",
    }),
  );
  await expect
    .poll(() => bench!.sql.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 90_000,
    })
    .toMatchObject({ revision: 2 });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const runs = bench.sql
    .prepare<
      [],
      { run_id: string }
    >("SELECT DISTINCT run_id FROM knowledge_batches WHERE run_id IS NOT NULL")
    .all();
  const executed = (
    await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))
  ).flat();
  const stale = executed.filter(
    (step) => step.tool === "knowledge_save" && step.result?.kind === "error",
  );
  expect(stale).toHaveLength(1);
  expect(stale[0]!.result).toMatchObject({
    code: "revision_conflict",
    message: expect.stringContaining("Stale dependency version"),
  });
  expect(
    executed.some(
      (step) => step.tool === "knowledge_reference" && step.result?.kind === "structured",
    ),
  ).toBe(true);
  const node = bench.sql
    .prepare<
      [string],
      { markdown: string; revision: number }
    >("SELECT markdown,revision FROM knowledge_nodes WHERE id=?")
    .get(pageId)!;
  expect(node.revision).toBe(2);
  expect(node.markdown).toContain(original());
  expect(node.markdown).toContain('id="labels"');
}, 180_000);
