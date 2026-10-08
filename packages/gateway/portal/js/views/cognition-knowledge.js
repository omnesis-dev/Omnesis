// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { KnowledgeInfiniteScroll } from "./knowledge-infinite-scroll.js";
import { annotationLifecycle } from "./knowledge-annotation-state.js";
import { useEffect, useState, useRef } from "preact/hooks";
import {
  getKnowledgeLibrary,
  getKnowledgeLibraryRetirement,
  getKnowledgeNodes,
  getKnowledgeNode,
  getKnowledgeHistory,
  getDocumentSummariesBulk,
} from "../api.js";
import {
  KnowledgeDetail,
  KnowledgeBadge,
  knowledgePath,
  knowledgeKinds,
  kindLabel,
  dateLabel,
} from "./knowledge-reader.js";
export { KnowledgeDetail, knowledgeReferenceHref } from "./knowledge-reader.js";

import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";
import { extractKnowledgeReferences } from "./knowledge-claim-markdown.js";
import { navigate, replaceUrl } from "../lib/router.js";
import {
  LoopContext,
  LoopActivity,
  loopDeadlineLabel,
  sortLibraryLoops,
} from "./knowledge-loop-library.js";

import { KnowledgeSubjectContext } from "./knowledge-subject-context.js";
import { BriefDetail, libraryStatusOptions, libraryStateLabel, RetirementMetadata, RetiredLoopDetail } from "./knowledge-canonical-library.js";

const preview = (text) =>
  String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_]/g, "")
    .trim();
export function knowledgeSelectionHref(id, kind = "", status = "all") {
  const path = id ? knowledgePath(id) : "/portal/debug/cognition/knowledge";
  const query = new URLSearchParams();
  if (kind) query.set("kind", kind);
  if (["loop", "brief"].includes(kind) && status !== "all") query.set("status", status);
  return path + (query.size ? `?${query}` : "");
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

export function PageCard({ node, selectedId, kind, status }) {
  const lifecycle = annotationLifecycle(node);
  const annotationNote = ["person_annotation", "doc_annotation"].includes(node.kind);
  const cardClass = `kn-card ${selectedId === node.id ? "is-selected" : ""}`;
  const card = html`<a
    class=${annotationNote ? "kn-card-link" : cardClass}
    href=${knowledgeSelectionHref(node.id, kind || (["loop", "brief"].includes(node.kind) ? node.kind : ""), status)}
    onClick=${navigateKnowledgeSelection}
    aria-current=${selectedId === node.id ? "page" : undefined}
    ><div class="kn-card-meta">
      <span>${kindLabel(node.kind)}</span>${node.validity === "stale" &&
      html`<span class="kn-needs-review">Needs review</span>`}
    </div>
    <h3><${KnowledgeIcon} kind=${node.kind} />${node.title}</h3>
    ${lifecycle.length > 0 && html`<div class="kn-loop-card-meta">${lifecycle.map((label) => html`<span class="kn-badge">${label}</span>`)}</div>`}
    ${["loop", "brief"].includes(node.kind) && html`<div class="kn-loop-card-meta"><span class="kn-badge">${libraryStateLabel(node)}</span>${node.kind === "brief" && html`<span>${node.canonicalFields?.briefKind ?? ""}</span>`}<${RetirementMetadata} node=${node} /></div>`}
    ${node.kind === "loop" &&
    html`<div class="kn-loop-card-meta">
${node.canonicalFields?.deadline &&
      html`<span>${loopDeadlineLabel(node.canonicalFields.deadline)}</span>`}${typeof node
        .canonicalFields?.importance === "number" &&
      html`<span>Importance ${Math.round(node.canonicalFields.importance * 100)}%</span>`}
    </div>`}
    <p>${preview(node.plainText).slice(0, 140) || "A page waiting to take shape."}</p>
    <span class="kn-card-date"
      >${node.kind === "brief" ? `Created ${dateLabel(node.canonicalFields?.createdAt)}` : `Updated ${dateLabel(node.updatedAt)}`} <span aria-hidden="true">↗</span></span
    ></a
  >`;
  return annotationNote ? html`<article class=${cardClass}>${card}<${KnowledgeSubjectContext} node=${node} /></article>` : card;
}
export function KnowledgeTab({ selectedId, developer = false }) {
  const listRef = useRef(null);
  const workspaceRef = useRef(null);
  const readerRef = useRef(null);
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;
    const resize = () => workspace.style.setProperty("--kn-workspace-height", `${Math.max(240, window.innerHeight - workspace.getBoundingClientRect().top - 20)}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(workspace.parentElement);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => { if (readerRef.current) readerRef.current.scrollTop = 0; }, [selectedId]);
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
  const requestedStatus = new URLSearchParams(routeSearch).get("status") ?? (new URLSearchParams(routeSearch).get("view") === "retired" ? "retired" : "all");
  const [loopState, setLoopState] = useState(requestedStatus),
    [loopSort, setLoopSort] = useState("updated");
  const [root, setRoot] = useState(null);
  const [detail, setDetail] = useState(null),
    [detailError, setDetailError] = useState("");
  const [references, setReferences] = useState({});
  const [detailMissing, setDetailMissing] = useState(false);
  const [canonicalLoopId, setCanonicalLoopId] = useState(null);
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [refresh, setRefresh] = useState(0),
    [activeTab, setActiveTab] = useState("overview");
  const [rootState, setRootState] = useState("loading");
  const page = useCursorPage({
    resetKey: JSON.stringify([kind, loopState, refresh]),
    pageSize: 30,
    staleCursorBehavior: "preserve",
    loadPage: ({ limit, cursor }) => getKnowledgeLibrary({ kind: kind || undefined, limit, cursor, consistency: "live",
      ...(["loop", "brief"].includes(kind) && loopState !== "all" ? { status: loopState } : {}) }),
  });
  const loading = page.loading;
  const error = page.error?.message ?? "";
  useEffect(() => {
    setKind(routeKind);
    setLoopState(requestedStatus);
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
    setRootState("loading");
    getKnowledgeNodes({ kind: "root", limit: 1 }).then((overview) => {
      if (alive) { setRootState("ready"); setRoot(overview.items[0] ?? null); }
    }, () => { if (alive) { setRootState("error"); setRoot(null); } });
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
      (selectedId.startsWith("retired-loop:") ? getKnowledgeLibraryRetirement(selectedId) : getKnowledgeNode(selectedId))
        .then(async (node) => {
          if (!alive) return;
          setDetail({ node, history: [], historyLoading: node.libraryType !== "retired-loop" });
          if (node.libraryType === "retired-loop") return;
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
  const filtered = (kind === "loop" ? sortLibraryLoops(page.items, loopSort) : page.items).filter(
    (node) =>
      (["loop", "brief"].includes(kind) || !validity || node.validity === validity) &&
      (!query ||
        `${node.title} ${node.plainText ?? ""}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return html`<div class=${`knowledge-library kn-library-page ${selectedId ? "has-selection" : ""}`}>
    <header class="kn-header">
      <div>
        <p class="kn-eyebrow">BRAIN / KNOWLEDGE</p>
        <h1>Your knowledge</h1>
        <p>What matters, what connects, and what is changing.</p>
      </div>
      <button
        class="kn-button kn-refresh"
        title="Refresh to include newly added or updated entries"
        disabled=${loading}
        onClick=${() => setRefresh((value) => value + 1)}
      >
        ↻ Refresh
      </button>
    </header>
    <div class="kn-workspace" ref=${workspaceRef}>
      <aside class="kn-library" aria-label="Knowledge library">
        <div class="kn-library-tools">
          <label class="kn-search"
            ><span aria-hidden="true">⌕</span
            ><input
              type="search"
              aria-label="Search loaded knowledge"
              placeholder="Search loaded pages…"
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
                setLoopState("all");
                const query = new URLSearchParams(window.location.search);
                query.delete("status"); query.delete("view");
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
            >${!["loop", "brief"].includes(kind) &&
            html`<select
              aria-label="Page status"
              value=${validity}
              onChange=${(event) => setValidity(event.target.value)}
            >
              <option value="">Any status</option>
              <option value="current">Up to date with linked evidence</option>
              <option value="stale">Needs review</option>
            </select>`}
            ${["loop", "brief"].includes(kind) && html`<select
                aria-label=${kind === "brief" ? "Brief status" : "Loop status"}
                value=${loopState}
                onChange=${(event) => {
                  const status = event.target.value; setLoopState(status);
                  const params = new URLSearchParams(window.location.search);
                  if (status === "all") params.delete("status"); else params.set("status", status);
                  params.delete("view"); replaceUrl(`${window.location.pathname}?${params}`);
                }}
              >${libraryStatusOptions(kind).map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select>`}
            ${kind === "loop" && html`<select
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
        <nav class="kn-card-list" aria-label="Knowledge pages" ref=${listRef}>
          ${filtered.map(
            (node) =>
              html`<${PageCard}
                key=${node.id}
                node=${node}
                selectedId=${selectedId}
                kind=${kind}
                status=${loopState}
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
                ? "Search and evidence filters cover loaded pages. Clear them to browse more knowledge."
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
                parameters.delete("status");
                parameters.delete("view");
                replaceUrl(
                  `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`,
                );
              }}
            >
              Clear filters
            </button>`}
          </div>`}
          <${KnowledgeInfiniteScroll} page=${page} listRef=${listRef} resetKey=${JSON.stringify([kind, loopState, query, validity, refresh])} />
        </nav>
      </aside>
      <main class="kn-reading-pane" ref=${readerRef}>
        ${selectedId
          ? html`<a
                class="kn-back"
                href=${knowledgeSelectionHref(null, kind, loopState)}
                onClick=${navigateKnowledgeSelection}
                >← Back to library</a
              >${(!detail && kind === "loop" && !selectedId.startsWith("retired-loop:")) &&
              html`<${LoopContext}
                id=${selectedId}
                refresh=${refresh}
                onReady=${setCanonicalLoopId}
                synthesisText=${detail?.node?.plainText ?? null}
              />`}${detailError
                ? kind === "brief" ? html`<${BriefDetail} id=${selectedId} />` : kind === "loop" && detailMissing
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
                  ? detail.node.libraryType === "retired-loop" ? html`<${RetiredLoopDetail} node=${detail.node} developer=${developer} />` : html`<${KnowledgeDetail}
                        ...${detail}
                        references=${references}
                        headerContent=${detail.node.kind === "loop" && html`<${LoopContext}
                          id=${selectedId}
                          refresh=${refresh}
                          onReady=${setCanonicalLoopId}
                          synthesisText=${detail.node.plainText ?? null}
                          embedded
                        />`}
                        overviewRenderer=${detail.node.kind === "brief" ? (content) => html`<${BriefDetail} id=${selectedId} content=${content} embedded />` : null}
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
