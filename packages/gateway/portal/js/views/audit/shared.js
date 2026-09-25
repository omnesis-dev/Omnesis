// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Vocabulary specific to the Privacy surfaces: the exchange-outcome map, the
 * three fixed actor glyphs, the review copy, and the page chrome. The
 * formatters and the lifecycle status chip that Watches also speaks live in
 * `../shared/privacy-vocabulary.js`.
 *
 * The glyphs are deliberately abstract. An exchange has exactly three actors —
 * the external agent that asked, Omnesis which drafted, and the privacy check
 * which decided — and each gets one fixed mark. The caller's display name is
 * self-asserted, so a vendor logo would assert an identity Omnesis cannot
 * verify; and the reviewer is a function of Omnesis rather than a product, so
 * it gets a lock rather than anything logo-shaped. Every glyph paints in
 * `currentColor` and sits at lower visual weight than the text label beside it,
 * so the whole design survives being read in monochrome.
 */

import { html } from "htm/preact";

import { LoadMore } from "../../components/load-more.js";
import { KindIcon } from "../../lib/device-kind-icon.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { policyEditorPath } from "../../lib/policy-path.js";
import { navigate } from "../../lib/router.js";

/**
 * The surface every verbatim quote in this section is drawn on: the request as
 * it arrived, the answer the agent drafted, the reviewer's own account of it,
 * the text that left, and the comparison between the last two. Prose Omnesis
 * wrote about an exchange never takes it — the contrast is what tells a reader
 * whose words they are looking at.
 */
export const PRIVACY_QUOTE_CLASS = "privacy-quote";

/** A quote of plain prose, as opposed to the comparison's own line grid. */
export const PRIVACY_PROSE_QUOTE_CLASS = `${PRIVACY_QUOTE_CLASS} privacy-quote--prose`;

export function privacyApprovalDocument(payload) {
  if (typeof payload?.id === "string") return payload;
  return payload?.approval && typeof payload.approval.id === "string" ? payload.approval : null;
}

export function privacyConversationDocument(payload) {
  if (typeof payload?.id === "string") return payload;
  return payload?.conversation && typeof payload.conversation.id === "string"
    ? payload.conversation
    : null;
}

/**
 * Outcome tones, split by the one question a reader scanning this screen is
 * asking: did an answer reach the caller? Two of these say yes, two say no, and
 * the rest have not reached an answer — which is what the stylesheet paints, so
 * that the answer is legible before the label is read.
 */
const OUTCOME_TONE = {
  checking: "waiting",
  needs_review: "review",
  ready: "waiting",
  shared: "released",
  shared_with_reductions: "reduced",
  not_shared: "kept",
  failed: "failed",
  canceled: "kept",
};

const OUTCOME_LABELS = {
  checking: "Checking",
  needs_review: "Needs your review",
  ready: "Approved, waiting for agent",
  shared: "Shared with the agent",
  shared_with_reductions: "Shared with details removed",
  not_shared: "Not shared",
  failed: "Nothing shared; check failed",
  canceled: "Canceled",
};

/**
 * How one exchange outcome presents: its chip tone, its label, and whether this
 * portal recognises it at all.
 *
 * A gateway ahead of the portal can name an outcome this build has never heard
 * of, so the unknown case is a real one rather than a defensive branch. It
 * never borrows the copy of a state it might not be — reading "Checking" for a
 * released answer, on the one screen whose job is reporting what left the
 * machine, is the worst reading available. It gets a neutral chip that says the
 * outcome could not be read, and `known` lets a caller that needs a truthful
 * phrase (a page title, say) choose something else entirely.
 */
export function privacyOutcomeDisplay(outcome) {
  const label = OUTCOME_LABELS[outcome];
  if (!label) return { tone: "unknown", label: "Outcome not recognised", known: false };
  return { tone: OUTCOME_TONE[outcome], label, known: true };
}

export function privacyExchangeOutcomeDisplay(exchange) {
  const display = privacyOutcomeDisplay(exchange?.outcome);
  const recipient = externalAgentReference(exchange);
  if (exchange?.outcome === "ready") return { ...display, label: `Approved, waiting for ${recipient}` };
  if (exchange?.outcome === "shared") return { ...display, label: `Shared with ${recipient}` };
  if (exchange?.outcome === "shared_with_reductions") {
    return { ...display, label: `Shared with ${recipient}, details removed` };
  }
  if (exchange?.outcome !== "failed") return display;
  return {
    ...display,
    label: privacyAnswerGenerationFailed(exchange)
      ? "Nothing shared; answer failed"
      : "Nothing shared; privacy check failed",
  };
}

/**
 * The status filter over the feed, as the four answers a reader is looking for
 * when they narrow it: what left, what did not, what broke, and what has not
 * finished. Every outcome belongs to exactly one of them.
 */
export const PRIVACY_FEED_FILTERS = [
  { value: "all", label: "All" },
  { value: "shared", label: "Shared" },
  { value: "not_shared", label: "Not shared" },
  { value: "failed", label: "Failed" },
  { value: "waiting", label: "Waiting" },
];

const FEED_FILTER_BY_OUTCOME = {
  shared: "shared",
  shared_with_reductions: "shared",
  not_shared: "not_shared",
  canceled: "not_shared",
  failed: "failed",
  checking: "waiting",
  ready: "waiting",
  needs_review: "waiting",
};

/**
 * Whether one exchange belongs under one filter.
 *
 * An outcome this build cannot classify — a gateway ahead of the portal can
 * name one — passes every filter rather than none. On the one screen that
 * reports what left this machine, a row the reader can see under "All" and
 * nowhere else is a row the filter has hidden, and hiding is the failure this
 * page cannot afford; the row carries the chip that says its outcome could not
 * be read, so it is never mistaken for the filter it was found under.
 */
export function privacyFeedFilterMatches(filter, exchange) {
  if (filter === "all") return true;
  const bucket = FEED_FILTER_BY_OUTCOME[exchange?.outcome];
  return bucket === undefined || bucket === filter;
}

/**
 * The same outcomes, said the way a feed row has room to say them.
 *
 * Every row opens with the caller's name — "Atlas Desk asked" — so an outcome
 * that names the recipient again spends the row's width restating the word
 * beside it. Only the three labels that interpolate a recipient are shortened;
 * every other outcome already says the one thing it has to say.
 */
const FEED_OUTCOME_LABELS = {
  ready: "Approved, waiting",
  shared: "Shared",
  shared_with_reductions: "Shared, details removed",
};

/**
 * Outcomes that have settled the way the operator expects them to.
 *
 * A page where nine rows in ten are a filled chip spends its loudest mark on
 * its most ordinary fact, and the one row that wants a decision has nothing
 * left to be louder than. These render as a mark in the outcome's colour
 * against the row's own text; the tones outside this set — a review still
 * owed, a failure, an outcome this build cannot read — keep the chip.
 */
const QUIET_OUTCOME_TONES = new Set(["released", "reduced", "kept", "waiting"]);

export function privacyFeedOutcomeDisplay(exchange) {
  const display = privacyExchangeOutcomeDisplay(exchange);
  const label = FEED_OUTCOME_LABELS[exchange?.outcome];
  return display.known && label ? { ...display, label } : display;
}

/**
 * One exchange's outcome, on a row in a list of them.
 */
export function PrivacyFeedOutcome({ exchange }) {
  const display = privacyFeedOutcomeDisplay(exchange);
  if (!QUIET_OUTCOME_TONES.has(display.tone)) {
    return html`<span class=${`privacy-chip privacy-chip--${display.tone}`}>${display.label}</span>`;
  }
  return html`<span class=${`privacy-status privacy-status--${display.tone}`}>
    <span class="privacy-status-dot" aria-hidden="true"></span>
    ${display.label}
  </span>`;
}

export function PrivacyOutcome({ outcome, exchange }) {
  const display = exchange
    ? privacyExchangeOutcomeDisplay(exchange)
    : privacyOutcomeDisplay(outcome);
  return html`<span class=${`privacy-chip privacy-chip--${display.tone}`}>${display.label}</span>`;
}

/**
 * The closed set of audit statuses a ledger row may render. The gateway maps
 * every raw producer token — a reviewer decision, or a model's terminal stop
 * reason drawn from an open string — onto `{code,label}` and drops the rest, so
 * anything that is not one of the four codes renders nothing at all rather than
 * arriving on screen styled as if it meant something.
 */
const AUDIT_STATUS_TONE = {
  allowed: "released",
  reduced: "reduced",
  held: "review",
  blocked: "kept",
};

export function auditStatusDisplay(status) {
  const tone = AUDIT_STATUS_TONE[status?.code];
  if (!tone) return null;
  const label = typeof status.label === "string" ? status.label.trim() : "";
  if (!label) return null;
  return { tone, label };
}

export function PrivacyAuditStatus({ status }) {
  const display = auditStatusDisplay(status);
  if (!display) return null;
  return html`<span class=${`privacy-chip privacy-chip--${display.tone}`}>${display.label}</span>`;
}

export function externalAgentName(value) {
  return value?.externalAgent?.displayName || value?.displayName || "External agent";
}

/**
 * A caller's display name often trails the registry slug it connected under —
 * `Atlas (openclaw)`. Only a bare lowercase token in trailing parentheses is
 * treated as a slug, so a caller that genuinely names itself `Acme (support
 * desk)` keeps every word.
 */
const AGENT_SLUG_SUFFIX = /\s*\([a-z0-9][a-z0-9._-]*\)$/;

/**
 * The name the narrative uses. Which integration a caller arrived through is
 * implementation detail in a plain-language story — a reader needs "Atlas
 * asked". `externalAgentName` is the full name, slug included, which the
 * exchange states among the caller's own claims about itself.
 */
export function externalAgentNarrativeName(value) {
  const supplied = value?.externalAgent?.narrativeName || value?.narrativeName;
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  const name = externalAgentName(value);
  return name.replace(AGENT_SLUG_SUFFIX, "").trim() || name;
}

export function externalAgentReference(value) {
  const name = externalAgentNarrativeName(value);
  return name === "External agent" ? "the external agent" : name;
}

export function externalAgentConnectionName(value) {
  const name = value?.externalAgent?.connectionName || value?.connectionName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/* ── The three fixed actor glyphs ─────────────────────────────────────────── */

/**
 * The external caller. One abstract mark for every caller — openclaw, hermes,
 * anything — because a per-vendor logo would imply a vendor identity that the
 * label alone does not establish. An arrow leaving an
 * enclosure: something outside the boundary, reaching in.
 */
export function ExternalAgentGlyph() {
  return html`<svg
    class="privacy-glyph privacy-glyph--external"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5L12.5 11.5" />
    <path d="M18 14.5V17.5C18 18.6 17.1 19.5 16 19.5H6.5C5.4 19.5 4.5 18.6 4.5 17.5V8C4.5 6.9 5.4 6 6.5 6H9.5" />
  </svg>`;
}

/** Omnesis itself, drafting inside the boundary. */
function OmnesisGlyph() {
  return html`<span class="privacy-glyph privacy-glyph--omnesis omnesis-mark" aria-hidden="true"></span>`;
}

/**
 * The privacy check. A closed padlock, monochrome and deliberately not
 * logo-shaped: the reviewer is a function of Omnesis, not a vendor with a mark
 * of its own.
 */
function PrivacyCheckGlyph() {
  return html`<svg
    class="privacy-glyph privacy-glyph--check"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="4.75" y="10.25" width="14.5" height="9.5" rx="2" />
    <path d="M8 10.25V7.5C8 5.29 9.79 3.5 12 3.5C14.21 3.5 16 5.29 16 7.5V10.25" />
    <circle cx="12" cy="15" r="1.35" fill="currentColor" stroke="none" />
  </svg>`;
}

const ACTOR_GLYPHS = {
  external: ExternalAgentGlyph,
  omnesis: OmnesisGlyph,
  check: PrivacyCheckGlyph,
};

/**
 * The actor line at the head of a spine card. The text carries the meaning; the
 * glyph is decorative reinforcement, which is why it is `aria-hidden` and set
 * at a lower weight than the label.
 */
/**
 * One actor on the spine. A caller that is a paired device is drawn with its
 * device kind's icon — the one the Devices page shows — rather than the
 * generic external mark, so the same device looks the same everywhere.
 */
export function PrivacyActor({ kind, label, deviceKind = null }) {
  const Glyph = ACTOR_GLYPHS[kind] ?? ExternalAgentGlyph;
  return html`<span class="privacy-actor">
    ${kind === "external" && deviceKind
      ? html`<${KindIcon} kind=${deviceKind} size=${16} class="privacy-glyph privacy-glyph--device" />`
      : html`<${Glyph} />`}
    <span class="privacy-actor-label">${label}</span>
  </span>`;
}

/** The kind of the paired device that asked, when a device did. */
export function externalAgentDeviceKind(value) {
  const kind = value?.externalAgent?.deviceKind ?? value?.deviceKind;
  return typeof kind === "string" && kind ? kind : null;
}

/* ── Review copy ──────────────────────────────────────────────────────────── */

/**
 * Sentence case per word, splitting on spaces only. A hyphen or an apostrophe
 * inside a word is not a word boundary here, so `e-mail` stays `E-mail` rather
 * than becoming `E-Mail`.
 */
function titleCase(value) {
  return String(value)
    .replaceAll("_", " ")
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * How one finding names itself on a chip.
 *
 * A finding about anyone other than the operator is named by that fact and
 * nothing else — `other_person` and `multiple_people` both mean "not you", and
 * which of the two it is would only narrow down who. The category itself is
 * free text the reviewer model authors, so there is no table to look it up in;
 * it is presented as written, with `_` read as a space.
 */
function privacyFindingLabel(finding) {
  if (finding?.subject === "other_person" || finding?.subject === "multiple_people") {
    return "Another person";
  }
  const raw = String(finding?.category ?? "").trim();
  const category = titleCase(raw || "Sensitive information");
  return finding?.detailLevel === "exact" && !category.startsWith("Exact ")
    ? `Exact ${category.toLowerCase()}`
    : category;
}

const AUTOMATIC_CHECK_FALLBACKS = new Set([
  "not_configured",
  "request_failed",
  "invalid_output",
  "low_confidence",
]);

const PRIVACY_REVIEW_FAILURES = new Set([
  ...AUTOMATIC_CHECK_FALLBACKS,
  "context_window_exceeded",
  "output_truncated",
]);

export function privacyPauseCopy(review) {
  if (AUTOMATIC_CHECK_FALLBACKS.has(review?.fallbackCause)) {
    return {
      title: "Automatic privacy check unavailable",
      message: "Omnesis could not verify this answer automatically, so nothing was shared. Review the exact answer shown above.",
    };
  }
  if (review?.fallbackCause === "hard_stop") {
    return {
      title: "This answer cannot be shared",
      message: "Omnesis detected information that its privacy boundary does not allow to leave.",
    };
  }
  return {
    title: "Your privacy policy asks you to decide",
    message: review?.rationale || "Nothing will be shared unless you approve this exact answer.",
  };
}

export function reviewFindings(review) {
  return AUTOMATIC_CHECK_FALLBACKS.has(review?.fallbackCause) ? [] : review?.findings ?? [];
}

export function PrivacyFindingChips({ findings, limit = 4 }) {
  const labels = [...new Set(findings.map(privacyFindingLabel))].slice(0, limit);
  if (labels.length === 0) return null;
  return html`<div class="privacy-finding-labels" aria-label="Information the check found">
    ${labels.map((label) => html`<span key=${label}>${label}</span>`)}
  </div>`;
}

function isHardStop(record) {
  return record?.review?.fallbackCause === "hard_stop";
}

function isPostApprovalHardStop(record) {
  if (!isHardStop(record)) return false;
  if (record?.userDecision === "approved_but_blocked") return true;
  if (record?.approval?.status === "approved" || record?.approval?.status === "denied") return true;
  // Approval detail records expose their own approval status rather than a
  // nested approval object. A hard stop on one of these records can only have
  // happened after the held candidate was submitted for one-time release.
  return typeof record?.id === "string"
    && (record.status === "approved" || record.status === "denied");
}

/**
 * Failure copy is deliberately supplied by the gateway's privacy presentation,
 * rather than derived from an audit payload here. Audit payloads can contain
 * private request context; this field is the reviewed, safe explanation an
 * operator needs to understand why nothing left Omnesis.
 */
export function privacyFailureMessage(value) {
  const candidates = [
    value?.failureMessage,
    value?.failure?.message,
    value?.display?.failureMessage,
    value?.display?.failure?.message,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim()
    ?? null;
}

/**
 * The machine code and the provider's own disposition metadata behind a
 * failure, for the diagnostic chip. Both are gateway-vetted: the code is an
 * Omnesis constant, and the detail carries only an HTTP status and envelope
 * codes, never provider prose.
 */
export function privacyFailureDiagnostics(value) {
  const failure = value?.failure ?? value?.display?.failure ?? null;
  const code = typeof failure?.code === "string" && failure.code.trim() ? failure.code.trim() : null;
  const detail =
    typeof failure?.detail === "string" && failure.detail.trim() ? failure.detail.trim() : null;
  return code || detail ? { code, detail } : null;
}

export function privacyDisplayedAnswer(exchange) {
  const answer = exchange?.draftAnswer ?? exchange?.pendingCandidate ?? exchange?.sharedAnswer;
  return typeof answer === "string" && answer.trim() ? answer : null;
}

export function privacyAnswerGenerationFailed(exchange) {
  if (exchange?.outcome !== "failed") return false;
  if (exchange?.failure?.stage) return exchange.failure.stage === "answer_generation";
  return !privacyDisplayedAnswer(exchange) && !privacyTechnicalReviewFailed(exchange);
}

export function privacyReviewFailed(exchange) {
  if (exchange?.outcome === "failed" && exchange?.failure?.stage) {
    return exchange.failure.stage === "privacy_check";
  }
  return privacyTechnicalReviewFailed(exchange)
    || (exchange?.outcome === "failed" && Boolean(privacyDisplayedAnswer(exchange)));
}

function privacyTechnicalReviewFailed(exchange) {
  return PRIVACY_REVIEW_FAILURES.has(exchange?.review?.fallbackCause);
}

/**
 * The decision, phrased as a full sentence for the spine's third card.
 *
 * Every branch below is reached by recognising a decision or an outcome. There
 * is deliberately no reassuring default: an outcome this portal cannot read
 * says so, because "Nothing was shared." asserted about a state we did not
 * understand is the one wrong answer this sentence can give.
 */
export function exchangeDecisionCopy(exchange) {
  const recipient = externalAgentReference(exchange);
  if (isHardStop(exchange)) {
    return isPostApprovalHardStop(exchange)
      ? "You approved this once, but Omnesis blocked it. Nothing was shared."
      : "Omnesis blocked this answer automatically. Nothing was shared.";
  }
  if (exchange?.userDecision === "approved_but_blocked") {
    return "You approved this once, but Omnesis blocked it. Nothing was shared.";
  }
  if (exchange?.userDecision === "approved") {
    return exchange.outcome === "ready"
      ? `You approved this once. ${recipient === "the external agent" ? "The external agent" : recipient} has not received it yet.`
      : `You shared this once, and ${recipient} received it.`;
  }
  if (exchange?.userDecision === "denied") return "You chose not to share. Nothing was shared.";
  if (exchange?.userDecision === "expired") return "The review expired. Nothing was shared.";
  if (exchange?.outcome === "shared") {
    return `Your policy allowed this answer, and ${recipient} received it.`;
  }
  if (exchange?.outcome === "shared_with_reductions") {
    return `Omnesis removed details from this answer, then ${recipient} received the rest.`;
  }
  if (exchange?.outcome === "ready") {
    return `Omnesis approved this answer, but ${recipient} has not received it yet.`;
  }
  if (exchange?.outcome === "needs_review") {
    return "Omnesis is holding this answer until you decide. Nothing has been shared.";
  }
  if (exchange?.outcome === "checking") {
    return "Omnesis is still checking this answer. Nothing has been shared.";
  }
  if (exchange?.denialReason === "approval_not_available") {
    return "The privacy check recommended approval, but this request has no approval flow."
      + " Omnesis did not share the answer.";
  }
  if (exchange?.outcome === "failed"
    && AUTOMATIC_CHECK_FALLBACKS.has(exchange?.review?.fallbackCause)) {
    return "Omnesis could not verify this automatically. Nothing was shared.";
  }
  if (exchange?.outcome === "failed") {
    return privacyAnswerGenerationFailed(exchange)
      ? "The privacy check did not run because Omnesis produced no answer. Nothing was shared."
      : "The privacy check failed. Nothing was shared.";
  }
  if (exchange?.outcome === "canceled") return "The request was canceled. Nothing was shared.";
  if (exchange?.outcome === "not_shared") return "Nothing was shared.";
  return "Omnesis reported an outcome this page cannot read, so it cannot say whether"
    + " anything was shared. Every step it did record is on this page.";
}

export function PrivacyAnswerContent({ answer, className }) {
  return html`<div
    class=${`${className} doc-content`}
    dangerouslySetInnerHTML=${{ __html: renderMarkdown(answer || "") }}
  ></div>`;
}

/* ── Page chrome ──────────────────────────────────────────────────────────── */

const REVIEWER_HEALTH_COPY =
  "Some recent automatic privacy checks could not complete. Any affected answer stays inside Omnesis and requires your review.";

export function PrivacyHealthBanner({ health }) {
  if (health?.status !== "attention") return null;
  return html`<div class="privacy-banner warning privacy-health-banner" role="status">
    ${REVIEWER_HEALTH_COPY}
  </div>`;
}

export function PrivacyActivityLoadFailure({ error, onRetry }) {
  return html`<${LoadMore}
    hasMore=${true}
    error=${error}
    onLoadMore=${onRetry}
    label="Retry loading activity"
  />`;
}

export function privacyResolutionCopy(response, identity = null) {
  if (response?.status === "released" || response?.status === "released_with_reductions") {
    const recipient = externalAgentReference(identity);
    return {
      title: "Answer approved",
      message: `The answer is ready for ${recipient} when it returns.`,
    };
  }
  if (response?.status === "denied" && response.reason === "hard_stop") {
    return {
      title: "Answer blocked",
      message: "You approved this answer once, but Omnesis blocked it before anything was shared.",
    };
  }
  if (response?.status === "denied" && response.reason === "expired") {
    return { title: "Approval expired", message: "Nothing was shared." };
  }
  return { title: "Answer not shared", message: "Nothing was shared." };
}

/** The exchange-scoped detail path a feed row opens. */
export function exchangeDetailPath(conversationId, taskId) {
  return `/portal/audit/conversations/${encodeURIComponent(conversationId)}`
    + `/exchanges/${encodeURIComponent(taskId)}`;
}

/**
 * The policy family a review record names, or null when it names none — a
 * record written before families were recorded carries only a content hash,
 * and nothing here guesses which family that hash belonged to.
 */
export function reviewedPolicyFamily(review) {
  const id = review?.policyFamilyId;
  const name = review?.policyFamilyName;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return { id, name };
}

/**
 * Which policy a review ran under, where the record says.
 *
 * The name is a link to the policy's own page, except where this line sits
 * inside an element that is itself a link — an anchor cannot contain another —
 * so a feed row names the policy in plain text and the pages it opens carry
 * the link.
 */
export function PrivacyReviewedUnder({ review, link = true }) {
  const family = reviewedPolicyFamily(review);
  if (!family) return null;
  const href = policyEditorPath(family.id);
  return html`<span class="privacy-reviewed-under">
    Reviewed under${" "}
    ${link
      ? html`<a
          href=${href}
          onClick=${(event) => { event.preventDefault(); navigate(href); }}
        >${family.name}</a>`
      : html`<span class="privacy-reviewed-under-name">${family.name}</span>`}
  </span>`;
}
