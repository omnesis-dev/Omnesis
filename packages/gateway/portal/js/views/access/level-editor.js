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

import { expectedFilterRevisions } from "../../components/source-filter-state.js";
import { createAccessLevel, updateAccessLevel, getAccessOverview } from "../../api.js";
import { EffectiveAccessSummary } from "../../components/grant-builder.js";
import {
  defaultPolicyFamilyId,
  newGrantRule,
  rulesShareSources,
  serializeGrantRules,
  serializeNewAuthorityRules,
  newAuthorityFilterError,
  validateGrantRules,
} from "../../components/grant-builder-state.js";
import { GrantWizard } from "./grant-wizard.js";
import {
  LEVEL_NAME_TAKEN_MESSAGE,
  NameField,
  levelNameTaken,
  validAccessName,
} from "./name-fields.js";
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
    <button type="button" class="doc-back access-page-back" disabled=${busy} onClick=${onClose}>
      ← Back to access
    </button>
    <div>
      <span class="access-eyebrow">Access level</span>
      <h2 ref=${headingRef} tabindex="-1">${title}</h2>
    </div>
  </header>`;
}

/** "2 connections and 1 integration": who uses a level, leaving out what none do. */
function usersLabel(count, devices) {
  return [
    count > 0 ? connectionCountLabel(count) : "",
    devices > 0 ? deviceCountLabel(devices) : "",
  ]
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
export function LevelEditorPage({
  level,
  connections,
  overview,
  onSaved,
  onConflict,
  onGone,
  onClose,
  headingRef,
}) {
  const policies = overviewPolicies(overview);
  const sources = overview.sources ?? [];
  const [baseline, setBaseline] = useState(level);
  const initial = accessRules(baseline, overview);
  const [value, setValue] = useState(initial);
  const [step, setStep] = useState(1);
  const [linkSources, setLinkSources] = useState(rulesShareSources(initial));
  const [linkFilters, setLinkFilters] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const reloadController = useRef(null);
  const inFlightRef = useRef(false);
  const validationError = validateGrantRules(value, sources);

  useEffect(() => {
    headingRef?.current?.focus();
    return () => {
      mounted.current = false;
      reloadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (level.revision !== baseline.revision) {
      setStale(true);
      setError(
        "This access level changed elsewhere. Your draft is retained. Reload the latest level before saving.",
      );
    }
  }, [level.revision, baseline.revision]);

  async function reloadLatest() {
    if (inFlightRef.current) return;
    const controller = new AbortController();
    reloadController.current?.abort();
    reloadController.current = controller;
    setBusy(true);
    try {
      const fresh = await getAccessOverview(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const current = fresh.levels?.find((candidate) => candidate.id === baseline.id);
      if (!current) {
        await onGone();
        return;
      }
      await onConflict();
      if (!mounted.current || controller.signal.aborted) return;
      setBaseline(current);
      setValue(accessRules(current, fresh));
      setLinkFilters(false);
      setLinkSources(rulesShareSources(accessRules(current, fresh)));
      setStale(false);
      setError("");
      setStep(1);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current)
        setError(
          errorMessage(
            error,
            "The latest access level could not be loaded. Your draft is retained.",
          ),
        );
    } finally {
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }

  async function save() {
    if (validationError || stale || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      await updateAccessLevel(baseline.id, {
        expectedRevision: baseline.revision,
        expectedFilterRevisions: expectedFilterRevisions(initial),
        rules: serializeGrantRules(value),
      });
      if (!mounted.current) return;
      await onSaved();
      if (mounted.current) onClose();
    } catch (error) {
      if (!mounted.current) return;
      if (error?.status === 409 && error?.serverMessage !== "level-in-use") {
        setStale(true);
        setError(
          "This access level changed while you were editing. Your draft is retained. Reload the latest level before saving again.",
        );
      } else if (error?.status === 404) {
        await onGone();
      } else if (error?.serverMessage === "level-in-use") {
        setError(
          "Integrations on this access level ask it for answers. Put them on another level before removing Answer.",
        );
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
    <${PageHeader}
      title=${`Edit ${level.name}`}
      busy=${busy}
      onClose=${onClose}
      headingRef=${headingRef}
    />
    <${GrantWizard}
      steps=${STEPS}
      step=${step}
      onStep=${setStep}
      rules=${value}
      sourceFiltersEnabled=${overview.sourceFilters?.enabled === true}
      accessLevel=${level.id}
      linkFilters=${linkFilters}
      onLinkFilters=${setLinkFilters}
      onRules=${setValue}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${setLinkSources}
      disabled=${busy}
      idPrefix=${`level-${level.id}`}
      error=${error}
      copy=${{
        one: {
          heading: "Choose permissions",
          blurb: "Choose what every connection using this access level may do.",
        },
        two: { heading: "Choose data and privacy" },
        three: {
          heading: "Review changes",
          blurb: "Compare the current permissions with the ones that will replace them.",
        },
      }}
      review=${html` <div class="access-review-comparison">
          <${EffectiveAccessSummary}
            rules=${initial}
            sources=${sources}
            policies=${policies}
            heading="Current permissions"
          />
          <${EffectiveAccessSummary}
            rules=${value}
            sources=${sources}
            policies=${policies}
            heading="Proposed permissions"
          />
        </div>
        <section class="access-impact" aria-label="Affected connections and integrations">
          <strong>${impactHeading(count, devices.length)}</strong>
          ${
            count || devices.length
              ? html`<ul>
                  ${connections.map((connection) => html`<li key=${connection.id}>${connection.name}</li>`)}
                  ${devices.map((device) => html`<li key=${device.id} class="access-impact-device"><${KindIcon} kind=${device.kind} size=${13} class="access-device-icon" />${device.name} <span class="access-muted">(integration)</span></li>`)}
                </ul>`
              : null
          }
          <p>
            Connected agents receive the new permissions when they refresh. They do not need to
            reconnect.${devices.length ? " An integration's next question uses them." : ""}
          </p>
        </section>`}
      leadAction=${html`<span><button type="button" class="btn-ghost" disabled=${busy} onClick=${onClose}>Cancel</button>${stale ? html`<button type="button" class="btn-secondary" disabled=${busy} onClick=${reloadLatest}>Reload latest and discard draft</button>` : null}</span>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || stale || Boolean(validationError)} onClick=${save}>${busy ? "Saving…" : saveChangesLabel(count, devices.length)}</button>`}
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
  const [linkFilters, setLinkFilters] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);
  const mounted = useRef(true);
  // A name a listed level already has is refused while it is typed; the
  // gateway's own refusal stays the backstop for a level created meanwhile.
  const taken = levelNameTaken(name, overview.levels ?? []);
  const creationError = newAuthorityFilterError(value, overview.sourceFilters?.enabled === true);
  const ready = validAccessName(name) && !taken && !creationError && !validateGrantRules(value, sources);

  useEffect(() => {
    headingRef?.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

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
      const result = await createAccessLevel({
        name: name.trim(),
        rules: serializeNewAuthorityRules(value),
      });
      if (!mounted.current) return;
      await onCreated(result?.level ?? { name: name.trim() });
      if (mounted.current) onClose();
    } catch (error) {
      if (!mounted.current) return;
      setError(
        error?.serverMessage === "level-name-taken"
          ? LEVEL_NAME_TAKEN_MESSAGE
          : errorMessage(error, "The access level could not be created."),
      );
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return html`<div class="access-editor-page">
    <${PageHeader}
      title="New access level"
      busy=${busy}
      onClose=${onClose}
      headingRef=${headingRef}
    />
    <div class="access-level-name-form">
      <${NameField}
        id="access-new-level-name"
        label="Access level name"
        value=${name}
        onInput=${(next) => {
          setName(next);
          setNameTouched(true);
        }}
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
      isNew
      sourceFiltersEnabled=${overview.sourceFilters?.enabled === true}
      linkFilters=${linkFilters}
      onLinkFilters=${setLinkFilters}
      onRules=${setValue}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${setLinkSources}
      disabled=${busy}
      idPrefix="new-level"
      error=${error || creationError}
      copy=${{
        one: {
          heading: "Choose permissions",
          blurb: "Choose what connections using this access level may do.",
        },
        two: { heading: "Choose data and privacy" },
        three: { heading: "Review" },
      }}
      review=${html` <dl class="access-review-rows" aria-label="New access level">
          <div>
            <dt>Access level name</dt>
            <dd>
              ${
                !validAccessName(name)
                  ? html`<span class="access-field-error"
                      >Enter a name for this access level.</span
                    >`
                  : taken
                    ? html`<span class="access-field-error">${LEVEL_NAME_TAKEN_MESSAGE}</span>`
                    : name.trim()
              }
            </dd>
          </div>
        </dl>
        <${EffectiveAccessSummary}
          rules=${value}
          sources=${sources}
          policies=${policies}
          heading="Permissions"
        />`}
      leadAction=${html`<button type="button" class="btn-ghost" disabled=${busy} onClick=${onClose}>Cancel</button>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || !ready} onClick=${create}>${busy ? "Creating…" : "Create access level"}</button>`}
    />
  </div>`;
}
