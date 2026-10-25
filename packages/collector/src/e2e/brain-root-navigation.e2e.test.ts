// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { saveKnowledgeNode } from "../../../gateway/src/brain/knowledge/storage.js";
import { enqueueKnowledgeWork } from "../../../gateway/src/brain/knowledge/work.js";
import {
  BrainBench,
  structuredData,
  compressCognitionCadences,
  preserveCurrentOwner,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);

it("refuses silent root navigation loss, permits retained navigation, then deliberate removal", async () => {
  const wikiId = "wiki_observatory_handbook";
  let activeRoot = "";
  let remove = false;
  let recover = false;
  let sawRecoveryHint = false;
  const text = (linked: boolean) =>
    `<claim id="overview" refs="">Observatory reference material.${linked ? ` [Handbook](wiki:${wikiId})` : ""}</claim>`;
  const ordinary = knowledgePuppet({ plan: preserveCurrentOwner });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    brain: { bootstrap: { enabled: false }, knowledge: { routineDelay: "6h" } },
    behaviors: {
      dynamic(ctx, steps) {
        const frontierAt = steps.findLastIndex((step) => step.name === "knowledge_next_frontier");
        const data = frontierAt < 0 ? null : structuredData(steps[frontierAt]!.result);
        const frontier = z
          .object({
            items: z.array(
              z.object({
                id: z.string(),
                inputFingerprint: z.string(),
                pendingClaimIds: z.array(z.string()).optional(),
                node: z.object({ title: z.string(), revision: z.number() }).nullable().optional(),
                recoverableNavigation: z
                  .object({
                    candidates: z.array(
                      z.object({ id: z.string(), title: z.string(), revision: z.number() }),
                    ),
                    incomplete: z.boolean(),
                  })
                  .optional(),
              }),
            ),
          })
          .safeParse(data);
        const item = frontier.success
          ? frontier.data.items.find((item) => item.id === activeRoot)
          : undefined;
        if (!item?.node) return ordinary(ctx, steps);
        const node = item.node;
        if (recover) {
          const hint = item.recoverableNavigation?.candidates.find(
            (candidate) => candidate.id === wikiId,
          );
          if (!hint)
            return {
              kind: "final",
              text: "Expected current navigation candidate was not offered.",
            };
          sawRecoveryHint = true;
        }
        const since = steps.slice(frontierAt + 1);
        if (!since.some((step) => step.name === "knowledge_list"))
          return { kind: "tool", name: "knowledge_list", args: { kind: "wiki" } };
        if (!since.some((step) => step.name === "knowledge_fetch" && step.args?.id === wikiId))
          return { kind: "tool", name: "knowledge_fetch", args: { id: wikiId, editing: false } };
        const saves = since.filter((step) => step.name === "knowledge_save");
        const latest = saves.at(-1);
        if (
          latest &&
          z.object({ node: z.object({ id: z.string() }) }).safeParse(structuredData(latest.result))
            .success
        )
          return { kind: "tool", name: "knowledge_next_frontier", args: {} };
        if (
          latest &&
          !z
            .object({
              kind: z.literal("error"),
              code: z.literal("claim_invalid"),
              message: z.string().includes("navigationRemovals"),
            })
            .safeParse(latest.result).success
        )
          return { kind: "final", text: "Unexpected refusal; preserve pending work." };
        if (saves.length > 1)
          return { kind: "final", text: "Scripted repair was refused; preserve pending work." };
        return {
          kind: "tool",
          name: "knowledge_save",
          args: {
            inputFingerprint: item.inputFingerprint,
            reviewedClaimIds: item.pendingClaimIds,
            node: {
              id: item.id,
              kind: "root",
              title: node.title,
              expectedRevision: node.revision,
              markdown: text(recover || (saves.length === 1 && !remove)),
              ...(saves.length === 1 && remove
                ? {
                    navigationRemovals: [
                      {
                        targetId: wikiId,
                        reason:
                          "This compact orientation no longer includes the reference section.",
                      },
                    ],
                  }
                : {}),
            },
          },
        };
      },
    },
  });
  const root = () =>
    bench!.sql
      .prepare("SELECT id,revision,markdown FROM knowledge_nodes WHERE kind='root'")
      .get() as { id: string; revision: number; markdown: string } | undefined;
  await expect.poll(root, { timeout: 15_000 }).toBeDefined();
  await bench.drainUntilQuiet();
  activeRoot = root()!.id;
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        saveKnowledgeNode(
          db,
          {
            id: wikiId,
            kind: "wiki",
            title: "Observatory handbook",
            expectedRevision: 0,
            markdown: '<claim id="scope" refs="">Observatory reference material.</claim>',
            inputVersions: {},
          },
          Date.now(),
        );
        const revision = (
          db.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(activeRoot) as {
            revision: number;
          }
        ).revision;
        saveKnowledgeNode(
          db,
          {
            id: activeRoot,
            kind: "root",
            title: "Current orientation",
            expectedRevision: revision,
            markdown: text(true),
            inputVersions: {},
          },
          Date.now(),
        );
      })
      .immediate(),
  );
  const enqueue = (id: string) =>
    bench!.withWriteHandle((db) =>
      db
        .transaction(() => {
          const node = db
            .prepare("SELECT revision FROM knowledge_nodes WHERE id=?")
            .get(activeRoot) as { revision: number };
          enqueueKnowledgeWork(
            db,
            {
              id,
              subjectId: activeRoot,
              subjectKind: "node",
              reason: "root",
              inputRevision: String(node.revision),
              tier: "immediate",
              dueAt: Date.now(),
            },
            Date.now(),
          );
        })
        .immediate(),
    );
  const settled = (id: string) =>
    (
      bench!.sql.prepare("SELECT status FROM knowledge_work WHERE id=?").get(id) as
        | { status: string }
        | undefined
    )?.status;
  enqueue("root-navigation-retain");
  await expect.poll(() => settled("root-navigation-retain"), { timeout: 45_000 }).toBe("completed");
  expect(root()!.markdown).toContain(`wiki:${wikiId}`);
  remove = true;
  enqueue("root-navigation-remove");
  await expect.poll(() => settled("root-navigation-remove"), { timeout: 45_000 }).toBe("completed");
  expect(root()!.markdown).not.toContain(`wiki:${wikiId}`);
  // An intentional omission stays omitted until a later explicit current-page investigation.
  recover = true;
  remove = false;
  enqueue("root-navigation-recover");
  await expect
    .poll(() => settled("root-navigation-recover"), { timeout: 45_000 })
    .toBe("completed");
  expect(sawRecoveryHint).toBe(true);
  expect(root()!.markdown).toContain(`wiki:${wikiId}`);
  const runs = await bench.obs.runs({ limit: 50 });
  const tools = (
    await Promise.all(runs.items.map((run) => bench!.obs.executedTools(run.id)))
  ).flat();
  const refusals = tools.filter(
    (step) =>
      step.tool === "knowledge_save" && JSON.stringify(step.result).includes("navigationRemovals"),
  );
  expect(refusals.length).toBeGreaterThanOrEqual(2);
  for (const refusal of refusals)
    expect(refusal.result).toMatchObject({ kind: "error", code: "claim_invalid" });
  const acceptedSaves = tools.filter(
    (step) =>
      step.tool === "knowledge_save" &&
      z
        .object({
          node: z.object({
            id: z.literal(activeRoot),
            markdown: z.string().includes('<claim id="overview"'),
          }),
        })
        .safeParse(structuredData(step.result)).success,
  );
  expect(acceptedSaves.length).toBeGreaterThanOrEqual(3);
  for (const saved of acceptedSaves) {
    const data = structuredData(saved.result)!;
    expect(data).toMatchObject({
      verificationSummary: {
        status: "available",
        acceptedRevision: z.object({ revision: z.number() }).parse(data.node).revision,
        claims: [{ id: "overview", storedVerification: "unverified" }],
        truncated: false,
      },
    });
  }
  expect(tools.some((step) => step.tool === "knowledge_history")).toBe(false);
}, 120_000);
