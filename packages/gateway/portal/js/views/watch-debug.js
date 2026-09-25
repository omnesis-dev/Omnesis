// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Watch — the definition of one watch, as the runtime holds it.
 *
 * The Watches page says what a watch was asked to catch and what it has caught.
 * This is the other question: what it is actually *shaped* like. A watch is a
 * graph of keyed nodes, and until you can see the graph, "why did this not
 * fire" is answered by reading a JSON document top to bottom and holding the
 * edges in your head.
 *
 * Read-only, and deliberately: probing, firing by hand, pausing and resuming
 * all stay in the CLI. Nothing on this page changes anything.
 *
 * The definition comes from `GET /admin/watch/watches/:id`, which serves the
 * stored DSL verbatim; the live state from `GET .../state`, which returns one
 * consistent snapshot per call. That whole route family 404s outside
 * experimental mode, so a miss is read as "this install has no such watch"
 * rather than as a failure of the read.
 *
 * State is **refreshed on demand**, never tailed. One read, one moment, stated
 * on the page — so nothing on the canvas can belong to a different instant from
 * anything else on it.
 */

import { html } from "htm/preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { getWatchV2Watch, getWatchV2WatchState, listWatchV2Watches } from "../api.js";
import { navigate } from "../lib/router.js";
import { layoutWatchDag, readWatchDag } from "../lib/watch-dag.js";
import {
  cellsForKey,
  litNodeIds,
  readWatchStateSnapshot,
  watchStateNames,
} from "../lib/watch-state.js";
// Where this tab lives, and how one watch — with or without an event selected
// — is addressed. Owned by the trace library so a firing in the Watches ledger
// can link here without pulling the canvas in behind it.
import { WATCH_DEBUG_PATH, watchDebugHref } from "../lib/watch-trace.js";
import {
  errorMessage,
  formatPrivacyRelativeDate,
  privacyCollection,
} from "./shared/privacy-vocabulary.js";
import {
  installedWatchDocument,
  installedWatchLiveness,
  installedWatchStatusLabel,
  installedWatchSummary,
} from "./watches/vocabulary.js";
import { WatchDagCanvas } from "./watch-debug/canvas.js";
import {
  WatchHistoryList,
  WatchHistoryPane,
  useWatchHistoryLens,
} from "./watch-debug/history.js";
import { WatchDagPane, WatchRawJson } from "./watch-debug/pane.js";
import { WatchStateBar } from "./watch-debug/state.js";

export function WatchDebugTab({ watchId = null, seq = null }) {
  return watchId
    ? html`<${WatchDefinitionRoute} watchId=${watchId} seq=${seq} />`
    : html`<${WatchPicker} />`;
}

// ── Choosing a watch ────────────────────────────────────────────────────────

function WatchPicker() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [journalHead, setJournalHead] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    listWatchV2Watches()
      .then((payload) => {
        if (generation.current !== current) return;
        const items = privacyCollection(payload, "watches") ?? [];
        setWatches(items.map(installedWatchDocument).filter((watch) => watch !== null));
        // The producer's position, which each row's cursor is read against.
        setJournalHead(Number.isInteger(payload?.journalHead) ? payload.journalHead : null);
        setError(null);
      })
      .catch((err) => {
        if (generation.current !== current) return;
        if (err?.status === 404) setWatches([]);
        else setError(errorMessage(err));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, []);

  if (loading) return html`<div class="debug-loading">Loading watches…</div>`;
  if (error) return html`<div class="debug-error" role="alert">${error}</div>`;
  if (watches.length === 0) {
    return html`<div class="debug-empty">
      No watches are installed. Ask your agent to keep an eye on something, or add a definition with
      <code>omnesis watch add</code>.
    </div>`;
  }
  return html`<div class="debug-section">
    <p class="debug-sub">
      Pick a watch to see the graph the runtime evaluates: its nodes, the keys that flow between
      them, and everything the definition sets on each one.
    </p>
    <ul class="watch-dag-picker">
      ${watches.map((watch) => {
        const href = watchDebugHref(watch.id);
        return html`<li key=${watch.id}>
          <a
            href=${href}
            onClick=${(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              navigate(href);
            }}
          >
            <span class="watch-dag-picker-main">
              <strong class="watch-dag-picker-title">${installedWatchSummary(watch)}</strong>
              <span class="watch-dag-picker-meta">
                <code>${watch.name}</code> · ${installedWatchStatusLabel(watch.status)} ·${" "}
                <${Liveness} watch=${watch} journalHead=${journalHead} />
              </span>
            </span>
            <span class="privacy-row-chevron" aria-hidden="true">›</span>
          </a>
        </li>`;
      })}
    </ul>
  </div>`;
}

/**
 * Whether this watch is holding anything, in one glance.
 *
 * A filled dot against a hollow one is the whole point: the list splits into
 * watches that are tracking something and watches sitting empty, before any
 * number is read. The count says how much, and the soonest deadline is the only
 * thing here that predicts behaviour — it is the difference between a watch
 * that will act on its own and one that can only react to what arrives.
 *
 * Deliberately not a health signal. An empty watch is the ordinary resting
 * state of one waiting for something to happen, so the hollow dot is dimmed
 * rather than coloured, and nothing here reorders the list.
 *
 * The count is of keys still holding something, which is usually the whole
 * population and sometimes less than it. Where it is less, the state tab lists
 * cells this line has just declined to count, so the difference is named on the
 * mark itself rather than left to look like a contradiction. Named in cells,
 * because cells are what that tab enumerates.
 */
function Liveness({ watch, journalHead }) {
  const live = installedWatchLiveness(watch, journalHead);
  const remembering = Math.max(0, live.cells - live.holdingCells);
  const kept =
    remembering === 0
      ? null
      : `${remembering} more ${remembering === 1 ? "cell is" : "cells are"} kept as bookkeeping — a spent cooldown, a drained window — and hold nothing.`;
  return html`<span class="watch-liveness" title=${kept ?? ""}>
    ${/* The spaces are explicit because the template collapses a newline
          between two interpolations, which is how "15 armedtimers" happens. */
    live.holding
      ? html`<span class="watch-liveness-mark is-holding" aria-hidden="true">●</span>${" "}${live.keys >
        0
          ? `${live.keys} ${live.keys === 1 ? "key" : "keys"}`
          : // Holding a timer and no cell: a watch on a clock, which is the one
            // kind that acts with nothing arriving at all.
            "armed"}`
      : html`<span class="watch-liveness-mark" aria-hidden="true">○</span>${" "}<span
            class="watch-liveness-idle"
            >nothing live</span
          >`}
    ${live.nextDueAt === null
      ? null
      : live.nextDueAt <= Date.now()
        ? html` ·${" "}<span
              class="watch-liveness-behind"
              title="Due, but timers are only swept by an evaluation pass — it fires on the next tick."
              >due now</span
            >`
        : html` · <span title="The soonest deadline this watch has armed."
              >next ${formatPrivacyRelativeDate(live.nextDueAt)}</span
            >`}
    ${live.behind === 0
      ? null
      : html` ·${" "}
          <span
            class="watch-liveness-behind"
            title="This watch has not read that many journal events yet, so what it holds is not the whole story."
            >${live.behind} behind</span
          >`}
  </span>`;
}

// ── One watch's definition ──────────────────────────────────────────────────

function WatchDefinitionRoute({ watchId, seq }) {
  const [watch, setWatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // What the right pane is showing: nothing, the watch as a whole, or one node.
  const [selection, setSelection] = useState(null);
  // The live state, as of one moment. Null until the first read returns, and
  // deliberately never replaced piecemeal — a snapshot is all or nothing.
  const [state, setState] = useState(null);
  const [stateError, setStateError] = useState(null);
  const [stateLoading, setStateLoading] = useState(true);
  // The key lens: which key the canvas is dimmed to, and the selector's filter.
  const [selectedKeyHash, setSelectedKeyHash] = useState(null);
  const [keyQuery, setKeyQuery] = useState("");
  const generation = useRef(0);
  const stateGeneration = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setSelection(null);
    getWatchV2Watch(watchId)
      .then((payload) => {
        if (generation.current !== current) return;
        const full = payload?.watch;
        if (!full?.dsl) throw new Error("The watch came back without its definition.");
        setWatch(full);
        setError(null);
      })
      .catch((err) => {
        if (generation.current !== current) return;
        setWatch(null);
        setError(
          err?.status === 404 ? "This install has no watch with that id." : errorMessage(err),
        );
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [watchId]);

  const refreshState = useCallback(() => {
    const current = ++stateGeneration.current;
    setStateLoading(true);
    getWatchV2WatchState(watchId)
      .then((payload) => {
        if (stateGeneration.current !== current) return;
        setState(readWatchStateSnapshot(payload));
        setStateError(null);
      })
      .catch((err) => {
        if (stateGeneration.current !== current) return;
        // The definition rendered, so the page is not broken — only the state
        // half of it is, and saying so beside the canvas is better than
        // replacing a readable graph with an error.
        setState(null);
        setStateError(errorMessage(err));
      })
      .finally(() => {
        if (stateGeneration.current === current) setStateLoading(false);
      });
  }, [watchId]);

  useEffect(() => {
    // A key selected on one watch means nothing on another.
    setSelectedKeyHash(null);
    setKeyQuery("");
    refreshState();
    return () => {
      stateGeneration.current += 1;
    };
  }, [refreshState]);

  // Escape closes the pane, which is the reflex a slide-in panel earns. A pane
  // opened on an event closes by navigating, because that is where its
  // selection lives.
  useEffect(() => {
    if (!selection && seq === null) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (selection) setSelection(null);
      else navigate(watchDebugHref(watchId));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, seq, watchId]);

  // What the watch has done, and whichever event the path names. Selecting one
  // is a navigation, so arriving from a firing in the ledger and picking a row
  // here land in exactly the same state.
  const history = useWatchHistoryLens(watchId, seq);

  // A newly selected event opens the pane on itself. Without this the pane
  // would stay on whichever node was last clicked, and the evidence and
  // delivery — the half of a firing that is not on the canvas — would never
  // show.
  useEffect(() => {
    if (seq !== null) setSelection(null);
  }, [seq]);

  const read = useMemo(() => (watch ? readWatchDag(watch.dsl) : null), [watch]);
  const layout = useMemo(() => (read?.ok ? layoutWatchDag(read.dag) : null), [read]);
  // What each node's badge counts, which the key lens narrows. With a key
  // selected the reader has asked to see one key's slice, and a node still
  // reporting its whole population answers a question they stopped asking —
  // on a watch where every node holds every key, that badge is the only thing
  // on the canvas that would change, so leaving it whole makes selecting a key
  // look like it did nothing at all.
  const counts = useMemo(
    () =>
      new Map(
        (state?.nodes ?? []).map((node) => [
          node.id,
          selectedKeyHash ? cellsForKey(state, node.id, selectedKeyHash).length : node.count,
        ]),
      ),
    [state, selectedKeyHash],
  );
  // Null rather than an empty set when no key is selected: the canvas reads a
  // set as "dim everything outside this", and with no lens nothing is outside.
  const lit = useMemo(
    () =>
      selectedKeyHash && read?.ok ? litNodeIds(state, read.dag, selectedKeyHash) : null,
    [state, read, selectedKeyHash],
  );
  // The state read is what resolves an id to a name, and the history lens shows
  // the same keys on the same page — so it borrows the resolution rather than
  // printing ids beside the selector's names.
  const names = useMemo(() => watchStateNames(state), [state]);

  if (loading) return html`<div class="debug-loading">Loading the definition…</div>`;
  if (error || !watch) {
    return html`<div class="debug-section">
      <${BackLink} />
      <div class="debug-error" role="alert">${error ?? "This watch could not be read."}</div>
    </div>`;
  }

  return html`<div class="debug-section watch-dag-view">
    <${BackLink} />
    <header class="watch-dag-header">
      <button
        type="button"
        class="watch-dag-header-button"
        onClick=${() => setSelection({ kind: "watch" })}
      >
        <span class="watch-dag-header-name">${installedWatchSummary(watch)}</span>
        <span class="watch-dag-header-sub">
          <code>${watch.name}</code> · ${installedWatchStatusLabel(watch.status)} · open the watch
        </span>
      </button>
    </header>
    ${watch.note
      ? html`<div class="privacy-banner warning">
          ${installedWatchStatusLabel(watch.status)}: ${watch.note}
        </div>`
      : null}
    ${read.ok
      ? html`
          <${WatchStateBar}
            state=${state}
            error=${stateError}
            loading=${stateLoading}
            selectedKeyHash=${selectedKeyHash}
            query=${keyQuery}
            onQuery=${setKeyQuery}
            onSelectKey=${setSelectedKeyHash}
            onRefresh=${refreshState}
            onOpenWatch=${() => setSelection({ kind: "watch" })}
          />
          <${WatchDagCanvas}
            layout=${layout}
            selectedId=${selection?.kind === "node" ? selection.id : null}
            counts=${counts}
            dimmed=${lit}
            verdicts=${history.verdicts}
            paneOpen=${selection !== null || history.path !== null}
            onSelect=${(id) => setSelection({ kind: "node", id })}
          />
          <${CanvasLegend} />
        `
      : html`<div class="watch-dag-unreadable">
          <div class="debug-error" role="alert">
            <strong>This definition cannot be drawn.</strong> ${read.reason}
          </div>
          <p class="watch-pane-note">
            The runtime stores a watch exactly as it was accepted, so what is below is what it is
            running — even where this page cannot make a graph of it.
          </p>
          <${WatchRawJson} value=${watch.dsl} />
        </div>`}
    ${seq !== null && !history.loading && !history.path
      ? html`<div class="privacy-banner warning">
          Event ${seq} is not on this page of the history — it is older than the events below, or
          the runtime never recorded it.
        </div>`
      : null}
    <${WatchHistoryList} lens=${history} names=${names} onSelect=${() => setSelection(null)} />
    ${selection === null && history.path
      ? html`<${WatchHistoryPane}
          path=${history.path}
          names=${names}
          lineage=${history.lineage}
          documents=${history.documents}
          exchanges=${history.exchanges}
          onClose=${() => navigate(watchDebugHref(watchId))}
        />`
      : html`<${WatchDagPane}
          selection=${selection}
          watch=${watch}
          dag=${read.ok ? read.dag : null}
          state=${state}
          selectedKeyHash=${selectedKeyHash}
          onSelectKey=${setSelectedKeyHash}
          onClose=${() => setSelection(null)}
        />`}
  </div>`;
}

function BackLink() {
  return html`<a
    class="doc-back"
    href=${WATCH_DEBUG_PATH}
    onClick=${(event) => {
      if (isModifiedClick(event)) return;
      event.preventDefault();
      navigate(WATCH_DEBUG_PATH);
    }}
  >← All watches</a>`;
}

/**
 * What the line styles mean. The three edge kinds carry different consequences
 * — an arm starts or advances a cell, a cancel kills one, a broadcast reaches
 * every live key at once — and none of that is guessable from a line.
 */
function CanvasLegend() {
  return html`<div class="watch-dag-legend">
    <span><i class="watch-dag-legend-line arm"></i>arm</span>
    <span><i class="watch-dag-legend-line cancel"></i>cancel</span>
    <span><i class="watch-dag-legend-line broadcast"></i>broadcast — reaches every live key</span>
    <span><i class="watch-dag-legend-line sink"></i>to the sink</span>
  </div>`;
}

function isModifiedClick(event) {
  return (
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
  );
}
