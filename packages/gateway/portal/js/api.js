// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { portalDeviceName, portalInstallId } from "./lib/storage.js";
import { NOTES_HISTORY_PAGE_SIZE } from "./lib/notes.js";

// Session state
let _authenticated = false;
let _scope = null;
let _csrfToken = null;

/**
 * 401 (session expired) handling — every API call funnels through
 * `apiFetch` (called inside `request` below). When the gateway returns
 * 401 we clear local auth state and dispatch a `omnesis:session-expired`
 * CustomEvent on `window` so app.js can swap in the login view (instead
 * of letting every polling timer push a stream of identical-looking
 * errors). Callers still get the Response back and their normal `!res.ok`
 * paths run — the one-shot side effect is in addition to, not in place
 * of, the existing error envelope.
 */
const SESSION_EXPIRED_EVENT = "omnesis:session-expired";
let _sessionExpiredFired = false;

function fireSessionExpired() {
  if (_sessionExpiredFired) return;
  _sessionExpiredFired = true;
  _authenticated = false;
  _scope = null;
  _csrfToken = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

function resetSessionExpired() {
  _sessionExpiredFired = false;
}

/**
 * Single fetch wrapper for every portal API call. Adds
 * `credentials: same-origin` by default, sets the JSON content-type
 * unless overridden, and detects 401 to dispatch the session-expired
 * event. Callers continue to inspect `res.ok` and parse the body
 * themselves — this is the layer underneath `request()` below, used
 * directly by the few view-local fetches (e.g. `search` with its
 * custom error-message extraction) that opt out of the consolidated
 * helper.
 */
export async function apiFetch(input, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (_csrfToken && unsafe && isSameOriginInput(input)) {
    headers["X-Omnesis-CSRF"] = _csrfToken;
  }
  const merged = {
    credentials: "same-origin",
    ...init,
    headers,
  };
  const res = await fetch(input, merged);
  if (res.status === 401) fireSessionExpired();
  return res;
}

function isSameOriginInput(input) {
  const raw = typeof input === "string" ? input : input?.url;
  if (!raw) return false;
  if (typeof window === "undefined") return raw.startsWith("/") && !raw.startsWith("//");
  try {
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Check if the portal has an active session.
 * Returns { authenticated, scope }
 */
export async function checkSession() {
  // The 401 path on /portal/api/session is "no session" — that's
  // expected on first paint, not a session that just expired. Use raw
  // fetch so we don't trip the session-expired event before the user
  // has even logged in.
  const res = await fetch("/portal/api/session", { credentials: "same-origin" });
  const data = await res.json();
  _authenticated = data.authenticated;
  _scope = data.scope ?? null;
  _csrfToken = data.authenticated ? (data.csrfToken ?? null) : null;
  if (data.authenticated) resetSessionExpired();
  return data;
}

/**
 * Log in with an API token.
 * Returns { ok, scope } on success, { error } on failure.
 */
export async function login(token) {
  const res = await fetch("/portal/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    // `deviceName` gives a nameless portal pairing a stable per-browser device
    // identity so two browsers don't collapse onto one `portal` row and evict
    // each other's session. Ignored for token logins / admin-named codes.
    body: JSON.stringify({
      token,
      deviceName: portalDeviceName(),
      installId: portalInstallId() ?? undefined,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    _authenticated = true;
    _scope = data.scope;
    _csrfToken = data.csrfToken ?? null;
    resetSessionExpired();
  }
  return data;
}

/**
 * Log out (clear session cookie).
 */
export async function logout() {
  await fetch("/portal/api/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  _authenticated = false;
  _scope = null;
  _csrfToken = null;
}

export function isAuthenticated() {
  return _authenticated;
}

export function getScope() {
  return _scope;
}

// --- API calls (use cookies for auth) ---

const fetchOpts = (init = {}) => ({ credentials: "same-origin", ...init });

/**
 * Generic JSON request helper. Most named exports below are one-liners
 * that delegate here — they exist for type/autocomplete affordance and
 * to keep view code path-free.
 *
 * - `opts.body` is JSON-encoded automatically; the Content-Type header
 *   is set when a body is present.
 * - `opts.query` is a `Record<string, string | number | boolean>` that
 *   gets URL-encoded and appended as `?k=v&...`. `null` / `undefined`
 *   entries are skipped so callers can pass optional filters straight
 *   through.
 * - `opts.raw` returns the `Response` itself instead of `.json()` —
 *   used by `getAdminConfigRaw()` which wants `.text()`.
 * - `opts.csrf` also sends the portal synchronizer token on a safe request.
 *   This is reserved for boundaries that require proof of a browser session
 *   even for their read/plan endpoint.
 *
 * On non-2xx the helper throws an Error with:
 *   - `.status`     — the HTTP status code, for callers that branch on
 *                     401 vs 5xx (e.g. session redirect logic).
 *   - `.requestId`  — the gateway's `X-Request-Id` correlation id, so
 *                     view-level error banners can surface it for
 *                     bug reports / log lookups.
 *   - `.code`       — the gateway's machine-readable refusal code, when
 *                     the body is a `{ error, code }` envelope.
 *   - `.serverMessage` — the envelope's `error` sentence, for surfaces
 *                     that show the operator what went wrong rather than
 *                     the request line (absent on a non-JSON body).
 *   - error message — `"<METHOD> <PATH> → <status>: <body-preview>"`
 *                     (body capped at 200 chars so the toast stays
 *                     readable).
 */
async function request(method, path, opts = {}) {
  const init = {
    method,
    ...(opts.cache ? { cache: opts.cache } : {}),
    headers:
      opts.body !== undefined || (opts.csrf && _csrfToken)
        ? {
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.csrf && _csrfToken ? { "X-Omnesis-CSRF": _csrfToken } : {}),
          }
        : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };
  let url = path;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url = `${path}?${qs}`;
  }
  // Route through `apiFetch` (not raw `fetch`) so the centralised 401
  // → session-expired event still fires for every consolidated call.
  const res = await apiFetch(url, init);
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore — non-JSON / consumed body */ }
    const err = new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    err.status = res.status;
    err.requestId = res.headers.get("X-Request-Id") || undefined;
    try {
      const envelope = JSON.parse(detail);
      if (typeof envelope?.code === "string") err.code = envelope.code;
      // The gateway's own sentence about what went wrong, for surfaces that
      // show the operator a message rather than the request line.
      if (typeof envelope?.error === "string") err.serverMessage = envelope.error;
    } catch {
      // Non-JSON error bodies still use the status/message contract above.
    }
    throw err;
  }
  if (opts.raw) return res;
  // A 204 carries no body by definition — res.json() would throw on the
  // empty stream and turn a success (e.g. note delete) into a reported
  // failure. Every other 2xx carries the JSON envelope as before.
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Search has a custom error policy: the gateway returns
 * `{ error, message? }` on 4xx/5xx, and the user wants to see
 * "embedQuery timed out after 30000ms" in the UI rather than a bare
 * "POST /search → 500". Hand-rolled so we can pull `.message` /
 * `.error` out of the JSON body before throwing.
 */
export async function search(text, { verbose = false, limit = 30 } = {}) {
  const body = { text, verbose, limit };
  const res = await fetch("/search", {
    method: "POST",
    ...fetchOpts(),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.message || body?.error || "";
    } catch { /* non-JSON body — fall through */ }
    const err = new Error(detail ? `${detail} (HTTP ${res.status})` : `Search failed: ${res.status}`);
    err.status = res.status;
    err.requestId = res.headers.get("X-Request-Id") || undefined;
    throw err;
  }
  return res.json();
}

/**
 * GET /search/readiness — indexer worker status.
 * Returned shape: `{ indexer: { status, reason?, message? } }`.
 * Used by the Search view to render a "warming up" banner while the
 * embedder loads, so a search started during the ~15s cold-start
 * window doesn't silently fall back to BM25-only.
 */
export const getSearchReadiness = () => request("GET", "/search/readiness");

/**
 * GET /status — system-wide snapshot (document counts per source, index
 * status, DB size, uptime, etc.). Used by the search view to pick a
 * real source ID for the syntax-help examples — without a corpus-aware
 * anchor the help reads "from:alice@example.com" forever, which the
 * user explicitly didn't want.
 */
export const getStatus = () => request("GET", "/status");

export const getDocument = (id) => request("GET", `/documents/${encodeURIComponent(id)}`);

// Delete a single document from the corpus for privacy (#1065). The gateway
// also removes its attachment children. By default it writes a durable
// tombstone so a re-sync / re-capture can't bring the document back; with
// `keepCopy` only this copy goes and the source may bring it back.
export const deleteDocument = (id, { keepCopy = false } = {}) =>
  request(
    "DELETE",
    `/documents/${encodeURIComponent(id)}${keepCopy ? "?tombstone=0" : ""}`,
  );

// Quick capture ("Tell Omnesis"): one note into the built-in Omnesis Notes
// source. Always mounted on the gateway — capture needs neither an agent
// model nor experimental mode. The body is built by `views/capture.js`.
export const createNote = (body) => request("POST", "/notes", { body });

// Newest-first note history for the Tell Omnesis manager
// (`GET /notes/history`): bounded server pages over a stable
// (`captured_at`, id) order. `day` seeds the first page at that day so a
// Manage-notes link from an old daily document lands on relevant notes.
export const getNotesHistory = ({ limit = NOTES_HISTORY_PAGE_SIZE, cursor, day } = {}) =>
  request("GET", "/notes/history", { query: { limit, cursor, day } });

// Amend / remove one original note. The day's generated search document
// rebuilds from the remaining entries (or is dropped when empty).
export const patchNoteEntry = (id, text) =>
  request("PATCH", `/notes/${encodeURIComponent(id)}`, { body: { text } });
export const deleteNoteEntry = (id) =>
  request("DELETE", `/notes/${encodeURIComponent(id)}`);

// Developer annotations (gateway OMNESIS_DEV_MODE). The route 404s when dev
// mode is off; the floating capture button is only shown when /status reports
// `developer`, so this is reached only in developer mode. Reads happen via the
// `omnesis dev-annotations` CLI, so the portal only writes.
export const createDevAnnotation = (body) => request("POST", "/dev/annotations", { body });

export const querySqlite = (sql) => request("POST", "/sql", { body: { sql } });

export const queryDuckdb = (sql) => request("POST", "/analytics/sql", { body: { sql } });

export const getDocumentRefs = (id) => request("GET", `/documents/${encodeURIComponent(id)}/refs`);
export const getDocumentInboundRefs = (id, { limit = 25, cursor } = {}) =>
  request("GET", `/documents/${encodeURIComponent(id)}/refs/inbound`, {
    query: { limit, cursor },
  });
export const getDocumentOutboundRefs = (id, { limit = 25, cursor } = {}) =>
  request("GET", `/documents/${encodeURIComponent(id)}/refs/outbound`, {
    query: { limit, cursor },
  });

/**
 * Resolve source URLs to internal document ids via the gateway's
 * canonicalizer. Mirrors what `omnesis lookup <url>` does on the CLI.
 * Returns `{ matches: Record<url, documentId[]> }` — each input URL is
 * a key and the value is the list of documents whose canonical
 * `metadata.sourceUrl` matches (usually 0 or 1, occasionally more
 * when the same URL is shared by an email + its forwarded copy).
 */
export const lookupDocumentsByUrl = (urls) =>
  request("POST", "/documents/by-url", { body: { urls } });

/**
 * Multi-edge-type subgraph around one document — feeds the portal's
 * graph-debug page (`/portal/debug/graph`) and the document-detail
 * timeline tab. Walks every edge in
 * `document_links`, `near_dup_edges`, and `document_people` regardless
 * of type / role, capped by `depth` (default 10 server-side).
 */
export const getDocumentGraph = (seedIds, depth, fanoutCap) => {
  // The route's path `:id` is always the first seed; extras travel via
  // `?seeds=…` (comma-joined). A single-seed call sends no `seeds=`
  // param and matches the legacy single-seed URL shape exactly.
  const [first, ...rest] = seedIds;
  return request("GET", `/documents/${encodeURIComponent(first)}/graph`, {
    query: {
      ...(rest.length > 0 ? { seeds: rest.join(",") } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(fanoutCap !== undefined ? { fanoutCap } : {}),
    },
  });
};

/** People payload is non-load-bearing: failure → empty list, no throw. */
export const getDocumentPeople = (id) =>
  request("GET", `/documents/${encodeURIComponent(id)}/people`).catch(() => ({ people: [] }));

/** Same defensive shape as getDocumentPeople — empty list on failure. */
export const getDocumentAttachments = (id) =>
  request("GET", `/documents/${encodeURIComponent(id)}/attachments`).catch(() => ({ attachments: [] }));

/**
 * Omnesis-derived dates extracted from a document's text, resolved against its
 * emission date (experimental). Non-load-bearing: failure → empty list, no throw.
 */
export const getDocumentDates = (id) =>
  request("GET", `/documents/${encodeURIComponent(id)}/dates`).catch(() => ({ dates: [] }));

/**
 * The background agent's durable LLM-derived observations about a document
 * (experimental). Non-load-bearing: failure → empty list, no throw.
 */
export const getDocumentAnnotations = (
  id,
  { limit = 20, cursor, includeDependents = false } = {},
) =>
  request("GET", `/documents/${encodeURIComponent(id)}/annotations`, {
    query: { limit, cursor, includeDependents: includeDependents ? "1" : "0" },
  }).catch((error) => {
    // The optional enrichment may be absent on an older gateway, but once a
    // cursor exists a failure is a real load-more error. Preserve it so the
    // paging footer can offer a retry instead of silently truncating history.
    if (cursor) throw error;
    return {
      annotations: [],
      pageInfo: { hasMore: false, limit },
    };
  });

/**
 * The background agent's durable LLM-derived observations about a PERSON
 * (experimental) — the self person's are the user's own "profile". Non-load-
 * bearing: failure → empty list, no throw.
 */
export const getPersonAnnotations = (
  id,
  { limit = 20, cursor, includeDependents = false } = {},
) =>
  request("GET", `/people/${encodeURIComponent(id)}/annotations`, {
    query: { limit, cursor, includeDependents: includeDependents ? "1" : "0" },
  }).catch((error) => {
    if (cursor) throw error;
    return {
      annotations: [],
      pageInfo: { hasMore: false, limit },
    };
  });

export const getAnnotationDependents = (
  store,
  id,
  { limit = 25, cursor } = {},
) =>
  request(
    "GET",
    `/admin/cognition/annotations/${encodeURIComponent(store)}/${encodeURIComponent(id)}/dependents`,
    { query: { limit, cursor } },
  );

/**
 * Near-duplicate edges for one document — feeds the "Similar" section
 * of the graph card. Same defensive shape: failure → empty list, never
 * surfaces as a thrown error since the section is optional.
 */
export const getDocumentNearDupes = (id, { limit = 20, cursor } = {}) =>
  request("GET", `/documents/${encodeURIComponent(id)}/near-dupes`, {
    query: { limit, ...(cursor ? { after: cursor } : {}) },
  }).catch((error) => {
    if (cursor) throw error;
    return {
      edges: [],
      nextCursor: null,
    };
  });

/**
 * Bulk lightweight resolved-people lookup, one round-trip for a list
 * of doc IDs (max 200). Returns { docs: { [docId]: { people, total } } }.
 * Used to render <PeopleBubbles> on document-list views without an
 * N+1 fetch storm. Failures (partial outage, oversized batch) are
 * swallowed into an empty map — the bubbles are a nice-to-have, not
 * load-bearing for the rest of the row.
 *
 * Hand-rolled because it auto-batches at 200 (the server's cap) and
 * swallows per-batch errors.
 */
export async function getDocumentsPeopleBulk(ids) {
  if (!ids || ids.length === 0) return { docs: {} };
  const out = { docs: {} };
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    try {
      const data = await request("POST", "/documents/people-bulk", { body: { ids: batch } });
      Object.assign(out.docs, data.docs ?? {});
    } catch { /* ignore — bubbles are optional */ }
  }
  return out;
}

/**
 * Bulk single-document fetch, one round-trip per 100-id batch (the
 * server caps at 100). Returns `{ docs: { [docId]: doc } }` — missing
 * IDs are simply absent from the map. Caller-decided whether to
 * surface partial failures; we do NOT swallow errors here.
 *
 * Used by PersonDetail to replace what was N parallel /documents/:id
 * round-trips per page.
 */
export async function getDocumentsBulk(ids) {
  if (!ids || ids.length === 0) return { docs: {} };
  const out = { docs: {} };
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await request("POST", "/documents/bulk", { body: { ids: batch } });
    Object.assign(out.docs, data.docs ?? {});
  }
  return out;
}

/** Lightweight linked-document hydration: title + source identity, never body/metadata. */
export async function getDocumentSummariesBulk(ids) {
  if (!ids || ids.length === 0) return { docs: {} };
  const out = { docs: {} };
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await request("POST", "/documents/bulk", { body: { ids: batch, summary: true } });
    Object.assign(out.docs, data.docs ?? {});
  }
  return out;
}

/**
 * People list — post-#330 the server returns `Page<T>` (`{items, pageInfo}`).
 * Tolerate both shapes during the cutover so the portal works against
 * either, then settle on `items` once the migration is complete.
 */
export async function getPeople(query = "", limit = 100, cursor, sort) {
  const data = await request("GET", "/people", {
    query: {
      limit,
      cursor,
      ...(query ? { q: query } : {}),
      ...(sort ? { sort } : {}),
    },
  });
  return { people: data.items ?? data.people ?? [], pageInfo: data.pageInfo };
}

export const getPerson = (id) => request("GET", `/people/${encodeURIComponent(id)}`);

/**
 * Server returns Page<{ id, roles[] }> — `{ items, pageInfo }` post-#330.
 * The cursor is opaque to the client even though the current gateway encodes
 * an offset in it.
 */
export const getPersonDocuments = (id, limit = 20, cursor = null) =>
  request("GET", `/people/${encodeURIComponent(id)}/documents`, {
    query: { limit, ...(cursor ? { cursor: String(cursor) } : {}) },
  });

export const getPeopleStats = () => request("GET", "/people/stats");

// --- Merge rules ---

/** Get merge rules touching a given person (active, both kinds). */
export const getMergeRulesForPerson = (id, query) =>
  request("GET", `/people/${encodeURIComponent(id)}/merge-rules`, { query });

/** List all merge rules with optional filters. resolve=true augments
 *  each rule with `resolvedSideA` / `resolvedSideB` person arrays so
 *  the portal can render clickable links to each side. details=true
 *  also fills `aliases` + `sourceIds` per resolved person — same
 *  rich payload the merge-candidates view consumes. preMerge=true
 *  resolves each side to the row that originally carried the alias
 *  (no merged_into walk), which is the right view for the rules page
 *  — the merge has already happened, so the canonical view collapses
 *  both sides to the same row. */
export function listMergeRules({ active, kind, resolve = false, details = false, preMerge = false } = {}) {
  const query = {};
  if (active !== undefined) query.active = active ? "1" : "0";
  if (kind) query.kind = kind;
  if (resolve) query.resolve = "1";
  if (details) query.details = "1";
  if (preMerge) query.preMerge = "1";
  return request("GET", "/people/merge-rules", { query });
}

/** Group-aware merge audit used by the paginated People > Rules surface. */
export const listMergeRuleGroups = ({ limit = 25, cursor, q, kind } = {}) =>
  request("GET", "/people/merge-rule-groups", {
    query: { limit, cursor, ...(q ? { q } : {}), ...(kind ? { kind } : {}) },
  });

/** Create a user merge rule. Returns { rule, created }. */
export const createMergeRule = ({ sideA, sideB, winnerSide, reason }) =>
  request("POST", "/people/merge-rules", { body: { sideA, sideB, winnerSide, reason } });

/** Permanently delete a merge rule by id. Returns { deleted }. */
export const deleteMergeRule = (id) =>
  request("DELETE", `/people/merge-rules/${encodeURIComponent(id)}`);

/** Undo a whole cluster merge: delete every rule sharing a group id.
 *  Returns { deleted } (rule count). */
export const deleteMergeRuleGroup = (groupId) =>
  request("DELETE", `/people/merge-rules/group/${encodeURIComponent(groupId)}`);

// --- Merge candidates ---

/** List merge candidates. status defaults to "pending". Returns
 *  { items: [...], pageInfo, counts: { pending, accepted, denied } }.
 *  Each candidate carries `resolvedSideA` / `resolvedSideB` for UI. */
export const listMergeCandidates = ({
  status = "pending",
  limit,
  clusterLimit,
  cursor,
  q,
} = {}) =>
  request("GET", "/people/merge-candidates", {
    query: {
      status,
      ...(limit !== undefined ? { limit } : {}),
      ...(clusterLimit !== undefined ? { clusterLimit } : {}),
      cursor,
      ...(q ? { q } : {}),
    },
  });

/** Deny a candidate. Idempotent. */
export const denyMergeCandidate = (id) =>
  request("POST", `/people/merge-candidates/${encodeURIComponent(id)}/deny`);

/** Merge a whole cluster: unify the given people via N-1 user rules.
 *  Body { personIds: string[], reason? }. */
export const mergeCluster = (personIds, { reason } = {}) =>
  request("POST", "/people/merge-candidates/merge-cluster", { body: { personIds, reason } });

// --- Catalog + activity (Debug page, Data tab) ---

export const getSqliteCatalog = () => request("GET", "/sqlite/catalog");
export const getSqliteTableInfo = (table) => request("GET", `/sqlite/catalog/${encodeURIComponent(table)}`);
export const getSqliteActivity = (table, days = 14) =>
  request("GET", `/sqlite/activity/${encodeURIComponent(table)}`, { query: { days } });

export const getAnalyticsCatalog = () => request("GET", "/analytics/catalog");
export const getAnalyticsTableInfo = (table) => request("GET", `/analytics/catalog/${encodeURIComponent(table)}`);
export const getAnalyticsActivity = (table, days = 14) =>
  request("GET", `/analytics/activity/${encodeURIComponent(table)}`, { query: { days } });

// --- Debug / metrics ---

/**
 * Pull the in-memory request + writer-queue metrics. Used by the
 * Debug view to render per-(route,caller) p50/p95/p99 plus current
 * writer-worker queue depth + a sparkline. `windowSeconds` selects
 * the trailing window (default 300 = 5 min, max 3600 = 1 h).
 */
export const getMetrics = (windowSeconds = 300) =>
  request("GET", "/admin/metrics", { query: { window: windowSeconds } });

/**
 * Pull the Scheduler snapshot — per-task p50/p95/p99/max execMs,
 * per-runner queue depth/age by priority, and the user-priority SLA
 * tracker (p50/p95/p99/p999, violations, count, budgetMs). Same
 * `windowSeconds` semantics as `getMetrics`.
 */
export const getSchedulerMetrics = (windowSeconds = 300) =>
  request("GET", "/admin/scheduler-metrics", { query: { window: windowSeconds } });

export const getProcessVitals = (windowSeconds = 300) =>
  request("GET", "/admin/process-vitals", { query: { window: windowSeconds } });

/**
 * Pull the BackgroundJobs snapshot — every long-running loop in the
 * gateway with its current state, progress, and last-tick stats. The
 * registry caches the snapshot on a 2s tick so calling this every 2s
 * from the portal is free.
 */
export const getBackgroundJobs = () => request("GET", "/admin/background-jobs");

/**
 * Run the gateway's self-diagnosis — the same report `omnesis doctor`
 * prints, in the same shape (`{ ok, summary, checks }`). The gateway folds
 * the check inputs from in-process state and runs the shared evaluator, so
 * this and the CLI agree by construction. Not free to poll: it walks the
 * config tree in a worker, so the Doctor tab loads it on demand.
 */
export const getDoctorReport = () => request("GET", "/admin/doctor");

// --- Cognition (read-only Cognition Steward debug surface) ---
// Every one of these is a GET against the `/admin/brain/*` read surface —
// the Cognition debug tab is strictly read-only, so there is no mutating
// counterpart here (no dismiss/wipe). All 404 unless the Briefs feature is
// active (experimental + a background-agent model assigned).

export const getCognitionLoops = (query) => request("GET", "/admin/brain/loops", { query });
export const getCognitionPulse = () => request("GET", "/admin/brain/pulse");
export const getCognitionLoop = (id, { includeChildren = true } = {}) =>
  request("GET", `/admin/brain/loops/${encodeURIComponent(id)}`, {
    query: includeChildren ? {} : { includeChildren: "0" },
  });
export const getCognitionLoopLedger = (id, query) =>
  request("GET", `/admin/brain/loops/${encodeURIComponent(id)}/ledger`, { query });
export const getCognitionLoopBriefs = (id, query) =>
  request("GET", `/admin/brain/loops/${encodeURIComponent(id)}/briefs`, { query });
export const getCognitionLoopScheduled = (id, query) =>
  request("GET", `/admin/brain/loops/${encodeURIComponent(id)}/scheduled`, { query });
export const getCognitionRunKinds = () => request("GET", "/admin/brain/run-kinds");
export const getCognitionRuns = (query) => request("GET", "/admin/brain/runs", { query });
export const getCognitionRun = (id) =>
  request("GET", `/admin/brain/runs/${encodeURIComponent(id)}`);
export const getCognitionTranscript = (fileName) =>
  request("GET", `/admin/brain/transcripts/${encodeURIComponent(fileName)}`);
export const getCognitionBriefs = (query) => request("GET", "/admin/brain/briefs", { query });
// Opens (or returns) the brief's talk-back thread; the caller then
// navigates to /agent/<conversationId>. Not part of the read-only
// /admin/brain family — it drives the user-facing POST /briefs/:id/thread.
export const openBriefThread = (id) =>
  request("POST", `/briefs/${encodeURIComponent(id)}/thread`);
export const getCognitionBrief = (id) =>
  request("GET", `/admin/brain/briefs/${encodeURIComponent(id)}`);
export const getCognitionNotes = () => request("GET", "/admin/brain/notes");

// --- Sweeps (the one WRITING surface under /admin/brain) ---
// The gateway ships a set of sweeps and the operator layers their own files
// over them under `<configDir>/sweeps`. Every mutation returns the whole
// resolved list, so the page never has to guess what a save did to the rest
// of the set (a fork changes an origin; a delete can resurrect a system
// sweep). Same feature gate as the rest of the family: 404 unless active.
export const getSweeps = () => request("GET", "/admin/brain/sweeps");
export const saveSweep = (id, body) =>
  request("PUT", `/admin/brain/sweeps/${encodeURIComponent(id)}`, { body });
export const forkSweep = (id) =>
  request("POST", `/admin/brain/sweeps/${encodeURIComponent(id)}/fork`);
export const setSweepEnabled = (id, enabled) =>
  request("POST", `/admin/brain/sweeps/${encodeURIComponent(id)}/enabled`, {
    body: { enabled },
  });
export const deleteSweepFile = (id) =>
  request("DELETE", `/admin/brain/sweeps/${encodeURIComponent(id)}`);
export const getCognitionRetiredLoops = (query) =>
  request("GET", "/admin/brain/retired-loops", { query });
export const getCognitionSpend = (query) => request("GET", "/admin/brain/spend", { query });
// Per-source coverage tallies — how much of each source's corpus the agent
// has reasoned over, per workflow. Reporting only; nothing selects on it.
// The retrospective lane's own state. Split in two because the halves cost
// different amounts: the status is key reads and indexed counts; the backlog is
// a corpus scan the gateway caches and dates. Pass `{ cached: 1 }` to read only
// what it already holds, so displaying the figure never triggers the scan.
export const getCognitionBootstrap = () => request("GET", "/admin/brain/bootstrap");

/**
 * Today's background-cognition spend against whatever ceiling is set.
 *
 * Tokens and runs only. The Brain reports no figure in currency anywhere: no
 * inference API it talks to exposes a price, so a number in money would be an
 * estimate the gateway cannot verify.
 */
export const getCognitionBudget = () => request("GET", "/admin/brain/budget");

/**
 * The corpus month by month — the picture of how far back the lane has read.
 * A grouped corpus scan, so it is served from a cache: pass `cached=1` to take
 * only what the gateway already holds.
 */
export const getCognitionBootstrapTimeline = (query) =>
  request("GET", "/admin/brain/bootstrap/timeline", { query });

/** Begin the retrospective backfill. Idempotent. */
export const startCognitionBootstrap = () =>
  request("POST", "/admin/brain/bootstrap/start");
export const getCognitionBootstrapBacklog = (query) =>
  request("GET", "/admin/brain/bootstrap/backlog", { query });

export const getCognitionCoverage = (query) =>
  request("GET", "/admin/brain/coverage", { query });
// Per-(day, mechanism, model) spend breakdown. Unlike the /admin/brain
// family this is NOT feature-gated — spend is passive accounting that
// exists even when briefs is off.
export const getCognitionMechanismSpend = (query) =>
  request("GET", "/admin/cognition/spend", { query });
// Measurement-only calibration report (reliability bins + ECE per artifact
// family). Ungated like the spend breakdown — a pure read over the durable
// stores; nothing recalibrates from it.
export const getCognitionCalibration = (query) =>
  request("GET", "/admin/cognition/calibration", { query });
export const getCognitionCalendarWindow = (query) =>
  request("GET", "/briefs/temporal/window", { query });
export const getCognitionCalendarAnnotation = (id, timeZone) =>
  request("GET", `/briefs/temporal/annotations/${encodeURIComponent(id)}`, {
    query: { timeZone },
  });

// --- Devices & tokens (admin) ---
// Gateway list endpoints return the canonical
// `Page<T>` envelope `{ items, pageInfo }`. Wrappers normalise to
// that shape so view code can always destructure `.items` regardless
// of which endpoint it consumes.

export async function listDevices() {
  const data = await request("GET", "/admin/devices");
  return { items: data.items ?? data.devices ?? [], pageInfo: data.pageInfo };
}

/**
 * Identity of the current portal session — `{ tokenId, deviceId, deviceName,
 * scopes }`. The devices view uses `deviceId` to pin the "This device" card.
 * `deviceId` is null for sessions not bound to a device.
 */
export const whoami = () => request("GET", "/whoami");

export const getNetworkIdentities = () => request("GET", "/admin/network-identities");

/**
 * A proposed operator identity inferred from a synced account, surfaced when no
 * canonical self exists yet. `{ candidate: { email, sourceId } | null }`.
 */
export const getSelfCandidate = () => request("GET", "/admin/self/candidate");

/**
 * Mint a pairing code for a device of `kind`. The gateway grants the kind's
 * canonical scopes; credentials with a custom grant are minted from the CLI.
 */
/**
 * Mint a pairing code. An integration also carries its name and, from this
 * portal session, the access level it is put on when the code is redeemed.
 */
export const pairDevice = ({ kind, repairDeviceId, name, accessLevelId }) =>
  request("POST", "/admin/devices/pair", {
    body: {
      kind,
      ...(repairDeviceId ? { repairDeviceId } : {}),
      ...(name ? { name } : {}),
      ...(accessLevelId ? { accessLevelId } : {}),
    },
  });

/**
 * The addresses the phone behind a pending pairing code can be given, judged
 * for that phone: `{ platform, addresses, recommendedUrl, awayFromHome }`.
 */
export const getPairAddresses = ({ pairingCode }) =>
  request("POST", "/admin/devices/pair-addresses", { body: { pairingCode } });

/** Build a pairing QR using system trust for configured public HTTPS origins. */
export const buildPairQrPayload = ({ pairingCode, gatewayUrl }) =>
  request("POST", "/admin/devices/pair-qr", {
    body: { pairingCode, gatewayUrl, trustMode: "auto" },
  });

export const revokeDevice = (deviceId, impactFingerprint) => {
  const impactQuery = impactFingerprint
    ? `?impactFingerprint=${encodeURIComponent(impactFingerprint)}`
    : "";
  return request("DELETE", `/admin/devices/${encodeURIComponent(deviceId)}${impactQuery}`).then(
    () => true,
  );
};

// Permanent delete of a revoked device's row. The gateway refuses while the
// device still hosts sources.
export const forgetDevice = (deviceId) =>
  request("DELETE", `/admin/devices/${encodeURIComponent(deviceId)}?forget=true`).then(() => true);

/** Withdraw one phone's relay consent and invalidate its opaque relay credential. */
export const withdrawRelayPushConsent = (deviceId) =>
  request(
    "DELETE",
    `/admin/devices/${encodeURIComponent(deviceId)}/push-relay-consent`,
  ).then(() => true);

/**
 * The version every commanded device is told to reach — the gateway's own.
 * Fetched once: it only changes when the gateway restarts on a new build.
 */
export const fleetUpdateTarget = () => request("GET", "/admin/fleet/target");

/** Read the latest per-device health-check state and completed reports. */
export const getFleetDoctor = () => request("GET", "/admin/fleet/doctor");

/**
 * Ask every applicable device, or an explicit subset, to run its local
 * diagnostics. An empty array is meaningful and must not turn into "all".
 */
export const requestFleetDoctor = (deviceIds) =>
  request("POST", "/admin/fleet/doctor", {
    body: deviceIds === undefined ? {} : { deviceIds },
  });

/**
 * Tell devices to update themselves to the gateway's version. Omitting
 * `deviceIds` means every device the plan says is commandable and behind.
 */
export const requestFleetUpdate = (deviceIds) =>
  request("POST", "/admin/fleet/update", { body: deviceIds ? { deviceIds } : {} });

/**
 * Plan or resume the gateway-first fleet update exposed by the release notice.
 * The response may carry a durable operation even when no newer release is
 * currently advertised, which lets the portal recover after the gateway
 * restarts in the middle of the update.
 */
export const getHostFleetUpdate = () =>
  request("GET", "/admin/fleet/host-update", { cache: "no-store", csrf: true });

/** Start only the opaque server plan the operator just reviewed. */
export const startHostFleetUpdate = (planId) =>
  request("POST", "/admin/fleet/host-update", { body: { planId } });

export async function listTokens(deviceId) {
  const data = await request("GET", "/admin/tokens", {
    query: deviceId ? { deviceId } : undefined,
  });
  return { items: data.items ?? data.tokens ?? [], pageInfo: data.pageInfo };
}

export const revokeTokenById = (id) =>
  request("DELETE", `/admin/tokens/${encodeURIComponent(id)}`).then(() => true);

// --- Delegated MCP access (Portal owner surface) ---

/** Every connection an agent holds on this gateway, with the access levels they can share. */
export const getAccessOverview = () =>
  request("GET", "/admin/access", { cache: "no-store" });

/**
 * Resolve the short code shown by an MCP client's authorization window: the
 * pending request, and the gateway's `connection` proposal for it — a default
 * name, the most relevant existing connection from the same app, and the
 * choice it recommends.
 */
export const lookupAccessAuthorization = (code) =>
  request("POST", "/portal/api/access/authorizations/lookup", { body: { code } });

/** Load a pending authorization (with its `connection` proposal) by its stable Portal detail URL. */
export const getAccessAuthorization = (approvalId) =>
  request(
    "GET",
    `/portal/api/access/authorizations/${encodeURIComponent(approvalId)}`,
    { cache: "no-store" },
  );

/** Approve or deny one pending OAuth authorization request. */
export const decideAccessAuthorization = (approvalId, body) =>
  request(
    "POST",
    `/portal/api/access/authorizations/${encodeURIComponent(approvalId)}/decision`,
    { body },
  );

/** Finish a browser-owned OAuth request and return its registered callback. */
export const completeAccessAuthorization = (approvalId) =>
  request(
    "POST",
    `/portal/api/access/authorizations/${encodeURIComponent(approvalId)}/complete`,
  );

/** Remove access: a connection is removed as `{ kind: "principal", id }` with every sign-in under it. */
export const revokeAccess = (kind, id) =>
  request("POST", "/portal/api/access/revoke", { body: { kind, id } });

/** Give a connection a new name; its permissions and sign-ins are untouched. */
export const renameAccessPrincipal = (principalId, name) =>
  request("PATCH", `/admin/access/principals/${encodeURIComponent(principalId)}`, {
    body: { name },
  });

/** Save a new access level from chosen rules: `{ name, rules }`. */
export const createAccessLevel = (body) =>
  request("POST", "/admin/access/levels", { body });

/**
 * Rename an access level or change its rules: `{ expectedRevision, name?, rules? }`
 * with at least one of `name` and `rules`. Its connections follow.
 */
export const updateAccessLevel = (levelId, body) =>
  request("PATCH", `/admin/access/levels/${encodeURIComponent(levelId)}`, { body });

/** Delete an access level no connection uses; refused as `level-in-use` otherwise. */
export const deleteAccessLevel = (levelId) =>
  request("DELETE", `/admin/access/levels/${encodeURIComponent(levelId)}`);

/**
 * Move a connection to another access level: `{ levelId, expectedLevelRevision }`
 * for an existing level, checked against the revision the owner was shown and
 * whose permissions replace the connection's, or `{ newLevel: { name } }` for a
 * new level copying the connection's current permissions.
 */
export const moveConnectionLevel = (connectionId, target, expectedGrantRevision) =>
  request("PUT", `/admin/access/connections/${encodeURIComponent(connectionId)}/level`, {
    body: { ...target, expectedGrantRevision },
  });

/**
 * Put a device on an access level, whose Answer rule then applies to what it
 * asks over `/answer`, or with `levelId: null` on none. The expected revision
 * refuses the change when the level changed since it was shown.
 */
export const setDeviceAccessLevel = (deviceId, levelId, expectedLevelRevision) =>
  request("PUT", `/admin/access/devices/${encodeURIComponent(deviceId)}/level`, {
    body: expectedLevelRevision === undefined ? { levelId } : { levelId, expectedLevelRevision },
  });

/**
 * Recent items for a source. Returns one of:
 *   { kind: "documents", documents: [...] }   — documents ordered newest-first
 *   { kind: "analytics", table, displayName, columns, columnDefs, rows } —
 *     fallback for pure-structured sources (Strava, Screen Time, Notion
 *     databases). `columnDefs` is the AnalyticsCatalogEntry.columns array,
 *     used by the portal DataTable for semantic link rendering.
 *   { kind: "empty" }                          — source has nothing yet
 */
export const getSourceRecent = (sourceId, limit = 25, cursor) =>
  request("GET", `/sources/${encodeURIComponent(sourceId)}/recent`, {
    query: { limit, cursor },
  });

// --- Sources (gateway admin API + sync status) ---

export async function getAdminSources() {
  // The canonical Page<T> shape — { items, pageInfo } — plus `pendingRemovals`,
  // the sources that have been removed but whose data is still being deleted.
  // Those have no `sources` row left to appear in `items`.
  const data = await request("GET", "/admin/sources");
  return {
    items: data.items ?? data.sources ?? [],
    pageInfo: data.pageInfo,
    pendingRemovals: data.pendingRemovals ?? [],
    internalSources: data.internalSources ?? [],
  };
}
export const getAdminSyncStatus = () => request("GET", "/admin/sync/status");
export const getOverallStatus = () => request("GET", "/status");
export const getIndexStats = () => request("GET", "/index/stats");

/**
 * Trigger a sync. A source one device syncs answers
 * `{ ok, result, deviceId }`; a source every member syncs on its own cursor
 * is triggered on each online member and answers
 * `{ ok, results: [{ deviceId, ok, triggered, skipped, disabled, error? }] }`.
 */
export const triggerSourceSync = (sourceId) =>
  request("POST", `/admin/sources/${encodeURIComponent(sourceId)}/sync`);

/**
 * Membership of a source several devices may contribute to. Both answer
 * `{ source, members }` with the full member list (owner first). A refusal's
 * `code` is one of SOURCE_ALREADY_HOSTED, DEVICE_CANNOT_HOST_TYPE,
 * LAST_MEMBER, DEVICE_NOT_MEMBER, DEVICE_REVOKED.
 */
export const joinSourceMember = (sourceId, deviceId, memberConfig) =>
  request("POST", `/admin/sources/${encodeURIComponent(sourceId)}/members`, {
    body: { deviceId, ...(memberConfig ? { memberConfig } : {}) },
  });

export const updateSourceMemberConfig = (sourceId, deviceId, configOverride) =>
  request(
    "PATCH",
    `/admin/sources/${encodeURIComponent(sourceId)}/members/${encodeURIComponent(deviceId)}`,
    { body: { configOverride } },
  );

/** Adopt the source descriptor's explicit contribution mode for stored data. */
export const enableSourceMultiDeviceMode = (sourceId, multiDeviceMode) =>
  request("PATCH", `/admin/sources/${encodeURIComponent(sourceId)}`, {
    body: { multiDeviceMode },
  });

/**
 * Move a source to another collector: the new host registers it and the old
 * one stops syncing it. Neither side's documents or on-disk credentials are
 * touched, so the new host authenticates for itself if the source needs a
 * sign-in. The exclusive counterpart of a join.
 */
export const moveSourceToDevice = (sourceId, deviceId) =>
  request("PATCH", `/admin/sources/${encodeURIComponent(sourceId)}`, { body: { deviceId } });

export const detachSourceMember = (sourceId, deviceId) =>
  request(
    "DELETE",
    `/admin/sources/${encodeURIComponent(sourceId)}/members/${encodeURIComponent(deviceId)}`,
  );

export const getSourceDebug = (sourceId) =>
  request("GET", `/admin/sources/${encodeURIComponent(sourceId)}/debug`);

export const getSourceWatermark = (sourceId) =>
  request("GET", "/admin/watermarks", { query: { sourceId } });

/**
 * Wipe a source's data and sync it again from scratch. Without `deviceId`
 * every document of the source goes; with one, only what that device holds —
 * its documents, analytics rows and cursor on a partitioned source, just its
 * cursor on a replicated one (siblings are untouched either way). Answers
 * `{ ok, scope: "source" | "stream" | "cursor", deviceIds }` — `scope` is what
 * was wiped, `deviceIds` the devices the sync command reached (empty when
 * none is online; the sync then waits for one). A refusal's `code` is
 * DEVICE_NOT_MEMBER or RESYNC_NOT_PER_DEVICE (a per-device resync on a
 * source whose mode has no per-device cursor).
 */
export const resyncSource = (sourceId, deviceId) =>
  request("POST", `/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
    body: deviceId ? { deviceId } : {},
  });

export const removeAdminSource = (sourceId) =>
  request("DELETE", `/admin/sources/${encodeURIComponent(sourceId)}`);

/**
 * Pause / resume sync for a source. Wire field is still `enabled` (legacy
 * name), but user-facing label is "pause"/"resume" — pausing keeps OAuth
 * tokens, cursor, and indexed data intact and just stops the sync timer.
 */
export const pauseSource = (sourceId) =>
  request("PATCH", `/admin/sources/${encodeURIComponent(sourceId)}`, { body: { enabled: false } });

export const resumeSource = (sourceId) =>
  request("PATCH", `/admin/sources/${encodeURIComponent(sourceId)}`, { body: { enabled: true } });

// --- Add Source flow (gateway admin API) ---

/**
 * Union across all online collectors. Each item carries `devices: [{id, name}]`
 * so the Add Source modal can route the selection to the right collector when
 * more than one advertises the same descriptor.
 */
export const getSourceDescriptorsUnion = () => request("GET", "/admin/source-descriptors");

export const getSourcesSnapshot = (deviceId) =>
  request("GET", "/admin/sources/snapshot", { query: deviceId ? { deviceId } : undefined });

// --- History import (#588): one-time bulk import from a local artifact ---
// Starts the import in the collector; progress streams back over the SSE
// endpoint (`/import-history/events`), consumed via EventSource in the modal.
export const startSourceHistoryImport = (id, values) =>
  request("POST", `/admin/sources/${encodeURIComponent(id)}/import-history`, { body: { values } });

export const cancelSourceHistoryImport = (id, flowId) =>
  request("POST", `/admin/sources/${encodeURIComponent(id)}/import-history/cancel`, {
    query: { flowId },
  });

export const discoverSourceAccounts = (descriptorId, deviceId) =>
  request("POST", "/admin/sources/discover", { body: { descriptorId, deviceId } });

export const validateSourceParam = ({ deviceId, descriptorId, paramName, value }) =>
  request("POST", "/admin/sources/validate-param", { body: { deviceId, descriptorId, paramName, value } });

export const resolveSourceAccount = ({ deviceId, descriptorId, params }) =>
  request("POST", "/admin/sources/resolve-account", { body: { deviceId, descriptorId, params } });

export const addSource = ({ deviceId, descriptorId, accountIds, params }) =>
  request("POST", "/admin/sources/add", { body: { deviceId, descriptorId, accountIds, params } });

// --- Config (unified omnesis.json) ---

export const getAdminConfig = () => request("GET", "/admin/config");

/**
 * Returns the raw text body, not JSON — the config view feeds this
 * straight into the JSON editor so it can preserve formatting /
 * comments the gateway might be tolerating.
 */
export const getAdminConfigRaw = async () => {
  const res = await request("GET", "/admin/config/raw", { raw: true });
  return res.text();
};

export const getAdminConfigStatus = () => request("GET", "/admin/config/status");

/**
 * Descriptor tree that drives the structured config form. Generated from
 * `omnesisConfigSchema` server-side, so the form stays in sync with the
 * schema without hand-editing fields. See `@omnesis/config` describe.
 */
export const getAdminConfigSchema = () => request("GET", "/admin/config/schema");

/**
 * Hand-rolled because config edits need the structured `{status, ok,
 * body}` triple even on failure — the editor surfaces the gateway's
 * validation errors inline rather than as a thrown banner.
 */
export async function patchAdminConfig(patch) {
  const res = await apiFetch("/admin/config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: data };
}

/** Same structured-failure shape as patchAdminConfig. */
export async function putAdminConfig(body) {
  const res = await apiFetch("/admin/config", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: data };
}

// --- OMNESIS.md (the operator's standing instructions to the agent) ---
// One file in the config dir, edited here or in a terminal editor. `updatedAt`
// is the concurrency token: pass back the one a read handed you and a save
// built on a version someone else has replaced comes back 409 instead of
// quietly winning.
export const getOperatorInstructions = () =>
  request("GET", "/admin/instructions", { cache: "no-store" });

export const saveOperatorInstructions = (content, expectedUpdatedAt) =>
  request("PUT", "/admin/instructions", {
    body: expectedUpdatedAt == null ? { content } : { content, expectedUpdatedAt },
  });

export const deleteOperatorInstructions = (expectedUpdatedAt) =>
  request("DELETE", "/admin/instructions", {
    body: expectedUpdatedAt == null ? {} : { expectedUpdatedAt },
  });

// --- Answer privacy boundary ---

const privacyRequest = (method, path, opts = {}) =>
  request(method, path, { ...opts, cache: "no-store" });

export const getPrivacyPolicyTemplates = () =>
  privacyRequest("GET", "/admin/privacy/policy/templates");

/** Named, reusable V2 privacy-policy families. */
export const listPrivacyPolicies = () => privacyRequest("GET", "/admin/privacy/policies");

export const createPrivacyPolicy = (body) =>
  privacyRequest("POST", "/admin/privacy/policies", { body });

export const getNamedPrivacyPolicy = (familyId) =>
  privacyRequest("GET", `/admin/privacy/policies/${encodeURIComponent(familyId)}`);

export const updateNamedPrivacyPolicy = (familyId, body) =>
  privacyRequest("PATCH", `/admin/privacy/policies/${encodeURIComponent(familyId)}`, { body });

export const getNamedPrivacyPolicyHistory = (familyId, { limit, beforeVersion } = {}) =>
  privacyRequest("GET", `/admin/privacy/policies/${encodeURIComponent(familyId)}/history`, {
    query: { limit, beforeVersion },
  });

export const getNamedPrivacyPolicyVersion = (familyId, version) =>
  privacyRequest(
    "GET",
    `/admin/privacy/policies/${encodeURIComponent(familyId)}/history/${encodeURIComponent(version)}`,
  );

export const restoreNamedPrivacyPolicy = (familyId, version, expectedRevision) =>
  privacyRequest("POST", `/admin/privacy/policies/${encodeURIComponent(familyId)}/restore`, {
    body: { version, expectedRevision },
  });

export const forkPrivacyPolicy = (familyId, body) =>
  privacyRequest("POST", `/admin/privacy/policies/${encodeURIComponent(familyId)}/fork`, { body });

export const getPrivacyReviewerHealth = () =>
  privacyRequest("GET", "/admin/privacy/reviewer-health");

// `totalCount` counts the whole ledger for the requested status, not the page,
// and the pending predicate excludes approvals that have already lapsed — so
// `limit: 1` is the cheapest way to ask "how many decisions are waiting?".
export const listPrivacyApprovals = ({ status = "pending", limit = 100, cursor } = {}) =>
  privacyRequest("GET", "/admin/privacy/approvals", {
    query: { status, limit, cursor },
  });

export const getPrivacyApproval = (approvalId) =>
  privacyRequest("GET", `/admin/privacy/approvals/${encodeURIComponent(approvalId)}`);

export const approvePrivacyApproval = (approvalId) =>
  privacyRequest("POST", `/admin/privacy/approvals/${encodeURIComponent(approvalId)}/approve`);

export const denyPrivacyApproval = (approvalId) =>
  privacyRequest("POST", `/admin/privacy/approvals/${encodeURIComponent(approvalId)}/deny`);

export const listSubscriptionApprovals = ({
  status = "pending",
  limit = 100,
  cursor,
} = {}) =>
  privacyRequest("GET", "/admin/privacy/subscription-approvals", {
    query: { status, limit, cursor },
  });

export const getSubscriptionApproval = (approvalId) =>
  privacyRequest(
    "GET",
    `/admin/privacy/subscription-approvals/${encodeURIComponent(approvalId)}`,
  );

export const resolveSubscriptionApproval = (approvalId, decision) =>
  privacyRequest(
    "POST",
    `/admin/privacy/subscription-approvals/${encodeURIComponent(approvalId)}/resolve`,
    { body: { decision } },
  );

export const approveSubscriptionApproval = (approvalId) =>
  resolveSubscriptionApproval(approvalId, "approve");

export const denySubscriptionApproval = (approvalId) =>
  resolveSubscriptionApproval(approvalId, "deny");

export const listPrivacySubscriptions = ({
  status = "all",
  limit = 50,
  cursor,
} = {}) =>
  privacyRequest("GET", "/admin/privacy/subscriptions", {
    query: { status, limit, cursor },
  });

export const getPrivacySubscription = (subscriptionId) =>
  privacyRequest(
    "GET",
    `/admin/privacy/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );

export const revokePrivacySubscription = (subscriptionId) =>
  privacyRequest(
    "POST",
    `/admin/privacy/subscriptions/${encodeURIComponent(subscriptionId)}/revoke`,
  );

export const purgePrivacySubscription = (subscriptionId) =>
  privacyRequest(
    "DELETE",
    `/admin/privacy/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );

export const listPrivacySubscriptionFirings = (
  subscriptionId,
  { limit = 50, cursor } = {},
) =>
  privacyRequest(
    "GET",
    `/admin/privacy/subscriptions/${encodeURIComponent(subscriptionId)}/firings`,
    { query: { limit, cursor } },
  );

export const getPrivacySubscriptionFiring = (subscriptionId, firingId) =>
  privacyRequest(
    "GET",
    `/admin/privacy/subscriptions/${encodeURIComponent(subscriptionId)}`
      + `/firings/${encodeURIComponent(firingId)}`,
  );

// --- Watch V2 (experimental) ---
//
// The runtime that evaluates the watches an operator asks for. A watch here is
// a definition installed in that runtime, not a subscription record: it crosses
// no egress boundary, so there is nothing to approve and nothing to revoke —
// only what it is, what it has said, and whether to keep it.
//
// The whole surface 404s when experimental mode is off, so a caller treats a
// miss as "this install has no such watch" rather than as an error.
const watchV2Request = (method, path, opts = {}) =>
  request(method, path, { ...opts, cache: "no-store" });

export const listWatchV2Watches = () => watchV2Request("GET", "/admin/watch/watches");

export const getWatchV2Watch = (watchId) =>
  watchV2Request("GET", `/admin/watch/watches/${encodeURIComponent(watchId)}`);

/**
 * What the runtime is holding for this watch, as of one moment.
 *
 * Refresh-on-demand: one call, one consistent snapshot. Nothing streams it, so
 * everything the page renders from a response describes the same instant.
 */
export const getWatchV2WatchState = (watchId) =>
  watchV2Request("GET", `/admin/watch/watches/${encodeURIComponent(watchId)}/state`);

export const listWatchV2Firings = (watchId, { limit = 50 } = {}) =>
  watchV2Request("GET", `/admin/watch/watches/${encodeURIComponent(watchId)}/firings`, {
    query: { limit },
  });

// One entry per journal event: the path it took through the watch's graph,
// every node's verdict on the way, and the ledger rows it produced. The join
// between the trace and the firings ledger is done on the gateway, because the
// two are keyed differently and nothing on this side could do it.
// `untouched: "include"` asks for the events the route holds back by default:
// the ones that reached the watch and no node took up.
export const getWatchV2History = (watchId, { limit = 50, untouched } = {}) =>
  watchV2Request("GET", `/admin/watch/watches/${encodeURIComponent(watchId)}/history`, {
    query: { limit, ...(untouched ? { untouched } : {}) },
  });

// What the judge was asked about this watch, and what it answered — prompt,
// raw reply, verdict and how long the provider took, newest first. Admin-only:
// a prompt quotes the document it is about, which makes these the most
// corpus-bearing thing the watch surface serves.
export const getWatchV2JudgeExchanges = (watchId, { limit = 20 } = {}) =>
  watchV2Request("GET", `/admin/watch/watches/${encodeURIComponent(watchId)}/judge-exchanges`, {
    query: { limit },
  });

export const deleteWatchV2Watch = (watchId) =>
  watchV2Request("DELETE", `/admin/watch/watches/${encodeURIComponent(watchId)}`);

// The Privacy landing feed: every exchange, newest first, across conversations.
export const listPrivacyExchangeFeed = ({ limit = 50, cursor } = {}) =>
  privacyRequest("GET", "/admin/privacy/exchanges", { query: { limit, cursor } });

export const getPrivacyConversation = (conversationId) =>
  privacyRequest("GET", `/admin/privacy/conversations/${encodeURIComponent(conversationId)}`);

export const listPrivacyExchanges = (
  conversationId,
  { limit = 50, cursor, includeAgentTracesTaskId } = {},
) =>
  privacyRequest(
    "GET",
    `/admin/privacy/conversations/${encodeURIComponent(conversationId)}/exchanges`,
    { query: { limit, cursor, includeAgentTracesTaskId } },
  );

export const listPrivacyAuditEvents = (conversationId, { limit = 50, cursor } = {}) =>
  privacyRequest(
    "GET",
    `/admin/privacy/conversations/${encodeURIComponent(conversationId)}/events`,
    { query: { limit, cursor } },
  );

export const deletePrivacyConversation = (conversationId) =>
  privacyRequest("DELETE", `/admin/privacy/conversations/${encodeURIComponent(conversationId)}`);

// Direct MCP transcript sessions, newest first. The Answer feed above shows
// privacy-reviewed releases; these sessions show raw reads, so the Audit
// view keeps the two visibly distinct.
export const listDirectAuditSessions = ({ limit = 50 } = {}) =>
  privacyRequest("GET", "/admin/privacy/direct/sessions", { query: { limit } });

export const listDirectSessionEvents = (sessionId, { limit = 100 } = {}) =>
  privacyRequest("GET", `/admin/privacy/direct/sessions/${encodeURIComponent(sessionId)}/events`, {
    query: { limit },
  });

export const getDirectAuditEvent = (eventId) =>
  privacyRequest("GET", `/admin/privacy/direct/events/${encodeURIComponent(eventId)}`);

export const deleteDirectAuditSession = (sessionId) =>
  privacyRequest("DELETE", `/admin/privacy/direct/sessions/${encodeURIComponent(sessionId)}`);

// `accountId` is set on re-auth flows (Reauthenticate banner) so the
// provider's authFlow knows which existing account is being re-authed.
/**
 * Every challenge kind this surface can draw.
 *
 * Declared so a provider needing something we cannot render is refused at
 * once, with a message, instead of emitting it and waiting out a timeout.
 * `widget` is included here and not in the terminal client: this is where the
 * renderer registry lives.
 */
export const PORTAL_RENDERS = ["redirect", "code", "qr", "fields", "widget", "wait"];

export const startAuthFlow = ({ deviceId, sourceType, params, accountId, credentials }) =>
  request("POST", "/admin/auth-flows", {
    body: { deviceId, sourceType, params, accountId, credentials, renders: PORTAL_RENDERS },
  });

/**
 * Deliver a manually pasted authorization code into a running auth flow.
 * The gateway forwards it to the collector; completion still arrives over
 * the flow's SSE events stream. Codes are single-use — a 409 means the
 * flow is no longer awaiting one (already delivered, completed, or
 * cancelled), which callers detect via `err.status` and surface as an
 * informational notice rather than an error.
 */
export const submitAuthFlowCode = (flowId, code) =>
  request("POST", `/admin/auth-flows/${encodeURIComponent(flowId)}/code`, { body: { code } });

/**
 * Deliver a hosted-widget result (`link-widget` AuthType) into a running auth
 * flow. Unlike a code, this endpoint is NOT single-use: a widget may yield
 * several results in one session, so the caller posts each `{ token, metadata }`
 * as it arrives and the flow stays awaiting until the provider resolves it
 * (completion still arrives over the flow's SSE `complete` event). `token` is the opaque widget
 * result token (e.g. a Plaid `public_token`); `metadata` is optional structured
 * context (e.g. the selected institution).
 */
export const submitAuthFlowWidgetResult = (flowId, token, metadata) =>
  request("POST", `/admin/auth-flows/${encodeURIComponent(flowId)}/widget-result`, {
    body: metadata ? { token, metadata } : { token },
  });

/**
 * Answer one typed challenge.
 *
 * The challenge id goes with the answer: a flow may have asked more than once,
 * and an answer sent after the operator went back and changed an earlier one
 * must not resolve the wait it does not belong to.
 */
export const answerAuthChallenge = (flowId, challengeId, answer) =>
  request("POST", `/admin/auth-flows/${encodeURIComponent(flowId)}/answer`, {
    body: { challengeId, answer },
  });

/**
 * Cancel an in-flight auth flow. 404 is treated as success because the
 * flow may have already cleared itself (race with completion).
 */
export async function cancelAuthFlow(flowId) {
  try {
    await request("POST", `/admin/auth-flows/${encodeURIComponent(flowId)}/cancel`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return true;
}

/**
 * After a re-auth OAuth flow writes fresh tokens to disk, ask the
 * collector to re-instantiate every source under (providerType,
 * accountId) so they pick up the new credentials in-memory and flip
 * out of `needs-auth` / `error` without a restart.
 *
 * `deviceId` is omitted when undefined/null because the gateway zod
 * schema rejects an explicit `null` (it's `.optional()`, not
 * `.nullable()`); leaving the field off lets `resolveCollectorDeviceId`
 * pick a sensible default on the server.
 */
export const finalizeReauth = ({ deviceId, providerType, accountId }) =>
  request("POST", "/admin/sources/reauth-finalize", {
    body: {
      ...(deviceId ? { deviceId } : {}),
      providerType,
      accountId,
    },
  });

// --- Provider OAuth credentials (Google, Strava, Notion, Outlook) ---

/**
 * Per-provider credentials status. Returns the providers that declare a
 * credentials spec (i.e. anything with a wizard), whether each is currently
 * configured, and the collector's hostname (used by the CLI for same-host
 * detection — informational in the portal).
 */
export const getCredentialsStatus = (deviceId) =>
  request("GET", "/admin/credentials", { query: deviceId ? { deviceId } : undefined });

export const setProviderCredentials = ({ fileKey, deviceId, fields }) =>
  request("POST", `/admin/credentials/${encodeURIComponent(fileKey)}`, { body: { deviceId, fields } });

/**
 * Gateway-host model-provider credential status (Anthropic API key,
 * future OpenAI / Mistral). Peer to `getCredentialsStatus` but for
 * credentials the gateway itself consumes — no collector hop, no
 * deviceId.
 */
export const getModelCredentialsStatus = () => request("GET", "/admin/model-credentials");

export const setModelProviderCredentials = ({ fileKey, fields }) =>
  request("POST", `/admin/model-credentials/${encodeURIComponent(fileKey)}`, { body: { fields } });

export const clearModelProviderCredentials = (fileKey) =>
  request("DELETE", `/admin/model-credentials/${encodeURIComponent(fileKey)}`);

// --- Agent config ---

export const getAgentConfig = () => request("GET", "/admin/agent/config");

// The model that would answer right now (current agent assignment, decoupled
// from any conversation's history). Returns a `ModelDisplay`.
export const getAgentModel = () => request("GET", "/agent/model");

// --- Model management ---

export const getModelsOverview = () => request("GET", "/admin/models");
export const saveModelBehavior = (role, assignment, values, expectedValues) =>
  request("PATCH", `/admin/models/behavior/${encodeURIComponent(role)}`, {
    body: { assignment, values, expectedValues },
  });
export const getSystemInfo = () => request("GET", "/admin/system-info");
export const installModel = (id) => request("POST", "/admin/models/install", { body: { id } });
export const cancelModelDownload = (id) => request("POST", "/admin/models/cancel-download", { body: { id } });
export const uninstallModel = (id) => request("DELETE", `/admin/models/${encodeURIComponent(id)}`);
export const activateModel = (id, role, capability) =>
  request("POST", "/admin/models/activate", {
    body: capability ? { id, role, capability } : { id, role },
  });
export const doctorModel = (id) => request("GET", `/admin/models/doctor/${encodeURIComponent(id)}`);

// Models recently used for this capability or a similar one, with their
// provider display and how to apply them. Empty entries = hide the section.
export const getRecentModels = (capability) =>
  request("GET", `/admin/models/recent/${encodeURIComponent(capability)}`);

// Rebuild the vector index (#1011). `graceful` (default) keeps search live on
// the current model while the new index rebuilds, then atomically flips; `hard`
// is the immediate cutover that stops the old model now and accepts keyword-only
// search until the rebuild finishes.
export const rebuildIndex = (mode = "graceful") =>
  request("POST", "/admin/index/rebuild", { body: { mode } });

// --- Inference backend management ---

export const assignCapability = (role, assignment) =>
  patchAdminConfig({ inference: { assignments: { [role]: assignment } } });

export const addHttpBackend = (key, url, apiKey, apiPathPrefix, allowRemoteInference = false) => {
  const cfg = { type: "http", url };
  if (apiKey) cfg.apiKey = apiKey;
  if (apiPathPrefix) cfg.apiPathPrefix = apiPathPrefix;
  const inference = { backends: { [key]: cfg } };
  if (allowRemoteInference) inference.allowRemoteInference = true;
  return patchAdminConfig({ inference });
};

export const removeHttpBackend = (key) =>
  patchAdminConfig({ inference: { backends: { [key]: null } } });

export const probeBackend = (key) =>
  request("POST", `/admin/inference/backends/${encodeURIComponent(key)}/probe`);

export const refreshCodexBackend = () =>
  request("POST", "/admin/inference/codex/refresh");

export const getCodexRuntimeUpdate = () =>
  request("GET", "/admin/inference/codex/runtime/update");

export const startCodexRuntimeUpdate = (dryRun = false) =>
  request("POST", "/admin/inference/codex/runtime/update", { body: dryRun ? { dryRun: true } : {} });

export const cancelCodexRuntimeUpdate = () =>
  request("DELETE", "/admin/inference/codex/runtime/update");

export const refreshAnthropicBackend = () =>
  request("POST", "/admin/inference/anthropic/refresh");

export const startCodexLogin = () =>
  request("POST", "/admin/inference/codex/login");

export const getCodexLogin = () =>
  request("GET", "/admin/inference/codex/login");

export const cancelCodexLogin = () =>
  request("DELETE", "/admin/inference/codex/login");

export const removeCodexBackend = () =>
  request("DELETE", "/admin/inference/codex");
