// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How a set of permissions is described on the Access page: how much of the
// corpus it reaches, in the few words a table column has, and the terms each
// capability runs under, one table row apiece. An access level's permissions read
// the same way wherever they are shown.

import { html } from "htm/preact";

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
 * accessible name as well as in the words beside it, unless the name already
 * ends in it.
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
  >${name}</a>${/\bpolicy$/i.test(name) ? null : " policy"}`;
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
// "file-text" for Save notes.
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

const CAPABILITY_LABELS = { answer: "Answer", direct: "Direct", notes: "Save notes" };

// Lucide "circle-check" and "circle-minus" (https://lucide.dev, ISC-licensed).
function PermissionGlyph({ granted }) {
  return html`<svg class="access-permission-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />${granted ? html`<path d="m9 12 2 2 4-4" />` : html`<path d="M8 12h8" />`}
  </svg>`;
}

/** What one granted reading capability runs under: its reach, its review and whether new sources join. */
function readingDetails(capability, rule, overview) {
  const retained = (overview.sources ?? []).filter((source) => source.available === false);
  const retainedAllowed = retained.filter((source) => isSourceAllowed(rule, sourceId(source))).length;
  const unreviewed = capability === "answer" && rule.release.mode === "unreviewed";
  return html`
    <span class="access-reach-cell"><span class="sr-only">Sources: </span>${laneReach(rule, overview)}</span>${" · "}
    ${capability === "direct"
      ? "Raw access"
      : unreviewed
        ? html`<span class="access-unreviewed">No privacy review</span>`
        : policySummary(rule.release.policyFamilyId, overviewPolicies(overview))}
    ${" · "}${rule.sources.mode === "allowlist" ? "New sources blocked" : "New sources allowed"}
    ${retained.length > 0
      ? ` · Retained: ${retainedAllowed} allowed, ${retained.length - retainedAllowed} blocked`
      : null}`;
}

/**
 * The terms a set of permissions runs under, as a table: one row per
 * capability, always all three and always in the same order, so a
 * capability's position never moves from one level to the next. Every row is
 * styled alike; only the permission column says whether it is granted, and a
 * withheld capability keeps its row and says Not granted. An Answer released
 * without review keeps a warning-coloured mark, a state the owner chose.
 */
export function AccessTerms({ rules, overview }) {
  return html`<table class="access-terms-table">
    <thead>
      <tr><th scope="col">Capability</th><th scope="col">Permission</th><th scope="col">Details</th></tr>
    </thead>
    <tbody>
      ${["answer", "direct", "notes"].map((capability) => {
        const rule = rules[capability];
        const unreviewed = capability === "answer" && rule?.release.mode === "unreviewed";
        return html`<tr key=${capability} class=${`access-term access-term-${capability}${rule ? "" : " access-term-off"}`}>
          <th scope="row"><span class="access-term-capability"><${CapabilityGlyph} capability=${capability} />${CAPABILITY_LABELS[capability]}</span></th>
          <td class="access-term-permission"><span
            class=${`access-permission${rule ? " is-granted" : ""}${unreviewed ? " is-unreviewed" : ""}`}
            title=${unreviewed ? "Answers are released without privacy review" : undefined}
          ><${PermissionGlyph} granted=${Boolean(rule)} />${rule ? "Allowed" : "Not granted"}</span></td>
          <td class="access-term-details">${!rule
            ? html`<span aria-hidden="true">—</span>`
            : capability === "notes"
              ? "Saved under the agent's name."
              : readingDetails(capability, rule, overview)}</td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}
