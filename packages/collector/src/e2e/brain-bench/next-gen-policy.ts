// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Scripted judgements for the fictional progressive universe; all writes use real tools. */
import { z } from "zod";
import { call, structuredData, type PuppetPlan, type ToolStep } from "./puppet-plan.js";
import { type KnowledgePuppetPolicy, type PuppetKnowledgeItem } from "./knowledge-puppet.js";
import { nextGenLoopCalls, nextGenOwnerPlan } from "./next-gen-loops.js";
import type { DecisionPolicy } from "./decision-server.js";

const pageSchema = z
  .object({
    id: z.string(),
    revision: z.number(),
    meaningRevision: z.number(),
    title: z.string(),
    markdown: z.string(),
    kind: z.string(),
  })
  .passthrough();
const evidenceSchema = z.object({ ref: z.string(), contentHash: z.string() }).passthrough();
const referenceSchema = z.object({
  ref: z.string(),
  revision: z.union([z.string(), z.number()]),
  text: z.string(),
});
type Topic = "gathering" | "camera" | "access";
const pageId = (topic: Topic) => `demo-${topic}`;
const titles: Record<Topic, string> = {
  gathering: "Winter lantern gathering",
  camera: "Camera loan",
  access: "Temporary gathering access",
};
function topics(title: string): Topic[] {
  if (/access instruction/.test(title)) return ["access"];
  if (/Household coordination/.test(title)) return ["gathering", "camera"];
  if (/Camera|camera/.test(title)) return ["camera"];
  if (/lantern|Lantern|setup|Setup/.test(title)) return ["gathering"];
  return [];
}
function result(steps: readonly ToolStep[], name: string, predicate: (step: ToolStep) => boolean) {
  const step = [...steps].reverse().find((entry) => entry.name === name && predicate(entry));
  return step ? structuredData(step.result) : undefined;
}
function localSteps(steps: readonly ToolStep[], item: PuppetKnowledgeItem): readonly ToolStep[] {
  let at = steps.length - 1;
  while (at >= 0 && steps[at]?.name !== "knowledge_next_frontier") at--;
  // Within a frontier, use the latest matching read, keyed by ID, never global call ordinals.
  return steps
    .slice(at + 1)
    .filter((step) => step.args?.id !== item.id || step.name !== "knowledge_discovery_complete");
}
function claim(text: string, refs: string[]) {
  return `<claim id="summary" refs="${refs.join(" ")}">${text}</claim>`;
}
function summarize(topic: Topic, texts: string[]): string {
  const content = texts.join("\n");
  if (topic === "access") return texts.join("\n");
  if (topic === "camera")
    return /returned|return is complete|loan is complete/i.test(content)
      ? "The silver camera has been returned; the loan is complete."
      : "The silver camera is on loan and is due to be returned on Saturday.";
  const corrected = /08:00/.test(content);
  const collected = /I collected|has been collected|collection is complete/.test(content);
  return [
    /08:00|10:00/.test(content)
      ? `Gathering setup is ${corrected ? "08:00" : "10:00"} tomorrow.`
      : "",
    /18:15/.test(content) ? "Guest arrival is 18:15." : "",
    collected
      ? "The lantern crate has been collected."
      : "Collecting the lantern crate remains a separate commitment.",
    /09:00.*not checked/.test(content) && !/guest suggestion of 09:00 was mistaken/.test(content)
      ? "An unconfirmed guest suggestion conflicts with the organiser's accepted time."
      : "",
    /early proposal/.test(content)
      ? "The earlier tentative proposal is historical context, not the accepted schedule."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function summaryMarkup(topic: Topic, evidence: Array<{ text: string; ref: string }>): string {
  let text = summarize(
    topic,
    evidence.map((entry) => entry.text),
  );
  // The arrival detail retains its own support and identity when setup changes.
  const arrival = evidence.find((entry) => entry.text.includes("Guest arrival is 18:15"));
  if (topic === "gathering" && arrival)
    text = text.replace(
      "Guest arrival is 18:15.",
      `<claim id="guest-arrival" refs="${arrival.ref}">Guest arrival is 18:15.</claim>`,
    );
  return claim(
    text,
    evidence.map((entry) => entry.ref),
  );
}

function sourcePlan(item: PuppetKnowledgeItem, steps: readonly ToolStep[]): PuppetPlan {
  const source = item.source!;
  const selected = topics(source.title);
  const calls: PuppetPlan["calls"] = [
    call("fetch_many", { documents: [{ documentId: source.id }] }),
    ...nextGenLoopCalls(item, steps),
    call("knowledge_list", { kind: "wiki" }),
    call("knowledge_candidates", {}),
  ];
  for (const topic of selected) {
    const id = pageId(topic);
    calls.push(call("knowledge_fetch", { id, editing: true }));
    const existing = result(steps, "knowledge_fetch", (step) => step.args?.id === id);
    if (existing !== null) continue;
    calls.push(
      call("knowledge_propose_page", {
        identityKey: `progressive-demo:${topic}`,
        title: titles[topic],
        scope: `Reusable context for ${titles[topic]}`,
        evidenceVersions: { [source.id]: source.contentHash },
      }),
    );
    calls.push(
      call("knowledge_evidence", {
        documentId: source.id,
        contentHash: source.contentHash,
        quote: source.content,
      }),
    );
    const candidate = z
      .object({ id: z.string(), status: z.string() })
      .safeParse(
        result(
          steps,
          "knowledge_propose_page",
          (step) => step.args?.identityKey === `progressive-demo:${topic}`,
        ),
      );
    const evidence = evidenceSchema.safeParse(
      result(steps, "knowledge_evidence", (step) => step.args?.documentId === source.id),
    );
    if (!candidate.success || !evidence.success || candidate.data.status !== "proposed") continue;
    calls.push(
      call("knowledge_save", {
        candidateId: candidate.data.id,
        node: {
          id,
          kind: "wiki",
          title: titles[topic],
          expectedRevision: 0,
          markdown: summaryMarkup(topic, [{ text: source.content, ref: evidence.data.ref }]),
          inputVersions: { [evidence.data.ref]: source.contentHash },
          metadata: { importance: topic === "access" ? 0.1 : 0.8 },
        },
      }),
    );
  }
  return { calls };
}

function nodePlan(item: PuppetKnowledgeItem, steps: readonly ToolStep[]): PuppetPlan {
  const node = item.node!;
  if (["loop", "doc_annotation", "person_annotation", "brief"].includes(node.kind))
    return nextGenOwnerPlan(item, localSteps(steps, item));
  if (node.kind === "root") {
    const orientation = z
      .array(pageSchema)
      .parse(item.orientation ?? [])
      .filter((entry) => entry.kind === "wiki" && entry.id !== pageId("access"));
    const calls = orientation.map((entry) =>
      call("knowledge_reference", { ref: `wiki:${entry.id}#claim:summary` }),
    );
    const views = orientation.flatMap((entry) => {
      const parsed = referenceSchema.safeParse(
        result(
          localSteps(steps, item),
          "knowledge_reference",
          (step) => step.args?.ref === `wiki:${entry.id}#claim:summary`,
        ),
      );
      return parsed.success ? [parsed.data] : [];
    });
    if (views.length === orientation.length)
      calls.push(
        call("knowledge_save", {
          inputFingerprint: item.inputFingerprint,
          node: {
            id: node.id,
            kind: "root",
            title: node.title,
            expectedRevision: node.revision,
            markdown: views.length
              ? claim(
                  views.map((view) => view.text).join("\n"),
                  views.map((view) => view.ref),
                )
              : "",
            inputVersions: Object.fromEntries(views.map((view) => [view.ref, view.revision])),
          },
        }),
      );
    return { calls };
  }
  const topic = (Object.keys(titles) as Topic[]).find((key) => pageId(key) === node.id);
  if (!topic) return { calls: [] };
  const sourceIds = new Set(
    [...node.markdown.matchAll(/source:([^\s"#]+)/g)].map((match) => match[1]!),
  );
  const local = localSteps(steps, item);
  const calls: PuppetPlan["calls"] = [];
  const inputVersions = { ...item.inputVersions };
  if (item.inputVersionsOmitted) {
    let after: string | undefined;
    for (;;) {
      calls.push(
        call("knowledge_maintenance_inputs", { id: item.id, ...(after ? { after } : {}) }),
      );
      const page = z
        .object({
          inputFingerprint: z.string(),
          inputVersions: z.record(z.string(), z.union([z.string(), z.number()])),
          nextAfter: z.string().optional(),
        })
        .safeParse(
          result(
            local,
            "knowledge_maintenance_inputs",
            (step) => step.args?.id === item.id && step.args?.after === after,
          ),
        );
      if (!page.success || page.data.inputFingerprint !== item.inputFingerprint) return { calls };
      Object.assign(inputVersions, page.data.inputVersions);
      if (!page.data.nextAfter) break;
      if (after && page.data.nextAfter <= after) return { calls };
      after = page.data.nextAfter;
    }
  }
  // Source selections survive paid run continuation in the offered input context.
  // They are read and grounded below, never treated as evidence by themselves.
  for (const ref of Object.keys(inputVersions))
    if (ref.startsWith("source:")) sourceIds.add(ref.slice(7).split("#")[0]!);
  const views: z.infer<typeof referenceSchema>[] = [];
  const evidence: z.infer<typeof evidenceSchema>[] = [];
  for (const id of [...sourceIds].sort()) {
    calls.push(call("knowledge_reference", { ref: `source:${id}` }));
    const view = referenceSchema.safeParse(
      result(local, "knowledge_reference", (step) => step.args?.ref === `source:${id}`),
    );
    if (!view.success) continue;
    views.push(view.data);
    calls.push(
      call("knowledge_evidence", {
        documentId: id,
        contentHash: view.data.revision,
        quote: view.data.text,
      }),
    );
    const passage = evidenceSchema.safeParse(
      result(local, "knowledge_evidence", (step) => step.args?.documentId === id),
    );
    if (passage.success) evidence.push(passage.data);
  }
  if (views.length === sourceIds.size && evidence.length === sourceIds.size)
    calls.push(
      call("knowledge_list", { kind: "wiki" }),
      call("knowledge_save", {
        inputFingerprint: item.inputFingerprint,
        placementAssessment: {
          status: "standalone",
          reason:
            "This scripted topic retains its own scope; shared source context alone does not establish a parent relationship.",
        },
        node: {
          id: node.id,
          kind: "wiki",
          title: node.title,
          expectedRevision: node.revision,
          markdown: summaryMarkup(
            topic,
            evidence.map((entry, index) => ({ ref: entry.ref, text: views[index]!.text })),
          ),
          inputVersions: Object.fromEntries(
            evidence.map((entry) => [entry.ref, entry.contentHash]),
          ),
        },
      }),
    );
  return { calls };
}

export const nextGenPolicy: KnowledgePuppetPolicy = {
  maxRevisionConflictRetries: 12,
  plan: (item, _ctx, steps) =>
    item.source ? sourcePlan(item, localSteps(steps, item)) : nodePlan(item, steps),
  targets: (item) => (item.source ? topics(item.source.title).map(pageId) : []),
};

export const nextGenDecisionPolicy: DecisionPolicy = (request) => {
  const state = JSON.stringify(request.state);
  return Object.fromEntries(
    Object.entries(request.questions).map(([key, question]) => {
      if (question.type !== "score") throw new Error(`Unexpected decision question ${key}`);
      let score = 1;
      if (key === "urgency") {
        score = /Camera return acknowledgement|Archived first proposal/.test(state)
          ? 0.1
          : /Lantern crate reservation/.test(state) && /today from 16:00/.test(state)
            ? 0.5
            : 1;
      } else if (key === "discovery" && /Reference note about paper sizes/.test(state)) score = 0;
      return [
        key,
        { type: "score" as const, score: score * (question.criteria.length - 1), confidence: 1 },
      ];
    }),
  );
};
