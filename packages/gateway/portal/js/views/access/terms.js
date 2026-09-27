// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How a set of permissions is described on the Access page: how much of the
// corpus it reaches, in the few words a table column has, and the terms each
// capability runs under, one tile apiece. An access level's permissions read
// the same way wherever they are shown.

import { html } from "htm/preact";
import { CapabilityBadge } from "../../components/grant-builder.js";

import {
  isSourceAllowed,
  policyFamilyId,
  policyFamilyName,
  sourceId,
} from "../../components/grant-builder-state.js";
import { policyEditorPath } from "../../lib/policy-path.js";
import { navigate } from "../../lib/router.js";
import { overviewPolicies } from "./shared.js";

/**
 * The policy a reviewed capability runs under, as a link to its editor.
 *
 * Rules can name a policy the overview does not carry — one deleted out from
 * under them, or an overview that answered without it. Naming it anyway would
 * print a placeholder over a live link, so that case is plain text instead.
 *
 * A list of links reads out its names alone, and "Household" three times over
 * says nothing about what each one is, so the word "Policy" travels inside the
 * accessible name as well as in the term beside it.
 */
function policySummary(policyId, policies) {
  const named = policies.find((policy) => policyFamilyId(policy) === policyId);
  if (!named) return "Policy unavailable";
  const name = policyFamilyName(named);
  const href = policyEditorPath(policyId);
  return html`<a
    href=${href}
    aria-label=${`Policy: ${name}`}
    onClick=${(event) => { event.preventDefault(); navigate(href); }}
  >${name}</a>`;
}

/**
 * How much of the corpus one capability reaches.
 *
 * A count is only the whole truth for a named allowlist. A boundary that lets
 * newly connected sources in says "All sources" without one, because "All 34"
 * is a claim about today that the next source connected makes false.
 */
function laneReach(rule, overview) {
  const connected = (overview.sources ?? []).filter((source) => source.available !== false);
  if (connected.length === 0) return "No connected sources";
  const allowed = connected.filter((source) => isSourceAllowed(rule, sourceId(source))).length;
  if (allowed === 0) return "No sources";
  if (allowed < connected.length) return `${allowed} of ${connected.length} sources`;
  return rule.sources.mode === "allowlist" ? `All ${connected.length} sources` : "All sources";
}

/** The reach of the reading capabilities, or where Answer and Direct disagree, that too. Null for Notes alone. */
export function reachSummary(rules, overview) {
  const phrases = ["answer", "direct"]
    .filter((capability) => rules[capability])
    .map((capability) => laneReach(rules[capability], overview));
  if (phrases.length === 0) return null;
  const distinct = [...new Set(phrases)];
  return distinct.length === 1 ? distinct[0] : `${distinct[0]} · varies`;
}

/** How an Answer's replies are released, in the words the review uses. */
export function answerPrivacySummary(rule, policies) {
  if (rule.release.mode === "unreviewed") return "No privacy review";
  const policy = policies.find((candidate) => policyFamilyId(candidate) === rule.release.policyFamilyId);
  return policy ? policyFamilyName(policy) : "Privacy policy";
}

// Lucide glyphs (https://lucide.dev, ISC-licensed), inlined like the portal's
// other icons: "book-open" for Answer, "arrow-left-right" for Direct and
// "file-text" for Notes.
const CAPABILITY_GLYPHS = {
  answer: html`<path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />`,
  direct: html`<path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" />`,
  notes: html`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />`,
};

function CapabilityGlyph({ capability }) {
  return html`<span class="access-term-icon" aria-hidden="true"><svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  >${CAPABILITY_GLYPHS[capability]}</svg></span>`;
}

/**
 * The terms a set of permissions runs under: one tile per capability, always
 * all three and always in the same order, so a capability's position never
 * moves from one level to the next. A withheld capability keeps its tile and
 * says Off.
 */
export function AccessTerms({ rules, overview }) {
  const lanes = ["answer", "direct", "notes"];
  const retained = (overview.sources ?? []).filter((source) => source.available === false);
  return html`<dl class="access-detail-grid">
    ${lanes.map((capability) => {
      const rule = rules[capability];
      const unreviewed = capability === "answer" && rule?.release.mode === "unreviewed";
      const term = (className, body) => html`<div key=${capability} class=${`access-term ${className}`}>
        <dt><${CapabilityGlyph} capability=${capability} /><${CapabilityBadge} capability=${capability} off=${!rule} unreviewed=${unreviewed} /></dt>
        <dd>${body}</dd>
      </div>`;
      // The badge already tells a screen reader the capability is not granted.
      if (!rule) return term("access-term-off", html`<span aria-hidden="true">Off</span>`);
      if (capability === "notes") return term("access-term-notes", "Saves notes under the agent's name");
      const retainedAllowed = retained.filter((source) => isSourceAllowed(rule, sourceId(source))).length;
      return term(`access-term-${capability}${unreviewed ? " access-term-unreviewed" : ""}`, html`
        <span class="access-reach-cell"><span class="sr-only">Sources: </span>${laneReach(rule, overview)}</span>${" · "}
        ${capability === "direct"
          ? "Raw access"
          : unreviewed
            ? html`<span class="access-unreviewed">No privacy review</span>`
            : policySummary(rule.release.policyFamilyId, overviewPolicies(overview))}
        ${" · "}${rule.sources.mode === "allowlist" ? "New sources blocked" : "New sources allowed"}
        ${retained.length > 0
          ? ` · Retained: ${retainedAllowed} allowed, ${retained.length - retainedAllowed} blocked`
          : null}`);
    })}
  </dl>`;
}
