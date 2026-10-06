// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { call, structuredData, type PuppetPlan, type ToolStep } from "./puppet-plan.js";
import type { PuppetKnowledgeItem } from "./knowledge-puppet.js";

export const DEMO_LOOPS = {
  setup: "Attend winter lantern setup",
  crate: "Collect the reserved lantern crate",
  camera: "Receive the borrowed silver camera",
};
const loopSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    state: z.string(),
    docs: z.array(z.string()).optional(),
  })
  .passthrough();
function read(steps: readonly ToolStep[], name: string, key: string, value: string) {
  const found = [...steps]
    .reverse()
    .find((step) => step.name === name && step.args?.[key] === value);
  return found ? structuredData(found.result) : null;
}

export function nextGenLoopCalls(
  item: PuppetKnowledgeItem,
  steps: readonly ToolStep[],
): PuppetPlan["calls"] {
  const source = item.source!;
  const relevant: Array<keyof typeof DEMO_LOOPS> = /Household coordination/.test(source.title)
    ? ["crate", "camera"]
    : /Camera|camera/.test(source.title)
      ? ["camera"]
      : /accepted plan|correction|crate collected/.test(source.title)
        ? ["setup", "crate"]
        : [];
  const calls: PuppetPlan["calls"] = [];
  for (const key of relevant) {
    const title = DEMO_LOOPS[key];
    calls.push(call("open_loop_search", { query: title }));
    const found = z
      .object({ loops: z.array(loopSchema) })
      .safeParse(read(steps, "open_loop_search", "query", title));
    if (!found.success) continue;
    const existing = found.data.loops.find((loop) => loop.title === title);
    const initiallyAccepted = /accepted plan|Camera loan continuation/.test(source.title);
    if (!existing && initiallyAccepted) {
      calls.push(
        call("open_loop_create", {
          title,
          description: source.content,
          confidence: 0.9,
          importance: 0.7,
          docs: [source.id],
        }),
      );
    } else if (existing) {
      const completed =
        key === "camera"
          ? /returned|loan is complete/.test(source.content)
          : key === "crate" &&
            /I collected|has been collected|collection is complete/.test(source.content);
      calls.push(
        call("open_loop_update", {
          id: existing.id,
          ...(completed ? { state: "done" } : {}),
          description: completed
            ? `${title}: confirmed complete in the cited evidence.`
            : source.content,
          docs: [...new Set([...(existing.docs ?? []), source.id])],
        }),
      );
    }
  }
  return calls;
}

/** Legacy-owner conversion deliberately preserves context as context, without invented proof. */
export function nextGenOwnerPlan(
  item: PuppetKnowledgeItem,
  steps: readonly ToolStep[],
): PuppetPlan {
  const node = item.node!;
  const refs = [
    ...new Set(
      [...node.markdown.matchAll(/source:([^\s"#]+)/g)].map((match) => `source:${match[1]!}`),
    ),
  ].sort();
  const calls: PuppetPlan["calls"] = refs.map((ref) => call("knowledge_reference", { ref }));
  const versions: Record<string, string | number> = {};
  for (const ref of refs) {
    const view = z
      .object({ revision: z.union([z.string(), z.number()]) })
      .safeParse(read(steps, "knowledge_reference", "ref", ref));
    if (view.success) versions[ref] = view.data.revision;
  }
  const pageId = node.title === DEMO_LOOPS.camera ? "demo-camera" : "demo-gathering";
  calls.push(call("knowledge_fetch", { id: pageId }));
  const page = z
    .object({ revision: z.number() })
    .safeParse(read(steps, "knowledge_fetch", "id", pageId));
  if (page.success)
    calls.push(
      call("knowledge_link", {
        fromId: node.id,
        toId: pageId,
        kind: "belongs_to_project",
        fromRevision: node.revision,
        toRevision: page.data.revision,
      }),
    );
  if (Object.keys(versions).length === refs.length) {
    const text = node.markdown.replace(/<\/?claim\b[^>]*>/g, "");
    calls.push(
      call("knowledge_save", {
        inputFingerprint: item.inputFingerprint,
        node: {
          id: node.id,
          ownerId: node.ownerId,
          kind: node.kind,
          title: node.title,
          expectedRevision: node.revision,
          markdown: refs.length
            ? `<claim id="legacy" refs="${refs.join(" ")}">${text}</claim>`
            : text,
          inputVersions: versions,
          claims: refs.length
            ? [{ id: "legacy", relations: Object.fromEntries(refs.map((ref) => [ref, "context"])) }]
            : [],
        },
      }),
    );
  }
  return { calls };
}
