// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The numbered step bar of the portal's one-question-at-a-time flows: the
// access-level wizard and the Connectivity setup. A finished step shows a
// tick and can be revisited; the current step is marked for assistive
// technology; a step not reached yet cannot be skipped to unless the flow
// marks it reachable. Focus follows the
// step, so a keyboard move forward lands on the new step's heading.

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * @param {object} props
 * @param {Array<{ key: string, label: string, current: boolean, complete: boolean, reachable?: boolean }>} props.items
 *   the steps in order; `complete` and `reachable` steps can be clicked, any other step but the
 *   current one is disabled.
 * @param {(key: string) => void} props.onSelect  called with a clickable step's key.
 * @param {boolean} [props.disabled]  holds every step while the flow is busy.
 */
export function StepNav({ items, onSelect, disabled = false }) {
  return html`<nav class="access-wizard-steps" aria-label="Progress">
    ${items.map((item, index) => html`<button type="button" key=${item.key}
        class=${item.current ? "is-current" : item.complete ? "is-complete" : ""}
        aria-current=${item.current ? "step" : undefined}
        disabled=${disabled || (!item.current && !item.complete && !item.reachable)}
        onClick=${() => !item.current && (item.complete || item.reachable) && onSelect(item.key)}>
        <span>${item.complete ? "✓" : index + 1}</span>${item.label}
      </button>`)}
  </nav>`;
}

/**
 * A ref for the current step's heading, focused whenever `step` changes. The
 * first render is not a move, and stealing focus there would fight the page's
 * own heading.
 */
export function useStepFocus(step) {
  const heading = useRef(null);
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  return heading;
}
