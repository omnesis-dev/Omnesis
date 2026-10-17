// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { connectionHref } from "./knowledge-connections.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";

const REASONS = {
  withdrawn: "The record this page describes was withdrawn.",
  claims_pending:
    "None of the information it reads has changed; some of its claims are waiting to be verified again.",
};

function StaleCauseItem({ item }) {
  const source = item.kind === "source";
  const unavailable = item.title == null;
  const label = unavailable
    ? source
      ? "A document that is no longer available"
      : "A page that is no longer available"
    : item.title || "Untitled record";
  const icon = html`<${KnowledgeIcon}
    kind=${source ? "source" : (item.nodeKind ?? "wiki")}
    sourceId=${item.sourceId}
  />`;
  return html`<li class="kn-stale-cause">
    ${unavailable
      ? html`<span class="kn-stale-cause-unavailable">${icon}${label}</span>`
      : html`<a href=${connectionHref({ id: source ? `source:${item.id}` : item.id })}
          >${icon}${label}</a
        >`}
    ${item.change === "owner_changed" &&
    html`<span class="kn-stale-cause-note"> · updated, not yet reflected here</span>`}
  </li>`;
}

/** Why a stale page needs another look, naming the records that changed under it. */
export function KnowledgeStaleNotice({ causes }) {
  const items = causes?.items ?? [];
  const more = Math.max(0, (causes?.total ?? 0) - items.length);
  return html`<aside class="kn-notice">
    <strong>Some context needs another look.</strong>
    <p>Supporting information has changed. Treat this page as provisional until it is reviewed.</p>
    ${causes?.reason && html`<p>${REASONS[causes.reason]}</p>`}
    ${items.length > 0 &&
    html`<p class="kn-stale-causes-label">Supporting information that changed:</p>
      <ul class="kn-stale-causes">
        ${items.map((item) => html`<${StaleCauseItem} key=${`${item.kind}:${item.id}`} item=${item} />`)}
      </ul>
      ${more > 0 && html`<p class="kn-stale-causes-more">and ${more} more</p>`}`}
  </aside>`;
}
