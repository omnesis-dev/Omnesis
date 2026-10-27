// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { terminalCallError, callError, type RealtimeCallError } from "./call-error.js";
import type { ChatMessage } from "@omnesis/agent";
import type { VoiceAgentSession } from "../agent/voice-session.js";
import type { LiveProviderCommand, LiveProviderEvent, LiveTextMessage } from "./live-provider.js";

export const LIVE_INSTRUCTIONS = `You are the spoken interface to the user's Omnesis agent.
The backend is the authority for research, private facts, tools, citations and actions. Delegate every substantive request, follow-up, correction or action to it. Wait until the user's intent is clear; if speech is incomplete or ambiguous, ask a brief clarification. Never invent an answer or claim an action happened without the backend result. If a result does not answer the complete request, delegate again rather than guessing.
Use the user's last clearly established language. Keep speech concise and natural. Do not read Markdown, URLs, tool syntax or citation markers aloud. The app displays the backend's actual tools and citations.
Give at most one short acknowledgment if useful, then wait quietly for the backend. Do not repeat progress, promise more work after the result, or speak to fill silence. Commentary supplied by the application contains verified results to communicate. Speaking interruption alone does not cancel backend work. Do not greet before the caller speaks.`;

const transcript = z
  .object({
    event_id: z.string().min(1).max(256),
    delta: z.string().max(64 * 1024),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative(),
  })
  .refine((value) => value.end_ms >= value.start_ms);
const delegation = z.object({
  delegation: z.object({ id: z.string().min(1).max(256), target: z.literal("client") }),
  offset_ms: z.number().nonnegative(),
});

/** A byte upper bound also bounds byte-pair tokens, including non-Latin text. */
export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let length = 0;
    let end = 0;
    let boundary = 0;
    for (const character of remaining) {
      const next = Buffer.byteLength(character);
      if (length + next > 480) break;
      length += next;
      end += character.length;
      if (/\s|[.!?;:]/u.test(character)) boundary = end;
    }
    const cut = end === remaining.length ? end : boundary || end;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

/** Only recent visible text seeds speech; the configured agent retains full canonical context. */
export function liveHistory(history: ReadonlyArray<ChatMessage>): LiveTextMessage[] {
  const result: LiveTextMessage[] = [];
  let bytes = 0;
  for (const message of [...history].reverse()) {
    const text = message.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
    if (!text) continue;
    const size = Buffer.byteLength(text);
    if (bytes + size > 8192 || result.length >= 32) break;
    bytes += size;
    result.unshift({ role: message.role, content: [{ type: "input_text", text }] });
  }
  return result;
}

interface ConversationHost {
  agent: VoiceAgentSession;
  callId: string;
  send(event: LiveProviderCommand): void;
  fail(error: RealtimeCallError): void;
  replyFailure(error: RealtimeCallError | undefined): void;
  authorized?(): boolean;
}

/** Delegation is an execution request, not a transcript boundary or a second agent turn. */
export class LiveConversation {
  private enabled = false;
  private closed = false;
  private scheduled = false;
  private revision = 0;
  private inputRevision = 0;
  private currentDelegation:
    | { id: string; offset: number; firstInputRevision?: number }
    | undefined;
  private latestTask: { delegationId: string; inputRevision: number } | undefined;
  private readonly seenTranscripts = new Set<string>();
  private readonly seenDelegations = new Set<string>();
  private callerFragments: Array<{ text: string; start: number; end: number; id: string }> = [];
  private spokenContext = "";

  constructor(private readonly host: ConversationHost) {}

  ready(): void {
    if (this.closed) return;
    this.enabled = true;
    this.schedule();
  }

  stop(): void {
    this.closed = true;
    this.currentDelegation = undefined;
    this.callerFragments = [];
    this.spokenContext = "";
  }

  receive(event: LiveProviderEvent): void {
    if (this.closed) return;
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      const parsed = transcript.safeParse(event);
      if (!parsed.success) return this.host.fail(callError("protocol_error"));
      const part = parsed.data;
      if (this.seenTranscripts.has(part.event_id)) return;
      if (this.seenTranscripts.size >= 20_000)
        return this.host.fail(callError("call_limit_reached"));
      this.seenTranscripts.add(part.event_id);
      if (event.type === "session.input_transcript.delta") {
        if (
          this.callerFragments.reduce((size, fragment) => size + fragment.text.length, 0) +
            part.delta.length >
          10_000
        )
          return this.host.fail(callError("protocol_error"));
        // Preserve repetitions and spaces. Offsets are approximate, not word or turn boundaries.
        this.inputRevision++;
        this.callerFragments.push({
          text: part.delta,
          start: part.start_ms,
          end: part.end_ms,
          id: part.event_id,
        });
      } else {
        this.spokenContext = (this.spokenContext + part.delta).slice(-4096);
      }
      this.schedule();
    } else if (event.type === "session.delegation.created") {
      const parsed = delegation.safeParse(event);
      if (!parsed.success) return this.host.fail(callError("protocol_error"));
      const id = parsed.data.delegation.id;
      if (this.seenDelegations.has(id)) return;
      if (this.seenDelegations.size >= 1024) return this.host.fail(callError("call_limit_reached"));
      this.seenDelegations.add(id);
      // Delegation IDs provide correlation, not transcript boundaries. Continue
      // forwarding caller speech under the latest correlation until it changes.
      // ASR may already have admitted this newer input under the previous ID.
      // Adopt its still-current work instead of dropping its eventual answer or
      // executing it again when the matching delegation notification arrives.
      const adoptsCurrentTask =
        this.currentDelegation?.firstInputRevision !== undefined &&
        this.currentDelegation.firstInputRevision < this.inputRevision &&
        this.latestTask?.inputRevision === this.inputRevision;
      if (adoptsCurrentTask && this.latestTask) this.latestTask.delegationId = id;
      this.currentDelegation = {
        id,
        offset: parsed.data.offset_ms,
        ...(adoptsCurrentTask ? { firstInputRevision: this.inputRevision } : {}),
      };
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.enabled || this.closed || this.scheduled) return;
    this.scheduled = true;
    // Coalesce queued event deliveries, never infer silence or finality from a timer.
    queueMicrotask(() => {
      this.scheduled = false;
      this.submit();
    });
  }

  private submit(): void {
    if (this.closed || !this.enabled || !this.currentDelegation) return;
    if (this.host.authorized && !this.host.authorized()) return;
    const { id, offset } = this.currentDelegation;
    // Append deltas in delivery order exactly once. Neither approximate offsets
    // nor transport timing establish which words complete a caller's request.
    const selected = this.callerFragments;
    const text = selected.map((fragment) => fragment.text).join("");
    if (!text.trim()) return;
    this.callerFragments = [];
    const revision = ++this.revision;
    const inputRevision = this.inputRevision;
    this.currentDelegation.firstInputRevision ??= inputRevision;
    const task = { delegationId: id, inputRevision };
    this.latestTask = task;
    const clientMessageId = createHash("sha256")
      .update(JSON.stringify([this.host.callId, id, selected.map((fragment) => fragment.id)]))
      .digest("hex");
    this.host.replyFailure(undefined);
    void this.host.agent
      .submit({
        stream: true,
        clientMessageId,
        text,
        spokenContext: JSON.stringify({
          frontendSpeech: this.spokenContext.slice(-1024),
          callerTranscriptMayContinue: true,
          delegationOffset: offset,
          observedInterval: {
            start: Math.min(...selected.map((fragment) => fragment.start)),
            end: Math.max(...selected.map((fragment) => fragment.end)),
          },
        }),
      })
      .then(
        (result) => {
          if (this.closed || revision !== this.revision) return;
          if (
            inputRevision !== this.inputRevision ||
            this.callerFragments.length > 0 ||
            this.currentDelegation?.id !== task.delegationId
          ) {
            // New speech is not cancellation. Quiet, scoped context avoids forcing
            // an old answer aloud while the voice frontend handles a correction.
            this.say(
              task.delegationId,
              `The prior backend request was ${JSON.stringify(text)}. More caller speech arrived afterward. These are only prior-request results; delegate any changed substantive request before answering it. Prior result: ${result.text || "No verified answer is available."}`,
              "session.thinking.append",
            );
            return;
          }
          if (result.failure) {
            const detail = terminalCallError(result.failure, false);
            this.host.replyFailure(detail);
            this.say(task.delegationId, detail.message);
          } else if (result.stopReason === "canceled") {
            this.say(
              task.delegationId,
              "The agent's work was stopped. No further result is available.",
            );
          } else if (result.text) {
            this.say(task.delegationId, result.text);
          } else {
            const detail = callError("provider_error", false);
            this.host.replyFailure(detail);
            this.say(task.delegationId, detail.message);
          }
        },
        () => {
          if (this.closed || revision !== this.revision) return;
          if (
            inputRevision !== this.inputRevision ||
            this.callerFragments.length > 0 ||
            this.currentDelegation?.id !== task.delegationId
          )
            return;
          const detail = callError("provider_error", false);
          this.host.replyFailure(detail);
          this.say(task.delegationId, detail.message);
        },
      )
      .catch(() => this.host.fail(callError("connection_error")));
  }

  private say(
    id: string,
    text: string,
    type: "session.commentary.append" | "session.thinking.append" = "session.commentary.append",
  ): void {
    for (const content of speechChunks(text)) {
      if (this.host.authorized && !this.host.authorized()) return;
      this.host.send({
        type,
        event_id: randomUUID(),
        delegation_id: id,
        content,
      });
    }
  }
}
