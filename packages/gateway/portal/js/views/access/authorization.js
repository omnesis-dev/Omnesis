// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How an owner lets a client in: the review of a pending OAuth authorization,
// which approves it by saying what the connection is called and which access
// level it uses, or denies it.
//
// Every approval creates a new connection — on an existing access level, or on
// a new one whose permissions the owner chooses here — unless the owner
// chooses to let the sign-in replace an existing connection. The gateway
// proposes a name, a level and a recommendation with the request (the
// `connection` proposal); the page opens on it and sends exactly what the
// owner chose.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { decideAccessAuthorization } from "../../api.js";
import { CopyValue } from "../../components/copy-button.js";
import { QrCanvas } from "../../components/qr-canvas.js";
import {
  defaultPolicyFamilyId,
  newGrantRule,
  serializeNewAuthorityRules,
  newAuthorityFilterError,
  validateGrantRules,
} from "../../components/grant-builder-state.js";
import { authorizationQrPayload } from "../../access-qr-payload.js";
import {
  ConnectionStep,
  connectionOptions,
  connectionStepReady,
  initialConnectionChoice,
} from "./connection-step.js";
import { ApprovalWizard, CONNECTION_STEP } from "./approval-wizard.js";
import { useLevelDecisionMemory, useNewLevelWalk } from "./level-decisions.js";
import { directFollowsAnswer, directMirrorsAnswer } from "./level-flow-state.js";
import { LevelReview } from "./level-review.js";
import { LEVEL_NAME_TAKEN_MESSAGE, NEW_LEVEL } from "./name-fields.js";
import { PageHeader } from "./page-header.js";
import { errorMessage, expiresInLabel, overviewPolicies, useExpiryClock } from "./shared.js";

/**
 * The selection the gateway receives for what the owner approved:
 *
 * - `new-level` — a new connection on a new access level with these rules;
 * - `existing-level` — a new connection on a level that exists, checked
 *   against the level's revision so a level edited meanwhile is refused;
 * - `replace` — the sign-in takes over a connection, checked against that
 *   connection's revision.
 */
export function buildAuthorizationSelection(approval) {
  if (approval.kind === "new-level") {
    return {
      kind: "new-connection",
      name: approval.name.trim(),
      level: {
        kind: "new",
        name: approval.levelName.trim(),
        rules: serializeNewAuthorityRules(approval.rules),
      },
    };
  }
  if (approval.kind === "existing-level") {
    return {
      kind: "new-connection",
      name: approval.name.trim(),
      level: {
        kind: "existing",
        levelId: approval.level.id,
        expectedLevelRevision: approval.level.revision,
      },
    };
  }
  return {
    kind: "replace-connection",
    connectionId: approval.connection.id,
    expectedGrantRevision: approval.connection.grant.revision,
  };
}

export function authorizationEndpointLabel(value, localLabel = "Requesting device") {
  try {
    const url = new URL(value);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return localLabel;
    return url.host;
  } catch {
    return "Unknown destination";
  }
}

export function authorizationStatusNotice(status) {
  switch (status) {
    case "approved":
      return "Access was approved from another device. The MCP client can finish connecting.";
    case "denied":
      return "This access request was denied from another device.";
    case "code-issued":
    case "complete":
      return "This connection was already completed.";
    case "expired":
      return "This authorization request expired.";
    default:
      return "This request is no longer waiting for a decision.";
  }
}

/**
 * The refusals that mean what the approval was checked against moved while
 * the page was open. Each is answered the same way: the request and the
 * choices are reloaded, and the review starts over from the Connection step.
 */
const REFRESH_REFUSALS = new Set(["stale-revision", "inactive-grant", "invalid-selection"]);
const REFRESHED_MESSAGE = "Access choices changed. Review the refreshed request.";

/**
 * The sentence for each refusal the authorization routes answer with as a
 * machine token, when the page has nothing to do about it but say so. The
 * refusals that reload the review are `REFRESH_REFUSALS`; the ones that close
 * it (`already-decided`, `expired` on a decision) are handled by the caller
 * before it comes here.
 */
const AUTHORIZATION_ERROR_MESSAGES = {
  "not-found": "This authorization request no longer exists.",
  expired: "This authorization request expired. Start the connection again.",
  "already-decided": "This authorization request was already completed.",
  "client-completes":
    "This client collects its own authorization code; there is nothing to finish from here.",
  "oauth-not-configured":
    "The MCP client could not finish connecting: OAuth needs the Gateway public URL. Set gateway.publicBaseUrl on the Config tab and try again.",
};

/**
 * What the owner reads when an authorization route refuses: the sentence for
 * a refusal it named, the gateway's own sentence when it sent one, and the
 * caller's fallback otherwise. A 404 from any of these routes means the
 * request is gone, whether the gateway said so in a token or a sentence.
 */
export function authorizationErrorMessage(error, fallback) {
  const token = error?.status === 404 ? "not-found" : error?.serverMessage;
  return AUTHORIZATION_ERROR_MESSAGES[token] ?? errorMessage(error, fallback);
}

/**
 * The same request, handed to a phone: the code the mobile apps scan, and the
 * code typed into one, for an owner who would rather decide there — the QR is
 * drawn only once asked for, since most reviews finish on this page.
 */
function PhoneHandoff({ userCode, disabled }) {
  const [open, setOpen] = useState(false);
  return html`<div class="access-phone-handoff">
    <button
      type="button"
      class="access-phone-toggle"
      aria-expanded=${open}
      aria-controls=${open ? "access-phone-panel" : undefined}
      disabled=${disabled}
      onClick=${() => setOpen((value) => !value)}
    >
      ${open ? "▾" : "▸"} Use your phone instead
    </button>
    ${
      open &&
      html`<div id="access-phone-panel" class="access-phone-panel">
        <${QrCanvas}
          payload=${authorizationQrPayload(userCode)}
          width=${160}
          class="access-phone-qr"
        />
        <div class="access-phone-copy">
          <p>Scan with the Omnesis app on your phone, or enter this code there.</p>
          <${CopyValue} text=${userCode} title="Copy code">
            <code class="access-phone-code">${userCode}</code>
          <//>
          <p>The request stays open here until it is decided on either.</p>
        </div>
      </div>`
    }
  </div>`;
}

/**
 * How many connections besides the one being approved already use the level
 * the approval lands on: all of an existing level's, and all but the replaced
 * connection itself for a replacement.
 */
function otherConnectionsOnLevel(approval) {
  if (approval.kind === "existing-level") return approval.level.connectionCount ?? 0;
  if (approval.kind === "replace" && approval.level)
    return Math.max((approval.level.connectionCount ?? 1) - 1, 0);
  return 0;
}

/**
 * The last look before access is granted: which connection, on which access
 * level, then `decisions` — the level's permissions, drawn by the level
 * editor's review.
 */
function ConnectionReview({ approval, decisions }) {
  const connectionName =
    approval.kind === "replace" ? approval.connection.name : approval.name.trim();
  const levelName =
    approval.kind === "new-level"
      ? `${approval.levelName.trim()} (new)`
      : (approval.level?.name ?? null);
  const others = otherConnectionsOnLevel(approval);
  return html`
    <dl class="access-review-rows" aria-label="Access to approve">
      <div>
        <dt>Connection</dt>
        <dd>${connectionName}</dd>
      </div>
      ${
        levelName
          ? html`<div>
              <dt>Access level</dt>
              <dd>${levelName}</dd>
            </div>`
          : null
      }
      ${
        approval.kind === "replace"
          ? html`<div>
              <dt>Replaces</dt>
              <dd>${`The current sign-in of ${approval.connection.name}`}</dd>
            </div>`
          : null
      }
    </dl>
    <section class="guided-level-flow access-review-decisions">${decisions}</section>
    ${
      others > 0
        ? html`<p class="access-review-note">
            ${`Also used by ${others} other connection${others === 1 ? "" : "s"}. Changing this access level later changes all of them.`}
          </p>`
        : null
    }
    <p class="access-review-foot">
      Access can be edited or revoked later from Settings → Access in the Omnesis Portal.
    </p>
  `;
}

/**
 * What approving would create from the owner's current choice, with the rules
 * it carries; null while a replacement has no connection picked.
 */
function approvalFor(choice, options) {
  if (choice.mode === "replace") {
    const target = options.replaceable.find((option) => option.entry.id === choice.replaceId);
    return target
      ? { kind: "replace", connection: target.entry, level: target.level, rules: target.rules }
      : null;
  }
  if (choice.levelChoice === NEW_LEVEL) {
    return {
      kind: "new-level",
      name: choice.name,
      levelName: choice.levelName,
      rules: choice.rules,
    };
  }
  const option = options.levels.find((candidate) => candidate.level.id === choice.levelChoice);
  return option
    ? { kind: "existing-level", name: choice.name, level: option.level, rules: option.rules }
    : null;
}

/**
 * Whether a refreshed choice walks the same path as the owner's: the same
 * mode and, for a new connection, a new level again or an existing one again.
 * The names the owner typed carry over only then, since on another path they
 * would name something the owner did not choose.
 */
function samePath(current, reloaded) {
  if (current.mode !== reloaded.mode) return false;
  return (
    current.mode === "replace" ||
    (current.levelChoice === NEW_LEVEL) === (reloaded.levelChoice === NEW_LEVEL)
  );
}

/**
 * `connection` is the gateway's proposal for the request, which the page opens
 * on. `onConflict()` reloads the request and the overview after a refusal that
 * means the choices moved, and resolves to both — or to null when the page has
 * moved on instead.
 */
export function RequestReview({
  request,
  connection,
  overview,
  onDone,
  onConflict = async () => null,
  onClose = () => {},
  headingRef,
}) {
  const policies = overviewPolicies(overview);
  const sources = overview.sources ?? [];
  const fallbackPolicy = defaultPolicyFamilyId(policies, overview.defaultPolicyFamilyId);
  const [choice, setChoice] = useState(() =>
    initialConnectionChoice(request, connection, overview),
  );
  const [step, setStep] = useState(CONNECTION_STEP);
  // Direct starts out following Answer only when it already reads exactly what
  // Answer uses; permissions carried over from a matched connection may not.
  const [linkDirect, setLinkDirect] = useState(() => directMirrorsAnswer(choice.rules));
  const memory = useLevelDecisionMemory();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set the moment a decision starts. The disabled buttons only follow on the
  // next render, so a second press in the same moment is refused here rather
  // than sent twice.
  const inFlightRef = useRef(false);
  const mounted = useRef(true);
  // The header prints how long the request still has.
  const now = useExpiryClock();

  useEffect(() => {
    headingRef?.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  const walk = useNewLevelWalk({
    step,
    onStep: setStep,
    rules: choice.rules,
    linkDirect,
  });
  const options = connectionOptions(request, connection, overview);
  const approval = approvalFor(choice, options);
  const effectiveRules = approval?.rules ?? choice.rules;
  const creationError = choice.mode !== "replace" && choice.levelChoice === NEW_LEVEL
    ? newAuthorityFilterError(choice.rules, overview.sourceFilters?.enabled === true)
    : null;
  const valid = Boolean(approval) && !creationError && !validateGrantRules(effectiveRules, sources);

  // A taken level name is the owner's to fix by typing another, so the refusal
  // goes as soon as they do.
  const changeChoice = (patch) => {
    if ("levelName" in patch && error === LEVEL_NAME_TAKEN_MESSAGE) setError("");
    setChoice((current) => ({ ...current, ...patch }));
  };
  const updateRules = (next) =>
    setChoice((current) => ({
      ...current,
      rules:
        request.requiresAnswer && !next.answer
          ? { ...next, answer: current.rules.answer ?? newGrantRule("answer", fallbackPolicy) }
          : next,
    }));

  function capabilityAction() {
    const permissions = [
      effectiveRules.answer && "Answer",
      effectiveRules.direct && "raw Direct access",
      effectiveRules.notes && "Notes",
    ].filter(Boolean);
    return `Allow ${permissions.join(" + ")}`;
  }

  /**
   * Starts the review over from what the gateway serves now, on the
   * Connection step. Permissions come from the refreshed proposal; the names
   * the owner typed stay when the refreshed choice walks the same path.
   */
  async function reloadChoices() {
    let fresh;
    try {
      fresh = await onConflict();
      if (!mounted.current) return;
    } catch (failure) {
      if (!mounted.current) return;
      setError(
        authorizationErrorMessage(failure, "The authorization request could not be reloaded."),
      );
      setBusy(false);
      return;
    }
    if (!fresh) {
      setBusy(false);
      return;
    }
    const reloaded = initialConnectionChoice(fresh.request, fresh.connection, fresh.overview);
    setChoice((current) =>
      samePath(current, reloaded)
        ? { ...reloaded, name: current.name, levelName: current.levelName }
        : reloaded,
    );
    setLinkDirect(directMirrorsAnswer(reloaded.rules));
    walk.reset();
    setStep(CONNECTION_STEP);
    setError(REFRESHED_MESSAGE);
    setStale(false);
    setBusy(false);
  }

  async function decide(decision) {
    if (inFlightRef.current || (stale && decision === "approve")) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const body =
        decision === "deny"
          ? { decision: "deny" }
          : { decision: "approve", selection: buildAuthorizationSelection(approval) };
      await decideAccessAuthorization(request.approvalId, body);
      if (mounted.current) onDone(decision);
    } catch (error) {
      if (!mounted.current) return;
      const refusal = error?.serverMessage;
      if (["already-decided", "expired"].includes(refusal)) {
        await onDone(refusal);
        return;
      }
      if (REFRESH_REFUSALS.has(refusal)) {
        setStale(true);
        setError(
          "The access choices changed. Your draft is retained. Reload the latest choices before approving.",
        );
        setBusy(false);
        return;
      }
      if (refusal === "level-name-taken") {
        walk.reset();
        setStep(CONNECTION_STEP);
        setError(LEVEL_NAME_TAKEN_MESSAGE);
        setBusy(false);
        return;
      }
      setError(authorizationErrorMessage(error, "The authorization decision could not be saved."));
      setBusy(false);
    } finally {
      inFlightRef.current = false;
    }
  }

  const idPrefix = `authorization-${request.approvalId}`;
  const replacing = choice.mode === "replace";
  const newLevel = !replacing && choice.levelChoice === NEW_LEVEL;
  const leadStep = {
    heading: replacing ? "Replace a connection" : "Name the connection",
    blurb: replacing
      ? "The new sign-in takes over the chosen connection’s name and access level. Its old sign-in stops working."
      : "Name this connection and choose the access level it uses.",
    canContinue: connectionStepReady(choice, options) && !creationError,
    skipsToReview: !newLevel,
    content: html`<${ConnectionStep}
      choice=${choice}
      options=${options}
      match=${connection.match ?? null}
      onChange=${changeChoice}
      disabled=${busy}
      idPrefix=${idPrefix}
    />`,
  };

  return html`<div class="access-authorization-page">
    <${PageHeader}
      eyebrow="Pending connection"
      title="Approve a connection"
      titleId="access-request-title"
      busy=${busy}
      onClose=${onClose}
      headingRef=${headingRef}
    >
      <p>
        <strong>${request.clientName}</strong> is the client-reported name ·
        ${expiresInLabel(request.expiresAt, now)}
      </p>
      <dl class="access-request-facts" aria-label="Connection destinations">
        <div>
          <dt>Omnesis gateway</dt>
          <dd>${authorizationEndpointLabel(request.resource, "This gateway")}</dd>
        </div>
        <div>
          <dt>Returns to</dt>
          <dd>${authorizationEndpointLabel(request.redirectOrigin)}</dd>
        </div>
      </dl>
      ${request.userCode && html`<${PhoneHandoff} userCode=${request.userCode} disabled=${busy} />`}
    <//>
    <${ApprovalWizard}
      leadStep=${leadStep}
      step=${step}
      onStep=${setStep}
      walk=${walk}
      memory=${memory}
      rules=${choice.rules}
      sourceFiltersEnabled=${overview.sourceFilters?.enabled === true}
      onRules=${updateRules}
      sources=${sources}
      policies=${policies}
      linkDirect=${linkDirect}
      onLinkDirect=${setLinkDirect}
      disabled=${busy}
      requiresAnswer=${request.requiresAnswer}
      error=${error || creationError}
      review=${
        approval
          ? html`<${ConnectionReview}
              approval=${approval}
              decisions=${html`<${LevelReview}
                rules=${effectiveRules}
                sources=${sources}
                policies=${policies}
                isNew
                linked=${directFollowsAnswer(effectiveRules, newLevel ? linkDirect : directMirrorsAnswer(effectiveRules))}
                disabled=${busy}
                onChange=${newLevel ? walk.change : null}
              />`}
            />`
          : null
      }
      leadAction=${html`<span><button type="button" class="btn-ghost danger" disabled=${busy} onClick=${() => decide("deny")}>Deny request</button>${stale ? html`<button type="button" class="btn-secondary" disabled=${busy} onClick=${reloadChoices}>Reload choices and discard draft</button>` : null}</span>`}
      finalAction=${html`<button type="button" class=${effectiveRules.direct ? "btn-primary access-risk-action" : "btn-primary"} disabled=${busy || stale || !valid} onClick=${() => decide("approve")}>${busy ? "Saving…" : capabilityAction()}</button>`}
    />
  </div>`;
}
