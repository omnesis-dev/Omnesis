// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Sweeps tab — the scheduled passes the background agent makes over the
// corpus, and what each of them has produced.
//
// One table row per sweep, system and user together, because the question the
// operator is answering is "what runs on this gateway" and splitting the list
// by who wrote it would make that two questions. The row is a scannable
// summary — schedule and counters — and the prose lives in the modal, since a
// paragraph per row turns a list of ten sweeps into a page nobody reads.
//
// A system sweep opens read-only with a Fork action; forking writes a file
// under `<configDir>/sweeps` that layers over the shipped definition, and
// Revert deletes that file and brings the shipped one back.
//
// Every mutation returns the whole resolved list, so the page re-renders from
// the server's answer rather than patching a local copy — a fork changes an
// origin, a revert can resurrect a system sweep, and guessing either would
// eventually disagree with the scheduler.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { Modal } from "../components/modal.js";
import { RowActionMenu } from "../components/row-action-menu.js";
import { getSweeps, saveSweep, forkSweep, setSweepEnabled, deleteSweepFile } from "../api.js";

/**
 * A cadence in whole days — what the scheduler actually counts. A sweep gets
 * one boundary per local day, so an hour count that is not a whole number of
 * days rounds to the nearest one, and showing the raw hours would promise a
 * precision the engine does not have (`36h` runs every 2 days, not every 1.5).
 */
export function cadenceDays(hours) {
  return Math.max(1, Math.round(hours / 24));
}

/** "daily" / "7d" — the effective cadence, in the units the engine counts. */
export function formatCadence(hours) {
  const days = cadenceDays(hours);
  return days === 1 ? "daily" : `${days}d`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDate(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whether the operator's file pins this sweep's prose, rather than only its on/off state. */
export function ownsProse(sweep) {
  return sweep.modified || !sweep.hasSystemVersion;
}

// System / Forked / Yours. A shipped sweep the operator only switched off is
// still System: its prose is untouched and a later release still improves it.
function OriginPill({ sweep }) {
  if (sweep.hasSystemVersion && !sweep.modified) {
    return html`<span class="portal-pill portal-pill-muted" title="Ships with Omnesis; updates with each release"
      >System</span
    >`;
  }
  if (sweep.modified) {
    return html`<span
      class="portal-pill portal-pill-accent"
      title="Your file overrides the sweep Omnesis ships with this id"
      >Forked</span
    >`;
  }
  return html`<span class="portal-pill portal-pill-accent" title="A sweep you wrote">Yours</span>`;
}

/** The schedule columns' explanations — see `COUNTERS` for the rest. */
const SCHEDULE_HELP = {
  every: "How often this sweep runs, counted in whole days.",
  at: "The time of day it lands on. Sweeps run one at a time, so their times are spread out on purpose.",
};

/**
 * What each counter column means, carried as that column's tooltip. "Held" and
 * "Updated" in particular are not guessable from the label alone.
 */
const COUNTERS = [
  { key: "runs", label: "Runs", help: "Scheduled passes that have finished, successful or not." },
  { key: "briefs", label: "Briefs", help: "Cards this sweep wrote that reached your feed." },
  {
    key: "held",
    label: "Held",
    help: "Cards it wrote that were refused before reaching you, because they did not clear the bar for interrupting you. A number climbing here means this sweep is mostly producing noise.",
  },
  { key: "loops", label: "Opened", help: "Commitments it started tracking for the first time." },
  {
    key: "updated",
    label: "Updated",
    help: "Commitments that already existed and which it added to — reconciling with what is tracked rather than opening a duplicate.",
  },
  {
    key: "notes",
    label: "Notes",
    help: "Durable observations it recorded about a document, a person, or a date.",
  },
  { key: "tokens", label: "Tokens", help: "Everything it has cost, input and output combined." },
  { key: "last", label: "Last run", help: "When it last finished." },
];

/** Pull each counter's display value off the DTO's stats block. */
function counterValue(key, stats) {
  switch (key) {
    case "runs":
      return String(stats.runs);
    case "briefs":
      return String(stats.briefsCreated);
    case "held":
      return String(stats.briefsHeld);
    case "loops":
      return String(stats.loopsCreated);
    case "updated":
      return String(stats.loopsTouched);
    case "notes":
      return String(stats.annotationsCreated);
    case "tokens":
      return formatTokens(stats.promptTokens + stats.completionTokens);
    case "last":
      return formatDate(stats.lastRunAt);
    default:
      return "";
  }
}

function SweepRow({ sweep, busy, onOpen, onFork, onToggle, onRevert }) {
  const editable = ownsProse(sweep);
  const items = [
    { label: editable ? "Edit…" : "View…", onSelect: onOpen },
    ...(editable ? [] : [{ label: "Fork to edit", onSelect: onFork, disabled: busy }]),
    { label: sweep.enabled ? "Disable" : "Enable", onSelect: onToggle, disabled: busy },
    ...(editable
      ? [
          {
            label: sweep.hasSystemVersion ? "Revert to system" : "Delete",
            onSelect: onRevert,
            danger: true,
            disabled: busy,
          },
        ]
      : []),
  ];

  return html`
    <tr class=${sweep.enabled ? undefined : "sweep-row-off"}>
      <td>
        <button class="portal-table-name" onClick=${onOpen} title="Open this sweep">
          ${sweep.name}
        </button>
        <div class="portal-table-sub">
          <code>${sweep.id}</code>
          <${OriginPill} sweep=${sweep} />
          ${!sweep.enabled && html`<span class="portal-pill portal-pill-warning">Off</span>`}
        </div>
      </td>
      <td class="portal-table-num">${formatCadence(sweep.cadenceHours)}</td>
      <td class="portal-table-num">
        ${sweep.at}${!sweep.anchorExplicit &&
        html`<span
          class="sweep-auto"
          title="No time was set, so this slot was picked from the sweep's id and placed clear of the morning digest"
        >
          auto</span
        >`}
      </td>
      ${COUNTERS.map(
        (c) => html`<td class="portal-table-num" key=${c.key}>${counterValue(c.key, sweep.stats)}</td>`,
      )}
      <td class="portal-table-actions-col">
        <${RowActionMenu} items=${items} label=${`Actions for ${sweep.name}`} />
      </td>
    </tr>
  `;
}

/**
 * The sweep editor. Read-only for a sweep whose prose still tracks the shipped
 * version — there is nothing of the operator's to edit yet, and offering an
 * editable box that silently forks on save would hide that decision.
 */
function SweepForm({ sweep, readOnly, busy, onSave, onFork, onClose }) {
  const isNew = !sweep;
  const [name, setName] = useState(sweep?.name ?? "");
  const [id, setId] = useState("");
  const [days, setDays] = useState(String(cadenceDays(sweep?.cadenceHours ?? 168)));
  // Blank means "pick a slot for me": the resolver spreads sweeps that name no
  // time across the day and clear of the digest's window. Pre-filling a time
  // here would pile every sweep made in this form onto the same minute, and
  // they drain one at a time.
  const [at, setAt] = useState(sweep?.anchorExplicit ? sweep.at : "");
  const [prose, setProse] = useState(sweep?.steeringPrompt ?? "");
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const d = Number(days);
    if (!Number.isFinite(d) || d < 1) return setError("Run it at least once a day.");
    if (isNew && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      return setError("Id must be lower-case letters, digits and hyphens, e.g. commitments-made.");
    }
    if (prose.trim() === "") return setError("Say what this sweep should look for.");
    try {
      await onSave(isNew ? id : sweep.id, {
        name: name.trim() === "" ? (isNew ? id : sweep.id) : name.trim(),
        cadenceHours: d * 24,
        // `null` — not an omission — is what asks for a derived slot: on an
        // edit the server merges over the file, so omitting the time would
        // leave a previously pinned one exactly where it was.
        at: at === "" ? null : at,
        enabled: sweep?.enabled ?? true,
        steeringPrompt: prose,
        ...(sweep?.temporalAnnotationPrimeDays != null
          ? { temporalAnnotationPrimeDays: sweep.temporalAnnotationPrimeDays }
          : {}),
      });
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  if (readOnly) {
    return html`
      <div class="sweep-form">
        <div class="sweep-form-row">
          <${Field} label="Every"
            ><div class="sweep-readonly">${formatCadence(sweep.cadenceHours)}</div><//
          >
          <${Field} label="At"
            ><div class="sweep-readonly">
              ${sweep.at}${sweep.anchorExplicit ? "" : " (auto)"}
            </div><//
          >
        </div>
        <${Field} label="What it looks for">
          <p class="sweep-readonly-prose">${sweep.steeringPrompt}</p>
        <//>
        <p class="sweep-form-hint">
          This sweep ships with Omnesis, so its wording improves with each release. Fork it to make
          it yours — from then on it keeps whatever you write, and a later release will not change
          it.
        </p>
        <div class="sweep-form-actions">
          <button type="button" class="btn-primary" onClick=${onFork} disabled=${busy}>
            ${busy ? "Forking…" : "Fork to edit"}
          </button>
          <button type="button" class="btn-secondary" onClick=${onClose}>Close</button>
        </div>
      </div>
    `;
  }

  return html`
    <form class="sweep-form" onSubmit=${submit}>
      <div class="sweep-form-row">
        <${Field} label="Name">
          <input
            type="text"
            value=${name}
            onInput=${(e) => setName(e.target.value)}
            placeholder="Commitments I made"
          />
        <//>
        ${isNew &&
        html`<${Field} label="Id">
          <input
            type="text"
            value=${id}
            onInput=${(e) => setId(e.target.value)}
            placeholder="commitments-made"
          />
        <//>`}
      </div>
      <div class="sweep-form-row">
        <${Field} label="Every (days)" narrow>
          <input
            type="number"
            min="1"
            step="1"
            value=${days}
            onInput=${(e) => setDays(e.target.value)}
          />
        <//>
        <${Field} label="At" narrow>
          <input type="time" value=${at} onInput=${(e) => setAt(e.target.value)} />
        <//>
        <p class="sweep-field-note">
          Leave the time blank and Omnesis picks one, spread away from the other sweeps and clear of
          your morning brief. Sweeps run one at a time, so sharing a time makes them queue.
        </p>
      </div>
      <${Field} label="What to look for">
        <textarea
          class="sweep-prose"
          rows="10"
          value=${prose}
          onInput=${(e) => setProse(e.target.value)}
          placeholder="Describe the shape of thing worth surfacing, and when to stay quiet. Name no sources, tools or people — a sweep that does stops being portable."
        ></textarea>
      <//>
      ${error && html`<div class="sweep-error">${error}</div>`}
      <div class="sweep-form-actions">
        <button type="submit" class="btn-primary" disabled=${busy}>
          ${busy ? "Saving…" : "Save"}
        </button>
        <button type="button" class="btn-secondary" onClick=${onClose} disabled=${busy}>
          Cancel
        </button>
      </div>
    </form>
  `;
}

function Field({ label, narrow, children }) {
  return html`<label class=${`sweep-field${narrow ? " sweep-field-narrow" : ""}`}>
    <span>${label}</span>${children}
  </label>`;
}

export function SweepsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // The whole /admin/brain family 404s until the Brain is active. That is a
  // state to explain, not an error to report: the operator has not switched
  // something on, and telling them so beats printing a status code.
  const [inactive, setInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  // null = closed; { id } opens that sweep; { creating: true } opens a blank.
  const [editing, setEditing] = useState(null);

  const load = async () => {
    try {
      setData(await getSweeps());
      setError(null);
      setInactive(false);
    } catch (err) {
      if (err?.status === 404) setInactive(true);
      else setError(err?.message ?? String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Every mutation adopts the server's whole list; see the module note. The
  // row buttons have nowhere of their own to report a failure, so a rejection
  // surfaces at the top of the page rather than vanishing.
  const mutate = async (fn) => {
    setBusy(true);
    try {
      const next = await fn();
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err?.message ?? String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  if (inactive) {
    return html`
      <div class="sweeps-view">
        <p class="sweep-intro">
          Sweeps are scheduled passes the background agent makes over your corpus — each one a
          rhythm and a paragraph saying what to look for.
        </p>
        <div class="sweep-warning">
          The background agent is not running on this gateway, so there are no sweeps to show.
          Assign a model to the <strong>background agent</strong> capability on the Models tab and
          the lane starts on its own.
        </div>
      </div>
    `;
  }
  if (error && !data) return html`<div class="sweep-error">Could not load sweeps: ${error}</div>`;
  if (!data) return html`<div class="muted">Loading sweeps…</div>`;

  const open = editing?.creating ? null : (data.items.find((s) => s.id === editing?.id) ?? null);
  const modalOpen = editing !== null;
  const readOnly = open !== null && !ownsProse(open);

  return html`
    <div class="sweeps-view">
      <p class="sweep-intro">
        Scheduled passes over your corpus. Each one is a rhythm and a paragraph saying what to look
        for — nothing else. Sweeps that ship with Omnesis can be turned off or forked; your own live
        as files in <code>${data.directory}</code>, so they can be edited in a text editor, kept in
        version control, and shared.
      </p>

      ${error && html`<div class="sweep-error">${error}</div>`}

      ${!data.laneEnabled &&
      html`<div class="sweep-warning">
        Sweeps are switched off on this gateway, so nothing below runs. Set
        <code>brain.sweepsEnabled</code> on the Config tab to start the schedule.
      </div>`}

      ${data.issues.length > 0 &&
      html`<div class="sweep-issues">
        <strong
          >${data.issues.length} sweep file${data.issues.length === 1 ? "" : "s"} could not be
          loaded — ${data.issues.length === 1 ? "it is" : "they are"} not running:</strong
        >
        <ul>
          ${data.issues.map((i) => html`<li key=${i.file}><code>${i.file}</code> — ${i.message}</li>`)}
        </ul>
      </div>`}

      ${data.digestWindowConflicts.length > 0 &&
      html`<div class="sweep-warning">
        ${data.digestWindowConflicts.map((c) => c.id).join(", ")} run while your morning brief is
        being written. It waits for the queue to go quiet, so it will arrive later and thinner. Give
        them a different time.
      </div>`}

      <div class="sweep-toolbar">
        <button
          type="button"
          class="btn-primary"
          onClick=${() => setEditing({ creating: true })}
          disabled=${busy}
        >
          + New sweep
        </button>
      </div>

      <div class="portal-table-wrap">
        <table class="portal-table">
          <thead>
            <tr>
              <th>Sweep</th>
              <th class="portal-table-num" title=${SCHEDULE_HELP.every}>Every</th>
              <th class="portal-table-num" title=${SCHEDULE_HELP.at}>At</th>
              ${COUNTERS.map(
                (c) => html`<th class="portal-table-num" key=${c.key} title=${c.help}>${c.label}</th>`,
              )}
              <th class="portal-table-actions-col"></th>
            </tr>
          </thead>
          <tbody>
            ${data.items.map(
              (sweep) => html`
                <${SweepRow}
                  key=${sweep.id}
                  sweep=${sweep}
                  busy=${busy}
                  onOpen=${() => setEditing({ id: sweep.id })}
                  onFork=${async () => {
                    // Forking is only ever a step towards editing, so land in
                    // the editor rather than back at an unchanged-looking row.
                    try {
                      await mutate(() => forkSweep(sweep.id));
                      setEditing({ id: sweep.id });
                    } catch {
                      /* surfaced at the top of the page */
                    }
                  }}
                  onToggle=${() =>
                    mutate(() => setSweepEnabled(sweep.id, !sweep.enabled)).catch(() => {})}
                  onRevert=${() => mutate(() => deleteSweepFile(sweep.id)).catch(() => {})}
                />
              `,
            )}
          </tbody>
        </table>
      </div>


      <${Modal}
        open=${modalOpen}
        onClose=${() => setEditing(null)}
        size="lg"
        title=${editing?.creating ? "New sweep" : (open?.name ?? "Sweep")}
        subtitle=${editing?.creating ? "It starts running as soon as you save." : open?.id}
      >
        ${modalOpen &&
        (editing.creating || open) &&
        html`<${SweepForm}
          sweep=${open}
          readOnly=${readOnly}
          busy=${busy}
          onClose=${() => setEditing(null)}
          onFork=${async () => {
            try {
              await mutate(() => forkSweep(open.id));
            } catch {
              /* surfaced at the top of the page */
            }
          }}
          onSave=${async (id, body) => {
            await mutate(() => saveSweep(id, body));
            setEditing(null);
          }}
        />`}
      <//>
    </div>
  `;
}
