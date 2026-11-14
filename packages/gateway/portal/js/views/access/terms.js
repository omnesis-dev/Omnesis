// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How a set of permissions is described on the Access page: how much of the
// corpus it reaches, in the few words a table column has, and the terms each
// capability runs under, one table row apiece. An access level's permissions read
// the same way wherever they are shown.

import { html } from "htm/preact";

import {
  CAPABILITIES,
  blocksNewSources,
  findPolicyFamily,
  isSourceAllowed,
  policyFamilyName,
  sourceId,
} from "../../components/grant-builder-state.js";
import { CapabilityPill } from "../../components/access-pills.js";
import { policyEditorPath } from "../../lib/policy-path.js";
import { navigate } from "../../lib/router.js";
import { overviewPolicies } from "./shared.js";

/**
 * The policy a reviewed capability runs under, as a link to its editor.
 *
 * Rules can name a policy the overview does not carry — one deleted out from
 * under them, or an overview that answered without it. That case reads as the
 * editor reads it, in plain text instead of a link.
 *
 * A list of links reads out its names alone, and "Household" three times over
 * says nothing about what each one is, so the word "Policy" travels inside the
 * accessible name.
 */
function policySummary(policyId, policies) {
  const named = findPolicyFamily(policies, policyId);
  if (!named) return policyFamilyName(named);
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
  const reach = allowed < connected.length ? `${allowed} of ${connected.length} sources` : blocksNewSources(rule) ? `All ${connected.length} sources` : "All sources";
  return rule.scopePolicies?.length ? `${reach} · filtered content` : reach;
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
  const policy = findPolicyFamily(policies, rule.release.policyFamilyId);
  return policyFamilyName(policy);
}

// Lucide "circle-check" and "circle-minus" (https://lucide.dev, ISC-licensed).
function PermissionGlyph({ granted }) {
  return html`<svg class="access-permission-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />${granted ? html`<path d="m9 12 2 2 4-4" />` : html`<path d="M8 12h8" />`}
  </svg>`;
}

/**
 * What one granted reading capability runs under: its reach, its review and
 * whether new sources join, in the words the level editor uses.
 */
function readingDetails(capability, rule, overview) {
  const retained = (overview.sources ?? []).filter((source) => source.available === false);
  const retainedAllowed = retained.filter((source) => isSourceAllowed(rule, sourceId(source))).length;
  const unreviewed = capability === "answer" && rule.release.mode === "unreviewed";
  return html`
    <span class="access-reach-cell"><span class="sr-only">Sources: </span>${laneReach(rule, overview)}</span>
    ${capability === "direct"
      ? null
      : unreviewed
        ? html`${" · "}<span class="access-unreviewed">No privacy review</span>`
        : html`${" · "}Privacy review: ${policySummary(rule.release.policyFamilyId, overviewPolicies(overview))}`}
    ${" · "}New sources: ${blocksNewSources(rule) ? "Blocked" : "Automatic"}
    ${retained.length > 0
      ? ` · Retained: ${retainedAllowed} allowed, ${retained.length - retainedAllowed} blocked`
      : null}`;
}

/**
 * The terms a set of permissions runs under, as a table: one row per
 * capability, always all three and always in the same order, so a
 * capability's position never moves from one level to the next. Every row is
 * styled alike: the capability pill goes muted and the permission column says
 * Not granted when it is withheld, keeping its row. An Answer released
 * without review keeps a warning-coloured mark, a state the owner chose.
 */
export function AccessTerms({ rules, overview }) {
  return html`<table class="access-terms-table">
    <thead>
      <tr><th scope="col">Capability</th><th scope="col">Permission</th><th scope="col">Details</th></tr>
    </thead>
    <tbody>
      ${CAPABILITIES.map((capability) => {
        const rule = rules[capability];
        const unreviewed = capability === "answer" && rule?.release.mode === "unreviewed";
        return html`<tr key=${capability} class=${`access-term access-term-${capability}${rule ? "" : " access-term-off"}`}>
          <th scope="row"><${CapabilityPill} capability=${capability} off=${!rule} /></th>
          <td class="access-term-permission"><span
            class=${`access-permission${rule ? " is-granted" : ""}${unreviewed ? " is-unreviewed" : ""}`}
            title=${unreviewed ? "Answers are released without privacy review" : undefined}
          ><${PermissionGlyph} granted=${Boolean(rule)} />${rule ? "Allowed" : "Not granted"}</span></td>
          <td class="access-term-details">${!rule
            ? html`<span aria-hidden="true">—</span>`
            : capability === "notes"
              ? "Saved under the agent’s name."
              : readingDetails(capability, rule, overview)}</td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}
