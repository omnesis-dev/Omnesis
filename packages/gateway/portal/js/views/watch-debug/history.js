// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The history lens: why this watch said what it said, and why it did not.
 *
 * The canvas says what a watch is shaped like and the pane says what it is set
 * to. This says what it *did*. Picking one event lights the path that event
 * took across the canvas — every node it touched wearing that moment's verdict
 * — and opens the pane on the rest: the judge's own sentence where one was
 * given, the class that parked a nomination, what the firing was read out of,
 * and where it went.
 *
 * Considerations are first-class here, not a footnote under the firings. "Why
 * didn't it fire" is the question this lens exists for, and an event that
 * decided nothing is the answer to it — so the picker lists a hold beside a
 * firing and selects it the same way.
 *
 * The selection lives in the path, not in local state, which is what lets a
 * firing in the Watches ledger link straight to the moment it happened.
 *
 * Read-only, like the rest of this page: nothing here fires, probes or pauses.
 */

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { getWatchV2History, getWatchV2JudgeExchanges } from "../../api.js";
import { navigate } from "../../lib/router.js";
import {
  WATCH_HISTORY_PAGE,
  findWatchPath,
  readWatchHistory,
  watchDebugHref,
  watchKeyDisplay,
  watchNodeVerdict,
  watchPathSummary,
  watchPathTone,
  watchPathVerdicts,
  watchTransition,
} from "../../lib/watch-trace.js";
import { DocChip } from "../../components/doc-chip.js";
import { WATCH_SINK_ID } from "../../lib/watch-dsl.js";
import { errorMessage, formatPrivacyDate } from "../shared/privacy-vocabulary.js";
import { watchInstant } from "../watches/vocabulary.js";
import { WatchRawJson } from "./pane.js";

/**
 * One watch's history, and whichever event the path names.
 *
 * Read once per watch rather than polled. Refresh-on-demand is the whole
 * page's contract — a canvas that re-drew itself under a reader would make the
 * lit path mean a different moment from the one they selected.
 */
export function useWatchHistoryLens(watchId, selectedSeq) {
  const empty = {
    paths: [],
    retained: null,
    events: null,
    lineage: {},
    documents: {},
    exchanges: [],
    loading: true,
    error: null,
  };
  const [state, setState] = useState(empty);
  // Whether the events nothing took up were asked for. Local to this lens and
  // reset per watch: it is a way of looking at one watch, not a preference.
  const [untouched, setUntouched] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    setUntouched(false);
  }, [watchId]);

  useEffect(() => {
    const current = ++generation.current;
    setState(empty);
    getWatchV2History(watchId, {
      limit: WATCH_HISTORY_PAGE,
      ...(untouched ? { untouched: "include" } : {}),
    })
      .then((payload) => {
        if (generation.current !== current) return;
        const { paths, retained, events, lineage, documents } = readWatchHistory(payload);
        setState({
          paths,
          retained,
          events,
          lineage,
          documents,
          exchanges: [],
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (generation.current !== current) return;
        // A 404 is this install saying the surface is not there, which is a
        // state of the gateway rather than a failure of the read.
        setState({
          paths: [],
          retained: null,
          events: null,
          exchanges: [],
          loading: false,
          error: err?.status === 404 ? null : errorMessage(err),
        });
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [watchId, untouched]);

  // Asked for separately, and allowed to fail on its own: a gateway that
  // predates the exchanges 404s here, and losing the history over that would
  // cost the reader the thing they came for.
  useEffect(() => {
    const current = generation.current;
    getWatchV2JudgeExchanges(watchId)
      .then((payload) => {
        if (generation.current !== current) return;
        const exchanges = Array.isArray(payload?.exchanges) ? payload.exchanges : [];
        setState((prev) => ({ ...prev, exchanges }));
      })
      .catch(() => {
        if (generation.current !== current) return;
        setState((prev) => ({ ...prev, exchanges: [] }));
      });
  }, [watchId, untouched]);

  const path = useMemo(
    () => findWatchPath(state.paths, selectedSeq),
    [state.paths, selectedSeq],
  );
  // Null rather than an empty map when nothing is selected: the canvas reads
  // the difference between "no path is lit" and "this path lit no nodes".
  const verdicts = useMemo(() => (path ? watchPathVerdicts(path) : null), [path]);
  return {
    ...state,
    watchId,
    selectedSeq,
    path,
    verdicts,
    untouchedShown: untouched,
    showUntouched: setUntouched,
  };
}

// ── The picker ──────────────────────────────────────────────────────────────

/**
 * Every event the trace still explains, newest first, with the firings the
 * trace has forgotten kept among them rather than dropped.
 */
export function WatchHistoryList({ lens, names = null, onSelect = () => {} }) {
  if (lens.loading) return html`<div class="debug-loading">Loading what it has done…</div>`;
  if (lens.error) {
    return html`<div class="debug-error" role="alert">${lens.error}</div>`;
  }
  if (lens.paths.length === 0) {
    // An empty page has two causes now, and saying the wrong one is worse than
    // saying nothing: a watch nothing has happened to, and a watch every one of
    // whose events was held back. The count below distinguishes them, so it has
    // to render here too — this branch is exactly where it matters most.
    const folded = lens.events !== null && lens.events.untouched > 0;
    return html`<div class="watch-history">
      <h4>What it has done</h4>
      <p class="privacy-empty">
        ${folded
          ? `Nothing took an event up yet. The runtime has looked at this watch, and every event it
             looked at is held back below.`
          : `Nothing yet. The runtime has evaluated no event for this watch — or every one it did
             has aged out of the trace it keeps.`}
      </p>
      <${Untouched} lens=${lens} />
    </div>`;
  }
  return html`<div class="watch-history">
    <h4>What it has done</h4>
    <p class="watch-pane-note">
      One row per journal event: what the runtime looked at, and what it decided. Pick one to light
      the path it took.
    </p>
    <ul class="watch-history-list">
      ${lens.paths.map((path) => {
        const href = watchDebugHref(lens.watchId, path.seq);
        const selected = path.seq === lens.selectedSeq;
        return html`<li key=${path.seq}>
          <a
            class=${`watch-history-row ${selected ? "is-selected" : ""}`.trim()}
            href=${href}
            aria-current=${selected ? "true" : null}
            onClick=${(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              // Told on every click, not only when the event changes: picking
              // the row already selected is how a reader gets back to its pane
              // after opening a node, and a navigation to the path already in
              // the address bar changes nothing for anyone else to react to.
              onSelect(path.seq);
              navigate(href);
            }}
          >
            <span class="watch-history-main">
              <span class=${`watch-history-verdict is-${watchPathTone(path)}`}>
                ${watchPathSummary(path)}
              </span>
              <span class="watch-history-meta">
                ${path.timer
                  ? html`<span class="watch-dag-note" title="A deadline elapsing, not an arrival."
                      >deadline</span
                    >`
                  : html`<code>event ${path.seq}</code>`}
                ${path.keys.map(
                  (key) =>
                    html`<code key=${key} class="watch-dag-key">${watchKeyDisplay(key, names)}</code>`,
                )}
              </span>
            </span>
            <span class="watch-history-when">${pathInstant(path)}</span>
            <span class="privacy-row-chevron" aria-hidden="true">›</span>
          </a>
        </li>`;
      })}
    </ul>
    <${Untouched} lens=${lens} />
    ${lens.retained === null
      ? null
      : html`<p class="watch-pane-note">
          ${lens.retained} trace records are still held for this watch.${" "}
          ${lens.paths.some((path) => !path.traceRetained)
            ? `Older events roll off while their firings are kept, which is why some of the rows
               above have no path left to draw.`
            : "Older events roll off while their firings are kept."}
        </p>`}
  </div>`;
}

/**
 * The events the list held back, as a count rather than as rows.
 *
 * A document that fails a source's filter never reaches a node and leaves no
 * record; a document that reaches one and no arm nominates it leaves a record
 * saying so. Those are the runtime's noise floor — on a watch with a narrow
 * recall arm they are most of what it sees, and a row apiece buries every event
 * that actually decided something.
 *
 * Stated as a share rather than a bare number, because that is the diagnostic:
 * a watch declining nearly everything it looks at, and never firing, has an arm
 * too narrow to catch what it was written for. Nothing else on this page says
 * so, and hiding the count would hide that too.
 */
function Untouched({ lens }) {
  const events = lens.events;
  if (!events || events.untouched === 0) return null;
  const share = Math.round((events.untouched / Math.max(events.total, 1)) * 100);
  return html`<p class="watch-pane-note watch-history-untouched">
    ${events.untouched} of ${events.total} events in the retained trace reached this watch and no
    node took them up${share >= 90 ? " — nearly everything it looked at" : ""}: a document
    arrived, and no recall arm nominated it.${events.declined > events.untouched
      ? ` It has declined ${events.declined.toLocaleString()} in all; the runtime keeps a sample
         of those rather than every one.`
      : ""}${" "}
    <button
      type="button"
      class="btn-tiny"
      onClick=${() => lens.showUntouched(!lens.untouchedShown)}
    >
      ${lens.untouchedShown ? "hide them" : "show them anyway"}
    </button>
  </p>`;
}

// ── The pane ────────────────────────────────────────────────────────────────

/**
 * One event in full. Its own drawer rather than a third case inside the
 * definition pane: what it shows is what the runtime *did*, and the two want
 * different sections under the same chrome.
 */
export function WatchHistoryPane({
  path,
  names = null,
  lineage = {},
  documents = {},
  exchanges = [],
  onClose,
}) {
  if (!path) return null;
  return html`<div
    class="sources-drawer watch-dag-drawer"
    role="dialog"
    aria-label=${`Watch history — event ${path.seq}`}
  >
    <div class="sources-drawer-header">
      <h3>${path.timer ? "Deadline" : "Event"} — <code>${path.seq}</code></h3>
      <button type="button" class="btn-tiny" onClick=${onClose}>close</button>
    </div>
    <div class="sources-drawer-body">
      <${Section} title="What happened">
        <${Rows}
          rows=${[
            ["When", pathInstant(path)],
            ["Outcome", watchPathSummary(path)],
            [
              "Cause",
              // Three causes, not two. A firing an operator forced carries a
              // sequence from the same counter a deadline does, so anything
              // that reads only the sign of the sequence calls it a deadline —
              // and anything that reads only "not a deadline" calls it an
              // arrival. It is neither: nothing came in and nothing came due.
              path.forced
                ? "An operator fired this watch by hand."
                : path.timer
                  ? "A deadline this watch armed for itself elapsed."
                  : "Something arrived on the journal.",
            ],
            [
              "Keys",
              // Each in its own chip rather than one joined string, so a key
              // here is marked as a key the same way it is everywhere else.
              path.keys.length > 0
                ? html`${path.keys.map(
                    (key) =>
                      html`<code key=${key} class="watch-dag-key"
                        >${watchKeyDisplay(key, names)}</code
                      >`,
                  )}`
                : null,
            ],
          ]}
        />
      <//>
      ${path.traceRetained
        ? html`<${PathSteps} path=${path} names=${names} />`
        : html`<${Section} title="The path it took">
            <p class="privacy-empty">
              Trace no longer retained for this firing. The runtime keeps a bounded account of what
              it did and an unbounded ledger of what it said, so a firing outlives the record of
              how it was reached.
            </p>
          <//>`}
      <${Firings} path=${path} lineage=${lineage} documents=${documents} />
      <${JudgeExchanges} path=${path} exchanges=${exchanges} />
      <${WatchRawJson} value=${path} />
    </div>
  </div>`;
}

/**
 * What the judge was asked about the nodes on this path, and what it answered.
 *
 * Scoped to those nodes and no further, and each row carries its own subject
 * and time rather than being presented as this event's. The exchange is keyed
 * by the document it was about; a path knows which nodes it touched but not, in
 * general, which document each of them judged — so claiming a row belongs to
 * the event on screen would be a guess, and a wrong one on any node that has
 * judged more than once.
 *
 * The verdict beside a node says which way the judge went. This is the only
 * place that says what it was given to decide on, which is what a proposition
 * asking about the wrong field is diagnosed from.
 */
function JudgeExchanges({ path, exchanges }) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) return null;
  const touched = new Set(path.nodes.map((node) => node.nodeId));
  const mine = exchanges.filter((exchange) => touched.has(exchange.nodeId));
  if (mine.length === 0) return null;
  return html`<${Section} title="What the judge was asked">
    <p class="watch-pane-note">
      The most recent exchanges on the nodes this event touched, newest first. Each says what it
      was about; they are not necessarily this event's.
    </p>
    <ul class="watch-history-exchanges">
      ${mine.map(
        (exchange, index) => html`<li key=${`${exchange.nodeId}:${exchange.at}:${index}`}>
          <span class="watch-history-step">
            <code>${exchange.nodeId}</code>
            <span
              class=${`watch-history-verdict is-${
                exchange.verdict === "matched"
                  ? "good"
                  : exchange.verdict === "unreadable"
                    ? "warn"
                    : "muted"
              }`}
            >
              ${exchange.verdict}
            </span>
            <code class="watch-dag-key">${exchange.subject}</code>
            <span class="watch-pane-note">${exchange.ms}ms · ${exchange.at}</span>
          </span>
          <details class="watch-history-exchange">
            <summary>view judge exchange</summary>
            <p class="watch-pane-note">Asked</p>
            <pre class="watch-pane-pre">${exchange.prompt}</pre>
            <p class="watch-pane-note">Answered</p>
            <pre class="watch-pane-pre">${exchange.reply}</pre>
          </details>
        </li>`,
      )}
    </ul>
  <//>`;
}

/** Every node the event touched, in the order the runtime wrote them. */
/**
 * A node that looked at this event and took nothing up.
 *
 * `ignored` is the runtime's word for both ways that happens — a colliding arm
 * discarded because a cell was already live, and a document no recall arm
 * nominated. Neither armed anything and neither judged anything, which is what
 * makes them the same kind of non-answer to "why did this happen".
 */
function lookedAndDeclined(node) {
  return node.verdict === "ignored";
}

function PathSteps({ path, names = null }) {
  if (path.nodes.length === 0) {
    return html`<${Section} title="The path it took">
      <p class="privacy-empty">This event reached no node: nothing in the graph was listening.</p>
    <//>`;
  }
  const acted = path.nodes.filter((node) => !lookedAndDeclined(node));
  const declined = path.nodes.filter(lookedAndDeclined);
  /**
   * Fold the shrugs, but only when something else answered.
   *
   * On a watch with several source arms, every event that matches one of them
   * is looked at by all of them, so the arms that declined outnumber the one
   * that acted and bury it. When **nothing** acted, though, the declines are
   * the entire answer to why nothing happened — folding them there would hide
   * the only thing the page had to say.
   */
  const fold = acted.length > 0 && declined.length > 0;
  return html`<${Section} title="The path it took">
    <ol class="watch-history-path">
      ${(fold ? acted : path.nodes).map((node, index) => {
        const verdict = watchNodeVerdict(node);
        // Everything before the decisive one — an `armed` under a `held` is
        // what says the cell opened on this same event rather than earlier.
        const earlier = node.steps.slice(0, -1);
        return html`<li key=${`${node.nodeId}:${node.key}:${index}`}>
          <span class="watch-history-step">
            <code>${node.nodeId}</code>
            <span class=${`watch-history-verdict is-${verdict.tone}`} title=${verdict.meaning}>
              ${verdict.label}
            </span>
            ${verdict.failure
              ? html`<span class="watch-dag-note cancel" title=${verdict.failure.meaning}>
                  ${verdict.failure.label}
                </span>`
              : null}
            <code class="watch-dag-key">${watchKeyDisplay(node.key, names)}</code>
          </span>
          ${node.detail
            ? html`<p class="watch-pane-prose watch-history-detail">${node.detail}</p>`
            : null}
          ${earlier.length > 0
            ? html`<p class="watch-pane-note">
                First ${earlier.map((step) => watchTransition(step.transition).label).join(", then ")}.
              </p>`
            : null}
        </li>`;
      })}
    </ol>
    ${fold
      ? html`<details class="watch-history-declined">
          <summary>
            ${declined.length} other arm${declined.length === 1 ? "" : "s"} looked and declined
          </summary>
          <ol class="watch-history-path">
            ${declined.map((node, index) => {
              const verdict = watchNodeVerdict(node);
              return html`<li key=${`${node.nodeId}:${node.key}:${index}`}>
                <span class="watch-history-step">
                  <code>${node.nodeId}</code>
                  <span
                    class=${`watch-history-verdict is-${verdict.tone}`}
                    title=${verdict.meaning}
                  >
                    ${verdict.label}
                  </span>
                  <code class="watch-dag-key">${watchKeyDisplay(node.key, names)}</code>
                </span>
                ${node.detail
                  ? html`<p class="watch-pane-prose watch-history-detail">${node.detail}</p>`
                  : null}
              </li>`;
            })}
          </ol>
        </details>`
      : null}
  <//>`;
}

/**
 * What the firing carried, with the documents among it rendered as documents.
 *
 * Which fields those are comes from the watch's own definition, computed when
 * it was compiled and carried on the response. Guessing from a field's name at
 * render time is the alternative, and it renders a person id as a document that
 * does not exist with nothing on the page admitting it guessed — so a value the
 * lineage does not mark is printed as the string it is.
 */
function payloadRows(payload, documentFields, documents) {
  if (!payload || typeof payload !== "object") return [];
  return Object.entries(payload).map(([field, value]) => {
    const document = documentFields.includes(field) && typeof value === "string"
      ? documents[value]
      : undefined;
    return [
      field,
      document
        ? html`<${DocChip}
            documentId=${value}
            title=${document.title}
            sourceId=${document.sourceId}
          />`
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    ];
  });
}

/**
 * The documents behind a firing that its payload does not already name.
 *
 * A sink's evidence field is usually derived from the same provenance chain the
 * documents come from, so rendering both puts the same chip on screen twice —
 * once under the field that carries it and once unlabelled beneath. The labelled
 * one is the better statement, so this block shows only what it leaves out: a
 * join's second arm, a document a payload never mentions.
 */
function unnamed(firing, documentFields) {
  const named = new Set(
    documentFields.flatMap((field) => {
      const value = firing.payload?.[field];
      return typeof value === "string" ? [value] : [];
    }),
  );
  return firing.documents.filter((document) => !named.has(document.id));
}

/** What the event said, what it was read out of, and where it went. */
function Firings({ path, lineage = {}, documents = {} }) {
  if (path.firings.length === 0) {
    return html`<${Section} title="What it said">
      <p class="privacy-empty">
        Nothing: this event was considered and the watch stayed quiet.
      </p>
    <//>`;
  }
  return html`
    ${path.firings.map(
      (firing, index) => html`<${Section}
        key=${firing.keyHash || index}
        title=${path.firings.length > 1 ? `What it said (${index + 1})` : "What it said"}
      >
        <${Rows}
          rows=${[
            ["From", html`<code>${firing.nodeId}</code>`],
            ["Fired", instant(firing.firedAt)],
            [
              "Noticed",
              firing.noticedAt && firing.noticedAt !== firing.firedAt
                ? instant(firing.noticedAt)
                : null,
            ],
            [
              "By hand",
              firing.forced ? "An operator fired this; nothing was evaluated." : null,
            ],
            ...payloadRows(firing.payload, lineage[WATCH_SINK_ID] ?? [], documents),
          ]}
        />
        ${unnamed(firing, lineage[WATCH_SINK_ID] ?? []).length === 0
          ? firing.documents.length > 0
            ? null
            : html`<p class="watch-pane-note">
              ${firing.forced
                ? "Nothing in the corpus is behind this one: nothing was evaluated to produce it."
                : `Nothing in the corpus is behind this one — it came true on a clock, a row, or a
                   deadline passing.`}
            </p>`
          : html`<div class="watch-firing-evidence">
              ${unnamed(firing, lineage[WATCH_SINK_ID] ?? []).map(
                (document) => html`<${DocChip}
                  key=${document.id}
                  documentId=${document.id}
                  title=${document.title}
                  sourceId=${document.sourceId}
                />`,
              )}
            </div>`}
        <${Delivery}
          delivery=${firing.delivery}
          suppressed=${path.nodes.some((node) =>
            node.steps.some((step) => step.transition === "suppressed"),
          )}
        />
      <//>`,
    )}
  `;
}

/**
 * @param suppressed Whether a cap stopped this event's firings, which is the
 * one cause of a missing delivery row the page can actually tell apart: the
 * runtime records the cap as a transition on the path and never reaches an
 * outcome to write. Every other cause leaves the same absence — a watch with no
 * delivery block, a channel never wired, an outcome the write lost — so with
 * this false the sentence below states the absence and stops there.
 */
function Delivery({ delivery, suppressed = false }) {
  if (!delivery) {
    return html`<p class="watch-pane-note">
      ${suppressed
        ? `Recorded, and deliberately not delivered: the daily cap on how often this watch may
           interrupt you was already spent.`
        : `Recorded, with no delivery attempted against it. A watch with no delivery block tells
           nobody; so does one whose channel is not wired.`}
    </p>`;
  }
  const reached = delivery.delivered > 0;
  return html`
    <span class=${`privacy-item-status ${reached ? "success" : "error"}`}>
      ${reached
        ? delivery.kind === "agent-wake"
          ? "Woke an agent"
          : "Notified your devices"
        : "Not delivered"}
    </span>
    <${Rows}
      rows=${[
        ["Channel", html`<code>${delivery.kind}</code>`],
        [
          "Reached",
          Number.isFinite(delivery.attempted)
            ? `${delivery.delivered} of ${delivery.attempted}`
            : String(delivery.delivered),
        ],
        // A transport's own words get a row rather than the status badge: an
        // error long enough to name five configuration keys is not a status,
        // and it is exactly the text an operator has to read carefully, since
        // it names the thing to fix.
        ...(delivery.error ? [["Why not", delivery.error]] : []),
        ["At", instant(delivery.at)],
      ]}
    />
  `;
}

// ── Shared building blocks ──────────────────────────────────────────────────

function Section({ title, children }) {
  return html`<section class="watch-pane-section">
    <h4>${title}</h4>
    ${children}
  </section>`;
}

/** Label / value pairs; an absent value drops its row rather than printing "—". */
function Rows({ rows }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (present.length === 0) return null;
  return html`<dl class="watch-pane-rows">
    ${present.map(
      ([label, value], index) => html`<div key=${`${label}:${index}`}>
        <dt>${label}</dt>
        <dd>${value}</dd>
      </div>`,
    )}
  </dl>`;
}

/** An ISO instant as the rest of the portal prints one. */
function instant(value) {
  const at = watchInstant(value);
  return at === null ? null : formatPrivacyDate(at);
}

function pathInstant(path) {
  return instant(path.at) ?? "Unknown";
}

function isModifiedClick(event) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}
