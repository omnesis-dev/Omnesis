// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One exchange, told as a spine: who asked, what Omnesis drafted, what the
 * privacy check decided, and every step the gateway recorded in between.
 *
 * The trust boundary is encoded structurally rather than described. Each band
 * of the story is a zone that draws one unbroken vertical line down its whole
 * height, all at the same x, so the left edge alone reads as a single spine:
 * dashed outside the machine, a labelled hairline at the edge, solid and
 * stronger through the tinted inside panel, then — only when something actually
 * left — a second hairline and dashed again. Inside/outside is the whole point
 * of this section, and a reader can see it without reading a word.
 *
 * The second thing encoded rather than described is authorship. The request,
 * the answer, and the reviewer's account of it are quoted verbatim from
 * somewhere other than this page, so each is drawn on the section's quote
 * surface; the sentences Omnesis writes about them stay in plain prose.
 *
 * One telling, not two. The audit ledger and the story are the same events in
 * the same order, so they are one column: the ledger supplies the order and the
 * instants, the cards supply the prominence, and the time of every moment sits
 * in a gutter to the left of the spine.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  approvePrivacyApproval,
  deletePrivacyConversation,
  denyPrivacyApproval,
  getPrivacyConversation,
  listPrivacyAuditEvents,
  listPrivacyExchanges,
} from "../../api.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { Loading } from "../../components/loading.js";
import { renderPart } from "../../components/agent/parts.js";
import { navigate } from "../../lib/router.js";
import { useVisiblePoll } from "../../lib/use-visible-poll.js";
import {
  errorMessage,
  formatPrivacyClock,
  formatPrivacyDay,
  formatPrivacyRelativeDate,
  privacyCollection,
  privacyDateTimeAttribute,
  privacyInstant,
} from "../shared/privacy-vocabulary.js";
import { PrivacyAnswerComparison, answerDiffLines } from "./answer-comparison.js";
import { chatMessagesToTurns } from "../agent-reducer.js";
import {
  PRIVACY_PROSE_QUOTE_CLASS,
  PrivacyActor,
  PrivacyAnswerContent,
  PrivacyAuditStatus,
  PrivacyFindingChips,
  PrivacyOutcome,
  PrivacyReviewedUnder,
  exchangeDecisionCopy,
  externalAgentConnectionName,
  externalAgentName,
  externalAgentDeviceKind,
  externalAgentNarrativeName,
  privacyConversationDocument,
  privacyFailureMessage,
  privacyFailureDiagnostics,
  privacyAnswerGenerationFailed,
  privacyDisplayedAnswer,
  privacyExchangeOutcomeDisplay,
  privacyReviewFailed,
  reviewFindings,
} from "./shared.js";

const SHARED_OUTCOMES = new Set(["shared", "shared_with_reductions"]);

/** Steps that are themselves a crossing of the trust boundary. */
const PRIVACY_CROSSING_KINDS = new Set(["released", "egress"]);
const RUNNING_EXCHANGE_REFRESH_MS = 2000;
const TRANSCRIPT_NOOP = () => {};

function PrivacyTracePart({ part, index }) {
  return renderPart(part, index, [], TRANSCRIPT_NOOP, null, false, false, true);
}

function PrivacyAgentTranscript({ trace, open }) {
  const messages = (trace.messages ?? []).filter(
    (message) => message && Array.isArray(message.parts)
      && (message.role === "user" || message.role === "assistant"),
  );
  const truncated = trace.truncated
    || (trace.messages ?? []).some((message) => message?.type === "trace_truncated");
  const turns = chatMessagesToTurns(messages, {
    includeEphemeralTools: true,
  });
  return html`<details class="privacy-agent-transcript" open=${open}>
    <summary>
      Attempt ${trace.attempt ?? ""} · ${trace.provider} / ${trace.model}
      ${trace.terminalStopReason ? ` · ${trace.terminalStopReason}` : ""}
    </summary>
    <div class="cognition-transcript-formatted privacy-agent-transcript-body">
      ${turns.length === 0
        ? html`<p class="privacy-card-muted">No transcript messages were recorded.</p>`
        : turns.map((turn) => html`<div key=${turn.id} class=${`agent-msg agent-msg-${turn.role}`}>
            <div class="agent-msg-body">
              ${turn.parts.map((part, index) => html`<${PrivacyTracePart}
                key=${`${turn.id}-${index}`}
                part=${part}
                index=${index}
              />`)}
            </div>
          </div>`)}
      ${truncated
        ? html`<p class="privacy-card-muted">
            ${trace.omittedParts > 0
              ? `${trace.omittedParts} observable transcript ${trace.omittedParts === 1 ? "part was" : "parts were"} omitted from this stored transcript.`
              : "This stored transcript is incomplete; some activity could not be shown."}
          </p>`
        : null}
    </div>
  </details>`;
}

function PrivacyAgentTranscripts({ traces = [], omittedAttempts = 0 }) {
  if (traces.length === 0 && omittedAttempts === 0) return null;
  return html`<div class="privacy-agent-transcripts">
    <h3>Agent transcript${traces.length === 1 ? "" : "s"}</h3>
    <p>Local generation activity. Only the final draft, when one exists, enters the privacy check.</p>
    ${omittedAttempts > 0
      ? html`<p class="privacy-card-muted">
          ${omittedAttempts} additional stored attempt${omittedAttempts === 1 ? " could" : "s could"}
          not be shown in this bounded view.
        </p>`
      : null}
    ${traces.map((trace, index) => html`<${PrivacyAgentTranscript}
      key=${`${trace.sessionId || "attempt"}-${trace.createdAt ?? index}-${index}`}
      trace=${trace}
      open=${index === 0}
    />`)}
  </div>`;
}

/**
 * The machine-readable half of a failure: the Omnesis code, and the provider's
 * own disposition when a model provider rejected the request. Sits under the
 * explanatory sentence so the sentence stays the thing you read and this stays
 * the thing you quote in a bug report.
 */
function PrivacyFailureDiagnostics({ source }) {
  const diagnostics = privacyFailureDiagnostics(source);
  if (!diagnostics) return null;
  return html`<p class="privacy-failure-codes">
    ${diagnostics.code ? html`<code class="privacy-failure-code">${diagnostics.code}</code>` : null}
    ${diagnostics.detail
      ? html`<span class="privacy-failure-provider">${diagnostics.detail}</span>`
      : null}
  </p>`;
}

/**
 * Which of a step's two paragraphs are the exchange's own words rather than the
 * gateway's account of what happened: the request as it arrived and the purpose
 * the caller stated for it, the answer the agent drafted, the reviewer's own
 * words, the reduced text, and the text that left.
 *
 * Every paragraph not named here is a sentence the gateway wrote about the
 * step, and stays in body prose. A step kind this build has never heard of is
 * absent from the map and so goes unquoted, because attributing text of unknown
 * authorship to the exchange is the claim this screen must not make.
 */
const QUOTED_STEP_PARTS = {
  external_request: { text: true, detail: true },
  candidate_generated: { text: true },
  privacy_review: { text: true },
  reduction_generated: { text: true },
  released: { text: true },
};

function eventsForTask(events, taskId) {
  return events.filter((event) => event.taskId === taskId);
}

function firstEventOfKind(events, kind) {
  return events.find((event) => event.kind === kind) ?? null;
}

function modelLine(event) {
  const parts = [event?.display?.provider, event?.display?.model].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * One recorded step, on the spine, in the band it happened in.
 *
 * Quieter than the three cards beside it, and deliberately: a reader scanning
 * this column is looking for what was asked, what was drafted and what was
 * decided, and a reduction or an agent's tool call is the detail underneath one
 * of those rather than a fourth thing of the same weight.
 *
 * A step that draws the full comparison drops its own preview of the released
 * answer. The comparison's unchanged and added lines are that answer, at full
 * length rather than bounded, so printing the preview beside them would be the
 * same words twice with the shorter copy first.
 *
 * A step's two paragraphs are not necessarily the same kind of text — the body
 * may be quoted where the note beside it is the gateway's own — so each is
 * drawn from the map of quoted parts rather than from the step as a whole.
 *
 * The instant is not here. It is in the gutter beside every moment on the
 * spine, so the times line up in one column rather than sitting inside each box
 * at whatever indent that box happens to have.
 */
export function PrivacyLedgerStep({ event }) {
  const model = modelLine(event);
  const failure = privacyFailureMessage(event);
  const comparison = event.answerComparison ?? null;
  const quotedText = answerDiffLines(comparison) ? null : event.display?.text;
  const detail = event.display?.detail;
  const quoted = QUOTED_STEP_PARTS[event.kind] ?? {};
  return html`<div class="privacy-ledger-step">
    <span class="privacy-ledger-head">
      <strong>${event.display?.title || "Step"}</strong>
      <${PrivacyAuditStatus} status=${event.display?.status} />
    </span>
    ${quotedText
      ? html`<p class=${quoted.text ? PRIVACY_PROSE_QUOTE_CLASS : null}>${quotedText}</p>`
      : null}
    ${detail
      ? event.display?.status?.tone === "failed"
        ? // A failed step's detail is the provider's disposition, not prose.
          // Give it the mono treatment the spine cards use rather than letting
          // it read as another sentence.
          html`<p class="privacy-failure-codes"><span class="privacy-failure-provider">${detail}</span></p>`
        : html`<p class=${quoted.detail ? PRIVACY_PROSE_QUOTE_CLASS : null}>${detail}</p>`
      : null}
    ${failure && failure !== quotedText && failure !== detail
      ? html`<p class="privacy-failure-detail">${failure}</p>`
      : null}

    ${model ? html`<span class="privacy-ledger-model">${model}</span>` : null}
    ${event.display?.reductions?.length
      ? html`<ul class="privacy-ledger-reductions">
          ${event.display.reductions.map((reduction, index) =>
            html`<li key=${index}>${reduction}</li>`)}
        </ul>`
      : null}
    <${PrivacyAnswerComparison} comparison=${comparison} />
  </div>`;
}

/**
 * The spine's running order, taken from the ledger rather than invented here.
 *
 * The gateway returns an exchange's steps in the order they happened, so that
 * order is the story's order and nothing on this page has to guess at it. Three
 * of those steps are the exchange's landmarks and become cards; the rest become
 * quiet rows in place. What is *not* recorded still gets a card: a draft card
 * that is missing says Omnesis is still drafting, and the decision card carries
 * the buttons that resolve a pending exchange — neither may go missing because
 * nothing wrote a step down.
 */
export function privacySpineOrder(exchange, events) {
  const askedEvent = firstEventOfKind(events, "external_request");
  const rest = events.filter((event) => event !== askedEvent);
  // The first step that is itself a crossing ends the inside band. A release
  // and an outbound response are both things that left, and a ledger can
  // record the second without the first — putting a step titled "Outbound
  // response" under the "your machine" rail, on the one screen whose claim is
  // that its left edge can be read without reading a word.
  const crossing = rest.findIndex((event) => PRIVACY_CROSSING_KINDS.has(event.kind));
  const beforeRelease = crossing >= 0 ? rest.slice(0, crossing) : rest;
  const released = crossing >= 0 && rest[crossing].kind === "released" ? rest[crossing] : null;
  const afterRelease = crossing >= 0 ? rest.slice(released ? crossing + 1 : crossing) : [];

  const inside = [];
  let hasDraft = false;
  let hasCheck = false;
  for (const event of beforeRelease) {
    if (event.kind === "candidate_generated" && !hasDraft) {
      hasDraft = true;
      inside.push({ key: event.id, kind: "draft", event });
    } else if (event.kind === "privacy_review" && !hasCheck) {
      hasCheck = true;
      inside.push({ key: event.id, kind: "check", event });
    } else {
      inside.push({ key: event.id, kind: "step", event });
    }
  }
  if (!hasDraft) inside.unshift({ key: "draft", kind: "draft", event: null });
  if (!hasCheck) inside.push({ key: "check", kind: "check", event: null });

  return {
    askedAt: askedEvent?.createdAt ?? exchange.createdAt,
    inside,
    released,
    afterRelease,
  };
}

/**
 * Which moments open a new day.
 *
 * The gutter prints a time of day beside every moment and a date only where the
 * date changes. An exchange usually happens inside one minute, so repeating the
 * same date down twelve rows would bury the only number that moves; an exchange
 * held overnight for approval spans two, and the reader has to see where.
 */
export function privacyDayBreaks(moments) {
  const breaks = new Set();
  let previous = null;
  for (const moment of moments) {
    const day = formatPrivacyDay(moment.at);
    if (day !== null && day !== previous) {
      breaks.add(moment.key);
      previous = day;
    }
  }
  return breaks;
}

/**
 * One moment on the spine: when it happened, in the gutter, and what happened,
 * beside it.
 */
function PrivacyMoment({ at, showDay, children }) {
  return html`<div class="privacy-moment">
    ${/* A step nothing timestamped still belongs on the spine; a gutter reading
          "—" beside it would claim the record holds an instant it does not. */
      privacyInstant(at)
        ? html`<time class="privacy-moment-at" datetime=${privacyDateTimeAttribute(at)}>
            ${showDay ? html`<span class="privacy-moment-day">${formatPrivacyDay(at)}</span>` : null}
            <span class="privacy-moment-clock">${formatPrivacyClock(at)}</span>
          </time>`
        : null}
    <div class="privacy-moment-body">${children}</div>
  </div>`;
}

function PrivacyBoundaryLine({ label }) {
  return html`<div class="privacy-boundary-line" role="separator" aria-label=${label}>
    <span>${label}</span>
  </div>`;
}

/**
 * One band of the story, carrying the stretch of spine that runs beside it. The
 * line is drawn on the zone rather than between the cards, so it cannot break
 * in a gap: it starts at the top of the zone's first card and runs into the
 * hairline that ends the band.
 */
function PrivacyZone({ band, children }) {
  return html`<div class=${`privacy-zone privacy-zone--${band}`}>${children}</div>`;
}

/**
 * The whole exchange as one column of moments, in ledger order.
 *
 * `events` is the exchange's own slice of the audit ledger. It supplies the
 * order, the instants, the models, and every step that is not one of the three
 * landmarks — so this component decides prominence and zone, and nothing else.
 */
export function PrivacyExchangeSpine({
  exchange,
  events = [],
  busy = null,
  actionError = null,
  onApprove,
  onDeny,
}) {
  const agentName = externalAgentNarrativeName(exchange);
  const connectionName = externalAgentConnectionName(exchange);
  const candidate = exchange.pendingCandidate;
  const shared = SHARED_OUTCOMES.has(exchange.outcome);
  const answer = privacyDisplayedAnswer(exchange);
  const drafting = exchange.status === "running" && !answer;
  const pending = exchange.outcome === "needs_review" && exchange.approval?.status === "pending";
  const findings = reviewFindings(exchange.review);
  const failure = privacyFailureMessage(exchange);
  const generationFailed = privacyAnswerGenerationFailed(exchange);
  const reviewFailed = privacyReviewFailed(exchange);
  const reviewModel = modelLine(firstEventOfKind(events, "privacy_review"));
  const order = privacySpineOrder(exchange, events);
  const receivedAt = order.released?.createdAt ?? exchange.sharedAt ?? null;
  // Whether anything crossed back out: an answer that was released, one that
  // was collected, or a step recorded after the release.
  const released = shared || order.released !== null || order.afterRelease.length > 0;

  // Every moment in the order it is rendered, so the gutter can print a date
  // only where the date changes.
  const moments = [
    { key: "asked", at: order.askedAt },
    ...order.inside.map((item) => ({
      key: item.key,
      at: item.event?.createdAt ?? (item.kind === "check" ? exchange.resolvedAt ?? null : null),
    })),
    ...(released ? [{ key: "received", at: receivedAt }] : []),
    ...order.afterRelease.map((event) => ({ key: event.id, at: event.createdAt })),
  ];
  const dayBreaks = privacyDayBreaks(moments);
  const momentAt = new Map(moments.map((moment) => [moment.key, moment.at]));

  function draftCard(item) {
    return html`<article class=${`privacy-card privacy-card--inside${generationFailed ? " privacy-card--error" : ""}`}>
      <header class="privacy-card-head">
        <${PrivacyActor}
          kind="omnesis"
          label=${generationFailed
            ? "Omnesis could not draft an answer"
            : drafting ? "Omnesis is drafting an answer" : "Omnesis drafted an answer"}
        />
      </header>
      ${answer
        ? html`
            <${PrivacyAnswerContent}
              answer=${answer}
              className=${`privacy-card-answer ${PRIVACY_PROSE_QUOTE_CLASS}`}
            />
            ${shared
              ? null
              : html`<p class="privacy-card-note">This draft has not left this machine.</p>`}
          `
        : // One sentence, not two: with no draft to show, the "has not left"
          // note would only repeat this line.
          html`<p class="privacy-card-muted">
            ${drafting
              ? "No draft has been recorded yet. Nothing has left this machine."
              : "The draft is not available. Nothing about it left this machine."}
          </p>`}
      ${generationFailed && failure
        ? html`<p class="privacy-failure-detail">${failure}</p>`
        : null}
      ${generationFailed ? html`<${PrivacyFailureDiagnostics} source=${exchange} />` : null}
      ${modelLine(item.event)
        ? html`<span class="privacy-ledger-model">${modelLine(item.event)}</span>`
        : null}
    </article>`;
  }

  /**
   * The reviewer's own words, from wherever this exchange keeps them.
   *
   * The record carries a rationale and the ledger step carries the sentence
   * the reviewer wrote; they are usually the same words, and an exchange whose
   * record kept no rationale still has the step. Reading only the record would
   * lose the reviewer's account entirely on those.
   */
  function reviewRationale(event) {
    const stated = exchange.review?.rationale;
    if (typeof stated === "string" && stated.trim().length > 0) return stated;
    const recorded = event?.display?.text;
    return typeof recorded === "string" && recorded.trim().length > 0 ? recorded : null;
  }

  function checkCard(item) {
    return html`<article class=${`privacy-card privacy-card--inside privacy-card--decision${reviewFailed ? " privacy-card--error" : ""}`}>
      <header class="privacy-card-head">
        <${PrivacyActor} kind="check" label="Privacy check" />
      </header>
      <p class="privacy-decision-sentence">
        ${exchangeDecisionCopy(exchange)}
        <${PrivacyReviewedUnder} review=${exchange.review} />
      </p>
      ${reviewFailed && failure
        ? html`<p class="privacy-failure-detail">${failure}</p>`
        : null}
      ${reviewFailed ? html`<${PrivacyFailureDiagnostics} source=${exchange} />` : null}
      ${reviewRationale(item?.event)
        ? html`<p class=${`privacy-decision-reason ${PRIVACY_PROSE_QUOTE_CLASS}`}>
            ${reviewRationale(item?.event)}
          </p>`
        : null}
      <${PrivacyFindingChips} findings=${findings} />
      ${exchange.reductions?.length
        ? html`<div class="privacy-reductions">
            <strong>Details removed before sharing</strong>
            <ul>${exchange.reductions.map((item, index) =>
              html`<li key=${index}>${item}</li>`)}</ul>
          </div>`
        : null}
      ${reviewModel
        ? html`<p class="privacy-card-caveat">Checked by ${reviewModel}.</p>`
        : null}
      ${actionError
        ? html`<div class="privacy-banner error" role="alert">${actionError}</div>`
        : null}
      ${pending
        ? html`<div class="privacy-approval-actions" role="group" aria-label="Approval actions">
            <button
              type="button"
              class="btn-primary privacy-share-button"
              disabled=${Boolean(busy) || !candidate}
              onClick=${onApprove}
            >${busy === "approve" ? "Approving…" : "Share once"}</button>
            <button
              type="button"
              class="privacy-deny-button"
              disabled=${Boolean(busy)}
              onClick=${onDeny}
            >${busy === "deny" ? "Not sharing…" : "Don’t share"}</button>
          </div>`
        : null}
    </article>`;
  }

  return html`<div class="privacy-spine">
    <${PrivacyZone} band="outside">
      <${PrivacyMoment} at=${order.askedAt} showDay=${dayBreaks.has("asked")}>
        <article class="privacy-card privacy-card--outside">
          <header class="privacy-card-head">
            <${PrivacyActor}
              kind="external"
              label=${`${agentName} asked`}
              deviceKind=${externalAgentDeviceKind(exchange)}
            />
            <time datetime=${privacyDateTimeAttribute(order.askedAt)}>
              ${formatPrivacyRelativeDate(order.askedAt)}
            </time>
          </header>
          <p class=${`privacy-card-question ${PRIVACY_PROSE_QUOTE_CLASS}`}>${exchange.question}</p>
          ${/* Everything under the rule is the caller's own account of itself.
                The name here is the full one, registry slug and all — the
                story above says "Atlas", and this is the identity that
                answers "Atlas which?". */ null}
          <dl class="privacy-card-facts">
            <div><dt>${exchange.externalAgent?.source === "principal" ? "Principal" : "Caller"}</dt><dd>${externalAgentName(exchange)}</dd></div>
            ${connectionName ? html`<div><dt>Connection</dt><dd>${connectionName}</dd></div>` : null}
            <div><dt>Workflow</dt><dd>${exchange.workflow?.name || "Unnamed workflow"}</dd></div>
            <div>
              <dt>Stated purpose</dt>
              <dd>${exchange.workflow?.purpose || "None supplied."}</dd>
            </div>
          </dl>
        </article>
      <//>
    <//>

    <${PrivacyBoundaryLine} label="your machine" />

    <${PrivacyZone} band="inside">
      <div class="privacy-inside">
        ${order.inside.map((item) => html`<${PrivacyMoment}
          key=${item.key}
          at=${momentAt.get(item.key)}
          showDay=${dayBreaks.has(item.key)}
        >
          ${item.kind === "draft"
            ? html`
                ${draftCard(item)}
                <${PrivacyAgentTranscripts}
                  traces=${exchange.agentTraces ?? []}
                  omittedAttempts=${exchange.agentTraceOmittedAttempts ?? 0}
                />
              `
            : item.kind === "check"
              ? checkCard(item)
              : html`<${PrivacyLedgerStep} event=${item.event} />`}
        <//>`)}
      </div>
    <//>

    ${/* The crossing is drawn when the ledger says something crossed. An
          answer the operator approved but the caller has not collected has a
          release step and no receipt, and dropping the whole band on that
          state would take the release — and every step after it — off the one
          screen that accounts for what left. */ null}
    ${released
      ? html`
          <${PrivacyBoundaryLine} label="left your machine" />
          <${PrivacyZone} band="received">
            <${PrivacyMoment} at=${receivedAt} showDay=${dayBreaks.has("received")}>
              ${/* The release, then the receipt it led to: a caller cannot have
                    received an answer before it was let go. */ null}
              ${order.released
                ? html`<${PrivacyLedgerStep} event=${order.released} />`
                : null}
              ${shared
                ? html`<p class="privacy-card-outside-note">
                    ${agentName} received this answer
                    ${Number.isFinite(exchange.sharedAt)
                      ? ` ${formatPrivacyRelativeDate(exchange.sharedAt)}`
                      : ""}.
                  </p>`
                : null}
            <//>
            ${order.afterRelease.map((event) => html`<${PrivacyMoment}
              key=${event.id}
              at=${event.createdAt}
              showDay=${dayBreaks.has(event.id)}
            >
              <${PrivacyLedgerStep} event=${event} />
            <//>`)}
          <//>
        `
      : null}
  </div>`;
}

/**
 * The header's overflow menu. It holds the page's only destructive action, so
 * it must be dismissable without taking it: Escape and a click anywhere outside
 * both close it, and focus returns to the toggle so a keyboard user is left
 * where they opened it rather than at the top of the document.
 */
export function PrivacyDetailOverflow({ onDelete, itemLabel = "Delete audit conversation" }) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const toggle = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function close() {
      setOpen(false);
      toggle.current?.focus();
    }
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    function onPointerDown(event) {
      if (!container.current?.contains(event.target)) setOpen(false);
    }
    globalThis.document?.addEventListener("keydown", onKeyDown);
    globalThis.document?.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.document?.removeEventListener("keydown", onKeyDown);
      globalThis.document?.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return html`<div class="privacy-overflow" ref=${container}>
    <button
      type="button"
      class="privacy-overflow-toggle"
      ref=${toggle}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-label="More actions"
      onClick=${() => setOpen((value) => !value)}
    >⋯</button>
    ${open
      ? html`<div class="privacy-overflow-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            class="privacy-overflow-item danger"
            onClick=${() => { setOpen(false); onDelete(); }}
          >${itemLabel}</button>
        </div>`
      : null}
  </div>`;
}

/** One exchange, or every exchange in a conversation when no task is named. */
export function PrivacyExchangeDetailRoute({ conversationId, taskId = null }) {
  const [conversation, setConversation] = useState(null);
  const [exchanges, setExchanges] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const generation = useRef(0);
  const backgroundLoadInFlight = useRef(false);
  const foregroundLoadsInFlight = useRef(0);

  async function load({ background = false } = {}) {
    if (background && foregroundLoadsInFlight.current > 0) return;
    const current = ++generation.current;
    if (!background) foregroundLoadsInFlight.current += 1;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const [conversationPayload, exchangePayload, eventPayload] = await Promise.all([
        getPrivacyConversation(conversationId),
        listPrivacyExchanges(conversationId, {
          limit: 50,
          includeAgentTracesTaskId: taskId,
        }),
        listPrivacyAuditEvents(conversationId, { limit: 100 }),
      ]);
      if (generation.current !== current) return;
      const detail = privacyConversationDocument(conversationPayload);
      const items = privacyCollection(exchangePayload, "exchanges");
      if (!detail || !items) throw new Error("Conversation response was incomplete.");
      setConversation(detail);
      setExchanges(items);
      setEvents(privacyCollection(eventPayload, "events") ?? []);
      setError(null);
    } catch (err) {
      if (!background && generation.current === current) setError(errorMessage(err));
    } finally {
      if (!background) foregroundLoadsInFlight.current -= 1;
      if (!background && generation.current === current) setLoading(false);
    }
  }

  async function refreshRunningExchange() {
    if (backgroundLoadInFlight.current) return;
    backgroundLoadInFlight.current = true;
    try {
      await load({ background: true });
    } finally {
      backgroundLoadInFlight.current = false;
    }
  }

  useEffect(() => {
    setConversation(null);
    setExchanges([]);
    setEvents([]);
    setActionError(null);
    load();
    return () => { generation.current += 1; };
  }, [conversationId, taskId]);

  const shown = taskId
    ? exchanges.filter((exchange) => exchange.taskId === taskId)
    : exchanges;
  const hasRunningExchange = shown.some((exchange) => exchange.status === "running");
  useVisiblePoll(refreshRunningExchange, RUNNING_EXCHANGE_REFRESH_MS, {
    enabled: hasRunningExchange,
  });

  async function resolve(approvalId, action) {
    if (busy) return;
    setBusy(`${approvalId}:${action}`);
    setActionError(null);
    try {
      if (action === "approve") await approvePrivacyApproval(approvalId);
      else await denyPrivacyApproval(approvalId);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeConversation() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deletePrivacyConversation(conversationId);
      navigate("/portal/audit");
    } catch (err) {
      setActionError(errorMessage(err));
      setConfirmDelete(false);
      setDeleting(false);
    }
  }

  const single = shown.length === 1 ? shown[0] : null;
  const outcome = single ? privacyExchangeOutcomeDisplay(single) : null;
  // An unrecognised outcome has no truthful one-line name, so the page is
  // titled by what it is about instead; the spine below still reports that the
  // outcome could not be read.
  const heading = outcome?.known
    ? outcome.label
    : conversation?.workflowName || "External activity";

  return html`
    <div class="privacy-view">
      <a
        class="doc-back"
        href="/portal/audit"
        onClick=${(event) => { event.preventDefault(); navigate("/portal/audit"); }}
      >← Activity</a>

      ${loading ? html`<${Loading} label="Loading exchange…" />` : null}
      ${!loading && error
        ? html`<div class="privacy-banner error" role="alert">Failed to load exchange: ${error}</div>`
        : null}

      ${!loading && !error && conversation
        ? html`
            <header class="privacy-detail-header">
              <div>
                <h1>${heading}</h1>
                <p>
                  ${externalAgentNarrativeName(single ?? conversation)}
                  ${single ? "" : ` · ${shown.length} exchange${shown.length === 1 ? "" : "s"}`}
                </p>
              </div>
              <${PrivacyDetailOverflow} onDelete=${() => setConfirmDelete(true)} />
            </header>

            ${actionError && !single
              ? html`<div class="privacy-banner error" role="alert">${actionError}</div>`
              : null}

            ${shown.length === 0
              ? html`<p class="privacy-empty">This exchange is no longer available.</p>`
              : shown.map((exchange) => {
                  const recordEvents = eventsForTask(events, exchange.taskId);
                  const approvalId = exchange.approval?.id ?? null;
                  return html`<section class="privacy-exchange-block" key=${exchange.taskId}>
                    ${single ? null : html`<${PrivacyOutcome} exchange=${exchange} />`}
                    <${PrivacyExchangeSpine}
                      exchange=${exchange}
                      events=${recordEvents}
                      busy=${busy?.startsWith(`${approvalId}:`) ? busy.split(":").pop() : null}
                      actionError=${single ? actionError : null}
                      onApprove=${() => approvalId && resolve(approvalId, "approve")}
                      onDeny=${() => approvalId && resolve(approvalId, "deny")}
                    />
                  </section>`;
                })}
          `
        : null}

      <${ConfirmModal}
        open=${confirmDelete}
        title="Delete audit conversation"
        body="This removes the trusted audit transcript and its external-view history. This cannot be undone."
        confirmLabel=${deleting ? "Deleting…" : "Delete"}
        destructive=${true}
        onConfirm=${removeConversation}
        onCancel=${() => { if (!deleting) setConfirmDelete(false); }}
      />
    </div>
  `;
}
