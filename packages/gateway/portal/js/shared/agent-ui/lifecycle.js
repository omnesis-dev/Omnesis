// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useRef, useEffect } from "preact/hooks";

export const EPHEMERAL_REVEAL_MS = 350; // PARITY:ephemeral-reveal-ms
export const EPHEMERAL_HOLD_MS = 450; // PARITY:ephemeral-hold-ms
export const EPHEMERAL_FADE_MS = 300; // PARITY:ephemeral-fade-ms
// Minimum time the card stays visible before it starts its fade-out,
// even when the reducer has buffered tail content that wants it gone.
// A card that pops in and out faster than this would read as a flash
// rather than a step in the agent's narration. Mirror this number on
// iOS (`agentEphemeralMinVisibleSeconds`).
export const EPHEMERAL_MIN_VISIBLE_MS = 500; // PARITY:ephemeral-min-visible-ms
export const EPHEMERAL_SLOT_HEIGHT = 18;
export const EPHEMERAL_SQL_SLOT_HEIGHT = 16;
export const EPHEMERAL_SQL_ROWS_MAX = 10;
// Caps on the per-card rotation length. The rolling slot is meant as
// a glance ("agent is reading this"), not an exhaustive replay — a
// 200-line PDF would otherwise roll for 70+ seconds. ~10 items keeps
// each card under ~4s of motion plus the post-roll hold + fade.
export const EPHEMERAL_DOC_LINES_MAX = 10;
export const EPHEMERAL_SEARCH_RESULTS_MAX = 12;
export const EPHEMERAL_TRAIL_DOCS_MAX = 12;
// Same cap as the search card — `lookup_people` is a multi-candidate
// disambiguation surface, not an exhaustive directory listing. Matches
// `LOOKUP_PEOPLE_MAX_LIMIT` in @omnesis/agent; defense-in-depth here
// so a legacy transcript carrying more rows still renders sensibly.
export const EPHEMERAL_PEOPLE_RESULTS_MAX = 12;

export function RollingSlot({ items, currentIndex, slotHeight, itemView }) {
  // currentIndex == null → stack starts one slot below (off-screen);
  // first step (i=0) translates by 0 → first item rolls into view.
  const offsetSlots = currentIndex == null ? 1 : -currentIndex;
  const transform = `translateY(${offsetSlots * slotHeight}px)`;
  return html`
    <div class="agent-ephemeral-slot" style=${`height:${slotHeight}px`}>
      <div
        class="agent-ephemeral-stack"
        style=${`transform:${transform};transition:transform ${EPHEMERAL_REVEAL_MS}ms linear`}
      >
        ${items.map(
          (item, i) => html`
            <div key=${i} class="agent-ephemeral-row" style=${`height:${slotHeight}px`}>
              ${itemView(item)}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

/**
 * Whether the tool call has produced ANY result yet — success OR error.
 *
 * Every ephemeral card runs exactly one dismiss lifecycle per tool call,
 * and it MUST run for every result the tool emits, not just the
 * success-shaped one. The reducer's causality gate
 * (`findActiveGateIndex` in `views/agent-reducer.js`) activates the
 * moment a tool part has *any* result and holds back all following text
 * until the card dispatches `ephemeral-tail-flush` at the end of its
 * fade-out. A tool that fails returns the shared `{ kind: "error" }`
 * result — if the card keyed its spinner + rotation off its
 * success-kind check (`result.kind === "sql.rows"`, …) instead, an
 * error result would leave the card spinning forever and the buffered
 * text would never flush. So the spinner and the rotation's `ready`
 * gate track "a result arrived" (this predicate); the per-card
 * success-kind check only decides whether there are rows/results to
 * roll through.
 */
export function ephemeralResultArrived(call) {
  return call?.result != null;
}

/**
 * Drives a rolling-slot rotation: holds the slot empty until `ready` is
 * true, then steps `currentIndex` from 0…N-1 at EPHEMERAL_REVEAL_MS each,
 * holds for EPHEMERAL_HOLD_MS, fades the card, then removes its rendered
 * DOM node so the transcript flex gap also disappears. Returns
 * `{ currentIndex, phase }`. The `count` and `ready` flags are captured
 * by ref so a late-arriving result (after
 * the empty-state dismiss fired) doesn't re-trigger the rotation.
 *
 * Causality contract — when the reducer parks new content on this
 * card's `pendingTail`, the parent flips `expedite` true. The hook
 * cancels the natural-flow dismiss timer and re-schedules it to fire
 * at `max(0, EPHEMERAL_MIN_VISIBLE_MS − elapsed)` from now, so the
 * card is never seen for less than 500ms (avoid flashes) but never
 * holds longer than that once the agent is ready to keep talking.
 * The fade-out is unchanged (300ms via CSS); `onDone` fires AFTER
 * the fade completes so the caller can dispatch `ephemeral-tail-flush`.
 */
export function useRollingRotation(ready, count, options) {
  const expedite = options?.expedite ?? false;
  const onDone = options?.onDone;
  const [currentIndex, setCurrentIndex] = useState(null);
  const [phase, setPhase] = useState("live");
  const startedRef = useRef(false);
  const startedAtRef = useRef(0);
  const revealTimersRef = useRef([]);
  // `dismissTimerRef.current` holds whichever dismiss timer is currently
  // armed (natural-flow or expedited). Re-arming clears the prior one
  // first so the dismiss fires exactly once.
  const dismissTimerRef = useRef(null);
  const fadeTimerRef = useRef(null);

  function fireDismiss() {
    setPhase("dismissing");
    fadeTimerRef.current = setTimeout(() => {
      setPhase("gone");
      onDone?.();
    }, EPHEMERAL_FADE_MS);
  }

  function scheduleDismiss(delayMs) {
    if (dismissTimerRef.current != null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (delayMs <= 0) {
      fireDismiss();
    } else {
      dismissTimerRef.current = setTimeout(fireDismiss, delayMs);
    }
  }

  // Natural-flow start. Fires once when `ready` flips true.
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    startedAtRef.current = Date.now();
    if (count === 0) {
      scheduleDismiss(EPHEMERAL_HOLD_MS + EPHEMERAL_REVEAL_MS);
      return;
    }
    for (let i = 0; i < count; i++) {
      revealTimersRef.current.push(setTimeout(() => setCurrentIndex(i), i * EPHEMERAL_REVEAL_MS));
    }
    scheduleDismiss(count * EPHEMERAL_REVEAL_MS + EPHEMERAL_HOLD_MS);
    // `ready` + `count` are deliberately the only deps — the rotation
    // should kick off exactly once when the result lands, not restart
    // if the parent re-renders with the same values.
  }, [ready, count]);

  // Expedite reaction. The reducer's gate set this true; collapse the
  // remaining display time to whatever brings total visible time to
  // exactly EPHEMERAL_MIN_VISIBLE_MS (or 0 if we're already past).
  useEffect(() => {
    if (!expedite || !startedRef.current || phase !== "live") return;
    const elapsed = Date.now() - startedAtRef.current;
    const remaining = EPHEMERAL_MIN_VISIBLE_MS - elapsed;
    scheduleDismiss(remaining);
  }, [expedite, phase]);

  // Unmount cleanup. Any in-flight timer must release before the
  // component leaves the tree so we never call `setState` on an
  // unmounted instance.
  useEffect(
    () => () => {
      for (const t of revealTimersRef.current) clearTimeout(t);
      if (dismissTimerRef.current != null) clearTimeout(dismissTimerRef.current);
      if (fadeTimerRef.current != null) clearTimeout(fadeTimerRef.current);
    },
    [],
  );

  return { currentIndex, phase };
}

/**
 * Shared chrome: leading 2px accent rail, 8px gap to content, no border
 * or bg fill. Reads as "the agent is currently doing something here"
 * without the visual weight of a bordered card. The dismissing phase fades
 * and collapses it; the gone phase removes the flex child and its parent gap.
 */
export function EphemeralCard({ phase, children }) {
  if (phase === "gone") return null;
  return html`
    <div class=${`agent-ephemeral${phase === "dismissing" ? " is-dismissed" : ""}`}>
      ${children}
    </div>
  `;
}

export function EphemeralHeader({
  glyph,
  label,
  monospaceArg,
  headerExtra,
  showSpinner,
  trailing,
}) {
  return html`
    <div class="agent-ephemeral-header">
      <span class="agent-ephemeral-glyph" aria-hidden="true">${glyph}</span>
      <span class="agent-ephemeral-label">${label}</span>
      ${monospaceArg ? html`<code class="agent-ephemeral-arg">${monospaceArg}</code>` : null}
      ${headerExtra ?? null}
      ${showSpinner ? html`<span class="agent-ephemeral-spinner" aria-hidden="true"></span>` : null}
      ${trailing ?? null}
    </div>
  `;
}
