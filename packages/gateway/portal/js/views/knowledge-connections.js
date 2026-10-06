// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { getKnowledgeConnections, getDocumentSummariesBulk } from "../api.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";

const kinds = {
  root: "Life overview",
  wiki: "Wiki page",
  loop: "Loop",
  doc_annotation: "Document note",
  person_annotation: "Person note",
  brief: "Brief",
  source: "Source document",
};
export function connectionHref(node) {
  return node.id.startsWith("source:")
    ? `/portal/doc/${encodeURIComponent(node.id.slice(7))}`
    : `/portal/debug/cognition/knowledge/${encodeURIComponent(node.id)}`;
}
export function connectionLabel(edge) {
  const incoming = edge.direction === "incoming";
  const labels = {
    supports: ["Supports this page", "Uses this page as support"],
    contradicts: ["Contradicts a claim here", "Uses this page as counterevidence"],
    context: ["Provides context here", "Uses this page as context"],
    depends_on: ["This page depends on it", "Depends on this page"],
    related_to: ["Related to this page", "Related to this page"],
    belongs_to_project: ["Project containing this page", "Belongs to this project"],
    part_of: ["Parent of this page", "Part of this page"],
    supersedes: ["Replaced by this page", "Replaces this page"],
    duplicate_of: ["This page duplicates it", "Duplicates this page"],
  };
  return (
    labels[edge.relationship]?.[incoming ? 1 : 0] ?? String(edge.relationship).replaceAll("_", " ")
  );
}
export function groupConnectionEdges(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.direction, edge.node.id, edge.relationship, edge.dependency]);
    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { ...edge, key, edges: [edge] });
  }
  return [...groups.values()];
}
async function loadConnections(id, options) {
  const result = await getKnowledgeConnections(id, options);
  const ids = [
    ...new Set(
      result.items
        .filter((edge) => edge.node.kind === "source")
        .map((edge) => edge.node.id.slice(7)),
    ),
  ];
  const { docs } = await getDocumentSummariesBulk(ids).catch(() => ({ docs: {} }));
  return {
    ...result,
    items: result.items.map((edge) =>
      edge.node.kind === "source"
        ? { ...edge, node: { ...edge.node, sourceId: docs[edge.node.id.slice(7)]?.source_id } }
        : edge,
    ),
  };
}
export function ConnectionCard({ edge, references = {} }) {
  const edges = edge.edges ?? [edge];
  const refs = edges.filter((item) => item.claimId || item.targetClaimId || item.ref);
  const category =
    edge.relationship === "context" && edge.ref
      ? "Context reference"
      : edge.dependency
        ? "Claim dependency"
        : "Organization link";
  return html`<li class="kn-connection-card">
    <p class="kn-connection-relation">${connectionLabel(edge)}</p>
    <a href=${connectionHref(edge.node)}
      ><${KnowledgeIcon} ...${references[edge.node.id] ?? {}} ...${edge.node} />${edge.node.title ||
      "Untitled record"}</a
    >
    <p class="kn-caption">${`${kinds[edge.node.kind] ?? "Knowledge record"} · ${category}`}</p>
    ${refs.length > 0 &&
    html`<details>
      <summary>${refs.length} claim reference${refs.length === 1 ? "" : "s"}</summary>
      ${refs.map(
        (item) =>
          html`<dl class="kn-facts" key=${item.id ?? item.ref}>
            ${item.claimId &&
            html`<dt>Claim using the reference</dt>
              <dd>${item.claimId}</dd>`}
            ${item.targetClaimId &&
            html`<dt>Referenced claim</dt>
              <dd>${item.targetClaimId}</dd>`}
            ${item.ref &&
            html`<dt>Reference</dt>
              <dd>${item.ref}</dd>`}
          </dl>`,
      )}
    </details>`}
  </li>`;
}
export function claimConnectionEdges(edges, claimId) {
  if (!claimId) return edges;
  return edges.filter((edge) =>
    edge.direction === "outgoing" ? edge.claimId === claimId : edge.targetClaimId === claimId,
  );
}

export function ConnectionClaims({ node, selectedClaim, onClaim, Badge, focusRef, filterRef }) {
  const claims = node.claims ?? [];
  const selected = claims.find((claim) => claim.id === selectedClaim);
  const assertion = (claim, index) =>
    html`<section class="kn-connection-claim" aria-label=${`Claim ${index + 1}`}>
      <div class="kn-evidence-meta">
        <strong>Claim ${index + 1}</strong><${Badge} value=${claim.verification} />
        ${claim.epistemicStatus &&
        claim.epistemicStatus !== "asserted" &&
        html`<${Badge} value=${claim.epistemicStatus} />`}
      </div>
      <p class="kn-claim-text">${claim.text}</p>
      <p class="kn-caption">
        ${String(claim.modality ?? "observation").replaceAll("_", " ")}${claim.attribution
          ? ` · Attributed to: ${claim.attribution}`
          : ""}${claim.supportLogic === "any" ? " · One sufficient source required" : ""}
      </p>
      ${!selectedClaim &&
      html`<button class="kn-button" onClick=${() => onClaim(claim.id)}>
        View connections for claim ${index + 1}
      </button>`}
    </section>`;
  return html`<div class="kn-connection-claims">
    <label class="kn-connection-filter"
      >Show connections
      <select
        aria-label="Filter connections by claim"
        ref=${filterRef}
        value=${selectedClaim ?? ""}
        onChange=${(event) => onClaim(event.target.value || null)}
      >
        <option value="">All relationships</option>
        ${claims.map(
          (claim, index) =>
            html`<option value=${claim.id}>Claim ${index + 1}: ${claim.text.slice(0, 90)}</option>`,
        )}
        ${selectedClaim &&
        !selected &&
        html`<option value=${selectedClaim}>Unavailable claim</option>`}
      </select>
    </label>
    ${selectedClaim
      ? html`<div
          class="kn-selected-claim"
          aria-label="Selected claim"
          aria-live="polite"
          tabindex="-1"
          ref=${focusRef}
        >
          ${selected
            ? assertion(selected, claims.indexOf(selected))
            : html`<p role="status">
                The referenced claim is not present in this version of the page.
              </p>`}
          ${selected &&
          html`<div class="kn-claim-family">
            ${claims
              .filter((claim) => claim.id === selected.parentId || claim.parentId === selected.id)
              .map(
                (claim) =>
                  html`<button class="kn-button" onClick=${() => onClaim(claim.id)}>
                    ${claim.id === selected.parentId
                      ? "Inspect enclosing claim"
                      : `Inspect nested claim ${claims.indexOf(claim) + 1}`}
                  </button>`,
              )}
          </div>`}
          <button class="kn-button" onClick=${() => onClaim(null)}>Show all relationships</button>
        </div>`
      : claims.length > 0 &&
        html`<details class="kn-claims-summary">
          <summary>Claims and verification (${claims.length})</summary>
          ${claims.map(assertion)}
        </details>`}
  </div>`;
}

export function KnowledgeConnections({
  node,
  references = {},
  selectedClaim = null,
  onClaim = () => {},
  Badge,
}) {
  const generation = useRef(0);
  const claimFocus = useRef(null);
  const filterFocus = useRef(null);
  useLayoutEffect(() => {
    if (selectedClaim) claimFocus.current?.focus();
    else filterFocus.current?.focus();
  }, [node.id, selectedClaim]);
  const [state, setState] = useState({ items: [], nextCursor: null, loading: true, error: null });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ items: [], nextCursor: null, loading: true, error: null });
    loadConnections(node.id)
      .then((result) => {
        if (generation.current === current) setState({ ...result, loading: false, error: null });
      })
      .catch((error) => {
        if (generation.current === current)
          setState({ items: [], nextCursor: null, loading: false, error: error.message });
      });
    return () => {
      generation.current++;
    };
  }, [node.id, node.revision, refresh]);
  async function loadMore() {
    const current = generation.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const result = await loadConnections(node.id, { cursor: state.nextCursor });
      if (generation.current === current)
        setState((value) => ({
          ...result,
          items: [...value.items, ...result.items],
          loading: false,
          error: null,
        }));
    } catch (error) {
      if (generation.current === current)
        setState((value) => ({ ...value, loading: false, error: error.message }));
    }
  }
  const visible = claimConnectionEdges(state.items, selectedClaim);
  const incoming = visible.filter((edge) => edge.direction === "incoming");
  const outgoing = visible.filter((edge) => edge.direction === "outgoing");
  return html`<section class="kn-connections">
    <div class="kn-section-intro">
      <h3>Connections</h3>
      <p>
        Inspect claims and supporting sources alongside context and organization links, which do not
        establish proof.
      </p>
    </div>
    <${ConnectionClaims}
      node=${node}
      selectedClaim=${selectedClaim}
      onClaim=${onClaim}
      Badge=${Badge}
      focusRef=${claimFocus}
      filterRef=${filterFocus}
    />
    ${state.error &&
    html`<p role="alert">
      Connections could not be loaded. ${state.error}
      <button
        class="kn-button"
        onClick=${() =>
          state.items.length && state.nextCursor ? loadMore() : setRefresh((value) => value + 1)}
      >
        Retry
      </button>
    </p>`}
    ${visible.length > 0 &&
    html`<div class="kn-connection-columns">
      ${[
        ["References from this page", outgoing],
        ["References to this page", incoming],
      ].map(
        ([title, edges]) =>
          html`<section>
            <h4>
              ${title}<span class="kn-caption"
                >${`${edges.length} edge${edges.length === 1 ? "" : "s"} loaded`}</span
              >
            </h4>
            <ul>
              ${groupConnectionEdges(edges).map(
                (edge) =>
                  html`<${ConnectionCard}
                    key=${edge.id ?? edge.key ?? JSON.stringify(edge)}
                    edge=${edge}
                    references=${references}
                  />`,
              )}
            </ul>
            ${!edges.length &&
            html`<p class="kn-caption">No connections in the loaded results.</p>`}
          </section>`,
      )}
    </div>`}
    ${state.loading && html`<p role="status">Loading connections…</p>`}
    ${!state.loading &&
    !state.error &&
    !visible.length &&
    !state.nextCursor &&
    html`<div class="kn-empty">
      <h4>No connections recorded</h4>
      <p>
        ${selectedClaim
          ? "No visible relationships are recorded for this claim."
          : "This page has no visible claim references or organization links yet."}
      </p>
    </div>`}
    ${!state.loading &&
    !visible.length &&
    state.nextCursor &&
    html`<p class="kn-caption">
      No matching relationships in the loaded results. Load more connections to continue.
    </p>`}
    ${state.nextCursor &&
    html`<button class="kn-button" disabled=${state.loading} onClick=${loadMore}>
      Load more connections
    </button>`}
    ${state.items.length > 0 &&
    html`<p class="kn-caption">
      ${`${selectedClaim ? `${visible.length} matching relationship${visible.length === 1 ? "" : "s"} · ` : ""}${state.items.length} connection${state.items.length === 1 ? "" : "s"} loaded${state.nextCursor ? " · More available" : " · All visible connections loaded"}. Private or unavailable records are omitted.`}
    </p>`}
  </section>`;
}
