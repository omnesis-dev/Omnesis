// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The pills the Access pages name permissions and filter modes with. Every
// place that shows which capabilities a level holds, or how a source filter
// treats matching content, renders these, so the same thing always looks the
// same.

import { html } from "htm/preact";
import { CAPABILITIES, capabilityName } from "./grant-builder-state.js";
import { SAVED_FILTER_LABEL } from "./source-filter-state.js";

/** "Answer and Direct", "Answer, Direct and Notes": names joined for a sentence. */
function joined(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

/** What the pills say, as one sentence: "Answer and Direct allowed, Notes not allowed". */
export function capabilityPillsLabel(rules) {
  const names = (held) =>
    CAPABILITIES.filter((capability) => Boolean(rules?.[capability]) === held).map(capabilityName);
  const allowed = names(true),
    withheld = names(false);
  return [
    allowed.length ? `${joined(allowed)} allowed` : "",
    withheld.length ? `${joined(withheld)} not allowed` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * One capability: its own colour when held — Answer green, Direct red, Notes
 * blue — and a muted outline when not, the word kept in place either way.
 */
export function CapabilityPill({ capability, off = false }) {
  return html`<span class=${`capability-pill capability-pill-${capability}${off ? " is-off" : ""}`}
    >${capabilityName(capability)}</span
  >`;
}

/**
 * The three capabilities of a set of rules, always all three and always in
 * the same order, so a capability's position never moves from one level to
 * the next. The row reads out as one sentence.
 */
export function CapabilityPills({ rules }) {
  return html`<span class="capability-pills" role="img" aria-label=${capabilityPillsLabel(rules)}
    >${CAPABILITIES.map(
      (capability) =>
        html`<${CapabilityPill} key=${capability} capability=${capability} off=${!rules?.[capability]} />`,
    )}</span
  >`;
}

/** Each filter mode's pill label and what it does, for its tooltip. */
const FILTER_MODES = {
  share: [
    "Share matching content",
    "Only content that matches the criteria in the table below will be shared.",
  ],
  hide: [
    "Hide matching content",
    "All content which does not match the criteria in the table below will be shared.",
  ],
};

/**
 * The label of a filter rule's action: "Share matching content" or "Hide
 * matching content", and the saved-filter label for an action with no pill.
 */
export function filterModeLabel(action) {
  return FILTER_MODES[action]?.[0] ?? SAVED_FILTER_LABEL;
}

/**
 * How a source filter treats the content it matches. The tooltip says what
 * that means for the rest of the account; the title is also the pill's
 * accessible description.
 */
export function FilterModePill({ action, className = "" }) {
  const [label, tip] = FILTER_MODES[action] ?? [filterModeLabel(action), undefined];
  return html`<span
    class=${`access-pill is-${action === "hide" ? "hide" : "only"}${className ? ` ${className}` : ""}`}
    title=${tip}
    >${label}</span
  >`;
}
