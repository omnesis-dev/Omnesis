// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// An account's filterable fields, as the gateway's filter editor describes
// them: what each field calls its items, how it is picked, and whether a
// filter can use it yet. Every sentence about a field's state is the
// gateway's; this module only lays it out.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getSourceFilterEditor, resyncSource } from "../api.js";
import { scopeLabelGeneration, useScopeLabelGeneration } from "./source-filter-labels.js";
import { readFilterOptions } from "./source-filter-requests.js";
import { isDeviceRef, scopeRefKey } from "./source-filter-state.js";
import { sourceId as accountIdOf, sourceLabel } from "./grant-builder-state.js";

/** How long to wait before asking again about a field that is still changing, when the gateway names no time. */
export const EDITOR_POLL_MS = 5000;

/** The words for a filter error the gateway did not put in a sentence of its own. */
export function filterApiError(error, fallback) {
  return error?.serverMessage || fallback;
}

export const capitalized = (text) =>
  text ? `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}` : text;

/** What a field calls one of its items, or several. */
export function fieldNoun(field, many = false) {
  return (many ? field?.noun?.many : field?.noun?.one) || (many ? "items" : "item");
}

/**
 * What a tree field calls an item `depth` levels down: a word per level,
 * roots first, the last standing for every deeper level. A field without
 * levels, or an item whose depth is not known, gets the field's own noun.
 */
export function fieldLevelNoun(field, depth, many = false) {
  const levels = Array.isArray(field?.levels) && field.levels.length ? field.levels : null;
  const noun =
    levels && Number.isInteger(depth) && depth >= 0
      ? levels[Math.min(depth, levels.length - 1)]
      : null;
  return (many ? noun?.many : noun?.one) || fieldNoun(field, many);
}

/** A tree field whose levels have different names, so a row says which level it is at. */
export function fieldHasNamedLevels(field) {
  return (
    Array.isArray(field?.levels) &&
    new Set(field.levels.map((level) => level?.one)).size > 1
  );
}

/** The typed address a person entry is, when it is one address shown as itself. */
export function exactIdentifier(ref) {
  const identifier =
    ref?.capability === "person" && ref.identifiers?.length === 1 ? ref.identifiers[0] : null;
  return identifier && ref.label === identifier.value ? identifier : null;
}

const IDENTIFIER_NOUNS = { phone: "phone", email: "email", domain: "domain" };

/** A table row's type: "Label", "Person", "Phone", "Device", or the tree level the item sits at. */
export function refTypeLabel(field, ref, depth) {
  const exact = exactIdentifier(ref);
  return capitalized(
    exact
      ? (IDENTIFIER_NOUNS[exact.type] ?? exact.type)
      : isDeviceRef(ref)
        ? "device"
        : !field && ref?.capability === "person"
          ? "person"
          : fieldLevelNoun(field, depth),
  );
}

/** Whether a field can take new entries. */
export const fieldReady = (field) => field?.state?.status === "ready";

/** States the gateway moves out of by itself, so the editor asks again until they change. */
const CHANGING = new Set(["resyncing", "list-pending"]);

/** How long until the editor should be read again, or null when nothing in it is still changing. */
export function editorPollDelay(editor, forced = false) {
  if (!editor) return null;
  if (Number.isFinite(editor.retryAfterMs) && editor.retryAfterMs > 0) return editor.retryAfterMs;
  const changing = (editor.fields ?? []).some(
    (field) => CHANGING.has(field.state?.status) || field.counts?.status === "pending",
  );
  return changing || forced ? EDITOR_POLL_MS : null;
}

// One editor read per account is shared by every view that names its
// fields; a view that watches the account's states reads it again on its
// own schedule.
const editors = new Map();
const listeners = new Set();
const announce = () => {
  for (const listener of listeners) listener();
};

function editorEntry(sourceId) {
  const key = JSON.stringify([scopeLabelGeneration(), sourceId]);
  for (const stale of editors.keys())
    if (JSON.parse(stale)[0] !== scopeLabelGeneration()) editors.delete(stale);
  let entry = editors.get(key);
  if (!entry) {
    entry = { sourceId, data: null, error: "", loading: false, generation: scopeLabelGeneration() };
    editors.set(key, entry);
  }
  return entry;
}

function readEditor(entry) {
  if (entry.loading) return;
  entry.loading = true;
  getSourceFilterEditor(entry.sourceId)
    .then(
      (data) => {
        if (data?.sourceId !== entry.sourceId) throw new Error("mismatched editor");
        entry.data = data;
        entry.error = "";
      },
      (error) => {
        entry.error = filterApiError(error, "This account’s filters could not be loaded.");
      },
    )
    .catch(() => {
      entry.error = "This account’s filters could not be loaded.";
    })
    .finally(() => {
      entry.loading = false;
      if (entry.generation === scopeLabelGeneration()) announce();
    });
}

/**
 * The filter editor of one account. `watch` reads it fresh when the view
 * opens and again while any field is still changing, or while `expectChange`
 * says the owner just asked for a change the gateway has not reported yet.
 */
export function useSourceFilterEditor(sourceId, { watch = false, expectChange = false } = {}) {
  const generation = useScopeLabelGeneration();
  const [, setVersion] = useState(0);
  const entry = sourceId ? editorEntry(sourceId) : null;
  useEffect(() => {
    const update = () => setVersion((value) => value + 1);
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);
  useEffect(() => {
    if (entry && (watch || (!entry.data && !entry.error))) readEditor(entry);
  }, [sourceId, generation, watch]);
  const delay = watch && entry && !entry.loading ? editorPollDelay(entry.data, expectChange) : null;
  useEffect(() => {
    if (delay == null || !entry) return;
    const timer = setTimeout(() => readEditor(entry), delay);
    return () => clearTimeout(timer);
  }, [entry, entry?.data, delay]);
  return {
    data: entry?.data ?? null,
    error: entry?.data ? "" : (entry?.error ?? ""),
    pending: Boolean(entry && !entry.data && !entry.error),
    reload: () => entry && readEditor(entry),
  };
}

// The first level of each tree whose levels have different names, read once
// per account and field: a saved entry the gateway names without its depth
// is a root when it is listed there, and lies deeper when the whole first
// level is listed without it.
const roots = new Map();

/**
 * The depth to name an entry by when nothing gave its own: 0 for a root of
 * a field whose levels have different names, the second level for an entry
 * that is not a root of a two-level tree, and undefined when it cannot be
 * told.
 */
export function useTreeRootDepth(sourceId, editor, refs, knownDepth) {
  const generation = useScopeLabelGeneration();
  const [, setVersion] = useState(0);
  const fields = (editor?.fields ?? []).filter(
    (field) =>
      field.capability !== "person" &&
      fieldHasNamedLevels(field) &&
      refs.some((ref) => ref.field === field.field && !Number.isInteger(knownDepth(ref))),
  );
  const keyOf = (field) => JSON.stringify([generation, sourceId, field]);
  useEffect(() => {
    for (const field of fields) {
      const key = keyOf(field.field);
      if (roots.has(key)) continue;
      roots.set(key, null);
      readFilterOptions(sourceId, { field: field.field })
        .then((page) => {
          roots.set(key, page.nextCursor ? null : new Set(page.items.map((item) => scopeRefKey(item.ref))));
        })
        .catch(() => roots.delete(key))
        .finally(() => setVersion((value) => value + 1));
    }
  }, [sourceId, generation, fields.map((field) => field.field).join("\n")]);
  return (ref) => {
    const field = fields.find((item) => item.field === ref.field);
    const listed = field ? roots.get(keyOf(field.field)) : null;
    if (!listed) return undefined;
    if (listed.has(scopeRefKey(ref))) return 0;
    return field.levels.length === 2 ? 1 : undefined;
  };
}

/** A determinate bar for how far a resync has read. */
function ResyncProgress({ processed, total, label }) {
  const max = Math.max(1, Number(total) || 0);
  const value = Math.min(max, Math.max(0, Number(processed) || 0));
  return html`<progress class="source-filter-progress" max=${max} value=${value} aria-label=${label}></progress>`;
}

/** States that belong to the whole account, so the fields in them share one block. */
const ACCOUNT_STATES = new Set(["needs-resync", "resyncing"]);

/** "Labels", "Labels and people", "Labels, folders and people". */
function joinedNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

/**
 * The fields that cannot take new entries yet, as the blocks that explain
 * why, in field order. Fields waiting for the same resync of the account —
 * or the same resync in progress — share one block; each other field has
 * its own.
 */
export function waitingFieldGroups(fields = []) {
  const groups = [];
  for (const field of fields) {
    if (fieldReady(field)) continue;
    const status = field.state?.status;
    const shared = ACCOUNT_STATES.has(status)
      ? groups.find((group) => group.status === status && ACCOUNT_STATES.has(group.status))
      : null;
    if (shared) shared.fields.push(field);
    else groups.push({ status, fields: [field] });
  }
  return groups.map((group) => ({
    ...group,
    key: group.fields.map((field) => field.field).join("\n"),
    name: capitalized(joinedNames(group.fields.map((field) => fieldNoun(field, true)))),
  }));
}

/**
 * The gateway's sentence for fields that share a resync. Each field's
 * sentence starts "<Noun> filters need …"; the shared one names every
 * field in that opening and keeps the rest of the first field's sentence.
 * Sentences that do not open that way are shown one after another.
 */
export function sharedResyncText(fields) {
  if (fields.length === 1) return fields[0].state.text;
  const opening = /^(.+?) filters (need .*)$/su;
  const parts = fields.map((field) => opening.exec(field.state.text ?? ""));
  if (parts.some((part) => !part)) return fields.map((field) => field.state.text).join(" ");
  const names = parts.map(([, noun], index) =>
    index === 0 ? noun : noun.charAt(0).toLocaleLowerCase() + noun.slice(1),
  );
  return `${joinedNames(names)} filters ${parts[0][2]}`;
}

/**
 * Why fields cannot take new entries yet, in the gateway's words, with the
 * one action the owner can take: resync the account when its records are
 * too old for them. `starting` is set once the owner has asked for that
 * resync and the gateway has not reported it running yet.
 */
export function FilterFieldState({ source, fields, starting = false, error = "", onResync }) {
  const state = fields[0].state ?? {};
  const name = sourceLabel(source);
  if (state.status === "needs-resync" && !starting)
    return html`<div class="source-filter-state" role="status">
      <p>${sharedResyncText(fields)}</p>
      ${error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
      <button type="button" class="btn-secondary" onClick=${onResync}>Resync ${name}</button>
    </div>`;
  if (state.status === "resyncing")
    return html`<div class="source-filter-state" role="status">
      <p>${state.text}</p>
      <${ResyncProgress} processed=${state.processed} total=${state.total} label=${`Resyncing ${name}`} />
    </div>`;
  if (state.status === "needs-resync")
    return html`<div class="source-filter-state" role="status">
      <p><span class="source-filter-spinner" aria-hidden="true"></span>Resyncing ${name}…</p>
    </div>`;
  if (state.status === "list-pending")
    return html`<div class="source-filter-state" role="status">
      <p><span class="source-filter-spinner" aria-hidden="true"></span>${state.text}</p>
    </div>`;
  return html`<div class="source-filter-state" role="status"><p>${state.text}</p></div>`;
}

/** Start the in-place resync a field asked for. */
export function resyncForFilters(source) {
  return resyncSource(accountIdOf(source), { mode: "in-place" });
}
