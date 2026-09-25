// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { sourceTypeOf } from "./source-id.js";

export function timeAgo(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

/**
 * A duration in ms as a compact age ("45s", "12m", "3.4h", "2.1d").
 * Used for backlog head-of-queue ages, where the magnitude matters more than
 * the precision.
 */
export function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/**
 * Whether a backlog's oldest item has waited longer than the latency the job
 * is held to.
 *
 * Both numbers come from the server: the age it measured and the SLA it
 * enforces. Deciding this against a threshold hardcoded here instead would
 * drift the moment an operator configured a different one — showing a false
 * alarm on a longer setting and staying silent on a shorter one. No SLA
 * reported means the job is not held to one, which is not the same as meeting
 * it, so nothing is flagged.
 */
export function isBacklogLate(oldestPendingMs, pendingSlaMs) {
  return (
    typeof oldestPendingMs === "number" &&
    typeof pendingSlaMs === "number" &&
    pendingSlaMs > 0 &&
    oldestPendingMs > pendingSlaMs
  );
}

export function formatScore(score) {
  if (score == null) return "";
  return `${Math.round(score * 100)}%`;
}

// Schemes that are obviously not doc launchers. Anything else (http,
// https, things, notion, obsidian, …) is treated as a real deep-link
// the browser / OS can hand off to the right app.
const BLOCKED_SCHEMES_RE = /^(file|data|javascript|about):/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * True for a string the browser / OS can hand off to open the source
 * (http, https, things, notion, obsidian, …) and false for empty
 * values, bare text, or the blocked non-launcher schemes. Exported so
 * the document page can gate its single "Open in source" affordance on
 * the presence of a real deep-link.
 */
export function isOpenableExternalUrl(value) {
  return typeof value === "string"
    && value.length > 0
    && HAS_SCHEME_RE.test(value)
    && !BLOCKED_SCHEMES_RE.test(value);
}

/**
 * Resolve the URL a "open this document" click should navigate to.
 * Any indexed document (one with a `documentId`) opens in the in-app
 * doc viewer at `/portal/doc/:id` — that page is the single entry point
 * to the original source, via its "Open in source" button. The only
 * time we hand back an external URL is for a reference that is NOT an
 * indexed document (no `documentId`) but does point at an openable
 * target — i.e. an unresolved external link with no in-app page to show.
 *
 * Accepts a doc-shaped object — `{ documentId, sourceUrl }` for
 * search results, `{ documentId, url }` for agent `DocRef`s, or any
 * other shape where the URL lives on a recognised field.
 */
export function docHref(doc) {
  if (!doc) return null;
  if (doc.documentId) return `/portal/doc/${encodeURIComponent(doc.documentId)}`;
  const url = doc.sourceUrl || doc.url;
  if (isOpenableExternalUrl(url)) return url;
  return null;
}

/**
 * True iff the `docHref` for this doc points at an external source —
 * which only happens for an unresolved external reference (no
 * `documentId`). Indexed documents always resolve to the in-app viewer.
 */
export function isExternalDocHref(doc) {
  return !doc?.documentId && isOpenableExternalUrl(doc?.sourceUrl ?? doc?.url);
}

// Source metadata fetched from gateway (icons + labels). The gateway
// returns entries keyed by BOTH full sourceId (e.g. "browser-history:chrome")
// AND source type (e.g. "browser-history") — we look up the full ID first
// and fall back to the type-level entry, so sources where the icon depends
// on the account (browser-history, …) get account-specific icons while
// single-icon sources (Gmail, Notes, …) keep the old behaviour.
let _metaCache = null;

// The portal CSP permits only same-origin and data: images. Older
// sync_state rows may still contain hosted URLs from before the gateway
// normalized source icons at the write boundary, so filter cached values to
// the same contract before they reach an <img src>. A rejected per-instance
// icon leaves the provider descriptor's type-level data URI in place.
function isPortalSafeIcon(icon) {
  if (typeof icon !== "string") return false;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(icon)
    || /^\/(?![\\/])/.test(icon);
}

/** Prefetch source metadata from gateway. Call once on app startup. */
export async function loadSourceMeta() {
  // `/portal/source-meta.json` is the sync_state-backed map: it only carries
  // an entry for sources that have already synced at least once. A
  // freshly-added source (just walked through "+Add Source") has no row
  // here yet, so its icon would fall back to the generic 📄 until the
  // first sync completes and the collector pushes meta on `upsertWithCursor`.
  //
  // To close that gap we also pull `/admin/source-descriptors` — the union
  // of what every online collector serves up-front from its registered
  // providers' `defineSource(...)` / `defineProvider(...)` blocks, so it is
  // the same registry whether one host or several are connected. The gateway has
  // already normalised hosted URLs into `imageDataUri` data URIs (so the
  // strict CSP `img-src 'self' data: blob:` rule lets them through), so
  // the descriptor's `icon.imageDataUri` drops straight into the cache.
  //
  // Descriptors are the fallback layer keyed by `sourceType`; sync_state
  // entries win for full sourceIds. Net effect: a new source row gets the
  // right icon immediately via the descriptor lookup, and once it syncs
  // the more-specific sync_state entry takes over (relevant for sources
  // whose icon varies per account, e.g. browser-history chrome vs safari).
  const synced = await fetchSyncedMeta();
  const fromDescriptors = await fetchDescriptorMeta();
  // Per-key merge so synced entries (icon/label per account) layer over
  // descriptor entries (unitName, plus type-level icon/label) WITHOUT
  // dropping fields the synced row doesn't carry. A naive spread of
  // `{ ...descriptors, ...synced }` replaces the whole object per key,
  // so any source that had synced at least once would lose its
  // descriptor-supplied `unitName` — leaving the agent search summary
  // to fall back to the generic "items" label.
  const merged = { ...fromDescriptors };
  for (const [key, syncedEntry] of Object.entries(synced)) {
    if (typeof syncedEntry === "string") {
      if (isPortalSafeIcon(syncedEntry)) merged[key] = syncedEntry;
      continue;
    }
    const safeSyncedEntry = { ...syncedEntry };
    if (!isPortalSafeIcon(safeSyncedEntry.icon)) delete safeSyncedEntry.icon;
    const sourceTypeEntry = merged[sourceTypeOf(key)];
    merged[key] = {
      ...(typeof sourceTypeEntry === "object" ? sourceTypeEntry : {}),
      ...(merged[key] ?? {}),
      ...safeSyncedEntry,
    };
  }
  _metaCache = merged;
}

async function fetchSyncedMeta() {
  try {
    const res = await fetch("/portal/source-meta.json");
    if (res.ok) return await res.json();
  } catch {
    /* fall through to empty map; descriptor cache may still cover us */
  }
  return {};
}

async function fetchDescriptorMeta() {
  try {
    const res = await fetch("/admin/source-descriptors");
    if (!res.ok) return {};
    const body = await res.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    const out = {};
    for (const d of items) {
      if (!d?.id) continue;
      const declaredIcon = d.icon?.imageDataUri ?? null;
      const iconStr = isPortalSafeIcon(declaredIcon) ? declaredIcon : null;
      // We carry `unitName` through the same cache as icon/label so any
      // consumer that needs the human-friendly per-source unit ("emails",
      // "messages", "activities", …) reads it from the same provider-
      // declared source of truth — see `SourceDescriptor.unitName`. This
      // keeps source-specific labels owned by the provider package and
      // out of the agent UI code.
      if (!iconStr && !d.name && !d.unitName) continue;
      // Descriptor entries are keyed by sourceType, which `lookupMeta`
      // already uses as its second-chance lookup. Single-account synced
      // sources will have a sync_state entry under the same sourceType
      // and will mask this one via the spread above.
      out[d.id] = {};
      if (iconStr) out[d.id].icon = iconStr;
      if (d.name) out[d.id].label = d.name;
      if (d.unitName) out[d.id].unitName = d.unitName;
    }
    return out;
  } catch {
    /* portal may be loaded without a paired collector — descriptors
       are unavailable and the sync_state fallback still works */
    return {};
  }
}

/**
 * Re-fetch source metadata. Call after a flow that changes the registered
 * sources mid-session (Add Source / Remove Source / device pairing) so the
 * portal picks up the new icon without a hard refresh — closes
 * portal-source-icon-meta-cache-not-refreshed.
 */
export async function refreshSourceMeta() {
  await loadSourceMeta();
}

function lookupMeta(sourceId) {
  if (!sourceId || !_metaCache) return null;
  return _metaCache[sourceId] ?? _metaCache[sourceTypeOf(sourceId)] ?? null;
}

/**
 * Resolve just the icon URL / data URI for a source, without wrapping
 * it in an htm `<img>` template. Consumers that build their own DOM
 * (e.g. raw SVG renderers that need an `<image href="…">`) read this
 * directly. Returns null when no icon is registered for the source.
 */
export function sourceIconUrl(sourceId) {
  const meta = lookupMeta(sourceId);
  if (!meta) return null;
  return typeof meta === "string" ? meta : (meta.icon ?? null);
}

/**
 * True iff the meta cache currently resolves a real icon for this source
 * (a registered URL / data URI), as opposed to `sourceIcon` falling back
 * to the generic 📄 glyph. The Sources view uses this to detect a source
 * that appeared out-of-band — added via the iOS app, or registered by a
 * collector that paired after the portal loaded — so it can re-fetch the
 * meta cache mid-poll and render the right icon without a hard refresh.
 */
export function sourceIconResolves(sourceId) {
  return sourceIconUrl(sourceId) != null;
}

export function sourceIcon(sourceId, opts = {}) {
  const meta = lookupMeta(sourceId);
  const icon = meta ? (typeof meta === "string" ? meta : meta.icon) : null;
  if (icon) {
    const base = sourceTypeOf(sourceId);
    // `size` is an optional px override for callers that want a
    // smaller icon than the default 16px (e.g. inline previews on
    // dense list views like merge candidates). Inline style wins
    // over the .source-icon CSS rule.
    const sizeStyle = opts.size
      ? `width:${opts.size}px;height:${opts.size}px;border-radius:${Math.max(1, Math.round(opts.size / 6))}px;vertical-align:middle;`
      : "";
    // The gateway stores normalized raster data URIs; same-origin paths are
    // also accepted for gateway-owned assets.
    return html`<img class="source-icon" style=${sizeStyle} src=${icon} alt=${base} />`;
  }
  return "\uD83D\uDCC4";
}

export function sourceLabel(sourceId) {
  if (!sourceId) return "Unknown";
  const meta = lookupMeta(sourceId);
  if (meta && typeof meta === "object" && meta.label) return meta.label;
  const base = sourceTypeOf(sourceId);
  return base.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve the source-specific accent colour (Gmail red, WhatsApp green,
 * Drive yellow …) for tinting per-source UI elements like the citation
 * quote bar. Falls back to `null` when the provider hasn't published an
 * `accentColor` in its `defineSource()` descriptor — callers should
 * substitute the app accent token in that case.
 */
export function sourceAccentColor(sourceId) {
  const meta = lookupMeta(sourceId);
  if (meta && typeof meta === "object" && meta.accentColor) return meta.accentColor;
  return null;
}

/**
 * Resolve the human-friendly unit name for a source — provider-declared
 * via `SourceDescriptor.unitName` ("emails", "messages", "activities",
 * "sessions", …). Returns null when the descriptor hasn't been fetched
 * yet or the provider didn't declare one; callers fall back to a
 * generic noun. Keeping the lookup table provider-driven means adding
 * a new source automatically gets the right label everywhere.
 *
 * Pass the **sourceType** (descriptor id, e.g. "whatsapp-messages") —
 * NOT the full sourceId, whose account half ("whatsapp-messages:+44…")
 * matches no entry. Callers that have a DocRef should pass
 * `ref.sourceType`, which is already the descriptor id.
 */
export function sourceUnitName(sourceType) {
  if (!sourceType) return null;
  const meta = _metaCache?.[sourceType];
  if (meta && typeof meta === "object" && meta.unitName) return meta.unitName;
  return null;
}

export function docTypeLabel(type) {
  if (!type) return "";
  return type.charAt(0).toUpperCase() + type.slice(1);
}
