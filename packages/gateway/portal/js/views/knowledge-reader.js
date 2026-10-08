// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NodeReviewDetails } from "./knowledge-decision-context.js";
import { html } from "htm/preact";
import { annotationLifecycle } from "./knowledge-annotation-state.js";
import { KnowledgeSubjectContext } from "./knowledge-subject-context.js";
import { useState } from "preact/hooks";
import { Segmented } from "../components/segmented.js";
import { KnowledgeClaimReader } from "./knowledge-claim-reader.js";
import {
  claimMarkupRanges,
  renderKnowledgeMarkdown,
  internalKnowledgeHref,
} from "./knowledge-claim-markdown.js";
import { KnowledgeConnections } from "./knowledge-connections.js";
import { knowledgeHistoryComparisons, KnowledgeHistoryRevision } from "./knowledge-history.js";

export const knowledgePath = (id) => `/portal/debug/cognition/knowledge/${encodeURIComponent(id)}`;
export const knowledgeKinds = [
  ["", "All knowledge"],
  ["root", "Life overview"],
  ["wiki", "Wiki pages"],
  ["loop", "Loops"],
  ["doc_annotation", "Document notes"],
  ["person_annotation", "People notes"],
  ["brief", "Briefs"],
];
export const kindLabel = (kind) =>
  ({
    root: "Life overview",
    wiki: "Wiki page",
    loop: "Loop",
    doc_annotation: "Document note",
    person_annotation: "Person note",
    brief: "Brief",
  })[kind] ?? "Page";
export const readable = (value) => String(value ?? "").replaceAll("_", " ");
export const dateLabel = (value) =>
  value == null
    ? "Date unavailable"
    : new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
export const knowledgeReferenceHref = internalKnowledgeHref;
export function KnowledgeBadge({ value }) {
  const label =
    {
      current: "Up to date with linked evidence",
      stale: "Needs review",
      verified: "Verified",
      unverified: "Not verified",
      rejected: "Not supported",
      disputed: "Disputed",
      unsupported: "Unsupported",
    }[value] ?? readable(value);
  return html`<span
    class=${`kn-badge kn-badge--${["verified"].includes(value) ? "good" : ["stale", "rejected", "disputed"].includes(value) ? "review" : "neutral"}`}
    >${label}</span
  >`;
}
export function KnowledgeProse({ text, references = {} }) {
  // The shared renderer sanitizes Markdown; remote images are blocked for privacy.
  return html`<div
    class="kn-prose"
    dangerouslySetInnerHTML=${{ __html: renderKnowledgeMarkdown(text ?? "", [], references).html }}
  />`;
}
export function KnowledgeContent({ node, references, onClaim, selectedClaim }) {
  const [mode, setMode] = useState("markdown");
  const claims = node.claims ?? [];
  return html`<div class="kn-content-mode" role="group" aria-label="Content display">
      <${Segmented}
        options=${[{ value: "markdown", label: "Markdown" }, { value: "raw", label: "Raw" }]}
        value=${mode}
        onChange=${setMode}
      />
    </div>
    ${selectedClaim && !claims.some((claim) => claim.id === selectedClaim) && html`<p class="kn-claim-missing" role="status">The referenced claim is not present in this version of the page.</p>`}
    ${mode === "raw"
      ? html`<pre class="kn-code kn-raw-content" aria-label="Raw Markdown"><code>${node.markdown ?? ""}</code></pre>`
      : node.plainText
        ? claimMarkupRanges(node.markdown ?? "", claims).length
          ? html`<${KnowledgeClaimReader}
              node=${node}
              references=${references}
              onClaim=${onClaim}
              selectedClaim=${selectedClaim}
            />`
          : html`<${KnowledgeProse} text=${node.plainText} references=${references} />`
        : html`<div class="kn-empty">
            <h3>This page is taking shape</h3>
            <p>Its first synthesis has not been written yet.</p>
          </div>`}`;
}
export function KnowledgeDetail({
  node,
  history = [],
  references = {},
  activeTab = "overview",
  onTab = () => {},
  historyLoading = false,
  historyError = false,
  hideTitle = false,
  headerContent = null,
  overviewContent = null,
  overviewRenderer = null,
  selectedClaim = null,
  onClaim = () => {},
}) {
  const lifecycle = annotationLifecycle(node);
  const claims = node.claims ?? [],
    verified = claims.filter((claim) => claim.verification === "verified").length;
  const selectedField =
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("field");
  const tabs = [
    ["overview", "Overview"],
    ["connections", "Connections"],
    ["history", "History"],
    ["advanced", "Advanced"],
  ];
  return html`<article class="kn-reader">
    <header class="kn-reader-header">
      <div class="kn-eyebrow">
        ${kindLabel(node.kind)} ${lifecycle.length ? lifecycle.map((label) => html`<span class="kn-badge">${label}</span>`) : html`<${KnowledgeBadge} value=${node.validity} />`}
      </div>
      ${!hideTitle && html`<h2>${node.title}</h2>`}
      <${KnowledgeSubjectContext} node=${node} />
      ${headerContent}
      ${["wiki", "root", "loop"].includes(node.kind) && html`<div class="kn-review-context"><span>${node.metadata?.nextReviewAt == null ? "Review timing: Automatic" : `Next review: ${new Date(node.metadata.nextReviewAt).toLocaleString()}`}</span><${NodeReviewDetails} node=${node} /></div>`}
      <p class="kn-caption">
        ${`Updated ${dateLabel(node.updatedAt)}`}${claims.length && !lifecycle.length
          ? ` · ${verified} of ${claims.length} claims verified`
          : ""}
      </p>
    </header>
    <div class="kn-tabs" aria-label="Page sections">
      ${tabs.map(
        ([value, label]) =>
          html`<button
            type="button"
            key=${value}
            aria-pressed=${activeTab === value}
            class=${activeTab === value ? "is-active" : ""}
            onClick=${() => onTab(value)}
          >
            ${label}
          </button>`,
      )}
    </div>
    <div class="kn-reader-body">
      ${activeTab === "overview" &&
      html`${node.validity === "stale" &&
      html`<aside class="kn-notice">
        <strong>Some context needs another look.</strong>
        <p>
          Supporting information has changed. Treat this page as provisional until it is reviewed.
        </p>
      </aside>`}${node.kind === "root" &&
      html`<p class="kn-root-note">
        The compact overview your agents use to stay oriented. Details live in the pages it connects
        to.
      </p>`}${overviewRenderer ? overviewRenderer(html`<${KnowledgeContent}
        key=${node.id} node=${node} references=${references} onClaim=${onClaim} selectedClaim=${selectedClaim}
      />`) : html`<${KnowledgeContent}
        key=${node.id} node=${node} references=${references} onClaim=${onClaim} selectedClaim=${selectedClaim}
      />`}${overviewContent} `}
      ${activeTab === "connections" &&
      html`<${KnowledgeConnections}
        node=${node}
        references=${references}
      />`}
      ${activeTab === "history" &&
      html`<div class="kn-section-intro">
          <h3>How this page evolved</h3>
          <p>
            Previous versions preserve context about earlier understanding. Showing changes for the latest 30
            saved versions; expand a version to compare it with its predecessor.
          </p>
        </div>
        ${!history.length &&
        !historyLoading &&
        !historyError &&
        html`<div class="kn-empty">
          <h3>No previous versions</h3>
          <p>Saved revisions will appear here as this page develops.</p>
        </div>`}
        <div class="kn-timeline">
          ${knowledgeHistoryComparisons(history).map(
            ({ revision, previous }) => html`<${KnowledgeHistoryRevision}
              key=${`${node.id}:${revision.revision}`}
              revision=${revision}
              previous=${previous}
            />`,
          )}
        </div>`}
      ${activeTab === "advanced" &&
      html`<div class="kn-section-intro">
          <h3>Under the hood</h3>
          <p>Exact identifiers and metadata for inspecting the maintenance model.</p>
        </div>
        ${selectedField &&
        html`<section class="kn-field-target" aria-label="Referenced field">
          <h4>Referenced field: ${selectedField}</h4>
          <pre class="kn-code">
${JSON.stringify(
              node.canonicalFields?.[selectedField] ??
                "This field is not available on the current record.",
              null,
              2,
            )}</pre
          >
        </section>`}
        <dl class="kn-facts">
          <dt>Identity</dt>
          <dd>${node.id}</dd>
          <dt>Revision</dt>
          <dd>Edit ${node.revision} · meaning ${node.meaningRevision}</dd>
          ${!["wiki", "root", "loop"].includes(node.kind) && html`<dt>Next review</dt>
          <dd>
            ${node.metadata?.nextReviewAt == null
              ? "No explicit review date"
              : new Date(node.metadata.nextReviewAt).toLocaleString()}
          </dd>`}
        </dl>
        <section>
          <h4>Canonical fields and review metadata</h4>
          <pre class="kn-code">
${JSON.stringify({ fields: node.canonicalFields, review: node.metadata }, null, 2)}</pre
          >
        </section>
        <section>
          <h4>Exact claim dependencies</h4>
          <pre class="kn-code">
${JSON.stringify({ claims, dependencies: node.dependencies ?? [] }, null, 2)}</pre
          >
        </section>`}
    </div>
  </article>`;
}
