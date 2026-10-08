// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { nextGenPolicy } from "./next-gen-policy.js";
import type { PuppetKnowledgeItem } from "./knowledge-puppet.js";
import type { RunContext, ToolStep } from "./puppet-plan.js";

const context: RunContext = {
  runId: "successor",
  kind: "synthesis",
  attempt: 1,
  flavour: "synthesis.knowledge",
  subject: null,
  detail: null,
  prompt: "",
};
function item(): PuppetKnowledgeItem {
  return {
    id: "demo-gathering",
    inputFingerprint: "offered-inputs",
    depth: 1,
    inputVersions: { "node:demo-gathering": 1, "source:selected": "v1" },
    node: {
      id: "demo-gathering",
      kind: "wiki",
      title: "Gathering",
      markdown: "",
      revision: 1,
      ownerId: null,
    },
  };
}
function step(name: string, args: Record<string, unknown>, data: unknown): ToolStep {
  return { name, args, result: { kind: "structured", data } };
}

describe("progressive policy continuation context", () => {
  it("reads a durable selected source without any predecessor transcript before grounding or saving", () => {
    const offered = item();
    const first = nextGenPolicy.plan(offered, context, []);
    expect(first.calls).toEqual([
      { tool: "knowledge_reference", args: { ref: "source:selected" } },
    ]);
    const reference = step(
      "knowledge_reference",
      { ref: "source:selected" },
      {
        ref: "source:selected",
        revision: "v1",
        text: "An early proposal was tentative.",
      },
    );
    const read = nextGenPolicy.plan(offered, context, [reference]);
    expect(read.calls.at(-1)).toEqual({
      tool: "knowledge_evidence",
      args: {
        documentId: "selected",
        contentHash: "v1",
        quote: "An early proposal was tentative.",
      },
    });
    expect(read.calls.some((entry) => entry.tool === "knowledge_save")).toBe(false);
    const grounded = nextGenPolicy.plan(offered, context, [
      reference,
      step(
        "knowledge_evidence",
        { documentId: "selected" },
        { ref: "source:selected#evidence:one", contentHash: "v1" },
      ),
    ]);
    expect(grounded.calls.at(-1)).toMatchObject({
      tool: "knowledge_save",
      args: {
        inputFingerprint: "offered-inputs",
        placementAssessment: { status: "standalone", reason: expect.any(String) },
        node: { inputVersions: { "source:selected#evidence:one": "v1" } },
      },
    });
    expect(grounded.calls.at(-2)).toEqual({
      tool: "knowledge_list",
      args: { kind: "wiki" },
    });
  });

  it("recovers every omitted input page before reading newly selected evidence", () => {
    const offered = { ...item(), inputVersions: {}, inputVersionsOmitted: true };
    const first = nextGenPolicy.plan(offered, context, []);
    expect(first.calls).toEqual([
      { tool: "knowledge_maintenance_inputs", args: { id: offered.id } },
    ]);
    const pageOne = step(
      "knowledge_maintenance_inputs",
      { id: offered.id },
      {
        inputFingerprint: offered.inputFingerprint,
        inputVersions: { "node:demo-gathering": 1 },
        nextAfter: "node:demo-gathering",
      },
    );
    expect(nextGenPolicy.plan(offered, context, [pageOne]).calls.at(-1)).toEqual({
      tool: "knowledge_maintenance_inputs",
      args: { id: offered.id, after: "node:demo-gathering" },
    });
    const pageTwo = step(
      "knowledge_maintenance_inputs",
      { id: offered.id, after: "node:demo-gathering" },
      {
        inputFingerprint: offered.inputFingerprint,
        inputVersions: { "source:selected": "v1" },
      },
    );
    expect(nextGenPolicy.plan(offered, context, [pageOne, pageTwo]).calls.at(-1)).toEqual({
      tool: "knowledge_reference",
      args: { ref: "source:selected" },
    });
    const stalePage = step(
      "knowledge_maintenance_inputs",
      { id: offered.id },
      {
        inputFingerprint: "other-inputs",
        inputVersions: { "source:selected": "v2" },
      },
    );
    expect(nextGenPolicy.plan(offered, context, [stalePage]).calls).toEqual(first.calls);
  });
});
