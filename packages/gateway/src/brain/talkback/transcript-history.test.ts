// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { transcriptToHistory } from "./transcript-history.js";
import type { CognitionRunTranscript } from "../transcripts.js";

function transcript(
  events: Array<{ type: string; payload: unknown }>,
  overrides: Partial<CognitionRunTranscript> = {},
): CognitionRunTranscript {
  return {
    runId: "run_1",
    attempt: 1,
    kind: "data",
    startedAt: 1_000,
    finishedAt: 2_000,
    prompt: "Loop agent run run_1 (kind: data, attempt 1).",
    events,
    finalText: "",
    outcome: "completed",
    usage: null,
    ...overrides,
  };
}

describe("transcriptToHistory", () => {
  test("folds deltas, tool calls, and results into replay-valid history", () => {
    const result = { kind: "search.results", query: "q", durationMs: 1, results: [] };
    const history = transcriptToHistory(
      transcript([
        { type: "agent.message.start", payload: {} },
        { type: "agent.thinking.delta", payload: { delta: "hmm " } },
        { type: "agent.text.delta", payload: { delta: "Let me " } },
        { type: "agent.text.delta", payload: { delta: "check." } },
        { type: "agent.tool.input_start", payload: { toolCallId: "t1", tool: "search_documents" } },
        {
          type: "agent.tool.start",
          payload: { toolCallId: "t1", tool: "search_documents", args: { query: "q" } },
        },
        { type: "agent.tool.result", payload: { toolCallId: "t1", result, durationMs: 1 } },
        { type: "agent.text.delta", payload: { delta: "Done — nothing new." } },
        { type: "agent.message.end", payload: { stopReason: "end_turn" } },
      ]),
    );

    expect(history).toEqual([
      {
        role: "user",
        parts: [{ kind: "text", text: "Loop agent run run_1 (kind: data, attempt 1)." }],
      },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: "hmm " },
          { kind: "text", text: "Let me check." },
          { kind: "tool_use", toolCallId: "t1", tool: "search_documents", args: { query: "q" } },
        ],
      },
      { role: "user", parts: [{ kind: "tool_result", toolCallId: "t1", result }] },
      { role: "assistant", parts: [{ kind: "text", text: "Done — nothing new." }] },
    ]);
  });

  test("orphan thinking deltas are dropped; input_start never becomes a tool_use", () => {
    const history = transcriptToHistory(
      transcript(
        [
          { type: "agent.thinking.delta", payload: { delta: "pondering" } },
          { type: "agent.tool.input_start", payload: { toolCallId: "t9", tool: "run_sql" } },
          { type: "agent.error", payload: { code: "x", message: "boom" } },
          { type: "agent.message.end", payload: { stopReason: "error" } },
        ],
        { finalText: "", outcome: "failed" },
      ),
    );
    // Only the prompt survives — no assistant content existed.
    expect(history).toEqual([
      {
        role: "user",
        parts: [{ kind: "text", text: "Loop agent run run_1 (kind: data, attempt 1)." }],
      },
    ]);
  });

  test("a run whose only assistant output is finalText still closes on assistant words", () => {
    const history = transcriptToHistory(
      transcript([{ type: "agent.message.end", payload: { stopReason: "end_turn" } }], {
        finalText: "No action needed.",
      }),
    );
    expect(history.at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: "No action needed." }],
    });
  });

  test("plaintext and opaque reasoning on a tool call survive the round trip", () => {
    const details = [
      { type: "reasoning.text", text: "example trace", signature: "example-signature" },
      { type: "reasoning.encrypted", data: "example-opaque-data" },
    ];
    const history = transcriptToHistory(
      transcript([
        { type: "agent.thinking.delta", payload: { delta: "exact " } },
        { type: "agent.thinking.delta", payload: { delta: "trace" } },
        {
          type: "agent.tool.start",
          payload: {
            toolCallId: "t1",
            tool: "plan",
            args: {},
            extraContent: { sig: "abc" },
            reasoningDetails: details,
          },
        },
        {
          type: "agent.tool.result",
          payload: { toolCallId: "t1", result: { kind: "text", text: "ok" } },
        },
      ]),
    );
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant?.parts[0]).toEqual({ kind: "thinking", text: "exact trace" });
    expect(assistant?.parts[1]).toMatchObject({
      kind: "tool_use",
      toolCallId: "t1",
      extraContent: { sig: "abc" },
      reasoningDetails: details,
    });
  });
});
