// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The first step of approving a connection: what it is called and which
// access level it uses — or, for an agent signing in again, which existing
// connection it takes over.
//
// The gateway sends a proposal with the request: a default name for the
// connection and for a new level, the most relevant connection from the same
// app, and the choice it recommends. The step opens on that recommendation
// and never acts on it by itself; every approval is the owner's choice.

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";

import { CapabilityTriad } from "../../components/grant-builder.js";
import {
  defaultPolicyFamilyId,
  newGrantRule,
  normalizeGrantRules,
  policyFamilyId,
} from "../../components/grant-builder-state.js";
import { timeAgo } from "../../lib/format.js";
import { ACCESS_NAME_MAX, NameField, NewLevelChoice, levelNameTaken, validAccessName } from "./name-fields.js";
import {
  LEVEL_HELPER,
  accessLevels,
  accessRules,
  compareNames,
  levelUsersLabel,
  connectionEntries,
  isLiveConnection,
  overviewPolicies,
} from "./shared.js";

export const NEW_LEVEL = "new";

/**
 * The rules a new access level opens on.
 *
 * When the gateway found a connection from the same app (`match`, anything
 * carrying that connection's `grant`), the level starts from the permissions
 * that connection has today; otherwise from Answer alone, reviewed under the
 * default policy, with no source allowed until the owner picks one. An
 * integration that requires Answer gets it either way.
 */
export function initialAuthorizationRules(request, match, policies, configuredPolicyId) {
  const fallbackPolicy = defaultPolicyFamilyId(policies, configuredPolicyId);
  const rules = match
    ? withKnownPolicy(
        normalizeGrantRules(match.grant.rules ?? match.grant.capabilities, fallbackPolicy),
        policies,
        fallbackPolicy,
      )
    : { answer: newGrantRule("answer", fallbackPolicy) };
  return request.requiresAnswer && !rules.answer
    ? { ...rules, answer: newGrantRule("answer", fallbackPolicy) }
    : rules;
}

/**
 * The same rules, with a reviewed Answer moved onto `fallbackPolicy` when the
 * policy it names is not among `policies` — a connection's permissions can
 * name a policy archived since, and a review must not carry that id to approval.
 */
function withKnownPolicy(rules, policies, fallbackPolicy) {
  const release = rules.answer?.release;
  if (
    release?.mode !== "reviewed" ||
    policies.some((policy) => policyFamilyId(policy) === release.policyFamilyId)
  ) {
    return rules;
  }
  return { ...rules, answer: { ...rules.answer, release: { mode: "reviewed", policyFamilyId: fallbackPolicy } } };
}

/**
 * What the step can offer this request: the access levels, the suggested one
 * first and the rest by name, and the live connections a sign-in could take
 * over, most recently used first. An agent that needs Answer cannot use
 * permissions without it, so those choices are there but disabled. A level is
 * suggested when the connection the gateway matched uses it; a connection is
 * suggested when the gateway recommends replacing it.
 */
export function connectionOptions(request, connection, overview) {
  const match = connection.match ?? null;
  const known = accessLevels(overview);
  const levels = known
    .map((level) => {
      const rules = accessRules(level, overview);
      return {
        level,
        rules,
        suggested: Boolean(match?.levelId) && match.levelId === level.id,
        disabled: Boolean(request.requiresAnswer && !rules.answer),
      };
    })
    .sort((left, right) => Number(right.suggested) - Number(left.suggested));
  const replaceable = connectionEntries(overview)
    .filter(isLiveConnection)
    .map((entry) => {
      const rules = accessRules(entry.grant, overview);
      return {
        entry,
        rules,
        level: known.find((level) => level.id === entry.levelId) ?? null,
        suggested: connection.recommended === "replace" && match?.connectionId === entry.id,
        disabled: Boolean(request.requiresAnswer && !rules.answer),
      };
    })
    .sort((left, right) =>
      (right.entry.lastUsedAt ?? 0) - (left.entry.lastUsedAt ?? 0)
      || compareNames(left.entry.name, right.entry.name));
  return { levels, replaceable };
}

/**
 * Where the step opens: the gateway's recommendation, where it is still a
 * choice the owner can make. A recommended level or connection that is gone,
 * or that cannot serve an agent needing Answer, opens on a new access level
 * instead. A new level's permissions start from the connection the gateway
 * matched, when it matched one.
 */
export function initialConnectionChoice(request, connection, overview) {
  const { levels, replaceable } = connectionOptions(request, connection, overview);
  const match = connection.match ?? null;
  const replaceTarget = replaceable.find((option) => option.suggested && !option.disabled) ?? null;
  const suggestedLevel = connection.recommended === "existing-level"
    ? levels.find((option) => option.suggested && !option.disabled) ?? null
    : null;
  return {
    mode: replaceTarget ? "replace" : "new",
    name: connection.defaultName.slice(0, ACCESS_NAME_MAX),
    levelChoice: suggestedLevel ? suggestedLevel.level.id : NEW_LEVEL,
    levelName: connection.defaultLevelName.slice(0, ACCESS_NAME_MAX),
    replaceId: replaceTarget?.entry.id ?? null,
    rules: initialAuthorizationRules(request, match, overviewPolicies(overview), overview.defaultPolicyFamilyId),
  };
}

/**
 * Whether the step's choice is complete enough to continue. A new level needs
 * a name no listed level already has.
 */
export function connectionStepReady(choice, options) {
  if (choice.mode === "replace") {
    return options.replaceable.some((option) => option.entry.id === choice.replaceId && !option.disabled);
  }
  if (!validAccessName(choice.name)) return false;
  if (choice.levelChoice === NEW_LEVEL) {
    return validAccessName(choice.levelName)
      && !levelNameTaken(choice.levelName, options.levels.map((option) => option.level));
  }
  return options.levels.some((option) => option.level.id === choice.levelChoice && !option.disabled);
}

function NeedsAnswer({ disabled }) {
  return disabled ? html`<small class="access-choice-blocked">This agent needs Answer.</small>` : null;
}

function SuggestedTag() {
  return html` <span class="portal-pill portal-pill-accent access-suggested-tag">Suggested</span>`;
}

function LevelChoices({ choice, options, match, onChange, disabled, idPrefix }) {
  return html`
    <${NameField}
      id=${`${idPrefix}-connection-name`}
      label="Connection name"
      value=${choice.name}
      onInput=${(name) => onChange({ name })}
      emptyMessage="Enter a name for this connection."
      disabled=${disabled}
      inline
    />
    <fieldset class="access-choice-list" disabled=${disabled}>
      <legend class="access-choice-legend">Access level</legend>
      <p class="access-choice-helper">${LEVEL_HELPER}</p>
      ${options.levels.map((option) => html`<label
        key=${option.level.id}
        class=${`access-choice-option${option.disabled ? " is-disabled" : ""}`}
      >
        <input
          type="radio"
          name=${`${idPrefix}-level`}
          checked=${choice.levelChoice === option.level.id}
          disabled=${option.disabled}
          onChange=${() => onChange({ levelChoice: option.level.id })}
        />
        <span class="access-choice-text">
          <strong>${option.level.name}${option.suggested ? html`<${SuggestedTag} />` : null}</strong>
          <small>${levelUsersLabel(option.level)}</small>
          ${option.suggested ? html`<small>${`${match.connectionName} uses this access level.`}</small>` : null}
          <${NeedsAnswer} disabled=${option.disabled} />
        </span>
        <${CapabilityTriad} rules=${option.rules} />
      </label>`)}
      <${NewLevelChoice}
        radioName=${`${idPrefix}-level`}
        checked=${choice.levelChoice === NEW_LEVEL}
        onSelect=${() => onChange({ levelChoice: NEW_LEVEL })}
        fieldId=${`${idPrefix}-level-name`}
        levelName=${choice.levelName}
        onLevelName=${(levelName) => onChange({ levelName })}
        levels=${options.levels.map((option) => option.level)}
        disabled=${disabled}
      />
    </fieldset>
  `;
}

/**
 * The connections a sign-in could take over. The step's heading and blurb
 * already say what replacing does, so the list carries only the choices; the
 * one the gateway recommends says why inside its own card.
 */
function ReplaceChoices({ choice, options, onChange, disabled, idPrefix }) {
  return html`<fieldset class="access-choice-list" disabled=${disabled}>
    <legend class="sr-only">Connection to replace</legend>
    ${options.replaceable.map((option) => html`<label
      key=${option.entry.grant.id}
      class=${`access-choice-option${option.disabled ? " is-disabled" : ""}`}
    >
      <input
        type="radio"
        name=${`${idPrefix}-replace`}
        checked=${choice.replaceId === option.entry.id}
        disabled=${option.disabled}
        onChange=${() => onChange({ replaceId: option.entry.id })}
      />
      <span class="access-choice-text">
        <strong>${option.entry.name}${option.suggested ? html`<${SuggestedTag} />` : null}</strong>
        ${option.level ? html`<small>${`Uses ${option.level.name}`}</small>` : null}
        <small>${option.entry.lastUsedAt ? `Last used ${timeAgo(option.entry.lastUsedAt)}` : "Never used"}</small>
        ${option.suggested ? html`<small class="access-suggestion">Already connected on this device.</small>` : null}
        <${NeedsAnswer} disabled=${option.disabled} />
      </span>
    </label>`)}
  </fieldset>`;
}

/**
 * The step itself. `onChange(patch)` merges into the choice. Switching between
 * a new connection and a replacement moves focus to the first choice the other
 * mode offers, since the button that was pressed is gone.
 */
export function ConnectionStep({ choice, options, match, onChange, disabled = false, idPrefix }) {
  const rootRef = useRef(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    rootRef.current?.querySelector("input:not([disabled])")?.focus();
  }, [choice.mode]);

  const shared = { choice, options, match, onChange, disabled, idPrefix };
  return html`<div class="access-connection-step" ref=${rootRef}>
    ${choice.mode === "replace"
      ? html`
          <${ReplaceChoices} ...${shared} />
          <button type="button" class="access-mode-switch" disabled=${disabled} onClick=${() => onChange({ mode: "new" })}>
            Connect as a new connection instead
          </button>`
      : html`
          <${LevelChoices} ...${shared} />
          ${options.replaceable.length > 0
            ? html`<button type="button" class="access-mode-switch" disabled=${disabled} onClick=${() => onChange({ mode: "replace" })}>
                Signing in again? Replace a connection
              </button>`
            : null}`}
  </div>`;
}
