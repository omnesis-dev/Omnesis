// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Leaf controls and config-path helpers for the structured config editor.
 *
 * Owns scalar/list/boolean widgets, default and override state, inline field
 * validation, accessible control naming, merge-patch construction, and
 * push-source field gating. Recursive schema layout and filtering remain in
 * config-structured-form.js.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { isDirtyPath } from "./config-draft.js";

// Capitalised forms for tokens that shouldn't be title-cased generically.
const ACRONYMS = {
  url: "URL", bm25: "BM25", rrf: "RRF", api: "API", ttl: "TTL", id: "ID",
  ms: "ms", db: "DB", apns: "APNs", io: "IO", cpu: "CPU", hnsw: "HNSW",
  idf: "IDF", df: "DF", cdn: "CDN", ws: "WS", fts5: "FTS5", p99: "p99",
};

// Turn a schema key ("dbWriteBatchSize", "maxConcurrency") into a label.
export function humanize(key) {
  if (!key || key === "*") return "";
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/).filter(Boolean);
  return words
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (ACRONYMS[lw]) return ACRONYMS[lw];
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : lw;
    })
    .join(" ");
}

// Extract a value at a path from a parsed config object.
export function readPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

// Build an RFC 7396 merge patch that sets `keys` to `value` (or deletes when null).
export function buildPatch(keys, value) {
  const out = Object.create(null);
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = Object.create(null);
    cur[keys[i]] = next;
    cur = next;
  }
  cur[keys[keys.length - 1]] = value === undefined ? null : value;
  return out;
}

function pointerFor(keys) {
  return "/" + keys.map((key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

export function fieldDomId(keys) {
  return `config-field-${keys.map((key) => encodeURIComponent(String(key))).join("--")}`;
}

export function errorsForPath(errors, keys) {
  const pointer = pointerFor(keys);
  return (errors ?? []).filter((error) => error.path === pointer || error.path?.startsWith(`${pointer}/`));
}

function constraintText(node) {
  if (node.kind !== "number" || !node.constraints) return null;
  const parts = [];
  if (node.constraints.int) parts.push("whole number");
  if (node.constraints.min !== undefined) parts.push(`minimum ${node.constraints.min}`);
  if (node.constraints.exclusiveMin !== undefined) {
    parts.push(`greater than ${node.constraints.exclusiveMin}`);
  }
  if (node.constraints.max !== undefined) parts.push(`maximum ${node.constraints.max}`);
  return parts.length > 0 ? `Allowed: ${parts.join(", ")}.` : null;
}

// ---------------------------------------------------------------------------
// Structured form pieces
// ---------------------------------------------------------------------------

export function Field({ label, hint, ids, state, error, constraints, children, dirty = false }) {
  if (!ids) {
    return html`
      <div class=${`config-field${dirty ? " config-field-dirty" : ""}`}>
        <div class="config-label">${label}${hint ? html`<span class="config-hint">${hint}</span>` : null}</div>
        <div class="config-control-stack">${children}</div>
      </div>
    `;
  }
  const describedBy = [hint ? ids.hint : null, ids.state, error ? ids.error : null, constraints ? ids.constraints : null]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${`config-field${dirty ? " config-field-dirty" : ""}`}>
      <label class="config-label" id=${ids.label} for=${ids.control}>
        ${label}${hint ? html`<span class="config-hint" id=${ids.hint}>${hint}</span>` : null}
      </label>
      <div class="config-control-stack">
        ${typeof children === "function" ? children(describedBy, ids.label, !!error) : children}
        ${state}
        ${constraints ? html`<p class="config-constraints" id=${ids.constraints}>${constraints}</p>` : null}
        ${error ? html`<p class="config-field-error" id=${ids.error} role="alert">${error}</p>` : null}
      </div>
    </div>
  `;
}

// Commit value for a free-value input's text, shared by the keystroke and
// blur paths. Empty clears the key; finite numbers commit as numbers;
// anything else (including malformed numbers) commits as text so the server
// rejects it with the same path-specific inline error as a range violation.
export function commitTextValue(node, text) {
  const t = (text ?? "").trim();
  if (t === "") return undefined;
  if (node.kind === "number") {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return t;
}

// Free-value input for number / duration / string knobs.
//
// The field shows only an explicit config value. When the setting is absent,
// the input stays empty and its placeholder names the fixed default, when one
// exists. Clearing the input deletes the key; entering a value equal to the
// current code default still persists an explicit override so it remains
// pinned if that default changes later. This is a plain text input (no
// number spinner) so large values like 600000 can just be typed. It commits
// per keystroke, so Save, Discard, and highlighting react while typing —
// no blur click needed.
function DefaultableInput({ node, value, onChange, disabled, id, describedBy, labelledBy, invalid, reconcileToken }) {
  const isNum = node.kind === "number";
  const def = node.default;
  const defStr = def === undefined ? "" : String(def);
  const valStr = value === undefined ? "" : String(value);
  const [text, setText] = useState(valStr);
  // Commits fire per keystroke, so the resync below must ignore value
  // changes our own commits caused — otherwise partially typed text
  // (trailing spaces, intermediate numbers like "007") would be overwritten
  // by the committed value mid-edit. The comparison is by value, not a
  // one-shot flag, so a later external change can never be skipped:
  // anything we didn't send resyncs. Blur also normalizes the display to
  // the committed value.
  //
  // A render that a commit has overtaken is stale by the time its effect
  // runs: the value it saw predates the commit, so the comparison would
  // mistake the user's own keystroke for an external change and overwrite
  // it. That happens when a keystroke lands between a render — a mount (a
  // field reappearing under a filter change) or a resync to an external
  // value — and that render's effect flush. The commit sequence detects it;
  // the render that follows the commit judges.
  const lastSentRef = useRef(value);
  const commitSeqRef = useRef(0);
  const renderSeq = commitSeqRef.current;
  useEffect(() => {
    if (commitSeqRef.current !== renderSeq) return;
    if (value === lastSentRef.current) return;
    setText(valStr);
  }, [valStr, reconcileToken]);

  const commit = (next, normalize) => {
    const committed = commitTextValue(node, next);
    lastSentRef.current = committed;
    commitSeqRef.current += 1;
    if (normalize) setText(committed === undefined ? "" : String(committed));
    onChange(committed);
  };

  return html`
    <input
      id=${id}
      type="text"
      inputmode=${isNum ? "decimal" : undefined}
      class="config-input"
      value=${text}
      placeholder=${def !== undefined ? `Default: ${defStr}` : node.kind === "duration" ? "Unset (e.g. 5m)" : "Unset"}
      aria-labelledby=${labelledBy || undefined}
      aria-describedby=${describedBy || undefined}
      aria-invalid=${invalid ? "true" : undefined}
      onInput=${(e) => {
        const next = e.target.value;
        setText(next);
        commit(next, false);
      }}
      onBlur=${() => commit(text, true)}
      disabled=${disabled}
    />
  `;
}

// Render a default value for display ("on"/"off" for booleans, else as text).
function formatDefault(kind, def) {
  if (def === undefined) return null;
  if (kind === "boolean") return def ? "on" : "off";
  if (Array.isArray(def)) return def.length === 0 ? "empty list" : `${def.length} values`;
  return String(def);
}

export function ValueState({ node, value, onReset, disabled, id }) {
  const explicit = value !== undefined;
  const defLabel = formatDefault(node.kind, node.default);
  const hasDefault = node.default !== undefined;
  const resetLabel = hasDefault ? `Reset to default${defLabel ? ` (${defLabel})` : ""}` : "Clear setting";

  return html`
    <div class="config-value-state" id=${id}>
      <span class=${`config-state-badge ${explicit ? "explicit" : "inherited"}`}>
        ${explicit ? "Set in config" : hasDefault ? "Using default" : "Unset"}
      </span>
      ${!explicit && hasDefault ? html`<span class="config-state-detail">${defLabel}</span>` : null}
      ${!explicit && !hasDefault && node.unsetDescription
        ? html`<span class="config-state-detail">${node.unsetDescription}</span>`
        : null}
      ${explicit && Array.isArray(value)
        ? html`<span class="config-state-detail">${value.length === 0 ? "empty list" : `${value.length} values`}</span>`
        : null}
      ${explicit
        ? html`<button type="button" class="config-reset-btn" onClick=${onReset} disabled=${disabled}>${resetLabel}</button>`
        : null}
      ${!explicit && Array.isArray(node.default) && node.default.length > 0
        ? html`<details class="config-default-details">
            <summary>View default values</summary>
            <code>${node.default.join(", ")}</code>
          </details>`
        : null}
    </div>
  `;
}

// Tri-state boolean control: Enabled (true) / Disabled (false) / Unset (key
// absent → inherit the runtime default). The three states are distinct on
// purpose — "explicitly disable a default-on feature" (writes false) is not the
// same as "unset" (deletes the key). The Unset segment surfaces the effective
// default so an absent value isn't ambiguous.
function TriToggle({ value, default: def, onChange, disabled, id, describedBy, labelledBy, invalid }) {
  const state = value === true ? "on" : value === false ? "off" : "unset";
  const defLabel = formatDefault("boolean", def);
  const seg = (key, label, next) => html`
    <button
      type="button"
      class=${`config-tristate-seg ${state === key ? "active" : ""}`}
      aria-pressed=${state === key}
      onClick=${() => onChange(next)}
      disabled=${disabled}
    >${label}</button>
  `;
  return html`
    <div
      class="config-tristate"
      role="group"
      id=${id}
      aria-labelledby=${labelledBy || undefined}
      aria-describedby=${describedBy || undefined}
      aria-invalid=${invalid ? "true" : undefined}
    >
      ${seg("on", "On", true)}
      ${seg("off", "Off", false)}
      ${seg("unset", defLabel ? html`Unset<span class="config-tristate-def"> · default ${defLabel}</span>` : "Unset", undefined)}
    </div>
  `;
}

// Commit derivation for the one-entry-per-line list editor, shared by the
// keystroke and blur paths. Non-empty text commits the entry list; emptied
// text clears a previously-set list, but reports no commit when there was
// nothing to clear so typing-then-deleting stages no phantom draft.
export function commitListValue(text, previous) {
  const list = (text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (list.length > 0) return { commit: true, value: list };
  if (Array.isArray(previous) && previous.length > 0) return { commit: true, value: undefined };
  return { commit: false, value: undefined };
}

function StringListInput({ value, onChange, placeholder, disabled, id, describedBy, labelledBy, invalid, reconcileToken }) {
  // Edits as one-entry-per-line text; committed per keystroke so Save,
  // Discard, and highlighting react while typing — no blur click needed.
  const [text, setText] = useState(() => (value ?? []).join("\n"));
  // Same value-compared self-commit guard as DefaultableInput, with the
  // same commit-sequence check against a render a commit has overtaken:
  // keeps a trailing newline being typed from collapsing back to the joined
  // list mid-edit, while external changes still resync.
  const lastSentJsonRef = useRef(JSON.stringify(value ?? []));
  const commitSeqRef = useRef(0);
  const renderSeq = commitSeqRef.current;
  useEffect(() => {
    if (commitSeqRef.current !== renderSeq) return;
    if (lastSentJsonRef.current === JSON.stringify(value ?? [])) return;
    setText((value ?? []).join("\n"));
  }, [JSON.stringify(value ?? []), reconcileToken]);
  const commit = (next, prev, normalize) => {
    const result = commitListValue(next, prev);
    if (!result.commit) return;
    lastSentJsonRef.current = JSON.stringify(result.value ?? []);
    commitSeqRef.current += 1;
    if (normalize) setText((result.value ?? []).join("\n"));
    onChange(result.value);
  };
  return html`
    <div class="config-list-editor">
      <textarea
        id=${id}
        class="config-textarea config-textarea-short"
        value=${text}
        placeholder=${placeholder ?? "one per line"}
        aria-labelledby=${labelledBy || undefined}
        aria-describedby=${describedBy || undefined}
        aria-invalid=${invalid ? "true" : undefined}
        onInput=${(e) => {
          const next = e.target.value;
          setText(next);
          commit(next, value, false);
        }}
        onBlur=${() => commit(text, value, true)}
        disabled=${disabled}
      ></textarea>
      ${value === undefined
        ? html`<button
            type="button"
            class="config-reset-btn"
            onClick=${() => onChange([])}
            disabled=${disabled}
          >Set an explicit empty list</button>`
        : null}
    </div>
  `;
}

export function SectionCard({ title, subtitle, children }) {
  return html`
    <section class="config-card">
      <header class="config-card-head">
        <h3>${title}</h3>
        ${subtitle ? html`<p class="config-card-sub">${subtitle}</p>` : null}
      </header>
      <div class="config-card-body">${children}</div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Schema-driven leaf widgets
// ---------------------------------------------------------------------------

export function coerceLeaf(node, raw) {
  const s = (raw ?? "").trim();
  if (s === "") return undefined;
  if (node.kind === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return s;
}

// Build the bare input control for a leaf node (no label wrapper).
export function leafControl(node, resolved, value, patch, busy, id, describedBy, labelledBy, invalid, reconcileToken) {
  const onChange = (v) => patch(resolved, v);
  switch (node.kind) {
    case "boolean":
      // Tri-state: writes true / false / undefined (delete). Unset shows the
      // default so an absent value reads as e.g. "inherits default on".
      return html`<${TriToggle} value=${value} default=${node.default} onChange=${onChange} disabled=${busy} id=${id} describedBy=${describedBy} labelledBy=${labelledBy} invalid=${invalid} />`;
    case "enum": {
      const d = formatDefault("enum", node.default);
      return html`
        <select id=${id} class="config-input" value=${value ?? ""} aria-labelledby=${labelledBy || undefined} aria-describedby=${describedBy || undefined} aria-invalid=${invalid ? "true" : undefined} onChange=${(e) => onChange(e.target.value || undefined)} disabled=${busy}>
          <option value="">${d !== null ? `(unset — default: ${d})` : "(unset)"}</option>
          ${(node.options ?? []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
      `;
    }
    case "stringArray":
      return html`<${StringListInput} value=${value} onChange=${onChange} disabled=${busy} id=${id} describedBy=${describedBy} labelledBy=${labelledBy} invalid=${invalid} reconcileToken=${reconcileToken} />`;
    case "number":
    case "duration":
    default:
      // number / duration / string: free-value input that stays empty while
      // unset and commits explicit values per keystroke.
      return html`<${DefaultableInput} node=${node} value=${value} onChange=${onChange} disabled=${busy} id=${id} describedBy=${describedBy} labelledBy=${labelledBy} invalid=${invalid} reconcileToken=${reconcileToken} />`;
  }
}

// Per-source knobs that only mean something for a source a collector pulls
// on a sync loop. A push-based source (hosted on a phone app — its data is
// uploaded, not pulled) has no sync timer and no document/attachment
// pipeline, so these are inert and we disable them with a note. `params`
// is deliberately excluded — it carries source-specific config that can
// still apply. Mirrors the add-flow gate and the gateway's `pushBased`
// derivation; kept in sync with SOURCE_SETTINGS_KEYS in @omnesis/config.
const INERT_PUSH_SOURCE_KNOBS = new Set([
  "syncInterval",
  "extractAttachments",
  "attachmentMaxSizeBytes",
  "attachmentTypes",
  "attachmentMaxTextLength",
  "maxAge",
]);

const PUSH_SOURCE_KNOB_NOTE =
  "Not applicable — this source is push-based (its device uploads the data), so it has no collector sync loop or document/attachment pipeline.";

// A config leaf at `sources/<sourceId>/<knob>` is inert when the source is
// push-based and the knob is one of the collector-ingestion settings. The
// gating is keyed off the config path + the descriptor-derived pushBased set,
// never a hardcoded source name.
function isInertForPushSource(resolved, pushBasedSources) {
  return (
    Array.isArray(resolved) &&
    resolved.length === 3 &&
    resolved[0] === "sources" &&
    INERT_PUSH_SOURCE_KNOBS.has(resolved[2]) &&
    !!pushBasedSources &&
    pushBasedSources.has(resolved[1])
  );
}

export function LeafField({ node, resolved, config, patch, busy, pushBasedSources, serverErrors, reconcileToken, dirtyPaths = null }) {
  const gated = isInertForPushSource(resolved, pushBasedSources);
  const value = readPath(config, resolved);
  const baseId = fieldDomId(resolved);
  const ids = {
    control: `${baseId}-control`,
    label: `${baseId}-label`,
    hint: `${baseId}-hint`,
    state: `${baseId}-state`,
    error: `${baseId}-error`,
    constraints: `${baseId}-constraints`,
  };
  const fieldErrors = errorsForPath(serverErrors, resolved);
  const error = fieldErrors.map((entry) => entry.message).join(" ") || null;
  const onReset = () => patch(resolved, undefined);
  const dirty = dirtyPaths ? isDirtyPath(dirtyPaths, resolved) : false;
  return html`
    <${Field}
      label=${humanize(node.key)}
      hint=${gated ? PUSH_SOURCE_KNOB_NOTE : node.description}
      ids=${ids}
      constraints=${constraintText(node)}
      error=${error}
      dirty=${dirty}
      state=${html`<${ValueState} node=${node} value=${value} onReset=${onReset} disabled=${busy || gated} id=${ids.state} />`}
    >
      ${(describedBy, labelledBy, invalid) => leafControl(node, resolved, value, patch, busy || gated, ids.control, describedBy, labelledBy, invalid, reconcileToken)}
    </${Field}>
  `;
}
