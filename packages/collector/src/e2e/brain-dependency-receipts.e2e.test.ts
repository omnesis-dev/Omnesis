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
const inventoryTitle = "Archive cabinet inventory";

it("inherits unchanged dependency versions from a real editing read, reads new evidence, and refuses explicit stale overrides", async () => {
  let sourceId = "";
  let sourceContentHash = "";
  let supportRef = "";
  let fullSourceAttemptExercised = false;
  let inventoryRef = "";
  let supportMarkup = "";
  let staleOverrideExercised = false;
  let fingerprintTypoExercised = false;
  const original = () =>
    `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>` +
    supportMarkup;
  const maintain = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source) {
        if (
          item.source.title === "Archive cabinet storage rules" ||
          item.source.title === inventoryTitle
        )
          return { calls: [] };
        const support = complementaryEvidence("Archive cabinet storage rules", steps);
        if (!support.evidence) return { calls: support.calls };
        supportMarkup = `<claim id="storage" refs="${support.evidence.ref}">${support.evidence.text}</claim>`;
        sourceId = item.source.id;
        sourceContentHash = item.source.contentHash;
        supportRef = support.evidence.ref;
        const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
        const libraryRead = steps
          .slice(frontierAt + 1)
          .find((step) => step.name === "knowledge_list");
        const library = libraryRead ? structuredData(libraryRead.result) : null;
        const prefix = [...support.calls, call("knowledge_list", { kind: "wiki" })];
        if (
          Array.isArray(library) &&
          library.some(
            (node) => node && typeof node === "object" && (node as { id?: string }).id === pageId,
          )
        )
          return { calls: prefix };
        return {
          calls: [
            ...prefix,
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
              contentHash: sourceContentHash,
              quote: "Blue labels mark the upper shelf.",
            }),
            call("knowledge_reference", {
              refs: [supportRef, supportRef, "source:missing-fixture"],
            }),
            call("knowledge_fetch", { id: pageId, editing: true }),
            call("knowledge_save", {
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
        const typoAttempts = steps.filter(
          (step) =>
            step.name === "knowledge_save" && step.args?.inputFingerprint === "mistyped-offer",
        );
        const staleAttempts = steps.filter(
          (step) =>
            step.name === "knowledge_save" &&
            (step.args?.node as { inputVersions?: Record<string, string> } | undefined)
              ?.inputVersions?.[`source:${sourceId}`] === "stale",
        );
        const fullSourceAttempts = steps.filter(
          (step) =>
            step.name === "knowledge_save" &&
            (step.args?.node as { markdown?: string } | undefined)?.markdown?.includes(
              `<claim id="labels" refs="source:${sourceId}">`,
            ),
        );
        const next = maintain(
          ctx,
          steps.filter(
            (step) =>
              !staleAttempts.includes(step) &&
              !fullSourceAttempts.includes(step) &&
              !typoAttempts.includes(step),
          ),
        );
        if (next?.kind === "tool" && next.name === "knowledge_save") {
          const args = next.args as {
            node: {
              id: string;
              markdown: string;
              expectedRevision: number;
              inputVersions?: Record<string, string>;
            };
            inputFingerprint?: string;
          };
          if (
            args.node.id === pageId &&
            args.node.expectedRevision > 0 &&
            !fingerprintTypoExercised
          ) {
            fingerprintTypoExercised = true;
            return { ...next, args: { ...args, inputFingerprint: "mistyped-offer" } };
          }
          if (
            args.node.id === pageId &&
            args.node.expectedRevision > 0 &&
            !fullSourceAttemptExercised
          ) {
            fullSourceAttemptExercised = true;
            // Cite two sources this run has not read: the save is refused once, naming both.
            inventoryRef = `source:${
              bench!.sql
                .prepare<[string], { id: string }>("SELECT id FROM documents WHERE title=?")
                .get(inventoryTitle)!.id
            }`;
            return {
              ...next,
              args: {
                ...args,
                node: {
                  ...args.node,
                  markdown:
                    original() +
                    `<claim id="labels" refs="source:${sourceId} ${inventoryRef}">Blue labels mark the upper shelf.</claim>`,
                },
              },
            };
          }
          if (
            args.node.id === pageId &&
            args.node.expectedRevision > 0 &&
            !staleOverrideExercised &&
            !staleAttempts.length
          ) {
            staleOverrideExercised = true;
            return {
              ...next,
              args: {
                ...args,
                node: { ...args.node, inputVersions: { [`source:${sourceId}`]: "stale" } },
              },
            };
          }
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
    email({
      externalId: "archive-cabinet-inventory",
      title: inventoryTitle,
      content: "The cabinet holds twelve folders of project correspondence.",
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
    .prepare<[], { run_id: string }>(
      "SELECT DISTINCT run_id FROM knowledge_batches WHERE run_id IS NOT NULL",
    )
    .all();
  const executed = (
    await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))
  ).flat();
  const stale = executed.filter(
    (step) => step.tool === "knowledge_save" && step.result?.kind === "error",
  );
  // The refused attempts can span runs, whose listing order is not fixed.
  const refusals = stale.map((step) => step.result as { code?: string; message?: string });
  expect(refusals).toHaveLength(3);
  for (const refusal of refusals) expect(refusal.code).toBe("revision_conflict");
  const refusal = (marker: string) => {
    const matching = refusals.filter((entry) => entry.message?.includes(marker));
    expect(matching, marker).toHaveLength(1);
    return matching[0]!.message!;
  };
  expect(refusal("Frontier item is no longer current")).toBe("Frontier item is no longer current");
  // One refusal names every unread source and the single call that reads them.
  const missing = [`source:${sourceId}`, inventoryRef];
  const missingRefusal = refusal("Missing dependency version");
  expect(missingRefusal).toContain(
    `Missing dependency version for ${missing.map((r) => JSON.stringify(r)).join(", ")} (not read in this run and no inputVersions entry).`,
  );
  expect(missingRefusal).toContain(
    `in one call: knowledge_reference ${JSON.stringify({ refs: missing })}.`,
  );
  expect(refusal("Stale dependency version")).toContain(
    `Stale dependency version for ${JSON.stringify(`source:${sourceId}`)}`,
  );
  const batchReads = executed.filter(
    (step) => step.tool === "knowledge_reference" && step.result?.kind === "structured",
  );
  expect(batchReads.length).toBeGreaterThan(0);
  expect(
    batchReads.some((step) => {
      const data = step.result?.data as { items?: Array<{ ok: boolean }> } | undefined;
      return data?.items?.length === 2 && data.items[0]?.ok === true && data.items[1]?.ok === false;
    }),
  ).toBe(true);
  const registrations = executed.filter((step) => step.tool === "knowledge_evidence");
  expect(registrations.length).toBeGreaterThan(0);
  for (const registration of registrations) {
    const selected = registration.result?.data as { ref: string; revision: string };
    expect(selected.ref).toContain("#evidence:");
    expect(selected.revision).toBeTruthy();
    expect(
      batchReads.some((step) => JSON.stringify(step.result?.data).includes(selected.ref)),
    ).toBe(false);
  }
  const node = bench.sql
    .prepare<[string], { markdown: string; revision: number }>(
      "SELECT markdown,revision FROM knowledge_nodes WHERE id=?",
    )
    .get(pageId)!;
  // The substantive edit must remain the second meaning revision. A later
  // background review may record a proof-only revision during drain; it must
  // not change the saved page or turn the rejected override into another edit.
  const meaning = bench.sql
    .prepare("SELECT meaning_revision FROM knowledge_nodes WHERE id=?")
    .get(pageId) as { meaning_revision: number };
  expect(meaning.meaning_revision).toBe(2);
  const revisions = bench.sql
    .prepare<[string], { revision: number; title: string; markdown: string; fields_json: string }>(
      "SELECT revision,title,markdown,fields_json FROM knowledge_revisions WHERE node_id=? AND revision>=2 ORDER BY revision",
    )
    .all(pageId);
  expect(revisions[0]!.revision).toBe(2);
  expect(revisions.at(-1)!.revision).toBe(node.revision);
  const { revision: _revision, ...editedPage } = revisions[0]!;
  for (const revision of revisions) {
    const { revision: _number, ...content } = revision;
    expect(content).toEqual(editedPage);
  }
  expect(node.markdown).toContain(original());
  expect(node.markdown).toContain('id="labels"');
}, 180_000);
