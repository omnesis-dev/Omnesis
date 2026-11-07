// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Access-level pages own persistence, revision conflicts and draft lifetime.
// Focused decision components render the create path and targeted edits.

import { html } from "htm/preact";
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { expectedFilterRevisions } from "../../components/source-filter-state.js";
import { createAccessLevel, updateAccessLevel, getAccessOverview } from "../../api.js";
import {
  defaultPolicyFamilyId,
  newGrantRule,
  rulesShareSources,
  serializeGrantRules,
  serializeNewAuthorityRules,
  newAuthorityFilterError,
  validateGrantRules,
} from "../../components/grant-builder-state.js";
import { LevelFlow } from "./level-flow.js";
import { useLevelExitGuard } from "./level-exit-guard.js";
import { sameDecision } from "./level-flow-state.js";
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
  const [step, setStep] = useState("overview");
  const [linkSources, setLinkSources] = useState(rulesShareSources(initial));
  const [linkFilters, setLinkFilters] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const reloadController = useRef(null);
  const inFlightRef = useRef(false);
  const validationError = validateGrantRules(value, sources);
  const exit = useLevelExitGuard(!sameDecision(initial, value), busy, onClose, inFlightRef);

  useEffect(() => {
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
    inFlightRef.current = true;
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
      setStep("overview");
    } catch (error) {
      if (!controller.signal.aborted && mounted.current)
        setError(
          errorMessage(
            error,
            "The latest access level could not be loaded. Your draft is retained.",
          ),
        );
    } finally {
      inFlightRef.current = false;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }

  async function save() {
    if (validationError || stale || sameDecision(initial, value) || inFlightRef.current) return;
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
      exit.saved();
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
  return html`<${Fragment}><div class="access-editor-page">
    <${PageHeader}
      title=${`Edit ${level.name}`}
      busy=${busy}
      onClose=${exit.close}
      headingRef=${headingRef}
    />
    <${LevelFlow}
      initial=${initial}
      step=${step}
      onStep=${(next) => {
        if (!inFlightRef.current && !busy) setStep(next);
      }}
      rules=${value}
      sourceFiltersEnabled=${overview.sourceFilters?.enabled === true}
      accessLevel=${level.id}
      linkFilters=${linkFilters}
      onLinkFilters=${(next) => {
        if (!inFlightRef.current && !busy) setLinkFilters(next);
      }}
      onRules=${(next) => {
        if (!inFlightRef.current && !busy) setValue(next);
      }}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${(next) => {
        if (!inFlightRef.current && !busy) setLinkSources(next);
      }}
      disabled=${busy}
      isLocked=${() => inFlightRef.current || busy}
      error=${error || (step === "changes" ? validationError : "")}
      impact=${html` <section
        class="access-impact"
        aria-label="Affected connections and integrations"
      >
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
      recovery=${stale ? html`<button type="button" class="btn-secondary guided-conflict-recovery" disabled=${busy} onClick=${reloadLatest}>Reload latest and discard draft</button>` : null}
      leadAction=${html`<button type="button" class="btn-ghost" disabled=${busy} onClick=${exit.close}>Cancel</button>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || stale || sameDecision(initial, value) || Boolean(validationError)} onClick=${save}>${busy ? "Saving…" : saveChangesLabel(count, devices.length)}</button>`}
    />
  </div>
    ${exit.confirmation}
  <//>`;
}

/** Guided decisions, followed by naming and review. `onCreated(level)` follows a save. */
export function NewLevelPage({ overview, onCreated, onClose, headingRef }) {
  const policies = overviewPolicies(overview);
  const sources = overview.sources ?? [];
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [value, setValue] = useState(() => ({
    answer: newGrantRule("answer", defaultPolicyFamilyId(policies, overview.defaultPolicyFamilyId)),
  }));
  const [step, setStep] = useState("permissions");
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
  const ready =
    validAccessName(name) && !taken && !creationError && !validateGrantRules(value, sources);
  const initialDraft = useRef(value);
  const exit = useLevelExitGuard(
    Boolean(name.trim()) || !sameDecision(initialDraft.current, value),
    busy,
    onClose,
    inFlightRef,
  );

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  // Navigation preserves the draft; name validation belongs to its final step.
  const moveTo = (next) => {
    if (inFlightRef.current || busy) return;
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
      exit.saved();
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

  return html`<${Fragment}><div class="access-editor-page">
    <${PageHeader}
      title="New access level"
      busy=${busy}
      onClose=${exit.close}
      headingRef=${headingRef}
    />
    <${LevelFlow}
      step=${step}
      onStep=${moveTo}
      rules=${value}
      isNew
      sourceFiltersEnabled=${overview.sourceFilters?.enabled === true}
      linkFilters=${linkFilters}
      onLinkFilters=${(next) => {
        if (!inFlightRef.current && !busy) setLinkFilters(next);
      }}
      onRules=${(next) => {
        if (!inFlightRef.current && !busy) setValue(next);
      }}
      sources=${sources}
      policies=${policies}
      linkSources=${linkSources}
      onLinkSources=${(next) => {
        if (!inFlightRef.current && !busy) setLinkSources(next);
      }}
      disabled=${busy}
      isLocked=${() => inFlightRef.current || busy}
      error=${error || creationError || (step === "review" ? validateGrantRules(value, sources) : "")}
      review=${html`<div class="access-level-name-form">
        <${NameField}
          id="access-new-level-name"
          label="Access level name"
          value=${name}
          onInput=${(next) => {
            if (inFlightRef.current || busy) return;
            setName(next);
            setNameTouched(true);
          }}
          emptyMessage=${nameTouched ? "Enter a name for this access level." : ""}
          conflictMessage=${taken ? LEVEL_NAME_TAKEN_MESSAGE : ""}
          disabled=${busy}
        />
      </div>`}
      leadAction=${html`<button type="button" class="btn-ghost" disabled=${busy} onClick=${exit.close}>Cancel</button>`}
      finalAction=${html`<button type="button" class="btn-primary" disabled=${busy || !ready} onClick=${create}>${busy ? "Creating…" : "Create access level"}</button>`}
    />
  </div>
    ${exit.confirmation}
  <//>`;
}
