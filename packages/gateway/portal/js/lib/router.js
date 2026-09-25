// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEBUG_TAB_KEYS, DEFAULT_DEBUG_TAB } from "./debug-tabs.js";
import { NOTE_DAY_RE } from "./notes.js";
import {
  SETTINGS_TAB_KEYS,
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS_WITH_SECTION,
} from "./settings-tabs.js";

// The one-page-each spelling every Settings tab still answers to —
// `/portal/<tab>`, optionally with the section a tab owns. Derived from the
// tab registry so adding or renaming a tab moves its alias with it.
const SETTINGS_ALIAS_PATTERN = new RegExp(
  `^/portal/(${SETTINGS_TAB_KEYS.join("|")})(?:/([a-z-]+))?/?$`,
);

// Alternate paths for three Debug tabs. Each resolves to its tab and
// redirects, so the address bar names the page actually on screen and links
// using these spellings keep working.
const DEBUG_TAB_ALIASES = {
  "/portal/graph": "graph",
  "/portal/data": "data",
  "/portal/sql": "sql",
};

// Optional unsaved-work guard for editors. The guard returns a message when
// navigating now would discard edits, or null to allow it. Both in-app
// navigations run it; a declined guard aborts before touching history.
// A native dialog is deliberate: navigation is synchronous, so an async
// modal promise cannot gate it. Last setter wins; editors clear on unmount.
let routeLeaveGuard = null;
export function setRouteLeaveGuard(guard) {
  routeLeaveGuard = guard;
}
function allowRouteLeave() {
  if (typeof routeLeaveGuard !== "function") return true;
  const message = routeLeaveGuard();
  return !message || window.confirm(message);
}

export function navigate(path) {
  if (!allowRouteLeave()) return false;
  history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("route-change"));
  return true;
}

// Replace the current history entry and re-render from the new route. Use this
// when the old URL represents state the user explicitly cleared: Browser Back
// must not resurrect it.
export function replaceRoute(path) {
  if (!allowRouteLeave()) return false;
  history.replaceState(null, "", path);
  window.dispatchEvent(new CustomEvent("route-change"));
  return true;
}

// Replace the current history entry without pushing a new one. Used when
// the URL needs to mirror in-page state (e.g. the People search box's
// `?q=` query) — pushState here would flood the back stack with one
// entry per keystroke. No route-change event is fired since the in-page
// state already changed and components don't need to re-derive from URL.
export function replaceUrl(path) {
  history.replaceState(null, "", path);
}

export function parseRoute() {
  const path = location.pathname;

  if (path === "/portal" || path === "/portal/") {
    return { view: "agent", convoId: null };
  }

  const docMatch = path.match(/^\/portal\/doc\/(.+)$/);
  if (docMatch) {
    return { view: "document", id: decodeURIComponent(docMatch[1]) };
  }

  // /portal/people/<id> — detail view. Reserved sub-paths ("rules",
  // "candidates") are excluded so they fall through to the People
  // tabs handler below; otherwise the greedy catch-all swallows them
  // and tries to fetch a person with id="rules" / "candidates".
  const personMatch = path.match(/^\/portal\/people\/(.+)$/);
  if (personMatch && personMatch[1] !== "rules" && personMatch[1] !== "candidates") {
    return { view: "people", personId: decodeURIComponent(personMatch[1]) };
  }

  if (path === "/portal/people" || path === "/portal/people/" || path === "/portal/people/rules" || path === "/portal/people/candidates") {
    const params = new URLSearchParams(location.search);
    let tab;
    if (path === "/portal/people/rules") tab = "rules";
    else if (path === "/portal/people/candidates") tab = "candidates";
    else tab = params.get("tab") || "list";
    return { view: "people", tab, query: params.get("q") || "" };
  }

  // Legacy /portal/merge-rules → redirect into the People tab. Resolved
  // here so deep links from older Slack messages / bookmarks still work.
  if (path === "/portal/merge-rules" || path === "/portal/merge-rules/") {
    return { view: "people", tab: "rules", query: "" };
  }

  const sourceRecentMatch = path.match(/^\/portal\/sources\/(.+?)\/recent\/?$/);
  if (sourceRecentMatch) {
    return { view: "source-recent", sourceId: decodeURIComponent(sourceRecentMatch[1]) };
  }

  if (path === "/portal/sources" || path === "/portal/sources/") {
    return { view: "sources" };
  }

  if (path === "/portal/capture" || path === "/portal/capture/") {
    // `?day=YYYY-MM-DD` seeds the note history at that day — a
    // Manage-notes link from an old daily document lands on relevant
    // notes. Malformed values are ignored (latest notes instead).
    const day = new URLSearchParams(location.search).get("day");
    return { view: "capture", day: day && NOTE_DAY_RE.test(day) ? day : null };
  }

  const accessAuthorizationMatch = path.match(
    /^\/portal\/settings\/access\/authorizations\/([^/]+)\/?$/,
  );
  if (accessAuthorizationMatch) {
    const accessAuthorizationId = decodePathSegment(accessAuthorizationMatch[1]);
    if (accessAuthorizationId === null) return { view: "search" };
    return {
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessAuthorizationId,
      completeAccessInPortal: new URLSearchParams(location.search).get("completion") === "portal",
    };
  }

  // A new access level, then one existing level, open in the permissions wizard.
  if (/^\/portal\/settings\/access\/levels\/new\/?$/.test(path)) {
    return {
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessNewLevel: true,
    };
  }

  const accessLevelMatch = path.match(/^\/portal\/settings\/access\/levels\/([^/]+)\/?$/);
  if (accessLevelMatch) {
    const accessLevelId = decodePathSegment(accessLevelMatch[1]);
    if (accessLevelId === null) return { view: "search" };
    return {
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessLevelId,
    };
  }

  // The connect dialog on the Access tab, addressed so a link can open it.
  if (/^\/portal\/settings\/access\/connect\/?$/.test(path)) {
    return {
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessConnect: true,
    };
  }

  // One privacy policy, open for editing on the Policies tab. The same policy
  // under the Access tab is an equivalent spelling and redirects, so the
  // address bar names the tab on screen.
  const policyMatch = path.match(
    /^\/portal\/settings\/(policies|access\/policies)\/([^/]+)\/?$/,
  );
  if (policyMatch) {
    const policyId = decodePathSegment(policyMatch[2]);
    if (policyId === null) return { view: "search" };
    return {
      view: "settings",
      tab: "policies",
      modelsSection: null,
      policyId,
      ...(policyMatch[1] === "policies"
        ? {}
        : { redirectTo: `/portal/settings/policies/${encodeURIComponent(policyId)}` }),
    };
  }

  // The policy list has one home, the Policies tab; spelling it under the
  // Access tab redirects there so the address names the tab on screen.
  if (/^\/portal\/settings\/access\/policies\/?$/.test(path)) {
    return {
      view: "settings",
      tab: "policies",
      modelsSection: null,
      redirectTo: "/portal/settings/policies",
    };
  }

  // Settings page tabs: /portal/settings[/<tab>]. Every tab owns a path
  // segment so a refresh lands where it left off; the bare /portal/settings is
  // the default tab. A tab the registry marks as owning a section nests one
  // segment deeper — /portal/settings/models/<capability> for a capability,
  // /portal/settings/models/backends for the backend list.
  //
  // Each tab also answers to a bare `/portal/<tab>` — the spelling from when
  // each was its own page. Those resolve to their tab and redirect, so
  // bookmarks and links using them keep working while the address bar always
  // names the page on screen. An unrecognised tab segment resolves to the
  // default tab the same way.
  const settingsMatch = path.match(/^\/portal\/settings(?:\/([a-z-]+)(?:\/([a-z-]+))?)?\/?$/);
  const settingsAliasMatch = path.match(SETTINGS_ALIAS_PATTERN);
  if (settingsMatch || settingsAliasMatch) {
    const match = settingsMatch ?? settingsAliasMatch;
    const requested = match[1];
    const tab = SETTINGS_TAB_KEYS.includes(requested) ? requested : DEFAULT_SETTINGS_TAB;
    // A stray segment under a tab that owns none is dropped (and redirected
    // away); `modelsSection` is null for those.
    const modelsSection = SETTINGS_TABS_WITH_SECTION.includes(tab) ? (match[2] ?? null) : null;
    const canonicalPath = `/portal/settings/${tab}${modelsSection ? `/${modelsSection}` : ""}`;
    const normalized = path.replace(/\/$/, "");
    const isCanonical =
      normalized === canonicalPath
      || (tab === DEFAULT_SETTINGS_TAB && !modelsSection && normalized === "/portal/settings");
    // `?pair=<kind>` on the Devices tab opens the pairing modal with that
    // device kind preselected, so a link can carry the user straight from
    // e.g. the Sources extension promo into pairing. The Devices view
    // validates the kind and ignores anything it doesn't recognise.
    const pairRequest = tab === "devices"
      ? new URLSearchParams(location.search).get("pair")
      : null;
    // `?device=<id>` on the Devices tab opens that device's card and scrolls
    // to it, so a page that names a device can link straight to it.
    const deviceRequest = tab === "devices"
      ? new URLSearchParams(location.search).get("device")
      : null;
    return {
      view: "settings",
      tab,
      modelsSection,
      ...(pairRequest ? { pair: pairRequest } : {}),
      ...(deviceRequest ? { device: deviceRequest } : {}),
      // Carry the query string across the rewrite: a tab that grows URL-carried
      // state must not lose it just because the caller used an older spelling.
      ...(isCanonical ? {} : { redirectTo: `${canonicalPath}${location.search}` }),
    };
  }

  // A single approval by id, opened on its own. Pending approvals are normally
  // decided inline on the Activity landing page; this path exists so a link
  // that names one — a push notification, a bookmark — resolves straight to
  // that decision.
  const privacyApprovalMatch = path.match(/^\/portal\/audit\/approvals\/([^/]+)\/?$/);
  if (privacyApprovalMatch) {
    const approvalId = decodePathSegment(privacyApprovalMatch[1]);
    if (approvalId === null) return { view: "search" };
    return {
      view: "privacy",
      approvalId,
      conversationId: null,
      taskId: null,
      directTab: false,
      directSessionId: null,
    };
  }

  // Watches — the approval inbox plus every watch an integration owns.
  // `/portal/audit/subscription-approvals/<id>` is an equivalent spelling of
  // the same screen and resolves here too, carrying a `redirectTo` so the
  // address bar settles on the canonical `/portal/watches/...` path.
  const watchApprovalMatch = path.match(
    /^\/portal\/(?:watches\/approvals|audit\/subscription-approvals)\/([^/]+)\/?$/,
  );
  if (watchApprovalMatch) {
    const watchApprovalId = decodePathSegment(watchApprovalMatch[1]);
    if (watchApprovalId === null) return { view: "search" };
    const canonical = `/portal/watches/approvals/${encodeURIComponent(watchApprovalId)}`;
    return {
      view: "watches",
      watchApprovalId,
      watchId: null,
      watchFiringId: null,
      ...(path.startsWith("/portal/watches/") ? {} : { redirectTo: canonical }),
    };
  }

  // /portal/watches/<id>/firings/<firingId> — one firing's trusted audit.
  // Matched before the watch-detail pattern so the segments after `/firings/`
  // are not swallowed into the watch id.
  const watchFiringMatch = path.match(
    /^\/portal\/(?:watches|audit\/subscriptions)\/([^/]+)\/firings\/([^/]+)\/?$/,
  );
  if (watchFiringMatch) {
    const watchId = decodePathSegment(watchFiringMatch[1]);
    const watchFiringId = decodePathSegment(watchFiringMatch[2]);
    if (watchId === null || watchFiringId === null) return { view: "search" };
    const canonical =
      `/portal/watches/${encodeURIComponent(watchId)}`
      + `/firings/${encodeURIComponent(watchFiringId)}`;
    return {
      view: "watches",
      watchApprovalId: null,
      watchId,
      watchFiringId,
      ...(path.startsWith("/portal/watches/") ? {} : { redirectTo: canonical }),
    };
  }

  // "approvals" is excluded so the bare `/portal/watches/approvals` falls through
  // to the inbox instead of asking the gateway for a watch by that id.
  const watchMatch = path.match(/^\/portal\/(?:watches|audit\/subscriptions)\/([^/]+)\/?$/);
  if (watchMatch && watchMatch[1] !== "approvals") {
    const watchId = decodePathSegment(watchMatch[1]);
    if (watchId === null) return { view: "search" };
    const canonical = `/portal/watches/${encodeURIComponent(watchId)}`;
    return {
      view: "watches",
      watchApprovalId: null,
      watchId,
      watchFiringId: null,
      ...(path.startsWith("/portal/watches/") ? {} : { redirectTo: canonical }),
    };
  }

  const watchesMatch = path.match(/^\/portal\/(watches|audit\/subscriptions)(?:\/approvals)?\/?$/);
  if (watchesMatch) {
    return {
      view: "watches",
      watchApprovalId: null,
      watchId: null,
      watchFiringId: null,
      ...(watchesMatch[1] === "watches" ? {} : { redirectTo: "/portal/watches" }),
    };
  }

  // One exchange's detail. The unit of the Privacy feed is an exchange, not a
  // conversation, so a row addresses the task it opened.
  const privacyExchangeMatch = path.match(
    /^\/portal\/audit\/conversations\/([^/]+)\/exchanges\/([^/]+)\/?$/,
  );
  if (privacyExchangeMatch) {
    const conversationId = decodePathSegment(privacyExchangeMatch[1]);
    const taskId = decodePathSegment(privacyExchangeMatch[2]);
    if (conversationId === null || taskId === null) return { view: "search" };
    return {
      view: "privacy",
      approvalId: null,
      conversationId,
      taskId,
      directTab: false,
      directSessionId: null,
    };
  }

  // A conversation's audit trail, addressed as `.../audit`. Those steps are the
  // conversation detail's own timeline, so the path resolves there and redirects
  // so the address bar names the page actually on screen.
  const privacyConversationAuditMatch = path.match(
    /^\/portal\/audit\/conversations\/([^/]+)\/audit\/?$/,
  );
  if (privacyConversationAuditMatch) {
    const conversationId = decodePathSegment(privacyConversationAuditMatch[1]);
    if (conversationId === null) return { view: "search" };
    return {
      view: "privacy",
      approvalId: null,
      conversationId,
      taskId: null,
      directTab: false,
      directSessionId: null,
      redirectTo: `/portal/audit/conversations/${encodeURIComponent(conversationId)}`,
    };
  }

  const privacyConversationMatch = path.match(/^\/portal\/audit\/conversations\/([^/]+)\/?$/);
  if (privacyConversationMatch) {
    const conversationId = decodePathSegment(privacyConversationMatch[1]);
    if (conversationId === null) return { view: "search" };
    return {
      view: "privacy",
      approvalId: null,
      conversationId,
      taskId: null,
      directTab: false,
      directSessionId: null,
    };
  }

  // Direct audit transcript: the tab, and one open session. Both spellings
  // resolve here so a refresh or bookmark lands where the operator left off.
  const privacyDirectMatch = path.match(/^\/portal\/audit\/direct(?:\/([^/]+))?\/?$/);
  if (privacyDirectMatch) {
    const directSessionId = privacyDirectMatch[1]
      ? decodePathSegment(privacyDirectMatch[1])
      : null;
    if (privacyDirectMatch[1] && directSessionId === null) return { view: "search" };
    return {
      view: "privacy",
      approvalId: null,
      conversationId: null,
      taskId: null,
      directTab: true,
      directSessionId,
    };
  }

  // The privacy policies are edited on the Policies tab of Settings; this
  // path answers with that tab.
  if (/^\/portal\/audit\/policy\/?$/.test(path)) {
    return {
      view: "settings",
      tab: "policies",
      modelsSection: null,
      redirectTo: "/portal/settings/policies",
    };
  }

  // Privacy is one page: the exchange feed and whatever is waiting on a
  // decision. `activity`, `conversations` and `approvals` are alternative
  // spellings of it and redirect so the address bar names the page on screen.
  const privacyMatch = path.match(
    /^\/portal\/audit(?:\/(activity|conversations|approvals))?\/?$/,
  );
  if (privacyMatch) {
    return {
      view: "privacy",
      approvalId: null,
      conversationId: null,
      taskId: null,
      directTab: false,
      directSessionId: null,
      ...(privacyMatch[1] ? { redirectTo: "/portal/audit" } : {}),
    };
  }

  // Cognition debug sub-area (experimental): the read-only Cognition Steward
  // cognitive-state inspector. `/portal/debug/cognition[/<section>[/<id>]]`.
  // Nested one level deeper than the other Debug tabs (overview / loops /
  // runs / briefs / memory rail sections, most with an optional
  // selected-entity id for the master-detail right pane; "scheduled" is a
  // legacy alias the view resolves to runs), so it needs its own matcher
  // ahead of the single-segment `debugMatch` below (which would otherwise
  // never match a two-segment cognition path and fall through to search).
  const cognitionMatch = path.match(
    /^\/portal\/debug\/cognition(?:\/([a-z-]+)(?:\/(.+))?)?\/?$/,
  );
  if (cognitionMatch) {
    return {
      view: "debug",
      tab: "cognition",
      cognitionTab: cognitionMatch[1] || "overview",
      cognitionId: cognitionMatch[2] ? decodeURIComponent(cognitionMatch[2]) : null,
    };
  }

  // Watch debug sub-area (experimental): one watch's definition, drawn as the
  // graph the runtime evaluates. `/portal/debug/watch[/<watchId>[/history/<seq>]]`
  // — the bare path lists the installed watches, a watch id opens its canvas,
  // and a sequence number lights the path that journal event took across it.
  // The event lives in the URL rather than in the view's state so that a firing
  // in the Watches ledger can link straight to the moment it happened. Like the
  // cognition block above, it nests deeper than the other Debug tabs, so it
  // needs its own matcher ahead of the single-segment `debugMatch` (which would
  // otherwise never match it and drop the path through to search). A watch id
  // is opaque, so the segment is decoded rather than constrained; a sequence
  // number may be negative, because the runtime journals its own timers with
  // sequences counting down from -1.
  // The `/history` segment is matched with or without a sequence after it, so a
  // link that lost its event still lands on the watch's canvas rather than
  // falling past every Debug matcher to the search view.
  const watchDebugMatch = path.match(
    /^\/portal\/debug\/watch(?:\/([^/]+)(?:\/history(?:\/(-?\d+))?)?)?\/?$/,
  );
  if (watchDebugMatch) {
    const watchDebugId = watchDebugMatch[1] ? decodePathSegment(watchDebugMatch[1]) : null;
    return {
      view: "debug",
      tab: "watch",
      watchDebugId,
      watchDebugSeq: watchDebugMatch[2] === undefined ? null : Number(watchDebugMatch[2]),
    };
  }

  // Debug page tabs: /portal/debug[/<tab>]. Every tab owns a path segment so
  // a refresh lands where it left off; the bare /portal/debug is the default
  // tab. Three tabs also carry state in the query string so a view is
  // shareable / reloadable: Graph its seed + render options, Data the selected
  // table, SQL the store + pre-filled statement.
  //
  // An unrecognised segment resolves to the default tab and redirects, so the
  // address bar can never name a tab the page isn't showing.
  const debugMatch = path.match(/^\/portal\/debug(?:\/([a-z-]+))?\/?$/);
  const aliasedTab = DEBUG_TAB_ALIASES[path.replace(/\/$/, "")];
  if (debugMatch || aliasedTab) {
    const requested = aliasedTab ?? debugMatch[1];
    const tab = DEBUG_TAB_KEYS.includes(requested) ? requested : DEFAULT_DEBUG_TAB;
    const params = new URLSearchParams(location.search);
    const route = { view: "debug", tab };
    // A tab is named canonically by its own segment; the default tab also
    // answers to the bare /portal/debug. Anything else — an alias, an
    // unrecognised segment — redirects onto the segment form.
    const normalized = path.replace(/\/$/, "");
    const isCanonical =
      normalized === `/portal/debug/${tab}`
      || (tab === DEFAULT_DEBUG_TAB && normalized === "/portal/debug");
    if (!isCanonical) {
      route.redirectTo = `/portal/debug/${tab}${location.search}`;
    }
    if (tab === "graph") {
      const depthRaw = Number.parseInt(params.get("depth") ?? "", 10);
      const fanoutRaw = Number.parseInt(params.get("fanoutCap") ?? "", 10);
      route.graph = {
        documentId: params.get("documentId") ?? "",
        depth: Number.isFinite(depthRaw) ? depthRaw : undefined,
        fanoutCap: Number.isFinite(fanoutRaw) ? fanoutRaw : undefined,
        // Default-on; only `collapse=0` opts out.
        collapse: params.get("collapse") !== "0",
        // Default-on; only `mentions=0` opts out.
        showMentions: params.get("mentions") !== "0",
        // Default-off; only `hideAttPeople=1` opts in.
        hideAttachmentPeople: params.get("hideAttPeople") === "1",
      };
    } else if (tab === "data") {
      route.data = {
        store: params.get("store") || null,
        table: params.get("table") || null,
      };
    } else if (tab === "sql") {
      route.sql = {
        store: params.get("store") || null,
        sql: params.get("sql") || null,
      };
    }
    return route;
  }

  if (path === "/portal/agent" || path === "/portal/agent/") {
    return { view: "agent", convoId: null };
  }

  const agentConvoMatch = path.match(/^\/portal\/agent\/(.+)$/);
  if (agentConvoMatch) {
    return { view: "agent", convoId: decodeURIComponent(agentConvoMatch[1]) };
  }

  return { view: "search" };
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function onRouteChange(callback) {
  window.addEventListener("popstate", callback);
  window.addEventListener("route-change", callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("route-change", callback);
  };
}
