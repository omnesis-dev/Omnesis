// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html, render } from "htm/preact";
import { Component } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { parseRoute, onRouteChange, navigate, replaceUrl } from "./lib/router.js";
import { loadSourceMeta } from "./lib/format.js";
import { lazy } from "./lib/lazy.js";
// Search is the default landing view — keep eager so the index page
// has zero waterfall. All other views lazy-load on first navigation
// (see `lib/lazy.js`). This cuts the cold-start dependency graph
// from ~30 modules (codemirror, marked, qrcode, lezer parsers,
// etc. transitively pulled in by the heavier views) down to just the
// preact + htm + search-view shell on first paint of /portal/.
import { SearchView } from "./views/search.js";
import {
  checkSession,
  login,
  logout,
  apiFetch,
  getStatus,
  listPrivacyApprovals,
  listSubscriptionApprovals,
} from "./api.js";
import { clearOmnesisStorage } from "./lib/storage.js";
import { getTheme, toggleTheme } from "./lib/theme.js";
import { DevAnnotationButton } from "./components/dev-annotation-button.js";
import { DevAnnotationComposer } from "./components/dev-annotation-composer.js";
import { LoadMore } from "./components/load-more.js";
import { useCursorPage } from "./lib/use-cursor-page.js";
import { useVisiblePoll } from "./lib/use-visible-poll.js";
import { deleteSidebarConversation } from "./lib/sidebar-conversations.js";
import { releaseUpdateFromStatus } from "./lib/release-update.js";
import { FleetHostUpdate } from "./components/fleet-host-update.js";

const DocumentView = lazy(() => import("./views/document.js").then((m) => m.DocumentView));
const PeopleView = lazy(() => import("./views/people.js").then((m) => m.PeopleView));
const SourcesView = lazy(() => import("./views/sources.js").then((m) => m.SourcesView));
const SourceRecentView = lazy(() => import("./views/source-recent.js").then((m) => m.SourceRecentView));
const SettingsView = lazy(() => import("./views/settings.js").then((m) => m.SettingsView));
// Reached only by the OAuth consent redirect, which renders the grant decision
// on its own rather than inside the Settings shell.
const AccessView = lazy(() => import("./views/access.js").then((m) => m.AccessView));
const DebugView = lazy(() => import("./views/debug.js").then((m) => m.DebugView));
const PrivacyView = lazy(() => import("./views/privacy.js").then((m) => m.PrivacyView));
const WatchesView = lazy(() => import("./views/watches.js").then((m) => m.WatchesView));
const AgentView = lazy(() => import("./views/agent.js").then((m) => m.AgentView));
const CaptureView = lazy(() => import("./views/capture.js").then((m) => m.CaptureView));

const CONVERSATION_PAGE_SIZE = 50;
// How often a visible tab re-reads the conversation list, so a conversation
// that went unread elsewhere grows its dot without the operator navigating.
const CONVERSATION_POLL_MS = 60_000;
// Fallback pace for re-marking a conversation on screen, used until /status
// reports the window the gateway actually enforces.
const DEFAULT_SEEN_REFRESH_MS = 45_000;
// How often a visible tab re-counts the decisions waiting on the operator. An
// approval expires, so the count has to move without the operator navigating.
const PRIVACY_PENDING_POLL_MS = 60_000;
// `/status` is cache-backed and this keeps a release found by the gateway
// visible without requiring the operator to reload the portal.
const RELEASE_STATUS_POLL_MS = 60_000;

/**
 * Top-level error boundary. Preact 10 doesn't ship a dedicated
 * `ErrorBoundary` primitive, but the `componentDidCatch` lifecycle
 * still runs on class components — that's enough to keep a single
 * unmounted view (e.g. a thrown exception inside a lazy module) from
 * blanking out the whole portal. We render a simple fallback with a
 * Reload button so the user has a way out without opening the
 * dev-tools console.
 */
class ErrorBoundary extends Component {
  state = { error: null };

  componentDidCatch(error) {
    this.setState({ error });
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.error) {
      return html`
        <div class="error-card" role="alert">
          <h2>Something went wrong</h2>
          <p>${this.state.error.message ?? String(this.state.error)}</p>
          <button class="sql-run-btn" onClick=${() => location.reload()}>Reload</button>
        </div>
      `;
    }
    return this.props.children;
  }
}

// Surface unhandled promise rejections in the browser devtools.
// Without this listener, async errors that escape any `.catch` (e.g. a
// background fetch firing post-unmount) get swallowed silently — the
// console.error here makes them at least visible during debugging.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[unhandledrejection]", event.reason);
  });
}

function LoginView({ reason } = {}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError("");
    try {
      const result = await login(token.trim());
      if (result.ok) {
        window.location.reload();
      } else {
        setError(result.error || "Invalid token");
      }
    } catch {
      setError("Failed to connect");
    }
    setLoading(false);
  };

  return html`
    <div class="login-container">
      <div class="login-card">
        <span class="login-logo omnesis-mark" style="width:72px;height:72px" role="img" aria-label="Omnesis"></span>
        <h1 class="login-title">Omnesis</h1>
        ${reason
          ? html`<p class="login-subtitle login-reason">${reason}</p>`
          : html`<p class="login-subtitle">Enter an API token or a pairing code to continue</p>`}
        <form onSubmit=${handleSubmit}>
          <input
            type="password"
            class="login-input"
            placeholder="omn_… or pairing code"
            aria-label="API token or pairing code"
            value=${token}
            onInput=${(e) => setToken(e.target.value)}
            autofocus
            disabled=${loading}
          />
          ${error && html`<p class="login-error">${error}</p>`}
          <button type="submit" class="login-button" disabled=${loading || !token.trim()}>
            ${loading ? "Authenticating..." : "Log in"}
          </button>
        </form>
        <p class="login-hint">
          Your default token is in <code>~/.config/omnesis/token</code>, or run
          ${" "}<code>omnesis devices pair</code> with <code>kind=portal</code> for a one-shot code.
        </p>
      </div>
    </div>
  `;
}

// Experimental destinations still appear only when the gateway runs in
// experimental mode. Privacy is a standard control surface because an Answer
// integration can require an operator decision in normal operation.
const NAV_ITEMS = [
  { view: "agent", href: "/portal/agent", label: "Ask", icon: "agent", isNewConvo: true },
  { view: "search", href: "/portal/search", label: "Search", icon: "search" },
  { view: "sources", href: "/portal/sources", label: "Sources", icon: "sources" },
  { view: "people", href: "/portal/people", label: "People", icon: "people" },
  { view: "capture", href: "/portal/capture", label: "Tell Omnesis", icon: "capture" },
  { view: "watches", href: "/portal/watches", label: "Watches", icon: "watches", experimental: true },
  { view: "privacy", href: "/portal/audit", label: "Audit", icon: "privacy" },
  { view: "debug", href: "/portal/debug", label: "Debug", icon: "debug" },
  { view: "settings", href: "/portal/settings", label: "Settings", icon: "settings" },
];

// Sidebar nav icons. Each one is decorative — the adjacent
// `.sidebar-label` already names the link — so we mark every SVG
// `aria-hidden="true"` to keep screen readers from announcing
// "search image" / "people image" before the actual label.
const ICONS = {
  search: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>`,
  people: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M2 14c0-2.5 2-4 4-4s4 1.5 4 4"/><circle cx="11.5" cy="6" r="2"/><path d="M10 13.5c0-1.6 1.3-2.8 3-2.8"/></svg>`,
  // Sources = the grid of connected integrations (one tile per source). The
  // 2×2 tile grid (Lucide `layout-grid`) matches the iOS (`square.grid.2x2`)
  // and Android (`GridView`) Sources glyph.
  sources: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
  // Settings = the gear, the universal "configure this thing" glyph. It covers
  // the whole page — the config file, the models, and the paired devices.
  settings: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/></svg>`,
  privacy: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`,
  // "Tell Omnesis" — a microphone (Lucide `mic`), the glyph the iOS
  // (`mic.fill`) and Android capture rows wear. The portal captures typed
  // text only, but the row is the same destination on every client.
  capture: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
  watches: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
  // "New conversation" — a compose glyph (Lucide `square-pen`), matching the
  // iOS (`square.and.pencil`) and Android (`Edit`) New-conversation rows. The
  // pencil-on-document is the universal "start a new chat" affordance.
  agent: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.874a2 2 0 0 1 .506-.852z"/></svg>`,
  debug: html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M3 4l2.5 2.5M13 4l-2.5 2.5"/><rect x="4" y="6" width="8" height="7" rx="2"/><path d="M2 9h2M12 9h2M2 12h2M12 12h2"/></svg>`,
};

// Pushpin glyph (Lucide "pin"), reused for the pinned-row marker and the
// Pin/Unpin menu item.
const PIN_ICON = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

// Stable pinned-first ordering. The gateway already returns conversations
// pinned-first, but re-partitioning client-side keeps an optimistic pin
// toggle at the top until the canonical refetch lands. A stable sort
// preserves the server's newest-first order within each pin group.
function orderConversations(conversations) {
  return [...conversations].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

function App() {
  const [route, setRoute] = useState(parseRoute());
  const [sessionExpired, setSessionExpired] = useState(false);
  const conversationPage = useCursorPage({
    resetKey: "sidebar-conversations",
    pageSize: CONVERSATION_PAGE_SIZE,
    loadPage: async ({ limit, cursor }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      const res = await apiFetch(`/agent/conversations?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Conversations are unavailable.");
      const body = await res.json();
      return {
        items: body?.conversations ?? [],
        nextCursor: body?.nextCursor ?? null,
      };
    },
  });
  const conversations = conversationPage.items;
  const setConversations = conversationPage.setItems;
  // Active conversation ID for the sidebar highlight. We can't rely on
  // `route.convoId` alone — the agent view's auto-resume path uses
  // `replaceUrl` (silent), so the URL has an id but the parsed route
  // doesn't. The agent view dispatches `omnesis:agent-active-convo`
  // every time it loads a conversation so we always know what's open.
  const [activeConvoId, setActiveConvoId] = useState(route.convoId ?? null);
  // Which sidebar convo row currently has its action menu open. null when
  // no menu is open. Mirrors ChatGPT's per-row "…" overflow menu.
  const [menuOpenId, setMenuOpenId] = useState(null);
  const menuRootRef = useRef(null);
  // Mirrors the applied light/dark theme so the Settings toggle's icon/label
  // re-render on flip. The actual application + persistence lives in
  // lib/theme.js; this is just the local copy that drives the button.
  const [theme, setThemeState] = useState(getTheme());
  // Whether the gateway runs in experimental mode (OMNESIS_EXPERIMENTAL=1).
  // Gates discovery of the experimental surfaces. Read from /status; stays
  // false until the first successful response, so experimental features never
  // flash in by default. The same lightweight poll also carries the passive
  // release result.
  const [experimental, setExperimental] = useState(false);

  // Whether the gateway runs in developer mode (OMNESIS_DEV_MODE=1). Separate
  // from experimental; reveals the floating developer-annotation button. Stays
  // false until the /status read resolves, so the affordance never flashes in.
  const [developer, setDeveloper] = useState(false);
  // A passive, gateway-owned release result. Null before the first successful
  // check, on malformed data, or when this install is current.
  const [releaseUpdate, setReleaseUpdate] = useState(null);
  const statusRequestGeneration = useRef(0);

  // Half the window the gateway believes a viewing mark for, so a refresh
  // always lands well inside it. Derived rather than hardcoded: the two
  // numbers must stay in a fixed relationship, and only the gateway knows
  // its own.
  const [seenRefreshMs, setSeenRefreshMs] = useState(DEFAULT_SEEN_REFRESH_MS);

  // Decisions waiting on the operator, badged on the nav item where each is
  // decided: a held answer on Privacy, and — only where watches exist at all —
  // a request for a standing watch on Watches. Each count stands on its own,
  // so one endpoint failing cannot hide the other's waiting decisions.
  const [pendingDecisions, setPendingDecisions] = useState({ privacy: 0, watches: 0 });

  async function refreshPendingDecisions() {
    const [answers, watches] = await Promise.allSettled([
      listPrivacyApprovals({ status: "pending", limit: 1 }),
      experimental
        ? listSubscriptionApprovals({ status: "pending", limit: 1 })
        : Promise.resolve(null),
    ]);
    // A gateway without the privacy boundary answers 503. A badge is not
    // worth surfacing an error over; a failed count keeps its last value and
    // the next tick retries.
    setPendingDecisions((current) => ({
      privacy: answers.status === "fulfilled" ? answers.value?.totalCount ?? 0 : current.privacy,
      watches: watches.status === "fulfilled" ? watches.value?.totalCount ?? 0 : current.watches,
    }));
  }

  // Count once on arrival — polling alone would leave a waiting decision
  // unbadged for a whole interval — and again when /status resolves, since
  // whether watch requests count at all depends on what it reports.
  useEffect(() => { refreshPendingDecisions(); }, [experimental]);
  useVisiblePoll(refreshPendingDecisions, PRIVACY_PENDING_POLL_MS);

  async function refreshGatewayStatus() {
    const generation = ++statusRequestGeneration.current;
    try {
      const status = await getStatus();
      if (generation !== statusRequestGeneration.current) return;
      setExperimental(status?.experimental === true);
      setDeveloper(status?.developer === true);
      const nextReleaseUpdate = releaseUpdateFromStatus(status);
      setReleaseUpdate((current) =>
        current?.currentVersion === nextReleaseUpdate?.currentVersion &&
        current?.latestVersion === nextReleaseUpdate?.latestVersion
          ? current
          : nextReleaseUpdate,
      );
      const ttlMs = status?.conversationViewingTtlMs;
      if (typeof ttlMs === "number" && ttlMs > 0) {
        setSeenRefreshMs(Math.max(5_000, Math.floor(ttlMs / 2)));
      }
    } catch {
      // Best-effort — retain the last successful status snapshot.
    }
  }

  useEffect(() => {
    refreshGatewayStatus();
    return () => {
      statusRequestGeneration.current += 1;
    };
  }, []);
  useVisiblePoll(refreshGatewayStatus, RELEASE_STATUS_POLL_MS);

  useEffect(() => {
    return onRouteChange(() => setRoute(parseRoute()));
  }, []);

  // A route the parser resolved from a retired path renders its current view
  // straight away and rewrites the address bar to match. `replaceUrl` rather
  // than `navigate` so Back leaves the portal instead of bouncing between the
  // old and new spelling of the same page.
  useEffect(() => {
    if (route.redirectTo) replaceUrl(route.redirectTo);
  }, [route.redirectTo]);

  useEffect(() => {
    // Mirror the URL into activeConvoId on any explicit navigation.
    if (route.view === "agent" && route.convoId) setActiveConvoId(route.convoId);
    if (route.view !== "agent") setActiveConvoId(null);
  }, [route.view, route.convoId]);

  useEffect(() => {
    const onActive = (e) => setActiveConvoId(e.detail?.id ?? null);
    window.addEventListener("omnesis:agent-active-convo", onActive);
    return () => window.removeEventListener("omnesis:agent-active-convo", onActive);
  }, []);

  // Tell the gateway which conversation is actually on screen, so it clears
  // that conversation's unread marker on every surface and knows not to treat
  // an answer arriving here as something the operator missed. `activeConvoId`
  // is the shell's own answer to "what is being rendered", so this is the one
  // place that has to say it.
  //
  // The mark is repeated while the tab is visible: the gateway stops believing
  // an unrefreshed mark after a couple of minutes, which is what makes a
  // killed browser stop suppressing notifications. Leaving the conversation —
  // navigating away, hiding the tab, closing it — withdraws the mark straight
  // away rather than waiting for that timeout.
  useEffect(() => {
    if (!activeConvoId) return undefined;
    const id = activeConvoId;
    const mark = (viewing) => {
      apiFetch(`/agent/conversations/${encodeURIComponent(id)}/seen`, {
        method: "POST",
        body: JSON.stringify({ viewing }),
        // A withdrawal is often the last thing a closing tab does; let it
        // outlive the page rather than being cancelled on unload.
        keepalive: !viewing,
      }).catch(() => {
        // A badge is not worth surfacing an error over; the next mark retries.
      });
    };
    // Only a tab the operator can actually see is reading anything. A shell
    // that mounts hidden — a restored session, a background reload, a
    // cmd-clicked link — must not clear a dot for a conversation nobody has
    // looked at; the visibility listener marks it the moment the tab surfaces.
    if (!document.hidden) mark(true);
    const timer = setInterval(() => {
      if (!document.hidden) mark(true);
    }, seenRefreshMs);
    const onVisibility = () => mark(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      mark(false);
    };
  }, [activeConvoId, seenRefreshMs]);

  // Nothing else tells the shell that a conversation went unread: the agent
  // view's change event only fires for the session this tab is streaming, and
  // the sidebar holds no socket of its own. Without this poll the headline
  // case — the agent opening a thread on its own while the operator is on
  // another page — would show no dot until they navigated to the agent view.
  // Only while the tab is visible, and re-checked the moment it surfaces.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) conversationPage.reload();
    };
    const timer = setInterval(refresh, CONVERSATION_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [conversationPage.reload]);

  useEffect(() => {
    // Single-source signal from `apiFetch` — any 401 from any view's
    // polling timer flips this once and the app overlays a re-login
    // banner instead of letting every banner show "Foo failed: 401".
    const onExpired = () => setSessionExpired(true);
    window.addEventListener("omnesis:session-expired", onExpired);
    return () => window.removeEventListener("omnesis:session-expired", onExpired);
  }, []);

  // App-level conversations list — surfaced in the sidebar so the user can
  // jump between past agent conversations from any page. Cursor ownership,
  // stale-response rejection and row de-duplication live in useCursorPage.
  // The agent view dispatches `omnesis:conversations-changed` after creating,
  // deleting, or completing a turn so the page resets to a fresh snapshot.
  //
  // We hit `/agent/conversations` directly via `apiFetch` rather than
  // instantiating a second `createAgentClient()` — that helper opens a
  // shared SSE connection to `/agent/events`, and running two clients
  // (one here, one in the agent view) made event delivery flaky.
  useEffect(() => {
    const onChange = () => conversationPage.reload();
    window.addEventListener("omnesis:conversations-changed", onChange);
    return () => window.removeEventListener("omnesis:conversations-changed", onChange);
  }, [conversationPage.reload]);

  // Close the row menu on outside click or Escape. Bound only while a
  // menu is actually open so we're not eating every document click.
  useEffect(() => {
    if (menuOpenId == null) return;
    const onDown = (e) => {
      if (menuRootRef.current && menuRootRef.current.contains(e.target)) return;
      setMenuOpenId(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpenId(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpenId]);

  const handleDeleteConvo = async (id) => {
    setMenuOpenId(null);
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    const removedIndex = conversationPage.items.findIndex((conversation) => conversation.id === id);
    const removedConversation = conversationPage.items[removedIndex];
    try {
      await deleteSidebarConversation({
        id,
        activeConversationId: activeConvoId,
        request: apiFetch,
        removeConversation: conversationPage.removeItem,
        restoreConversation: (deletedId) => {
          if (removedConversation) {
            conversationPage.restoreItem(deletedId, removedConversation, removedIndex);
          }
        },
        onActiveDeleted: () => {
          setActiveConvoId(null);
          navigate("/portal/agent");
        },
      });
    } catch (err) {
      console.error("[portal] failed to delete conversation", err);
      alert(`Couldn't delete conversation: ${err.message ?? String(err)}`);
    }
  };

  const handleTogglePin = async (id, pinned) => {
    setMenuOpenId(null);
    try {
      const res = await apiFetch(`/agent/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error("[portal] failed to update conversation pin", err);
      alert(`Couldn't ${pinned ? "pin" : "unpin"} conversation: ${err.message ?? String(err)}`);
      return;
    }
    // Optimistically reflect the new pin state; the broadcast then triggers
    // the canonical refetch, which returns the list re-sorted pinned-first.
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, pinned } : c)));
    window.dispatchEvent(new Event("omnesis:conversations-changed"));
  };

  const handleThemeToggle = () => {
    setThemeState(toggleTheme());
  };

  const handleLogout = async () => {
    await logout();
    // Wipe per-user caches (search results, SQL history, …) before the
    // login form re-renders, so the next sign-in on this machine starts
    // from a clean slate.
    clearOmnesisStorage();
    window.location.reload();
  };

  if (sessionExpired) {
    return html`<${LoginView} reason="Your session expired. Log in again to continue." />`;
  }

  // A client opened this window to ask one question, so it gets one question.
  // `completion=portal` is set only by the OAuth consent redirect — reaching
  // the same request from the Access list carries no such flag and keeps the
  // whole portal, because that reader is browsing rather than deciding.
  if (route.view === "settings" && route.accessAuthorizationId && route.completeAccessInPortal) {
    return html`
      <div class="consent-layout">
        <div class="consent-brand">
          <span class="omnesis-mark" style="width:28px;height:28px" aria-hidden="true"></span>
          <span>OMNESIS</span>
        </div>
        <main class="consent-main">
          <${AccessView}
            authorizationId=${route.accessAuthorizationId}
            completeInPortal
          />
        </main>
      </div>
    `;
  }

  return html`
    <div class="app-layout">
      <aside class="app-sidebar">
        <a class="sidebar-brand" href="/portal/" onClick=${(e) => { e.preventDefault(); navigate("/portal/"); }}>
          <span class="omnesis-mark" style="width:32px;height:32px" aria-hidden="true"></span>
          <div class="sidebar-brand-text">
            <span class="sidebar-brand-name">OMNESIS</span>
            <span class="sidebar-brand-sub">Personal index</span>
          </div>
        </a>

        <nav class="sidebar-nav">
          ${NAV_ITEMS.filter((item) => !item.experimental || experimental).map((item) => {
            // "Ask" (the agent landing) is special: it navigates AND
            // dispatches the fresh-session event, so clicking it from
            // inside an existing conversation drops back to a hero
            // composer (and clicking it while already on the hero resets
            // to a brand-new empty session).
            const isActive = route.view === item.view && !(item.isNewConvo && activeConvoId);
            const pending = pendingDecisions[item.view] ?? 0;
            return html`
              <a
                key=${item.view}
                class=${isActive ? "sidebar-item active" : "sidebar-item"}
                href=${item.href}
                onClick=${(e) => {
                  e.preventDefault();
                  navigate(item.href);
                  if (item.isNewConvo) {
                    window.dispatchEvent(new CustomEvent("omnesis:new-conversation"));
                  }
                }}
              >
                <span class="sidebar-icon">${ICONS[item.icon]}</span>
                <span class="sidebar-label">${item.label}</span>
                ${pending > 0
                  ? html`<span class="sidebar-badge" aria-hidden="true">${pending > 99 ? "99+" : pending}</span
                      ><span class="sr-only">${pending} ${pending === 1 ? "decision" : "decisions"} waiting for you. </span>`
                  : null}
              </a>
            `;
          })}
        </nav>

        <${FleetHostUpdate} releaseUpdate=${releaseUpdate} />

        <div class="sidebar-convos" ref=${menuRootRef}>
          <div class="sidebar-convos-list">
            ${conversations.length === 0 && !conversationPage.error
              ? html`<div class="sidebar-convos-empty">
                  ${conversationPage.loading ? "Loading conversations…" : "No conversations yet."}
                </div>`
              : orderConversations(conversations).map((c) => {
                const isActive = activeConvoId === c.id;
                const isMenuOpen = menuOpenId === c.id;
                // The conversation on screen has been read by definition, so
                // it drops its dot immediately rather than waiting for the
                // next list refetch to say what the gateway already knows.
                const isUnread = c.unread === true && !isActive;
                return html`
                  <div
                    key=${c.id}
                    class=${`sidebar-convo-row${isActive ? " active" : ""}${isMenuOpen ? " menu-open" : ""}${c.pinned ? " pinned" : ""}`}
                  >
                    <a
                      class="sidebar-convo-item"
                      href=${`/portal/agent/${encodeURIComponent(c.id)}`}
                      onClick=${(e) => { e.preventDefault(); navigate(`/portal/agent/${encodeURIComponent(c.id)}`); }}
                      title=${c.title || "(untitled)"}
                    >
                      ${isUnread
                        ? html`<span class="sidebar-convo-unread" aria-hidden="true"></span
                            ><span class="sr-only">Unread. </span>`
                        : null}
                      ${c.pinned
                        ? html`<span class="sidebar-convo-pin" aria-label="Pinned" title="Pinned">${PIN_ICON}</span>`
                        : null}
                      <span class=${`sidebar-convo-title${isUnread ? " unread" : ""}`}>${c.title || "(untitled)"}</span>
                    </a>
                    <button
                      class="sidebar-convo-actions"
                      type="button"
                      aria-label="Conversation options"
                      aria-haspopup="menu"
                      aria-expanded=${isMenuOpen}
                      title="More"
                      onClick=${(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuOpenId(isMenuOpen ? null : c.id);
                      }}
                    >
                      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <circle cx="3" cy="8" r="1.4"/>
                        <circle cx="8" cy="8" r="1.4"/>
                        <circle cx="13" cy="8" r="1.4"/>
                      </svg>
                    </button>
                    ${isMenuOpen
                      ? html`
                        <div class="sidebar-convo-menu" role="menu">
                          <button
                            class="sidebar-convo-menu-item"
                            type="button"
                            role="menuitem"
                            onClick=${(e) => { e.preventDefault(); e.stopPropagation(); handleTogglePin(c.id, !c.pinned); }}
                          >
                            ${PIN_ICON}
                            <span>${c.pinned ? "Unpin" : "Pin"}</span>
                          </button>
                          <button
                            class="sidebar-convo-menu-item destructive"
                            type="button"
                            role="menuitem"
                            onClick=${(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteConvo(c.id); }}
                          >
                            <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M3 4h10"/>
                              <path d="M5 4V2.5h6V4"/>
                              <path d="M4.5 4l.5 9.5h6l.5-9.5"/>
                              <path d="M6.5 6.5v5M9.5 6.5v5"/>
                            </svg>
                            <span>Delete</span>
                          </button>
                        </div>
                      `
                      : null}
                  </div>
                `;
              })}
            <${LoadMore}
              hasMore=${conversationPage.hasMore || Boolean(conversationPage.error)}
              loading=${conversationPage.loading || conversationPage.loadingMore}
              error=${conversationPage.loadMoreError ?? conversationPage.error}
              onLoadMore=${conversationPage.error
                ? conversationPage.reload
                : conversationPage.loadMore}
              label="Load older conversations"
              className="sidebar-convos-pager"
            />
          </div>
        </div>

      </aside>

      <main class="app-main">
        ${route.view === "document"
          ? html`<${DocumentView} id=${route.id} experimental=${experimental} />`
          : route.view === "people"
          ? html`<${PeopleView} personId=${route.personId} tab=${route.tab} initialQuery=${route.query} experimental=${experimental} />`
          : route.view === "sources"
          ? html`<${SourcesView} />`
          : route.view === "source-recent"
          ? html`<${SourceRecentView} sourceId=${route.sourceId} />`
          : route.view === "settings"
          ? html`<${SettingsView}
              tab=${route.tab}
              modelsSection=${route.modelsSection}
              accessAuthorizationId=${route.accessAuthorizationId}
              accessLevelId=${route.accessLevelId}
              accessNewLevel=${route.accessNewLevel}
              accessConnect=${route.accessConnect}
              pair=${route.pair ?? null}
              device=${route.device ?? null}
              policyId=${route.policyId}
              completeAccessInPortal=${route.completeAccessInPortal}
              experimental=${experimental}
              theme=${theme}
              onThemeToggle=${handleThemeToggle}
              onLogout=${handleLogout}
            />`
          : route.view === "capture"
          ? html`<${CaptureView} day=${route.day ?? null} />`
          : route.view === "privacy"
          ? html`<${PrivacyView}
              approvalId=${route.approvalId}
              conversationId=${route.conversationId}
              taskId=${route.taskId}
              directTab=${route.directTab ?? false}
              directSessionId=${route.directSessionId ?? null}
            />`
          : route.view === "watches" && experimental
          ? html`<${WatchesView}
              watchApprovalId=${route.watchApprovalId}
              watchId=${route.watchId}
              watchFiringId=${route.watchFiringId}
            />`
          : route.view === "debug"
          ? html`<${DebugView} tab=${route.tab} graphParams=${route.graph} dataParams=${route.data} sqlParams=${route.sql} experimental=${experimental} developer=${developer} cognitionTab=${route.cognitionTab} cognitionId=${route.cognitionId} watchDebugId=${route.watchDebugId} watchDebugSeq=${route.watchDebugSeq} />`
          : route.view === "agent"
          ? html`<${AgentView} convoId=${route.convoId} experimental=${experimental} developer=${developer} />`
          : html`<${SearchView} />`
        }
      </main>
      <${DevAnnotationButton} route=${route} developer=${developer} activeConvoId=${activeConvoId} />
      ${developer ? html`<${DevAnnotationComposer} />` : null}
    </div>
  `;
}

// One-click sign-in via `?token=…` query param. Used by the demo gateway
// boot script so opening the printed URL drops you straight into the portal
// (no pairing code copy-paste). The param is consumed and stripped from the
// URL via history.replaceState so it doesn't leak via reload or share.
async function consumeUrlToken() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.toString());
  try {
    await login(token);
  } catch {
    // Fall through — checkSession() will then surface the login view and
    // the user can paste the token by hand.
  }
}

// Check session, prefetch icons, then render
async function init() {
  await consumeUrlToken();
  const session = await checkSession();
  await loadSourceMeta();

  if (session.authenticated) {
    render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`, document.getElementById("app"));
  } else {
    render(html`<${ErrorBoundary}><${LoginView} /></${ErrorBoundary}>`, document.getElementById("app"));
  }
}

init();
