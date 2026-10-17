// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { CitationReads, type DocumentPort, type DocumentPortResult } from "@omnesis/agent";
import { LlmJudgeEntailmentVerifier } from "../inference/entailment-loader.js";
import {
  prepareAnswerWitnessRequest,
  parseAnswerWitnessVerdict,
} from "../inference/answer-entailment.js";
import { KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import {
  CONTEXTUAL_EVIDENCE_MAX_BYTES,
  ContextualAssessmentError,
} from "../inference/contextual-entailment.js";
import { renderCallerZoneBlock } from "./system-prompt.js";
import {
  createAnswerGroundingFinalizer,
  GROUNDING_UNKNOWN,
  GROUNDING_CHANGED,
  type AnswerGroundingDiagnostic,
} from "./answer-grounding.js";
import type { EntailCapability } from "@omnesis/core";

const identity = { sessionId: "session", messageId: "turn", question: "What happened?" };
function setup(
  options: {
    body?: string;
    sourceEvidenceAuthority?: {
      policy: "attributed_utterances";
      available: boolean;
      utterances: Array<{ role: "user" | "assistant"; start: number; end: number }>;
    };
    read?: boolean;
    root?: boolean;
    promptSupport?: { evidence: Array<{ text: string }>; current(): boolean };
    span?: { offset: number; length: number };
  } = {},
) {
  let version = "one";
  let visible = true;
  const body = options.body ?? "The prism calibration finished on Monday.";
  const result = (): DocumentPortResult => ({
    ref: { documentId: "source", sourceId: "fixture", sourceType: "fixture" },
    readSnapshot: { documentId: "source", version },
    document: {
      content: body,
      title: "Calibration notes",
      sourceEvidenceAuthority: options.sourceEvidenceAuthority,
    },
  });
  const document: DocumentPort = { fetch: vi.fn(async () => (visible ? result() : null)) };
  const reads = new CitationReads();
  if (options.read !== false) reads.record(identity, result(), !options.span, options.span);
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const repair = vi.fn(
    async (_prompt: string, _signal: AbortSignal) => "The calibration finished on Monday.",
  );
  const getVerifier = vi.fn(async (_signal?: AbortSignal) => ({ verify, dispose() {} }));
  const diagnostics: AnswerGroundingDiagnostic[] = [];
  const finalizer = createAnswerGroundingFinalizer({
    reads,
    document,
    ...(options.root
      ? { promptSupport: { evidence: [{ text: "Qualified root statement" }], current: () => true } }
      : {}),
    ...(options.promptSupport ? { promptSupport: options.promptSupport } : {}),
    getVerifier,
    repair,
    diagnostic: (value) => diagnostics.push(value),
  })(identity);
  return {
    finalizer,
    getVerifier,
    verify,
    repair,
    diagnostics,
    change: () => {
      version = "two";
    },
    hide: () => {
      visible = false;
    },
    refreshRead: () => reads.record(identity, result(), true),
  };
}
const input = {
  draft: "The calibration finished on Monday.",
  overflow: false,
  signal: new AbortController().signal,
};

it("checks the actual observed source without expanding a partial read", async () => {
  const f = setup({ body: "Observed. Never read.", span: { offset: 0, length: 9 } });
  expect(await f.finalizer.finalize(input)).toBe(input.draft);
  expect(f.getVerifier).toHaveBeenCalledWith(input.signal);
  const packet = JSON.parse(JSON.parse(f.verify.mock.calls[0]![0].evidence).evidenceParts[0]);
  expect(packet.sources).toEqual([
    {
      documentId: "source",
      title: "Calibration notes",
      authority: "selected_quote",
      text: "Observed.",
      selectedQuotes: ["Observed."],
    },
  ]);
  expect(f.repair).not.toHaveBeenCalled();
  expect(f.verify.mock.calls[0]![0].signal).toBe(input.signal);
  expect(f.verify.mock.calls[0]![0].assessment).toBe("answer_segments");
});

it("repairs once then rechecks instead of releasing unsupported relationships", async () => {
  const f = setup();
  f.verify
    .mockResolvedValueOnce({ label: "neutral" })
    .mockResolvedValueOnce({ label: "entailment" });
  expect(
    await f.finalizer.finalize({ ...input, draft: "Calibration caused the unrelated launch." }),
  ).toBe("The calibration finished on Monday.");
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.repair).toHaveBeenCalledTimes(1);
  const repairPacket = JSON.parse(f.repair.mock.calls[0]![0].split("\n").at(-1)!);
  expect(Object.keys(repairPacket)).toEqual([
    "evidence",
    "context",
    "citationNavigation",
    "draft",
    "diagnostic",
  ]);
  expect(repairPacket.diagnostic).toEqual([]);
  expect(repairPacket.evidence).toBe(f.verify.mock.calls[0]![0].evidence);
  expect(repairPacket.context).toBe(f.verify.mock.calls[0]![0].context);
  expect(repairPacket.draft).toBe("Calibration caused the unrelated launch.");
  expect(f.diagnostics[0]).toMatchObject({
    status: "repaired",
    repairTrigger: "semantic",
    selectionIncomplete: false,
    checks: [
      { outcome: "rejected", label: "neutral", probabilityThreshold: "default_pass" },
      { outcome: "accepted", label: "entailment", probabilityThreshold: "default_pass" },
    ],
  });
});

it("does not release a failed repair or call an unbounded repair loop", async () => {
  const f = setup();
  f.verify.mockResolvedValue({ label: "neutral" });
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.repair).toHaveBeenCalledTimes(1);
});

it.each(["change", "hide"] as const)(
  "holds an answer when evidence %s happens during verification",
  async (action) => {
    const f = setup();
    f.verify.mockImplementation(async () => {
      f[action]();
      return { label: "entailment" };
    });
    expect(await f.finalizer.finalize(input)).toBe(GROUNDING_CHANGED);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.diagnostics[0]?.reason).toBe("evidence_changed");
    expect(f.diagnostics[0]?.checks).toEqual([{ outcome: "recheck_failed" }]);
    expect(f.diagnostics[0]?.sourceFailure).toEqual({
      documentId: "source",
      stage: "recheck",
      comparison: "read_version",
      change: action === "hide" ? "unavailable" : "authority_changed",
      repairAttempted: false,
      discardedInventoryCount: 0,
    });
  },
);

it.each(["unavailable", "snapshot_missing", "authority_changed"] as const)(
  "reports bounded %s qualified-page materialization diagnostics without releasing the draft",
  async (change) => {
    const reads = new CitationReads();
    const original: DocumentPortResult = {
      ref: { documentId: "page", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "brain-knowledge" },
      readSnapshot: {
        documentId: "page",
        version: "one",
        fullPageAuthorityVersion: "qualified-one",
      },
      document: { content: "Private rejected page prose" },
    };
    reads.record(identity, original, true);
    const next =
      change === "unavailable"
        ? null
        : {
            ...original,
            readSnapshot:
              change === "snapshot_missing"
                ? undefined
                : {
                    documentId: "page",
                    version: "two",
                    fullPageAuthorityVersion: "qualified-two",
                  },
          };
    const diagnostic = vi.fn();
    const verify = vi.fn();
    const repair = vi.fn();
    const finalizer = createAnswerGroundingFinalizer({
      reads,
      document: { fetch: async () => next },
      getVerifier: async () => ({ verify, dispose() {} }),
      repair,
      diagnostic,
    })(identity);
    expect(await finalizer.finalize(input)).toBe(GROUNDING_CHANGED);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 0,
        sourceFailure: {
          documentId: "page",
          stage: "materialization",
          comparison: "qualified_page",
          change,
          repairAttempted: false,
          discardedInventoryCount: 0,
        },
      }),
    );
    expect(verify).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /Private|qualified-one|qualified-two/,
    );
  },
);

it("identifies source drift after the one bounded repair rather than hiding it behind attempts", async () => {
  const f = setup();
  f.verify.mockResolvedValue({ label: "neutral" });
  f.repair.mockImplementation(async () => {
    f.change();
    return "The calibration finished on Monday.";
  });
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_CHANGED);
  expect(f.diagnostics.at(-1)?.sourceFailure).toEqual({
    documentId: "source",
    stage: "recheck",
    comparison: "read_version",
    change: "authority_changed",
    repairAttempted: true,
    discardedInventoryCount: 0,
  });
  expect(f.repair).toHaveBeenCalledTimes(1);
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it("holds oversized evidence before any paid check and reports the limitation", async () => {
  const f = setup({ body: "x".repeat(CONTEXTUAL_EVIDENCE_MAX_BYTES) });
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.diagnostics[0]?.reason).toBe("evidence_budget");
});

it("does not acquire unread source content or turn an outage into a positive stamp", async () => {
  const f = setup({ read: false });
  f.verify.mockRejectedValue(new Error("Unavailable"));
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(
    JSON.parse(JSON.parse(f.verify.mock.calls[0]![0].evidence).evidenceParts[0]).sources,
  ).toEqual([]);
  expect(f.diagnostics[0]?.status).toBe("unknown");
});

it("does not release a late verification after cancellation", async () => {
  const f = setup();
  const abort = new AbortController();
  f.verify.mockImplementation(async () => {
    abort.abort();
    return { label: "entailment" };
  });
  expect(await f.finalizer.finalize({ ...input, signal: abort.signal })).toBe("");
  expect(f.repair).not.toHaveBeenCalled();
});

it("preserves successful operation acknowledgment even when the input is over budget", async () => {
  const f = setup();
  f.finalizer.observe({
    type: "agent.tool.result",
    payload: {
      sessionId: "session",
      messageId: "turn",
      toolCallId: "save",
      durationMs: 1,
      result: {
        kind: "watch.upserted",
        watchId: "watch",
        name: "Calibration watch",
        action: "created",
        enabled: true,
      },
    },
  });
  const result = await f.finalizer.finalize({ ...input, overflow: true });
  expect(result).toContain("watch created");
  expect(result).toContain(GROUNDING_UNKNOWN);
  expect(f.verify).not.toHaveBeenCalled();
  expect(JSON.stringify(f.diagnostics)).not.toContain("Calibration");
});

it("allows a supported conversational acknowledgment with user-statement evidence", async () => {
  const f = setup({ read: false });
  expect(await f.finalizer.finalize({ ...input, draft: "Hello!" })).toBe("Hello!");
  const packet = JSON.parse(JSON.parse(f.verify.mock.calls[0]![0].evidence).evidenceParts[1]);
  expect(packet.sources[0].title).toBe("Current user message");
  expect(f.verify.mock.calls[0]![0].context).toContain("not unstated external facts");
});

it("uses only a captured current root support packet and holds a changed root", async () => {
  let current = true;
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const finalizer = createAnswerGroundingFinalizer({
    reads: new CitationReads(),
    document: { fetch: async () => null },
    promptSupport: {
      evidence: [
        {
          text: '{"claim":"The calibration is complete","context":{"pageTitle":"Laboratory","sectionPaths":[["Completed work"]]}}',
        },
      ],
      current: () => current,
    },
    getVerifier: async () => ({ verify, dispose() {} }),
    repair: async () => "",
    diagnostic() {},
  })(identity);
  expect(await finalizer.finalize(input)).toBe(input.draft);
  expect(verify.mock.calls[0]![0].evidence).toContain("Completed work");
  verify.mockImplementation(async () => {
    current = false;
    return { label: "entailment" };
  });
  expect(await finalizer.finalize(input)).toBe(GROUNDING_CHANGED);
});

it("keeps prior user corrections as attributed user statements, never prior assistant proof", async () => {
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const finalizer = createAnswerGroundingFinalizer({
    reads: new CitationReads(),
    document: { fetch: async () => null },
    getVerifier: async () => ({ verify, dispose() {} }),
    repair: async () => "",
    diagnostic() {},
  })({ ...identity, priorUserStatements: ["I finished the calibration yesterday."] });
  await finalizer.finalize({ ...input, draft: "You said you finished it yesterday." });
  const packet = JSON.parse(JSON.parse(verify.mock.calls[0]![0].evidence).evidenceParts[1]);
  expect(packet.sources[1].text).toContain("I finished the calibration yesterday.");
});

it.each(["sql.rows", "subagent.joined"])(
  "preserves existing %s answers without a false verification stamp",
  async (kind) => {
    const f = setup({ read: false });
    // The observer accepts production ToolResult values; these fixtures isolate
    // the surface discriminator without invoking the underlying read service.
    const result =
      kind === "sql.rows"
        ? {
            kind: "sql.rows" as const,
            sql: "SELECT 1",
            columns: [],
            rows: [],
            rowCount: 0,
            durationMs: 1,
          }
        : { kind: "subagent.joined" as const, results: [] };
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "read",
        durationMs: 1,
        result,
      },
    });
    expect(await f.finalizer.finalize(input)).toBe(input.draft);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.diagnostics[0]?.status).toBe("not_applicable");
    expect(f.diagnostics[0]?.reason).toBe("unsupported_read_surface");
  },
);

it.each(["current", "stale"])(
  "retains root and individually qualified %s page support in separate bounded frames",
  async (validity) => {
    const document: DocumentPort = {
      fetch: async () => ({
        ref: { documentId: "page", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "omnesis" },
        readSnapshot: { documentId: "page", version: "v1" },
        document: {
          content: "Detailed page",
          knowledgeContext: {
            validity,
            verifiedSupport: [
              {
                ref: "wiki:detail#claim:one",
                revision: 1,
                text: "The prism calibration is complete.",
              },
            ],
          },
        },
      }),
    };
    const result = await document.fetch("page");
    const reads = new CitationReads();
    reads.record(identity, result!, true);
    const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
    const f = createAnswerGroundingFinalizer({
      reads,
      document,
      promptSupport: {
        evidence: Array.from({ length: 16 }, (_, i) => ({ text: `Root statement ${i}` })),
        current: () => true,
      },
      getVerifier: async () => ({ verify, dispose() {} }),
      repair: async () => "",
      diagnostic() {},
    })(identity);
    await f.finalize(input);
    const parts = JSON.parse(verify.mock.calls[0]![0].evidence).evidenceParts.map((part: string) =>
      JSON.parse(part),
    );
    expect(
      parts.flatMap((part: { verifiedReferences: unknown[] }) => part.verifiedReferences),
    ).toHaveLength(17);
    expect(
      parts.every(
        (part: { verifiedReferences: unknown[] }) => part.verifiedReferences.length <= 16,
      ),
    ).toBe(true);
  },
);

it.each([49, 100])(
  "verifies all %i observed loop summaries without treating list size as unsupported",
  async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({
      loopId: `loop-${i}`,
      title: `Calibration task ${i}`,
      state: "open",
    }));
    const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
    const diagnostic = vi.fn();
    const f = createAnswerGroundingFinalizer({
      reads: new CitationReads(),
      document: { fetch: async () => null },
      loops: {
        fetch: async () => null,
        search: async () => ({ query: "", loops: [], durationMs: 0 }),
        list: async () => ({ loops: rows, truncated: false, durationMs: 0 }),
        validateList: async () => true,
      },
      getVerifier: async () => ({ verify, dispose() {} }),
      repair: async () => "",
      diagnostic,
    })(identity);
    f.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "list",
        durationMs: 0,
        result: {
          kind: "structured",
          resultType: "loops.listed",
          data: {
            loops: rows,
            truncated: false,
            durationMs: 0,
            observation: {
              receiptId: "trusted-test-receipt",
              mode: "snapshot",
              observedAt: "2026-02-03T12:00:00.000Z",
              readScope: {
                states: ["open", "snoozed"],
                order: "importance_desc_id_desc",
                limit: count,
                population: "accessible_stored_records",
              },
            },
          },
        },
      },
    });
    expect(await f.finalize(input)).toContain(input.draft);
    expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ status: "supported" }));
    const parts = JSON.parse(verify.mock.calls[0]![0].evidence).evidenceParts.map((part: string) =>
      JSON.parse(part),
    );
    const inventory = parts
      .flatMap((part: { sources: Array<{ title: string; text: string }> }) => part.sources)
      .find(
        (source: { title: string }) =>
          source.title === "Recorded tracking snapshots (historical system state only)",
      );
    expect(JSON.parse(inventory.text)).toMatchObject([
      { loops: rows, returnedCount: count, truncated: false },
    ]);
    expect(verify.mock.calls[0]![0].context).not.toContain(rows[0]!.title);
  },
);

it.each([
  {
    data: {
      loops: [{ loopId: "large", title: "x".repeat(CONTEXTUAL_EVIDENCE_MAX_BYTES), state: "open" }],
      truncated: false,
    },
    reason: "evidence_budget",
  },
  { data: { loops: [{ loopId: "invalid" }], truncated: false }, reason: "unusable_read" },
])(
  "holds unusable covered loop lists instead of bypassing verification: $reason",
  async ({ data, reason }) => {
    const s = setup({ read: false });
    s.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "list",
        durationMs: 0,
        result: { kind: "structured", resultType: "loops.listed", data },
      },
    });
    expect(await s.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
    expect(s.verify).not.toHaveBeenCalled();
    expect(s.diagnostics.at(-1)).toMatchObject({ status: "unknown", reason });
  },
);

it("holds fetched-loop receipt overflow instead of dropping observed records", async () => {
  const s = setup({ read: false });
  for (let i = 0; i < 33; i++)
    s.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: `fetch-${i}`,
        durationMs: 0,
        result: {
          kind: "loop.fetched",
          loop: { loopId: `loop-${i}`, title: `Calibration ${i}`, state: "open" },
        },
      },
    });
  expect(await s.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(s.verify).not.toHaveBeenCalled();
  expect(s.diagnostics.at(-1)).toMatchObject({ status: "unknown", reason: "evidence_budget" });
});

it("holds too many observed source receipts before fetching or judging", async () => {
  const reads = new CitationReads();
  for (let i = 0; i < 33; i++)
    reads.record(
      identity,
      {
        ref: { documentId: `source-${i}`, sourceId: "fixture", sourceType: "fixture" },
        readSnapshot: { documentId: `source-${i}`, version: "one" },
        document: { content: "Calibration" },
      },
      true,
    );
  const fetch = vi.fn(async () => null);
  const getVerifier = vi.fn(async () => null);
  const diagnostic = vi.fn();
  const f = createAnswerGroundingFinalizer({
    reads,
    document: { fetch },
    getVerifier,
    repair: async () => "",
    diagnostic,
  })(identity);
  expect(await f.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(fetch).not.toHaveBeenCalled();
  expect(getVerifier).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ status: "unknown", reason: "source_budget" }),
  );
});

it.each(["entailment", "neutral"] as const)(
  "keeps mixed temporal/source answers checked with verdict %s",
  async (label) => {
    const f = setup();
    f.verify.mockResolvedValue({ label });
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "temporal",
        durationMs: 0,
        result: {
          kind: "structured",
          resultType: "temporal.results",
          data: { items: [{ sentence: "Unobserved temporal-only assertion" }] },
        },
      },
    });
    expect(await f.finalizer.finalize(input)).toBe(
      label === "entailment" ? input.draft : GROUNDING_UNKNOWN,
    );
    expect(f.verify).toHaveBeenCalled();
    expect(f.verify.mock.calls[0]![0].evidence).not.toContain("Unobserved temporal-only assertion");
    expect(f.verify.mock.calls[0]![0].context).toContain("discovery/navigation only");
    expect(f.diagnostics.at(-1)?.status).not.toBe("not_applicable");
  },
);

it.each([false, true])(
  "keeps temporal-only answers outside rollout without actual reads (root injected: %s)",
  async (root) => {
    const f = setup({ read: false, root });
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "temporal",
        durationMs: 0,
        result: { kind: "structured", resultType: "temporal.results", data: { items: [] } },
      },
    });
    expect(await f.finalizer.finalize(input)).toBe(input.draft);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.diagnostics.at(-1)).toMatchObject({
      status: "not_applicable",
      reason: "unsupported_read_surface",
    });
  },
);

it.each([
  { populated: false, label: "entailment" as const },
  { populated: true, label: "entailment" as const },
  { populated: false, label: "neutral" as const },
  { populated: true, label: "neutral" as const },
])("checks mixed person/source answers: %j", async ({ populated, label }) => {
  const f = setup({ read: false });
  f.verify.mockResolvedValue({ label });
  f.finalizer.observe({
    type: "agent.tool.result",
    payload: {
      sessionId: "session",
      messageId: "turn",
      toolCallId: "lookup",
      durationMs: 0,
      result: {
        kind: "person.results",
        query: "Maya",
        durationMs: 0,
        results: populated
          ? [
              {
                canonicalId: "person-fixture",
                displayName: "Fixture person",
                aliases: [],
                interactionScore: 1,
                annotations: [
                  {
                    claimType: "preference",
                    claim: "Unobserved person-only assertion",
                    confidence: 0.9,
                    verificationState: "verified",
                    evidenceDocId: "unread-source",
                  },
                ],
              },
            ]
          : [],
      },
    },
  });
  // The lookup precedes the actual original-source read, as the tool recommends.
  f.refreshRead();
  expect(await f.finalizer.finalize(input)).toBe(
    label === "entailment" ? input.draft : GROUNDING_UNKNOWN,
  );
  expect(f.verify).toHaveBeenCalled();
  expect(f.verify.mock.calls[0]![0].evidence).not.toContain("Unobserved person-only assertion");
  expect(f.verify.mock.calls[0]![0].evidence).not.toContain("unread-source");
  expect(f.verify.mock.calls[0]![0].context).toContain("person lookup results");
  expect(f.diagnostics.at(-1)?.status).not.toBe("not_applicable");
});

it.each([false, true])(
  "keeps person-only turns outside rollout without actual reads (root injected: %s)",
  async (root) => {
    const f = setup({ read: false, root });
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "lookup",
        durationMs: 0,
        result: { kind: "person.results", query: "Maya", durationMs: 0, results: [] },
      },
    });
    expect(await f.finalizer.finalize(input)).toBe(input.draft);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.diagnostics.at(-1)).toMatchObject({
      status: "not_applicable",
      reason: "unsupported_read_surface",
    });
  },
);

it("accepts a complete observed packet above64KiB within the shared contextual protocol budget", async () => {
  const f = setup({ body: "x".repeat(80_000) });
  expect(await f.finalizer.finalize(input)).toBe(input.draft);
  const request = f.verify.mock.calls[0]![0];
  expect(Buffer.byteLength(request.evidence)).toBeGreaterThan(65_536);
  expect(Buffer.byteLength(request.evidence) + Buffer.byteLength(request.context!)).toBeLessThan(
    CONTEXTUAL_EVIDENCE_MAX_BYTES,
  );
});

it("serializes observed loop details and action receipts once as scoped evidence", async () => {
  const reads = new CitationReads();
  const loop = {
    loopId: "calibration",
    title: "Calibrate prism",
    state: "open",
    description: "Unique calibration detail",
  };
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const f = createAnswerGroundingFinalizer({
    reads,
    document: { fetch: async () => null },
    loops: {
      fetch: async () => loop,
      list: async () => ({ loops: [], truncated: false, durationMs: 0 }),
      search: async () => ({ query: "", loops: [], durationMs: 0 }),
    },
    getVerifier: async () => ({ verify, dispose() {} }),
    repair: async () => "",
    diagnostic() {},
  })(identity);
  f.observe({
    type: "agent.tool.result",
    payload: {
      sessionId: "session",
      messageId: "turn",
      toolCallId: "loop",
      durationMs: 0,
      result: { kind: "loop.fetched", loop },
    },
  });
  f.observe({
    type: "agent.tool.result",
    payload: {
      sessionId: "session",
      messageId: "turn",
      toolCallId: "action",
      durationMs: 0,
      result: { kind: "structured", resultType: "annotation.created", data: {} },
    },
  });
  await f.finalize(input);
  const request = verify.mock.calls[0]![0];
  expect(request.evidence).toContain(loop.description);
  expect(request.evidence).toContain("annotation.created");
  expect(request.context).not.toContain(loop.description);
  expect(request.context).not.toContain("annotation.created");
  const frames = JSON.parse(request.evidence).evidenceParts.map((part: string) => JSON.parse(part));
  expect(
    frames
      .flatMap((frame: { sources: Array<{ authority?: string }> }) => frame.sources)
      .every((source: { authority?: string }) => source.authority === "whole_source"),
  ).toBe(true);
});

it("declares whole observed source and scoped conversation authority explicitly", async () => {
  const f = setup();
  await f.finalizer.finalize(input);
  const frames = JSON.parse(f.verify.mock.calls[0]![0].evidence).evidenceParts.map((part: string) =>
    JSON.parse(part),
  );
  expect(frames[0].sources[0]).toMatchObject({ authority: "whole_source", selectedQuotes: [] });
  expect(frames.at(-1).sources[0]).toMatchObject({
    authority: "whole_source",
    text: identity.question,
  });
  expect(frames.at(-1).limitation).toContain("only what the user stated or asked");
});

it("checks a selected observed paragraph from an oversized source instead of refusing the entire answer", async () => {
  const body =
    "Unrelated filler paragraph.\n\n".repeat(12000) +
    "This result is provisional.\n\nThe calibration finished on Monday.\n\nFurther measurements may change it.";
  const f = setup({ body });
  expect(await f.finalizer.finalize(input)).toBe(input.draft);
  const request = f.verify.mock.calls[0]![0];
  const frame = JSON.parse(JSON.parse(request.evidence).evidenceParts[0]);
  expect(frame.sources[0].authority).toBe("selected_quote");
  expect(frame.sources[0].selectedQuotes.join(" ")).toContain("This result is provisional.");
  expect(frame.sources[0].selectedQuotes.join(" ")).toContain(
    "Further measurements may change it.",
  );
  expect(frame.limitation).toContain("omitted passages were not checked");
  expect(Buffer.byteLength(request.evidence) + Buffer.byteLength(request.context!)).toBeLessThan(
    CONTEXTUAL_EVIDENCE_MAX_BYTES,
  );
});

it.each([false, true])(
  "binds successful batch citation anchors to the observed source revision (changed: %s)",
  async (changed) => {
    const quote = "Cobalt procedure accepted.";
    const f = setup({
      body:
        "Unrelated filler paragraph.\n\n".repeat(12000) +
        "Laboratory restriction.\n\n" +
        quote +
        "\n\nTrial only.",
    });
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        sessionId: "session",
        messageId: "turn",
        toolCallId: "cite",
        durationMs: 0,
        result: {
          kind: "annotate.batch",
          items: [
            {
              kind: "annotate.recorded",
              documentId: "source",
              ref: { documentId: "source", sourceId: "fixture", sourceType: "fixture" },
              quote,
            },
            { kind: "error", code: "citation_read_required", message: "No citation" },
          ],
        },
      },
    });
    if (changed) {
      f.change();
      f.refreshRead();
    }
    expect(await f.finalizer.finalize(input)).toBe(changed ? GROUNDING_UNKNOWN : input.draft);
    if (changed) expect(f.verify).not.toHaveBeenCalled();
    else expect(f.verify.mock.calls[0]![0].evidence).toContain(quote);
  },
);

it("does not invalidate a source answer for an unused root orientation packet", async () => {
  let current = true;
  const f = setup({ promptSupport: { evidence: [], current: () => current } });
  f.verify.mockImplementation(async () => {
    current = false;
    return { label: "entailment" };
  });
  expect(await f.finalizer.finalize(input)).toBe(input.draft);
  expect(f.diagnostics[0]?.status).toBe("supported");
});

it.each([
  "response_format",
  "assessment_schema",
  "positive_witness_missing",
  "witness_outside_authority",
] as const)("reports a content-free verifier protocol failure: %s", async (category) => {
  const f = setup();
  f.verify.mockRejectedValue(new ContextualAssessmentError(category, "fixture-model"));
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(f.diagnostics[0]?.reason).toBe(`verification_protocol_${category}`);
  expect(f.diagnostics[0]?.checks).toEqual([
    { outcome: "protocol_error", protocolFailure: category },
  ]);
  expect(f.repair).not.toHaveBeenCalled();
});

it("does not copy arbitrary verifier error text into diagnostics", async () => {
  const f = setup();
  f.verify.mockRejectedValue(new Error("private response contents"));
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(f.diagnostics[0]?.reason).toBe("verification_unavailable");
  expect(f.diagnostics[0]?.checks).toEqual([{ outcome: "unavailable" }]);
  expect(JSON.stringify(f.diagnostics)).not.toContain("private response contents");
});

it.each([false, true])(
  "never passes through an unbound Knowledge read (other covered reads: %s)",
  async (mixed) => {
    const f = setup({ read: mixed });
    f.finalizer.observe({
      type: "agent.tool.result",
      payload: {
        ...identity,
        toolCallId: "wiki",
        durationMs: 0,
        result: {
          kind: "structured",
          resultType: "knowledge_fetch",
          data: {
            id: "wiki_example",
            kind: "wiki",
            plainText: "The prism caused the launch.",
          },
        },
      },
    });
    if (mixed)
      f.finalizer.observe({
        type: "agent.tool.result",
        payload: {
          ...identity,
          toolCallId: "loop",
          durationMs: 0,
          result: {
            kind: "loop.fetched",
            loop: {
              loopId: "loop_example",
              title: "Calibration",
              state: "open",
              actors: [],
              involved: [],
              docIds: [],
              ledger: [],
            },
          },
        },
      });
    expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.diagnostics.at(-1)).toMatchObject({
      status: "unknown",
      reason: "unsupported_evidence_receipt",
      attempts: 0,
    });
  },
);

it("does not release unchecked mixed source and SQL prose", async () => {
  const f = setup();
  f.finalizer.observe({
    type: "agent.tool.result",
    payload: {
      ...identity,
      toolCallId: "sql",
      durationMs: 0,
      result: {
        kind: "sql.rows",
        sql: "SELECT 1",
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
      },
    },
  });
  expect(await f.finalizer.finalize(input)).toBe(GROUNDING_UNKNOWN);
  expect(f.diagnostics.at(-1)?.status).toBe("unknown");
  expect(f.verify).not.toHaveBeenCalled();
});

it("releases through actual source-bound segment parsing without copied source quotes", async () => {
  const reads = new CitationReads();
  const source: DocumentPortResult = {
    ref: { documentId: "source", sourceId: "fixture", sourceType: "fixture" },
    readSnapshot: { documentId: "source", version: "v1" },
    document: { title: "Laboratory", content: '**Note:** proposed\n> Inspect the "prism".' },
  };
  reads.record(identity, source, true);
  const complete = vi.fn().mockImplementation(async (prompt: string) => {
    const packet = JSON.parse(prompt.split("\n").at(-1)!);
    const source = packet.evidenceParts[0].sources[0];
    expect(source.text.map((s: { text: string }) => s.text).join("")).toBe(
      '**Note:** proposed\n> Inspect the "prism".',
    );
    return {
      text: JSON.stringify({
        witnessSet: packet.witnessSet,
        contentInContext: {
          verdict: "supported",
          evidenceSegments: [source.text[0].id],
          reason: "Qualified recorded proposal.",
        },
        placementSupport: {
          verdict: "not_applicable",
          evidenceSegments: [],
          reason: "Generic scope.",
        },
      }),
      usage: null,
    };
  });
  const verifier = new LlmJudgeEntailmentVerifier({
    completer: { modelId: "scripted", complete, dispose() {} },
    getPromptStyle: () => "judge",
  });
  const finalizer = createAnswerGroundingFinalizer({
    reads,
    document: { fetch: vi.fn().mockResolvedValue(source) },
    getVerifier: async () => verifier,
    repair: vi.fn(),
    diagnostic: vi.fn(),
  })(identity);
  const draft = "A proposed prism inspection is recorded.";
  expect(await finalizer.finalize({ ...input, draft })).toBe(draft);
  expect(complete).toHaveBeenCalledTimes(1);
});

it("gives an Answer the host's clock, marked as a default", async () => {
  const f = setup();
  await f.finalizer.finalize(input);
  const clock = JSON.parse(f.verify.mock.calls[0]![0].context!).callerClock;
  expect(clock).toBe(renderCallerZoneBlock(undefined));
  expect(clock).toContain("gateway host's");
});

it.each(["full", "partial", "changed-proof", "same-bytes-changed-proof"] as const)(
  "uses stable qualified authority only for a complete page after maintenance: %s",
  async (mode) => {
    let version = "before";
    let authority = "proof-one";
    const document: DocumentPort = {
      fetch: async () => ({
        ref: { documentId: "page", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "omnesis" },
        readSnapshot: { documentId: "page", version, fullPageAuthorityVersion: authority },
        document: {
          content: "The prism calibration finished.",
          knowledgeContext: {
            validity: "current",
            verifiedSupport: [
              {
                text: "The prism calibration finished.",
                revision: 1,
                ref: "wiki:prism#claim:calibration",
              },
            ],
          },
        },
      }),
    };
    const reads = new CitationReads();
    reads.record(identity, (await document.fetch("page"))!, mode !== "partial", {
      offset: 0,
      length: 5,
    });
    version = mode === "same-bytes-changed-proof" ? "before" : "after";
    if (mode === "changed-proof" || mode === "same-bytes-changed-proof") authority = "proof-two";
    const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
    const finalizer = createAnswerGroundingFinalizer({
      reads,
      document,
      getVerifier: async () => ({ verify, dispose() {} }),
      repair: async () => "",
      diagnostic() {},
    })(identity);
    const result = await finalizer.finalize(input);
    expect(result).toBe(mode === "full" ? input.draft : GROUNDING_CHANGED);
    expect(verify).toHaveBeenCalledTimes(mode === "full" ? 1 : 0);
  },
);

it("passes only fully observed attributed conversation units to the actual answer verification seam", async () => {
  const body = "I enjoy mineral collecting.\nThe survey grant was approved.";
  const sourceEvidenceAuthority = {
    policy: "attributed_utterances" as const,
    available: true,
    utterances: [
      { role: "user" as const, start: 0, end: 26 },
      { role: "assistant" as const, start: 27, end: body.length },
    ],
  };
  const f = setup({
    body,
    sourceEvidenceAuthority,
    span: { offset: 27, length: body.length - 27 },
  });
  await f.finalizer.finalize(input);
  const frames = JSON.parse(f.verify.mock.calls[0]![0].evidence).evidenceParts.map((part: string) =>
    JSON.parse(part),
  );
  expect(
    frames
      .flatMap((frame: { sources: Array<{ documentId?: string }> }) => frame.sources)
      .filter((source: { documentId?: string }) => source.documentId),
  ).toEqual([]);
  const refs = frames.flatMap(
    (frame: { verifiedReferences: Array<{ text: string; wholeStatementOnly: boolean }> }) =>
      frame.verifiedReferences,
  );
  expect(refs).toHaveLength(1);
  expect(refs[0].wholeStatementOnly).toBe(true);
  expect(refs[0].text).toContain("recorded assistant utterance");
  expect(refs[0].text).not.toContain("mineral collecting");
  const partial = setup({ body, sourceEvidenceAuthority, span: { offset: 27, length: 8 } });
  await partial.finalizer.finalize(input);
  expect(partial.verify.mock.calls[0]![0].evidence).not.toContain("survey grant");
  const unavailable = setup({
    body,
    sourceEvidenceAuthority: { ...sourceEvidenceAuthority, available: false },
  });
  await unavailable.finalizer.finalize(input);
  expect(unavailable.verify.mock.calls[0]![0].evidence).not.toContain("survey grant");
});

it.each(["full", "partial", "changed-during-verification"])(
  "keeps exact observation and post-verification fences for stale-page support: %s",
  async (mode) => {
    let version = "snapshot-one";
    const document: DocumentPort = {
      fetch: async () => ({
        ref: { documentId: "page", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "omnesis" },
        readSnapshot: { documentId: "page", version },
        document: {
          content: "Orientation prose with a stale sibling.",
          knowledgeContext: {
            validity: "stale",
            verifiedSupport: [
              {
                ref: "wiki:page#claim:steady",
                revision: 1,
                text: "The prism calibration finished.",
              },
            ],
          },
        },
      }),
    };
    const reads = new CitationReads();
    reads.record(identity, (await document.fetch("page"))!, mode !== "partial", {
      offset: 0,
      length: 5,
    });
    const verify = vi.fn<EntailCapability["verify"]>().mockImplementation(async () => {
      if (mode === "changed-during-verification") version = "snapshot-two";
      return { label: "entailment" };
    });
    const f = createAnswerGroundingFinalizer({
      reads,
      document,
      getVerifier: async () => ({ verify, dispose() {} }),
      repair: async () => "",
      diagnostic() {},
    })(identity);
    const result = await f.finalize(input);
    if (mode === "full") expect(result).toBe(input.draft);
    if (mode === "changed-during-verification") expect(result).toBe(GROUNDING_CHANGED);
    if (mode === "partial") {
      // The current user question remains independently available; the page
      // subset must not enter the packet without a complete page read.
      expect(verify.mock.calls[0]![0].evidence).not.toContain("prism calibration");
    } else {
      expect(verify.mock.calls[0]![0].evidence).toContain("prism calibration");
      expect(verify.mock.calls[0]![0].evidence).not.toContain("stale sibling");
    }
  },
);

it("separates current qualified loop facts from state and enclosing unverified prose", async () => {
  const loop = {
    loopId: "lens",
    title: "Install lens",
    state: "open",
    description: "The lens may be installed. An unverified sibling claims the dome is finished.",
    knowledgeContext: {
      nodeId: "lens",
      kind: "loop",
      revision: 1,
      validity: "current",
      verifiedSupport: [
        {
          ref: "loop:lens#claim:permission",
          revision: "proof-one",
          text: JSON.stringify({
            statement: "The lens may be installed.",
            semantics: {
              modality: "possibility",
              attribution: "Inspector",
              validFrom: 10,
              validUntil: 20,
            },
          }),
          interpretationContext: JSON.stringify({
            outcome: {
              text: "Only after inspection. An unverified sibling claims the dome is finished.",
            },
          }),
        },
      ],
    },
  };
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const f = createAnswerGroundingFinalizer({
    reads: new CitationReads(),
    document: { fetch: async () => null },
    loops: {
      fetch: async () => loop,
      list: async () => ({ loops: [], truncated: false, durationMs: 0 }),
      search: async () => ({ query: "", loops: [], durationMs: 0 }),
    },
    getVerifier: async () => ({ verify, dispose() {} }),
    repair: async () => "",
    diagnostic() {},
  })(identity);
  f.observe({
    type: "agent.tool.result",
    payload: {
      sessionId: "session",
      messageId: "turn",
      toolCallId: "fetch",
      durationMs: 0,
      result: { kind: "loop.fetched", loop },
    },
  });
  expect(
    await f.finalize({
      ...input,
      draft: "The inspector permits installation after inspection, within the stated period.",
    }),
  ).toBe("The inspector permits installation after inspection, within the stated period.");
  const frames = JSON.parse(verify.mock.calls[0]![0].evidence).evidenceParts.map((part: string) =>
    JSON.parse(part),
  );
  const qualified = frames.flatMap(
    (frame: { verifiedReferences: Array<{ text: string; interpretationContext?: string }> }) =>
      frame.verifiedReferences,
  );
  expect(qualified).toEqual([
    {
      text: loop.knowledgeContext.verifiedSupport[0]!.text,
      interpretationContext: loop.knowledgeContext.verifiedSupport[0]!.interpretationContext,
    },
  ]);
  expect(qualified[0]!.text).not.toContain("dome");
  expect(qualified[0]!.text).not.toContain("Install lens");
  expect(qualified[0]!.text).not.toContain('"state":"open"');
  expect(
    frames.find((frame: { verifiedReferences: unknown[] }) => frame.verifiedReferences.length)
      ?.limitation,
  ).toContain("not proof of current real-world obligations");
});

it("records only closed negative facets and never copies rejection reasons or candidate text", async () => {
  const f = setup();
  f.verify.mockResolvedValue({
    label: "neutral",
    raw: JSON.stringify({
      witnessSet: "opaque-binding",
      contentInContext: {
        verdict: "unsupported",
        evidenceSegments: [],
        reason: "private model explanation",
      },
      placementSupport: {
        verdict: "contradicted",
        evidenceSegments: [],
        reason: "private relationship explanation",
      },
    }),
  });
  expect(await f.finalizer.finalize({ ...input, draft: "private candidate sentence" })).toBe(
    GROUNDING_UNKNOWN,
  );
  expect(f.diagnostics[0]).toMatchObject({
    reason: "unsupported_after_repair",
    attempts: 2,
    repairTrigger: "semantic",
  });
  expect(f.diagnostics[0]?.checks).toEqual(
    [1, 2].map(() => ({
      outcome: "rejected",
      label: "neutral",
      probabilityThreshold: "default_pass",
      negativeFacets: [
        { check: "content_in_context", verdict: "unsupported" },
        { check: "placement_support", verdict: "contradicted" },
      ],
    })),
  );
  expect(JSON.stringify(f.diagnostics)).not.toMatch(/private|opaque-binding|calibration/i);
});

it.each([undefined, 0.5, 0.49, Number.NaN])(
  "reports the existing entailment probability threshold for %s",
  async (probability) => {
    const f = setup();
    f.verify.mockResolvedValue({ label: "entailment", probability });
    const accepted = (probability ?? 1) >= 0.5;
    expect(await f.finalizer.finalize(input)).toBe(accepted ? input.draft : GROUNDING_UNKNOWN);
    expect(f.diagnostics[0]?.checks[0]).toMatchObject({
      outcome: accepted ? "accepted" : "rejected",
      probabilityThreshold: probability === undefined ? "default_pass" : accepted ? "pass" : "fail",
    });
    expect(f.verify).toHaveBeenCalledTimes(accepted ? 1 : 2);
  },
);

it.each(["full", "partial", "changed-proof", "hidden"] as const)(
  "keeps repair citation metadata separate from proof and rechecks its read: %s",
  async (mode) => {
    let authority = "proof-one";
    let visible = true;
    const result = (): DocumentPortResult => ({
      ref: { documentId: "projection", sourceId: KNOWLEDGE_SOURCE_ID, sourceType: "omnesis" },
      readSnapshot: {
        documentId: "projection",
        version: "bytes",
        fullPageAuthorityVersion: authority,
      },
      document: {
        content: "The prism calibration finished.",
        title: "An unverified title assertion",
        knowledgeContext: {
          nodeId: "prism",
          kind: "wiki",
          validity: "current",
          verifiedSupport: [
            {
              ref: "wiki:prism#claim:calibration",
              revision: 1,
              text: "The prism calibration finished.",
            },
          ],
        },
      },
    });
    const reads = new CitationReads();
    reads.record(identity, result(), mode !== "partial", { offset: 0, length: 5 });
    const reason =
      "The initial explanation needs correction. ".repeat(20) + "Preserve the stated condition.";
    const verify = vi.fn<EntailCapability["verify"]>().mockImplementation(async (request) => {
      const prepared = prepareAnswerWitnessRequest(request);
      expect([...prepared.segments.values()]).not.toContain("wiki:prism");
      expect(prepared.prompt).not.toContain("citationNavigation");
      expect(prepared.prompt).not.toContain("An unverified title assertion");
      const forged = JSON.stringify({
        witnessSet: prepared.witnessSet,
        contentInContext: {
          verdict: "supported",
          evidenceSegments: ["wiki:prism"],
          reason: "A navigation handle is not a witness.",
        },
        placementSupport: {
          verdict: "not_applicable",
          evidenceSegments: [],
          reason: "No placement.",
        },
      });
      expect(parseAnswerWitnessVerdict(forged, prepared)).toBeNull();
      return verify.mock.calls.length === 1
        ? {
            label: "neutral",
            raw: JSON.stringify({
              witnessSet: prepared.witnessSet,
              contentInContext: { verdict: "unsupported", evidenceSegments: [], reason },
              placementSupport: {
                verdict: "not_applicable",
                evidenceSegments: [],
                reason: "No placement.",
              },
            }),
          }
        : { label: "entailment" };
    });
    const repair = vi.fn(async (prompt: string) => {
      const packet = JSON.parse(prompt.split("\n").at(-1)!);
      expect(packet.diagnostic[0].reason).toBe(reason);
      expect(packet.evidence).toBe(verify.mock.calls[0]![0].evidence);
      expect(packet.context).toBe(verify.mock.calls[0]![0].context);
      expect(packet.citationNavigation).toEqual({
        pages:
          mode === "partial"
            ? []
            : [
                {
                  documentId: "projection",
                  pageRef: "wiki:prism",
                  supportedClaimRefs: ["wiki:prism#claim:calibration"],
                },
              ],
        incomplete: false,
      });
      if (mode === "changed-proof") authority = "proof-two";
      if (mode === "hidden") visible = false;
      return mode === "partial"
        ? "I cannot establish that from this partial read."
        : `The prism calibration finished. [Calibration](${packet.citationNavigation.pages[0].pageRef})`;
    });
    const diagnostics: AnswerGroundingDiagnostic[] = [];
    const finalizer = createAnswerGroundingFinalizer({
      reads,
      document: { fetch: async () => (visible ? result() : null) },
      getVerifier: async () => ({ verify, dispose() {} }),
      repair,
      diagnostic: (value) => diagnostics.push(value),
    })(identity);
    const answer = await finalizer.finalize({ ...input, draft: "Initial explanation." });
    if (mode === "changed-proof" || mode === "hidden") {
      expect(answer).toBe(GROUNDING_CHANGED);
      expect(verify).toHaveBeenCalledTimes(1);
    } else {
      expect(answer).toBe(
        mode === "partial"
          ? "I cannot establish that from this partial read."
          : "The prism calibration finished. [Calibration](wiki:prism)",
      );
      expect(verify).toHaveBeenCalledTimes(2);
      expect(verify.mock.calls[1]![0].evidence).toBe(verify.mock.calls[0]![0].evidence);
    }
    expect(JSON.stringify(diagnostics)).not.toContain(reason);
    expect(JSON.stringify(diagnostics)).not.toContain("wiki:prism");
  },
);
