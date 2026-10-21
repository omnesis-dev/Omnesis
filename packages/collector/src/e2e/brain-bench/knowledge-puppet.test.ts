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
  it("works around inputs it leaves pending and ends its turn once only those remain", () => {
    const next = knowledgePuppet({
      plan: () => ({ calls: [] }),
      leavePending: (item) => item.source?.id === "heavy",
    });
    const heavy = {
      ...source,
      id: "source:heavy",
      inputFingerprint: "fp-heavy",
      source: { ...source.source, id: "heavy" },
    };
    expect(next(ctx, [frontier([heavy, source])])).toMatchObject({
      name: "knowledge_discovery_complete",
      args: { id: "source:doc" },
    });
    const settled: ToolStep = {
      name: "knowledge_discovery_complete",
      args: { id: "source:doc", inputFingerprint: "fp" },
      result: { kind: "structured", data: {} },
    };
    expect(next(ctx, [frontier([heavy, source]), settled])).toMatchObject({
      name: "knowledge_next_frontier",
    });
    expect(next(ctx, [frontier([heavy, source]), settled, frontier([heavy])])).toMatchObject({
      kind: "final",
      text: expect.stringContaining("pending"),
    });
  });

  it("allows an explicitly refused new-page draft during source discovery without swallowing node settlement errors", () => {
    const next = knowledgePuppet({
      expectedRefusals: () => [{ tool: "knowledge_save", code: "claim_invalid" }],
      plan: () => ({ calls: [call("knowledge_save", { node: { id: "new-page" } })] }),
      targets: () => [],
    });
    const refused: ToolStep = {
      name: "knowledge_save",
      args: { node: { id: "new-page" } },
      result: { kind: "error", code: "claim_invalid", message: "Draft refused" },
    };
    expect(next(ctx, [frontier([source]), refused])).toMatchObject({
      name: "knowledge_discovery_complete",
    });
    expect(
      next(ctx, [
        frontier([{ id: "new-page", depth: 0, inputFingerprint: "fp", inputVersions: {} }]),
        refused,
      ]),
    ).toMatchObject({ kind: "final", text: expect.stringContaining("refused") });
    expect(
      next(ctx, [
        frontier([source]),
        { ...refused, result: { kind: "error", code: "revision_conflict", message: "Stale" } },
      ]),
    ).toMatchObject({ kind: "final" });
  });

  it("re-reads a source after a source_read_required refusal, within a bound", () => {
    const next = knowledgePuppet({ plan: () => ({ calls: [] }) });
    const refused: ToolStep = {
      name: "knowledge_discovery_complete",
      args: { id: "source:doc", inputFingerprint: "fp" },
      result: { kind: "error", code: "source_read_required", message: "Read it again" },
    };
    const reread: ToolStep = {
      name: "fetch_many",
      args: { documents: [{ documentId: "doc" }] },
      result: { kind: "document.batch", items: [] },
    };
    expect(next(ctx, [frontier([source]), refused])).toEqual({
      kind: "tool",
      name: "fetch_many",
      args: { documents: [{ documentId: "doc" }] },
    });
    expect(next(ctx, [frontier([source]), refused, reread])).toMatchObject({
      name: "knowledge_discovery_complete",
      args: { id: "source:doc", inputFingerprint: "fp" },
    });
    const settled = { ...refused, result: { kind: "structured", data: {} } };
    expect(next(ctx, [frontier([source]), refused, reread, settled])).toMatchObject({
      name: "knowledge_next_frontier",
    });
    expect(
      next(ctx, [frontier([source]), refused, reread, refused, reread, refused]),
    ).toMatchObject({ kind: "final", text: expect.stringContaining("refused") });
  });

  it("accepts a complete source read at its semantic revision without confusing the body hash", () => {
    const next = knowledgePuppet({ plan: () => ({ calls: [] }) });
    const offered = {
      ...source,
      source: { ...source.source, sourceRevision: "v1:knowledge:2" },
      fetchRequired: { id: "doc", kind: "source" },
    };
    const read: ToolStep = {
      name: "knowledge_reference",
      args: { ref: "source:doc" },
      result: {
        kind: "structured",
        data: { text: source.source.content, revision: "v1:knowledge:2", contentHash: "v1" },
      },
    };
    expect(next(ctx, [frontier([offered]), read])).toMatchObject({
      name: "knowledge_discovery_complete",
    });
    const stale = {
      ...read,
      result: {
        kind: "structured" as const,
        data: { text: source.source.content, revision: "v1" },
      },
    };
    expect(next(ctx, [frontier([offered]), stale])).toMatchObject({
      kind: "final",
      text: expect.stringContaining("Source changed"),
    });
  });
  it.each([true, false])(
    "interprets adopted evidence but not original cohort members (member=%s)",
    (member) => {
      const next = knowledgePuppet({
        plan: () => ({ calls: [call("fetch_many", { documents: [{ documentId: "doc" }] })] }),
        targets: () => ["topic"],
      });
      const joint: ToolStep = {
        name: "knowledge_next_frontier",
        args: {},
        result: {
          kind: "structured",
          data: {
            batchId: "b",
            done: false,
            items: [source],
            organization: {
              id: "cohort",
              inputFingerprint: "joint",
              sourceIds: member ? ["doc", "other"] : ["a", "b"],
              readyToComplete: false,
            },
          },
        },
      };
      if (!member) expect(next(ctx, [joint])).toMatchObject({ name: "fetch_many" });
      expect(
        next(ctx, [
          joint,
          ...(!member
            ? [
                {
                  name: "fetch_many",
                  args: { documents: [{ documentId: "doc" }] },
                  result: { kind: "document.batch", items: [] },
                },
              ]
            : []),
        ]),
      ).toMatchObject({
        name: "knowledge_discovery_complete",
        args: { targets: member ? [] : ["topic"] },
      });
    },
  );

  it("records a scripted joint outcome after the source frontier is settled", () => {
    const next = knowledgePuppet({ plan: () => ({ calls: [] }) });
    const joint: ToolStep = {
      name: "knowledge_next_frontier",
      args: {},
      result: {
        kind: "structured",
        data: {
          batchId: "b",
          done: false,
          items: [],
          organization: {
            id: "cohort",
            inputFingerprint: "joint-fp",
            sourceIds: ["a", "b"],
            readyToComplete: true,
          },
        },
      },
    };
    expect(next(ctx, [joint])).toMatchObject({
      kind: "tool",
      name: "knowledge_organization_complete",
      args: { id: "cohort", inputFingerprint: "joint-fp", outcome: "no_page" },
    });
    expect(
      next(ctx, [
        joint,
        {
          name: "knowledge_organization_complete",
          args: {},
          result: { kind: "structured", data: true },
        },
      ]),
    ).toMatchObject({ name: "knowledge_next_frontier" });
  });

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
      expect(next(ctx, [offered])).toMatchObject({ kind: "tool", name: "knowledge_fetch" });
      const fetched: ToolStep = {
        name: "knowledge_fetch",
        args: { id: "page", editing: true },
        result: {
          kind: "structured",
          data: {
            id: "page",
            kind: "wiki",
            title: "Workshop",
            markdown: "Tagged page",
            revision: 1,
            ownerId: null,
          },
        },
      };
      expect(next(ctx, [offered, fetched])).toMatchObject({
        kind: "tool",
        name: "knowledge_save",
        args: { reviewedClaimIds: reviewedClaimIds ?? ["date", "place"] },
      });
    },
  );
  it("settles, scopes and stops on a targeted knowledge_edit exactly like knowledge_save", () => {
    const next = knowledgePuppet({
      plan: (item) => ({
        calls: [
          call("knowledge_edit", {
            inputFingerprint: item.inputFingerprint,
            node: {
              id: item.id,
              expectedRevision: 1,
              edits: [{ op: "replace_text", old: "Tagged", new: "Edited" }],
            },
          }),
        ],
      }),
    });
    const node = {
      id: "page",
      kind: "wiki",
      title: "Workshop",
      markdown: "Tagged page",
      revision: 1,
      ownerId: null,
    };
    const offered = frontier([
      {
        id: "page",
        inputFingerprint: "fp",
        inputVersions: {},
        depth: 0,
        pendingClaimIds: ["date"],
        node,
      },
    ]);
    const fetched: ToolStep = {
      name: "knowledge_fetch",
      args: { id: "page", editing: true },
      result: { kind: "structured", data: node },
    };
    const edit = next(ctx, [offered, fetched]);
    expect(edit).toMatchObject({
      kind: "tool",
      name: "knowledge_edit",
      args: { reviewedClaimIds: ["date"] },
    });
    if (edit?.kind !== "tool") throw new Error("expected an edit call");
    const saved: ToolStep = {
      name: "knowledge_edit",
      args: edit.args,
      result: { kind: "structured", data: { node: { id: "page", revision: 2 } } },
    };
    expect(next(ctx, [offered, fetched, saved])).toMatchObject({
      kind: "tool",
      name: "knowledge_next_frontier",
    });
    const refused: ToolStep = {
      ...saved,
      result: { kind: "error", code: "claim_invalid", message: "Refused" },
    };
    expect(next(ctx, [offered, fetched, refused])).toMatchObject({ kind: "final" });
  });
  it("settles an offered page on a successful knowledge_retire and stops on a refused one", () => {
    const next = knowledgePuppet({
      plan: (item) => ({
        calls: [
          call("knowledge_retire", {
            id: item.id,
            expectedRevision: 2,
            reason: "Its only sources were deleted.",
          }),
        ],
      }),
    });
    const node = {
      id: "page",
      kind: "wiki",
      title: "Workshop",
      markdown: "Tagged page",
      revision: 2,
      ownerId: null,
    };
    const offered = frontier([
      { id: "page", inputFingerprint: "fp", inputVersions: {}, depth: 0, node },
    ]);
    const fetched: ToolStep = {
      name: "knowledge_fetch",
      args: { id: "page", editing: true },
      result: { kind: "structured", data: node },
    };
    const retire = next(ctx, [offered, fetched]);
    expect(retire).toMatchObject({ kind: "tool", name: "knowledge_retire", args: { id: "page" } });
    if (retire?.kind !== "tool") throw new Error("expected a retire call");
    const retired: ToolStep = {
      name: "knowledge_retire",
      args: retire.args,
      result: { kind: "structured", data: { id: "page", revision: 3, retired: true } },
    };
    expect(next(ctx, [offered, fetched, retired])).toMatchObject({
      kind: "tool",
      name: "knowledge_next_frontier",
    });
    const refused: ToolStep = {
      ...retired,
      result: { kind: "error", code: "revision_conflict", message: "Refused" },
    };
    expect(next(ctx, [offered, fetched, refused])).toMatchObject({ kind: "final" });
  });
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
  it("opt-in conflicts reacquire the frontier and redo reconciliation instead of replaying stale writes", () => {
    const next = knowledgePuppet({
      maxRevisionConflictRetries: 2,
      plan: (_item, _ctx, steps) => {
        const current = steps.slice(
          steps.findLastIndex((step) => step.name === "knowledge_next_frontier") + 1,
        );
        const search = current.find((step) => step.name === "open_loop_search");
        const data = search?.result as { data?: { loops?: { id: string }[] } } | undefined;
        const existing = data?.data?.loops?.[0];
        return {
          calls: [
            call("open_loop_search", { query: "Workshop" }),
            existing
              ? call("open_loop_update", { id: existing.id })
              : call("open_loop_create", { title: "Workshop" }),
          ],
        };
      },
    });
    const failed: ToolStep[] = [
      frontier([source]),
      {
        name: "open_loop_search",
        args: { query: "Workshop" },
        result: { kind: "structured", data: { loops: [] } },
      },
      { name: "open_loop_create", args: {}, result: { kind: "error", code: "revision_conflict" } },
    ];
    expect(next(ctx, failed)).toMatchObject({ kind: "tool", name: "knowledge_next_frontier" });
    const refreshed = [...failed, frontier([source])];
    expect(next(ctx, refreshed)).toMatchObject({ kind: "tool", name: "open_loop_search" });
    expect(
      next(ctx, [
        ...refreshed,
        {
          name: "open_loop_search",
          args: {},
          result: { kind: "structured", data: { loops: [{ id: "peer-created" }] } },
        },
      ]),
    ).toMatchObject({
      kind: "tool",
      name: "open_loop_update",
      args: { id: "peer-created" },
    });
  });

  it("bounds revision conflict recovery across refreshed frontiers", () => {
    const next = knowledgePuppet({ maxRevisionConflictRetries: 1, plan: () => ({ calls: [] }) });
    const conflict: ToolStep = {
      name: "knowledge_save",
      args: {},
      result: { kind: "error", code: "revision_conflict" },
    };
    const first = [frontier([source]), conflict];
    expect(next(ctx, first)).toMatchObject({ kind: "tool", name: "knowledge_next_frontier" });
    expect(next(ctx, [...first, frontier([source]), conflict])).toMatchObject({
      kind: "final",
      text: expect.stringContaining("retry budget exhausted"),
    });
  });

  it("opt-in retry preserves expected negative-path refusals and other error classes", () => {
    const next = knowledgePuppet({
      maxRevisionConflictRetries: 2,
      plan: () => ({ calls: [call("open_loop_create", {})] }),
      expectedRefusals: () => [{ tool: "open_loop_create", code: "revision_conflict" }],
    });
    const refusal: ToolStep = {
      name: "open_loop_create",
      args: {},
      result: { kind: "error", code: "revision_conflict" },
    };
    expect(next(ctx, [frontier([source]), refusal])).toMatchObject({
      kind: "tool",
      name: "knowledge_discovery_complete",
    });
    expect(
      next(ctx, [
        frontier([source]),
        { ...refusal, result: { kind: "error", code: "claim_invalid" } },
      ]),
    ).toMatchObject({ kind: "final", text: expect.stringContaining("preserve pending") });
  });
});

it("settles omitted fingerprints only from an actual matching saved revision", () => {
  const next = knowledgePuppet({
    plan: () => ({ calls: [call("knowledge_fetch", { id: "atlas", editing: true })] }),
  });
  const offer = frontier([{ id: "atlas", depth: 0, inputFingerprint: "fp", inputVersions: {} }]);
  const save: ToolStep = {
    name: "knowledge_save",
    args: { node: { id: "atlas", expectedRevision: 2 } },
    result: { kind: "structured", data: { node: { id: "atlas", revision: 3 } } },
  };
  expect(next(ctx, [offer, save])).toMatchObject({ name: "knowledge_next_frontier" });
  for (const result of [
    { kind: "structured", data: { reason: "Record refused" } },
    { kind: "structured", data: { node: { id: "other", revision: 3 } } },
    { kind: "structured", data: { node: { id: "atlas", revision: 2 } } },
  ])
    expect(next(ctx, [offer, { ...save, result }])).not.toMatchObject({
      name: "knowledge_next_frontier",
    });
});
