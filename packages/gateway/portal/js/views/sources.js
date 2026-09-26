// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Sources view — gateway-driven source management. Merges:
//   - GET /admin/sources       (registered sources, can be empty if user
//                                added everything via the legacy CLI add path;
//                                plus `pendingRemovals`, sources whose row is
//                                already gone but whose data is still being
//                                deleted)
//   - GET /admin/sync/status   (live sync state per source — populated as
//                                collectors emit sync.status events)
//   - GET /status              (per-source document counts, total, db size)
//   - GET /admin/devices       (so we can show the hosting device's name)
//
// Sources discovered via sync-status only (not in /admin/sources) are still
// fully usable: sync triggers route to whichever device emits events for
// that source (server-side fallback in deviceForSource).
//
// Actions:
//   - Sync       → POST /admin/sources/:id/sync
//   - Debug      → GET /admin/sources/:id/debug (drawer)
//   - Resync     → POST /admin/sources/:id/resync — wipes the source's data
//                  and syncs it again; with a `deviceId`, only that device's
//                  stream (partitioned) or cursor (replicated) is reset
//   - Remove     → DELETE /admin/sources/:id (only meaningful for registered;
//                  for discovered, surfaces a hint). Returns
//                  once the source has stopped; its data drains afterwards and
//                  the row stays visible as `removing` until it has.
//   - Join a device   → POST /admin/sources/:id/members
//   - Detach a device → DELETE /admin/sources/:id/members/:deviceId
//                  (both only for a source whose type lets several devices
//                  contribute; the Device cell then lists one line per member)

import { html } from "htm/preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import {
  getAdminSources,
  getAdminSyncStatus,
  getOverallStatus,
  getIndexStats,
  listDevices,
  triggerSourceSync,
  joinSourceMember,
  detachSourceMember,
  getSourceDebug,
  getSourceWatermark,
  resyncSource,
  removeAdminSource,
  pauseSource,
  resumeSource,
  getSourceDescriptorsUnion,
} from "../api.js";
import { sourceIcon, sourceLabel, refreshSourceMeta, sourceIconResolves } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { AddSourceModal } from "./add-source.js";
import { ExtensionPromoCard, shouldShowExtensionPromo } from "../components/extension-promo.js";
import { IosPromoCard } from "../components/ios-promo.js";
import { AndroidPromoCard } from "../components/android-promo.js";
import { shouldShowMobilePromos } from "../components/mobile-promo.js";
import { AgentPromoCard, useAgentPromoVisible } from "../components/agent-promo.js";
import { ExpiringBanner, ReauthBanner } from "./reauth-banner.js";
import { RemediationBanner } from "./remediation-banner.js";
import { OverviewBar, PctBar, MigrationBar } from "../components/index-hero.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { MemberPickerModal } from "../components/member-picker-modal.js";
import { joinCandidates } from "../lib/join-candidates.js";
import { ImportHistoryModal } from "../components/import-history-modal.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { KindIcon } from "../lib/device-kind-icon.js";
import { SourceNoticeIcons, noticesForDevice } from "../components/source-notices.js";

const REFRESH_MS = 2000;
// How long the "Sync sent to …" note stays on a row after a manual sync.
const SYNC_NOTE_MS = 6000;

// Display state comes pre-mapped from /admin/sync/status (idle / syncing /
// synced / error / paused / needs-auth) — kept in sync with the CLI by the gateway.

function fmtDateShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${dd}/${yy}`;
}

function fmtTime(ms, now = Date.now()) {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtTimeIso(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return fmtTime(ms);
}

function fmtNumber(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}


export function pluralizeUnit(unit, n) {
  if (!unit) return "";
  if (n === 1) {
    if (unit.endsWith("ies")) return `${unit.slice(0, -3)}y`;
    if (unit.endsWith("sses")) return unit.slice(0, -2);
    if (unit.endsWith("s") && !unit.endsWith("ss")) return unit.slice(0, -1);
    return unit;
  }
  // Descriptors conventionally provide plural nouns, while generic fallbacks
  // may still be singular (doc/visit/activity/session/page).
  if (unit.endsWith("s") || unit.endsWith("y"))
    return unit.endsWith("y") ? `${unit.slice(0, -1)}ies` : unit;
  return `${unit}s`;
}

export function sourceCanManualSync(source) {
  return !source?.pushBased;
}

export function resolveSourceDisplayCount({ documents, units, analytics, primaryCount }) {
  if (primaryCount === "documents") return documents;
  if (primaryCount === "analytics") {
    return typeof analytics === "number" && Number.isFinite(analytics) && analytics >= 0
      ? analytics
      : documents;
  }
  return typeof units === "number" && units > 0 && units !== documents
    ? units
    : typeof analytics === "number" && analytics > 0
      ? analytics
      : documents;
}

/**
 * The per-row action menu. Membership actions appear only for a source whose
 * type lets several devices contribute (`multiDevice`); an exclusive source
 * has exactly one host and offers neither. "Resync" becomes "Resync…" when a
 * choice follows — the resync can be scoped to one member (`resyncPerDevice`),
 * so a picker headed by the whole source opens first.
 */
export function sourceActionMenuItems({
  paused = false,
  canManualSync = true,
  canImport = false,
  importLabel,
  multiDevice = false,
  canJoin = false,
  canDetach = false,
  resyncPerDevice = false,
  internal = false,
} = {}) {
  // Gateway-internal sources (a dataset the gateway hosts itself) have no sync engine,
  // no registration and no device to act on — the only meaningful action is
  // opening their recent documents. Document deletion lives on that page.
  if (internal) return [{ action: "recent", label: "See recent" }];
  return [
    { action: "recent", label: "See recent" },
    ...(canManualSync ? [{ action: "sync", label: "Sync", disabled: paused }] : []),
    { action: "pause-toggle", label: paused ? "Resume sync" : "Pause sync (keep data)" },
    ...(multiDevice
      ? [
          { action: "join-member", label: "Join a device…", disabled: !canJoin },
          { action: "detach-member", label: "Detach a device…", disabled: !canDetach },
        ]
      : []),
    { action: "debug", label: "Debug" },
    ...(canManualSync
      ? [{ action: "resync", label: resyncPerDevice ? "Resync…" : "Resync" }]
      : []),
    ...(canImport ? [{ action: "import-history", label: importLabel || "Import full history" }] : []),
    { action: "remove", label: "Remove", danger: true },
  ];
}

export function sourcesErrorReducer(state, event) {
  switch (event.type) {
    case "refresh-succeeded":
      return { ...state, refresh: null };
    case "refresh-failed":
      return { ...state, refresh: event.message };
    case "action-started":
      return { ...state, action: null };
    case "action-failed":
      return { ...state, action: event.message };
    default:
      return state;
  }
}

/**
 * The status of one member of `source`, from its own sync row when the
 * gateway reports one. `syncStatus.members` exists only once more than one
 * device has a row; before that the aggregate status belongs to the single
 * device it names.
 */
function memberSyncStatus(syncStatus, deviceId) {
  if (!syncStatus) return null;
  const own = syncStatus.members?.find((m) => m.deviceId === deviceId);
  if (own) return own;
  if (!syncStatus.members && syncStatus.deviceId === deviceId) return syncStatus;
  return null;
}

export function wholeSourceRemovalBody(s) {
  return `Remove the whole source ${s.id} for every device, including offline members. All managed gateway data for this source will be deleted in the background. Re-add is blocked until cleanup completes. Originals on the provider or phone, retained backups and exported copies are not deleted. This is not physical secure erasure.`;
}

export function memberDetachBody(s, d) {
  const effect = s.multiDeviceMode === "partitioned"
    ? `Delete ${d.name}'s managed gateway contribution to ${s.id}. Other members' data stays. Originals, backups and exports are not deleted; this is not physical secure erasure.`
    : `${d.name} stops contributing to ${s.id}. Shared indexed data stays; if the source is partitioned when the gateway handles the request, this device’s contribution is deleted. Other members’ data stays. Originals, backups and exports are not deleted; this is not physical secure erasure.`;
  return `${effect} If this device owns the source, ownership passes to a remaining member. The gateway checks current membership: the last member cannot detach. An offline device learns the change when it reconnects.`;
}

/**
 * One line per member device — name, kind and a short status word — for the
 * Device cell of a source several devices contribute to. The status reads,
 * in priority order: "syncing now", "needs sign-in", "error", "synced <ago>",
 * "offline", "standby" (a handoff member waiting its turn), "idle". The
 * device syncing a handoff source is simply the one whose line says it is
 * syncing or has synced; no other marker singles it out.
 *
 * Pure: `now` is the clock the relative times are measured against.
 */
export function buildMemberLines(source, deviceById, syncStatus, now = Date.now()) {
  const members = source?.members?.length ? source.members : source?.deviceId ? [source.deviceId] : [];
  const handoff = source?.multiDeviceMode === "handoff";
  return members.map((deviceId) => {
    const device = deviceById?.get(deviceId);
    const status = memberSyncStatus(syncStatus, deviceId);
    const lastSyncMs = status?.lastSyncAt ? Date.parse(status.lastSyncAt) : NaN;
    let label;
    let tone;
    if (status?.state === "syncing") {
      label = "syncing now";
      tone = "syncing";
    } else if (status?.state === "needs-auth") {
      label = "needs sign-in";
      tone = "warn";
    } else if (status?.state === "error" && status.remediation) {
      // The failure named its remedy; the banner above carries the steps.
      label = "needs access";
      tone = "warn";
    } else if (status?.state === "error") {
      label = "error";
      tone = "error";
    } else if (!Number.isNaN(lastSyncMs)) {
      label = `synced ${fmtTime(lastSyncMs, now)}`;
      tone = "muted";
    } else if (device && device.online === false) {
      label = "offline";
      tone = "muted";
    } else if (handoff && source.leaseHolder && source.leaseHolder !== deviceId) {
      label = "standby";
      tone = "muted";
    } else {
      label = "idle";
      tone = "muted";
    }
    return {
      deviceId,
      name: device?.name ?? deviceId.slice(0, 8),
      kind: device?.kind ?? null,
      online: device?.online ?? null,
      label,
      tone,
      notices: noticesForDevice(syncStatus, deviceId),
    };
  });
}

/**
 * The note a row shows after a manual sync, naming the device(s) the sync
 * went to and what they did with it. A single-target sync answers
 * `{ deviceId, result }`, where `result` is that device's own answer — a
 * device that accepted the command but started nothing skipped it, because
 * the source was already syncing or is paused there. A fan-out answers
 * `{ results: [{ deviceId, ok, error? }] }`, and the failed members are
 * named after the ones that accepted.
 */
export function syncTargetNote(response, deviceById) {
  const nameOf = (id) => deviceById?.get(id)?.name ?? (id ? id.slice(0, 8) : "device");
  const results = response?.results;
  if (!Array.isArray(results)) {
    const target = response?.deviceId ? nameOf(response.deviceId) : null;
    if (response?.result?.triggered === 0) {
      const where = target ?? "the device";
      return (response.result.disabled ?? 0) > 0
        ? `Sync skipped; the source is paused on ${where}`
        : `Sync skipped; ${where} was already syncing`;
    }
    return target ? `Sync sent to ${target}` : "Sync sent";
  }
  // A member that accepted the command but triggered nothing (the source is
  // disabled or already syncing there) was skipped, not synced.
  const sent = results.filter((r) => r.ok && (r.triggered ?? 1) > 0);
  const skipped = results.filter((r) => r.ok && (r.triggered ?? 1) === 0);
  const failed = results.filter((r) => !r.ok);
  const names = (list) => list.map((r) => nameOf(r.deviceId)).join(", ");
  const failures = failed
    .map((r) => `${nameOf(r.deviceId)}${r.error ? ` (${r.error})` : ""}`)
    .join(", ");
  const tails = [
    skipped.length > 0 ? `${names(skipped)} skipped` : "",
    failed.length > 0 ? `failed on ${failures}` : "",
  ].filter(Boolean);
  if (sent.length === 0) {
    if (failed.length === 0 && skipped.length === 0) return "Sync sent";
    return failed.length === 0 ? `Sync skipped on ${names(skipped)}` : `Sync failed on ${failures}`;
  }
  const head =
    sent.length === 1
      ? `Sync sent to ${nameOf(sent[0].deviceId)}`
      : `Sync sent to ${sent.length} devices`;
  return tails.length === 0 ? head : `${head}; ${tails.join("; ")}`;
}

/**
 * The notes rows show after a manual sync, keyed by source id as
 * `{ text, until }`. `show` posts a note due to lapse at `until`; `expire`
 * drops a note only when it names that same deadline, so a note re-shown
 * while an earlier expiry was still pending outlives the earlier timer.
 */
export function syncNotesReducer(state, event) {
  switch (event.type) {
    case "show":
      return { ...state, [event.sourceId]: { text: event.text, until: event.until } };
    case "expire": {
      if (state[event.sourceId]?.until !== event.until) return state;
      const next = { ...state };
      delete next[event.sourceId];
      return next;
    }
    default:
      return state;
  }
}

/**
 * The picker entry that resyncs every member's data at once, listed ahead of
 * the members when a resync can be scoped to one device.
 */
export const RESYNC_WHOLE_SOURCE = "whole-source";

/**
 * How a resync of `source` is offered:
 *   - "single": one member — the plain confirmation, the whole source is wiped.
 *   - "whole": several members that share one cursor (handoff) — the same
 *     plain confirmation; there is no per-device slice to reset.
 *   - "per-device": several members on their own cursors (replicated or
 *     partitioned) — a picker of the members, headed by the whole source.
 */
export function resyncChoices(source) {
  if ((source?.members?.length ?? 1) <= 1) return "single";
  const mode = source?.multiDeviceMode ?? "exclusive";
  return mode === "replicated" || mode === "partitioned" ? "per-device" : "whole";
}

/**
 * The note a row shows after a resync, from the route's answer: what each
 * member did with the sync command — started it (`deviceIds`), is restarting
 * the one it had in flight (`restarting`), was already syncing and skipped
 * it (`skipped`), or has the source paused and re-syncs it once resumed
 * (`disabled`) — and, when only one device's slice was reset (`scope`
 * "stream" or "cursor"), what that reset kept. No member in any list means
 * none was online to take the command; the sync waits for one.
 */
export function resyncNote(response, deviceById) {
  const nameOf = (id) => deviceById?.get(id)?.name ?? (id ? id.slice(0, 8) : "device");
  const list = (key) => (Array.isArray(response?.[key]) ? response[key] : []);
  const sent = list("deviceIds");
  const restarting = list("restarting");
  const skipped = list("skipped");
  const disabled = list("disabled");
  if (sent.length + restarting.length + skipped.length + disabled.length === 0) {
    return "Resync queued; no member is online";
  }
  const names = (ids) => (ids.length === 1 ? nameOf(ids[0]) : `${ids.length} devices`);
  const verdicts = [
    sent.length > 0 ? `sent to ${names(sent)}` : "",
    restarting.length > 0 ? `restarting the sync in flight on ${names(restarting)}` : "",
    skipped.length > 0
      ? `${names(skipped)} ${skipped.length === 1 ? "was" : "were"} already syncing`
      : "",
    disabled.length > 0
      ? `the source is paused on ${names(disabled)}; it re-syncs when resumed`
      : "",
  ].filter(Boolean);
  let head;
  if (sent.length > 0 || restarting.length > 0) head = `Resync ${verdicts.join("; ")}`;
  else if (skipped.length > 0) head = `Resync skipped; ${verdicts.join("; ")}`;
  // Only paused members answered: the sync waits, as it does for an offline one.
  else head = `Resync queued; ${verdicts.join("; ")}`;
  switch (response.scope) {
    case "stream":
      return `${head}; its contribution was removed first`;
    case "cursor":
      return `${head}; nothing was deleted`;
    default:
      return head;
  }
}

/**
 * Rows for sources whose removal has been accepted but whose data is still
 * being purged. The `sources` row is gone, so there is no device and no sync
 * state to report and the renderer keys off `removing` instead. Counts are
 * deliberately left for the shared enrichment pass to fill from `/status`:
 * they are still real, and watching them fall is how the purge shows progress.
 */
export function buildRemovalRows(pendingRemovals) {
  return (pendingRemovals || []).map((p) => ({
    id: p.id,
    type: p.type,
    accountId: p.accountId,
    deviceId: null,
    deviceName: null,
    deviceKind: null,
    members: [],
    multiDeviceMode: "exclusive",
    leaseHolder: null,
    enabled: true,
    pushBased: false,
    registered: false,
    discoveredOnly: false,
    removing: true,
    syncStatus: null,
  }));
}

/**
 * Add a row for each source that is being removed, unless one of that id is
 * already live. A live row always wins: re-registering a source cancels the
 * rest of its purge, so when both appear the tombstone is the stale half.
 *
 * Mutates and returns `byId` so it composes with the rest of the merge.
 */
export function mergeRemovalRows(byId, pendingRemovals) {
  for (const row of buildRemovalRows(pendingRemovals)) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return byId;
}

/**
 * Whether the legacy collector.json migration banner applies: no source
 * registered with the gateway, but at least one live registered row.
 * Gateway-internal rows never count — a fresh install whose only entry
 * is the Notes source must not see a migration prompt.
 */
export function showLegacyMigrationBanner(overall, sources) {
  return (
    !!overall &&
    overall.registeredCount === 0 &&
    (sources ?? []).some((s) => !s.removing && !s.internal)
  );
}

/**
 * Rows for gateway-internal sources (a dataset the gateway hosts itself):
 * no collector, no sync state to report and no device to name. They carry
 * the same enrichment fields as a registered row so the shared count /
 * indexing / activity pass fills them from `/status` and `/index/stats`
 * unchanged; the action menu is gated separately via the `internal` flag.
 * A registered row of the same id always wins — an internal id must never
 * shadow a real registration.
 */
export function buildInternalRows(internalSources) {
  if (!Array.isArray(internalSources)) return [];
  // Type and account fall back to the id itself, matching the native
  // clients: internal sources have no descriptor or provider account, so
  // the id is the only stable key for label/icon/count lookups.
  return internalSources.filter((s) => s && typeof s.id === "string" && s.id.length > 0).map((s) => ({
    id: s.id,
    type: s.id,
    accountId: s.id,
    deviceId: null,
    deviceName: "Gateway",
    deviceKind: null,
    members: [],
    multiDeviceMode: "exclusive",
    leaseHolder: null,
    enabled: true,
    pushBased: false,
    registered: false,
    discoveredOnly: false,
    removing: false,
    internal: true,
    syncStatus: null,
  }));
}

/**
 * Add a row for each advertised internal source, unless a registered row of
 * that id already exists. Mutates and returns `byId` so it composes with
 * the rest of the merge; call before the sync-status attach + enrichment
 * passes so internal rows get their counts like every other row.
 */
export function mergeInternalRows(byId, internalSources) {
  for (const row of buildInternalRows(internalSources)) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return byId;
}

/**
 * The glyph of the picker's "Whole source" entry: three stacked bars, one
 * per contributing device, drawn on the same 16×16 grid as the device-kind
 * glyphs so it lines up with the member entries below it.
 */
function WholeSourceIcon() {
  return html`<svg
    aria-hidden="true"
    class="member-picker-item-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  ><rect x="2" y="2" width="12" height="3" rx="0.8"/><rect x="2" y="6.5" width="12" height="3" rx="0.8"/><rect x="2" y="11" width="12" height="3" rx="0.8"/></svg>`;
}

function StatePill({ state }) {
  // Render label: needs-auth + rate-limited surface with more readable text
  // and distinct CSS classes (warn-yellow / info-blue). Other states are
  // shown verbatim — they already match what humans expect.
  const label =
    state === "needs-auth"
      ? "needs auth"
      : state === "rate-limited"
        ? "rate limited"
        : state === "auth-expiring"
          ? "expiring"
          : state;
  return html`<span class=${`sources-state state-${state}`}>${label}</span>`;
}


/**
 * Whether a poll's rows need the icon meta cache re-fetched, and the synced
 * source ids the cache then reflects.
 *
 * The cache is loaded at startup and after the in-portal Add Source flow, so
 * two kinds of row can outrun it. One the cache cannot resolve at all — added
 * from a phone, or registered by a collector that paired after the portal
 * loaded — would show the generic 📄 fallback. One that resolves only to its
 * source type's icon may be about to gain its own: a per-account icon (a
 * bank's logo under an aggregator) is recorded on its first sync, after Add
 * Source has already refreshed the cache, and the type icon it resolves to
 * meanwhile would otherwise stand until a reload. So a source seen synced
 * for the first time re-fetches once, and steady-state polls never do.
 *
 * Internal rows are excluded: their icons come from the boot-seeded
 * sync_state meta, never from a collector descriptor, so a missing icon
 * there means "seed hasn't landed yet" — without the filter every poll would
 * re-fetch meta forever.
 */
export function sourceMetaRefresh(rows, coveredSynced, resolves = sourceIconResolves) {
  const external = rows.filter((row) => !row.internal);
  const synced = external.filter((row) => row.syncStatus?.lastSyncAt).map((row) => row.id);
  const unresolved = external.some((row) => !resolves(row.id));
  const newlySynced = coveredSynced !== null && synced.some((id) => !coveredSynced.has(id));
  return { refresh: unresolved || newlySynced, covered: new Set(synced) };
}

export function SourcesView() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const agentPromoVisible = useAgentPromoVisible();
  const [errors, dispatchError] = useReducer(sourcesErrorReducer, {
    refresh: null,
    action: null,
  });
  const [overall, setOverall] = useState(null);
  const [indexStats, setIndexStats] = useState(null);
  const [busy, setBusy] = useState({}); // sourceId → action being performed
  const [drawer, setDrawer] = useState(null); // { sourceId, debug?, error? }
  const [showAdd, setShowAdd] = useState(false);
  const [confirmState, setConfirmState] = useState(null); // { title, body, confirmLabel, danger, onConfirm } | null
  // sourceType → historyImport spec, for sources that support a one-time
  // backup/artifact import. Drives the "Import full history" action.
  const [importSpecByType, setImportSpecByType] = useState({});
  const [importState, setImportState] = useState(null); // { sourceId, spec } | null
  // Every device the gateway knows, so a row can name its members and offer
  // the ones that could join.
  const [devices, setDevices] = useState([]);
  // { sourceId, action: "join" | "detach" | "resync" } | null — the row is
  // looked up on every render so the picker follows the polled membership.
  const [memberPicker, setMemberPicker] = useState(null);
  // sourceId → { text, until }: "Sync sent to …" / "Resync sent to …", kept
  // for SYNC_NOTE_MS.
  const [syncNotes, dispatchSyncNote] = useReducer(syncNotesReducer, {});
  const syncNoteTimers = useRef(new Map());
  const refreshing = useRef(false);
  // Synced source ids the icon meta cache already reflects; null until the
  // first poll, whose rows the startup load covers.
  const metaCoveredSynced = useRef(null);

  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [registeredRes, syncRes, statusRes, devicesRes, indexRes, descriptorsRes] =
        await Promise.all([
          getAdminSources(),
          getAdminSyncStatus(),
          getOverallStatus(),
          listDevices().catch(() => ({ items: [] })),
          getIndexStats().catch(() => null),
          getSourceDescriptorsUnion().catch(() => ({ items: [] })),
        ]);

      // Map sourceType → historyImport spec for sources that advertise the
      // generic one-time-import capability. Empty when no collector is
      // online, in which case the action simply doesn't appear.
      const importSpecs = {};
      // Per-type descriptor signals used by the Count column: the headline
      // count plane and the unit noun (so gateway-hosted sources with
      // a descriptor but no collector sync.status — e.g. `web` — still read
      // "web pages", not the generic "docs"). Gateway-internal sources such
      // as `omnesis-notes` have no descriptor at all, so they keep the
      // generic noun.
      const primaryCountByType = {};
      const descriptorUnitByType = {};
      for (const d of descriptorsRes.items || []) {
        if (d.historyImport) importSpecs[d.id] = d.historyImport;
        if (d.primaryCount) primaryCountByType[d.id] = d.primaryCount;
        if (d.unitName) descriptorUnitByType[d.id] = d.unitName;
      }
      setImportSpecByType(importSpecs);

      const registered = registeredRes.items || [];
      const pendingRemovals = registeredRes.pendingRemovals || [];
      const internalSources = registeredRes.internalSources || [];
      const statuses = syncRes.items || [];
      const status = statusRes || {};
      const devices = devicesRes.items || [];
      const deviceById = new Map(devices.map((d) => [d.id, d]));

      // Merge: union of source IDs from /admin/sources and /admin/sync/status.
      const byId = new Map();

      for (const r of registered) {
        byId.set(r.id, {
          id: r.id,
          type: r.type,
          accountId: r.accountId,
          deviceId: r.deviceId,
          deviceName: deviceById.get(r.deviceId)?.name ?? r.deviceId.slice(0, 8),
          deviceKind: deviceById.get(r.deviceId)?.kind ?? null,
          // Owner first. A source the gateway reports no membership for has
          // exactly its owner.
          members: Array.isArray(r.members) && r.members.length > 0 ? r.members : [r.deviceId],
          multiDeviceMode: r.multiDeviceMode ?? "exclusive",
          leaseHolder: r.leaseHolder ?? null,
          // Device ids the gateway admits as new members; absent on a
          // gateway that does not report them (see joinCandidates()).
          joinCandidates: Array.isArray(r.joinCandidates) ? r.joinCandidates : undefined,
          enabled: r.enabled,
          pushBased: !!r.pushBased,
          registered: true,
          discoveredOnly: false,
          syncStatus: null,
        });
      }

      mergeRemovalRows(byId, pendingRemovals);
      mergeInternalRows(byId, internalSources);

      for (const s of statuses) {
        const existing = byId.get(s.sourceId);
        if (existing) {
          existing.syncStatus = s;
        }
        // Sources present in /admin/sync/status but NOT in /admin/sources
        // are "orphan" drift — a removed source whose collector is still
        // syncing it. We deliberately don't surface them as rows (would
        // confuse "is this source active?"). The real fix is to make sure
        // the collector applies `source.removed` / `sources.snapshot`
        // reconciliation. If you see an orphan here, restart
        // the collector to let applySourcesSnapshot clean it up.
      }

      // Count priority mirrors CLI status. A source can override the heuristic
      // via its descriptor's `primaryCount`:
      //   - primaryCount "documents" → always the document total (e.g. `web`,
      //     whose tiny page_visits log must not shadow its page count).
      //   - primaryCount "analytics" → always the analytics row count.
      // Otherwise the heuristic decides:
      //   1. totalUnitCount when it differs from doc count (WhatsApp bundles
      //      many messages per daily doc; browser-history daily digests).
      //   2. analyticsCount for pure-structured sources (screen-time, strava)
      //      keyed by source TYPE.
      //   3. documentCount — everything else (gmail, calendar, etc.).
      const docCounts = status.documents?.bySource ?? {};
      const unitCounts = status.documents?.unitCountBySource ?? {};
      const analyticsByType = status.analyticsCountByType ?? {};
      const latestActivityBySource = status.latestActivityBySource ?? {};
      const indexBySource = indexRes?.bySource ?? {};
      const indexerEnabled = indexRes?.enabled !== false;
      for (const row of byId.values()) {
        const docs = docCounts[row.id] ?? 0;
        const units = unitCounts[row.id];
        const analyticsById = analyticsByType[row.id];
        const analyticsByTypeOnly = analyticsByType[row.type];
        const analytics = analyticsById ?? analyticsByTypeOnly;
        row.documentCount = docs;
        const primaryCount = primaryCountByType[row.type];
        // Descriptor unit noun falls back here for sources with no collector
        // sync.status (e.g. the gateway-internal `web`).
        row.unitName = row.syncStatus?.unitName ?? descriptorUnitByType[row.type] ?? null;
        row.displayCount = resolveSourceDisplayCount({
          documents: docs,
          units,
          analytics,
          primaryCount,
        });
        const idx = indexBySource[row.id];
        const gatewayDocs = idx?.gatewayDocs ?? docs;
        row.latestActivity = latestActivityBySource[row.id] ?? null;
        row.indexedDocs = idx?.indexedDocs ?? null;
        row.gatewayIndexedDocs = idx?.gatewayDocs ?? null;
        row.indexErrors = idx?.indexErrors ?? 0;
        row.degradedDocs = idx?.degradedDocs ?? 0;
        row.truncatedChunks = idx?.truncatedChunks ?? 0;
        row.droppedChunks = idx?.droppedChunks ?? 0;
        row.earliestIndexedDate = idx?.earliestIndexedDate ?? null;
        row.latestIndexedDate = idx?.latestIndexedDate ?? null;
        if (!indexerEnabled) {
          // Indexer off — no percentage makes sense for any source.
          row.indexed = null;
          row.indexNote = "Indexer is disabled";
        } else if (gatewayDocs === 0) {
          // Nothing to index. Two sub-cases:
          //   - source produces only structured analytics records (screen-time,
          //     strava, apple-health) → displayCount > 0 from DuckDB rows.
          //   - source hasn't synced yet / has no data → displayCount === 0.
          row.indexed = null;
          row.indexNote = (row.displayCount ?? 0) > 0
            ? "This source only produces structured analytics records — no text documents to index"
            : "No documents yet to index";
        } else if (idx && typeof idx.percentIndexed === "number") {
          row.indexed = Math.min(idx.percentIndexed, 100);
        } else {
          row.indexed = null;
        }
      }

      // Stable alphabetical order by source id. Previously this pushed
      // error / syncing rows to the top, which made a live table jump
      // around whenever a sync kicked off — losing track of which row
      // you were looking at. State is already surfaced via the coloured
      // pill and the dedicated state counts in the header; row order
      // should stay predictable.
      const merged = Array.from(byId.values()).sort((a, b) => {
        return a.id.localeCompare(b.id);
      });

      const metaRefresh = sourceMetaRefresh(merged, metaCoveredSynced.current);
      metaCoveredSynced.current = metaRefresh.covered;
      if (metaRefresh.refresh) await refreshSourceMeta();

      setSources(merged);
      setDevices(devices);
      setOverall({
        totalDocs: status.documents?.total ?? 0,
        index: status.index ?? null,
        dbSizeBytes: status.dbSizeBytes ?? null,
        diskUsage: status.diskUsage ?? null,
        registeredCount: registered.length,
      });
      setIndexStats(indexRes ?? null);
      dispatchError({ type: "refresh-succeeded" });
    } catch (e) {
      dispatchError({ type: "refresh-failed", message: String(e.message || e) });
    } finally {
      setLoading(false);
      refreshing.current = false;
    }
  }

  useEffect(() => {
    refresh();
    const timers = syncNoteTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);
  useVisiblePoll(refresh, REFRESH_MS);

  const deviceById = new Map(devices.map((d) => [d.id, d]));

  async function withBusy(sourceId, action, fn) {
    setBusy((b) => ({ ...b, [sourceId]: action }));
    dispatchError({ type: "action-started" });
    try {
      await fn();
    } catch (e) {
      // The gateway's own sentence when it sent one, else the request line.
      dispatchError({ type: "action-failed", message: String(e.serverMessage || e.message || e) });
    }
    setBusy((b) => {
      const next = { ...b };
      delete next[sourceId];
      return next;
    });
    refresh();
  }

  function showSyncNote(sourceId, text) {
    const until = Date.now() + SYNC_NOTE_MS;
    dispatchSyncNote({ type: "show", sourceId, text, until });
    const timers = syncNoteTimers.current;
    clearTimeout(timers.get(sourceId));
    timers.set(
      sourceId,
      setTimeout(() => {
        timers.delete(sourceId);
        dispatchSyncNote({ type: "expire", sourceId, until });
      }, SYNC_NOTE_MS),
    );
  }

  async function handleSync(s) {
    return withBusy(s.id, "syncing", async () => {
      const response = await triggerSourceSync(s.id);
      showSyncNote(s.id, syncTargetNote(response, deviceById));
    });
  }

  function handleJoinMember(s) {
    setMemberPicker({ sourceId: s.id, action: "join" });
  }

  function handleDetachMember(s) {
    setMemberPicker({ sourceId: s.id, action: "detach" });
  }

  // The row the member picker is about, as the latest poll reports it. Null
  // once the source is gone, which closes the picker below.
  const pickerSource = memberPicker
    ? (sources.find((s) => s.id === memberPicker.sourceId && !s.removing) ?? null)
    : null;
  useEffect(() => {
    if (memberPicker && !pickerSource) setMemberPicker(null);
  }, [memberPicker, pickerSource]);

  function confirmMemberPick(deviceId) {
    const { sourceId, action } = memberPicker;
    setMemberPicker(null);
    switch (action) {
      case "join":
        return withBusy(sourceId, "joining", () => joinSourceMember(sourceId, deviceId));
      case "detach":
        return withBusy(sourceId, "detaching", () => detachSourceMember(sourceId, deviceId));
      case "resync":
        return runResync(sourceId, deviceId === RESYNC_WHOLE_SOURCE ? undefined : deviceId);
      default:
        return undefined;
    }
  }

  function runResync(sourceId, deviceId) {
    return withBusy(sourceId, "resyncing", async () => {
      const response = await resyncSource(sourceId, deviceId);
      showSyncNote(sourceId, resyncNote(response, deviceById));
    });
  }

  // The warning for wiping every member's data, worded the same whether it
  // is the plain confirmation or the "Whole source" entry of the picker.
  const wholeSourceResyncBody = (s) =>
    `All ingested documents for ${s.id} will be deleted and re-fetched from scratch. This can take a while for large sources.`;

  async function handleResync(s) {
    if (resyncChoices(s) === "per-device") {
      setMemberPicker({ sourceId: s.id, action: "resync" });
      return;
    }
    setConfirmState({
      title: `Resync ${sourceLabel(s.id)}?`,
      body: wholeSourceResyncBody(s),
      confirmLabel: "Resync",
      danger: true,
      onConfirm: () => runResync(s.id),
    });
  }

  async function handleRemove(s) {
    const body = wholeSourceRemovalBody(s);
    setConfirmState({
      title: `Remove ${sourceLabel(s.id)}?`,
      body,
      confirmLabel: "Remove whole source",
      danger: true,
      // One call: the gateway stops the source and then purges its data in
      // the background, reporting it in `pendingRemovals` until that finishes.
      // The row keeps rendering from there, so there is nothing to wait on here.
      onConfirm: () => withBusy(s.id, "removing", () => removeAdminSource(s.id)),
    });
  }

  async function handleDebug(s) {
    setDrawer({ sourceId: s.id, loading: true });
    const [debugResult, watermarkResult] = await Promise.allSettled([
      getSourceDebug(s.id),
      getSourceWatermark(s.id),
    ]);
    if (debugResult.status === "rejected" && watermarkResult.status === "rejected") {
      setDrawer({ sourceId: s.id, error: String(debugResult.reason?.message || debugResult.reason) });
      return;
    }
    setDrawer({
      sourceId: s.id,
      debug: debugResult.status === "fulfilled" ? debugResult.value : null,
      debugError: debugResult.status === "rejected" ? String(debugResult.reason?.message || debugResult.reason) : null,
      watermark: watermarkResult.status === "fulfilled" ? watermarkResult.value.items[0] ?? null : null,
      watermarkError:
        watermarkResult.status === "rejected"
          ? String(watermarkResult.reason?.message || watermarkResult.reason)
          : null,
    });
  }

  async function handlePauseToggle(s) {
    const paused = !s.enabled;
    return withBusy(s.id, paused ? "resuming" : "pausing", () =>
      paused ? resumeSource(s.id) : pauseSource(s.id),
    );
  }

  function handleImportHistory(s, spec) {
    setImportState({ sourceId: s.id, spec });
  }

  const statesCount = sources.reduce((acc, s) => {
    const state = s.removing ? "removing" : (s.syncStatus?.state ?? "idle");
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});

  return html`
    <div class="sources-view-v2">
      <div class="sources-header-v2">
        <div>
          <h1>Sources</h1>
        </div>
        <div class="sources-header-right">
          <button class="btn-primary sources-add-btn" onClick=${() => setShowAdd(true)}>+ Add source</button>
        </div>
      </div>

      ${errors.action && html`
        <div class="sources-banner-v2 error sources-action-error" role="alert">
          ${errors.action}
        </div>
      `}
      ${errors.refresh && html`
        <div class="sources-banner-v2 error" role="alert">${errors.refresh}</div>
      `}

      <${ReauthBanner} sources=${sources} onReauthed=${refresh} />

      <${ExpiringBanner} sources=${sources} onReauthed=${refresh} />

      <${RemediationBanner} sources=${sources} deviceById=${deviceById} />

      ${indexStats && html`<${OverviewBar}
        stats=${indexStats}
        summary=${{
          // A source being removed is no longer one of your sources — it is
          // still listed only so its purge is visible. Counting it here would
          // make the headline disagree with what the list actually holds.
          totalSources: sources.filter((s) => !s.removing).length,
          syncing: statesCount.syncing ?? 0,
          errors: statesCount.error ?? 0,
          totalDocs: overall?.totalDocs ?? 0,
          dbSizeBytes: overall?.dbSizeBytes ?? null,
          diskUsage: overall?.diskUsage ?? null,
        }}
      />`}

      ${indexStats && html`<${MigrationBar} versions=${indexStats.indexVersions} />`}

      ${!loading
        && (shouldShowExtensionPromo({ sources }) || shouldShowMobilePromos({ sources }) || agentPromoVisible)
        && html`<div class="sources-promo-row">
          ${shouldShowExtensionPromo({ sources }) && html`<${ExtensionPromoCard} />`}
          ${shouldShowMobilePromos({ sources }) && html`<${IosPromoCard} /><${AndroidPromoCard} />`}
          ${agentPromoVisible && html`<${AgentPromoCard} />`}
        </div>`}

      ${showLegacyMigrationBanner(overall, sources) && html`
        <div class="sources-banner-v2 info">
          <strong>None of your sources are registered with the gateway yet.</strong>
          They were added via <code>${"npm run cli -- add <source>"}</code> which writes to <code>collector.json</code> directly. The gateway is the long-term source of truth.
          Sources still work; some actions (Remove) are limited.
        </div>
      `}



      ${loading
        ? html`<div class="sources-empty-v2">Loading…</div>`
        : sources.length === 0
          ? html`<div class="sources-empty-v2">
              <p>No sources yet.</p>
              <p class="dim">Click <strong>+ Add source</strong> above, or run <code>${"npm run cli -- add <source>"}</code>.</p>
            </div>`
          : html`
            <div class="sources-table-wrap-v2">
              <table class="sources-table-v2">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>State</th>
                    <th>Count</th>
                    <th>Indexing</th>
                    <th>Last sync</th>
                    <th>Last activity</th>
                    <th>Device</th>
                    <th class="sources-actions-col"></th>
                  </tr>
                </thead>
                <tbody>
                  ${sources.map((s) => {
                      const importSpec = importSpecByType[s.type];
                      return html`
                        <${SourceRow}
                          key=${s.id}
                          source=${s}
                          busy=${busy[s.id]}
                          importSpec=${importSpec}
                          deviceById=${deviceById}
                          joinable=${joinCandidates(s, devices).length > 0}
                          syncNote=${syncNotes[s.id]?.text}
                          onSync=${() => handleSync(s)}
                          onResync=${() => handleResync(s)}
                          onDebug=${() => handleDebug(s)}
                          onRemove=${() => handleRemove(s)}
                          onPauseToggle=${() => handlePauseToggle(s)}
                          onJoinMember=${() => handleJoinMember(s)}
                          onDetachMember=${() => handleDetachMember(s)}
                          onImportHistory=${importSpec ? () => handleImportHistory(s, importSpec) : null}
                          onRecent=${() => navigate(`/portal/sources/${encodeURIComponent(s.id)}/recent`)}
                        />
                      `;
                    })}
                </tbody>
              </table>
            </div>
          `}

      ${drawer && html`<${DebugDrawer} drawer=${drawer} onClose=${() => setDrawer(null)} />`}

      ${showAdd && html`<${AddSourceModal}
        onClose=${() => setShowAdd(false)}
        onAdded=${async () => {
          // Refresh behind the modal, which stays open on its own result
          // screen — that screen is where a join or a move says what the
          // device that gained the source still needs (its own sign-in).
          // Re-fetch the icon meta cache too, so the new source's icon
          // renders without a hard refresh — without this the row shows up
          // with the generic 📄 fallback until reload.
          await refreshSourceMeta();
          refresh();
        }}
      />`}

      <${ConfirmModal}
        open=${!!confirmState}
        title=${confirmState?.title}
        body=${confirmState?.body}
        confirmLabel=${confirmState?.confirmLabel}
        destructive=${!!confirmState?.danger}
        onCancel=${() => setConfirmState(null)}
        onConfirm=${async () => {
          const fn = confirmState?.onConfirm;
          setConfirmState(null);
          try { if (fn) await fn(); } catch (err) { console.error(err); }
        }}
      />

      ${pickerSource && (() => {
        const s = pickerSource;
        const { action } = memberPicker;
        const label = sourceLabel(s.id);
        if (action === "join") {
          const candidates = joinCandidates(s, devices).map((d) => ({
            id: d.id,
            name: d.name,
            kind: d.kind,
            hint: d.online ? null : "offline",
          }));
          return html`<${MemberPickerModal}
            key=${`join:${s.id}`}
            title=${`Join a device to ${label}`}
            body=${(d) => `${d.name} starts contributing to ${s.id} alongside its current device${s.members.length === 1 ? "" : "s"}.`}
            devices=${candidates}
            emptyText="No other device can host this source: every device that could is already a member."
            confirmLabel="Join"
            onConfirm=${confirmMemberPick}
            onCancel=${() => setMemberPicker(null)}
          />`;
        }
        const members = buildMemberLines(s, deviceById, s.syncStatus).map((m) => ({
          id: m.deviceId,
          name: m.name,
          kind: m.kind,
          hint: m.label,
        }));
        if (action === "resync") {
          const partitioned = s.multiDeviceMode === "partitioned";
          const whole = {
            id: RESYNC_WHOLE_SOURCE,
            name: "Whole source",
            kind: null,
            hint: "every member",
            icon: html`<${WholeSourceIcon} />`,
          };
          return html`<${MemberPickerModal}
            key=${`resync:${s.id}`}
            title=${`Resync ${label}`}
            body=${(d) =>
              d.id === RESYNC_WHOLE_SOURCE
                ? wholeSourceResyncBody(s)
                : partitioned
                  ? `${d.name} re-syncs ${s.id} from scratch; everything it contributed is removed first. The other members' data stays.`
                  : `${d.name} re-syncs ${s.id} from scratch; nothing is deleted.`}
            devices=${[whole, ...members]}
            confirmLabel="Resync"
            destructive=${(d) => d.id === RESYNC_WHOLE_SOURCE || partitioned}
            onConfirm=${confirmMemberPick}
            onCancel=${() => setMemberPicker(null)}
          />`;
        }
        return html`<${MemberPickerModal}
          key=${`detach:${s.id}`}
          title=${`Detach a device from ${label}`}
          body=${(d) => memberDetachBody(s, d)}
          devices=${members}
          confirmLabel=${s.multiDeviceMode === "partitioned" ? "Detach and delete device data" : "Detach device"}
          destructive
          onConfirm=${confirmMemberPick}
          onCancel=${() => setMemberPicker(null)}
        />`;
      })()}

      ${importState && html`<${ImportHistoryModal}
        sourceId=${importState.sourceId}
        spec=${importState.spec}
        onClose=${() => setImportState(null)}
        onComplete=${refresh}
      />`}
    </div>
  `;
}

function SourceRow({
  source: s,
  busy,
  importSpec,
  deviceById,
  joinable = false,
  syncNote,
  onSync,
  onResync,
  onDebug,
  onRemove,
  onPauseToggle,
  onJoinMember,
  onDetachMember,
  onImportHistory,
  onRecent,
}) {
  // The gateway has already collapsed in-memory + persisted state into a
  // canonical pill (idle / syncing / synced / error / paused / needs-auth),
  // so we render it as-is.
  // A removing source has no sync state to report — it has already stopped.
  // `removing` describes the purge that is still draining behind it.
  const state = s.removing ? "removing" : (s.syncStatus?.state ?? "idle");
  const progress = s.syncStatus?.progress;
  const lastSyncAt = s.syncStatus?.lastSyncAt;
  const canManualSync = sourceCanManualSync(s);
  const multiDevice = (s.multiDeviceMode ?? "exclusive") !== "exclusive";
  // Several members → one line each; a single host keeps the plain chip.
  const memberLines = multiDevice ? buildMemberLines(s, deviceById, s.syncStatus) : [];

  return html`
    <tr class=${`source-row-v2 state-${state}`}>
      <td>
        <div class="source-cell-name-v2">
          <span class="source-icon-wrap">${sourceIcon(s.id)}</span>
          <div class="source-cell-name-text">
            <span class="source-display-name">${sourceLabel(s.id)}</span>
            <span class="source-id-inline"><code>${s.id}</code></span>
            ${s.discoveredOnly && html`<span class="source-discovered-tag" title="Discovered via sync.status only — not in /admin/sources">discovered</span>`}
            ${!s.enabled && html`<span class="source-paused-tag">paused</span>`}
          </div>
        </div>
      </td>
      <td>
        <${StatePill} state=${state} />
        ${s.removing && html`
          <div class="source-removing-line" title="Removal is durable — the source has already stopped syncing. Deleting what it ingested runs in the background and is queued behind indexing, so on a large source it can take several minutes.">
            deleting all source data; re-add after cleanup…
          </div>
        `}
        ${state === "syncing" && progress?.processed != null
          && (progress.total != null || progress.processed > 0)
          && html`
          <div class="source-progress">
            ${progress.total != null
              ? (() => {
                  // Bar shows visual progress; text renders alongside so
                  // big counts (`10/146246`, `7/486192`) aren't clipped by
                  // the bar's fixed width like they would be if the label
                  // lived inside the bar.
                  const pct = Math.max(0, Math.min(100, (progress.processed / progress.total) * 100));
                  const tone = pct >= 100 ? "ok" : pct > 0 ? "partial" : "zero";
                  return html`
                    <div class="index-pctbar ${tone}" title=${`${Math.round(pct)}% (${progress.processed}/${progress.total})`}>
                      <div class="index-pctbar-fill" style=${`width: ${pct}%`}></div>
                    </div>
                    <span class="source-progress-text">${progress.processed}/${progress.total}</span>
                  `;
                })()
              : html`<span>${progress.processed} processed</span>`}
          </div>
        `}
      </td>
      <td class="source-num">
        ${fmtNumber(s.displayCount ?? s.documentCount)}
        <span class="source-unit">${pluralizeUnit(s.unitName ?? s.syncStatus?.unitName ?? "doc", s.displayCount ?? s.documentCount)}</span>
      </td>
      <td class="source-progress-cell"><${ProgressCell} source=${s} /></td>
      <td class="source-time">${fmtTimeIso(lastSyncAt)}</td>
      <td class="source-activity-cell"><${ActivityCell} activity=${s.latestActivity} /></td>
      <td>
        ${s.removing
          ? html`<span class="source-device-none">—</span>`
          : memberLines.length > 1
            ? html`<div class="source-device-members">
                ${memberLines.map(
                  (m) => html`
                    <div class="source-device-member" key=${m.deviceId}>
                      <span class="source-device-chip" title=${`${m.name} (${m.deviceId})`}>
                        <${KindIcon} kind=${m.kind} size=${12} class="source-device-chip-icon" />
                        <span class="source-device-chip-name">${m.name}</span>
                      </span>
                      <span class=${`source-device-member-status tone-${m.tone}`}>${m.label}</span>
                      <${SourceNoticeIcons} notices=${m.notices} deviceName=${m.name} />
                    </div>
                  `,
                )}
              </div>`
            : html`<div class="source-device-member">
                <span class="source-device-chip" title=${`${s.deviceName}${s.deviceId ? ` (${s.deviceId})` : ""}`}>
                  <${KindIcon} kind=${s.deviceKind} size=${12} class="source-device-chip-icon" />
                  <span class="source-device-chip-name">${s.deviceName}</span>
                </span>
                <${SourceNoticeIcons}
                  notices=${noticesForDevice(s.syncStatus, memberLines[0]?.deviceId ?? s.deviceId)}
                  deviceName=${s.deviceName}
                />
              </div>`}
        ${syncNote && html`<div class="source-sync-note" role="status">${syncNote}</div>`}
      </td>
      <td class="sources-actions-v2">
        ${s.removing
          ? html`<span class="source-busy danger" title="Deleting this source's documents, analytics, derived notes and search-index entries. It disappears when that finishes.">removing…</span>`
          : busy
          ? html`<span class="source-busy">${busy}…</span>`
          : html`<${SourceActionMenu}
              paused=${!s.enabled}
              canImport=${!!(importSpec && onImportHistory)}
              canManualSync=${canManualSync}
              importLabel=${importSpec?.label}
              multiDevice=${multiDevice}
              canJoin=${joinable}
              canDetach=${(s.members?.length ?? 1) > 1}
              resyncPerDevice=${resyncChoices(s) === "per-device"}
              onRecent=${onRecent}
              onSync=${onSync}
              onPauseToggle=${onPauseToggle}
              onJoinMember=${onJoinMember}
              onDetachMember=${onDetachMember}
              onDebug=${onDebug}
              onResync=${onResync}
              onImportHistory=${onImportHistory}
              onRemove=${onRemove}
              internal=${!!s.internal}
            />`}
      </td>
    </tr>
  `;
}

/**
 * Indexer progress cell — renders the PctBar inline and a styled hover
 * popover with indexed counts + date range. We use mouse events + a
 * fixed-positioned popover so it escapes the table wrapper's overflow
 * clipping (same trick as SourceActionMenu) and flips above the trigger
 * when space below is tight.
 */
function ProgressCell({ source: s }) {
  const [hover, setHover] = useState(false);
  const [style, setStyle] = useState(null);
  const cellRef = useRef(null);

  const open = (e) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const popH = 96; // approximate popover height
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipped = spaceBelow < popH && rect.top > popH;
    const left = rect.left + rect.width / 2;
    setStyle(flipped
      ? { bottom: (window.innerHeight - rect.top + 6) + "px", left: left + "px" }
      : { top: (rect.bottom + 6) + "px", left: left + "px" });
    setHover(true);
  };
  const close = () => setHover(false);

  const styleStr = style ? Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";") : "";
  const pct = s.indexed;
  const indexedDocs = s.indexedDocs;
  const gatewayDocs = s.gatewayIndexedDocs;
  const earliest = fmtDateShort(s.earliestIndexedDate);
  const latest = fmtDateShort(s.latestIndexedDate);
  const errors = s.indexErrors ?? 0;
  const degraded = s.degradedDocs ?? 0;

  return html`
    <div
      ref=${cellRef}
      class="source-progress-wrap"
      onMouseEnter=${open}
      onMouseLeave=${close}
    >
      ${pct === null || pct === undefined
        ? html`<span class="source-progress-dash">—</span>`
        : html`<${PctBar} pct=${pct} />`}
      ${hover && html`
        <div class="source-progress-popover" style=${styleStr} role="tooltip">
          ${pct === null || pct === undefined
            ? html`<div class="source-progress-popover-note">${s.indexNote ?? "Not indexed"}</div>`
            : html`
              <div class="source-progress-popover-row">
                <span class="source-progress-popover-label">Indexed</span>
                <span class="source-progress-popover-value">
                  ${indexedDocs != null && gatewayDocs != null
                    ? `${fmtNumber(indexedDocs)} / ${fmtNumber(gatewayDocs)}`
                    : "—"}
                </span>
              </div>
              <div class="source-progress-popover-row">
                <span class="source-progress-popover-label">Range</span>
                <span class="source-progress-popover-value">
                  ${earliest && latest ? `${earliest} → ${latest}` : "—"}
                </span>
              </div>
              ${errors > 0 && html`
                <div class="source-progress-popover-row">
                  <span class="source-progress-popover-label">Failed</span>
                  <span class="source-progress-popover-value error">${fmtNumber(errors)}</span>
                </div>
              `}
              ${degraded > 0 && html`
                <div class="source-progress-popover-row">
                  <span class="source-progress-popover-label">Degraded</span>
                  <span class="source-progress-popover-value">
                    ${fmtNumber(degraded)}
                    ${(s.truncatedChunks > 0 || s.droppedChunks > 0)
                      ? ` (${fmtNumber(s.truncatedChunks)} trunc, ${fmtNumber(s.droppedChunks)} dropped)`
                      : ""}
                  </span>
                </div>
              `}
            `}
        </div>
      `}
    </div>
  `;
}

/**
 * Last-activity cell — shows the relative time of the most recent ingest
 * or content rewrite for this source. Hover-popover reveals one of:
 *
 *   - kind="document": "Created"/"Updated" label, document title, arrow
 *     link into the portal doc viewer.
 *   - kind="analytics": "Latest sample" label and the source DuckDB
 *     table's display name (apple-health, screen-time, etc. — no
 *     individual doc to navigate to).
 *
 * The popover is interactive (the title and arrow are clickable for
 * documents), so the hover bridge uses a small mouseleave-debounce and the
 * popover itself cancels the close timer on mouseenter — moving the cursor
 * from the cell onto the popover keeps it open.
 */
function ActivityCell({ activity }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const closeTimer = useRef(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    // Generous grace — long enough to forgive cursor jitter and reading
    // pauses, short enough that the popover doesn't overstay its welcome
    // when the user clearly moves elsewhere.
    closeTimer.current = setTimeout(() => setOpen(false), 240);
  };
  useEffect(() => () => cancelClose(), []);

  if (!activity) {
    return html`<span class="source-activity-empty">—</span>`;
  }

  // Tolerate older payloads that pre-date the `kind` discriminator —
  // the doc-based shape always has docId, the analytics shape never does.
  const kind = activity.kind ?? (activity.docId ? "document" : "analytics");
  const isAnalytics = kind === "analytics";

  const handleEnter = (e) => {
    cancelClose();
    const rect = e.currentTarget.getBoundingClientRect();
    // Popover anchors flush below the cell with no vertical gap so the
    // cursor can transit straight onto it without crossing dead space.
    const popH = 80;
    const flipped = (window.innerHeight - rect.bottom) < popH && rect.top > popH;
    const left = rect.left + rect.width / 2;
    setStyle(flipped
      ? { bottom: (window.innerHeight - rect.top) + "px", left: left + "px" }
      : { top: rect.bottom + "px", left: left + "px" });
    setOpen(true);
  };

  const goToDoc = (e) => {
    e.preventDefault();
    cancelClose();
    setOpen(false);
    navigate(`/portal/doc/${encodeURIComponent(activity.docId)}`);
  };

  let label;
  let labelClass;
  let detail;
  if (isAnalytics) {
    label = "Latest sample";
    labelClass = "analytics";
    detail = activity.tableDisplayName?.trim() || activity.tableName || "Analytics record";
  } else {
    label = activity.isNew ? "Created" : "Updated";
    labelClass = activity.isNew ? "new" : "updated";
    detail = activity.title?.trim() || "(no title)";
  }
  const truncated = detail.length > 60 ? detail.slice(0, 60) + "…" : detail;
  const styleStr = style ? Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";") : "";

  return html`
    <div
      class="source-activity-wrap"
      onMouseEnter=${handleEnter}
      onMouseLeave=${scheduleClose}
    >
      <span class="source-time">${fmtTimeIso(activity.latestActivityAt)}</span>
      ${open && html`
        <div
          class="source-activity-popover"
          style=${styleStr}
          role="tooltip"
          onMouseEnter=${cancelClose}
          onMouseLeave=${scheduleClose}
        >
          <div class="source-activity-popover-row">
            <span class="source-activity-popover-label ${labelClass}">
              ${label}
            </span>
            <span class="source-activity-popover-time">
              ${fmtTimeIso(activity.latestActivityAt)}
            </span>
          </div>
          ${isAnalytics
            ? html`
              <div class="source-activity-popover-link" title=${detail}>
                <span class="source-activity-popover-title">${truncated}</span>
              </div>
            `
            : html`
              <a
                href=${`/portal/doc/${encodeURIComponent(activity.docId)}`}
                class="source-activity-popover-link"
                onClick=${goToDoc}
                title=${detail}
              >
                <span class="source-activity-popover-title">${truncated}</span>
                <svg aria-hidden="true" class="source-activity-popover-arrow" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 3l5 5-5 5"/>
                </svg>
              </a>
            `}
        </div>
      `}
    </div>
  `;
}

/**
 * ARIA menu keyboard navigation. Wired on the `role="menu"` container —
 * arrow keys cycle focus across visible `role="menuitem"` buttons,
 * Home/End jump to the first/last, Escape closes the popover. Mirrors
 * the helper in `views/devices.js`.
 */
function handleMenuKeyNav(event, onClose) {
  const items = Array.from(event.currentTarget.querySelectorAll('[role="menuitem"]'));
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[(idx + 1 + items.length) % items.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    items[(idx - 1 + items.length) % items.length]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === "Escape" && onClose) {
    event.preventDefault();
    onClose();
  }
}

/**
 * Kebab (⋯) popover menu for per-row actions. Uses fixed positioning so
 * the popover escapes the table wrapper's overflow clipping, and flips
 * above the trigger when there isn't room below.
 */
function SourceActionMenu({
  paused,
  canManualSync = true,
  canImport,
  importLabel,
  multiDevice = false,
  canJoin = false,
  canDetach = false,
  resyncPerDevice = false,
  internal = false,
  onRecent,
  onSync,
  onPauseToggle,
  onJoinMember,
  onDetachMember,
  onDebug,
  onResync,
  onImportHistory,
  onRemove,
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const handlers = {
    recent: onRecent,
    sync: onSync,
    "pause-toggle": onPauseToggle,
    "join-member": onJoinMember,
    "detach-member": onDetachMember,
    debug: onDebug,
    resync: onResync,
    "import-history": onImportHistory,
    remove: onRemove,
  };
  const items = sourceActionMenuItems({
    paused,
    canManualSync,
    canImport,
    importLabel,
    multiDevice,
    canJoin,
    canDetach,
    resyncPerDevice,
    internal,
  });

  function toggle() {
    if (open) { setOpen(false); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    const menuH = items.length * 36; // approximate item height × count
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipped = spaceBelow < menuH && rect.top > menuH;
    const right = window.innerWidth - rect.right;
    setStyle(flipped
      ? { bottom: (window.innerHeight - rect.top + 4) + "px", right: right + "px" }
      : { top: (rect.bottom + 4) + "px", right: right + "px" });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onDocMouse = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const run = (fn) => () => { setOpen(false); fn(); };
  const styleStr = style ? Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";") : "";

  return html`
    <div class="source-action-menu">
      <button
        ref=${triggerRef}
        class="btn-tiny source-action-trigger"
        title="Actions"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded=${open}
        onClick=${toggle}
      >⋯</button>
      ${open && html`
        <div ref=${menuRef} class="source-action-popover" role="menu" style=${styleStr}
          onKeyDown=${(e) => handleMenuKeyNav(e, () => setOpen(false))}>
          ${items.map((item) => html`
            <button
              class=${`source-action-item${item.danger ? " danger" : ""}`}
              role="menuitem"
              onClick=${run(handlers[item.action])}
              disabled=${item.disabled}
            >${item.label}</button>
          `)}
        </div>
      `}
    </div>
  `;
}

function DebugDrawer({ drawer, onClose }) {
  return html`
    <div class="sources-drawer-backdrop" onClick=${onClose}>
      <div class="sources-drawer" onClick=${(e) => e.stopPropagation()}>
        <div class="sources-drawer-header">
          <h3>Debug — <code>${drawer.sourceId}</code></h3>
          <button class="btn-tiny" onClick=${onClose}>close</button>
        </div>
        <div class="sources-drawer-body">
          ${drawer.loading
            ? html`<div class="dim">Loading…</div>`
            : drawer.error
              ? html`<div class="sources-banner-v2 error">${drawer.error}</div>`
              : html`
                <${CoverageWatermark} watermark=${drawer.watermark} error=${drawer.watermarkError} />
                ${drawer.debugError
                  ? html`<div class="sources-banner-v2 error">${drawer.debugError}</div>`
                  : html`<pre class="sources-debug-json">${JSON.stringify(drawer.debug, null, 2)}</pre>`}
              `}
        </div>
      </div>
    </div>
  `;
}

const watermarkMeaning = {
  "change-cut": "The source reported a durable upstream change position.",
  snapshot: "The source completed a bounded snapshot of its configured scope.",
  "best-effort-scan": "The source finished a scan, but cannot prove a complete upstream cut.",
  observation: "A source sync completed at this time; it does not prove upstream completeness.",
};

function CoverageWatermark({ watermark, error }) {
  if (error) {
    return html`
      <section class="source-watermark">
        <h4>Coverage watermark</h4>
        <p class="dim">Unavailable: ${error}</p>
      </section>
    `;
  }
  if (!watermark) {
    return html`
      <section class="source-watermark">
        <h4>Coverage watermark</h4>
        <p class="dim">No completed sync has recorded coverage yet.</p>
      </section>
    `;
  }

  return html`
    <section class="source-watermark">
      <h4>Coverage watermark</h4>
      <dl class="source-watermark-grid">
        <dt>Guarantee</dt><dd><code>${watermark.guarantee}</code></dd>
        <dt>Observed</dt><dd title=${watermark.observedAt}>${fmtTimeIso(watermark.observedAt)}</dd>
        ${watermark.semanticTimeThrough && html`
          <dt>Semantic time through</dt><dd title=${watermark.semanticTimeThrough}>${fmtTimeIso(watermark.semanticTimeThrough)}</dd>
        `}
        <dt>Generation</dt><dd>${watermark.generation}</dd>
        <dt>Updated</dt><dd title=${watermark.committedAt}>${fmtTimeIso(watermark.committedAt)}</dd>
      </dl>
      <p class="source-watermark-meaning">${watermark.detail || watermarkMeaning[watermark.guarantee]}</p>
    </section>
  `;
}
