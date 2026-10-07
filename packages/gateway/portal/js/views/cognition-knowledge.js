// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState, useRef } from "preact/hooks";
import {
  getCognitionLoops,
  getCognitionLoop,
  getKnowledgeNodes,
  getKnowledgeNode,
  getKnowledgeHistory,
  getKnowledgeStatus,
  getDocumentSummariesBulk,
} from "../api.js";
import {
  KnowledgeDetail,
  KnowledgeStatus,
  KnowledgeBadge,
  knowledgePath,
  knowledgeKinds,
  kindLabel,
  dateLabel,
} from "./knowledge-reader.js";
export { KnowledgeDetail, KnowledgeStatus, knowledgeReferenceHref } from "./knowledge-reader.js";

import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";
import { extractKnowledgeReferences } from "./knowledge-claim-markdown.js";
import { navigate, replaceUrl } from "../lib/router.js";
import {
  LoopContext,
  LoopActivity,
  loopLibraryNode,
  loopDeadlineLabel,
  sortLibraryLoops,
} from "./knowledge-loop-library.js";

async function canonicalLoopCards(data) {
  if (data.canonical) return data;
  const items = await Promise.all(
    data.items.map(async (node) => {
      if (node.kind !== "loop") return node;
      try {
        const { loop } = await getCognitionLoop(node.id, { includeChildren: false });
        return { ...node, ...loopLibraryNode(loop), validity: node.validity };
      } catch {
        return { ...node, canonicalFields: {} };
      }
    }),
  );
  return { ...data, items };
}
const preview = (text) =>
  String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_]/g, "")
    .trim();
export function knowledgeSelectionHref(id, kind = "") {
  const path = id ? knowledgePath(id) : "/portal/debug/cognition/knowledge";
  return path + (kind ? `?kind=${encodeURIComponent(kind)}` : "");
}

/** Preserve normal new-tab actions while ordinary selections reuse the mounted library. */
export function navigateKnowledgeSelection(event) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
}

function PageCard({ node, selectedId, kind }) {
  return html`<a
    class=${`kn-card ${selectedId === node.id ? "is-selected" : ""}`}
    href=${knowledgeSelectionHref(node.id, kind)}
    onClick=${navigateKnowledgeSelection}
    aria-current=${selectedId === node.id ? "page" : undefined}
    ><div class="kn-card-meta">
      <span>${kindLabel(node.kind)}</span>${node.validity === "stale" &&
      html`<span class="kn-needs-review">Needs review</span>`}
    </div>
    <h3><${KnowledgeIcon} kind=${node.kind} />${node.title}</h3>
    ${node.kind === "loop" &&
    html`<div class="kn-loop-card-meta">
      <span>${node.canonicalFields?.state ?? "Outcome"}</span>${node.canonicalFields?.deadline &&
      html`<span>${loopDeadlineLabel(node.canonicalFields.deadline)}</span>`}${typeof node
        .canonicalFields?.importance === "number" &&
      html`<span>Importance ${Math.round(node.canonicalFields.importance * 100)}%</span>`}
    </div>`}
    <p>${preview(node.plainText).slice(0, 140) || "A page waiting to take shape."}</p>
    <span class="kn-card-date"
      >Updated ${dateLabel(node.updatedAt)} <span aria-hidden="true">↗</span></span
    ></a
  >`;
}
export function KnowledgeTab({ selectedId }) {
  const generation = useRef(0);
  const routeSearch = window.location.search;
  const requestedKind = new URLSearchParams(routeSearch).get("kind");
  const routeKind = /\/cognition\/loops(?:\/|$)/.test(window.location.pathname)
    ? "loop"
    : knowledgeKinds.some(([value]) => value === requestedKind)
      ? requestedKind
      : "";
  const [kind, setKind] = useState(routeKind),
    [query, setQuery] = useState(""),
    [validity, setValidity] = useState("");
  const [loopState, setLoopState] = useState("all"),
    [loopSort, setLoopSort] = useState("updated");
  const [page, setPage] = useState({ items: [], more: false }),
    [root, setRoot] = useState(null);
  const [status, setStatus] = useState(null);
  const [detail, setDetail] = useState(null),
    [detailError, setDetailError] = useState("");
  const [references, setReferences] = useState({});
  const [detailMissing, setDetailMissing] = useState(false);
  const [canonicalLoopId, setCanonicalLoopId] = useState(null);
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [activeTab, setActiveTab] = useState("overview");
  const [maintenanceError, setMaintenanceError] = useState(false);
  const [rootState, setRootState] = useState("loading");
  useEffect(() => {
    setKind(routeKind);
  }, [selectedId, routeSearch]);
  useEffect(() => {
    const params = new URLSearchParams(routeSearch);
    const claim = params.get("claim");
    setSelectedClaim(claim);
    const tab = params.get("tab");
    setActiveTab(
      params.has("field")
        ? "advanced"
        : params.has("claim")
          ? "overview"
          : ["connections", "history", "advanced"].includes(tab)
            ? tab
            : "overview",
    );
  }, [selectedId, routeSearch]);
  function selectClaim(id) {
    setSelectedClaim(id);
    setActiveTab("overview");
    const params = new URLSearchParams(window.location.search);
    params.delete("field");
    params.set("tab", "overview");
    if (id) params.set("claim", id);
    else params.delete("claim");
    replaceUrl(
      `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
    );
  }
  function selectTab(tab) {
    setActiveTab(tab);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    if (tab !== "overview") {
      params.delete("claim");
      setSelectedClaim(null);
    }
    if (tab !== "advanced") params.delete("field");
    replaceUrl(`${window.location.pathname}?${params}${window.location.hash}`);
  }
  useEffect(() => {
    let alive = true;
    generation.current++;
    setLoading(true);
    setError("");
    setPage({ items: [], more: false });
    (kind === "loop"
      ? getCognitionLoops({ limit: 30, ...(loopState === "all" ? {} : { state: loopState }) }).then(
          (data) => ({
            items: data.items.map(loopLibraryNode),
            cursor: data.pageInfo?.nextCursor ?? data.nextCursor ?? null,
            canonical: true,
          }),
        )
      : getKnowledgeNodes({ kind: kind || undefined, limit: 30 })
    )
      .then(canonicalLoopCards)
      .then((nodes) => {
        if (alive)
          setPage({
            items: nodes.items,
            cursor: nodes.cursor,
            more: nodes.canonical ? !!nodes.cursor : nodes.items.length === 30,
          });
      })
      .catch((failure) => {
        if (alive) setError(failure.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      generation.current++;
    };
  }, [kind, loopState, refresh]);
  useEffect(() => {
    let alive = true;
    setMaintenanceError(false);
    setRootState("loading");
    Promise.allSettled([getKnowledgeNodes({ kind: "root", limit: 1 }), getKnowledgeStatus()]).then(
      ([overview, state]) => {
        if (!alive) return;
        setRootState(overview.status === "fulfilled" ? "ready" : "error");
        setRoot(overview.status === "fulfilled" ? (overview.value.items[0] ?? null) : null);
        setStatus(state.status === "fulfilled" ? state.value : null);
        setMaintenanceError(state.status !== "fulfilled");
      },
    );
    return () => {
      alive = false;
    };
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setCanonicalLoopId(null);
    setDetailError("");
    setDetailMissing(false);
    setReferences({});
    if (selectedId)
      getKnowledgeNode(selectedId)
        .then(async (node) => {
          if (!alive) return;
          setDetail({ node, history: [], historyLoading: true });
          const historyItems = await getKnowledgeHistory(selectedId)
            .then((history) => {
              if (alive)
                setDetail((value) => ({ ...value, history: history.items, historyLoading: false }));
              return history.items;
            })
            .catch(() => {
              if (alive)
                setDetail((value) => ({ ...value, historyLoading: false, historyError: true }));
              return [];
            });
          if (!alive) return;
          const refs = [
            ...new Set([
              ...(node.dependencies ?? []).map((dep) => dep.ref),
              ...extractKnowledgeReferences(node.markdown ?? node.plainText ?? ""),
              ...historyItems.flatMap((item) => extractKnowledgeReferences(item.plainText ?? "")),
            ]),
          ].slice(0, 256);
          const sources = refs
            .filter((ref) => ref.startsWith("source:"))
            .map((ref) => ref.slice(7).split("#")[0]);
          const ids = [
            ...new Set([
              ...refs
                .filter((ref) => !ref.startsWith("source:"))
                .map((ref) => ref.split(":").slice(1).join(":").split("#")[0]),
            ]),
          ].slice(0, 24);
          const [documents, related] = await Promise.all([
            getDocumentSummariesBulk([...new Set(sources)].slice(0, 100)).catch(() => ({
              docs: {},
            })),
            Promise.allSettled(ids.map((id) => getKnowledgeNode(id))),
          ]);
          if (!alive) return;
          const refMetadata = {};
          for (const [id, doc] of Object.entries(documents.docs ?? {}))
            for (const ref of refs)
              if (ref.split("#")[0] === `source:${id}`) {
                refMetadata[ref] = { kind: "source", sourceId: doc.source_id, title: doc.title };
              }
          related.forEach((result) => {
            if (result.status !== "fulfilled") return;
            const item = result.value;
            refMetadata[`node:${item.id}`] = { kind: item.kind, title: item.title };
            for (const ref of refs)
              if (ref.split("#")[0].split(":").slice(1).join(":") === item.id) {
                refMetadata[ref] = { kind: item.kind, title: item.title };
              }
          });
          setReferences(refMetadata);
        })
        .catch((failure) => {
          if (alive) {
            setDetailError(failure.message);
            setDetailMissing(failure.status === 404);
          }
        });
    return () => {
      alive = false;
    };
  }, [selectedId, refresh]);
  async function more() {
    const current = generation.current;
    setError("");
    setLoading(true);
    try {
      const result =
        kind === "loop"
          ? await getCognitionLoops({
              limit: 30,
              cursor: page.cursor,
              ...(loopState === "all" ? {} : { state: loopState }),
            }).then((data) => ({
              items: data.items.map(loopLibraryNode),
              cursor: data.pageInfo?.nextCursor ?? data.nextCursor ?? null,
              canonical: true,
            }))
          : await getKnowledgeNodes({
              kind: kind || undefined,
              limit: 30,
              afterId: page.items.at(-1)?.id,
            });
      const data = await canonicalLoopCards(result);
      if (current === generation.current)
        setPage((value) => ({
          items: [...value.items, ...data.items],
          cursor: data.cursor,
          more: data.canonical ? !!data.cursor : data.items.length === 30,
        }));
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  const filtered = (kind === "loop" ? sortLibraryLoops(page.items, loopSort) : page.items).filter(
    (node) =>
      (kind === "loop" || !validity || node.validity === validity) &&
      (!query ||
        `${node.title} ${node.plainText ?? ""}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return html`<div class=${`knowledge-library ${selectedId ? "has-selection" : ""}`}>
    <header class="kn-header">
      <div>
        <p class="kn-eyebrow">BRAIN / KNOWLEDGE</p>
        <h1>Your knowledge</h1>
        <p>What matters, what connects, and what is changing.</p>
      </div>
      <button
        class="kn-button kn-refresh"
        disabled=${loading}
        onClick=${() => setRefresh((value) => value + 1)}
      >
        ↻ Refresh
      </button>
    </header>
    <${KnowledgeStatus} status=${status} compact=${true} />${maintenanceError &&
    html`<p class="kn-caption" role="status">
      Maintenance status is unavailable. Refresh to try again.
    </p>`}
    <div class="kn-workspace">
      <aside class="kn-library" aria-label="Knowledge library">
        <div class="kn-library-tools">
          <label class="kn-search"
            ><span aria-hidden="true">⌕</span
            ><input
              type="search"
              aria-label="Search knowledge"
              placeholder="Find a page or idea…"
              value=${query}
              onInput=${(event) => setQuery(event.target.value)}
          /></label>
          <div class="kn-filters">
            <select
              aria-label="Knowledge type"
              value=${kind}
              onChange=${(event) => {
                const next = event.target.value;
                setKind(next);
                const query = new URLSearchParams(window.location.search);
                if (next) query.set("kind", next);
                else query.delete("kind");
                replaceUrl(
                  `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`,
                );
              }}
            >
              ${knowledgeKinds.map(
                ([value, label]) => html`<option value=${value}>${label}</option>`,
              )}</select
            >${kind !== "loop" &&
            html`<select
              aria-label="Page status"
              value=${validity}
              onChange=${(event) => setValidity(event.target.value)}
            >
              <option value="">Any status</option>
              <option value="current">Up to date with linked evidence</option>
              <option value="stale">Needs review</option>
            </select>`}
            ${kind === "loop" &&
            html`<select
                aria-label="Loop status"
                value=${loopState}
                onChange=${(event) => setLoopState(event.target.value)}
              >
                <option value="all">All outcomes</option>
                <option value="active">Active</option>
                <option value="resolved">Resolved</option></select
              ><select
                aria-label="Sort loops"
                value=${loopSort}
                onChange=${(event) => setLoopSort(event.target.value)}
              >
                <option value="updated">Recently updated</option>
                <option value="deadline">Soonest deadline</option>
                <option value="importance">Highest importance</option>
              </select>`}
          </div>
          <p class="kn-caption">
            ${`${filtered.length} of ${page.items.length} loaded ${kind === "loop" ? "outcomes · sorting loaded results" : "pages"}${query ? " · searching loaded results" : ""}`}
          </p>
        </div>
        ${error &&
        html`<div class="kn-error" role="alert">
          <strong>Knowledge could not be loaded</strong>
          <p>${error}</p>
          <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>Retry</button>
        </div>`}
        <nav class="kn-card-list" aria-label="Knowledge pages">
          ${filtered.map(
            (node) =>
              html`<${PageCard}
                key=${node.id}
                node=${node}
                selectedId=${selectedId}
                kind=${kind}
              />`,
          )}${loading &&
          html`<div class="kn-loading" role="status">
            <span></span><span></span>
            <p>Loading your knowledge…</p>
          </div>`}${!loading &&
          !error &&
          !filtered.length &&
          html`<div class="kn-empty kn-empty-small">
            <h3>
              ${query || validity || kind ? "No matching pages" : "Your knowledge starts here"}
            </h3>
            <p>
              ${query || validity || kind
                ? "Try another search or filter. You can load more pages below."
                : "As the Brain learns from your sources, its pages and notes will appear here."}
            </p>
            ${(query || validity || kind) &&
            html`<button
              class="kn-button"
              onClick=${() => {
                setQuery("");
                setKind("");
                setValidity("");
                setLoopState("all");
                const parameters = new URLSearchParams(window.location.search);
                parameters.delete("kind");
                replaceUrl(
                  `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`,
                );
              }}
            >
              Clear filters
            </button>`}
          </div>`}
        </nav>
        ${page.more &&
        html`<button class="kn-button kn-load-more" disabled=${loading} onClick=${more}>
          Load more pages
        </button>`}
      </aside>
      <main class="kn-reading-pane">
        ${selectedId
          ? html`<a
                class="kn-back"
                href=${knowledgeSelectionHref(null, kind)}
                onClick=${navigateKnowledgeSelection}
                >← Back to library</a
              >${(!detail && kind === "loop") &&
              html`<${LoopContext}
                id=${selectedId}
                refresh=${refresh}
                onReady=${setCanonicalLoopId}
                synthesisText=${detail?.node?.plainText ?? null}
              />`}${detailError
                ? kind === "loop" && detailMissing
                  ? html`<div class="kn-empty">
                      <h2>No synthesis available</h2>
                      <p>
                        Read the canonical outcome and its activity above. This outcome may not have
                        a synthesis page.
                      </p>
                    </div>`
                  : html`<div class="kn-empty kn-error" role="alert">
                      <h2>This page could not be opened</h2>
                      <p>It may have been removed or access may have changed.</p>
                      <p class="kn-caption">${detailError}</p>
                      <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>
                        Retry
                      </button>
                    </div>`
                : detail
                  ? html`<${KnowledgeDetail}
                        ...${detail}
                        references=${references}
                        headerContent=${detail.node.kind === "loop" && html`<${LoopContext}
                          id=${selectedId}
                          refresh=${refresh}
                          onReady=${setCanonicalLoopId}
                          synthesisText=${detail.node.plainText ?? null}
                          embedded
                        />`}
                        overviewContent=${detail.node.kind === "loop" && html`<${LoopActivity}
                          id=${selectedId} refresh=${refresh} synthesisText=${detail.node.plainText ?? null}
                        />`}
                        hideTitle=${detail.node.kind === "loop" && canonicalLoopId === selectedId}
                        activeTab=${activeTab}
                        selectedClaim=${selectedClaim}
                        onClaim=${selectClaim}
                        onTab=${selectTab}
                      />${activeTab === "history" &&
                      detail.historyLoading &&
                      html`<p class="kn-history-status" role="status">
                        Loading revision history…
                      </p>`}${activeTab === "history" &&
                      detail.historyError &&
                      html`<p class="kn-history-status" role="alert">
                        Revision history could not be loaded.
                        <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>
                          Retry
                        </button>
                      </p>`}`
                  : html`<div class="kn-empty" role="status">
                      <span class="kn-orbit" aria-hidden="true">◌</span>
                      <h2>Opening your page…</h2>
                    </div>`}`
          : html` <section class="kn-home">
              <div class="kn-home-intro">
                <h2>Your overview</h2>
                <p>
                  Read the big picture, explore a project, or follow an idea back to the evidence
                  that supports it.
                </p>
              </div>
              ${rootState === "loading"
                ? html`<div class="kn-root-placeholder" role="status">
                    Loading your life overview…
                  </div>`
                : rootState === "error"
                  ? html`<div class="kn-root-placeholder" role="alert">
                      <h3>Your life overview is unavailable</h3>
                      <p>Refresh to try again.</p>
                    </div>`
                  : root
                    ? html`<a
                        class="kn-root-card"
                        href=${knowledgeSelectionHref(root.id, kind)}
                        onClick=${navigateKnowledgeSelection}
                        ><div class="kn-eyebrow">
                          YOUR LIFE AT A GLANCE
                          <span aria-hidden="true">↗</span>
                        </div>
                        <h3><${KnowledgeIcon} kind="root" />${root.title}</h3>
                        <p>
                          ${preview(root.plainText).slice(0, 380) ||
                          "Your compact life overview is taking shape."}
                        </p>
                        <div>
                          <${KnowledgeBadge} value=${root.validity} /><span class="kn-caption"
                            >Open life overview</span
                          >
                        </div></a
                      >`
                    : html`<div class="kn-root-placeholder">
                        <h3>Your life at a glance</h3>
                        <p>
                          A compact overview will appear here once the Brain has enough
                          context.${" "}
                          ${page.items.length
                            ? "Explore the pages in your library while it takes shape."
                            : "Pages will appear as your sources are considered."}
                        </p>
                      </div>`}
            </section>`}
      </main>
    </div>
  </div>`;
}
