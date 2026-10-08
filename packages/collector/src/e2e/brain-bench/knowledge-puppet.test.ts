// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { knowledgePuppet } from "./knowledge-puppet.js";
import { type RunContext, type ToolStep, call } from "./puppet-plan.js";
const ctx: RunContext = {
  runId: "r",
  kind: "synthesis",
  attempt: 1,
  flavour: "synthesis.knowledge",
  subject: null,
  detail: null,
  prompt: "",
};
const source = {
  id: "source:doc",
  inputFingerprint: "fp",
  inputVersions: { "source:doc": "v1" },
  depth: 0,
  source: { id: "doc", title: "Plan", content: "A fictional plan.", contentHash: "v1" },
};
const frontier = (items: unknown[], done = false): ToolStep => ({
  name: "knowledge_next_frontier",
  args: {},
  result: { kind: "structured", data: { batchId: "b", done, items } },
});
describe("knowledge puppet protocol", () => {
  it.each([undefined, [], ["date"]])(
    "preserves explicit claim review scope %j",
    (reviewedClaimIds) => {
      const next = knowledgePuppet({
        plan: (item) => ({
          calls: [
            call("knowledge_save", {
              node: { id: item.id },
              inputFingerprint: item.inputFingerprint,
              ...(reviewedClaimIds !== undefined ? { reviewedClaimIds } : {}),
            }),
          ],
        }),
      });
      const offered = frontier([
        {
          id: "page",
          inputFingerprint: "fp",
          inputVersions: {},
          depth: 0,
          pendingClaimIds: ["date", "place"],
          node: {
            id: "page",
            kind: "wiki",
            title: "Workshop",
            markdown: "Tagged page",
            revision: 1,
            ownerId: null,
          },
        },
      ]);
      expect(next(ctx, [offered])).toMatchObject({
        kind: "tool",
        name: "knowledge_save",
        args: { reviewedClaimIds: reviewedClaimIds ?? ["date", "place"] },
      });
    },
  );
  it("only finishes when the real engine returns done", () => {
    const next = knowledgePuppet({ plan: () => ({ calls: [] }) });
    expect(next(ctx, [])).toMatchObject({ kind: "tool", name: "knowledge_next_frontier" });
    expect(next(ctx, [frontier([])])).toMatchObject({
      kind: "tool",
      name: "knowledge_next_frontier",
    });
    expect(next(ctx, [frontier([], true)])).toMatchObject({ kind: "final" });
  });
  it("executes scripted real tool calls before completing the exact source version", () => {
    const next = knowledgePuppet({
      plan: () => ({ calls: [call("knowledge_propose_page", { title: "Workshop" })] }),
      targets: () => ["existing-page"],
    });
    const offered = frontier([source]);
    expect(next(ctx, [offered])).toMatchObject({ kind: "tool", name: "knowledge_propose_page" });
    const planCall: ToolStep = {
      name: "knowledge_propose_page",
      args: { title: "Workshop" },
      result: { kind: "structured", data: { id: "candidate" } },
    };
    expect(next(ctx, [offered, planCall])).toEqual({
      kind: "tool",
      name: "knowledge_discovery_complete",
      args: { id: "source:doc", inputFingerprint: "fp", targets: ["existing-page"] },
    });
    const completed: ToolStep = {
      name: "knowledge_discovery_complete",
      args: { id: "source:doc", inputFingerprint: "fp" },
      result: { kind: "structured", data: null },
    };
    expect(next(ctx, [offered, planCall, completed])).toMatchObject({
      kind: "tool",
      name: "knowledge_next_frontier",
    });
  });
  it("fetches oversized synthesis nodes before constructing a save plan", () => {
    let seen = "";
    const next = knowledgePuppet({
      plan: (item) => {
        seen = item.node!.markdown;
        return {
          calls: [
            call("knowledge_save", {
              inputFingerprint: item.inputFingerprint,
              node: { id: item.id },
            }),
          ],
        };
      },
    });
    const offered = frontier([
      {
        id: "page",
        inputFingerprint: "fp",
        inputVersions: {},
        depth: 0,
        fetchRequired: { id: "page", kind: "wiki" },
      },
    ]);
    expect(next(ctx, [offered])).toEqual({
      kind: "tool",
      name: "knowledge_fetch",
      args: { id: "page", editing: true },
    });
    const fetched: ToolStep = {
      name: "knowledge_fetch",
      args: { id: "page", editing: true },
      result: {
        kind: "structured",
        data: {
          id: "page",
          kind: "wiki",
          title: "Planning",
          markdown: "Full claim markup",
          revision: 1,
          ownerId: null,
        },
      },
    };
    expect(next(ctx, [offered, fetched])).toMatchObject({ kind: "tool", name: "knowledge_save" });
    expect(seen).toBe("Full claim markup");
  });
  it("does not mark discovery complete after a missing or refused earlier write", () => {
    const next = knowledgePuppet({
      plan: () => ({ calls: [call("open_loop_create", { title: "Workshop" })] }),
    });
    for (const result of [null, { kind: "error", code: "revision_conflict" }]) {
      expect(
        next(ctx, [
          frontier([source]),
          { name: "open_loop_create", args: { title: "Workshop" }, result },
        ]),
      ).toMatchObject({ kind: "final", text: expect.stringContaining("preserve pending") });
    }
  });
  it("does not fake completion when a canonical write was refused", () => {
    const next = knowledgePuppet({ plan: () => ({ calls: [] }) });
    expect(
      next(ctx, [
        frontier([source]),
        {
          name: "knowledge_discovery_complete",
          args: { id: "source:doc", inputFingerprint: "fp" },
          result: { kind: "error", code: "revision_conflict" },
        },
      ]),
    ).toMatchObject({ kind: "final", text: expect.stringContaining("refused") });
  });
});
