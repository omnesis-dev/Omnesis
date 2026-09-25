// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recursive schema layout for the structured config editor.
 *
 * Owns object/record rendering, search and override filtering, record
 * editing, and section layout. Removals stage into the parent draft like
 * any other edit; confirmation happens in ConfigView's shared save-review
 * step. Leaf controls, path helpers, default state, and field-level
 * accessibility live in config-field-controls.js. ConfigView remains the
 * loading and persistence facade.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { isDirtyPath } from "./config-draft.js";
import { Segmented } from "../components/segmented.js";
import {
  Field,
  LeafField,
  SectionCard,
  ValueState,
  buildPatch,
  coerceLeaf,
  errorsForPath,
  fieldDomId,
  humanize,
  leafControl,
  readPath,
} from "./config-field-controls.js";

function fmtPath(path) {
  return path || "/";
}

function renderErrors(errors) {
  if (!errors?.length) return null;
  return html`
    <ul class="config-errors">
      ${errors.map((error, index) => html`
        <li key=${index}><code>${fmtPath(error.path)}</code> ${error.message}</li>
      `)}
    </ul>
  `;
}

function OwnedNote({ node }) {
  const where = node.ownedBy?.page ?? "another screen";
  return html`<p class="config-owned-note">Configured under ${where} — ${node.ownedBy?.reason ?? ""}</p>`;
}

// ---------------------------------------------------------------------------
// Recursive node renderer
// ---------------------------------------------------------------------------

function isLeaf(node) {
  return node.kind !== "object" && node.kind !== "record";
}

function nodeOwnSearchText(node, resolved) {
  return [humanize(node.key), node.description, node.unsetDescription, resolved.join(".")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function nodeHasVisibleContent(node, resolved, config, query, overridesOnly) {
  if (node.ownedBy) return !overridesOnly && nodeOwnSearchText(node, resolved).includes(query);
  if (isLeaf(node)) {
    if (overridesOnly && readPath(config, resolved) === undefined) return false;
    return nodeOwnSearchText(node, resolved).includes(query);
  }
  if (node.kind === "object") {
    return node.children.some((child) =>
      nodeHasVisibleContent(child, [...resolved, child.key], config, query, overridesOnly),
    );
  }

  const existing = readPath(config, resolved);
  const keys = existing && typeof existing === "object" ? Object.keys(existing) : [];
  if (overridesOnly && keys.length === 0) return false;
  if (nodeOwnSearchText(node, resolved).includes(query)) return true;
  return keys.some(
    (key) =>
      key.toLowerCase().includes(query) ||
      nodeHasVisibleContent(node.value, [...resolved, key], config, query, overridesOnly),
  );
}

function countExplicitLeaves(node, resolved, config) {
  if (node.ownedBy) return 0;
  if (isLeaf(node)) return readPath(config, resolved) === undefined ? 0 : 1;
  if (node.kind === "object") {
    return node.children.reduce(
      (count, child) => count + countExplicitLeaves(child, [...resolved, child.key], config),
      0,
    );
  }
  const existing = readPath(config, resolved);
  if (!existing || typeof existing !== "object") return 0;
  return Object.keys(existing).reduce(
    (count, key) => count + countExplicitLeaves(node.value, [...resolved, key], config),
    0,
  );
}

// Renders the *body* of a node (its children / record entries / leaf control).
function NodeView({ node, resolved, config, patch, busy, pushBasedSources, serverErrors, query, overridesOnly, reconcileToken, dirtyPaths }) {
  if (node.ownedBy) return html`<${OwnedNote} node=${node} />`;
  if (node.kind === "object") {
    return node.children.map((child) => {
      const childResolved = [...resolved, child.key];
      if (!nodeHasVisibleContent(child, childResolved, config, query, overridesOnly)) return null;
      if (child.ownedBy) {
        return html`<${Field} key=${child.key} label=${humanize(child.key)}>
          <${OwnedNote} node=${child} />
        </${Field}>`;
      }
      if (!isLeaf(child)) {
        return html`<${SubGroup} key=${child.key} node=${child} resolved=${childResolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} query=${query} overridesOnly=${overridesOnly} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />`;
      }
      return html`<${LeafField} key=${child.key} node=${child} resolved=${childResolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />`;
    });
  }
  if (node.kind === "record") {
    return html`<${RecordEditor} node=${node} resolved=${resolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} query=${query} overridesOnly=${overridesOnly} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />`;
  }
  return html`<${LeafField} node=${node} resolved=${resolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />`;
}

function SubGroup({ node, resolved, config, patch, busy, pushBasedSources, serverErrors, query, overridesOnly, reconcileToken, dirtyPaths }) {
  return html`
    <div class="config-subgroup">
      <div class="config-subgroup-head">
        <h4>${humanize(node.key)}</h4>
        ${node.description ? html`<span class="config-subgroup-sub">${node.description}</span>` : null}
      </div>
      <div class="config-subgroup-body">
        <${NodeView} node=${node} resolved=${resolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} query=${query} overridesOnly=${overridesOnly} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />
      </div>
    </div>
  `;
}

function RecordEditor({ node, resolved, config, patch, busy, pushBasedSources, serverErrors, query, overridesOnly, reconcileToken, dirtyPaths }) {
  const existing = readPath(config, resolved);
  const serverKeys = existing && typeof existing === "object" ? Object.keys(existing) : [];
  // Object-valued entries the user added but hasn't persisted yet (an empty
  // merge-patch object wouldn't persist server-side). Once any field inside is
  // set, the key arrives via serverKeys on the next refresh.
  const [draftKeys, setDraftKeys] = useState([]);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [newValueError, setNewValueError] = useState(null);
  const newValueErrorId = `${fieldDomId(resolved)}-new-value-error`;
  const valueIsLeaf = isLeaf(node.value);
  const parentMatches = nodeOwnSearchText(node, resolved).includes(query);
  const keys = Array.from(new Set([...serverKeys, ...draftKeys])).filter((key) => {
    const keyResolved = [...resolved, key];
    if (overridesOnly && !nodeHasVisibleContent(node.value, keyResolved, config, "", true)) {
      return false;
    }
    if (!query || parentMatches || key.toLowerCase().includes(query)) return true;
    return (
      nodeOwnSearchText(node.value, keyResolved).includes(query) ||
      nodeHasVisibleContent(node.value, keyResolved, config, query, overridesOnly)
    );
  });

  // Once a draft key materialises in the rendered config (the user set a
  // field under it), drop it from local draft state. Otherwise an entry the
  // user later empties out would resurrect as a phantom draft row. The
  // reconcile token also covers Discard/save, which clear the draft without
  // the key ever materialising.
  useEffect(() => {
    setDraftKeys((d) => d.filter((k) => !serverKeys.includes(k)));
  }, [JSON.stringify(serverKeys), reconcileToken]);

  const addKey = () => {
    const k = newKey.trim();
    if (!k) return;
    if (valueIsLeaf) {
      const v = coerceLeaf(node.value, newVal);
      if (v === undefined) {
        setNewValueError(
          node.value.kind === "number" ? "Enter a valid number." : "Enter a value.",
        );
        return;
      }
      setNewValueError(null);
      patch([...resolved, k], v);
    } else if (!keys.includes(k)) {
      setDraftKeys((d) => [...d, k]);
    }
    setNewKey("");
    setNewVal("");
  };

  // Removals stage into the draft like any other edit — the Save review
  // diff shows them, and Discard recovers them. No per-removal confirm.
  const removeKey = (k) => {
    patch([...resolved, k], undefined);
    setDraftKeys((d) => d.filter((x) => x !== k));
  };

  return html`
    <div class="config-record">
      ${keys.length === 0
        ? html`<p class="config-empty">No entries.</p>`
        : keys.map((k) => html`
            <${RecordEntry}
              key=${k}
              k=${k}
              node=${node}
              resolved=${[...resolved, k]}
              config=${config}
              patch=${patch}
              busy=${busy}
              pushBasedSources=${pushBasedSources}
              serverErrors=${serverErrors}
              query=${parentMatches || k.toLowerCase().includes(query) ? "" : query}
              overridesOnly=${overridesOnly}
              reconcileToken=${reconcileToken}
              dirtyPaths=${dirtyPaths}
              onRemove=${() => removeKey(k)}
            />
          `)}
      ${!overridesOnly ? html`<div class="config-record-add">
        <input
          class="config-input"
          placeholder="new key"
          aria-label="New record key"
          value=${newKey}
          onInput=${(e) => setNewKey(e.target.value)}
          disabled=${busy}
        />
        ${valueIsLeaf
          ? html`<input
              class="config-input"
              placeholder="value"
              aria-label="New record value"
              aria-invalid=${newValueError ? "true" : undefined}
              aria-describedby=${newValueError ? newValueErrorId : undefined}
              value=${newVal}
              onInput=${(e) => { setNewVal(e.target.value); setNewValueError(null); }}
              disabled=${busy}
            />`
          : null}
        <button type="button" class="btn-tiny" onClick=${addKey} disabled=${busy || !newKey.trim()}>Add</button>
      </div>
      ${newValueError
        ? html`<p class="config-field-error" id=${newValueErrorId} role="alert">${newValueError}</p>`
        : null}` : null}
    </div>
  `;
}

function RecordEntry({ k, node, resolved, config, patch, busy, pushBasedSources, serverErrors, query, overridesOnly, reconcileToken, dirtyPaths, onRemove }) {
  const [open, setOpen] = useState(false);
  if (isLeaf(node.value)) {
    const value = readPath(config, resolved);
    const baseId = fieldDomId(resolved);
    const labelId = `${baseId}-label`;
    const stateId = `${baseId}-state`;
    const error = errorsForPath(serverErrors, resolved).map((entry) => entry.message).join(" ") || null;
    const describedBy = [stateId, error ? `${baseId}-error` : null].filter(Boolean).join(" ");
    const dirty = dirtyPaths ? isDirtyPath(dirtyPaths, resolved) : false;
    return html`
      <div class=${`config-record-row${dirty ? " config-field-dirty" : ""}`}>
        <code class="config-record-key" id=${labelId}>${k}</code>
        <div class="config-record-row-control config-control-stack">
          ${leafControl(node.value, resolved, value, patch, busy, `${baseId}-control`, describedBy, labelId, !!error, reconcileToken)}
          <${ValueState} node=${node.value} value=${value} onReset=${() => patch(resolved, undefined)} disabled=${busy} id=${stateId} />
          ${error ? html`<p class="config-field-error" id=${`${baseId}-error`} role="alert">${error}</p>` : null}
        </div>
        <button type="button" class="btn-tiny danger" onClick=${onRemove} disabled=${busy} aria-label=${`Remove ${k}`}>×</button>
      </div>
    `;
  }
  const forcedOpen = query.length > 0;
  const expanded = open || forcedOpen;
  return html`
    <div class=${`config-record-entry ${expanded ? "open" : ""}`}>
      <button
        type="button"
        class="config-record-head"
        aria-expanded=${expanded}
        aria-disabled=${forcedOpen ? "true" : undefined}
        disabled=${forcedOpen}
        onClick=${() => setOpen((v) => !v)}
      >
        <code>${k}</code>
        <span class="config-record-chevron">${expanded ? "▾" : "▸"}</span>
      </button>
      ${expanded
        ? html`
            <div class="config-record-entry-body">
              <${NodeView} node=${node.value} resolved=${resolved} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} query=${query} overridesOnly=${overridesOnly} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />
              <div class="config-record-actions">
                <button type="button" class="btn-tiny danger" onClick=${onRemove} disabled=${busy} aria-label=${`Remove ${k}`}>Remove entry</button>
              </div>
            </div>
          `
        : null}
    </div>
  `;
}

function TopSection({ node, config, patch, busy, pushBasedSources, serverErrors, query, overridesOnly, reconcileToken, dirtyPaths }) {
  const title = humanize(node.key);
  if (node.ownedBy) {
    return html`
      <${SectionCard} title=${title} subtitle=${node.description}>
        <${OwnedNote} node=${node} />
      </${SectionCard}>
    `;
  }
  return html`
    <${SectionCard} title=${title} subtitle=${node.description}>
      <${NodeView} node=${node} resolved=${[node.key]} config=${config} patch=${patch} busy=${busy} pushBasedSources=${pushBasedSources} serverErrors=${serverErrors} query=${query} overridesOnly=${overridesOnly} reconcileToken=${reconcileToken} dirtyPaths=${dirtyPaths} />
    </${SectionCard}>
  `;
}

// ---------------------------------------------------------------------------
// Structured form
// ---------------------------------------------------------------------------

export function StructuredForm({ schema, config, onPatch, busy, lastError, pushBasedSources, serverErrors, reconcileToken, dirtyPaths }) {
  // Each field stages into the parent's draft (on blur / toggle change).
  // Nothing reaches the gateway until the shared Save bar's review step
  // confirms the diff, so the SSE `config.changed` stream stays the single
  // source of truth for any-other-writer reconciliation.
  const patch = (keys, value) => onPatch(buildPatch(keys, value));
  const [queryText, setQueryText] = useState("");
  const [visibility, setVisibility] = useState("all");

  if (!schema) {
    return html`<div class="config-structured"><p class="config-empty">Loading schema…</p></div>`;
  }

  const query = queryText.trim().toLowerCase();
  const overridesOnly = visibility === "overrides";
  const explicitCount = schema.children.reduce(
    (count, node) => count + countExplicitLeaves(node, [node.key], config),
    0,
  );
  const visibleNodes = schema.children.filter((node) =>
    nodeHasVisibleContent(node, [node.key], config, query, overridesOnly),
  );

  return html`
    <div class="config-structured">
      ${lastError ? html`
        <div class="config-banner error">
          <strong>The file on disk is invalid.</strong> The gateway kept the last good config in memory.
          <code>${lastError.message}</code>
          ${renderErrors(lastError.errors)}
        </div>
      ` : null}

      <div class="config-filterbar">
        <label class="config-search-label">
          <span>Find a setting</span>
          <input
            type="search"
            class="config-search-input"
            value=${queryText}
            placeholder="Name, description, or config path"
            onInput=${(event) => setQueryText(event.target.value)}
          />
        </label>
        <div class="config-visibility-filter">
          <span class="config-filter-label">Show</span>
          <${Segmented}
            options=${[
              { value: "all", label: "All settings" },
              { value: "overrides", label: `Set in config (${explicitCount})` },
            ]}
            value=${visibility}
            onChange=${setVisibility}
          />
        </div>
      </div>

      ${visibleNodes.map((node) => html`
        <${TopSection}
          key=${node.key}
          node=${node}
          config=${config}
          patch=${patch}
          busy=${busy}
          pushBasedSources=${pushBasedSources}
          serverErrors=${serverErrors}
          query=${query}
          overridesOnly=${overridesOnly}
          reconcileToken=${reconcileToken}
          dirtyPaths=${dirtyPaths}
        />
      `)}

      ${visibleNodes.length === 0
        ? html`<p class="config-no-results">No settings match this view.</p>`
        : null}
    </div>
  `;
}
