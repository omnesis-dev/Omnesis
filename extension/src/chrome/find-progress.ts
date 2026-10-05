// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { initialState, reducer, type AgentUiState } from "@omnesis/gateway/agent-ui/reducer";
import type { AgentUiPart } from "@omnesis/gateway/agent-ui";

export type FindToolCard = AgentUiPart;
const EVENTS = new Set([
  "agent.text.delta",
  "agent.tool.input_start",
  "agent.tool.start",
  "agent.tool.result",
  "agent.tool.child.start",
  "agent.tool.child.result",
]);

/** The portal reducer owns ordering and tool-card causality; only this current run is kept. */
export class FindProgress {
  private state: AgentUiState = reducer(initialState(), {
    kind: "agent.message.start",
    payload: { messageId: "find", sessionId: null },
  });
  private textLength = 0;
  private toolCount = 0;
  private readonly toolIds = new Set<string>();
  update(type: string, payload: Record<string, unknown>): boolean {
    if (!EVENTS.has(type)) return false;
    if (type === "agent.text.delta") {
      if (typeof payload.delta !== "string") return false;
      const delta = payload.delta.slice(0, Math.max(0, 32000 - this.textLength));
      this.textLength += delta.length;
      payload = { ...payload, delta };
    } else {
      if (typeof payload.toolCallId !== "string" || payload.toolCallId.length > 128) return false;
      if (!this.toolIds.has(payload.toolCallId)) {
        if (this.toolCount >= 40) return false;
        this.toolIds.add(payload.toolCallId);
        this.toolCount++;
      }
    }
    // Find has one worker-fenced run rather than a portal conversation session.
    this.state = reducer(this.state, { kind: type, payload: { ...payload, sessionId: null } });
    return true;
  }
  flush(toolCallId: string): void {
    this.state = reducer(this.state, { kind: "ephemeral-tail-flush", toolCallId });
  }
  finish(): void {
    this.state = reducer(this.state, {
      kind: "agent.message.end",
      payload: { sessionId: null, stopReason: "end_turn" },
    });
  }
  snapshot(): AgentUiPart[] {
    return this.state.turns.flatMap((turn) =>
      turn.done ? turn.parts.filter((part) => part.kind === "text") : turn.parts,
    );
  }
}
