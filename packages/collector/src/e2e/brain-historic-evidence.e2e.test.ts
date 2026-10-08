// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { BrainBench, call, compressCognitionCadences, email } from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { structuredData, type ToolStep } from "./brain-bench/puppet-plan.js";

import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";

compressCognitionCadences();
const archived = email({
  externalId: "historic-equipment",
  title: "Archived equipment instructions",
  content: "Disconnect the training console before replacing its removable cover.",
  at: Date.parse("1999-04-03T10:00:00Z"),
});
const promise = email({
  externalId: "current-console-promise",
  title: "Current console commitment",
  content: "I will collect the training console.",
  ageDays: 2,
});
const cancellation = email({
  externalId: "current-console-cancellation",
  title: "Current console cancellation",
  content: "The console collection is cancelled. No collection is required.",
  ageDays: 1,
});
const olderPromise = email({
  externalId: "historic-console-promise",
  title: "Earlier console promise",
  content: "I will collect the training console. This is the earlier promise.",
  at: Date.parse("1998-02-01T09:00:00Z"),
});
const equipment = email({
  externalId: "console-storage-reference",
  title: "Training console storage instructions",
  content: "Keep the training console in its padded case during transport and storage.",
  at: Date.parse("1999-04-02T10:00:00Z"),
});
const project = email({
  externalId: "console-project-scope",
  title: "Training console project scope",
  content: "The training console is allocated to the workshop demonstration project.",
});
const supportFor = (page: string) => (page === "historic-instructions" ? equipment : project);
const supportMarkup = (page: string) => {
  const document = supportFor(page);
  const source = evidence.get(document.title)!;
  return `<claim id="scope" refs="source:${source.id}">${document.content}</claim>`;
};
const loopTitle = "Collect the training console";
let bench: BrainBench;
const evidence = new Map<string, { id: string; revision: string }>();
function last(steps: readonly ToolStep[], name: string, key: string, value: string) {
  const step = [...steps]
    .reverse()
    .find((entry) => entry.name === name && entry.args?.[key] === value);
  return step ? structuredData(step.result) : undefined;
}
function content(page: string) {
  if (page === "historic-instructions") {
    const source = evidence.get(archived.title)!;
    return (
      `<claim id="procedure" refs="source:${source.id}">${archived.content}</claim>` +
      supportMarkup(page)
    );
  }
  const cancelled = evidence.get(cancellation.title);
  const current = cancelled ?? evidence.get(promise.title)!;
  const old = evidence.get(olderPromise.title);
  return (
    `<claim id="status" refs="source:${current.id}">${cancelled ? cancellation.content : promise.content}</claim>` +
    supportMarkup(page) +
    (old
      ? `\n<claim id="earlier" refs="source:${old.id}">An earlier promise preceded the cancellation.</claim>`
      : "")
  );
}
function versions() {
  return Object.fromEntries(
    [...evidence.values()].map((source) => [`source:${source.id}`, source.revision]),
  );
}

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
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
        targets: (item) =>
          item.source && item.source.title !== archived.title && evidence.has(promise.title)
            ? ["console-project"]
            : [],
        plan(item, _ctx, steps) {
          if (item.source) {
            if ([equipment.title, project.title].includes(item.source.title)) return { calls: [] };
            const page =
              item.source.title === archived.title ? "historic-instructions" : "console-project";
            const support = complementaryEvidence(supportFor(page).title, steps);
            if (!support.evidence) return { calls: support.calls };
            evidence.set(supportFor(page).title, {
              id: support.evidence.id,
              revision: support.evidence.revision,
            });
            evidence.set(item.source.title, {
              id: item.source.id,
              revision: item.source.contentHash,
            });
            const calls = [
              ...support.calls,
              call("knowledge_list", { kind: "wiki" }),
              call("knowledge_candidates", {}),
            ];
            if (item.source.title === promise.title)
              calls.push(
                call("open_loop_search", { query: loopTitle }),
                call("open_loop_create", {
                  title: loopTitle,
                  description: promise.content,
                  confidence: 0.9,
                  importance: 0.7,
                  docs: [item.source.id],
                }),
              );
            if (item.source.title === cancellation.title) {
              calls.push(call("open_loop_search", { query: loopTitle }));
              const found = z
                .object({ loops: z.array(z.object({ id: z.string(), title: z.string() })) })
                .safeParse(last(steps, "open_loop_search", "query", loopTitle));
              const loop = found.success
                ? found.data.loops.find((loop) => loop.title === loopTitle)
                : undefined;
              if (loop)
                calls.push(
                  call("open_loop_update", {
                    id: loop.id,
                    state: "dismissed",
                    description: cancellation.content,
                    docs: [item.source.id],
                  }),
                );
            }
            calls.push(call("knowledge_fetch", { id: page, editing: true }));
            if (last(steps, "knowledge_fetch", "id", page) !== null) return { calls };
            calls.push(
              call("knowledge_propose_page", {
                identityKey: page,
                title: page,
                scope: "Durable invented equipment context",
                evidenceVersions: {
                  [item.source.id]: item.source.contentHash,
                  [support.evidence.id]: support.evidence.revision,
                },
              }),
            );
            const candidate = z
              .object({ id: z.string() })
              .safeParse(last(steps, "knowledge_propose_page", "identityKey", page));
            if (candidate.success)
              calls.push(
                call("knowledge_save", {
                  candidateId: candidate.data.id,
                  creationAssessment: {
                    reason:
                      "This page combines complementary equipment evidence within a distinct procedural or project scope; existing pages do not cover that scope.",
                    relatedPageIds: [],
                  },
                  node: {
                    id: page,
                    kind: "wiki",
                    title: page,
                    markdown: content(page),
                    expectedRevision: 0,
                    inputVersions: versions(),
                  },
                }),
              );
            return { calls };
          }
          const node = item.node!;
          const custom = node.id === "historic-instructions" || node.id === "console-project";
          return {
            calls: [
              ...(custom ? [call("knowledge_list", { kind: "wiki" })] : []),
              call("knowledge_save", {
                inputFingerprint: item.inputFingerprint,
                ...(custom
                  ? {
                      placementAssessment: {
                        status: "standalone",
                        reason:
                          "Archived instructions and the current equipment project have distinct scopes; neither is a parent of the other.",
                      },
                    }
                  : {}),
                node: {
                  id: node.id,
                  kind: node.kind,
                  ...(node.ownerId ? { ownerId: node.ownerId } : {}),
                  title: node.title,
                  markdown: custom ? content(node.id) : node.markdown,
                  expectedRevision: node.revision,
                  inputVersions: custom
                    ? versions()
                    : Object.fromEntries(
                        Object.entries(item.inputVersions).filter(([ref]) =>
                          /^(source|wiki|loop|annotation|brief):/.test(ref),
                        ),
                      ),
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

it("publishes useful old evidence without manufacturing a future timestamp", async () => {
  await bench.pushAndSettle([equipment, project]);
  await waitForComplementaryEvidence(bench, equipment.title);
  await waitForComplementaryEvidence(bench, project.title);
  const [id] = await bench.pushAndSettle([archived]);
  const stored = bench.sql
    .prepare<
      [string],
      { source_created_at: string }
    >("SELECT source_created_at FROM documents WHERE id=?")
    .get(id!)!;
  expect(stored.source_created_at).toBe("1999-04-03T10:00:00.000Z");
  const page = await bench.harness.gatewayJson<{ plainText: string; validity: string }>(
    "/admin/brain/knowledge/historic-instructions",
  );
  expect(page).toMatchObject({
    plainText: expect.stringContaining(archived.content),
    validity: "current",
  });
  expect(page.plainText).toContain(equipment.content);
  expect(
    bench.sql
      .prepare(
        "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'",
      )
      .get(id),
  ).toMatchObject({ status: "considered" });
}, 180_000);

it("keeps a recent cancellation authoritative after an older promise arrives", async () => {
  await bench.pushAndSettle([promise]);
  await bench.pushAndSettle([cancellation]);
  const before = bench.sql.prepare("SELECT id,state FROM open_loops WHERE title=?").get(loopTitle);
  expect(before).toMatchObject({ state: "dismissed" });
  const [oldId] = await bench.pushAndSettle([olderPromise]);
  expect(bench.sql.prepare("SELECT id,state FROM open_loops WHERE title=?").all(loopTitle)).toEqual(
    [before],
  );
  const page = await bench.harness.gatewayJson<{ plainText: string; validity: string }>(
    "/admin/brain/knowledge/console-project",
  );
  expect(page.validity).toBe("current");
  expect(page.plainText).toContain("collection is cancelled");
  expect(page.plainText).toContain("earlier promise preceded the cancellation");
  expect(
    bench.sql
      .prepare(
        "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'",
      )
      .get(oldId),
  ).toMatchObject({ status: "considered" });
}, 180_000);
