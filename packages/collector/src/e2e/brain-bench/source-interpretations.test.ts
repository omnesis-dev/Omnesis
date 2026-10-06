// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  sourceInterpretations,
  preserveCurrentOwner,
  refreshCurrentOwner,
} from "./source-interpretations.js";
import { call, type RunContext, type ToolStep } from "./puppet-plan.js";

const ctx: RunContext = {
  runId: "batch-run",
  kind: "synthesis",
  attempt: 1,
  flavour: "synthesis.knowledge",
  subject: null,
  detail: null,
  prompt: "maintenance",
};
const frontier = (items: unknown[]): ToolStep => ({
  name: "knowledge_next_frontier",
  args: {},
  result: { kind: "structured", data: { batchId: "batch", done: false, items } },
});
const source = {
  id: "source:document",
  inputFingerprint: "version-one",
  inputVersions: { "source:document": "one" },
  depth: 0,
  source: {
    id: "document",
    title: "Workshop",
    content: "Reserve the workshop.",
    contentHash: "one",
  },
};

describe("source interpretations", () => {
  it("refreshes temporarily stale owners without repairing truly stale prose or changing the offered fence", () => {
    const node = {
      id: "owner",
      kind: "loop",
      ownerId: "owner",
      title: "Workshop",
      markdown: '<claim id="legacy" refs="source:document">Workshop</claim>',
      revision: 1,
      validity: "stale",
      metadata: { activity: "active" },
      claims: [
        {
          id: "legacy",
          refs: ["source:document"],
          supportLogic: "all",
          validFrom: null,
          validUntil: null,
        },
      ],
    };
    const item = { ...source, id: "owner", source: undefined, node };
    const offered = frontier([item]);
    const fetchArgs = { id: "owner", editing: true };
    expect(refreshCurrentOwner(item, ctx, [offered]).calls).toEqual([
      call("knowledge_fetch", fetchArgs),
    ]);
    const fetched = (value: unknown): ToolStep => ({
      name: "knowledge_fetch",
      args: fetchArgs,
      result: { kind: "structured", data: value },
    });
    expect(refreshCurrentOwner(item, ctx, [offered, fetched(node)]).calls).toEqual([]);
    const refreshed = refreshCurrentOwner(item, ctx, [
      offered,
      fetched({ ...node, revision: 2, validity: "current" }),
    ]);
    expect(refreshed.calls[1]?.args).toMatchObject({
      node: {
        expectedRevision: 2,
        inputVersions: item.inputVersions,
        claims: [{ relations: { "source:document": "context" } }],
      },
      inputFingerprint: item.inputFingerprint,
    });
    expect(refreshCurrentOwner(item, ctx, [offered, fetched(null)]).calls).toEqual([]);
    // A fetch from an older frontier cannot stand in for re-reading this offer.
    expect(
      refreshCurrentOwner(item, ctx, [fetched({ ...node, validity: "current" }), offered]).calls,
    ).toEqual([call("knowledge_fetch", fetchArgs)]);
  });

  it("preserves current legacy context without promoting it to proof or accepting stale prose", () => {
    const item = {
      ...source,
      source: undefined,
      node: {
        id: "owner",
        kind: "loop",
        ownerId: "owner",
        title: "Workshop",
        markdown: '<claim id="legacy" refs="source:document">Workshop</claim>',
        revision: 1,
        validity: "current",
        metadata: { importance: 0.5, lastVerifiedAt: 100 },
        claims: [
          {
            id: "legacy",
            refs: ["source:document"],
            supportLogic: "all",
            validFrom: null,
            validUntil: null,
          },
        ],
      },
    };
    const plan = preserveCurrentOwner(item, ctx, []);
    expect(plan.calls[0]?.args).toMatchObject({
      node: {
        claims: [{ id: "legacy", relations: { "source:document": "context" } }],
        metadata: { importance: 0.5 },
      },
    });
    expect((plan.calls[0]?.args.node as { metadata: object }).metadata).not.toHaveProperty(
      "lastVerifiedAt",
    );
    expect(
      preserveCurrentOwner({ ...item, node: { ...item.node, validity: "stale" } }, ctx, []).calls,
    ).toEqual([]);
  });

  it("preserves evidence-free legacy owner prose with explicit unsupported coverage", () => {
    const item = {
      ...source,
      source: undefined,
      node: {
        id: "owner",
        ownerId: "owner",
        kind: "loop",
        title: "Workshop",
        markdown: "Historical workshop context.",
        revision: 1,
        validity: "current",
        claims: [],
        metadata: {},
      },
    };
    expect(preserveCurrentOwner(item, ctx, []).calls[0]?.args).toMatchObject({
      node: {
        markdown: '<claim id="legacy-context-0" refs="">Historical workshop context.</claim>',
        claims: [{ id: "legacy-context-0", epistemicStatus: "unsupported" }],
      },
    });
  });

  it("pages remaining temporal casualties before completing discovery", () => {
    const next = sourceInterpretations({
      sources: [{ docTitle: "Workshop", plan: { calls: [] } }],
    });
    const offered = frontier([{ ...source, temporal: { hasMoreInvalidated: true } }]);
    const fetch: ToolStep = { name: "fetch_many", args: {}, result: { kind: "document.batch" } };
    expect(next(ctx, [offered, fetch])).toMatchObject({
      kind: "tool",
      name: "knowledge_temporal_context",
      args: { documentId: "document" },
    });
    expect(
      next(ctx, [
        offered,
        fetch,
        {
          name: "knowledge_temporal_context",
          args: { documentId: "document" },
          result: { kind: "structured", data: { hasMoreInvalidated: false } },
        },
      ]),
    ).toMatchObject({
      kind: "tool",
      name: "knowledge_discovery_complete",
      args: { id: "source:document" },
    });
  });
  it("dispatches from actual source evidence while preserving synthesis attribution", () => {
    const next = sourceInterpretations({
      sources: [
        {
          docTitle: "Workshop",
          plan: (context, item) => ({
            calls: [
              call("open_loop_create", {
                title: item.source!.content,
                docs: [context.subject],
                run: context.runId,
                kind: context.kind,
              }),
            ],
          }),
        },
      ],
    });
    expect(next(ctx, [frontier([source])])).toEqual({
      kind: "tool",
      name: "fetch_many",
      args: { documents: [{ documentId: "document" }] },
    });
    expect(
      next(ctx, [
        frontier([source]),
        {
          name: "fetch_many",
          args: { documents: [{ documentId: "document" }] },
          result: {
            kind: "document.batch",
            items: [{ kind: "document", document: { title: "Workshop" } }],
          },
        },
      ]),
    ).toMatchObject({
      kind: "tool",
      name: "open_loop_create",
      args: {
        title: "Reserve the workshop.",
        docs: ["document"],
        run: "batch-run",
        kind: "synthesis",
      },
    });
    expect(
      next(ctx, [frontier([{ ...source, source: { ...source.source, title: "Other" } }])]),
    ).toMatchObject({
      kind: "tool",
      name: "knowledge_discovery_complete",
      args: { id: "source:document", inputFingerprint: "version-one" },
    });
  });

  it("continues only after an explicitly expected source refusal, preserving settlement guards", () => {
    const steps: ToolStep[] = [
      frontier([source]),
      { name: "fetch_many", args: {}, result: { kind: "document.batch" } },
      { name: "annotate_durable", args: {}, result: { kind: "error", code: "evidence_not_found" } },
    ];
    const policy = (expectedRefusals?: { tool: string; code: string }[]) =>
      sourceInterpretations({
        sources: [
          {
            docTitle: "Workshop",
            expectedRefusals,
            plan: { calls: [call("annotate_durable", {})] },
          },
        ],
      });
    expect(policy()(ctx, steps)).toMatchObject({
      kind: "final",
      text: expect.stringContaining("refused"),
    });
    expect(
      policy([{ tool: "annotate_durable", code: "evidence_not_found" }])(ctx, steps),
    ).toMatchObject({
      kind: "tool",
      name: "knowledge_discovery_complete",
      args: { id: "source:document" },
    });
    for (const refusal of [
      { tool: "other_tool", code: "evidence_not_found" },
      { tool: "annotate_durable", code: "unexpected_error" },
      { tool: "knowledge_save", code: "conflict" },
      { tool: "knowledge_discovery_complete", code: "conflict" },
    ]) {
      const changed = [
        ...steps.slice(0, 2),
        {
          name: refusal.tool,
          args: { id: source.id, inputFingerprint: source.inputFingerprint },
          result: { kind: "error", code: refusal.code },
        },
      ];
      const allowed = refusal.tool.startsWith("knowledge_")
        ? [refusal]
        : [{ tool: "annotate_durable", code: "evidence_not_found" }];
      expect(policy(allowed)(ctx, changed)).toMatchObject({
        kind: "final",
        text: expect.stringContaining("refused"),
      });
    }
  });

  it("scopes expected refusals to their own source within a shared frontier", () => {
    const other = {
      ...source,
      id: "source:other",
      source: { ...source.source, id: "other", title: "Other" },
    };
    const next = sourceInterpretations({
      sources: [
        {
          docTitle: "Other",
          expectedRefusals: [{ tool: "annotate_durable", code: "evidence_not_found" }],
          plan: { calls: [call("annotate_durable", {})] },
        },
      ],
    });
    expect(
      next(ctx, [
        frontier([source, other]),
        {
          name: "knowledge_discovery_complete",
          args: { id: source.id, inputFingerprint: source.inputFingerprint },
          result: { kind: "structured" },
        },
        { name: "fetch_many", args: {}, result: { kind: "document.batch" } },
        {
          name: "annotate_durable",
          args: {},
          result: { kind: "error", code: "evidence_not_found" },
        },
      ]),
    ).toMatchObject({
      kind: "tool",
      name: "knowledge_discovery_complete",
      args: { id: "source:other" },
    });
  });

  it("requires an explicit node-save policy instead of pretending source decisions repair owners", () => {
    const node = {
      ...source,
      id: "owner",
      source: undefined,
      node: {
        id: "owner",
        kind: "loop",
        title: "Workshop",
        markdown: "",
        revision: 1,
        ownerId: "owner",
      },
    };
    const next = sourceInterpretations({ sources: [] });
    expect(next(ctx, [frontier([node])])).toMatchObject({
      kind: "final",
      text: expect.stringContaining("did not save offered node"),
    });
    const maintained = sourceInterpretations({
      sources: [],
      maintainNode: (item) => ({
        calls: [
          call("knowledge_save", {
            node: { id: item.id },
            inputFingerprint: item.inputFingerprint,
          }),
        ],
      }),
    });
    expect(maintained(ctx, [frontier([node])])).toMatchObject({
      kind: "tool",
      name: "knowledge_save",
      args: { node: { id: "owner" }, inputFingerprint: "version-one" },
    });
  });
});
