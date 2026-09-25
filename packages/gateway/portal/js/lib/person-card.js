// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { sourceIcon } from "./format.js";
import { navigate } from "./router.js";

/**
 * Unified PersonCard component shared across:
 *   - People list (`compact` + `featured` variants)
 *   - Merge candidates (`card` variant, paired)
 *   - Merge rules (`card` variant, paired with directional flow)
 *
 * Design vocabulary:
 *   - Hashed-color avatar with initials (deterministic per name → same
 *     person looks the same color across all pages).
 *   - Alias chips with type-icon prefixes (replaces "email:" text).
 *   - Recent-doc preview rows.
 *   - Source-icon strip (provenance at a glance).
 *   - Optional 10-dot interaction-score meter or thin score bar.
 *
 * Inputs:
 *   - person: ResolvedSidePerson (id, canonicalName, aliases?,
 *     sourceIds?, interactionScoreRecent?, mergedIntoCanonicalName?)
 *   - opts.referencedAlias: { aliasType, alias } — if set, the matching
 *     alias gets a `highlight` outline (used by the rule's referenced
 *     side and the candidate's matched alias).
 *   - opts.emphasis: "primary" | "subordinate" | undefined — visual
 *     hierarchy for merge-rule sides (winner = primary, loser = subordinate).
 *   - opts.dormant: bool — render as a dormant placeholder when no
 *     person resolves (rule's alias has no matching people).
 *   - opts.dormantSide: { aliasType, alias } — the alias text to show
 *     when dormant is true.
 */

// ─── Hashed colors + initials ───────────────────────────────────────

// Curated palette tuned for the dark theme (saturated but legible).
const PALETTE = [
  "#7d8590", // gray
  "#d29922", // gold
  "#3fb950", // green
  "#58a6ff", // blue
  "#a371f7", // purple
  "#ff7b72", // red
  "#39c5cf", // cyan
  "#f0883e", // orange
  "#bc8cff", // lavender
  "#ffa657", // peach
];

// FNV-ish string hash. Stable across runs (same name = same color).
export function hashColor(name) {
  if (!name) return PALETTE[0];
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h | 0) % PALETTE.length];
}

export function initials(name) {
  if (!name) return "?";
  const cleaned = name.trim();
  if (!cleaned) return "?";
  // If it looks like an email/handle (contains @ or no space), use first
  // 2 chars of the local part / handle.
  if (/[@<>]/.test(cleaned) || !/\s/.test(cleaned)) {
    const local = cleaned.split(/[@<>\s]/)[0];
    return local.slice(0, 2).toUpperCase();
  }
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── Alias-type icons ───────────────────────────────────────────────

// All four alias-type icons are decorative — they ride alongside the
// alias text in the same chip. `aria-hidden="true"` keeps screen
// readers from announcing them as "image" before reading the alias.
const ALIAS_ICON_PATHS = {
  email: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="12" height="9" rx="1.2" /><path d="M2.5 5l5.5 4.5L13.5 5" /></svg>`,
  phone: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5h3l1.5 3.5-2 1c1 2 2 3 4 4l1-2 3.5 1.5v3a1 1 0 0 1-1 1c-6 0-11-5-11-11a1 1 0 0 1 1-1z" /></svg>`,
  lid: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10c-1.5 0-3-1.3-3-3s1.5-3 3-3h2.5M10 6c1.5 0 3 1.3 3 3s-1.5 3-3 3h-2.5M6 7h4" /></svg>`,
  name: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="2.5" /><path d="M3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" /></svg>`,
};

function chipIcon(aliasType) {
  return ALIAS_ICON_PATHS[aliasType] ?? ALIAS_ICON_PATHS.name;
}

// ─── Role grouping ──────────────────────────────────────────────────

/**
 * Priority order for picking the "primary" role to display when a
 * person carries multiple roles on the same document. Strongest first.
 * Anything not listed sorts to the end (alphabetical fallback).
 */
const ROLE_PRIORITY = [
  "sender",
  "author",
  "owner",
  "participant",
  "attendee",
  "recipient",
  "mentioned",
  "contact",
];

/**
 * Compare two role strings by descending priority (strongest first).
 * Unknown roles sort to the end alphabetically.
 */
export function compareRoles(a, b) {
  const ai = ROLE_PRIORITY.indexOf(a);
  const bi = ROLE_PRIORITY.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return (a ?? "").localeCompare(b ?? "");
}

/**
 * Collapse a list of `{ personId, role, ... }` entries into one entry
 * per personId, with `role` set to the strongest role and a sorted
 * `roles` array listing every role that person carried on the doc.
 *
 * Used by:
 *   - the document detail page's Resolved People panel,
 *   - <PeopleBubbles> (defensive — bulk endpoint already dedupes, but
 *     direct callers passing per-role rows are still correct).
 *
 * Order is preserved from the input by first-occurrence of each
 * personId, so the original server-side ordering (e.g. self-first)
 * survives the collapse.
 */
export function groupPeopleByPerson(people) {
  if (!people || people.length === 0) return [];
  const byId = new Map();
  for (const p of people) {
    const key = p.personId ?? p.id;
    if (!key) continue;
    let entry = byId.get(key);
    if (!entry) {
      entry = { ...p, roles: [] };
      byId.set(key, entry);
    }
    if (p.role && !entry.roles.includes(p.role)) entry.roles.push(p.role);
  }
  const out = [];
  for (const entry of byId.values()) {
    entry.roles.sort(compareRoles);
    entry.role = entry.roles[0] ?? entry.role;
    out.push(entry);
  }
  return out;
}

// ─── Avatar ─────────────────────────────────────────────────────────

export function renderAvatar(name, size = "md") {
  const color = hashColor(name);
  const sizeClass = size === "md" ? "" : `size-${size}`;
  return html`
    <span class=${`pc-avatar ${sizeClass}`} style=${`--pc-color: ${color};`} aria-hidden="true">
      ${initials(name)}
    </span>
  `;
}

// ─── Score visualization (two variants — caller picks) ─────────────

/** 10-dot meter. score is in [0, 1]; we map to a relative percentile. */
export function renderScoreDots(score, opts = {}) {
  if (typeof score !== "number" || score <= 0) return null;
  // Most interaction scores live in [0, 0.2]. Map 0.20+ → 10 dots.
  const filled = Math.max(0, Math.min(10, Math.round((score / 0.2) * 10)));
  const dots = [];
  for (let i = 0; i < 10; i++) {
    dots.push(html`<span class=${`pc-score-dot ${i < filled ? "filled" : ""}`}></span>`);
  }
  const label = opts.label ?? formatScoreShort(score);
  return html`
    <span class="pc-score-dots" title=${`Interaction score (decayed 1y half-life): ${score.toFixed(4)}`}>
      ${dots}<span class="pc-score-label">${label}</span>
    </span>
  `;
}

/** Slim horizontal bar — alternative score viz. */
export function renderScoreBar(score) {
  if (typeof score !== "number" || score <= 0) return null;
  const pct = Math.max(0, Math.min(100, (score / 0.2) * 100));
  return html`
    <span class="pc-score-bar" title=${`Interaction score: ${score.toFixed(4)}`}>
      <span class="pc-score-bar-fill" style=${`width: ${pct}%`}></span>
    </span>
  `;
}

function formatScoreShort(score) {
  if (score >= 0.01) return score.toFixed(3);
  return score.toExponential(1);
}

// ─── Source-icon provenance strip ───────────────────────────────────

// Render with actual source-icon imgs (re-uses the existing helper —
// returns an htm template). Source-icon helper already returns an img.
export function renderSourceStripFromIds(sourceIds) {
  const unique = Array.from(new Set(sourceIds.filter(Boolean)));
  if (unique.length === 0) return null;
  return html`
    <span class="pc-source-strip">
      ${unique.slice(0, 6).map((id) => sourceIcon(id, { size: 14 }))}
    </span>
  `;
}

// ─── Alias chips ────────────────────────────────────────────────────

export function renderAliasChip(alias, isHighlight) {
  return html`
    <span class=${`pc-chip ${isHighlight ? "highlight" : ""}`} title=${`${alias.aliasType}: ${alias.alias}`}>
      <span class="pc-chip-icon">${chipIcon(alias.aliasType)}</span>
      <span>${alias.alias}</span>
    </span>
  `;
}

export function renderAliasChips(aliases, referencedAlias, opts = {}) {
  if (!aliases || aliases.length === 0) return null;
  const isMatch = (a) =>
    referencedAlias
    && a.aliasType === referencedAlias.aliasType
    && a.alias === referencedAlias.alias;
  // Sort: highlight first, then by type (email > phone > lid > name).
  const order = { email: 0, phone: 1, lid: 2, name: 3 };
  const sorted = [...aliases].sort((a, b) => {
    if (isMatch(a) !== isMatch(b)) return isMatch(a) ? -1 : 1;
    return (order[a.aliasType] ?? 99) - (order[b.aliasType] ?? 99);
  });
  const max = opts.max ?? Infinity;
  const visible = sorted.slice(0, max);
  const more = sorted.length - visible.length;
  return html`
    <div class="pc-chip-list">
      ${visible.map((a, i) => renderAliasChip(a, isMatch(a)))}
      ${more > 0 ? html`<span class="pc-chip">+${more}</span>` : null}
    </div>
  `;
}

/**
 * Compact one-row variant — for the People list main feed.
 */
export function renderCompactPersonRow(person, opts = {}) {
  const profileUrl = `/portal/people/${encodeURIComponent(person.id)}`;
  return html`
    <a
      key=${person.id}
      href=${profileUrl}
      class="pc-compact-row"
      onClick=${(e) => { e.preventDefault(); navigate(profileUrl); }}
    >
      ${renderAvatar(person.canonicalName, "sm")}
      <span class="pc-compact-row-name">
        ${person.canonicalName}
        ${person.isSelf ? html`<span class="people-self-tag" style="margin-left:4px;">(you)</span>` : null}
      </span>
      ${renderSourceStripFromIds(person.sourceIds ?? [])}
      <span class="pc-compact-row-meta">
        <span>${person.documentCount ?? 0} doc${(person.documentCount ?? 0) !== 1 ? "s" : ""}</span>
        <span>${person.aliasCount ?? 0} alias${(person.aliasCount ?? 0) !== 1 ? "es" : ""}</span>
        ${person.lastSeen ? html`<span>${opts.formatDate ? opts.formatDate(person.lastSeen) : person.lastSeen}</span>` : null}
      </span>
    </a>
  `;
}

/**
 * Mini person card — for the document page's resolved-people sidebar.
 * Same visual vocabulary as the featured/compact variants: hashed-color
 * avatar, name, role badge, optional one-line subtitle (e.g. "(self)").
 * Avoids the heavy alias listing — operator clicks through to see the
 * person's full profile if they want details.
 *
 * `opts.role` is the primary (strongest) role shown inline. `opts.roles`
 * (optional) is the full sorted list of roles this person carried on
 * the doc; when it has more than one entry a "+N" badge appears next
 * to the role and the card's `title` lists them all (revealed on hover).
 */
export function renderResolvedPersonMini(person, opts = {}) {
  const profileUrl = `/portal/people/${encodeURIComponent(person.personId ?? person.id)}`;
  const roles = opts.roles && opts.roles.length > 0 ? opts.roles : (opts.role ? [opts.role] : []);
  const primaryRole = roles[0];
  const extraRoles = roles.length > 1 ? roles.length - 1 : 0;
  const title = roles.length > 1
    ? `${person.canonicalName} \u00b7 ${roles.join(", ")}${person.isSelf ? " (you)" : ""}`
    : `${person.canonicalName}${primaryRole ? ` \u00b7 ${primaryRole}` : ""}${person.isSelf ? " (you)" : ""}`;
  return html`
    <a
      key=${person.personId ?? person.id}
      href=${profileUrl}
      class="pc-mini-card"
      title=${title}
      onClick=${(e) => { e.preventDefault(); navigate(profileUrl); }}
    >
      ${renderAvatar(person.canonicalName, "sm")}
      <div class="pc-mini-card-body">
        <span class="pc-mini-card-name">
          ${person.canonicalName}
          ${person.isSelf ? html`<span class="people-self-tag" style="margin-left:4px;">(you)</span>` : null}
        </span>
        ${primaryRole ? html`
          <span class="pc-mini-card-role">
            ${primaryRole}
            ${extraRoles > 0 ? html`<span class="pc-mini-card-role-extra" title=${roles.slice(1).join(", ")}>+${extraRoles}</span>` : null}
          </span>
        ` : null}
      </div>
    </a>
  `;
}

/**
 * Featured leaderboard card — used for the top-N people on the list page.
 * Bigger avatar, clearer score, source strip prominent.
 */
export function renderFeaturedPersonCard(person, opts = {}) {
  const profileUrl = `/portal/people/${encodeURIComponent(person.id)}`;
  return html`
    <a
      key=${person.id}
      href=${profileUrl}
      class=${`pc-featured-card ${person.isSelf ? "is-self" : ""}`}
      onClick=${(e) => { e.preventDefault(); navigate(profileUrl); }}
    >
      ${renderAvatar(person.canonicalName, "lg")}
      <div class="pc-featured-body">
        <span class="pc-featured-name">
          ${person.canonicalName}
          ${person.isSelf ? html`<span class="people-self-tag" style="font-size:11px;">· you</span>` : null}
        </span>
        <span class="pc-featured-stats">
          ${renderSourceStripFromIds(person.sourceIds ?? [])}
          <span>${person.documentCount ?? 0} doc${(person.documentCount ?? 0) !== 1 ? "s" : ""}</span>
        </span>
      </div>
    </a>
  `;
}
