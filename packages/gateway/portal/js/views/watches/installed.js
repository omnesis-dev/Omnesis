// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch installed in the runtime: the grouped list on the dashboard, one
 * watch's detail with its firings, and the one way it ends — removal.
 *
 * These watches are compiled from a request the operator made — in conversation
 * with their own agent, or from the CLI — and evaluated directly by Omnesis.
 * Nothing about one crosses an egress boundary, so there is no approval to
 * grant and no subscriber to revoke: the screen says what the watch was asked
 * to catch, what it does when it catches it, and what it has caught.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  deleteWatchV2Watch,
  getWatchV2Watch,
  listPrivacySubscriptionFirings,
  listWatchV2Firings,
} from "../../api.js";
import { purgePrivacySubscription, revokePrivacySubscriptionRequest } from "./revoke.js";
import { CopyIconButton } from "../../components/copy-button.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { DocChip } from "../../components/doc-chip.js";
import { Loading } from "../../components/loading.js";
import { navigate } from "../../lib/router.js";
import { watchDebugHref } from "../../lib/watch-trace.js";
import {
  errorMessage,
  formatPrivacyDate,
  formatPrivacyRelativeDate,
  privacyCollection,
  shortId,
} from "../shared/privacy-vocabulary.js";
import {
  canPurgePrivacySubscription,
  canRevokePrivacySubscription,
  firingDeliveryStatusLabel,
  installedWatchDelivery,
  installedWatchRequest,
  installedWatchStatusLabel,
  installedWatchSummary,
  subscriptionFiringHref,
  watchAskedBy,
  watchDeliveryLabel,
  watchDisclosure,
  watchInstant,
  watchInstantsAgree,
  watchVerdictMark,
} from "./vocabulary.js";

/**
 * A watch id is an opaque string from a store that never promised it would be
 * path-safe, so it is encoded rather than interpolated.
 */
function installedWatchHref(watchId) {
  return `/portal/watches/${encodeURIComponent(watchId)}`;
}

/**
 * Running first, finished last.
 *
 * Which of these is still doing something is the question a reader brings to
 * the list, and each row states its own status — so order is enough to answer
 * it, and no heading has to.
 *
 * Stable within a rank, so the runtime's own order — newest first — survives
 * inside each band, and a status this build has not heard of sorts with the
 * finished rather than vanishing.
 */
const WATCH_STATUS_RANK = { active: 0, paused: 1, retired: 2 };

export function orderedInstalledWatches(watches) {
  return [...watches]
    .map((watch, index) => ({ watch, index }))
    .sort((left, right) => {
      const rank = (entry) => WATCH_STATUS_RANK[entry.watch.status] ?? WATCH_STATUS_RANK.retired;
      return rank(left) - rank(right) || left.index - right.index;
    })
    .map((entry) => entry.watch);
}

export function InstalledWatchList({ watches }) {
  if (watches.length === 0) {
    return html`<div class="privacy-empty-state">
      <strong>No watches yet</strong>
      <span>Ask your agent to keep an eye on something and the watch it writes appears here.</span>
    </div>`;
  }
  return html`<ul class="privacy-conversation-list privacy-subscription-list">
    ${orderedInstalledWatches(watches).map((watch) => {
      const href = installedWatchHref(watch.id);
      const firings = Number.isFinite(watch.firings) ? watch.firings : 0;
      const verdictMark = watchVerdictMark(watch);
      return html`<li key=${watch.id}>
        <a
          class="privacy-conversation-row"
          href=${href}
          onClick=${(event) => {
            event.preventDefault();
            navigate(href);
          }}
        >
          <span class="privacy-conversation-main">
            <strong>${installedWatchSummary(watch)}</strong>
            <span>${watch.name} · ${firings} firing${firings === 1 ? "" : "s"}</span>
            <span class="watch-row-indicators">
              <span class="watch-indicator">${watchAskedBy(watch)}</span>
              <span class="watch-indicator">${watchDeliveryLabel(watch)}</span>
              ${verdictMark
                ? // Only a verdict there is something to do about, and
                  // coloured, because the point of it is to be seen among rows
                  // that are fine. The uncoloured indicators beside it are
                  // facts about the watch; this is the one that asks for
                  // something.
                  html`<span class="watch-indicator is-verdict">${verdictMark.label}</span>`
                : null}
            </span>
            ${verdictMark
              ? // The numbers, on the row rather than in a tooltip. The label
                // alone is an adjective, and an operator cannot act on an
                // adjective — nor hover one on a phone.
                html`<span class="watch-verdict-because">${verdictMark.because}</span>`
              : null}
          </span>
          <span class="privacy-conversation-meta">
            Added ${formatPrivacyRelativeDate(watchInstant(watch.addedAt))}
          </span>
          <span class=${`privacy-item-status ${watch.status === "active" ? "success" : "muted"}`}>
            ${installedWatchStatusLabel(watch.status)}
          </span>
        </a>
      </li>`;
    })}
  </ul>`;
}

/**
 * The documents the runtime read to decide this firing, each a link to it.
 *
 * Absent rather than empty for a firing with nothing behind it — a clock
 * reaching a boundary, a row arriving — where a "no documents" line would
 * read as something missing rather than as the watch working as asked. Also
 * absent for a firing recorded before the journal kept them, which is the same
 * absence to a reader: neither can be shown anything.
 */
function firingEvidence(firing) {
  const documents = Array.isArray(firing.documents) ? firing.documents : [];
  if (documents.length === 0) return null;
  return html`<div class="watch-firing-evidence is-flat">
    ${documents.map(
      (document) =>
        html`<${DocChip}
          key=${document.id}
          documentId=${document.id}
          title=${document.title}
          sourceId=${document.sourceId}
        />`,
    )}
  </div>`;
}

/**
 * What delivering a firing did, when it was meant to go anywhere.
 *
 * Absent for a watch that delivers nowhere, which is most of them — a firing
 * with no delivery block was never sent, and saying so would read as a failure
 * rather than as the watch doing what was asked. When there is an outcome, the
 * failing case is the one worth the ink: a notification that never arrived
 * looks exactly like a watch that never fired, and this is the only place that
 * difference is written down.
 */
function firingDeliveryLabel(firing) {
  const delivery = firing.delivery;
  if (!delivery) return null;
  if (delivery.delivered > 0) {
    const where = delivery.kind === "agent-wake" ? "Woke an agent" : "Notified you";
    return html`<span class="privacy-item-status success">${where}</span>`;
  }
  return html`<span class="privacy-item-status error" title=${delivery.error ?? ""}>
    ${delivery.error ? `Not delivered: ${delivery.error}` : "Not delivered"}
  </span>`;
}

/**
 * The glyph that opens a firing's path across the watch's graph — Lucide's
 * "search", inlined as the rest of the portal inlines its icons. It strokes in
 * `currentColor`, so the link and its dimmed absent form colour it alike.
 */
const SEARCH_SVG = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <circle cx="11" cy="11" r="8" />
  <path d="m21 21-4.3-4.3" />
</svg>`;

/**
 * One of a firing row's two records, whether or not this install holds it.
 *
 * A firing is assembled from two ledgers and a row can hold either half alone,
 * so every row of a watch carries the same pair of words: the one whose record
 * exists opens it, and the one whose record is missing stays as dim text saying
 * so. The shape of the list is then a property of the page, not of which
 * records happen to exist — and a reader who came looking for one of them
 * learns that it is not there rather than that the page has an unstated rule.
 *
 * A null `href` is what "this install does not hold it" means, so the caller
 * passes the address it has and the word decides its own form.
 */
function FiringRecordLink({ label, href, presentTitle, absentTitle }) {
  if (href === null) {
    return html`<span class="watch-link watch-firing-record watch-link--absent" title=${absentTitle}>
      ${label}<span class="sr-only"> — ${absentTitle}</span>
    </span>`;
  }
  return html`<a
    class="watch-link watch-firing-record"
    href=${href}
    title=${presentTitle}
    onClick=${(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigate(href);
    }}
  >${label}</a>`;
}

/**
 * The referents a wake hands over with its instruction.
 *
 * Printed as name and value rather than folded into the sentence above: the
 * instruction is prose an operator reads, and a referent is a value they check
 * against the thing it points at. Nothing when there are none, which is most
 * watches — an empty list would read as a wake that lost them.
 */
function WatchWakeBindings({ bindings }) {
  if (!bindings || bindings.length === 0) return null;
  return html`<div>
    <p class="privacy-subscription-note">
      Handed to the agent with the instruction — what its words point at:
    </p>
    <dl class="watch-pane-rows is-mono">
      ${bindings.map(
        ([name, referent]) => html`<div key=${name}>
          <dt>${name}</dt>
          <dd>${referent}</dd>
        </div>`,
      )}
    </dl>
  </div>`;
}

/**
 * What this watch is allowed to say, and to whom.
 *
 * A watch that wakes an agent crosses an egress boundary, and this is the one
 * sentence that says where its firings land. The record behind it carries a
 * good deal more — its identifier, which revision of it stands, which revision
 * of the policy judged it — and none of that is on the screen: an operator
 * reading this page is asking what the watch does, and an identifier they can
 * read off the address bar is not an answer to that.
 *
 * Absent entirely for a watch that wakes nobody. There was no egress, so there
 * is nothing to disclose — an empty section would report that as something
 * missing.
 */
function WatchDisclosureSection({ disclosure, bindings = [], onRevoke = null, onPurge = null }) {
  if (!disclosure) return null;
  return html`<section class="privacy-section watch-disclosure">
    <header class="privacy-section-head"><h2>What it tells an integration</h2></header>
    <p class="privacy-subscription-exact">
      Wakes ${disclosure.integrationName ?? "an integration"}: ${disclosure.instruction
        || "No instruction was recorded."}
    </p>
    <${WatchWakeBindings} bindings=${bindings} />
    <p class="privacy-subscription-note">
      The wake itself carries no corpus content — only what is shown above. What the firing
      recorded reaches the agent only as an answer that passed the privacy boundary.
    </p>
    ${onRevoke && canRevokePrivacySubscription(disclosure.status)
      ? html`<div class="privacy-delete-row">
          <button type="button" class="privacy-deny-button" onClick=${onRevoke}>
            Revoke this watch's access
          </button>
        </div>`
      : null}
    ${onPurge && canPurgePrivacySubscription(disclosure.status)
      ? html`<div class="privacy-delete-row">
          <button type="button" class="privacy-deny-button" onClick=${onPurge}>
            Delete this record permanently
          </button>
        </div>`
      : null}
  </section>`;
}

/**
 * One list of firings, from the two records that each hold half of one.
 *
 * The runtime records what the watch *caught*; the record that authorises its
 * egress records what it actually *sent*. Those are the same events seen from
 * two sides, so one firing earns one row, carrying whichever halves exist.
 *
 * The join is `seq`, the journal event a firing happened on. A sequence names a
 * *set* of firings rather than one — a broadcast arm re-judges every live cell
 * on the same tick — and what tells those apart in the runtime, the node and
 * key that fired, is not on this wire. So a sequence is read as a queue: each
 * caught firing takes the next sent record still unclaimed at that sequence,
 * and no record is handed to two rows.
 *
 * A sent firing nothing claims still gets a row of its own rather than being
 * dropped: it is a record written before the runtime stamped its identity, or
 * one whose caught half is older than the page this screen holds, and losing it
 * would understate what left the machine.
 *
 * Newest first, across both halves — the question a ledger is read to answer is
 * what the watch has said lately.
 */
export function mergeWatchFirings(firings, egress = []) {
  const bySeq = new Map();
  for (const firing of egress) {
    if (!Number.isFinite(firing.seq)) continue;
    const queue = bySeq.get(firing.seq);
    if (queue) queue.push(firing);
    else bySeq.set(firing.seq, [firing]);
  }
  const claimed = new Set();
  const occurrences = new Map();
  const rows = firings.map((firing) => {
    const match = (Number.isFinite(firing.seq) ? bySeq.get(firing.seq)?.shift() : null) ?? null;
    if (match) claimed.add(match.id);
    // A sequence can hold more than one row, so the key names which of them
    // this is. Position would do it too, but position moves when a firing
    // arrives and every row below would be re-keyed.
    const occurrence = occurrences.get(firing.seq) ?? 0;
    occurrences.set(firing.seq, occurrence + 1);
    return {
      key: occurrence === 0 ? `seq:${firing.seq}` : `seq:${firing.seq}#${occurrence}`,
      firing,
      sent: match,
    };
  });
  const orphans = egress
    .filter((firing) => !claimed.has(firing.id))
    .map((firing) => ({ key: `sent:${firing.id}`, firing: null, sent: firing }));
  return [...rows, ...orphans]
    .map((row, index) => ({ row, index, at: firingRowInstant(row) }))
    .sort((left, right) => {
      if (left.at === null || right.at === null) {
        // A row with no usable instant cannot be placed among the dated ones,
        // so it keeps the order it arrived in, below them.
        if (left.at === right.at) return left.index - right.index;
        return left.at === null ? 1 : -1;
      }
      if (right.at !== left.at) return right.at - left.at;
      // Two firings on the same instant are ordered by the journal sequence,
      // which is what the runtime increments per event.
      const seq = (entry) => (Number.isFinite(entry.row.firing?.seq) ? entry.row.firing.seq : null);
      if (seq(left) !== null && seq(right) !== null && seq(left) !== seq(right)) {
        return seq(right) - seq(left);
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

/**
 * When a row happened, whichever half of it this build has, in epoch
 * milliseconds.
 *
 * A caught firing is stamped with the moment the watch spoke, as an instant in
 * text; a sent one with the moment the wake was written, as a number. Both come
 * from the same clock, so once they are the same kind of value a row with only
 * one of them still sits in its right place among the rest.
 */
function firingRowInstant(row) {
  if (row.firing) return watchInstant(row.firing.noticedAt ?? row.firing.firedAt);
  const sent = row.sent.createdAt ?? row.sent.firedAt;
  return Number.isFinite(sent) ? sent : null;
}

/**
 * One firing, however much of it this install holds.
 *
 * The first cell is when the watch spoke, because that is what a ledger is
 * read to answer. A firing is stamped with the subject's time — the date on
 * the document, the moment the meeting starts — and the two can be far apart,
 * so the second cell carries that instant whenever they disagree.
 *
 * Two trailing controls, and neither is decoration: the glyph lights this
 * moment's path across the watch's graph, which is the only way to see *why*
 * it fired, and `audit` opens the trusted record of what left the machine,
 * which is the only way to see what the integration was actually told. Both
 * are drawn on every row; the one whose record this install does not hold is
 * dimmed and says why, so a reader learns something about the firing rather
 * than wondering what the rule is. A watch that wakes nobody has no egress
 * ledger at all, and its rows carry the glyph alone rather than a word for a
 * record that cannot exist — as do the rows of a watch whose egress ledger
 * could not be read, since "this firing sent nothing" and "the ledger did not
 * answer" are different claims and only the first is one this row is entitled
 * to make.
 */
function WatchFiringRow({ watchId, row, subscriptionId, egressKnown = true }) {
  const { firing, sent } = row;
  const at = firingRowInstant(row);
  const dated = firing?.noticedAt && !watchInstantsAgree(firing.noticedAt, firing.firedAt)
    ? formatPrivacyDate(watchInstant(firing.firedAt))
    : null;
  // See #1865 — a subscription's firings carry no journal sequence, so a
  // sent-only row cannot address the canvas at all.
  const debugHref = Number.isFinite(firing?.seq)
    ? watchDebugHref(watchId, firing.seq)
    : null;
  const auditHref = sent && subscriptionId
    ? subscriptionFiringHref(subscriptionId, sent.id)
    : null;
  const evidence = firing ? firingEvidence(firing) : null;
  const none = html`<span class="watch-firing-none">—</span>`;
  return html`<tr class="privacy-subscription-firing-row">
    <td class="watch-firing-when">
      <strong>${formatPrivacyDate(at)}</strong>
      ${firing ? html`<code>seq ${firing.seq}</code>` : html`<code>${shortId(sent.id)}</code>`}
    </td>
    <td class="watch-firing-about">${dated ?? none}</td>
    <td class="watch-firing-delivery">
      ${firing?.forced
        ? html`<span
            class="privacy-item-status muted"
            title="An operator fired this watch by hand. Nothing was evaluated; only the delivery path ran."
          >By hand</span>`
        : null}
      ${firing
        ? (firingDeliveryLabel(firing) ?? (firing.forced ? null : none))
        : html`<span class="privacy-item-status muted">
            ${firingDeliveryStatusLabel(sent.deliveryStatus ?? sent.status)}
          </span>`}
    </td>
    <td class="watch-firing-docs">${evidence ?? none}</td>
    <td class="watch-firing-records">
      <${FiringRecordLink}
        label=${html`${SEARCH_SVG}<span class="sr-only">debug</span>`}
        href=${debugHref}
        presentTitle="Light the path this firing took through the watch's graph."
        absentTitle=${firing
          ? "No journal sequence on this firing, so it cannot be addressed on the graph."
          : "No runtime record of this firing — it is known only from what was sent."}
      />
      ${subscriptionId && egressKnown
        ? html`<${FiringRecordLink}
            label="audit"
            href=${auditHref}
            presentTitle="The trusted record of what this firing disclosed."
            absentTitle="No egress record for this firing — nothing is recorded as having left for it."
          />`
        : null}
    </td>
  </tr>`;
}

export function InstalledWatchDetail({
  watch,
  firings,
  firingsLoading = false,
  firingsError = null,
  error = null,
  onRemove,
  // The egress ledger of the record that authorised this watch, when it has
  // one. Read separately because it comes from a different store, then folded
  // into the one list below: a firing that was caught and a firing that was
  // sent are the same event, and the reader is owed one row for it.
  egress = [],
  egressLoading = false,
  egressError = null,
  onRevoke = null,
  onPurge = null,
  // The definition is fetched on demand, so the screen renders fine without
  // it — an unopened disclosure and nothing else.
  dsl = null,
  dslLoading = false,
  dslError = null,
  onShowDefinition = () => {},
}) {
  const request = installedWatchRequest(watch);
  const delivery = installedWatchDelivery(watch);
  const disclosure = watchDisclosure(watch);
  const addedAt = watchInstant(watch.addedAt);
  // The compile this watch came out of — its transcript is what the compiler
  // read and answered before deciding what the watch means. Null for a watch
  // added from a hand-written DSL document, and for one compiled before
  // compiles were recorded.
  const compileRunHref = watch.compileRunId
    ? `/portal/debug/cognition/runs/${encodeURIComponent(watch.compileRunId)}`
    : null;
  const rows = mergeWatchFirings(firings, egress);
  return html`<div class="privacy-conversation-detail privacy-subscription-detail">
    <header class="privacy-detail-header">
      <div>
        <h1>${installedWatchSummary(watch)}</h1>
        <p>
          ${watch.name} · Added ${formatPrivacyDate(addedAt)}${compileRunHref
            ? html`${" · "}<a
                class="watch-link"
                href=${compileRunHref}
                onClick=${(event) => {
                  if (
                    event.metaKey
                    || event.ctrlKey
                    || event.shiftKey
                    || event.altKey
                    || event.button !== 0
                  ) return;
                  event.preventDefault();
                  navigate(compileRunHref);
                }}
              >View compilation transcript</a>`
            : null}
        </p>
      </div>
      <span class=${`privacy-item-status ${watch.status === "active" ? "success" : "muted"}`}>
        ${installedWatchStatusLabel(watch.status)}
      </span>
    </header>
    ${watch.note
      ? html`<div class="privacy-banner warning">
          ${installedWatchStatusLabel(watch.status)}: ${watch.note}
        </div>`
      : null}
    <div class="watch-detail-cards">
      <section class="privacy-section">
        <header class="privacy-section-head"><h2>What you asked for</h2></header>
        <p class="privacy-subscription-exact">
          ${request ?? "This watch was written as a definition, so it carries no request."}
        </p>
      </section>
      ${disclosure
        ? // A watch that wakes an agent says so once, in the section that says
          // what it was approved to send. Stating it here as well would print
          // the same fact twice, under two different names for the same
          // integration.
          html`<${WatchDisclosureSection}
            disclosure=${disclosure}
            bindings=${delivery.bindings}
            onRevoke=${onRevoke}
            onPurge=${onPurge}
          />`
        : html`<section class="privacy-section">
            <header class="privacy-section-head"><h2>When it fires</h2></header>
            <p class="privacy-subscription-exact">${delivery.text}</p>
            <${WatchWakeBindings} bindings=${delivery.bindings} />
            ${delivery.delivers
              ? null
              : html`<p class="privacy-subscription-note">
                  Delivery is off by default. Turn it on for this watch with
                  ${" "}<code>omnesis watch deliver ${watch.name}</code>.
                </p>`}
          </section>`}
    </div>
    <${WatchDefinition}
      dsl=${dsl}
      loading=${dslLoading}
      error=${dslError}
      onOpen=${onShowDefinition}
    />
    <section class="privacy-section watch-firings">
      <header class="privacy-section-head privacy-section-head--count">
        <h2>Firings</h2><span>${rows.length}</span>
      </header>
      ${/* Both banners stand on their own rather than as a fallback below the
            list. Either read can fail while the other succeeds, and a half
            ledger presented as a whole one — with a count that agrees with it
            — is the one way this screen can lie. */ null}
      ${firingsError
        ? html`<div class="privacy-banner error" role="alert">
            Failed to load firings: ${firingsError}
          </div>`
        : null}
      ${egressError
        ? html`<div class="privacy-banner error" role="alert">
            Failed to load what it has sent: ${egressError}
          </div>`
        : null}
      ${firingsLoading || egressLoading
        ? html`<${Loading} label="Loading firings…" />`
        : rows.length > 0
        ? html`<div class="portal-table-wrap">
            <table class="portal-table watch-firing-table">
              <thead>
                <tr>
                  <th>Fired at</th>
                  <th title="The subject's own time — the date on the document, the moment the meeting starts — when it differs from when the watch noticed it.">About</th>
                  <th>Delivery</th>
                  <th>Evidence</th>
                  <th class="watch-firing-records"></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((row) => html`<${WatchFiringRow}
                  key=${row.key}
                  watchId=${watch.id}
                  row=${row}
                  subscriptionId=${disclosure?.subscriptionId ?? null}
                  egressKnown=${egressError === null}
                />`)}
              </tbody>
            </table>
          </div>`
        : firingsError || egressError
        ? null
        : html`<p class="privacy-empty">This watch has not fired.</p>`}
    </section>
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
    <div class="privacy-delete-row">
      <button type="button" class="privacy-deny-button" onClick=${onRemove}>Remove watch</button>
    </div>
  </div>`;
}

/**
 * The watch itself, as it is actually stored.
 *
 * Everything above this reads the definition and says what it means; this is
 * the definition. It is what you send someone when a watch is not doing what
 * you expected, and the thing you edit and re-add when it is wrong.
 *
 * Fetched only when opened, and closed by default, for the same reason the
 * listing omits it: it is by far the largest field a watch has, and the screen
 * around it is about what the watch does rather than how it is written.
 */
function WatchDefinition({ dsl, loading, error, onOpen }) {
  return html`<details class="watch-dsl" onToggle=${(event) => {
    if (event.currentTarget.open) onOpen();
  }}>
    <summary>Definition</summary>
    ${loading ? html`<${Loading} label="Loading…" />` : null}
    ${error ? html`<p class="privacy-error">${error}</p>` : null}
    ${dsl
      ? html`<div class="watch-dsl-body">
          <${CopyIconButton} text=${dsl} class="watch-dsl-copy" title="Copy the definition" />
          <pre class="watch-dsl-pre">${dsl}</pre>
        </div>`
      : null}
  </details>`;
}

/**
 * One installed watch's screen.
 *
 * The watch itself arrives already read: deciding which family of watch an id
 * names is what fetched it, and asking the runtime a second question it has
 * already answered would be a round trip for nothing. The firings are this
 * screen's own read — the listing counts them and carries none.
 */
export function InstalledWatchRoute({ watch }) {
  const [firings, setFirings] = useState([]);
  const [firingsLoading, setFiringsLoading] = useState(true);
  const [firingsError, setFiringsError] = useState(null);
  const [error, setError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dsl, setDsl] = useState(null);
  const [dslLoading, setDslLoading] = useState(false);
  const [dslError, setDslError] = useState(null);
  const askedForDsl = useRef(false);
  const [removing, setRemoving] = useState(false);
  const [egress, setEgress] = useState([]);
  const [egressLoading, setEgressLoading] = useState(false);
  const [egressError, setEgressError] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  // A generation guard belongs to the read it guards: it may only discard a
  // result of its own read. These two start together on mount, so each carries
  // its own counter.
  const firingsGeneration = useRef(0);
  const egressGeneration = useRef(0);
  // A removal navigates on success, which is a thing to do only while this
  // screen is still the one on display.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const watchId = watch.id;
  const disclosure = watchDisclosure(watch);
  const subscriptionId = disclosure?.subscriptionId ?? null;

  useEffect(() => {
    const current = ++firingsGeneration.current;
    setFiringsLoading(true);
    setFiringsError(null);
    listWatchV2Firings(watchId)
      .then((payload) => {
        if (firingsGeneration.current !== current) return;
        const items = privacyCollection(payload, "firings");
        if (!items) throw new Error("Firing history response was incomplete.");
        // Newest first, so the most recent thing a watch said is the first
        // thing read. The runtime returns them in the order they happened.
        setFirings([...items].reverse());
      })
      .catch((err) => {
        if (firingsGeneration.current === current) setFiringsError(errorMessage(err));
      })
      .finally(() => {
        if (firingsGeneration.current === current) setFiringsLoading(false);
      });
    return () => {
      if (firingsGeneration.current === current) firingsGeneration.current += 1;
    };
  }, [watchId]);

  /**
   * Everything this watch has actually sent, when it wakes an agent.
   *
   * A separate read because it comes from a separate store — the record that
   * authorises the egress, not the runtime that evaluates the watch. What each
   * one holds is half of the same firing, and the screen folds them back into
   * one row apiece.
   */
  useEffect(() => {
    if (!subscriptionId) {
      setEgress([]);
      setEgressError(null);
      return undefined;
    }
    const current = ++egressGeneration.current;
    setEgressLoading(true);
    setEgressError(null);
    listPrivacySubscriptionFirings(subscriptionId)
      .then((payload) => {
        if (egressGeneration.current !== current) return;
        setEgress(privacyCollection(payload, "firings") ?? []);
      })
      .catch((err) => {
        if (egressGeneration.current === current) setEgressError(errorMessage(err));
      })
      .finally(() => {
        if (egressGeneration.current === current) setEgressLoading(false);
      });
    return () => {
      if (egressGeneration.current === current) egressGeneration.current += 1;
    };
  }, [subscriptionId]);

  async function revoke() {
    if (!subscriptionId) return;
    setConfirmRevoke(false);
    setError(null);
    try {
      await revokePrivacySubscriptionRequest(subscriptionId);
      // The record this page reads is now terminal, and the page renders it
      // from the watch it was handed. Re-reading from the list is the honest
      // refresh: patching a status this screen did not compute would state a
      // fact nothing verified.
      navigate("/portal/watches");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function purge() {
    if (!subscriptionId) return;
    setConfirmPurge(false);
    setError(null);
    try {
      await purgePrivacySubscription(subscriptionId);
      navigate("/portal/watches");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /**
   * Read the definition, once, the first time it is asked for.
   *
   * The listing omits it because it is the largest field a watch has and the
   * list is polled; the same reasoning says not to fetch it here until someone
   * opens it.
   */
  function showDefinition() {
    if (askedForDsl.current) return;
    askedForDsl.current = true;
    setDslLoading(true);
    setDslError(null);
    getWatchV2Watch(watchId)
      .then((payload) => {
        const full = payload?.watch;
        if (!full?.dsl) throw new Error("The watch came back without its definition.");
        setDsl(JSON.stringify(full.dsl, null, 2));
      })
      .catch((err) => {
        askedForDsl.current = false;
        setDslError(errorMessage(err));
      })
      .finally(() => setDslLoading(false));
  }

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await deleteWatchV2Watch(watchId);
      if (mounted.current) navigate("/portal/watches");
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage(err));
        setRemoving(false);
        setConfirmRemove(false);
      }
    }
  }

  return html`<div class="privacy-view">
    <a class="doc-back" href="/portal/watches" onClick=${(event) => {
      event.preventDefault();
      navigate("/portal/watches");
    }}>← Watches</a>
    <${InstalledWatchDetail}
      dsl=${dsl}
      dslLoading=${dslLoading}
      dslError=${dslError}
      onShowDefinition=${showDefinition}
      watch=${watch}
      firings=${firings}
      firingsLoading=${firingsLoading}
      firingsError=${firingsError}
      error=${error}
      onRemove=${() => setConfirmRemove(true)}
      egress=${egress}
      egressLoading=${egressLoading}
      egressError=${egressError}
      onRevoke=${subscriptionId ? () => setConfirmRevoke(true) : null}
      onPurge=${subscriptionId ? () => setConfirmPurge(true) : null}
    />
    <${ConfirmModal}
      open=${confirmRevoke}
      title="Revoke this watch's access?"
      body="The watch stays, and stops waking the integration. Everything it has already sent is kept — an egress ledger with the record removed would describe disclosures nothing accounts for."
      confirmLabel="Revoke"
      onConfirm=${revoke}
      onCancel=${() => setConfirmRevoke(false)}
    />
    <${ConfirmModal}
      open=${confirmPurge}
      title="Delete this record permanently?"
      body="The watch stays. What goes is the record of what was approved and every disclosure it accounts for. Only a record that has already ended can be deleted, and this cannot be undone."
      confirmLabel="Delete"
      destructive=${true}
      onConfirm=${purge}
      onCancel=${() => setConfirmPurge(false)}
    />
    <${ConfirmModal}
      open=${confirmRemove}
      title="Remove this watch?"
      body="It stops watching, and everything the runtime holds for it — its place in the journal, what it has already looked at, and every firing it recorded — goes with it. This cannot be undone."
      confirmLabel=${removing ? "Removing…" : "Remove"}
      destructive=${true}
      onConfirm=${remove}
      onCancel=${() => { if (!removing) setConfirmRemove(false); }}
    />
  </div>`;
}
