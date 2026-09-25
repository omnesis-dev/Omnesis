// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { listMergeCandidates, denyMergeCandidate, mergeCluster } from "../api.js";
import { renderAvatar } from "../lib/person-card.js";
import { navigate } from "../lib/router.js";
import { LoadMore } from "../components/load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";

/**
 * Merge candidates — a triage queue of probable-duplicate clusters.
 *
 * Members are checked by default; untick anyone who isn't the same person, then
 * Merge to unify the rest, or Dismiss to veto the grouping for good. Each member
 * row shows its identifying attributes as calm, borderless tokens (a small
 * uppercase type label + a mono value) rather than bordered pills — the chrome
 * was the clutter the redesign removes.
 *
 * The API returns candidates already cluster-contiguous and cluster-ranked, so
 * iterating `items` in order preserves the queue ordering.
 */

const ALIAS_RANK = { email: 0, phone: 1, lid: 2, name: 3 };
const ATTR_LIMIT = 4; // attributes shown before the "+N more" toggle

/** A person's aliases, strongest first (email > phone > lid > name). */
function sortedAliases(person) {
  return [...(person.aliases ?? [])].sort((a, b) => {
    const ra = ALIAS_RANK[a.aliasType] ?? 9;
    const rb = ALIAS_RANK[b.aliasType] ?? 9;
    return ra !== rb ? ra - rb : a.alias.localeCompare(b.alias);
  });
}

/** Group the flat candidate list into clusters, preserving API order. */
function buildClusters(items) {
  const clusters = new Map();
  for (const it of items) {
    const cid = it.clusterId ?? it.id;
    let cl = clusters.get(cid);
    if (!cl) {
      cl = { id: cid, members: new Map(), candidates: [] };
      clusters.set(cid, cl);
    }
    for (const p of [...(it.resolvedSideA ?? []), ...(it.resolvedSideB ?? [])]) {
      if (!p?.id) continue;
      if (!cl.members.has(p.id)) cl.members.set(p.id, p);
    }
    cl.candidates.push({
      id: it.id,
      adjudicationVerdict: it.adjudicationVerdict ?? null,
      adjudicationReason: it.adjudicationReason ?? null,
      needsOperator: it.needsOperator === true,
    });
  }
  return [...clusters.values()].map((cl) => ({ ...cl, members: [...cl.members.values()] }));
}

/**
 * The background agent's takes on a cluster — one entry per adjudicated
 * candidate (a multi-candidate cluster can carry several, and they may
 * disagree). A still-pending candidate holds either an `unsure` verdict or a
 * `merge` verdict the writer guard refused to apply — the latter is labelled
 * as such, so a bare "merge" never appears on a cluster that visibly didn't
 * merge.
 *
 * `needsOperator` marks the ones the agent will not revisit: it has said all
 * it can about the current evidence. Without it, "unsure" reads as work in
 * progress when it is in fact a request.
 */
function clusterAdjudications(cl) {
  return cl.candidates
    .filter((c) => c.adjudicationVerdict && c.adjudicationReason)
    .map((c) => ({
      key: c.id,
      label:
        c.adjudicationVerdict === "merge" ? "merge (blocked — needs review)" : c.adjudicationVerdict,
      reason: c.adjudicationReason,
      needsOperator: c.needsOperator,
    }));
}

/** Cluster title: a name-like member name, preferring the most active. */
function clusterTitle(members) {
  const named = members.filter((m) => /\s/.test(m.canonicalName) && !m.canonicalName.includes("@"));
  const pool = named.length > 0 ? named : members;
  const best = [...pool].sort(
    (a, b) => (b.interactionScoreRecent ?? 0) - (a.interactionScoreRecent ?? 0),
  )[0];
  return best?.canonicalName ?? "Unknown";
}

const EMPTY_COPY = {
  pending: { icon: "✓", title: "No pending candidates", body: "The fuzzy detector hasn't found any probable duplicates you haven't already decided on." },
  denied: { icon: "⃠", title: "Nothing dismissed yet", body: "Clusters you dismiss won't be re-proposed, and will be listed here." },
};

export function MergeCandidatesView() {
  const [statusFilter, setStatusFilter] = useState("pending"); // pending | denied
  const [query, setQuery] = useState("");
  const [requestedQuery, setRequestedQuery] = useState("");
  // Cluster ids with an in-flight merge/dismiss. A Set, not a single slot: the
  // merge flow can hold a card busy for several seconds while it waits for
  // materialization, and other cards stay usable.
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  // Per-cluster set of DESELECTED person ids. Absence = checked (default all).
  const [deselected, setDeselected] = useState({});
  const [collapsed, setCollapsed] = useState(() => new Set()); // cluster ids collapsed
  const [attrExpanded, setAttrExpanded] = useState(() => new Set()); // `${cid}:${pid}` expanded

  useEffect(() => {
    const timer = setTimeout(() => setRequestedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const page = useCursorPage({
    resetKey: `${statusFilter}:${requestedQuery}`,
    pageSize: 20,
    loadPage: ({ limit, cursor }) =>
      listMergeCandidates({
        status: statusFilter,
        clusterLimit: limit,
        cursor,
        q: requestedQuery || undefined,
      }),
    selectMeta: (payload) => payload.counts ?? null,
    mergeMeta: (_previous, next) => next,
  });
  const clusters = useMemo(() => {
    return buildClusters(page.items);
  }, [page.items]);
  useEffect(() => {
    setDeselected({});
    setCollapsed(new Set());
    setAttrExpanded(new Set());
  }, [statusFilter, requestedQuery]);

  const isPending = statusFilter === "pending";
  const isChecked = (clusterId, personId) => !(deselected[clusterId]?.has(personId) ?? false);

  function toggleMember(clusterId, personId) {
    setDeselected((prev) => {
      const set = new Set(prev[clusterId] ?? []);
      if (set.has(personId)) set.delete(personId);
      else set.add(personId);
      return { ...prev, [clusterId]: set };
    });
  }

  function checkedMemberIds(cl) {
    return cl.members.filter((m) => isChecked(cl.id, m.id)).map((m) => m.id);
  }

  function toggleAll(cl, allChecked) {
    setDeselected((prev) => ({
      ...prev,
      [cl.id]: allChecked ? new Set(cl.members.map((m) => m.id)) : new Set(),
    }));
  }

  function dropDeselected(clusterId) {
    setDeselected((prev) => {
      if (!(clusterId in prev)) return prev;
      const { [clusterId]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function toggleCollapse(clusterId) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }

  function toggleAttrs(key) {
    setAttrExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setBusy(clusterId, busy) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(clusterId);
      else next.delete(clusterId);
      return next;
    });
  }

  async function handleMerge(cl) {
    const ids = checkedMemberIds(cl);
    if (ids.length < 2) {
      setNotice({ kind: "err", text: "Select at least two entities to merge." });
      return;
    }
    setBusy(cl.id, true);
    setNotice(null);
    try {
      const result = await mergeCluster(ids);
      dropDeselected(cl.id);
      await page.reload();
      setNotice({
        kind: "ok",
        text: `Merge recorded for ${ids.length} entities — ${result.rulesCreated} rule(s) created.`,
      });
    } catch (err) {
      setNotice({ kind: "err", text: `Merge failed: ${err.message}` });
    } finally {
      setBusy(cl.id, false);
    }
  }

  async function handleDismiss(cl) {
    setBusy(cl.id, true);
    setNotice(null);
    try {
      await Promise.all(cl.candidates.map((c) => denyMergeCandidate(c.id)));
      setNotice({ kind: "ok", text: `Dismissed — these ${cl.members.length} entities won't be re-proposed as the same person.` });
      dropDeselected(cl.id);
      await page.reload();
    } catch (err) {
      setNotice({ kind: "err", text: `Dismiss failed: ${err.message}` });
    } finally {
      setBusy(cl.id, false);
    }
  }

  function renderAttr(a) {
    return html`
      <span class="mc-attr" key=${`${a.aliasType}:${a.alias}`}>
        <span class="mc-attr-type">${a.aliasType}</span>
        <span class="mc-attr-val mono">${a.alias}</span>
      </span>
    `;
  }

  function renderMemberRow(cl, m) {
    const checked = isChecked(cl.id, m.id);
    const attrs = sortedAliases(m);
    const key = `${cl.id}:${m.id}`;
    const expanded = attrExpanded.has(key);
    const shown = expanded ? attrs : attrs.slice(0, ATTR_LIMIT);
    const hidden = attrs.length - shown.length;
    const busy = busyIds.has(cl.id);
    return html`
      <div class=${`mc-member ${checked ? "" : "unchecked"}`} key=${m.id}>
        ${isPending
          ? html`<button
              class=${`mc-check ${checked ? "checked" : ""}`}
              role="checkbox"
              aria-checked=${checked}
              aria-label=${`Include ${m.canonicalName || "this entity"}`}
              disabled=${busy}
              onClick=${() => toggleMember(cl.id, m.id)}
            >${checked ? "✓" : ""}</button>`
          : html`<span class="mc-check-spacer"></span>`}
        <div class="mc-member-body">
          <a
            class="mc-member-title"
            href=${`/portal/people/${encodeURIComponent(m.id)}`}
            title=${`Open ${m.canonicalName || "person"}`}
            onClick=${(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/portal/people/${encodeURIComponent(m.id)}`); }}
          >${m.canonicalName || "(unnamed)"}</a>
          <div class="mc-attr-line">
            ${shown.map((a) => renderAttr(a))}
            ${attrs.length > ATTR_LIMIT && html`
              <button class="mc-attr-more" onClick=${() => toggleAttrs(key)}>
                ${expanded ? "show less" : `+${hidden} more`}
              </button>
            `}
          </div>
        </div>
      </div>
    `;
  }

  function renderClusterCard(cl) {
    const isCollapsed = collapsed.has(cl.id);
    const checkedCount = checkedMemberIds(cl).length;
    const allChecked = checkedCount === cl.members.length;
    const busy = busyIds.has(cl.id);
    return html`
      <div class=${`mc-cluster ${busy ? "busy" : ""}`} key=${cl.id}>
        <div class="mc-cluster-header">
          ${renderAvatar(clusterTitle(cl.members), "sm")}
          <div class="mc-cluster-titlewrap" onClick=${() => toggleCollapse(cl.id)}>
            <span class="mc-cluster-name">${clusterTitle(cl.members)}</span>
            <span class="mc-cluster-count">${cl.members.length} ${cl.members.length === 1 ? "entity" : "entities"}</span>
          </div>
          ${isPending && html`<span class="mc-selected-count">${checkedCount} of ${cl.members.length} selected</span>`}
          <div style="flex:1 1 auto;"></div>
          ${isPending && html`
            <button class="mc-toggle-all" disabled=${busy} onClick=${() => toggleAll(cl, allChecked)}>
              ${allChecked ? "Uncheck all" : "Check all"}
            </button>
            <button
              class="candidate-accept-btn"
              disabled=${busy || checkedCount < 2}
              onClick=${() => handleMerge(cl)}
              title="Unify the checked entities into one person"
            >Merge ${checkedCount}</button>
            <button
              class="candidate-reject-btn"
              disabled=${busy}
              onClick=${() => handleDismiss(cl)}
              title="Mark these as not the same person. Won't be re-proposed."
            >Dismiss</button>
          `}
          <button class="mc-collapse-btn" aria-label=${isCollapsed ? "Expand" : "Collapse"} onClick=${() => toggleCollapse(cl.id)}>
            ${isCollapsed ? "▸" : "▾"}
          </button>
        </div>
        ${!isCollapsed && html`
          <div class="mc-member-list">
            ${cl.members.map((m) => renderMemberRow(cl, m))}
          </div>
          ${clusterAdjudications(cl).map((adj) => html`
            <div class="mc-adjudication" key=${adj.key} title=${adj.reason}>
              <span class="mc-adjudication-verdict">assistant: ${adj.label}</span>
              ${adj.needsOperator && html`
                <span class="mc-adjudication-await" title="The assistant will not revisit this unless the evidence changes.">your call</span>
              `}
              <span class="mc-adjudication-reason">${adj.reason}</span>
            </div>
          `)}
        `}
      </div>
    `;
  }

  const seg = (val, label) => html`
    <button class=${statusFilter === val ? "active" : ""} onClick=${() => setStatusFilter(val)}>${label}</button>
  `;
  const empty = EMPTY_COPY[statusFilter];

  return html`
    <div style="max-width:100%;">
      <div style="margin-bottom:12px;">
        <h2 style="margin:0 0 8px 0;">Candidates</h2>
        ${page.meta && html`
          <div class="people-stats-bar">
            <span><strong class="mc-count-pending">${page.meta.pending}</strong> pending</span>
            <span>${page.meta.denied} denied</span>
          </div>
        `}
        <p class="mc-explainer">
          Probable duplicates, grouped into clusters. Members are checked by default — untick anyone
          who isn't the same person, then <strong>Merge</strong> to unify the rest (creates user
          merge rules; applies within a few seconds). <strong>Dismiss</strong> never re-proposes the
          grouping.
        </p>
      </div>

      <div class="mr-toolbar">
        <input
          class="search-input mr-search"
          type="text"
          placeholder="Search clusters or identifiers"
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
        />
        <div class="segmented mr-trigger-seg">
          ${seg("pending", "Pending")}
          ${seg("denied", "Denied")}
        </div>
      </div>

      ${notice && html`
        <div class=${`mc-notice ${notice.kind === "ok" ? "ok" : "err"}`}>${notice.text}</div>
      `}

      ${page.loading && html`<div class="loading"><span class="spinner"></span> Loading candidates...</div>`}
      ${page.error && html`<div class="sql-error">${page.error.message}</div>`}

      ${page.loaded && clusters.length === 0 && html`
        <div class="pc-empty-state">
          <div class="pc-empty-state-icon">${empty.icon}</div>
          <div class="pc-empty-state-title">${requestedQuery ? "No matching clusters" : empty.title}</div>
          <div class="pc-empty-state-body">${requestedQuery ? "No clusters match your search." : empty.body}</div>
        </div>
      `}

      ${clusters.length > 0 && html`
        <div class="mc-cluster-list">
          ${clusters.map((cl) => renderClusterCard(cl))}
        </div>
      `}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more candidates"
      />
    </div>
  `;
}
