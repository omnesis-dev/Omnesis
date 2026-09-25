// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { hashColor, initials, groupPeopleByPerson } from "../lib/person-card.js";
import { navigate } from "../lib/router.js";

/**
 * Compact stack of overlapping circular avatars for the resolved
 * canonical people on a document. Reused by:
 *   - the person detail page's docs list,
 *   - the source-recent docs list,
 *   - search result rows.
 *
 * Inputs:
 *   - people: [{ personId, canonicalName, role?, isSelf? }]
 *       Slim shape returned by `POST /documents/people-bulk`.
 *   - totalCount: total resolved-people count for the doc (>= people.length)
 *       — drives the "+N" overflow chip when the server already
 *       capped the list. Defaults to people.length.
 *   - maxVisible: max bubbles before collapsing into "+N" (default 4).
 *       The "+N" itself counts as one slot, so when overflow kicks in
 *       we render `maxVisible - 1` real bubbles + 1 overflow chip.
 *   - excludePersonId: hide the bubble for one specific person — used
 *       on the person detail page so the page's own person doesn't
 *       repeat in every row's bubble stack.
 *   - size: "sm" (default, 22px) | "xs" (18px).
 *   - parentBg: CSS color used for the cutout border around each
 *       bubble. Defaults to var(--bg-secondary). Pass var(--bg-primary)
 *       when the row sits directly on the page background.
 */
export function PeopleBubbles({
  people,
  totalCount,
  maxVisible = 4,
  excludePersonId,
  size = "sm",
  parentBg,
}) {
  if (!people || people.length === 0) return null;

  // Defensive client-side dedupe: most callers receive an already-deduped
  // list from `/documents/people-bulk`, but the server/client contract
  // doesn't strictly forbid duplicates and direct callers (e.g. passing
  // raw `/documents/:id/people` rows) would otherwise render the same
  // bubble twice. Group keeps the original ordering and merges the
  // role list so the per-bubble tooltip shows every role.
  let filtered = groupPeopleByPerson(people);
  // If a totalCount was supplied (server already reports the
  // post-dedupe count), keep it. Otherwise fall back to the deduped
  // length so the "+N" overflow chip stays consistent.
  let total = totalCount ?? filtered.length;
  if (excludePersonId) {
    const before = filtered.length;
    filtered = filtered.filter((p) => p.personId !== excludePersonId);
    if (filtered.length < before) total = Math.max(0, total - 1);
  }
  if (filtered.length === 0) return null;

  const showOverflow = total > maxVisible;
  const visibleSlots = showOverflow ? Math.max(1, maxVisible - 1) : maxVisible;
  const visible = filtered.slice(0, visibleSlots);
  const overflow = total - visible.length;

  const sizeClass = size === "xs" ? "size-xs" : "";
  const styleVars = parentBg ? `--pb-cutout: ${parentBg};` : "";

  return html`
    <span
      class=${`pb-bubbles ${sizeClass}`.trim()}
      style=${styleVars}
      onClick=${(e) => e.stopPropagation()}
    >
      ${visible.map((p) => {
        const roleText = (p.roles && p.roles.length > 1)
          ? p.roles.join(", ")
          : (p.role ?? "");
        return html`
          <a
            key=${p.personId}
            class="pb-bubble"
            href=${`/portal/people/${encodeURIComponent(p.personId)}`}
            onClick=${(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigate(`/portal/people/${encodeURIComponent(p.personId)}`);
            }}
            title=${`${p.canonicalName}${roleText ? ` · ${roleText}` : ""}${p.isSelf ? " (you)" : ""}`}
            style=${`--pc-color: ${hashColor(p.canonicalName)};`}
          >
            ${initials(p.canonicalName)}
          </a>
        `;
      })}
      ${showOverflow && overflow > 0 && html`
        <span class="pb-bubble pb-overflow" title=${`+${overflow} more`}>
          +${overflow}
        </span>
      `}
    </span>
  `;
}
