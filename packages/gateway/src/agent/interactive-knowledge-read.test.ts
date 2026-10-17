// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildBuiltinTools,
  CitationReads,
  type ToolHandle,
  type DocumentPort,
} from "@omnesis/agent";
import { KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import { adaptInteractiveKnowledgeReads } from "./interactive-knowledge-read.js";
import { createAnswerGroundingFinalizer } from "./answer-grounding.js";

const identity = { sessionId: "session", messageId: "turn" };
function setup(available = true, aliases = true) {
  const raw = vi.fn<ToolHandle["invoke"]>().mockResolvedValue({
    kind: "structured",
    resultType: "knowledge_fetch",
    data: { id: "page", markdown: "<claim>Editing snapshot</claim>" },
  });
  const canonical: ToolHandle = {
    name: "knowledge_fetch",
    description: "Canonical read",
    mutates: false,
    schema: z.object({ id: z.string(), editing: z.boolean().default(false) }).strict(),
    invoke: raw,
  };
  const document: DocumentPort = {
    supportsKnowledgeAliases: aliases,
    fetch: vi.fn(async (id) =>
      available && (id === "wiki:page" || id === "projection")
        ? {
            ref: { documentId: "projection", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "omnesis" },
            readSnapshot: { documentId: "projection", version: "v1" },
            document: {
              title: "Experiment",
              content: "The prism is green.",
              knowledgeContext: {
                validity: "current",
                verifiedSupport: [
                  { ref: "wiki:page#claim:color", revision: 1, text: "The prism is green." },
                ],
              },
            },
          }
        : null,
    ),
  };
  const reads = new CitationReads();
  const registry = buildBuiltinTools({
    citationReads: reads,
    ports: { document, search: { search: vi.fn() } },
  });
  const [tool] = adaptInteractiveKnowledgeReads([canonical], registry, aliases);
  return { tool: tool!, canonical, raw, document, reads, registry };
}

it.each(["page", "wiki:page"])(
  "returns qualified reads for %s and records only the projection for this turn",
  async (id) => {
    const f = setup();
    const result = await f.tool.invoke({ id }, identity);
    expect(result).toMatchObject({
      kind: "document.batch",
      items: [{ kind: "document", ref: { documentId: "projection" } }],
    });
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.reads.snapshot(identity)).toEqual([
      { documentId: "projection", version: "v1", full: true, spans: [] },
    ]);
    expect(f.reads.snapshot({ ...identity, messageId: "other" })).toEqual([]);
    const verify = vi.fn().mockResolvedValue({ label: "entailment" });
    const finalizer = createAnswerGroundingFinalizer({
      reads: f.reads,
      document: f.document,
      getVerifier: async () => ({ verify, dispose() {} }),
      repair: vi.fn(),
      diagnostic: vi.fn(),
    })({ ...identity, question: "What color is it?" });
    finalizer.observe({
      type: "agent.tool.result",
      payload: { ...identity, toolCallId: "wiki", durationMs: 0, result },
    });
    expect(
      await finalizer.finalize({
        draft: "The prism is green.",
        overflow: false,
        signal: new AbortController().signal,
      }),
    ).toBe("The prism is green.");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0].evidence).toContain("The prism is green.");
  },
);

it.each(["page", "wiki:page"])(
  "keeps the exact canonical editing invocation for %s without inventing a citation read",
  async (id) => {
    const f = setup();
    const args = { id, editing: true };
    await f.tool.invoke(args, identity);
    expect(f.tool.schema).toBe(f.canonical.schema);
    expect(f.tool.mutates).toBe(f.canonical.mutates);
    expect(f.raw).toHaveBeenCalledWith(args, identity);
    expect(f.document.fetch).not.toHaveBeenCalled();
    expect(f.reads.snapshot(identity)).toEqual([]);
  },
);

it.each([
  "wiki:wiki:page",
  "wiki:page#claim:color",
  "source:page",
  "loop:page",
  "root:page",
  "https://example.org/page",
  "../page",
  " page",
  "wiki:page ",
  "wiki:%70age",
  "wiki:",
  "a".repeat(129),
])("refuses malformed or non-page reference %s before any read", async (id) => {
  const f = setup();
  expect(await f.tool.invoke({ id }, identity)).toMatchObject({
    kind: "error",
    code: "knowledge_read_unavailable",
  });
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.document.fetch).not.toHaveBeenCalled();
  expect(f.reads.snapshot(identity)).toEqual([]);
});

it.each([false, true])(
  "does not fall back to raw canonical data when alias unavailable (supported: %s)",
  async (aliases) => {
    const f = setup(false, aliases);
    expect(await f.tool.invoke({ id: "private_or_nonwiki" }, identity)).toMatchObject({
      kind: "error",
      code: "knowledge_read_unavailable",
    });
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.reads.snapshot(identity)).toEqual([]);
  },
);

it("rejects invalid input and preserves unrelated tools unchanged", async () => {
  const f = setup();
  expect(await f.tool.invoke({ id: "page", surprise: true }, identity)).toMatchObject({
    kind: "error",
    code: "invalid_args",
  });
  expect(f.document.fetch).not.toHaveBeenCalled();
  const unrelated = { ...f.canonical, name: "knowledge_save" };
  expect(adaptInteractiveKnowledgeReads([unrelated], f.registry, true)[0]).toBe(unrelated);
});

it("keeps the page-title summary the canonical read gives its call", () => {
  const { canonical } = setup();
  const titled: ToolHandle = { ...canonical, summarize: () => "Experiment" };
  const [tool] = adaptInteractiveKnowledgeReads([titled], [], true);
  expect(tool!.summarize?.({ id: "page" })).toBe("Experiment");
});
