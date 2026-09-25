// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { listMergeRuleGroups, deleteMergeRule, deleteMergeRuleGroup } from "../api.js";
import { timeAgo } from "../lib/format.js";
import { renderAvatar, renderSourceStripFromIds } from "../lib/person-card.js";
import { navigate } from "../lib/router.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { LoadMore } from "../components/load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";

/**
 * Merge rules — applied-merge audit, as a grid of collapsible cards (two
 * columns on the desktop portal; the iOS / Android apps stack the same cards in
 * one column).
 *
 * Each card is a *merged identity* (the surviving canonical person): its header
 * shows the canonical name in the accent colour with the canonical alias right
 * underneath, the "N rules" count, and the latest merge time at the top-right.
 * Expanding it reveals the absorbed identities — each one the rule alias (mono)
 * stacked over that identity's name, aligned beside the ↳ arrow, with its
 * source icons at the right.
 *
 * Portal-only affordances layered on top of the shared layout:
 *   - the trigger (user / system) lives in the top All / User / System filter,
 *     not a per-card badge;
 *   - an "Undo merge" button surfaces over the timestamp on card hover;
 *   - a selection check fades in on hover for cross-card bulk undo.
 */

export function MergeRulesView() {
  const [query, setQuery] = useState("");
  const [requestedQuery, setRequestedQuery] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("all"); // all | user | system
  const [collapsed, setCollapsed] = useState(() => new Set()); // identity keys collapsed
  const [selected, setSelected] = useState(() => new Set()); // identity keys selected
  const [confirmUndo, setConfirmUndo] = useState(null); // { keys: string[], label } | null
  const [undoError, setUndoError] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setRequestedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const page = useCursorPage({
    resetKey: `${triggerFilter}:${requestedQuery}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) =>
      listMergeRuleGroups({
        limit,
        cursor,
        q: requestedQuery || undefined,
        kind: triggerFilter === "all" ? undefined : triggerFilter,
      }),
    itemKey: (group) => group.key,
  });
  const identities = page.items;
  const loadedRuleCount = identities.reduce(
    (count, identity) => count + (identity.sources?.length ?? 0),
    0,
  );
  useEffect(() => {
    setSelected(new Set());
    setCollapsed(new Set());
  }, [triggerFilter, requestedQuery]);

  function toggleCollapse(key) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelect(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allSelected = identities.length > 0 && identities.every((g) => selected.has(g.key));
  function toggleSelectAll() {
    setSelected(() => (allSelected ? new Set() : new Set(identities.map((g) => g.key))));
  }

  // Collect the rule + group ids backing a set of identity keys, so undo
  // deletes whole cluster batches in one call and singletons individually.
  function undoTargets(keys) {
    const keySet = new Set(keys);
    const groupIds = new Set();
    const ruleIds = new Set();
    for (const g of identities) {
      if (!keySet.has(g.key)) continue;
      for (const s of g.sources) {
        if (s.groupId) groupIds.add(s.groupId);
        else ruleIds.add(s.ruleId);
      }
    }
    return { groupIds: [...groupIds], ruleIds: [...ruleIds] };
  }

  async function performUndo() {
    const target = confirmUndo;
    setConfirmUndo(null);
    if (!target) return;
    const { groupIds, ruleIds } = undoTargets(target.keys);
    try {
      await Promise.all([
        ...groupIds.map((gid) => deleteMergeRuleGroup(gid)),
        ...ruleIds.map((rid) => deleteMergeRule(rid)),
      ]);
      setUndoError(null);
      setSelected(new Set());
      await page.reload();
    } catch (err) {
      setUndoError(`Failed to undo merge: ${err.message}`);
    }
  }

  function askUndo(keys) {
    const n = keys.length;
    const label = n === 1
      ? `Undo this merge? Its source identities split back apart within a few seconds.`
      : `Undo ${n} merges? Their source identities split back apart within a few seconds.`;
    setConfirmUndo({ keys, label });
  }

  const seg = (val, label) => html`
    <button class=${triggerFilter === val ? "active" : ""} onClick=${() => setTriggerFilter(val)}>${label}</button>
  `;

  function renderIdentity(g) {
    const isCollapsed = collapsed.has(g.key);
    const isSelected = selected.has(g.key);
    const ruleCount = g.sources.length;
    const personHref = g.person ? `/portal/people/${encodeURIComponent(g.person.id)}` : null;
    return html`
      <div class=${`mr-card ${isSelected ? "selected" : ""}`} key=${g.key}>
        <div class="mr-card-header" onClick=${() => toggleCollapse(g.key)}>
          <button
            class=${`mr-check ${isSelected ? "checked" : ""}`}
            role="checkbox"
            aria-checked=${isSelected}
            aria-label="Select merged identity"
            onClick=${(e) => { e.stopPropagation(); toggleSelect(g.key); }}
          >${isSelected ? "✓" : ""}</button>
          <span class="mr-chevron">${isCollapsed ? "▸" : "▾"}</span>
          ${renderAvatar(g.name, "sm")}
          <div class="mr-card-id">
            <div class="mr-card-name-row">
              ${g.person
                ? html`<a
                    class="mr-name"
                    href=${personHref}
                    onClick=${(e) => { e.preventDefault(); e.stopPropagation(); navigate(personHref); }}
                    title=${`Open ${g.name}`}
                  >${g.name}</a>`
                : html`<span class="mr-name mr-name-dormant" title="No people currently match">${g.name}</span>`}
              <span class="mr-rule-count">${ruleCount} rule${ruleCount !== 1 ? "s" : ""}</span>
            </div>
            ${g.canonicalEmail && html`<div class="mr-card-canonical mono">${g.canonicalEmail}</div>`}
          </div>
          <div class="mr-card-when">
            <span class="mr-when">${g.latest ? timeAgo(g.latest) : ""}</span>
            <button
              class="mr-undo-btn"
              onClick=${(e) => { e.stopPropagation(); askUndo([g.key]); }}
              title="Undo this merge — the source identities split back apart within a few seconds."
            >Undo</button>
          </div>
        </div>
        ${!isCollapsed && html`
          <div class="mr-card-sources">
            ${g.sources.map((s, i) => html`
              <div class="mr-card-source" key=${`${g.key}:${s.ruleId}:${i}`} title=${`${s.aliasType}: ${s.alias}`}>
                <span class="mr-source-arrow">↳</span>
                <div class="mr-card-source-text">
                  <div class="mr-card-source-alias mono">
                    ${s.personId
                      ? html`<a
                          class="mr-source-alias-link"
                          href=${`/portal/people/${encodeURIComponent(s.personId)}`}
                          onClick=${(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/portal/people/${encodeURIComponent(s.personId)}`); }}
                        >${s.alias}</a>`
                      : s.alias}
                  </div>
                  ${s.name && html`<div class="mr-card-source-name">${s.name}</div>`}
                  ${s.reason && html`<div class="mr-card-source-reason" title=${s.reason}>${s.reason}</div>`}
                </div>
                ${renderSourceStripFromIds(s.sourceIds)}
              </div>
            `)}
          </div>
        `}
      </div>
    `;
  }

  return html`
    <div class="people-view" style="max-width:100%;">
      <div style="margin-bottom:16px;">
        <h2 style="margin:0 0 8px 0;">Merge rules</h2>
        ${page.loaded && html`
          <div class="people-stats-bar">
            <span><strong>${identities.length}</strong> merge group${identities.length !== 1 ? "s" : ""} loaded</span>
            <span>${loadedRuleCount} rule${loadedRuleCount !== 1 ? "s" : ""}</span>
          </div>
        `}
      </div>

      ${page.loaded && html`
        <div class="mr-toolbar">
          <input
            class="search-input mr-search"
            type="text"
            placeholder="Search people or emails"
            value=${query}
            onInput=${(e) => setQuery(e.target.value)}
          />
          <div class="segmented mr-trigger-seg">
            ${seg("all", "All")}
            ${seg("user", "User")}
            ${seg("system", "System")}
          </div>
        </div>
      `}

      ${selected.size > 0 && html`
        <div class="mr-selection-bar">
          <span class="mr-selection-count">${selected.size} selected</span>
          <div style="flex:1 1 auto;"></div>
          <button class="mr-bulk-clear" onClick=${toggleSelectAll}>${allSelected ? "Deselect all" : "Select all"}</button>
          <button class="mr-bulk-undo" onClick=${() => askUndo([...selected])}>Undo merge</button>
          <button class="mr-bulk-clear" onClick=${() => setSelected(new Set())}>Clear</button>
        </div>
      `}

      ${page.loading && html`<div class="loading"><span class="spinner"></span> Loading rules...</div>`}
      ${page.error && html`<div class="sql-error">${page.error.message}</div>`}

      ${page.loaded && identities.length === 0 && !requestedQuery && triggerFilter === "all" && html`
        <div class="pc-empty-state">
          <div class="pc-empty-state-icon">⚯</div>
          <div class="pc-empty-state-title">No merge rules</div>
          <div class="pc-empty-state-body">
            Your people graph has no applied merges. To merge two people, open one of their profiles and click "Merge with...". To review fuzzy duplicates, head to the Candidates tab.
          </div>
        </div>
      `}

      ${page.loaded && identities.length === 0 && (requestedQuery || triggerFilter !== "all") && html`
        <div class="pc-empty-state">
          <div class="pc-empty-state-icon">∅</div>
          <div class="pc-empty-state-title">No matching rules</div>
          <div class="pc-empty-state-body">No merge rules match the current search or filter.</div>
        </div>
      `}

      ${identities.length > 0 && html`
        <div class=${`mr-cards ${selected.size > 0 ? "mr-cards--selecting" : ""}`}>
          ${identities.map((g) => renderIdentity(g))}
        </div>
      `}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more merge rules"
      />

      <${ConfirmModal}
        open=${confirmUndo !== null}
        title="Undo merge?"
        body=${confirmUndo?.label ?? ""}
        confirmLabel="Undo merge"
        destructive=${true}
        onCancel=${() => setConfirmUndo(null)}
        onConfirm=${performUndo}
      />
      <${ConfirmModal}
        open=${!!undoError}
        title="Undo failed"
        body=${undoError ?? ""}
        confirmLabel="OK"
        hideCancel=${true}
        onCancel=${() => setUndoError(null)}
        onConfirm=${() => setUndoError(null)}
      />
    </div>
  `;
}
