// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
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
      current: "Inputs current",
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
export function KnowledgeProse({ text }) {
  // The shared renderer sanitizes Markdown; remote images are blocked for privacy.
  return html`<div
    class="kn-prose"
    dangerouslySetInnerHTML=${{ __html: renderKnowledgeMarkdown(text ?? "").html }}
  />`;
}
function Reference({ value, names = {} }) {
  const href = knowledgeReferenceHref(value);
  const label = names[value] ?? (value.startsWith("source:") ? "Source document" : "Related page");
  return href
    ? html`<a class="kn-reference" href=${href}><span aria-hidden="true">↗</span> ${label}</a>`
    : html`<span>Reference unavailable</span>`;
}
export function KnowledgeDetail({
  node,
  history = [],
  names = {},
  activeTab = "overview",
  onTab = () => {},
  historyLoading = false,
  historyError = false,
}) {
  const claims = node.claims ?? [],
    verified = claims.filter((claim) => claim.verification === "verified").length;
  const selectedField =
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("field");
  const requestedClaim =
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("claim");
  const tabs = [
    ["overview", "Overview"],
    ["evidence", "Evidence"],
    ["connections", "Connections"],
    ["history", "History"],
    ["advanced", "Advanced"],
  ];
  return html`<article class="kn-reader">
    <header class="kn-reader-header">
      <div class="kn-eyebrow">
        ${kindLabel(node.kind)} <${KnowledgeBadge} value=${node.validity} />
      </div>
      <h2>${node.title}</h2>
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
            ${label}${value === "evidence" && claims.length
              ? html`<span>${claims.length}</span>`
              : null}
          </button>`,
      )}
    </div>
    <div class="kn-reader-body">
      ${activeTab === "overview" &&
      requestedClaim &&
      !claims.some((claim) => claim.id === requestedClaim) &&
      html`<p class="kn-caption" role="status">
        The referenced claim is not present in this version of the page.
      </p>`}
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
      </p>`}${node.plainText
        ? claimMarkupRanges(node.markdown ?? "", claims).length
          ? html`<${KnowledgeClaimReader}
              node=${node}
              names=${names}
              referenceHref=${knowledgeReferenceHref}
              Badge=${KnowledgeBadge}
            />`
          : html`<${KnowledgeProse} text=${node.plainText} />`
        : html`<div class="kn-empty">
            <h3>This page is taking shape</h3>
            <p>Its first synthesis has not been written yet.</p>
          </div>`}
      ${(node.links ?? []).length > 0 &&
      html`<section class="kn-related">
        <h3>Connected pages</h3>
        ${node.links.map((link) => {
          const id = link.fromId === node.id ? link.toId : link.fromId;
          return html`<a href=${knowledgePath(id)} key=${`${link.kind}:${id}`}
            ><span>${names[`node:${id}`] ?? "Related page"}</span
            ><small>${readable(link.relation ?? link.kind)} ↗</small></a
          >`;
        })}
      </section>`}`}
      ${activeTab === "connections" && html`<${KnowledgeConnections} node=${node} />`}
      ${activeTab === "evidence" &&
      html`<div class="kn-section-intro">
          <h3>What this page is based on</h3>
          <p>
            Each claim keeps its own sources and verification status. A source link alone is not
            proof.
          </p>
        </div>
        ${!claims.length &&
        html`<div class="kn-empty">
          <h3>No claims yet</h3>
          <p>This page has no tagged assertions to inspect.</p>
        </div>`}${claims.map(
          (claim, index) =>
            html`<section class="kn-evidence-card" key=${claim.id}>
              <div class="kn-evidence-meta">
                <span>Claim ${index + 1}</span
                ><${KnowledgeBadge} value=${claim.verification} />${claim.epistemicStatus &&
                claim.epistemicStatus !== "asserted" &&
                html`<${KnowledgeBadge} value=${claim.epistemicStatus} />`}
              </div>
              <p class="kn-claim-text">${claim.text}</p>
              <p class="kn-caption">
                ${readable(claim.modality ?? "observation")}${claim.attribution
                  ? ` · Attributed to: ${claim.attribution}`
                  : ""}${claim.supportLogic === "any" ? " · One sufficient source required" : ""}
              </p>
              <div class="kn-sources">
                ${(node.dependencies ?? [])
                  .filter((dep) => dep.claimId === claim.id)
                  .map(
                    (dep) =>
                      html`<div key=${dep.ref}>
                        <span class="kn-caption">${readable(dep.relation)}</span
                        ><${Reference} value=${dep.ref} names=${names} />
                      </div>`,
                  )}
              </div>
              ${!(claim.refs ?? (node.dependencies ?? []).filter((dep) => dep.claimId === claim.id))
                .length && html`<p class="kn-caption">No supporting source attached.</p>`}
            </section>`,
        )}`}
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
                <${KnowledgeProse} text=${revision.plainText} />
              </details>`,
          )}
        </div>`}
      ${activeTab === "advanced" &&
      html`<div class="kn-section-intro">
          <h3>Under the hood</h3>
          <p>Exact identifiers and source markup for inspecting the maintenance model.</p>
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
        <details>
          <summary>Tagged Markdown</summary>
          <pre class="kn-code">${node.markdown}</pre>
        </details>
        <details>
          <summary>Canonical fields and review metadata</summary>
          <pre class="kn-code">
${JSON.stringify({ fields: node.canonicalFields, review: node.metadata }, null, 2)}</pre
          >
        </details>
        <details>
          <summary>Exact claim dependencies</summary>
          <pre class="kn-code">
${JSON.stringify({ claims, dependencies: node.dependencies ?? [] }, null, 2)}</pre
          >
        </details>`}
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
