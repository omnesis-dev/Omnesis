// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { PrivacyPolicyDiff } from "./policies/policy.js";

/** The extra snapshot is comparison context, never a thirty-first visible entry. */
export function knowledgeHistoryComparisons(history) {
  const byRevision = new Map(history.map((revision) => [revision.revision, revision]));
  return history.slice(0, 30).map((revision) => ({
    revision,
    previous: revision.previousRevision === 0 ? null : byRevision.get(revision.previousRevision),
  }));
}

export function knowledgeRevisionText(revision) {
  return revision ? `# ${revision.title ?? ""}\n\n${revision.markdown ?? revision.plainText ?? ""}` : "";
}

export function KnowledgeHistoryRevision({ revision, previous }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const placementStatus = revision.diff?.placementAssessment?.status;
  const placementLabel = placementStatus === "integrated" ? "connected"
    : placementStatus === "standalone" ? "standalone"
      : placementStatus === "deferred" ? "deferred" : null;
  const before = knowledgeRevisionText(previous);
  const after = knowledgeRevisionText(revision);
  return html`<section class="kn-revision">
    <header>
      <h4>Version ${revision.revision}</h4>
      <time>${new Date(revision.createdAt).toLocaleString()}</time>
    </header>
    <p class="kn-caption">
      ${`${revision.diff?.changedClaimIds?.length ?? 0} claim${revision.diff?.changedClaimIds?.length === 1 ? "" : "s"} changed`}
      · ${revision.validity === "stale" ? "Needed review" : "Current when saved"}
      ${placementLabel ? ` · Placement: ${placementLabel}` : null}
    </p>
    <details onToggle=${(event) => setExpanded(event.currentTarget.open)}>
      <summary>${previous === null ? "Initial version" : `Changes from version ${revision.previousRevision}`}</summary>
      ${expanded && (previous === undefined
        ? html`<p class="kn-caption">The preceding version is no longer available for comparison.</p>`
        : before === after
          ? html`<p class="kn-caption">No title or text changes in this version.</p>`
          : html`<${PrivacyPolicyDiff}
              before=${before}
              after=${after}
              page=${page}
              onPage=${setPage}
              label=${`Changes in version ${revision.revision}`}
            />`)}
    </details>
  </section>`;
}
