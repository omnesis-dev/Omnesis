// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The pages an access level opens on.
//
// Editing a level is a three-step wizard that changes what every connection
// using it may do, which sources it reads and under which policy, then shows
// the current and proposed permissions side by side — and names the
// connections the change reaches — before saving on the level's revision.
// Creating a level asks for its name and runs the same wizard.
//
// Each page's save is guarded by a ref set the moment it starts: the disabled
// button only follows on the next render, so a second press in the same moment
// is refused rather than sent twice.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { createAccessLevel, updateAccessLevel } from "../../api.js";
import { EffectiveAccessSummary } from "../../components/grant-builder.js";
import {
  defaultPolicyFamilyId,
  newGrantRule,
  rulesShareSources,
  serializeGrantRules,
  validateGrantRules,
} from "../../components/grant-builder-state.js";
import { GrantWizard } from "./grant-wizard.js";
import { LEVEL_NAME_TAKEN_MESSAGE, NameField, levelNameTaken, validAccessName } from "./name-fields.js";
import { KindIcon } from "../../lib/device-kind-icon.js";
import {
  accessRules,
  connectionCountLabel,
  deviceCountLabel,
  errorMessage,
  levelDevices,
  overviewPolicies,
} from "./shared.js";

const STEPS = ["Permissions", "Data & privacy", "Review changes"];

function PageHeader({ title, busy, onClose, headingRef }) {
  return html`<header class="access-page-header">
    <button type="button" class="doc-back access-page-back" disabled=${busy} onClick=${onClose}>← Back to access</button>
    <div>
      <span class="access-eyebrow">Access level</span>
      <h2 ref=${headingRef} tabIndex="-1">${title}</h2>
    </div>
  </header>`;
}

/** "2 connections and 1 integration": who uses a level, leaving out what none do. */
function usersLabel(count, devices) {
  return [count > 0 ? connectionCountLabel(count) : "", devices > 0 ? deviceCountLabel(devices) : ""]
    .filter(Boolean)
    .join(" and ");
}

export function saveChangesLabel(count, devices = 0) {
  return count + devices > 1 ? `Save changes for ${usersLabel(count, devices)}` : "Save changes";
}

/** What the review says is affected, or that nothing uses the level yet. */
function impactHeading(count, devices) {
  if (count === 0 && devices === 0) return "No connections use this access level yet";
  return `${usersLabel(count, devices)} affected`;
}

/**
 * @param {object} props
 * @param {object} props.level        the level as the overview lists it.
 * @param {Array<{ id: string, name: string }>} props.connections  the connections using it.
 * @param {() => Promise<void>} props.onGone  re-reads the overview when the level no longer exists.
 */
export function LevelEditorPage({ level, connections, overview, onSaved, onConflict, onGone, onClose, headingRef }) {
  const policies = overviewPolicies(overview);
  const sources = overview.sources ?? [];
  const initial = accessRules(level, overview);
  const [value, setValue] = useState(initial);
  const [step, setStep] = useState(1);
  const [linkSources, setLinkSources] = useState(rulesShareSources(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);
  const validationError = validateGrantRules(value);

  useEffect(() => { headingRef?.current?.focus(); }, []);

  async function save() {
    if (validationError || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      await updateAccessLevel(level.id, { expectedRevision: level.revision, rules: serializeGrantRules(value) });
      await onSaved();
      onClose();
    } catch (error) {
      if (error?.status === 409 && error?.serverMessage === "stale-revision") {
        await onConflict();
        onClose();
      } else if (error?.status === 404) {
        await onGone();
      } else if (error?.serverMessage === "level-in-use") {
        setError("Integrations on this access level ask it for answers. Put them on another level before removing Answer.");
      } else {
        setError(errorMessage(error, "The access level could not be updated."));
      }
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  const count = connections.length;
  const devices = levelDevices(level);
  return html`<div class="access-editor-page">
    <${PageHeader} title=${`Edit ${level.name}`} busy=${busy} onClose=${onClose} headingRef=${headingRef} />
    <${GrantWizard}
      steps=${STEPS}
      step=${step}
      onStep=${setStep}
      rules=${value}
      onRules=${setValue}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${setLinkSources}
      disabled=${busy}
      idPrefix=${`level-${level.id}`}
      error=${error}
      copy=${{
        one: { heading: "Choose permissions", blurb: "Choose what every connection using this access level may do." },
        two: { heading: "Choose data and privacy" },
        three: { heading: "Review changes", blurb: "Compare the current permissions with the ones that will replace them." },
      }}
      review=${html`
        <div class="access-review-comparison">
          <${EffectiveAccessSummary} rules=${initial} sources=${sources} policies=${policies} heading="Current permissions" />
          <${EffectiveAccessSummary} rules=${value} sources=${sources} policies=${policies} heading="Proposed permissions" />
        </div>
        <section class="access-impact" aria-label="Affected connections and integrations">
          <strong>${impactHeading(count, devices.length)}</strong>
          ${count || devices.length
            ? html`<ul>
                ${connections.map((connection) => html`<li key=${connection.id}>${connection.name}</li>`)}
                ${devices.map((device) => html`<li key=${device.id} class="access-impact-device"><${KindIcon} kind=${device.kind} size=${13} class="access-device-icon" />${device.name} <span class="access-muted">(integration)</span></li>`)}
              </ul>`
            : null}
          <p>Connected agents receive the new permissions when they refresh. They do not need to reconnect.${devices.length
            ? " An integration's next question uses them."
            : ""}</p>
        </section>`}
      leadAction=${html`<button type="button" class="btn-ghost" disabled=${busy} onClick=${onClose}>Cancel</button>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || Boolean(validationError)} onClick=${save}>${busy ? "Saving…" : saveChangesLabel(count, devices.length)}</button>`}
    />
  </div>`;
}

/** A new access level: its name, then the permissions it holds. `onCreated(level)` follows a save. */
export function NewLevelPage({ overview, onCreated, onClose, headingRef }) {
  const policies = overviewPolicies(overview);
  const sources = overview.sources ?? [];
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [value, setValue] = useState(() => ({
    answer: newGrantRule("answer", defaultPolicyFamilyId(policies, overview.defaultPolicyFamilyId)),
  }));
  const [step, setStep] = useState(1);
  const [linkSources, setLinkSources] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);
  // A name a listed level already has is refused while it is typed; the
  // gateway's own refusal stays the backstop for a level created meanwhile.
  const taken = levelNameTaken(name, overview.levels ?? []);
  const ready = validAccessName(name) && !taken && !validateGrantRules(value);

  useEffect(() => { headingRef?.current?.focus(); }, []);

  // Leaving the first step is when an empty name becomes worth saying: the
  // review cannot be saved without one.
  const moveTo = (next) => {
    setNameTouched(true);
    setStep(next);
  };

  async function create() {
    if (!ready) {
      setNameTouched(true);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await createAccessLevel({ name: name.trim(), rules: serializeGrantRules(value) });
      await onCreated(result?.level ?? { name: name.trim() });
      onClose();
    } catch (error) {
      setError(error?.serverMessage === "level-name-taken"
        ? LEVEL_NAME_TAKEN_MESSAGE
        : errorMessage(error, "The access level could not be created."));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return html`<div class="access-editor-page">
    <${PageHeader} title="New access level" busy=${busy} onClose=${onClose} headingRef=${headingRef} />
    <div class="access-level-name-form">
      <${NameField}
        id="access-new-level-name"
        label="Access level name"
        value=${name}
        onInput=${(next) => { setName(next); setNameTouched(true); }}
        emptyMessage=${nameTouched ? "Enter a name for this access level." : ""}
        conflictMessage=${taken ? LEVEL_NAME_TAKEN_MESSAGE : ""}
        disabled=${busy}
      />
    </div>
    <${GrantWizard}
      steps=${["Permissions", "Data & privacy", "Review"]}
      step=${step}
      onStep=${moveTo}
      rules=${value}
      onRules=${setValue}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${setLinkSources}
      disabled=${busy}
      idPrefix="new-level"
      error=${error}
      copy=${{
        one: { heading: "Choose permissions", blurb: "Choose what connections using this access level may do." },
        two: { heading: "Choose data and privacy" },
        three: { heading: "Review" },
      }}
      review=${html`
        <dl class="access-review-rows" aria-label="New access level">
          <div>
            <dt>Access level name</dt>
            <dd>${!validAccessName(name)
              ? html`<span class="access-field-error">Enter a name for this access level.</span>`
              : taken
                ? html`<span class="access-field-error">${LEVEL_NAME_TAKEN_MESSAGE}</span>`
                : name.trim()}</dd>
          </div>
        </dl>
        <${EffectiveAccessSummary} rules=${value} sources=${sources} policies=${policies} heading="Permissions" />`}
      leadAction=${html`<button type="button" class="btn-ghost" disabled=${busy} onClick=${onClose}>Cancel</button>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || !ready} onClick=${create}>${busy ? "Creating…" : "Create access level"}</button>`}
    />
  </div>`;
}
