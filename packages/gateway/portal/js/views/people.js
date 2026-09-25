// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import {
  getPeople,
  getPeopleStats,
  getPerson,
  getPersonDocuments,
  getPersonAnnotations,
  getDocumentsBulk,
  getMergeRulesForPerson,
  createMergeRule,
  deleteMergeRule,
  getDocumentsPeopleBulk,
  getSelfCandidate,
  patchAdminConfig,
} from "../api.js";
import { AnnotationList, OmnesisSparkle } from "../components/annotation-list.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { cursorPageBoundaryState, LoadMore } from "../components/load-more.js";
import { PeopleBubbles } from "../components/people-bubbles.js";
import { TabBar } from "../components/tab-bar.js";
import { sourceIcon, sourceLabel, timeAgo } from "../lib/format.js";
import { navigate, replaceUrl } from "../lib/router.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { MergeRulesView } from "./merge-rules.js";
import { MergeCandidatesView } from "./merge-candidates.js";
import {
  renderFeaturedPersonCard,
  renderCompactPersonRow,
  renderAvatar,
  renderAliasChips,
  renderSourceStripFromIds,
} from "../lib/person-card.js";

/**
 * People list — leaderboard layout.
 *
 * Hierarchy:
 *   - Search input.
 *   - Stats bar.
 *   - Section: "Top contacts" (top-N by interaction score) — featured
 *     cards in a grid (avatar + score dots + meta). Self pinned first
 *     with an accent border.
 *   - Section: "Everyone" (the rest) — compact rows with hashed avatars.
 *
 * No results fall back to a single section.
 */

function formatLastSeen(s) {
  if (!s) return "";
  return timeAgo(s);
}

export function shouldShowPersonAnnotations(annotations, annotationPage) {
  return Boolean(
    ((annotations?.length ?? 0) > 0 || cursorPageBoundaryState(annotationPage).visible),
  );
}

export function personMergeRuleBoundaryState(page) {
  return cursorPageBoundaryState(page);
}

/**
 * Nudge shown on the People page when no canonical self exists yet but the
 * gateway can infer one from a synced account (the account email IS the source
 * id). "Set as me" writes it to `config.self`; the gateway materializes the
 * self person on the next boot. A suggestion, never an automatic election.
 */
function SelfCandidateBanner({ candidate, onDismiss }) {
  const [state, setState] = useState("idle"); // idle | saving | saved | error
  const [error, setError] = useState(null);

  async function setAsMe() {
    setState("saving");
    setError(null);
    const res = await patchAdminConfig({ self: { emails: [candidate.email] } });
    if (res.ok) {
      setState("saved");
    } else {
      setState("error");
      setError(res.body?.error || `HTTP ${res.status}`);
    }
  }

  if (state === "saved") {
    return html`
      <div class="people-self-candidate saved">
        <span>✓ Saved <strong>${candidate.email}</strong> as you — restart the gateway to apply.</span>
        <button class="btn-tiny" onClick=${onDismiss}>dismiss</button>
      </div>
    `;
  }

  return html`
    <div class="people-self-candidate">
      <span class="people-self-candidate-msg">
        Is <strong>${candidate.email}</strong> you? Setting it lets your own messages attribute to you and makes <code>from:me</code> work.
      </span>
      <div class="people-self-candidate-actions">
        <button class="btn-primary btn-tiny" disabled=${state === "saving"} onClick=${setAsMe}>
          ${state === "saving" ? "Saving…" : "Set as me"}
        </button>
        <button class="btn-tiny" onClick=${onDismiss}>Dismiss</button>
      </div>
      ${error && html`<span class="people-self-candidate-error">${error}</span>`}
    </div>
  `;
}

function PersonList({ initialQuery = "" }) {
  const [query, setQuery] = useState(initialQuery);
  const [requestedQuery, setRequestedQuery] = useState(initialQuery);
  const [stats, setStats] = useState(null);
  // Self-candidate nudge: only when no self has been detected yet.
  const [candidate, setCandidate] = useState(null);
  const [candidateDismissed, setCandidateDismissed] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const peoplePage = useCursorPage({
    resetKey: requestedQuery,
    pageSize: 50,
    loadPage: ({ limit, cursor }) => getPeople(requestedQuery, limit, cursor),
    selectItems: (payload) => payload.people ?? payload.items ?? [],
  });

  useEffect(() => {
    getPeopleStats().then(setStats).catch(() => {});
    inputRef.current?.focus();
    return () => clearTimeout(debounceRef.current);
  }, []);

  // Once stats land, offer an inferred self only if none was detected.
  useEffect(() => {
    if (!stats || stats.selfDetected) {
      setCandidate(null);
      return;
    }
    getSelfCandidate()
      .then((res) => {
        const cand = res?.candidate ?? null;
        if (!cand) {
          setCandidate(null);
          return;
        }
        setCandidateDismissed(
          localStorage.getItem(`omnesis:self-candidate-dismissed:${cand.email}`) === "1",
        );
        setCandidate(cand);
      })
      .catch(() => setCandidate(null));
  }, [stats]);

  function dismissCandidate() {
    if (candidate) {
      localStorage.setItem(`omnesis:self-candidate-dismissed:${candidate.email}`, "1");
    }
    setCandidateDismissed(true);
  }

  function syncQueryToUrl(q) {
    const path = q ? `/portal/people?q=${encodeURIComponent(q)}` : "/portal/people";
    if (location.pathname + location.search !== path) {
      replaceUrl(path);
    }
  }

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    syncQueryToUrl(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setRequestedQuery(val), 250);
  }

  // Split into self / featured / rest.
  const filtered = peoplePage.items;
  const self = filtered.find((p) => p.isSelf);
  const others = filtered.filter((p) => !p.isSelf);
  // The list is already sorted by interaction score desc on the server
  // (default sort). Featured = top 9 (3×3 on a wide screen) when not
  // searching; when searching, treat all results uniformly as a list
  // (search intent is "find someone specific", not "browse top contacts").
  const isSearching = query.trim().length > 0;
  const FEATURED_COUNT = 9;
  const featured = isSearching ? [] : others.slice(0, FEATURED_COUNT);
  const rest = isSearching ? others : others.slice(FEATURED_COUNT);

  return html`
    <div class="people-view">
      <div class="people-search-bar">
        <input
          ref=${inputRef}
          class="search-input"
          type="text"
          placeholder="Search people..."
          value=${query}
          onInput=${handleInput}
        />
      </div>

      ${candidate && !candidateDismissed && stats && !stats.selfDetected && html`
        <${SelfCandidateBanner} candidate=${candidate} onDismiss=${dismissCandidate} />
      `}

      ${stats && html`
        <div class="people-stats-bar">
          <span>${stats.totalPeople} people</span>
          <span>${stats.totalAliases} aliases</span>
          <span>${stats.totalLinks} document links</span>
          ${stats.selfDetected ? html`<span class="people-self-badge">Self detected</span>` : ""}
        </div>
      `}

      ${peoplePage.loading && html`<div class="loading"><span class="spinner"></span> Loading people...</div>`}
      ${peoplePage.error && html`<div class="sql-error">${peoplePage.error.message ?? String(peoplePage.error)}</div>`}

      ${!peoplePage.loading && !peoplePage.error && filtered.length === 0 && html`
        <div class="pc-empty-state">
          <div class="pc-empty-state-icon">∅</div>
          <div class="pc-empty-state-title">No people found</div>
          <div class="pc-empty-state-body">
            ${query ? "Try a different search term." : "No people have been extracted yet. Start by adding a source on the Sources tab."}
          </div>
        </div>
      `}

      ${!peoplePage.loading && filtered.length > 0 && html`
        <div class="results-count">${filtered.length} result${filtered.length !== 1 ? "s" : ""} loaded</div>

        ${self && !isSearching && html`
          <div class="pc-page-section-h">
            <span>You</span>
            <span class="pc-page-section-h-rule"></span>
          </div>
          <div class="pc-featured-grid">
            ${renderFeaturedPersonCard(self)}
          </div>
        `}

        ${featured.length > 0 && html`
          <div class="pc-page-section-h">
            <span>Top contacts</span>
            <span class="pc-page-section-h-rule"></span>
            <span style="font-size:10px;color:var(--text-muted);text-transform:none;letter-spacing:normal;">by interaction score</span>
          </div>
          <div class="pc-featured-grid">
            ${featured.map((p) => renderFeaturedPersonCard(p))}
          </div>
        `}

        ${rest.length > 0 && html`
          ${!isSearching && html`
            <div class="pc-page-section-h">
              <span>Everyone</span>
              <span class="pc-page-section-h-rule"></span>
              <span style="font-size:10px;color:var(--text-muted);text-transform:none;letter-spacing:normal;">${rest.length} more</span>
            </div>
          `}
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${rest.map((p) => renderCompactPersonRow(p, { formatDate: formatLastSeen }))}
          </div>
        `}
        <${LoadMore}
          hasMore=${peoplePage.hasMore}
          loading=${peoplePage.loadingMore}
          error=${peoplePage.loadMoreError}
          onLoadMore=${peoplePage.loadMore}
          label="Load more people"
        />
      `}
    </div>
  `;
}

/**
 * Format an interaction score for display. Returns a 1e-4 precision
 * string for non-zero scores, or null when there's nothing to show
 * (lets the caller skip rendering the chip entirely on cold rows).
 * Scores live in [0, 1] but the typical range is much smaller (top
 * relationships sit around 1-5%); we use scientific-friendly
 * formatting so tiny values stay readable.
 */
function formatScore(score) {
  if (typeof score !== "number" || score <= 0) return null;
  if (score >= 0.01) return score.toFixed(3);
  return score.toExponential(1);
}

function PersonDetail({ id }) {
  const [person, setPerson] = useState(null);
  const [docDetails, setDocDetails] = useState({});
  const [peopleByDoc, setPeopleByDoc] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showMergePicker, setShowMergePicker] = useState(false);
  // Filter state: pills are inclusion-by-default; clicking a pill adds
  // its key to the disabled set, hiding documents that match it.
  const [disabledSources, setDisabledSources] = useState(() => new Set());
  const [disabledRoles, setDisabledRoles] = useState(() => new Set());
  // In-portal modals: confirm delete-merge-rule, plus a one-button alert
  // for the failure path (replaces window.confirm() / window.alert()).
  const [confirmDeleteRule, setConfirmDeleteRule] = useState(null); // ruleId | null
  const [ruleAlert, setRuleAlert] = useState(null);
  // Merge materialization: rule mutations kick the gateway's
  // merge-rules eval, so the merged state lands within a few seconds.
  // `applying` shows a progress banner while we poll for it;
  // `reloadNonce` re-runs the full load effect once it lands.
  const [applying, setApplying] = useState(null); // banner text | null
  const [applyNotice, setApplyNotice] = useState(null); // timeout modal text | null
  const [reloadNonce, setReloadNonce] = useState(0);
  const documentPage = useCursorPage({
    resetKey: `person-documents:${id}:${reloadNonce}`,
    pageSize: 20,
    loadPage: ({ limit, cursor }) => getPersonDocuments(id, limit, cursor),
    itemKey: (entry) => entry.id,
  });
  const annotationPage = useCursorPage({
    resetKey: `person-annotations:${id}:${reloadNonce}`,
    pageSize: 20,
    loadPage: ({ limit, cursor }) =>
      getPersonAnnotations(id, { limit, cursor, includeDependents: false }),
    selectItems: (payload) => payload.annotations ?? [],
  });
  const mergeRulePage = useCursorPage({
    resetKey: `person-merge-rules:${id}:${reloadNonce}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getMergeRulesForPerson(id, { limit, cursor }),
    selectItems: (payload) => payload.rules ?? [],
  });
  const mergeRules = mergeRulePage.items;
  const annotationBoundary = cursorPageBoundaryState(annotationPage);
  const mergeRuleBoundary = personMergeRuleBoundaryState(mergeRulePage);
  const documents = documentPage.items.map((entry) => entry.id);
  const rolesByDoc = Object.fromEntries(
    documentPage.items.map((entry) => [entry.id, entry.roles ?? []]),
  );
  // Async detail enrichment and merge-poll continuations must still belong to
  // the rendered person before touching state.
  const currentIdRef = useRef(id);
  currentIdRef.current = id;
  const enrichedDocumentIdsRef = useRef(new Set());

  function toggleDisabled(setter, key) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // A navigation to another person mid-poll must not carry over the
  // previous person's progress banner or timeout modal. Keyed on [id]
  // only — a reloadNonce bump may legitimately coincide with setting
  // the timeout notice.
  useEffect(() => {
    setApplying(null);
    setApplyNotice(null);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let current = true;
    getPerson(id)
      .then((personData) => {
        if (!current || currentIdRef.current !== id) return;
        setPerson(personData);
      })
      .catch((err) => {
        if (!current || currentIdRef.current !== id) return;
        const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
        setError(`${err.message}${reqId}`);
      })
      .finally(() => {
        if (current && currentIdRef.current === id) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [id, reloadNonce]);

  useEffect(() => {
    const pending = documents.filter(
      (documentId) => !enrichedDocumentIdsRef.current.has(documentId),
    );
    if (pending.length === 0) return;
    for (const documentId of pending) {
      enrichedDocumentIdsRef.current.add(documentId);
    }
    void fetchDocDetails(pending, id);
  }, [id, documentPage.items]);

  function handleDeleteRule(ruleId) {
    setConfirmDeleteRule(ruleId);
  }

  async function performDeleteRule() {
    const ruleId = confirmDeleteRule;
    setConfirmDeleteRule(null);
    if (!ruleId) return;
    const forId = id;
    const isStale = () => currentIdRef.current !== forId;
    try {
      await deleteMergeRule(ruleId);
      // Rule deletion kicks the gateway's merge-rules eval. When this
      // page renders merged state, poll until it changes (the unmerge
      // lands within a couple of seconds); a dormant rule changes no
      // person state, so just reload after a beat.
      setApplying("Updating merge state…");
      if (person?.mergedInto || (person?.mergedFrom?.length ?? 0) > 0) {
        await waitForPersonChange(id, personMergeSignature(person), { isStale });
      } else {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      if (isStale()) return;
      setApplying(null);
      setReloadNonce((n) => n + 1);
    } catch (err) {
      if (isStale()) return;
      setApplying(null);
      setRuleAlert(`Failed to delete rule: ${err.message}`);
    }
  }

  async function fetchDocDetails(docIds, forId) {
    if (docIds.length === 0) return;
    // One bulk round-trip instead of N parallel /documents/:id calls.
    // The server returns only present IDs; we backfill misses as null
    // so the consumer's lookups still resolve to a value.
    let bulk = { docs: {} };
    try {
      bulk = await getDocumentsBulk(docIds);
    } catch {
      // On failure, fall through with an empty result map — every doc
      // ends up null below, same as the previous per-id catch arm.
    }
    const results = {};
    for (const docId of docIds) {
      results[docId] = bulk.docs?.[docId] ?? null;
    }
    if (currentIdRef.current !== forId) return;
    setDocDetails((prev) => ({ ...prev, ...results }));
    // Bubble enrichment: parallel single bulk call per page of docs.
    getDocumentsPeopleBulk(docIds)
      .then((b) => {
        if (currentIdRef.current !== forId) return;
        setPeopleByDoc((prev) => ({ ...prev, ...(b.docs ?? {}) }));
      })
      .catch(() => {});
  }

  function goBack(e) {
    e.preventDefault();
    if (history.length > 1) {
      history.back();
    } else {
      navigate("/portal/people");
    }
  }

  if (loading) return html`<div class="loading"><span class="spinner"></span> Loading person...</div>`;
  if (error) return html`<div class="empty-state"><h2>Error</h2><p>${error}</p></div>`;
  if (!person) return html`<div class="empty-state"><h2>Person not found</h2></div>`;

  // Loser pages render a banner pointing at the canonical instead of
  // the "Merge with..." button. The portal getPerson API does NOT
  // walk merged_into anymore (so loser pages show the loser's own
  // pre-merge state — aliases, docs, counts).
  const isLoser = person.mergedInto !== null;
  // Source-icon strip data: collect every distinct source_id from
  // this identity's aliases AND its docs.
  //
  //   - Canonical: `person.aliases` is the union (own + losers'
  //     aliases, deduped server-side); `getPersonDocuments` UNIONs
  //     docs across the equivalence class. So the strip shows the
  //     full footprint of this identity.
  //   - Loser:     `person.aliases` is loser-only (mergedFrom=[]
  //     for loser rows); `getPersonDocuments` returns only this
  //     row's directly-attributed docs. So the strip shows just
  //     this loser's pre-merge sources.
  //
  // Use `person.aliases` (not `aliasesOwn`) so the canonical's strip
  // includes losers' alias sources — `aliasesOwn || aliases` was
  // a bug because `aliasesOwn` is always an array (truthy), so the
  // `||` never fell through.
  const aliasSourceIds = (person.aliases || [])
    .map((a) => a.sourceId)
    .filter(Boolean);
  const docSourceIds = Object.values(docDetails)
    .filter(Boolean)
    .map((d) => d.source_id)
    .filter(Boolean);
  const allSourceIds = Array.from(new Set([...aliasSourceIds, ...docSourceIds]));

  return html`
    <div>
      <a class="doc-back" href="/portal/people" onClick=${goBack}>\u2190 Back to People</a>

      ${applying && html`
        <div class="loading"><span class="spinner"></span> ${applying}</div>
      `}

      <div class="person-detail-header">
        ${renderAvatar(person.canonicalName, "lg")}
        <div class="person-detail-header-body">
          <h1 class="person-detail-name">
            ${person.canonicalName}
            ${person.isSelf ? html`<span class="people-self-tag">(self)</span>` : ""}
          </h1>
          <div class="person-detail-meta">
            ${renderSourceStripFromIds(allSourceIds)}
            <span>${person.source}</span>
            ${person.firstSeen ? html`<span>· first seen ${timeAgo(person.firstSeen)}</span>` : ""}
            ${person.lastSeen ? html`<span>· last seen ${timeAgo(person.lastSeen)}</span>` : ""}
          </div>
        </div>
        ${!isLoser && html`
          <button
            class="sql-run-btn person-detail-merge-btn"
            onClick=${() => setShowMergePicker(true)}
          >
            Merge with...
          </button>
        `}
      </div>

      ${shouldShowPersonAnnotations(annotationPage.items, annotationPage) && html`
        <div class="meta-panel meta-panel--mb-lg person-annotations-panel">
          <div class="meta-enriched-title">
            ${OmnesisSparkle}
            <span>${person.isSelf
              ? "Profile"
              : `What Omnesis has learned about ${person.canonicalName || "this person"}`}</span>
          </div>
          <${AnnotationList} annotations=${annotationPage.items} store="person" />
          <${LoadMore}
            hasMore=${annotationBoundary.hasMore}
            loading=${annotationBoundary.loading}
            error=${annotationBoundary.error}
            onLoadMore=${annotationBoundary.onLoadMore}
            label="Load more observations"
          />
        </div>
      `}

      ${isLoser && html`
        <div class="person-merged-banner">
          <div class="person-merged-banner-icon">⤴</div>
          <div class="person-merged-banner-body">
            <div class="person-merged-banner-title">
              This identity has been merged into${" "}
              <a
                href="/portal/people/${encodeURIComponent(person.mergedInto)}"
                onClick=${(e) => { e.preventDefault(); navigate(`/portal/people/${encodeURIComponent(person.mergedInto)}`); }}
              >${person.mergedIntoCanonicalName ?? person.mergedInto}</a>.
            </div>
            <div class="person-merged-banner-body-text">
              You're seeing this row's pre-merge state — its own aliases and the documents that surfaced them. Edge counts and interaction scores are aggregated on the canonical.
            </div>
            ${mergeRules.length > 0 && html`
              <div class="person-merged-banner-rules">
                ${mergeRules.length === 1 ? "Caused by rule:" : `Caused by ${mergeRules.length} rules:`}
                ${mergeRules.map((rule) => html`
                  <span class="person-merged-banner-rule" key=${rule.id}>
                    <code>(${rule.sideA.aliasType}=${rule.sideA.alias}) ↔ (${rule.sideB.aliasType}=${rule.sideB.alias})</code>
                    <button
                      class="sql-run-btn person-merged-banner-rule-action"
                      onClick=${() => handleDeleteRule(rule.id)}
                      title=${rule.kind === "system" ? "Veto this auto-detected merge" : "Remove this user-issued merge"}
                    >
                      ${rule.kind === "system" ? "Veto" : "Remove"}
                    </button>
                  </span>
                `)}
              </div>
            `}
          </div>
        </div>
      `}

      ${person.mergedFrom && person.mergedFrom.length > 0 && html`
        <div class="meta-panel meta-panel--mb-lg">
          <div class="meta-panel-title">
            ${person.mergedFrom.length} ${person.mergedFrom.length === 1 ? "person" : "people"} merged into this canonical
          </div>
          <div class="meta-panel-sub">
            Their aliases, documents, and edge counts have been rolled up.
          </div>
          <div class="merge-loser-list">
            ${person.mergedFrom.map((mp) => html`
              <a
                key=${mp.id}
                class="merged-from-line merged-from-line-link"
                href="/portal/people/${encodeURIComponent(mp.id)}"
                onClick=${(e) => { e.preventDefault(); navigate(`/portal/people/${encodeURIComponent(mp.id)}`); }}
              >
                ${renderAvatar(mp.canonicalName, "sm")}
                <span class="merged-from-link">${mp.canonicalName}</span>
                ${(mp.sourceIds && mp.sourceIds.length > 0) && renderSourceStripFromIds(mp.sourceIds)}
                ${mp.appliedAt ? html`<span class="merged-from-when">merged ${timeAgo(mp.appliedAt)}</span>` : ""}
              </a>
            `)}
          </div>
        </div>
      `}

      ${!isLoser && mergeRules.length > 0 && person.mergedFrom?.length === 0 && html`
        <div class="meta-panel meta-panel--mb-lg">
          <div class="meta-panel-title">Merge rules touching this person</div>
          <div class="meta-panel-sub--dim">
            Rules reference this person's aliases but no other person currently matches the other side (dormant).
          </div>
          <div class="people-alias-list">
            ${mergeRules.map((rule) => html`
              <span class="people-alias-pill" key=${rule.id}>
                <span class="people-alias-type">${rule.kind}:</span>
                (${rule.sideA.aliasType}=${rule.sideA.alias}) \u2194 (${rule.sideB.aliasType}=${rule.sideB.alias})
                ${rule.reason ? html`<span class="people-alias-source"> — ${rule.reason}</span>` : ""}
                <button
                  class="sql-run-btn merge-rule-action"
                  onClick=${() => handleDeleteRule(rule.id)}
                  title=${rule.kind === "system" ? "Veto this auto-detected merge" : "Remove this user-issued merge"}
                >
                  ${rule.kind === "system" ? "Veto" : "Remove"}
                </button>
              </span>
            `)}
          </div>
        </div>
      `}
      <${LoadMore}
        hasMore=${mergeRuleBoundary.hasMore}
        loading=${mergeRuleBoundary.loading}
        error=${mergeRuleBoundary.error}
        onLoadMore=${mergeRuleBoundary.onLoadMore}
        label="Load more merge rules"
      />

      ${showMergePicker && html`
        <${MergePicker}
          person=${person}
          onClose=${() => setShowMergePicker(false)}
          onMerged=${async ({ otherPersonId }) => {
            const forId = id;
            const isStale = () => currentIdRef.current !== forId;
            setShowMergePicker(false);
            mergeRulePage.reload();
            setApplying("Applying merge…");
            const landed = await waitForMergeApplied(id, otherPersonId, { isStale });
            if (isStale()) return;
            setApplying(null);
            setReloadNonce((n) => n + 1);
            if (!landed) {
              setApplyNotice(
                "The merge rule was recorded, but the merge hasn't materialized yet. It should land shortly — refresh the page to check.",
              );
            }
          }}
        />
      `}

      ${(person.aliases || []).length > 0 && html`
        <div class="meta-panel" style="margin-bottom: 24px;">
          <div class="meta-panel-title">Aliases</div>
          ${renderAliasChips(person.aliases)}
        </div>
      `}

      ${formatScore(person.interactionScoreRecent) !== null && html`
        <div class="meta-panel" style="margin-bottom: 24px;">
          <div class="meta-panel-title">Interaction</div>
          <div class="people-alias-list">
            <span class="people-alias-pill">
              <span class="people-alias-type">recent:</span>
              in ${formatScore(person.inboundScoreRecent) ?? "0"} \u00B7
              out ${formatScore(person.outboundScoreRecent) ?? "0"} \u00B7
              score ${formatScore(person.interactionScoreRecent)}
            </span>
            ${formatScore(person.interactionScore) !== null && html`
              <span class="people-alias-pill">
                <span class="people-alias-type">lifetime:</span>
                in ${formatScore(person.inboundScore) ?? "0"} \u00B7
                out ${formatScore(person.outboundScore) ?? "0"} \u00B7
                score ${formatScore(person.interactionScore)}
              </span>
            `}
            <span class="people-alias-pill">
              <span class="people-alias-type">edges:</span>
              ${person.inboundCount} in / ${person.outboundCount} out
            </span>
          </div>
        </div>
      `}

      ${(() => {
        // Pill universe = every distinct source_id / role observed in
        // the loaded documents. Pills appear lazily (only after the
        // first page of doc details + roles arrives) and grow as
        // additional pages enter the viewport. A doc is shown unless its source is
        // disabled, OR every role it carries for this person is
        // disabled (so partial-role overlap still renders the row).
        const sourceIds = new Set();
        const roles = new Set();
        for (const docId of documents) {
          const doc = docDetails[docId];
          if (doc?.source_id) sourceIds.add(doc.source_id);
          for (const r of rolesByDoc[docId] || []) roles.add(r);
        }
        const sourceList = Array.from(sourceIds).sort();
        const roleList = Array.from(roles).sort();
        const visibleDocs = documents.filter((docId) => {
          const doc = docDetails[docId];
          if (doc?.source_id && disabledSources.has(doc.source_id)) return false;
          const docRoles = rolesByDoc[docId] || [];
          if (docRoles.length > 0 && docRoles.every((r) => disabledRoles.has(r))) return false;
          return true;
        });
        return html`
          <div class="meta-panel-title" style="margin-bottom: 12px;">
            Documents (${visibleDocs.length}${visibleDocs.length !== documents.length ? ` of ${documents.length}` : ""})
          </div>

          ${(sourceList.length > 0 || roleList.length > 0) && html`
            <div class="people-filter-bar">
              ${sourceList.length > 0 && html`
                <div class="people-filter-row">
                  <span class="people-filter-label">Sources</span>
                  <div class="people-filter-pills">
                    ${sourceList.map((sid) => {
                      const active = !disabledSources.has(sid);
                      return html`
                        <button
                          key=${sid}
                          class="people-filter-pill ${active ? "active" : "inactive"}"
                          onClick=${() => toggleDisabled(setDisabledSources, sid)}
                          title=${active ? "Click to hide this source" : "Click to show this source"}
                        >
                          <span class="people-filter-pill-icon">${sourceIcon(sid, { size: 12 })}</span>
                          ${sourceLabel(sid)}
                        </button>
                      `;
                    })}
                  </div>
                </div>
              `}
              ${roleList.length > 0 && html`
                <div class="people-filter-row">
                  <span class="people-filter-label">Relationship</span>
                  <div class="people-filter-pills">
                    ${roleList.map((role) => {
                      const active = !disabledRoles.has(role);
                      return html`
                        <button
                          key=${role}
                          class="people-filter-pill ${active ? "active" : "inactive"}"
                          onClick=${() => toggleDisabled(setDisabledRoles, role)}
                          title=${active ? "Click to hide this relationship" : "Click to show this relationship"}
                        >
                          ${role}
                        </button>
                      `;
                    })}
                  </div>
                </div>
              `}
            </div>
          `}

          ${documents.length === 0 && documentPage.loading && html`
            <div class="loading" style="padding: 20px;">
              <span class="spinner"></span> Loading documents...
            </div>
          `}

          ${documents.length === 0 && documentPage.loaded && html`
            <div class="empty-state" style="padding: 20px;">
              <p>No documents linked to this person.</p>
            </div>
          `}

          ${documents.length > 0 && visibleDocs.length === 0 && html`
            <div class="empty-state" style="padding: 20px;">
              <p>No documents match the active filters.</p>
            </div>
          `}

          <div class="people-doc-list">
            ${visibleDocs.map((docId) => {
              const doc = docDetails[docId];
              const summary = peopleByDoc[docId];
              if (!doc) {
                return html`
                  <div class="people-doc-item" key=${docId}>
                    <span class="people-doc-id">${docId.substring(0, 12)}...</span>
                  </div>
                `;
              }
              const meta = typeof doc.metadata === "string" ? JSON.parse(doc.metadata || "{}") : (doc.metadata || {});
              const docRoles = rolesByDoc[docId] || [];
              return html`
                <div
                  class="people-doc-item"
                  key=${docId}
                  onClick=${() => navigate(`/portal/doc/${encodeURIComponent(docId)}`)}
                >
                  <span class="people-doc-icon">${sourceIcon(doc.source_id)}</span>
                  <div class="people-doc-info">
                    <span class="people-doc-title">${doc.title || "Untitled"}</span>
                    <span class="people-doc-meta">
                      ${sourceLabel(doc.source_id)}
                      ${meta.documentType ? ` \u00B7 ${meta.documentType}` : ""}
                      ${docRoles.length > 0 ? ` \u00B7 ${docRoles.join(", ")}` : ""}
                      ${doc.source_created_at ? ` \u00B7 ${timeAgo(doc.source_created_at)}` : ""}
                    </span>
                  </div>
                  ${summary && summary.people?.length > 0 && html`
                    <${PeopleBubbles}
                      people=${summary.people}
                      totalCount=${summary.total}
                      maxVisible=${4}
                      excludePersonId=${id}
                    />
                  `}
                </div>
              `;
            })}
          </div>
        `;
      })()}

      <${LoadMore}
        hasMore=${documentPage.hasMore || Boolean(documentPage.error)}
        loading=${documentPage.loading || documentPage.loadingMore}
        error=${documentPage.loadMoreError ?? documentPage.error}
        onLoadMore=${documentPage.error ? documentPage.reload : documentPage.loadMore}
        label="Load more documents"
        loadingLabel="Loading documents…"
      />
      <${ConfirmModal}
        open=${confirmDeleteRule !== null}
        title="Permanently delete this merge rule?"
        body="People merged via it will be unmerged within a few seconds."
        confirmLabel="Delete"
        destructive=${true}
        onCancel=${() => setConfirmDeleteRule(null)}
        onConfirm=${performDeleteRule}
      />
      <${ConfirmModal}
        open=${!!applyNotice}
        title="Merge recorded — still applying"
        body=${applyNotice ?? ""}
        confirmLabel="OK"
        hideCancel=${true}
        onCancel=${() => setApplyNotice(null)}
        onConfirm=${() => setApplyNotice(null)}
      />
      <${ConfirmModal}
        open=${!!ruleAlert}
        title="Couldn't delete the merge rule"
        body=${ruleAlert ?? ""}
        confirmLabel="OK"
        hideCancel=${true}
        onCancel=${() => setRuleAlert(null)}
        onConfirm=${() => setRuleAlert(null)}
      />
    </div>
  `;
}

/**
 * Poll both sides of a freshly-created merge rule until one of them
 * has `mergedInto` set. Rule mutations kick the gateway's merge-rules
 * eval, so this typically lands within a couple of seconds. Resolves
 * true once the merge materialized, false on timeout (the periodic
 * eval still picks the rule up later) or when `isStale()` reports the
 * caller no longer cares.
 */
async function waitForMergeApplied(idA, idB, { attempts = 15, intervalMs = 1000, isStale } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (isStale?.()) return false;
    try {
      const [a, b] = await Promise.all([getPerson(idA), getPerson(idB)]);
      if (a.mergedInto !== null || b.mergedInto !== null) return true;
    } catch {
      // Transient fetch error — keep polling until attempts run out.
    }
  }
  return false;
}

/** Stable string capturing a person's merge state, for change polling. */
function personMergeSignature(p) {
  return JSON.stringify([p?.mergedInto ?? null, (p?.mergedFrom ?? []).map((m) => m.id).sort()]);
}

/**
 * Poll a person until their merge state differs from `beforeSignature`
 * (an unmerge landing, or a remaining rule re-applying). False on
 * timeout — e.g. deleting one of several rules can legitimately leave
 * the merge state unchanged.
 */
async function waitForPersonChange(
  personId,
  beforeSignature,
  { attempts = 8, intervalMs = 1000, isStale } = {},
) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (isStale?.()) return false;
    try {
      const p = await getPerson(personId);
      if (personMergeSignature(p) !== beforeSignature) return true;
    } catch {
      // Transient fetch error — keep polling until attempts run out.
    }
  }
  return false;
}

/**
 * MergePicker — modal-style search picker that lets the user pick
 * another person to merge into the current one. Picks the strongest
 * available alias (email > phone > lid > name) from each side and POSTs
 * a `kind='user'` rule. Rule creation kicks the merge-rules eval task,
 * so the merge itself applies within a few seconds; the parent view
 * polls for it via `waitForMergeApplied` and reloads.
 */
function MergePicker({ person, onClose, onMerged }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [winnerSide, setWinnerSide] = useState("a"); // "a" = current person wins
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  // Full detail of the selected target — fetched eagerly on select so
  // we can preview the resolved aliases BEFORE the user clicks confirm.
  // Without this, a misleading canonical_name (e.g. "priyanair@example.com"
  // displayed despite there being NO email alias on the row) would
  // hide what the rule actually matches on. Picker now surfaces the
  // exact (aliasType=value) tuple it'll send.
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [selectedDetailError, setSelectedDetailError] = useState(null);
  const debounceRef = useRef(null);

  function pickBestAlias(p) {
    if (!p?.aliases?.length && !p?.aliases) return null;
    const aliases = p.aliases || [];
    const order = ["email", "phone", "lid", "name"];
    for (const t of order) {
      const a = aliases.find((al) => al.aliasType === t);
      if (a) return { aliasType: a.aliasType, alias: a.alias };
    }
    // Fall back to canonicalName as a name alias. The fallback is
    // *labelled* in the preview as a "fallback" match because
    // canonical_name isn't always an authoritative identifier (e.g.
    // it can be email-shaped without there being an actual email
    // alias — which means the rule matches on a `name` value that
    // happens to look like an email).
    if (p.canonicalName) return { aliasType: "name", alias: p.canonicalName, fallback: true };
    return null;
  }

  // The "current person" preview is computed once from the prop.
  const sideAPreview = pickBestAlias(person);

  // The "target" preview updates whenever selectedDetail loads.
  const sideBPreview = selectedDetail ? pickBestAlias(selectedDetail) : null;

  function handleSearch(val) {
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (!val.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await getPeople(val, 20);
        // Exclude the current person from the picker results.
        setResults((data.people || []).filter((p) => p.id !== person.id));
      } catch (err) {
        const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
        setError(`${err.message}${reqId}`);
      } finally {
        setSearching(false);
      }
    }, 250);
  }

  async function handleSelect(p) {
    setSelected(p);
    setSelectedDetail(null);
    setSelectedDetailError(null);
    try {
      const detail = await getPerson(p.id);
      setSelectedDetail(detail);
    } catch (err) {
      setSelectedDetailError(err.message);
    }
  }

  async function handleMerge() {
    if (!selected || !selectedDetail) return;
    setSubmitting(true);
    setError(null);
    try {
      const sideA = sideAPreview;
      const sideB = sideBPreview;
      if (!sideA || !sideB) {
        throw new Error(
          `Cannot create merge rule — ${!sideA ? "this person" : "target person"} has no usable aliases (need at least an email, phone, LID, or name).`,
        );
      }
      // `created: false` (rule already active) is fine — the parent's
      // poll resolves immediately when the merge is already in effect.
      await createMergeRule({
        sideA: { aliasType: sideA.aliasType, alias: sideA.alias },
        sideB: { aliasType: sideB.aliasType, alias: sideB.alias },
        winnerSide,
        reason: reason || null,
      });
      onMerged({ otherPersonId: selected.id });
    } catch (err) {
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setError(`${err.message}${reqId}`);
    } finally {
      setSubmitting(false);
    }
  }

  return html`
    <div class="meta-panel meta-panel--mb-lg merge-picker">
      <div class="meta-panel-title merge-picker-head">
        <span>Merge ${person.canonicalName} with...</span>
        <button class="sql-run-btn merge-picker-cancel" onClick=${onClose}>Cancel</button>
      </div>
      <input
        class="search-input merge-picker-search"
        type="text"
        placeholder="Search for the other person..."
        aria-label="Search for the other person to merge with"
        value=${query}
        onInput=${(e) => handleSearch(e.target.value)}
        autofocus
      />
      ${searching && html`<div class="loading"><span class="spinner"></span> Searching...</div>`}
      ${results.length > 0 && html`
        <div class="people-card-list merge-picker-results">
          ${results.map((r) => html`
            <div
              class=${selected?.id === r.id ? "people-card merge-picker-card-selected" : "people-card"}
              key=${r.id}
              onClick=${() => handleSelect(r)}
            >
              <span class="people-card-name">${r.canonicalName}</span>
              <span class="people-card-meta">
                ${r.documentCount} doc${r.documentCount !== 1 ? "s" : ""}
                ${r.aliasCount} alias${r.aliasCount !== 1 ? "es" : ""}
              </span>
            </div>
          `)}
        </div>
      `}
      ${selected && html`
        <div class="merge-picker-detail">
          <div class="merge-picker-selected-label">
            Selected: <strong>${selected.canonicalName}</strong>
          </div>

          ${selectedDetailError && html`<div class="sql-error">${selectedDetailError}</div>`}
          ${!selectedDetail && !selectedDetailError && html`
            <div class="loading merge-picker-loading-inline"><span class="spinner"></span> Resolving aliases...</div>
          `}
          ${selectedDetail && html`
            <div class="merge-picker-rule-preview">
              <div class="merge-picker-rule-preview-label">Will create rule:</div>
              <div class="merge-picker-rule-preview-tuple">
                <span class=${sideAPreview?.fallback ? "merge-picker-rule-warn--fallback" : ""}>(${sideAPreview ? `${sideAPreview.aliasType}=${sideAPreview.alias}` : "??"})</span>
                ${" \u2194 "}
                <span class=${sideBPreview?.fallback ? "merge-picker-rule-warn--fallback" : ""}>(${sideBPreview ? `${sideBPreview.aliasType}=${sideBPreview.alias}` : "??"})</span>
              </div>
              ${(sideAPreview?.fallback || sideBPreview?.fallback) && html`
                <div class="merge-picker-rule-warn">
                  ⚠ Falling back to canonical_name as a name alias on one side — that side has no email / phone / LID alias to match on.
                  Name matches are weaker (case-insensitive string equality on the display name).
                </div>
              `}
              ${sideAPreview && sideBPreview &&
                sideAPreview.aliasType === "name" && sideBPreview.aliasType === "name" && html`
                <div class="merge-picker-rule-warn">
                  ⚠ Both sides match on name only. Consider whether the names are unambiguous —
                  the rule will merge ANY two people whose name matches case-insensitively.
                </div>
              `}
            </div>
          `}

          <label class="merge-picker-radio">
            <input
              type="radio"
              name="winner"
              checked=${winnerSide === "a"}
              onChange=${() => setWinnerSide("a")}
            />
            Keep <strong>${person.canonicalName}</strong> as canonical
          </label>
          <label class="merge-picker-radio">
            <input
              type="radio"
              name="winner"
              checked=${winnerSide === "b"}
              onChange=${() => setWinnerSide("b")}
            />
            Keep <strong>${selected.canonicalName}</strong> as canonical
          </label>
          <input
            class="search-input merge-picker-search"
            type="text"
            placeholder="Optional reason (e.g. 'work email + personal phone')"
            aria-label="Optional reason for the merge rule"
            value=${reason}
            onInput=${(e) => setReason(e.target.value)}
          />
          ${error && html`<div class="sql-error">${error}</div>`}
          <button
            class="sql-run-btn merge-picker-confirm"
            onClick=${handleMerge}
            disabled=${submitting || !selectedDetail}
          >
            ${submitting ? "Creating rule..." : "Create merge rule"}
          </button>
        </div>
      `}
    </div>
  `;
}

export function PeopleView({ personId, tab = "list", initialQuery = "" }) {
  if (personId) {
    return html`<${PersonDetail} key=${personId} id=${personId} />`;
  }
  const activeTab = tab === "rules" || tab === "candidates" ? tab : "list";
  function selectTab(next) {
    if (next === activeTab) return;
    if (next === "rules") return navigate("/portal/people?tab=rules");
    if (next === "candidates") return navigate("/portal/people?tab=candidates");
    return navigate("/portal/people");
  }
  return html`
    <div>
      <${TabBar}
        style="margin-bottom: 16px;"
        active=${activeTab}
        onSelect=${selectTab}
        tabs=${[
          { key: "list", label: "People" },
          { key: "candidates", label: "Candidates" },
          { key: "rules", label: "Merge rules" },
        ]}
      />
      ${activeTab === "list"
        ? html`<${PersonList} initialQuery=${initialQuery} />`
        : activeTab === "candidates"
        ? html`<${MergeCandidatesView} />`
        : html`<${MergeRulesView} />`}
    </div>
  `;
}
