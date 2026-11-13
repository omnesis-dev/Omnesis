// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef } from "preact/hooks";
import { copyRuleFilters } from "./source-filter-state.js";
import {
  capabilityName,
  copyRuleSources,
  defaultPolicyFamilyId,
  newGrantRule,
} from "./grant-builder-state.js";

/** The question the capabilities answer, wherever it is asked. */
export const PERMISSIONS_QUESTION = "What should this connection be allowed to do?";

/**
 * Turn one capability on or off.
 *
 * Answer and Direct read the same corpus, so switching one on while the other
 * is already configured inherits its source selection rather than starting
 * from an empty allowlist the owner would have to fill in again.
 */
function withCapability(value, capability, enabled, fallbackPolicy) {
  if (!enabled) {
    const next = { ...value };
    delete next[capability];
    return next;
  }
  if (value[capability]) return value;
  if (capability === "direct" && value.answer) {
    return { ...value, direct: copyRuleSources(newGrantRule("direct"), value.answer) };
  }
  if (capability === "answer" && value.direct) {
    return { ...value, answer: copyRuleSources(newGrantRule("answer", fallbackPolicy), value.direct) };
  }
  return { ...value, [capability]: newGrantRule(capability, fallbackPolicy) };
}

/**
 * The capabilities a connection may hold. Each is independent: a connection
 * can answer, read directly, save notes, or any combination. The page's own
 * heading asks the question, so the legend labels the fieldset for assistive
 * technology only; the page also says when nothing is chosen.
 *
 * `linkDirect` starts a newly added Direct as Answer's copy, filters included.
 */
export function CapabilityPicker({ value, onChange, policies = [], disabled = false, requiresAnswer = false, idPrefix = "capability", linkDirect = false, accessLevel = "new", sourceFiltersEnabled = false, memory }) {
  const fallbackPolicy = defaultPolicyFamilyId(policies);
  // What a capability held when it was switched off, so switching it back on
  // restores the boundary the owner had chosen rather than inheriting the
  // other capability's. A caller that unmounts the picker between steps passes
  // its own `memory` ref so the saved boundary outlives the step.
  const own = useRef({});
  const removed = memory ?? own;
  const capabilities = [
    {
      id: "answer",
      detail: "Ask questions to the Omnesis agent using allowed sources. A privacy policy can review every answer before it is released.",
      locked: requiresAnswer,
    },
    {
      id: "direct",
      detail: "Search and read raw matching records from allowed sources.",
      // Sits inside the card's own description and turns red once the card is
      // chosen, so the consequence is loudest exactly when it applies.
      warning: "Direct is not protected by a privacy policy.",
      risk: true,
    },
    {
      id: "notes",
      detail: "Save notes with Tell Omnesis. The agent’s name is recorded with each note. This does not grant access to read existing notes.",
    },
  ];
  const requiredNoteId = `${idPrefix}-answer-required`;
  return html`<fieldset class="access-capability-presets" disabled=${disabled}>
    <legend class="sr-only">${PERMISSIONS_QUESTION}</legend>
    ${capabilities.map((capability) => html`<label class=${`access-capability-preset${capability.risk ? " is-risk" : ""}`} key=${capability.id}>
      <input
        type="checkbox"
        checked=${Boolean(value[capability.id]) || Boolean(capability.locked)}
        aria-disabled=${capability.locked ? "true" : undefined}
        aria-describedby=${capability.locked ? requiredNoteId : undefined}
        onChange=${(event) => {
          if (capability.locked) return;
          const enabled = event.currentTarget.checked;
          if (!enabled) removed.current[capability.id] = value[capability.id];
          const restored = enabled ? removed.current[capability.id] : null;
          const next = restored ? { ...value, [capability.id]: restored } : withCapability(value, capability.id, enabled, fallbackPolicy);
          // Direct switched on beside Answer starts as Answer's copy, filters
          // included, so it never reads an account more widely than Answer does.
          if (enabled && !restored && capability.id === "direct" && linkDirect && next.answer && sourceFiltersEnabled === true)
            next.direct = copyRuleFilters(next.direct, next.answer, accessLevel);
          onChange(next);
        }}
      />
      <span><strong>${capabilityName(capability.id)}</strong><small>${capability.detail}${capability.warning && html` <b class="access-capability-warning">${capability.warning}</b>`}</small></span>
    </label>`)}
    ${requiresAnswer && html`<p class="access-required-note" id=${requiredNoteId}>Answer is required by this integration.</p>`}
  </fieldset>`;
}
