// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Privacy landing: what is waiting on you, then what left this machine.
 *
 * Anything pending is pinned at the top as a full review card — the exact held
 * answer, the reason Omnesis paused, and both decisions inline — because a
 * pending item is an exchange, and putting it behind a separate tab is what
 * hides it. Below it the flat feed, newest first, one row per exchange. Rows
 * are grouped by workflow with a quiet rule rather than collapsed into a
 * conversation: a collapsed row's title, time and status each describe a
 * different event.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  approvePrivacyApproval,
  denyPrivacyApproval,
  getPrivacyApproval,
  listPrivacyExchangeFeed,
} from "../../api.js";
import { LoadMore } from "../../components/load-more.js";
import { Loading } from "../../components/loading.js";
import { Segmented } from "../../components/segmented.js";
import { KindIcon } from "../../lib/device-kind-icon.js";
import { navigate } from "../../lib/router.js";
import { useCursorPage } from "../../lib/use-cursor-page.js";
import {
  errorMessage,
  formatPrivacyDate,
  formatPrivacyDayHeading,
  formatPrivacyRelativeDate,
  formatPrivacyTimeOfDay,
  privacyCollection,
  privacyDateTimeAttribute,
  privacyDayKey,
} from "../shared/privacy-vocabulary.js";
import {
  PRIVACY_FEED_FILTERS,
  PrivacyActivityLoadFailure,
  PrivacyActor,
  PrivacyAnswerContent,
  PrivacyFeedOutcome,
  PrivacyFindingChips,
  PrivacyReviewedUnder,
  exchangeDetailPath,
  externalAgentDeviceKind,
  externalAgentNarrativeName,
  privacyApprovalDocument,
  privacyFailureDiagnostics,
  privacyFeedFilterMatches,
  privacyPauseCopy,
  privacyResolutionCopy,
  reviewFindings,
} from "./shared.js";

/**
 * How many pending exchanges get a full review card. Pending items are few by
 * construction — they expire — but the cap keeps one runaway integration from
 * turning the landing page into an unreadable stack, and the rest stay visible
 * as feed rows carrying the "Needs your review" chip.
 */
const MAX_PINNED_REVIEWS = 5;

function isPendingReview(exchange) {
  return exchange?.outcome === "needs_review" && exchange?.approval?.status === "pending";
}

/**
 * The pinned review card takes an approval-shaped record from either the feed
 * or the dedicated approval route.
 */
export function PrivacyReviewCard({
  approval,
  busy,
  error,
  onApprove,
  onDeny,
}) {
  const agentName = externalAgentNarrativeName(approval);
  const candidateAvailable = typeof approval.candidateAnswer === "string"
    && approval.candidateAnswer.trim().length > 0;
  const pause = privacyPauseCopy(approval.review);
  const findings = reviewFindings(approval.review);

  return html`
    <article class="privacy-review-card">
      <header class="privacy-review-card-head">
        <${PrivacyActor}
          kind="external"
          label=${`${agentName} asked`}
          deviceKind=${externalAgentDeviceKind(approval)}
        />
        <time datetime=${privacyDateTimeAttribute(approval.createdAt)}>
          ${formatPrivacyRelativeDate(approval.createdAt)}
        </time>
      </header>

      <p class="privacy-review-question">${approval.question}</p>

      <div class="privacy-review-answer">
        <span class="privacy-review-answer-label">Answer held inside Omnesis</span>
        ${candidateAvailable
          ? html`<${PrivacyAnswerContent}
              answer=${approval.candidateAnswer}
              className="privacy-held-answer"
            />`
          : html`<div class="privacy-answer-unavailable" role="status">
              <strong>The exact answer is unavailable.</strong>
              <p>It cannot be shared from here. You can still choose not to share it.</p>
            </div>`}
      </div>

      <div class="privacy-review-reason">
        <strong>${pause.title}</strong>
        <p>${pause.message}</p>
        <${PrivacyReviewedUnder} review=${approval.review} />
        <${PrivacyFindingChips} findings=${findings} limit=${3} />
      </div>

      ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}

      <div class="privacy-approval-actions" role="group" aria-label="Approval actions">
        <button
          type="button"
          class="btn-primary privacy-share-button"
          disabled=${Boolean(busy) || !candidateAvailable}
          onClick=${onApprove}
        >
          ${busy === "approve" ? "Approving…" : "Share once"}
        </button>
        <button
          type="button"
          class="privacy-deny-button"
          disabled=${Boolean(busy)}
          onClick=${onDeny}
        >${busy === "deny" ? "Not sharing…" : "Don’t share"}</button>
      </div>
    </article>
  `;
}

/** The instant a row is filed under: when it concluded, else when it began. */
function privacyFeedRowInstant(exchange) {
  return exchange?.sharedAt ?? exchange?.resolvedAt ?? exchange?.createdAt ?? null;
}

/**
 * One exchange, one row. The question is the row's identity; the outcome and
 * the time say what became of it.
 *
 * The time is a clock reading rather than a distance, because the row sits
 * under a heading that already carries the day: a column of them at one x is
 * read as a sequence, where twelve rows each saying "yesterday" are not. The
 * full instant stays on the element for anyone who hovers or reads the markup.
 */
export function PrivacyFeedRow({ exchange }) {
  const agentName = externalAgentNarrativeName(exchange);
  const deviceKind = externalAgentDeviceKind(exchange);
  const href = exchangeDetailPath(exchange.conversationId, exchange.taskId);
  const at = privacyFeedRowInstant(exchange);
  // The chip already says an answer failed; this says which failure it was, so
  // a run of failed rows is legible as one cause or several without opening
  // each one.
  const failureCode = privacyFailureDiagnostics(exchange)?.code ?? null;
  return html`<a
    class="privacy-feed-row"
    href=${href}
    onClick=${(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigate(href);
    }}
  >
    <span class="privacy-feed-main">
      <span class="privacy-feed-question">
        <strong class="privacy-feed-asker">${deviceKind
          ? html`<${KindIcon} kind=${deviceKind} size=${14} class="privacy-feed-device" />`
          : null}${agentName} asked</strong> <span class="privacy-feed-quote">“${exchange.question}”</span>
      </span>
      <span class="privacy-feed-meta">
        <${PrivacyFeedOutcome} exchange=${exchange} />
        ${failureCode ? html`<code class="privacy-feed-failure">${failureCode}</code>` : null}
        ${/* The row is itself the link to the exchange, so the policy is
              named here and linked from the detail it opens. */ null}
        <${PrivacyReviewedUnder} review=${exchange.review} link=${false} />
      </span>
    </span>
    <time
      class="privacy-feed-time"
      datetime=${privacyDateTimeAttribute(at)}
      title=${formatPrivacyDate(at)}
    >${formatPrivacyTimeOfDay(at)}</time>
    <span class="privacy-row-chevron" aria-hidden="true">›</span>
  </a>`;
}

/**
 * The feed, cut into the days it happened on, newest first.
 *
 * Grouping by day is the one heading this list can carry without breaking what
 * it is: the feed is read as a chronology, and a day boundary is part of that
 * chronology rather than a second axis laid across it. Which workflow a row
 * belongs to — the cut that would break it — stays on the row's detail page.
 */
export function privacyFeedDays(exchanges) {
  const days = [];
  const byKey = new Map();
  for (const exchange of exchanges) {
    const at = privacyFeedRowInstant(exchange);
    const key = privacyDayKey(at);
    let day = byKey.get(key);
    if (!day) {
      day = { key, heading: formatPrivacyDayHeading(at), exchanges: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.exchanges.push(exchange);
  }
  return days;
}

/**
 * Every exchange, newest first, under the day it happened on.
 *
 * `filter` is what the reader narrowed to, and it changes what an empty list
 * means: with nothing filtered out, an empty feed says nothing has ever left
 * this machine; under a filter it says only that this page of activity holds
 * none of that kind, which is a different and much smaller claim.
 */
export function PrivacyExchangeFeed({ exchanges, filter = "all" }) {
  if (exchanges.length === 0) {
    return html`<div class="privacy-empty-state">
      ${filter === "all"
        ? html`<strong>Nothing has left this machine</strong>
            <span>Every question an external agent asks Omnesis appears here, with what was shared.</span>`
        : html`<strong>No matching activity</strong>
            <span>Nothing in the activity loaded so far has this status. Load older activity to look further back.</span>`}
    </div>`;
  }
  return html`<div class="privacy-feed">
    ${privacyFeedDays(exchanges).map((day) => html`<section class="privacy-feed-day" key=${day.key}>
      <h3 class="privacy-feed-day-heading">${day.heading}</h3>
      ${day.exchanges.map((exchange) => html`<${PrivacyFeedRow}
        key=${exchange.taskId}
        exchange=${exchange}
      />`)}
    </section>`)}
  </div>`;
}

/**
 * Shapes a pending feed exchange like the approval detail used by the card.
 */
export function pinnedApprovalRecord(exchange) {
  return {
    id: exchange.approval.id,
    taskId: exchange.taskId,
    workflowId: exchange.workflowId,
    conversationId: exchange.conversationId,
    workflowName: exchange.workflow?.name ?? "",
    workflowPurpose: exchange.workflow?.purpose ?? "",
    question: exchange.question,
    candidateAnswer: exchange.pendingCandidate,
    status: exchange.approval.status,
    createdAt: exchange.createdAt,
    expiresAt: exchange.approval.expiresAt,
    resolvedAt: exchange.approval.resolvedAt ?? null,
    sharedAt: null,
    review: exchange.review,
    externalAgent: exchange.externalAgent,
  };
}

function PrivacyPendingReviews({ exchanges, onResolved }) {
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});

  async function resolve(approvalId, action) {
    if (busy) return;
    setBusy(`${approvalId}:${action}`);
    setErrors((previous) => ({ ...previous, [approvalId]: null }));
    try {
      const response = action === "approve"
        ? await approvePrivacyApproval(approvalId)
        : await denyPrivacyApproval(approvalId);
      const exchange = exchanges.find((item) => item.approval?.id === approvalId);
      onResolved(privacyResolutionCopy(response, exchange));
    } catch (err) {
      setErrors((previous) => ({ ...previous, [approvalId]: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  }

  if (exchanges.length === 0) return null;

  return html`<section class="privacy-pending" aria-label="Waiting for your decision">
    <header class="privacy-section-head">
      <h2>${exchanges.length === 1 ? "One answer is waiting for you" : `${exchanges.length} answers are waiting for you`}</h2>
    </header>
    ${exchanges.map((exchange) => {
      const approvalId = exchange.approval.id;
      const record = pinnedApprovalRecord(exchange);
      return html`<${PrivacyReviewCard}
        key=${approvalId}
        approval=${record}
        busy=${busy?.startsWith(`${approvalId}:`) ? busy.split(":").pop() : null}
        error=${errors[approvalId] ?? null}
        onApprove=${() => resolve(approvalId, "approve")}
        onDeny=${() => resolve(approvalId, "deny")}
      />`;
    })}
  </section>`;
}

/**
 * The status filter, and a tally of what each option would leave on screen.
 *
 * The tallies count the activity that has been loaded, which is what the list
 * below can show — a number drawn from the whole ledger would promise rows the
 * filter cannot produce until more pages are fetched.
 */
function PrivacyFeedFilter({ value, onChange, exchanges }) {
  const options = PRIVACY_FEED_FILTERS.map((option) => ({
    ...option,
    count: exchanges.filter((exchange) => privacyFeedFilterMatches(option.value, exchange)).length,
  }));
  return html`<${Segmented}
    className="privacy-feed-filter"
    options=${options}
    value=${value}
    onChange=${onChange}
  />`;
}

export function PrivacyActivityPane() {
  const [resolution, setResolution] = useState(null);
  const [filter, setFilter] = useState("all");
  const page = useCursorPage({
    resetKey: "privacy-exchange-feed",
    pageSize: 50,
    loadPage: async ({ limit, cursor }) => {
      const payload = await listPrivacyExchangeFeed({ limit, cursor });
      const items = privacyCollection(payload, "exchanges");
      if (!items) throw new Error("Activity feed response was incomplete.");
      return { items, nextCursor: payload.nextCursor ?? null };
    },
    itemKey: (item) => item.taskId,
  });

  const pending = page.items.filter(isPendingReview).slice(0, MAX_PINNED_REVIEWS);
  const pinnedTaskIds = new Set(pending.map((exchange) => exchange.taskId));
  // The pinned reviews are not part of the feed and the filter never touches
  // them: they are the one thing on this page that is waiting on the operator,
  // and a narrowed list is not a reason to stop showing it.
  const listed = page.items.filter((exchange) => !pinnedTaskIds.has(exchange.taskId));
  const feed = listed.filter((exchange) => privacyFeedFilterMatches(filter, exchange));

  function onResolved(copy) {
    setResolution(copy);
    page.reload();
  }

  return html`
    <div class="privacy-activity">
      ${resolution
        ? html`<div class="privacy-banner success privacy-resolution-banner" role="status">
            <strong>${resolution.title}</strong> <span>${resolution.message}</span>
          </div>`
        : null}

      ${page.error
        ? html`<${PrivacyActivityLoadFailure} error=${page.error} onRetry=${page.reload} />`
        : null}
      ${page.loading && !page.error ? html`<${Loading} label="Loading activity…" />` : null}

      ${page.loaded && !page.error
        ? html`
            <${PrivacyPendingReviews}
              exchanges=${pending}
              onResolved=${onResolved}
            />
            <section class="privacy-section privacy-pane-section">
              <header class="privacy-feed-head">
                <${PrivacyFeedFilter}
                  value=${filter}
                  onChange=${setFilter}
                  exchanges=${listed}
                />
              </header>
              <${PrivacyExchangeFeed} exchanges=${feed} filter=${filter} />
              <${LoadMore}
                hasMore=${page.hasMore}
                loading=${page.loadingMore}
                error=${page.loadMoreError}
                onLoadMore=${page.loadMore}
                label="Load older activity"
              />
            </section>
          `
        : null}
    </div>
  `;
}

/**
 * A single approval opened by id. The landing feed pins pending reviews inline,
 * so this route serves links that name one approval on its own — a push
 * notification, a bookmark — and points at the exchange detail once the
 * approval is no longer pending.
 */
export function PrivacyApprovalRoute({ approvalId }) {
  const [approval, setApproval] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [resolution, setResolution] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setApproval(null);
    setResolution(null);
    setBusy(null);
    setLoading(true);
    setError(null);
    getPrivacyApproval(approvalId)
      .then((payload) => {
        if (generation.current !== current) return;
        const detail = privacyApprovalDocument(payload);
        if (!detail) throw new Error("Approval response was incomplete.");
        setApproval(detail);
      })
      .catch((err) => {
        if (generation.current === current) setError(errorMessage(err));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [approvalId]);

  async function resolve(action) {
    if (busy) return;
    const current = generation.current;
    setBusy(action);
    setError(null);
    try {
      const response = action === "approve"
        ? await approvePrivacyApproval(approvalId)
        : await denyPrivacyApproval(approvalId);
      if (generation.current !== current) return;
      setApproval(null);
      setResolution(privacyResolutionCopy(response, approval));
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }

  return html`
    <div class="privacy-view">
      <a
        class="doc-back"
        href="/portal/audit"
        onClick=${(event) => { event.preventDefault(); navigate("/portal/audit"); }}
      >← Activity</a>

      ${loading ? html`<${Loading} label="Loading review…" />` : null}
      ${!loading && resolution
        ? html`<div class="privacy-resolution" role="status">
            <h1>${resolution.title}</h1>
            <p>${resolution.message}</p>
            <button type="button" class="btn-secondary" onClick=${() => navigate("/portal/audit")}>
              Back to activity
            </button>
          </div>`
        : null}
      ${!loading && !resolution && approval && approval.status === "pending"
        ? html`<${PrivacyReviewCard}
            approval=${approval}
            busy=${busy}
            error=${error}
            onApprove=${() => resolve("approve")}
            onDeny=${() => resolve("deny")}
          />`
        : null}
      ${!loading && !resolution && approval && approval.status !== "pending"
        ? html`<div class="privacy-banner" role="status">
            This review is already decided.
            <a
              href=${exchangeDetailPath(approval.conversationId, approval.taskId)}
              onClick=${(event) => {
                event.preventDefault();
                navigate(exchangeDetailPath(approval.conversationId, approval.taskId));
              }}
            >See what happened</a>
          </div>`
        : null}
      ${!loading && !resolution && !approval && error
        ? html`<div class="privacy-banner error" role="alert">Failed to load review: ${error}</div>`
        : null}
    </div>
  `;
}
