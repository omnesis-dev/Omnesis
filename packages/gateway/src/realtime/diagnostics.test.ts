// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeDiagnostics } from "./diagnostics.js";

afterEach(() => vi.useRealTimers());

describe("realtime protocol diagnostics", () => {
  it("separates transcription, first audio, response phases and tool execution without logging content", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lines: string[] = [];
    const diagnostics = new RealtimeDiagnostics((line) => lines.push(line));
    diagnostics.upstream({ type: "input_audio_buffer.speech_stopped", item_id: "fixture-audio" });
    vi.setSystemTime(200);
    diagnostics.upstream({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "fixture-audio",
      transcript: "PRIVATE_SENTINEL",
    });
    diagnostics.request();
    vi.setSystemTime(700);
    diagnostics.upstream({ type: "response.output_audio.delta", delta: "AAAAAA==" });
    vi.setSystemTime(4200);
    diagnostics.upstream({
      type: "response.done",
      response: {
        status: "completed",
        output: [
          { type: "message", phase: "commentary", content: [{ transcript: "PRIVATE_SENTINEL" }] },
          { type: "function_call", name: "PRIVATE_SENTINEL", arguments: "PRIVATE_SENTINEL" },
        ],
        usage: { input_tokens: 32, input_token_details: { cached_tokens: 16 } },
      },
    });
    diagnostics.agent({
      type: "agent.tool.start",
      payload: {
        sessionId: "fixture-session",
        messageId: "fixture-message",
        toolCallId: "fixture-call",
        tool: "PRIVATE_SENTINEL",
        args: { private: "PRIVATE_SENTINEL" },
      },
    });
    diagnostics.agent({
      type: "agent.tool.result",
      payload: {
        sessionId: "fixture-session",
        messageId: "fixture-message",
        toolCallId: "fixture-call",
        result: { kind: "error", code: "fixture", message: "PRIVATE_SENTINEL" },
        durationMs: 80,
      },
    });
    expect(lines).toContain("transcription complete afterSpeechMs=200");
    expect(lines.join("\n")).toContain(
      "durationMs=4000 firstAudioMs=500 audioBytes=4 toolCalls=1 commentary=true finalAnswer=false inputTokens=32 cachedTokens=16",
    );
    expect(lines).toContain("tool completed ordinal=1 durationMs=80");
    expect(lines.join("\n")).not.toContain("PRIVATE_SENTINEL");

    diagnostics.request();
    diagnostics.upstream({
      type: "response.done",
      response: { status: "completed", output: [{ type: "message", phase: "final_answer" }] },
    });
    expect(lines.at(-1)).toContain("round=2");
    expect(lines.at(-1)).toContain(
      "firstAudioMs=none audioBytes=0 toolCalls=0 commentary=false finalAnswer=true",
    );
  });

  it("does not expose unknown provider status or error messages", () => {
    const lines: string[] = [];
    const diagnostics = new RealtimeDiagnostics((line) => lines.push(line));
    diagnostics.upstream({ type: "response.done", response: { status: "PRIVATE_SENTINEL" } });
    diagnostics.upstream({ type: "error", error: { message: "PRIVATE_SENTINEL" } });
    expect(lines).toEqual([]);
  });
});
