// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch is, said in the operator's words: the wire-shape validators that
 * decide whether a payload may be shown at all, and the labels every Watches
 * surface reads from.
 */

import { formatPrivacyRelativeDate } from "../shared/privacy-vocabulary.js";
import { watchWakeBindings } from "../../lib/watch-dsl.js";

export function subscriptionApprovalDocument(payload) {
  const approval = typeof payload?.id === "string" ? payload : payload?.approval;
  const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  if (
    !approval
    || !nonEmpty(approval.id)
    || !nonEmpty(approval.subscriptionId)
    || !nonEmpty(approval.workflowHandle)
    || !nonEmpty(approval.workflowId)
    || !nonEmpty(approval.integrationDeviceId)
    || !["pending", "approved", "denied", "expired"].includes(approval.status)
    || !Number.isInteger(approval.revision)
    || approval.revision < 1
    || !nonEmpty(approval.revisionId)
    || !finite(approval.createdAt)
    || approval.createdAt <= 0
    || !finite(approval.expiresAt)
    || approval.expiresAt <= 0
    || !nonEmpty(approval.condition?.description)
    || approval.condition?.kind !== "natural-language"
    || !["agent-workflow", "ios-push"].includes(approval.reaction?.kind)
    || (approval.reaction?.kind === "agent-workflow" && !nonEmpty(approval.reaction?.instruction))
    || !nonEmpty(approval.interpretedCondition?.summary)
    || approval.interpretedCondition?.pushDetail !== "existence"
    || !nonEmpty(approval.interpretation?.summary)
    || approval.interpretation?.pushDetail !== "existence"
    || approval.interpretation.summary !== approval.interpretedCondition.summary
    || !nonEmpty(approval.integration?.displayName)
    || approval.integration?.source !== "token"
    || !nonEmpty(approval.integrationDevice?.id)
    || approval.integrationDevice.id !== approval.integrationDeviceId
    || !nonEmpty(approval.integrationDevice?.name)
    // Any paired device holding the manage scope can author a watch — a CLI, a
    // phone, an off-host agent — and the gateway reports that device's own kind
    // here as display metadata. Requiring one particular kind would discard the
    // whole approval, measurement included, for every watch the operator
    // authored themselves.
    || !nonEmpty(approval.integrationDevice?.kind)
    || !nonEmpty(approval.workflow?.id)
    || approval.workflow.id !== approval.workflowId
    || !nonEmpty(approval.workflow?.name)
    || !nonEmpty(approval.workflow?.purpose)
    || !Array.isArray(approval.categories)
    || approval.categories.length === 0
    || !approval.categories.every(nonEmpty)
    || !nonEmpty(approval.policyRevision)
  ) return null;
  return approval;
}

export function privacySubscriptionDocument(payload) {
  if (typeof payload?.id === "string") return payload;
  return payload?.subscription && typeof payload.subscription.id === "string"
    ? payload.subscription
    : null;
}

export function privacySubscriptionFiringDocument(payload) {
  if (typeof payload?.id === "string") return payload;
  return payload?.firing && typeof payload.firing.id === "string" ? payload.firing : null;
}

/**
 * What a firing does, phrased for the reaction's kind: the exact
 * subscriber-authored workflow instruction, or the iOS push an operator
 * watch delivers to the operator's own devices.
 */
export function subscriptionReactionText(reaction) {
  if (reaction?.kind === "ios-push") {
    const parts = [reaction.title, reaction.body].filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    return parts.length > 0
      ? `Push a notification to your devices: ${parts.join(" — ")}`
      : "Push a notification to your devices.";
  }
  return reaction?.instruction || "No reaction instruction was supplied.";
}

export function subscriptionIntegrationName(value) {
  return value?.integration?.displayName
    || value?.integrationDevice?.name
    || value?.workflow?.name
    || value?.workflowHandle
    || value?.workflowId
    || "External integration";
}

export function subscriptionSummary(value) {
  return value?.interpretedCondition?.summary
    || value?.interpretation?.summary
    || "A new or changed document matches the approved condition";
}

/**
 * The compile-time measurement of a watch, or null when the gateway did not
 * measure one. A malformed block reads as absent: the card must never invent a
 * count, because "0 matching rows" is exactly the fact an operator would act on.
 */
export function subscriptionGrounding(value) {
  const grounding = value?.grounding;
  const count = (input) => Number.isInteger(input) && input >= 0;
  if (
    !grounding
    || typeof grounding.matchesNow !== "boolean"
    || !count(grounding.matchCount)
    || !(grounding.recentMatchCount === null || count(grounding.recentMatchCount))
    || !(grounding.latestMatchAt === null || Number.isFinite(grounding.latestMatchAt))
    || !["empty", "dormant", "active"].includes(grounding.liveness)
    || !(Number.isFinite(grounding.horizonMs) && grounding.horizonMs > 0)
  ) return null;
  return grounding;
}

export function subscriptionGroundingCopy(grounding, now = Date.now()) {
  const horizonDays = Math.round(grounding.horizonMs / 86_400_000);
  const parts = [grounding.matchesNow ? "Matches right now" : "Does not match right now"];
  if (grounding.matchCount === 0) parts.push("no matching data yet");
  else if (grounding.recentMatchCount !== null) {
    parts.push(`${grounding.recentMatchCount} matching rows in the last ${horizonDays} days`);
  } else parts.push(`${grounding.matchCount} matching rows`);
  if (grounding.latestMatchAt !== null) {
    parts.push(`latest matching data ${formatPrivacyRelativeDate(grounding.latestMatchAt, now)}`);
  }
  return parts.join(" · ");
}

export function subscriptionGroundingIsQuiet(grounding) {
  return grounding.matchCount === 0
    || grounding.recentMatchCount === 0
    || grounding.liveness !== "active";
}

/**
 * A denied watch is revocable too: denial leaves the watch open to revision by
 * the integration, so revoking it is the operator's path to making it
 * purgeable.
 */
export function canRevokePrivacySubscription(status) {
  return (
    status === "pending_approval" ||
    status === "active" ||
    status === "paused" ||
    status === "denied"
  );
}

/**
 * Hard delete is offered only once a watch is terminal: revocation or expiry
 * is what makes a watch deletable, so the two affordances never coexist.
 */
export function canPurgePrivacySubscription(status) {
  return status === "revoked" || status === "expired";
}

export function firingDeliveryStatusLabel(status) {
  const labels = {
    pending: "Queued",
    delivered: "Delivered",
    blocked: "Blocked",
    failed: "Failed",
  };
  return labels[status] ?? "Unknown";
}

export function subscriptionFiringHref(subscriptionId, firingId) {
  return `/portal/watches/${encodeURIComponent(subscriptionId)}`
    + `/firings/${encodeURIComponent(firingId)}`;
}

// --- Watches installed in the runtime ---
//
// A watch compiled from a request — asked for in conversation, or added from
// the CLI — and evaluated by the Watch V2 runtime. It has no approval record
// and no subscriber: it watches on the operator's own behalf, so the vocabulary
// below is about what it was asked to catch and what it does when it does.

/** What the runtime does with a watch. */
const INSTALLED_WATCH_STATUS_LABELS = {
  active: "Active",
  paused: "Paused",
  /** `once_ever` got its answer, or the watch's horizon passed. */
  retired: "Finished",
};

export function installedWatchStatusLabel(status) {
  return INSTALLED_WATCH_STATUS_LABELS[status] ?? "Unknown";
}

/**
 * One installed watch, bare or inside a `{ watch }` envelope.
 *
 * The three fields checked are the three the surface cannot do without: the id
 * addresses the detail route and the removal, the name is the handle every
 * other surface prints, and a status outside the runtime's own vocabulary means
 * this build is reading a record it does not understand.
 */
export function installedWatchDocument(payload) {
  const watch = typeof payload?.id === "string" ? payload : payload?.watch;
  if (typeof watch?.id !== "string" || watch.id.length === 0) return null;
  if (typeof watch.name !== "string" || watch.name.length === 0) return null;
  if (!Object.hasOwn(INSTALLED_WATCH_STATUS_LABELS, watch.status)) return null;
  return watch;
}

/**
 * The disclosure a watch carries, or null when it wakes nobody.
 *
 * Present on both reads of a watch — the listing carries a summary, the detail
 * carries all of it — so a caller never has to know which read produced the
 * record. A watch without one told nobody anything, which is most of them.
 *
 * The subscription's identity is what makes a disclosure usable — it is how the
 * egress ledger is read and how a firing's audit record is addressed — so a
 * record carrying a blank one is treated as no record rather than as a section
 * whose every link goes nowhere.
 */
export function watchDisclosure(watch) {
  const disclosure = watch?.disclosure;
  const id = disclosure?.subscriptionId;
  return typeof id === "string" && id.trim().length > 0 ? disclosure : null;
}

/**
 * Who asked for this watch, in one phrase.
 *
 * A watch with no disclosure was the operator's: there was no egress to
 * approve, so no record of a request exists and there is nothing else it could
 * have been. Read from the record rather than guessed from the delivery block —
 * an operator can perfectly well write a watch that wakes an agent, and calling
 * that one "asked for by the integration" would misattribute their own request.
 */
export function watchAskedBy(watch) {
  const disclosure = watchDisclosure(watch);
  if (!disclosure || disclosure.authoredBy !== "integration") return "You asked for this";
  return `${disclosure.integrationName ?? "An integration"} asked for this`;
}

/**
 * Where a watch's firings go, as one word for a row.
 *
 * The listing carries the resolved kind; the detail carries the whole delivery
 * block and the kind is inside it. `null` means the watch delivers nowhere,
 * which is a real setting rather than a missing value — see
 * {@link installedWatchDelivery} for the sentence a detail page shows.
 */
export function watchDeliveryKind(watch) {
  const stated = watch?.delivery;
  if (typeof stated === "string" && stated.length > 0) return stated;
  const compiled = watch?.dsl?.watch?.delivery?.kind;
  if (typeof compiled !== "string" || compiled.length === 0) return null;
  // The stored DSL is served verbatim, so a watch written before the rename
  // still says `ios-push`; both spellings are the same channel.
  return compiled === "ios-push" ? "omnesis-notify" : compiled;
}

/** The delivery kind as a person reads it, or null when nothing is delivered. */
export function watchDeliveryLabel(watch) {
  const kind = watchDeliveryKind(watch);
  if (kind === "omnesis-notify") return "Notifies you";
  if (kind === "agent-wake") {
    const disclosure = watchDisclosure(watch);
    const agent =
      disclosure?.integrationName
      ?? (typeof watch?.dsl?.watch?.delivery?.integration === "string"
        ? watch.dsl.watch.delivery.integration
        : null);
    return agent ? `Wakes ${agent}` : "Wakes an agent";
  }
  return kind === null ? "Records only" : kind;
}

/**
 * The request a watch was compiled from, in the words it was asked in.
 *
 * The listing carries it as `request` and omits the definition; the detail
 * carries the definition and the request is inside it. Both spellings resolve
 * here so a caller never has to know which read produced the record.
 */
export function installedWatchRequest(watch) {
  const stated = watch?.request;
  if (typeof stated === "string" && stated.trim().length > 0) return stated;
  const compiled = watch?.dsl?.watch?.nl_query;
  return typeof compiled === "string" && compiled.trim().length > 0 ? compiled : null;
}

/**
 * The line that names a watch to a person.
 *
 * The request when there is one, because that is what the operator said; the
 * name otherwise, which is what a hand-written DSL carries instead.
 */
export function installedWatchSummary(watch) {
  return installedWatchRequest(watch) ?? watch?.name ?? "A watch";
}

/**
 * Where a watch's firings go, and whether they go anywhere at all.
 *
 * A watch with no delivery block records and interrupts nobody — which from
 * the outside is indistinguishable from one that pushes and has not fired yet.
 * `delivers` exists so the surface can state the difference rather than leave
 * an operator to infer it from silence.
 *
 * `bindings` are the referents a wake hands over with its instruction, as
 * `[name, referent]` pairs and empty for every other kind. They are what makes
 * "reply in the conversation this came from" mean something at the other end,
 * so an operator reading what a watch discloses has to be able to see them.
 */
export function installedWatchDelivery(watch) {
  const delivery = watch?.dsl?.watch?.delivery;
  // Both spellings of the notify kind. The stored DSL is served verbatim, so
  // a watch written before the rename still says `ios-push` on the wire — and
  // an unrecognised kind falls through to "Delivers nowhere", which would be a
  // confident false statement about a watch that notifies on every firing.
  if (delivery?.kind === "omnesis-notify" || delivery?.kind === "ios-push") {
    const words = [delivery.title, delivery.body].filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    return {
      delivers: true,
      text: words.length > 0
        ? `Notifies your devices: ${words.join(" — ")}`
        : "Notifies your devices.",
      bindings: [],
    };
  }
  if (delivery?.kind === "agent-wake") {
    const agent = typeof delivery.integration === "string" && delivery.integration.length > 0
      ? delivery.integration
      : "an agent";
    const instruction = typeof delivery.instruction === "string"
      && delivery.instruction.trim().length > 0
      ? delivery.instruction
      : "No instruction was recorded.";
    return {
      delivers: true,
      text: `Wakes ${agent}: ${instruction}`,
      // Beside the sentence rather than inside it. An instruction is prose an
      // operator reads; a referent is a value they compare against the thing it
      // points at, and folding one into the other loses that.
      bindings: watchWakeBindings(delivery),
    };
  }
  return {
    delivers: false,
    text: "Delivers nowhere. Every firing is recorded here and nobody is told.",
    bindings: [],
  };
}

/**
 * Whether a watch is holding anything, and what would move it next.
 *
 * The question a list answers that a detail page cannot: which of these is
 * awake. Three readings, because they are genuinely different states and only
 * one of them is visible from the others.
 *
 * `keys` rather than cells, because a key is one thing the watch is tracking
 * and a node holding three instances of one key is still tracking one thing.
 * Keys that are *holding* rather than every key with a cell, because the mark
 * this feeds claims the watch is tracking something and a cell kept as
 * bookkeeping — a spent cooldown stamp, a drained window — is tracking nothing.
 *
 * `behind` is the state that misleads. A watch that has not caught up to the
 * journal holds nothing *yet*, and on every other field it is indistinguishable
 * from one with nothing to hold — so it gets its own reading rather than being
 * folded into idle.
 *
 * Nothing here is a health judgement. A watch holding nothing is the ordinary
 * resting state of a watch waiting for something to arrive, and a reader must
 * not be led to read an empty one as broken.
 */
export function installedWatchLiveness(watch, journalHead = null) {
  const live = watch?.live;
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  const cursor = Number.isInteger(live?.cursorSeq) ? live.cursorSeq : null;
  const head = Number.isInteger(journalHead) ? journalHead : null;
  // Only an active watch is evaluated at all: the runtime iterates the active
  // definitions, so a paused or finished one is not lagging, not about to fire,
  // and not going to catch up. Its cursor simply stopped where it stopped, and
  // the gap to the head grows forever with corpus traffic that has nothing to
  // do with it.
  const running = watch?.status === "active";
  const timers = count(live?.timers);
  // What the watch is waiting on, as against every cell it keeps. A cell
  // outlives what it was holding — a cooldown stamp after its interval, a
  // persistence window after it drains — and the gateway is where each node
  // type says which of its own still count. A gateway too old to send that
  // count leaves the population as the fallback, which over-reports rather
  // than hiding a watch that is genuinely tracking something.
  const keys = count(live?.holdingKeys ?? live?.keys);
  return {
    keys,
    /** Every cell the runtime keeps, holding or not. */
    cells: count(live?.cells),
    /** Of those, the ones still holding something — never more than `cells`. */
    holdingCells: Math.min(count(live?.cells), count(live?.holdingCells ?? live?.cells)),
    timers,
    /**
     * Whether the runtime is holding anything at all for this watch.
     *
     * An armed timer counts. A watch driven by a clock holds no cell and is the
     * one kind that acts with no input whatsoever — reading it as empty puts
     * the only self-starting watch in the same bucket as the resting ones.
     */
    holding: keys > 0 || timers > 0,
    /** The soonest deadline as epoch milliseconds, or null when none is armed. */
    nextDueAt: running ? watchInstant(live?.nextDueAt) : null,
    // Only ever a positive number of events. The cursor and the head live in
    // different tables, and a cursor reading past the head is a momentary
    // artefact of that rather than a watch that has run into the future.
    behind: !running || cursor === null || head === null ? 0 : Math.max(0, head - cursor),
  };
}

/**
 * An ISO instant as epoch milliseconds, or null when it is unreadable.
 *
 * The runtime stamps its records in ISO because it runs on journal time and a
 * replay has to reach the same answers; every date helper on this page takes
 * epoch milliseconds and reads null as "Unknown".
 */
export function watchInstant(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether two of those instants name the same second.
 *
 * A firing carries the subject's time and the moment the journal noticed it.
 * They are the same instant for most watches, so printing both on every row
 * would be noise; they diverge only for a watch about something that already
 * had a date of its own — a calendar entry created in June and moved today.
 */
export function watchInstantsAgree(left, right) {
  const a = watchInstant(left);
  const b = watchInstant(right);
  if (a === null || b === null) return left === right;
  return Math.floor(a / 1000) === Math.floor(b / 1000);
}

/**
 * What a row's verdict marker should say, or null when it should not be shown.
 *
 * Whether there is anything to do about a verdict is the gateway's to say, and
 * it says so on the wire. A table kept here would be a table of the names this
 * build was written against — so a verdict a newer gateway learned to raise
 * would render as no mark at all, on the one surface whose whole job is to
 * raise it. Not every verdict is marked: `healthy`, `resting` and `stopped`
 * are the ordinary states of a watch that is fine or has stopped on purpose,
 * and a badge on every row makes the badge mean nothing.
 *
 * The list is deliberately not reordered by this: sorting by verdict makes the
 * top of the page mean "worst", and a watch with nothing to say would arrive
 * there through no fault of its own.
 */
export function watchVerdictMark(watch) {
  const verdict = watch?.verdict;
  if (!verdict || verdict.actionable !== true) return null;
  return {
    name: verdict.name,
    label: watchVerdictLabel(verdict),
    // The numbers travel with the mark rather than being recomposed here: one
    // sentence, written once, so the phone and the page cannot come to say
    // different things about one watch.
    because: typeof verdict.because === "string" ? verdict.because : "",
  };
}

/**
 * The word for a verdict.
 *
 * The gateway's, falling back to the bare name — which is a word an operator
 * can still act on, where an empty label is not.
 */
function watchVerdictLabel(verdict) {
  return typeof verdict?.label === "string" && verdict.label.length > 0
    ? verdict.label
    : (verdict?.name ?? "");
}

/** The verdict as a full sentence, for a surface with room for one. */
export function watchVerdictSentence(watch) {
  const verdict = watch?.verdict;
  if (!verdict) return null;
  const label = watchVerdictLabel(verdict);
  return verdict.because ? `${label} — ${verdict.because}` : label;
}
