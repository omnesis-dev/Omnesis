// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ComponentChildren, VNode } from "preact";
export { render, h } from "preact";
export interface AgentUiPart {
  kind: "text" | "tool" | "thinking";
  text?: string;
  toolCallId?: string;
  tool?: string;
  args?: Record<string, unknown> | null;
  argsSummary?: string;
  result?: Record<string, unknown> | null;
  durationMs?: number | null;
  pendingTail?: unknown[];
  tailDismissed?: boolean;
  children?: unknown[];
}
export function createAgentToolRenderer(options?: {
  sourceIcon?(sourceId: string, options?: { size?: number }): ComponentChildren;
  renderLoopRow?(loop: Record<string, unknown>): ComponentChildren;
}): {
  renderToolPart(
    part: AgentUiPart,
    key: string | number,
    dispatch?: (action: { kind: string; toolCallId: string }) => void,
  ): ComponentChildren;
};
export function AssistantMarkdown(props: {
  text: string;
  copyable?: boolean;
  blockImages?: boolean;
  plainValueFences?: boolean;
  className?: string;
}): VNode;
