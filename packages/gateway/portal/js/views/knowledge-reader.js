// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Segmented } from "../components/segmented.js";
import { KnowledgeClaimReader } from "./knowledge-claim-reader.js";
import {
  claimMarkupRanges,
  renderKnowledgeMarkdown,
  internalKnowledgeHref,
} from "./knowledge-claim-markdown.js";
import { KnowledgeConnections } from "./knowledge-connections.js";

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
  selectedClaim = null,
  onClaim = () => {},
}) {
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
        ${kindLabel(node.kind)} <${KnowledgeBadge} value=${node.validity} />
      </div>
      ${!hideTitle && html`<h2>${node.title}</h2>`}
      ${headerContent}
      <p class="kn-caption">
        ${`Updated ${dateLabel(node.updatedAt)}`}${claims.length
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
      </p>`}<${KnowledgeContent}
        key=${node.id}
        node=${node}
        references=${references}
        onClaim=${onClaim}
        selectedClaim=${selectedClaim}
      />${overviewContent} `}
      ${activeTab === "connections" &&
      html`<${KnowledgeConnections}
        node=${node}
        references=${references}
      />`}
      ${activeTab === "history" &&
      html`<div class="kn-section-intro">
          <h3>How this page evolved</h3>
          <p>
            Previous versions preserve context about earlier understanding. Showing the latest 30
            saved versions.
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
          ${history.map(
            (revision) =>
              html`<details key=${revision.revision}>
                <summary>
                  <span>Version ${revision.revision}</span
                  ><time>${new Date(revision.createdAt).toLocaleString()}</time>
                </summary>
                <p class="kn-caption">
                  ${`${revision.diff?.changedClaimIds?.length ?? 0} claim${revision.diff?.changedClaimIds?.length === 1 ? "" : "s"} changed`}
                  · ${revision.validity === "stale" ? "Needed review" : "Current when saved"}
                </p>
                <${KnowledgeProse} text=${revision.plainText} references=${references} />
              </details>`,
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
          <dt>Next review</dt>
          <dd>
            ${node.metadata?.nextReviewAt == null
              ? "Not scheduled"
              : new Date(node.metadata.nextReviewAt).toLocaleString()}
          </dd>
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
export function KnowledgeStatus({ status, compact = false }) {
  if (!status) return null;
  const work = status.work ?? [],
    pending = work
      .filter((row) => ["pending", "batched", "deferred"].includes(row.status))
      .reduce((sum, row) => sum + row.count, 0),
    cascades = status.cascades?.pending ?? 0;
  if (compact)
    return html`<div class="kn-maintenance">
      <div class="kn-maintenance-body">
        <strong
          >${pending || cascades ? "Updates awaiting maintenance" : "No updates waiting"}</strong
        >
        · ${pending} queued · <a href="/portal/debug/cognition/maintenance">View maintenance</a>
      </div>
    </div>`;
  return html`<details class="kn-maintenance">
    <summary>
      <span class=${`kn-status-dot ${pending || cascades ? "is-busy" : ""}`}></span
      ><strong
        >${pending || cascades ? "Updates awaiting maintenance" : "No updates waiting"}</strong
      ><span
        >${pending ? `${pending} queued` : cascades ? "Applying changes" : "No queued work"}</span
      >
    </summary>
    <div class="kn-maintenance-body">
      <h3>Work queue</h3>
      ${work.length
        ? html`<ul>
            ${work.map(
              (row) =>
                html`<li>
                  ${row.count} ${readable(row.status)} · ${readable(row.tier)} ·
                  ${readable(row.reason)}${row.readiness === "pending_content"
                    ? " · Waiting for source content"
                    : row.readiness === "derivation"
                      ? " · Waiting for document processing"
                      : ""}${row.nextDueAt != null &&
                  ["pending", "batched", "deferred"].includes(row.status)
                    ? ` · Next ${new Date(row.nextDueAt).toLocaleString()}`
                    : ""}
                </li>`,
            )}
          </ul>`
        : html`<p>No scheduled work.</p>`}
      <p>${`${cascades} pending cascade step${cascades === 1 ? "" : "s"}`}</p>
      <p>
        <a href="/portal/debug/cognition/bootstrap"
          >View discovery coverage and historical backfill</a
        >
      </p>
    </div>
  </details>`;
}
