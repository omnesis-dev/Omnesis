// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { sourceIcon } from "../lib/format.js";
import {
  copyRuleSources,
  defaultPolicyFamilyId,
  isSourceAllowed,
  NO_CAPABILITY_MESSAGE,
  newGrantRule,
  policyFamilyId,
  policyFamilyName,
  rulesShareSources,
  setAllSourcesAllowed,
  setFutureSourcesAllowed,
  setSourceAllowed,
  sourceBoundaryError,
  sourceId,
  sourceLabel,
  sourceScopeName,
  releaseError,
  validateGrantRules,
} from "./grant-builder-state.js";

function capabilityName(capability) {
  return capability === "notes" ? "Notes" : capability === "direct" ? "Direct" : "Answer";
}

/**
 * One capability, as the pill the Access table uses.
 *
 * The same capability must look the same wherever it is named — a review that
 * invents its own labels makes the owner check twice that the thing they are
 * about to approve is the thing the list will show them afterwards.
 *
 * `off` renders the withheld state: the word kept in place and gone faint.
 */
export function CapabilityBadge({ capability, off = false, unreviewed = false }) {
  return html`<span
    class=${`access-badge access-badge-${capability}${off ? " is-off" : ""}${unreviewed ? " is-unreviewed" : ""}`}
  >${capabilityName(capability)}<span class="sr-only"
    >${off ? " not granted" : " granted"}${unreviewed ? ", released without privacy review" : ""}</span
  ></span>`;
}

/**
 * The three capabilities a connection can hold, always rendered, always in
 * this order.
 *
 * A granted capability is a lit badge and a withheld one is the same word gone
 * faint, so a capability's position never moves: scanning one column down the
 * Access table answers "which of these can read raw records", which chips
 * packed left-to-right cannot, and the review of an approval shows exactly the
 * row the table will show afterwards. An Answer released without review turns
 * its own badge amber — a state the owner chose, in the warning colour rather
 * than the danger one, which is kept for Direct.
 *
 * `live` is false for a row whose access has ended; the triad then fades as
 * one.
 */
export function CapabilityTriad({ rules, live = true }) {
  return html`<div class=${`access-triad${live ? "" : " is-inactive"}`}>
    ${["answer", "direct", "notes"].map((capability) => {
      const held = Boolean(rules[capability]);
      const unreviewed = capability === "answer" && held && rules.answer.release.mode === "unreviewed";
      return html`<span
        key=${capability}
        title=${unreviewed ? "Answers are released without privacy review" : undefined}
      ><${CapabilityBadge} capability=${capability} off=${!held} unreviewed=${unreviewed} /></span>`;
    })}
  </div>`;
}

function sourceInstanceIcon(source, id) {
  const icon = source.icon;
  const safeIcon = typeof icon === "string" && (
    /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(icon)
    || /^\/(?![\\/])/.test(icon)
  );
  return safeIcon ? html`<img src=${icon} alt="" />` : sourceIcon(id, { size: 20 });
}

export function SourceBoundary({ capability, label, rule, sources, disabled, onChange, idPrefix }) {
  const [query, setQuery] = useState("");
  const ids = sources.map(sourceId).filter(Boolean);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSources = normalizedQuery
    ? sources.filter((source) => `${sourceLabel(source)} ${sourceId(source)}`.toLocaleLowerCase().includes(normalizedQuery))
    : sources;
  const futureAllowed = rule.sources.mode !== "allowlist";
  const allowed = ids.filter((id) => isSourceAllowed(rule, id)).length;
  const title = label ?? `${capabilityName(capability)} sources`;
  const error = sourceBoundaryError(rule, sourceScopeName(capability), sources);

  return html`<fieldset class="grant-builder-boundary" disabled=${disabled}>
    <legend>${title}</legend>
    <p class="grant-builder-guidance">Checked sources are allowed. You can change this access later.</p>
    ${sources.length === 0
      ? html`<p class="grant-builder-empty">No source instances are connected. Connect a source before approving this access.</p>`
      : html`
        <div class="grant-builder-source-tools">
          <label class="grant-builder-search">
            <span class="sr-only">Search sources</span>
            <input type="search" placeholder="Search sources" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} />
          </label>
          <span>${allowed} of ${ids.length} allowed</span>
          <div class="grant-builder-bulk" aria-label=${`${capability} source shortcuts`}>
            <button type="button" class="btn-tiny" onClick=${() => onChange(setAllSourcesAllowed(rule, ids, true))}>Allow all</button>
            <button type="button" class="btn-tiny" onClick=${() => onChange(setAllSourcesAllowed(rule, ids, false))}>Block all</button>
          </div>
        </div>
        <div class="grant-builder-sources" aria-label=${`${capability} source selection`}>
          ${visibleSources.map((source, index) => {
            const id = sourceId(source);
            const isAllowed = isSourceAllowed(rule, id);
            const status = source.available === false ? "Retained" : isAllowed ? "Allowed" : "Blocked";
            const inputId = `${idPrefix}-${capability}-source-${index}`;
            return html`<label class="grant-builder-source" for=${inputId} key=${id}>
              <input id=${inputId} type="checkbox" checked=${isAllowed} disabled=${disabled}
                onChange=${(event) => onChange(setSourceAllowed(rule, id, event.currentTarget.checked))} />
              <span class="grant-builder-source-icon" aria-hidden="true">${sourceInstanceIcon(source, id)}</span>
              <span><strong>${sourceLabel(source)}</strong><code>${id}</code>${source.available === false && html`<small>Unavailable — decision retained</small>`}</span>
              <small>${status}</small>
            </label>`;
          })}
          ${visibleSources.length === 0 && html`<p class="grant-builder-empty">No sources match that search.</p>`}
        </div>
      `}
    ${error && html`<p class="access-field-error grant-builder-boundary-error" role="alert">${error}</p>`}
    <fieldset class="grant-builder-future" disabled=${disabled}>
      <legend>When you connect a new source</legend>
      <label>
        <input type="radio" name=${`${idPrefix}-${capability}-future`} checked=${!futureAllowed}
          onChange=${() => onChange(setFutureSourcesAllowed(rule, false, ids))} />
        <span><strong>Keep it blocked until I allow it</strong></span>
      </label>
      <label class=${futureAllowed ? "grant-builder-future-risk" : ""}>
        <input type="radio" name=${`${idPrefix}-${capability}-future`} checked=${futureAllowed}
          onChange=${() => onChange(setFutureSourcesAllowed(rule, true, ids))} />
        <span><strong>Allow it automatically</strong></span>
      </label>
    </fieldset>
  </fieldset>`;
}

export function AnswerRelease({ rule, policies, disabled, onChange, idPrefix }) {
  const selected = rule.release.mode === "reviewed" ? rule.release.policyFamilyId : "";
  return html`<fieldset class="grant-builder-release" disabled=${disabled}>
    <legend>Privacy for Answer</legend>
    <div class="grant-builder-release-choice grant-builder-release-reviewed">
      <label for=${`${idPrefix}-reviewed`}>
        <input id=${`${idPrefix}-reviewed`} name=${`${idPrefix}-release`} type="radio"
          checked=${rule.release.mode === "reviewed"}
          onChange=${() => onChange({
            ...rule,
            release: { mode: "reviewed", policyFamilyId: selected || defaultPolicyFamilyId(policies) },
          })} />
        <strong>Review answers with a privacy policy</strong>
      </label>
      ${rule.release.mode === "reviewed" && html`<select aria-label="Answer privacy policy" value=${selected}
        onChange=${(event) => onChange({
          ...rule,
          release: { mode: "reviewed", policyFamilyId: event.currentTarget.value },
        })}>
        <option value="">Choose a policy</option>
        ${policies.map((policy) => html`<option value=${policyFamilyId(policy)}>${policyFamilyName(policy)}</option>`)}
      </select>`}
    </div>
    <label class="grant-builder-release-choice grant-builder-risk" for=${`${idPrefix}-unreviewed`}>
      <input id=${`${idPrefix}-unreviewed`} name=${`${idPrefix}-release`} type="radio"
        checked=${rule.release.mode === "unreviewed"}
        onChange=${() => onChange({ ...rule, release: { mode: "unreviewed" } })} />
      <span><strong>Release answers automatically</strong><small>High risk: source boundaries and audit still apply, but no reviewer checks the answer.</small></span>
    </label>
  </fieldset>`;
}

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
 * can answer, read directly, save notes, or any combination, and at least one
 * is required before the rest of the profile means anything.
 */
// `hideLegend` is for a caller whose own section heading already asks the
// question — the wizards. The legend still labels the fieldset for assistive
// technology; only its on-screen duplicate goes away.
export function CapabilityPicker({ value, onChange, policies = [], disabled = false, requiresAnswer = false, hideLegend = false, idPrefix = "capability" }) {
  const fallbackPolicy = defaultPolicyFamilyId(policies);
  // What a capability held when it was switched off, so switching it back on
  // restores the boundary the owner had chosen rather than inheriting the
  // other capability's.
  const removed = useRef({});
  const capabilities = [
    {
      id: "answer",
      label: "Answer",
      detail: "Ask questions using allowed sources. A privacy policy can review every answer before it is released.",
      locked: requiresAnswer,
    },
    {
      id: "direct",
      label: "Direct",
      detail: "Search and read raw matching records.",
      // Sits inside the card's own description and turns red once the card is
      // chosen, so the consequence is loudest exactly when it applies.
      warning: "Direct is not protected by a privacy policy.",
      risk: true,
    },
    {
      id: "notes",
      label: "Notes",
      detail: "Save notes with Tell Omnesis. The agent's name is recorded with each note. This does not grant access to read existing notes.",
    },
  ];
  const chosen = capabilities.some((capability) => value[capability.id] || capability.locked);
  const requiredNoteId = `${idPrefix}-answer-required`;
  const emptyId = `${idPrefix}-no-capability`;
  return html`<fieldset
    class="access-capability-presets"
    disabled=${disabled}
    aria-describedby=${chosen ? undefined : emptyId}
  >
    <legend class=${hideLegend ? "sr-only" : undefined}>What should this connection be allowed to do?</legend>
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
          onChange(
            restored
              ? { ...value, [capability.id]: restored }
              : withCapability(value, capability.id, enabled, fallbackPolicy),
          );
        }}
      />
      <span><strong>${capability.label}</strong><small>${capability.detail}${capability.warning && html` <b class="access-capability-warning">${capability.warning}</b>`}</small></span>
    </label>`)}
    ${requiresAnswer && html`<p class="access-required-note" id=${requiredNoteId}>Answer is required by this integration.</p>`}
    ${!chosen && html`<p class="access-field-error" id=${emptyId} role="alert">${NO_CAPABILITY_MESSAGE}</p>`}
  </fieldset>`;
}

export function GrantDataPrivacy({ value, onChange, sources = [], policies = [], disabled = false, linkSources = true, onLinkSources = () => {}, idPrefix = "grant-data" }) {
  const both = Boolean(value.answer && value.direct);
  const updateRule = (capability) => (rule) => onChange({ ...value, [capability]: rule });
  const updateShared = (rule) => onChange({
    ...value,
    answer: copyRuleSources(value.answer, rule),
    direct: copyRuleSources(value.direct, rule),
  });
  const sharedRule = value.answer ?? value.direct;
  return html`<div class="grant-data-privacy">
    ${both && html`<fieldset class="grant-builder-link-sources" disabled=${disabled}>
      <legend>Sources for Answer and Direct</legend>
      <label>
        <input type="radio" name=${`${idPrefix}-link-sources`} checked=${linkSources}
          onChange=${() => {
            // Re-linking adopts Answer's boundary for Direct, so the one list
            // shown next is the one both capabilities will actually use.
            onChange({ ...value, direct: copyRuleSources(value.direct, value.answer) });
            onLinkSources(true);
          }} />
        <span><strong>Allow the same sources for Answer and Direct</strong><small>One selection controls both capabilities.</small></span>
      </label>
      <label>
        <input type="radio" name=${`${idPrefix}-link-sources`} checked=${!linkSources}
          onChange=${() => onLinkSources(false)} />
        <span><strong>Allow different sources</strong><small>Direct may expose raw records, so a narrower boundary can be useful.</small></span>
      </label>
    </fieldset>`}
    ${both && linkSources
      ? html`<${SourceBoundary} capability="shared" label="Sources available to Answer and Direct"
          rule=${sharedRule} sources=${sources} disabled=${disabled} onChange=${updateShared} idPrefix=${idPrefix} />`
      : ["answer", "direct"].map((capability) => value[capability] && html`<${SourceBoundary} key=${capability}
          capability=${capability} rule=${value[capability]} sources=${sources} disabled=${disabled}
          onChange=${updateRule(capability)} idPrefix=${idPrefix} />`)}
    ${value.answer && html`<${AnswerRelease} rule=${value.answer} policies=${policies} disabled=${disabled}
      onChange=${updateRule("answer")} idPrefix=${idPrefix} />`}
  </div>`;
}

function accessDescription(rule, sources, policies) {
  const connected = sources.filter((source) => source.available !== false);
  const allowed = connected.filter((source) => isSourceAllowed(rule, sourceId(source)));
  const future = rule.sources.mode === "allowlist" ? "New sources remain blocked until you allow them." : "New sources are allowed automatically.";
  const privacy = rule.capability === "answer"
    ? rule.release.mode === "reviewed"
      ? `Reviewed with “${policyFamilyName(policies.find((candidate) => policyFamilyId(candidate) === rule.release.policyFamilyId) ?? {})}”.`
      : "No privacy review."
    : "No privacy review; raw records may be returned.";
  return {
    allowed,
    total: connected.length,
    future,
    privacy,
    privacyRisk: rule.capability === "answer" && rule.release.mode === "unreviewed",
  };
}

export function EffectiveAccessSummary({ rules, sources, policies, heading = "Effective access" }) {
  return html`<section class="grant-builder-summary" aria-label=${heading}>
    <strong>${heading}</strong>
    ${["answer", "direct"].flatMap((capability) => {
      const rule = rules[capability];
      if (!rule) return [];
      const detail = accessDescription(rule, sources, policies);
      return [html`<div class=${`grant-review-row${capability === "direct" ? " is-risk" : ""}`} key=${capability}>
        <${CapabilityBadge} capability=${capability} unreviewed=${detail.privacyRisk} />
        <span>${detail.allowed.length} of ${detail.total} connected source${detail.total === 1 ? "" : "s"}. <span class=${detail.privacyRisk ? "grant-review-risk" : undefined}>${detail.privacy}</span></span>
        <small>${detail.future}</small>
      </div>`];
    })}
    ${rules.notes && html`<div class="grant-review-row"><${CapabilityBadge} capability="notes" /><span>Save notes with the agent's name recorded.</span><small>Does not grant access to read existing notes.</small></div>`}
  </section>`;
}

export function GrantBuilder({ value, onChange, sources = [], policies = [], disabled = false, requiresAnswer = false, idPrefix = "grant-builder" }) {
  const [linkSources, setLinkSources] = useState(rulesShareSources(value));
  const error = validateGrantRules(value, sources);
  return html`<div class="grant-builder" data-valid=${error ? "false" : "true"}>
    <${CapabilityPicker} value=${value} onChange=${onChange} policies=${policies} disabled=${disabled}
      requiresAnswer=${requiresAnswer} />
    <${GrantDataPrivacy} value=${value} onChange=${onChange} sources=${sources} policies=${policies}
      disabled=${disabled} linkSources=${linkSources} onLinkSources=${setLinkSources} idPrefix=${idPrefix} />
    <${EffectiveAccessSummary} rules=${value} sources=${sources} policies=${policies} />
    ${releaseError(value) && html`<p class="access-field-error" role="alert">${releaseError(value)}</p>`}
  </div>`;
}

export { newGrantRule };
