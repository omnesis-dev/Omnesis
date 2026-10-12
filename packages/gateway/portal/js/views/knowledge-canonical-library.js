// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { lazy } from "../lib/lazy.js";
import { DevAnnotateButton } from "../components/dev-annotate-button.js";
import { loopDeadlineLabel } from "./knowledge-loop-library.js";
export const BriefDetail = lazy(() => import("./cognition.js").then((module) => module.BriefDetail));
export function libraryStatusOptions(kind) {
  return kind === "loop" ? [
    ["all", "All outcomes"], ["active", "Active"], ["resolved", "Resolved"],
    ["retired", "Retired"], ["open", "Open"], ["snoozed", "Snoozed"],
    ["done", "Done"], ["dismissed", "Dismissed"], ["decayed", "Decayed"], ["deleted", "Deleted"],
  ] : kind === "brief" ? [
    ["all", "All briefs"], ["unread", "Unread"], ["read", "Read"],
    ["snoozed", "Snoozed"], ["dismissed", "Dismissed"],
  ] : [];
}
export function libraryStateLabel(node) {
  const value = node.canonicalFields?.state;
  if (!value) return "";
  const label = value === "dismissed_snoozed" ? "Snoozed"
    : String(value).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  return node.libraryType === "retired-loop" ? `Retired · ${label}` : label;
}
export function RetirementMetadata({ node }) {
  const fields = node.canonicalFields ?? {};
  if (fields.recurrenceCount == null) return null;
  return html`<span>${fields.recurrenceCount} recurrences${fields.cadenceDays == null ? "" : ` · ${fields.cadenceDays} day cadence`}</span>`;
}
export function RetiredLoopDetail({ node, developer = false }) {
  const fields = node.canonicalFields;
  return html`<article class="kn-reader">
    <header class="kn-reader-header"><div class="kn-eyebrow">Retired outcome</div>
      <h2>${node.title || "Untitled outcome"}</h2>
      <span class="kn-badge">${libraryStateLabel(node)}</span>
      <${DevAnnotateButton} developer=${developer} target=${{ targetType: "retired_loop", targetId: fields.originalLoopId, label: node.title }} />
    </header>
    <div class="kn-reader-body">
      <p>${node.plainText}</p>
      <dl class="kn-facts">
        <dt>Recurrences</dt><dd>${fields.recurrenceCount ?? 0}</dd>
        <dt>Cadence</dt><dd>${fields.cadenceDays == null ? "Not established" : `${fields.cadenceDays} days`}</dd>
        <dt>Deadline</dt><dd>${loopDeadlineLabel(fields.deadline)}</dd>
        <dt>Importance</dt><dd>${typeof fields.importance === "number" ? `${Math.round(fields.importance * 100)}%` : "Not set"}</dd>
        <dt>Created</dt><dd>${fields.createdAt ? new Date(fields.createdAt).toLocaleString() : "Not recorded"}</dd>
        <dt>Retired</dt><dd>${new Date(fields.retiredAt).toLocaleString()}</dd>
      </dl>
      <p class="kn-caption">Retained history of a removed outcome; this is not an active obligation.</p>
    </div>
  </article>`;
}
