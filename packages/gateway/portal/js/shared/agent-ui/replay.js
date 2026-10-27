// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createContext } from "preact";
import { html } from "htm/preact";
import { useContext } from "preact/hooks";

/** Optional presentation clock. Null keeps the live portal lifecycle. */
export const AgentReplayContext = createContext(null);
export const ToolReplayContext = createContext(null);

/** Scope an external clock to one tool; no DOM wrapper or live timers. */
export function ReplayTool({ id, children }) {
  const replay = useContext(AgentReplayContext);
  if (replay == null) return children;
  const cue = replay.tools?.[id];
  if (!cue) throw new Error(`Missing replay timing for tool ${id}`);
  return html`<${ToolReplayContext.Provider} value=${{ ...cue, timeMs: replay.timeMs }}>${children}</${ToolReplayContext.Provider}>`;
}

/** Pure projection: identical timestamps produce identical rolling/fade phases. */
export function replayRotation(cue, count, revealMs, fadeMs) {
  if (!Number.isFinite(cue.timeMs) || !Number.isFinite(cue.startAtMs) || !Number.isFinite(cue.dismissAtMs)
    || (cue.resultAtMs != null && !Number.isFinite(cue.resultAtMs))
    || !Number.isInteger(count) || count < 0 || !Number.isFinite(revealMs) || !Number.isFinite(fadeMs) || revealMs <= 0 || fadeMs <= 0) {
    throw new Error("Invalid replay timing");
  }
  const fade = Math.max(0, Math.min(1, (cue.timeMs - cue.dismissAtMs) / fadeMs));
  const elapsed = cue.resultAtMs == null ? -1 : cue.timeMs - cue.resultAtMs;
  return {
    currentIndex: elapsed < 0 || count === 0 ? null : Math.min(count - 1, elapsed / revealMs - 1),
    phase: fade >= 1 ? "gone" : cue.timeMs >= cue.dismissAtMs ? "dismissing" : "live",
    fade,
  };
}
