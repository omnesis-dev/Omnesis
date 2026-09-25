// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Rebuild agent conversation history from a persisted steward run
 * transcript, so a brief-anchored follow-up thread starts with the full
 * context of the run that created the brief — the documents it read, the
 * tool calls it made, and its reasoning's conclusions — instead of a
 * cold-start summary.
 *
 * The fold mirrors how a live `AgentSession` builds history from its own
 * event stream: text deltas coalesce into one assistant text part,
 * `agent.tool.start` becomes an assistant `tool_use` part, and each
 * `agent.tool.result` closes the pending assistant message and lands as a
 * user `tool_result` part. Tool turns retain reasoning text and opaque
 * blocks; the chosen model's catalog facts decide which field reaches the
 * inference API. An event the fold doesn't recognise is ignored, matching
 * the session's own tolerance.
 */

import type { ChatMessage, AssistantPart, UserPart } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type { CognitionRunTranscript } from "../transcripts.js";

interface ToolStartPayload {
  toolCallId?: unknown;
  tool?: unknown;
  args?: unknown;
  extraContent?: unknown;
  reasoningDetails?: unknown;
}

interface ToolResultPayload {
  toolCallId?: unknown;
  result?: unknown;
}

interface TextDeltaPayload {
  delta?: unknown;
}

/**
 * Fold a run transcript into replay-valid `ChatMessage[]` history: the
 * run's prompt as the opening user message, then the assistant/tool
 * exchange as the session recorded it.
 */
export function transcriptToHistory(transcript: CognitionRunTranscript): ChatMessage[] {
  const history: ChatMessage[] = [
    { role: "user", parts: [{ kind: "text", text: transcript.prompt }] },
  ];

  let pendingAssistant: AssistantPart[] = [];

  const flushAssistant = (): void => {
    const parts = pendingAssistant.some((part) => part.kind === "tool_use")
      ? pendingAssistant
      : pendingAssistant.filter((part) => part.kind !== "thinking");
    if (parts.length > 0) history.push({ role: "assistant", parts });
    pendingAssistant = [];
  };

  for (const event of transcript.events) {
    switch (event.type) {
      case "agent.text.delta": {
        const delta = (event.payload as TextDeltaPayload | undefined)?.delta;
        if (typeof delta !== "string" || delta.length === 0) break;
        const last = pendingAssistant.at(-1);
        if (last && last.kind === "text") {
          pendingAssistant[pendingAssistant.length - 1] = {
            kind: "text",
            text: last.text + delta,
          };
        } else {
          pendingAssistant.push({ kind: "text", text: delta });
        }
        break;
      }
      case "agent.thinking.delta": {
        const delta = (event.payload as TextDeltaPayload | undefined)?.delta;
        if (typeof delta !== "string" || delta.length === 0) break;
        const last = pendingAssistant.at(-1);
        if (last && last.kind === "thinking") {
          pendingAssistant[pendingAssistant.length - 1] = {
            kind: "thinking",
            text: last.text + delta,
          };
        } else {
          pendingAssistant.push({ kind: "thinking", text: delta });
        }
        break;
      }
      case "agent.tool.start": {
        const p = event.payload as ToolStartPayload | undefined;
        if (typeof p?.toolCallId !== "string" || typeof p?.tool !== "string") break;
        pendingAssistant.push({
          kind: "tool_use",
          toolCallId: p.toolCallId,
          tool: p.tool,
          args: p.args,
          ...(p.extraContent !== undefined ? { extraContent: p.extraContent } : {}),
          ...(Array.isArray(p.reasoningDetails) ? { reasoningDetails: p.reasoningDetails } : {}),
        });
        break;
      }
      case "agent.tool.result": {
        const p = event.payload as ToolResultPayload | undefined;
        if (typeof p?.toolCallId !== "string" || p.result === undefined) break;
        flushAssistant();
        const part: UserPart = {
          kind: "tool_result",
          toolCallId: p.toolCallId,
          // The transcript stores the full ToolResult verbatim; carry it
          // back opaquely the same way the live session does.
          result: p.result as ToolResult,
        };
        history.push({ role: "user", parts: [part] });
        break;
      }
      default:
        // citations, message.start/end, input_start — not
        // part of replayable history.
        break;
    }
  }

  flushAssistant();

  // A thread reads best when the seeded context ends on the agent's own
  // words. A failed or empty run may leave nothing — fall back to the
  // transcript's finalText so the exchange still closes.
  const last = history.at(-1);
  if (last?.role !== "assistant") {
    const text = transcript.finalText.trim();
    if (text.length > 0) {
      history.push({ role: "assistant", parts: [{ kind: "text", text }] });
    }
  }

  return history;
}
