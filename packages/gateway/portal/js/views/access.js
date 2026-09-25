// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Access is the owner-facing control surface for delegated MCP data access.
// It talks in two nouns: access levels, which hold permissions, and
// connections — approved agent installs — each of which uses exactly one
// level. Devices remain operational Omnesis installations and are managed on
// the neighbouring Settings tab.
//
// This file is the façade: it owns the route dispatcher (`AccessView`) and the
// overview state the pages share, and re-exports the public surface of the
// modules under `./access/` so every importer keeps one address:
//
// - `access/access-list.js` — `AccessList`, each access level followed by the
//   connections that use it.
// - `access/level-editor.js` — `LevelEditorPage` and `NewLevelPage`, the
//   wizard editing or creating a level.
// - `access/grant-wizard.js` — `GrantWizard`, the step shape every
//   permissions decision runs through, whoever is deciding.
// - `access/authorization.js` — `RequestReview` for a pending OAuth request,
//   and the authorization helpers (`authorizationEndpointLabel`,
//   `authorizationErrorMessage`, `authorizationStatusNotice`,
//   `buildAuthorizationSelection`, `reviewSourceScopes`, `sourceSummary`).
// - `access/connection-step.js` — the approval's Connection step, and
//   `initialAuthorizationRules`.
// - `access/move-dialog.js` — `MoveConnectionDialog`.
// - `access/pending-requests.js` — `PendingRequests`, the authorization
//   requests still waiting on the owner.
// - `access/connect-dialog.js` — `ConnectAgentDialog`, the MCP server address
//   and the short-code entry that opens a pending request for review.
// - `access/name-fields.js`, `access/terms.js`, `access/shared.js` — helpers
//   those modules have in common.
//
// The privacy policies a level names live on the neighbouring Policies tab
// (`./policies.js`); a level's terms here link to the one it names.
//
// New Access work belongs in one of those modules, not here.

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  completeAccessAuthorization,
  deleteAccessLevel,
  getAccessAuthorization,
  getAccessOverview,
  moveConnectionLevel,
  renameAccessPrincipal,
  revokeAccess,
  updateAccessLevel,
} from "../api.js";
import { navigate, replaceRoute } from "../lib/router.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { AccessList, levelEditorPath } from "./access/access-list.js";
import {
  RequestReview,
  authorizationErrorMessage,
  authorizationStatusNotice,
} from "./access/authorization.js";
import { ConnectAgentDialog } from "./access/connect-dialog.js";
import { LevelEditorPage, NewLevelPage } from "./access/level-editor.js";
import { MoveConnectionDialog } from "./access/move-dialog.js";
import { LEVEL_NAME_TAKEN_MESSAGE } from "./access/name-fields.js";
import { PendingRequests } from "./access/pending-requests.js";
import {
  accessLevels,
  connectionEntries,
  errorMessage,
  isLiveConnection,
  levelDevices,
  liveConnectionCount,
} from "./access/shared.js";

export {
  authorizationEndpointLabel,
  authorizationErrorMessage,
  authorizationStatusNotice,
  buildAuthorizationSelection,
  reviewSourceScopes,
  sourceSummary,
} from "./access/authorization.js";
export { initialAuthorizationRules } from "./access/connection-step.js";
export { effectiveAccessState } from "./access/shared.js";

const EMPTY_OVERVIEW = { principals: [], levels: [], oauth: null };
const ACCESS_ROUTE = "/portal/settings/access";
const NEW_LEVEL_ROUTE = "/portal/settings/access/levels/new";
const UNLOADABLE_APPROVAL_MESSAGE = "This approval could not be loaded. Reload the page.";

// How often the inventory page re-reads the overview. The pending strip is
// the page's clock: a request arrives, or is decided on a phone, while the
// page is open, and the strip must follow without a reload. Half a minute
// matches the strip's own countdown and is a fraction of a request's life.
const OVERVIEW_REFRESH_MS = 30_000;

export function AccessView({
  authorizationId = null,
  levelId = null,
  newLevel = false,
  connectOpen = false,
  completeInPortal = false,
  completeAuthorization = async (approvalId) => {
    const result = await completeAccessAuthorization(approvalId);
    globalThis.location.assign(result.redirectTo);
  },
} = {}) {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [overviewReady, setOverviewReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectLocal, setConnectLocal] = useState(false);
  // The pending request under review, with the gateway's `connection`
  // proposal for it. The gateway sends a proposal with every pending request;
  // a lookup without one cannot be reviewed and the page says so.
  const [pending, setPending] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState("");
  // The connection a Remove is being confirmed for, and the level that goes
  // with it when it is that level's last connection.
  const [removal, setRemoval] = useState(null);
  const [alsoDeleteLevel, setAlsoDeleteLevel] = useState(true);
  const [levelDeletion, setLevelDeletion] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Set synchronously while a confirmed removal, deletion or move is on its
  // way to the gateway. The disabled buttons only follow on the next render, so
  // a second press in the same moment is refused here rather than sent twice.
  const inFlightRef = useRef(false);
  // The connection the move dialog is open for, with the dialog's own state.
  const [moving, setMoving] = useState(null);
  // What a window opened only to finish one request says once there is
  // nothing left to finish: the client completed on its own. Set only when
  // `completeInPortal`; the whole portal reports the same outcome as a notice.
  const [done, setDone] = useState("");
  // Set while a window opened only to finish one request hands it back to the
  // client. The browser is about to leave for the client's callback, so the
  // page says it is on its way rather than showing a review that is over.
  const [completing, setCompleting] = useState(false);
  const detailHeadingRef = useRef(null);
  const accessHeadingRef = useRef(null);
  const detail = Boolean(authorizationId || levelId || newLevel);
  const previousDetailRef = useRef(detail);

  /**
   * Re-reads the overview. A `background` read is the page keeping itself
   * current, and it leaves the page's banners to the actions that raised
   * them: a failed read changes nothing — what the page shows is what it
   * read a moment ago, and taking that away would close a dialog the owner
   * is typing into — and a successful one clears only a failed load's own
   * banner, never a removal's.
   */
  async function refresh({ background = false } = {}) {
    try {
      const loaded = await getAccessOverview();
      setOverview(loaded);
      setOverviewReady(true);
      if (!background || !overviewReady) setError("");
      return loaded;
    } catch (error) {
      if (background) return null;
      setOverviewReady(false);
      setError(errorMessage(error, "Agent access could not be loaded."));
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * The gateway refused a decision because what it was checked against moved
   * while the review was open. The request is looked up again — the proposal
   * it came with may name a level or connection that is gone, so it is
   * recomputed rather than reused — beside the overview; the review rebuilds
   * from both. Returns null when the page has moved on instead — including
   * to saying the refreshed lookup cannot be reviewed.
   */
  async function reloadPending() {
    const [result, loaded] = await Promise.all([getAccessAuthorization(authorizationId), refresh()]);
    if (result.request.status !== "pending") {
      await finishDecision(result.request.status);
      return null;
    }
    if (!loaded) return null;
    const fresh = { request: result.request, connection: result.connection ?? null };
    setPending(fresh);
    return fresh.connection ? { ...fresh, overview: loaded } : null;
  }

  /**
   * Hands a decided request back to the client that asked. The client may
   * have collected its answer already — it polls the same request — and the
   * gateway then refuses to issue a second code as `already-decided`. That is
   * the connection finished, not a failure, and the window says so. Any other
   * refusal is returned as the sentence to show, for the caller to place
   * after whatever else it reloads.
   */
  async function completeForClient(approvalId) {
    try {
      await completeAuthorization(approvalId);
      return null;
    } catch (error) {
      if (error?.serverMessage === "already-decided") {
        setDone("The client has already finished connecting. You can close this window.");
        return null;
      }
      return authorizationErrorMessage(error, "The MCP client could not finish connecting.");
    }
  }

  useEffect(() => { refresh(); }, []);
  // Only the inventory page follows the gateway; a detail page holds a review
  // built from what it loaded, and its own reloads are the conflict path.
  useVisiblePoll(
    () => { void refresh({ background: true }); },
    OVERVIEW_REFRESH_MS,
    { enabled: !detail },
  );
  useEffect(() => {
    let cancelled = false;
    if (!authorizationId) {
      setPending(null);
      setDetailLoading(false);
      return () => { cancelled = true; };
    }
    setDetailLoading(true);
    setPending(null);
    getAccessAuthorization(authorizationId)
      .then((result) => {
        if (cancelled) return;
        if (result.request.status !== "pending") {
          setPending(null);
          if (
            completeInPortal &&
            !result.request.requiresAnswer &&
            ["approved", "denied"].includes(result.request.status)
          ) {
            setCompleting(true);
            void completeForClient(result.request.approvalId).then((failure) => {
              if (failure && !cancelled) {
                setCompleting(false);
                setError(failure);
              }
            });
            return;
          }
          setNotice(authorizationStatusNotice(result.request.status));
          replaceRoute(ACCESS_ROUTE);
          return;
        }
        setPending({ request: result.request, connection: result.connection ?? null });
      })
      .catch((error) => {
        if (!cancelled) {
          setError(authorizationErrorMessage(error, "The authorization request could not be loaded."));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [authorizationId]);
  useEffect(() => {
    if (!detail && previousDetailRef.current) accessHeadingRef.current?.focus();
    previousDetailRef.current = detail;
  }, [detail]);

  const entries = useMemo(() => connectionEntries(overview), [overview]);
  const levels = useMemo(() => accessLevels(overview), [overview]);
  const activeConnectionCount = entries.filter((entry) => entry.state === "active").length;

  /**
   * Leaves a request the review has finished with. The review stays on the
   * page, its controls disabled, until the route has moved on — the route
   * change is what clears it — so nothing in between reads as the request
   * having gone missing. The list is re-read after the route is replaced.
   */
  async function finishDecision(decision) {
    const completingRequest = pending?.request ?? null;
    if (
      (decision === "approve" || decision === "deny") &&
      completingRequest &&
      !completingRequest.requiresAnswer &&
      completeInPortal
    ) {
      setCompleting(true);
      const failure = await completeForClient(completingRequest.approvalId);
      if (failure) {
        setCompleting(false);
        setPending(null);
        setError(failure);
        replaceRoute(ACCESS_ROUTE);
        await refresh({ background: true });
      }
      return;
    }
    setNotice(
      decision === "approve"
        ? "Access approved. The MCP client can finish connecting."
        : decision === "deny"
          ? "Access request denied."
          : decision === "expired"
            ? "This authorization request expired before it could be saved."
            : "This authorization request was already resolved elsewhere.",
    );
    replaceRoute(ACCESS_ROUTE);
    await refresh();
  }

  /**
   * Gives a connection the name the owner typed, and answers whether it took.
   * A connection that is gone by the time the name is saved is the page's
   * news, not the field's: the list is re-read so the row goes with it — as a
   * background read, which leaves that sentence on the page.
   */
  async function renameConnection(entry, name) {
    try {
      await renameAccessPrincipal(entry.id, name);
      setError("");
      setNotice(`“${entry.name}” is now “${name}”.`);
      await refresh();
      return true;
    } catch (error) {
      if (error?.status === 404) {
        setError("This connection no longer exists.");
        await refresh({ background: true });
      } else {
        setError(errorMessage(error, "The connection could not be renamed."));
      }
      return false;
    }
  }

  /** The same for a level, saved on the revision the list shows. */
  async function renameLevel(level, name) {
    try {
      await updateAccessLevel(level.id, { expectedRevision: level.revision, name });
      setError("");
      setNotice(`“${level.name}” is now “${name}”.`);
      await refresh();
      return true;
    } catch (error) {
      const refusal = error?.serverMessage;
      if (error?.status === 404) {
        setError("This access level no longer exists.");
        await refresh({ background: true });
      } else if (refusal === "level-name-taken") {
        setError(LEVEL_NAME_TAKEN_MESSAGE);
      } else if (refusal === "stale-revision") {
        setError("This access level changed elsewhere. Review it and try the new name again.");
        await refresh({ background: true });
      } else {
        setError(errorMessage(error, "The access level could not be renamed."));
      }
      return false;
    }
  }

  /**
   * Asks to remove a connection, offering to delete its level with it when no
   * other live connection and no integration would be left using that level — the
   * rule the gateway deletes a level by.
   */
  function askRemoval(entry) {
    const level = levels.find((candidate) => candidate.id === entry.levelId) ?? null;
    const remaining = level === null
      ? null
      : liveConnectionCount(level, entries) - (isLiveConnection(entry) ? 1 : 0);
    setAlsoDeleteLevel(true);
    setRemoval({
      entry,
      level: remaining === 0 && levelDevices(level).length === 0 ? level : null,
    });
  }

  /**
   * Removes the connection, then its level when the owner kept that box
   * checked. The level goes only after the connection is gone; a level the
   * gateway still finds in use is kept and the page says why. A removal that
   * fails closes the confirmation and re-reads the list behind the sentence
   * that says so, since what failed may be a connection already gone.
   */
  async function confirmRemoval() {
    if (!removal || inFlightRef.current) return;
    inFlightRef.current = true;
    const { entry, level } = removal;
    setConfirming(true);
    try {
      const result = await revokeAccess("principal", entry.id);
      if (!result.revoked) {
        setRemoval(null);
        setError("This connection was already removed.");
        await refresh({ background: true });
        return;
      }
      let message = `“${entry.name}” removed.`;
      let levelFailure = "";
      if (level && alsoDeleteLevel) {
        try {
          await deleteAccessLevel(level.id);
          message = `“${entry.name}” and its access level “${level.name}” removed.`;
        } catch (error) {
          if (error?.serverMessage === "level-in-use") {
            levelFailure = `The access level “${level.name}” is still used by another connection or an integration, so it was kept.`;
          } else {
            message = "";
            levelFailure = `“${entry.name}” removed. Its access level “${level.name}” could not be deleted.`;
          }
        }
      }
      setRemoval(null);
      setNotice(message);
      await refresh();
      if (levelFailure) setError(levelFailure);
    } catch (error) {
      setRemoval(null);
      setError(errorMessage(error, "The connection could not be removed."));
      await refresh({ background: true });
    } finally {
      inFlightRef.current = false;
      setConfirming(false);
    }
  }

  async function confirmLevelDeletion() {
    if (!levelDeletion || inFlightRef.current) return;
    inFlightRef.current = true;
    setConfirming(true);
    try {
      await deleteAccessLevel(levelDeletion.id);
      setLevelDeletion(null);
      setNotice(`Access level “${levelDeletion.name}” deleted.`);
      await refresh();
    } catch (error) {
      setLevelDeletion(null);
      setError(error?.serverMessage === "level-in-use"
        ? "Move its connections and integrations off it first."
        : errorMessage(error, "The access level could not be deleted."));
      await refresh({ background: true });
    } finally {
      inFlightRef.current = false;
      setConfirming(false);
    }
  }

  const movingEntry = moving ? entries.find((entry) => entry.id === moving.connectionId) ?? null : null;

  /**
   * Moves the connection on the revisions the dialog was showing — the
   * connection's, and the chosen level's. A refusal that means the choices
   * moved re-reads the list and keeps the dialog open on the fresh ones, with
   * the reason; a connection that is gone closes it.
   */
  async function submitMove(target) {
    if (!movingEntry || inFlightRef.current) return;
    inFlightRef.current = true;
    const entry = movingEntry;
    setMoving((current) => current && { ...current, busy: true, error: "" });
    try {
      await moveConnectionLevel(entry.id, target, entry.grant.revision);
      const levelName = target.newLevel?.name ?? levels.find((level) => level.id === target.levelId)?.name ?? "";
      setMoving(null);
      setError("");
      setNotice(`“${entry.name}” now uses “${levelName}”.`);
      await refresh();
    } catch (error) {
      const refusal = error?.serverMessage;
      if (error?.status === 404) {
        setMoving(null);
        setError("This connection no longer exists.");
        await refresh({ background: true });
        return;
      }
      const stale = refusal === "stale-revision" || refusal === "inactive-grant";
      if (stale) await refresh({ background: true });
      setMoving((current) => current && {
        ...current,
        busy: false,
        error: refusal === "level-name-taken"
          ? LEVEL_NAME_TAKEN_MESSAGE
          : refusal === "inactive-grant"
            ? "That access level no longer exists."
            : stale
              ? "Access choices changed. Review the refreshed choices and try again."
              : errorMessage(error, "The connection could not be moved."),
      });
    } finally {
      inFlightRef.current = false;
    }
  }

  const backToAccess = () => replaceRoute(ACCESS_ROUTE);

  if (done) {
    return html`<div class="access-view access-detail-state">
      <p class="access-notice" role="status">${done}</p>
    </div>`;
  }

  if (completing) {
    return html`<div class="access-view access-detail-state">
      <p class="loading" role="status">Returning to the MCP client…</p>
    </div>`;
  }

  const matchingRequest = pending?.request.approvalId === authorizationId ? pending.request : null;
  if (
    (authorizationId && (!matchingRequest || loading || !overviewReady))
    || ((levelId || newLevel) && loading)
  ) {
    return html`<div class="access-view access-detail-state">
      <button type="button" class="doc-back access-page-back" onClick=${backToAccess}>← Back to access</button>
      ${detailLoading || loading
        ? html`<p class="loading">Loading access details…</p>`
        : html`<p class="access-error" role="alert">${error || "This access detail is no longer available."}</p>`}
    </div>`;
  }

  if (authorizationId && matchingRequest && !pending.connection) {
    return html`<div class="access-view access-detail-state">
      <button type="button" class="doc-back access-page-back" onClick=${backToAccess}>← Back to access</button>
      <p class="access-error" role="alert">${UNLOADABLE_APPROVAL_MESSAGE}</p>
    </div>`;
  }

  if (authorizationId && matchingRequest) {
    return html`<div class="access-view">
      <${RequestReview}
        key=${matchingRequest.id}
        request=${matchingRequest}
        connection=${pending.connection}
        overview=${overview}
        onDone=${finishDecision}
        onConflict=${reloadPending}
        onClose=${backToAccess}
        headingRef=${detailHeadingRef}
      />
    </div>`;
  }

  if (newLevel) {
    return html`<div class="access-view">
      <${NewLevelPage}
        overview=${overview}
        onClose=${backToAccess}
        headingRef=${detailHeadingRef}
        onCreated=${async (level) => {
          await refresh();
          setError("");
          setNotice(`Access level “${level.name}” created.`);
        }}
      />
    </div>`;
  }

  if (levelId) {
    const level = levels.find((candidate) => candidate.id === levelId);
    if (!level) {
      return html`<div class="access-view access-detail-state">
        <button type="button" class="doc-back access-page-back" onClick=${backToAccess}>← Back to access</button>
        <p class="access-error" role="alert">This access level is no longer available.</p>
      </div>`;
    }
    return html`<div class="access-view">
      <${LevelEditorPage}
        key=${`${level.id}-${level.revision}`}
        level=${level}
        connections=${entries.filter((entry) => entry.levelId === level.id && isLiveConnection(entry))}
        overview=${overview}
        onClose=${backToAccess}
        headingRef=${detailHeadingRef}
        onSaved=${async () => {
          await refresh();
          setError("");
          setNotice("Access level updated. Its connections receive the new permissions when they refresh.");
        }}
        onConflict=${async () => {
          await refresh();
          setNotice("");
          setError("This access level changed elsewhere. Your update was not applied; review the current permissions and try again.");
        }}
        onGone=${async () => { await refresh(); }}
      />
    </div>`;
  }

  // The dialog opens from the header button, and from its own route so a link
  // can land on it; closing a route-opened dialog walks the address back.
  //
  // Both ways of opening it wait for a loaded overview carrying a usable OAuth
  // address. Its first step is that address and its second is a code only an
  // OAuth-issuing gateway can have handed out, so opening it before the
  // overview answers would show a form against a gateway that cannot serve it.
  const connectVisible = overviewReady && Boolean(overview.oauth) && (connectOpen || connectLocal);
  const closeConnect = () => {
    setConnectLocal(false);
    if (connectOpen) replaceRoute(ACCESS_ROUTE);
  };
  const openConnect = () => setConnectLocal(true);
  const configHref = "/portal/settings/config";

  return html`
    <div class="access-view">
      <header class="access-header">
        <div>
          <h2 ref=${accessHeadingRef} tabIndex="-1">Agent access</h2>
          <p>
            Who may read the corpus or save notes over MCP, and under which policy.
            ${" "}${activeConnectionCount} active connection${activeConnectionCount === 1 ? "" : "s"}.
          </p>
        </div>
        ${overviewReady
          ? html`<div class="access-actions">
              <button type="button" class="btn-secondary" onClick=${() => navigate(NEW_LEVEL_ROUTE)}>New access level</button>
              ${overview.oauth
                ? html`<button type="button" class="btn-primary" onClick=${openConnect}>Connect an agent</button>`
                : null}
            </div>`
          : null}
      </header>

      ${!overviewReady || overview.oauth
        ? null
        : html`<div class="access-oauth-blocker" role="status">
            <strong>OAuth is not available yet.</strong>
            <span>
              Connecting an agent runs over OAuth, which needs the Gateway public URL.
              Set <code>gateway.publicBaseUrl</code> on the${" "}
              <a
                href=${configHref}
                onClick=${(event) => { event.preventDefault(); navigate(configHref); }}
              >Config tab</a>, then reload this page.
            </span>
          </div>`}

      ${overview.pendingRequests?.length
        ? html`<${PendingRequests} requests=${overview.pendingRequests} />`
        : null}

      ${notice && html`<p class="access-notice" role="status">${notice}</p>`}
      ${error && html`<p class="access-error" role="alert">${error}</p>`}

      ${loading
        ? html`<div class="loading"><div class="spinner"></div><span>Loading agent access…</span></div>`
        : html`<${AccessList}
            entries=${entries}
            levels=${levels}
            overview=${overview}
            onConnect=${overview.oauth ? openConnect : null}
            levelActions=${{
              onEdit: (level) => navigate(levelEditorPath(level.id)),
              onRename: renameLevel,
              onDelete: (level) => setLevelDeletion(level),
            }}
            connectionActions=${{
              onRename: renameConnection,
              onMove: (entry) => setMoving({ connectionId: entry.id, busy: false, error: "" }),
              onRemove: askRemoval,
            }}
          />`}

      ${connectVisible && html`<${ConnectAgentDialog} oauth=${overview.oauth} onClose=${closeConnect} />`}

      ${movingEntry && html`<${MoveConnectionDialog}
        key=${movingEntry.grant.id}
        entry=${movingEntry}
        levels=${levels}
        overview=${overview}
        busy=${moving.busy}
        error=${moving.error}
        onSubmit=${submitMove}
        onClose=${() => setMoving(null)}
      />`}

      <${ConfirmModal}
        open=${Boolean(removal)}
        title=${`Remove “${removal?.entry.name ?? ""}”?`}
        body=${removal
          ? html`<p>Its sign-in stops working immediately.</p>
              ${removal.level
                ? html`<label class="access-confirm-check">
                    <input
                      type="checkbox"
                      checked=${alsoDeleteLevel}
                      disabled=${confirming}
                      onChange=${(event) => setAlsoDeleteLevel(event.currentTarget.checked)}
                    />
                    <span>${`Also delete the access level “${removal.level.name}”`}</span>
                  </label>`
                : null}`
          : ""}
        confirmLabel=${confirming ? "Removing…" : "Remove"}
        destructive
        confirmDisabled=${confirming}
        cancelDisabled=${confirming}
        onConfirm=${confirmRemoval}
        onCancel=${() => setRemoval(null)}
      />

      <${ConfirmModal}
        open=${Boolean(levelDeletion)}
        title=${`Delete “${levelDeletion?.name ?? ""}”?`}
        confirmLabel=${confirming ? "Deleting…" : "Delete"}
        destructive
        confirmDisabled=${confirming}
        cancelDisabled=${confirming}
        onConfirm=${confirmLevelDeletion}
        onCancel=${() => setLevelDeletion(null)}
      />
    </div>
  `;
}
