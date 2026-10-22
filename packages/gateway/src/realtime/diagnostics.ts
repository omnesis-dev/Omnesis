// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { AgentEvent } from "@omnesis/core";
import type { UpstreamEvent } from "./backend.js";

const responseSummary = z.object({
  response: z.object({
    status: z.enum(["completed", "cancelled", "failed", "incomplete", "in_progress"]).optional(),
    output: z.array(z.object({ type: z.string(), phase: z.string().optional() })).optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        input_token_details: z
          .object({ cached_tokens: z.number().int().nonnegative().optional() })
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});

/** Timing and protocol metadata only: no audio, transcript, arguments, results or provider errors. */
export class RealtimeDiagnostics {
  private requests = 0;
  private requestedAt = 0;
  private firstAudioAt: number | undefined;
  private audioBytes = 0;
  private readonly speechStops = new Map<string, number>();
  private readonly tools = new Map<string, number>();
  private toolCount = 0;

  constructor(private readonly write: (message: string) => void) {}

  request(): void {
    this.requests += 1;
    this.requestedAt = Date.now();
    this.firstAudioAt = undefined;
    this.audioBytes = 0;
    this.write(`response requested round=${this.requests}`);
  }

  upstream(event: UpstreamEvent): void {
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
    if (event.type === "input_audio_buffer.speech_stopped" && itemId && this.speechStops.size < 4)
      this.speechStops.set(itemId, Date.now());
    if (event.type === "conversation.item.input_audio_transcription.completed" && itemId) {
      const stoppedAt = this.speechStops.get(itemId);
      if (stoppedAt !== undefined)
        this.write(`transcription complete afterSpeechMs=${Date.now() - stoppedAt}`);
      this.speechStops.delete(itemId);
    }
    if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
      this.firstAudioAt ??= Date.now();
      this.audioBytes += Buffer.byteLength(event.delta, "base64");
    }
    if (event.type !== "response.done") return;
    const parsed = responseSummary.safeParse(event);
    if (!parsed.success) return;
    const { output = [], usage, status = "unknown" } = parsed.data.response;
    this.write(
      `response completed round=${this.requests} status=${status} durationMs=${Date.now() - this.requestedAt} firstAudioMs=${this.firstAudioAt === undefined ? "none" : this.firstAudioAt - this.requestedAt} audioBytes=${this.audioBytes} toolCalls=${output.filter((item) => item.type === "function_call").length} commentary=${output.some((item) => item.phase === "commentary")} finalAnswer=${output.some((item) => item.phase === "final_answer")} inputTokens=${usage?.input_tokens ?? 0} cachedTokens=${usage?.input_token_details?.cached_tokens ?? 0}`,
    );
  }

  agent(event: AgentEvent): void {
    if (event.type === "agent.tool.start") {
      const ordinal = ++this.toolCount;
      this.tools.set(event.payload.toolCallId, ordinal);
      this.write(`tool started ordinal=${ordinal}`);
    }
    if (event.type === "agent.tool.result") {
      const ordinal = this.tools.get(event.payload.toolCallId) ?? "unknown";
      this.tools.delete(event.payload.toolCallId);
      this.write(`tool completed ordinal=${ordinal} durationMs=${event.payload.durationMs ?? 0}`);
    }
    if (event.type === "agent.message.end") {
      this.tools.clear();
      this.write(
        `turn ended stopReason=${event.payload.stopReason} failure=${event.payload.failure?.code ?? "none"}`,
      );
    }
  }
}
