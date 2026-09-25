// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The state lens: what the runtime is holding, on the definition canvas.
 *
 * The canvas draws the watch once; state is always seen through one of two
 * framings, and this renders both. With no key selected every node wears its
 * cell count. With a key selected the canvas dims to that key's slice and each
 * node shows *that* cell — which is the only framing that can be honest, because
 * two nodes in one watch may key differently and "the instances of this watch"
 * is therefore not a list that exists.
 *
 * Everything comes from one snapshot, stated in the header, and the page
 * refreshes it on demand rather than tailing it. That is deliberate: a canvas
 * whose parts arrived at different moments would show a cell that has since
 * fired beside a timer that has already swept it, and no reader could tell which
 * half was stale.
 *
 * Cells are drawn per node type rather than dumped. A wait is a countdown, a
 * join is a set of arms with holes in it, an accumulator is a count against a
 * floor — printing the same field table for all three would leave the reader
 * doing the interpretation the runtime already did.
 */

import { html } from "htm/preact";

import {
  cellsForKey,
  filterWatchStateKeys,
  keyDisplayLabel,
  spanProgress,
  watchStateKeyGroups,
} from "../../lib/watch-state.js";
import { DocChip } from "../../components/doc-chip.js";
import { formatPrivacyDate, formatPrivacyRelativeDate } from "../shared/privacy-vocabulary.js";
import { watchInstant } from "../watches/vocabulary.js";

/**
 * What each arm of a join or a sequence actually arrived on.
 *
 * "1 of 2 arrived" is the shape of the answer, not the answer. A reader looking
 * at a half-satisfied cell is asking when the first step happened and what
 * satisfied it — and the cell has known both all along, in the sequence it was
 * armed by and the document that signal carried.
 *
 * The document renders as the same chip a firing's evidence does, so the thing
 * a cell is waiting on and the thing a firing cited read alike and open alike.
 * An arm with neither — a clock, a row, an event long pruned — is left out
 * rather than given an empty line.
 */
function Arrivals({ arrived }) {
  const known = (arrived ?? []).filter((arm) => arm.at || arm.document);
  if (known.length === 0) return null;
  return html`<ul class="watch-arrival-list">
    ${known.map(
      (arm) => html`<li key=${arm.from} class="watch-arrival">
        <code class="watch-arrival-arm">${arm.from}</code>
        ${arm.at ? html`<span class="watch-arrival-when">${formatPrivacyDate(watchInstant(arm.at))}</span>` : null}
        ${arm.document
          ? html`<${DocChip}
              documentId=${arm.document.id}
              title=${arm.document.title}
              sourceId=${arm.document.sourceId}
            />`
          : null}
      </li>`,
    )}
  </ul>`;
}

/**
 * The strip above the canvas: which moment this is, and the key lens.
 *
 * The moment is stated rather than implied. Every badge, bar and list below it
 * belongs to that one journal event, and a page that showed live-looking state
 * with no instant on it would invite the reader to trust it as current when it
 * is as old as their last refresh.
 */
export function WatchStateBar({
  state,
  error,
  loading,
  selectedKeyHash,
  query,
  onQuery,
  onSelectKey,
  onRefresh,
  onOpenWatch,
}) {
  const groups = watchStateKeyGroups(state);
  const total = groups.reduce((sum, group) => sum + group.keys.length, 0);
  return html`<div class="watch-state-bar">
    <div class="watch-state-asof">
      <span class="watch-state-asof-text"><${AsOf} state=${state} error=${error} /></span>
      <button type="button" class="btn-tiny" onClick=${onRefresh} disabled=${loading === true}>
        ${loading ? "refreshing…" : "refresh"}
      </button>
    </div>
    ${error ? html`<div class="debug-error" role="alert">${error}</div>` : null}
    ${state
      ? html`<div class="watch-state-summary">
          ${state.empty
            ? html`<span class="watch-pane-dim"
                >Nothing live: no cell, no armed timer, no parked nomination. Every node below is
                waiting to be armed.</span
              >`
            : html`
                <span>${total} live ${total === 1 ? "key" : "keys"}</span>
                <button type="button" class="watch-state-link" onClick=${onOpenWatch}>
                  ${`${state.timers.length} armed ${state.timers.length === 1 ? "timer" : "timers"}`}${state
                    .parked.length > 0
                    ? ` · ${state.parked.length} parked`
                    : ""}
                </button>
              `}
        </div>`
      : null}
    ${total > 0
      ? html`<${KeySelector}
          groups=${groups}
          selectedKeyHash=${selectedKeyHash}
          query=${query}
          onQuery=${onQuery}
          onSelectKey=${onSelectKey}
        />`
      : null}
  </div>`;
}

/**
 * The one moment everything on the page belongs to.
 *
 * The prose is interpolated rather than written as markup text: htm discards
 * whitespace that spans a newline, so a sentence broken across lines around an
 * element loses the spaces at the break — and "journal seq" running straight
 * into its own number is the reading this line exists to give.
 */
function AsOf({ state, error }) {
  if (error) return "State could not be read";
  if (!state?.asOf.at) return "Reading the runtime…";
  const behind =
    state.asOf.journalHead === null ? 0 : Math.max(0, state.asOf.journalHead - state.asOf.seq);
  return html`<span
    >${`state as of ${formatPrivacyDate(watchInstant(state.asOf.at))} · journal seq `}<strong
      >${state.asOf.seq}</strong
    >${behind > 0
      ? html`<span
          class="watch-state-behind"
          title="The producer has written further than this watch has read."
          >${` · ${behind} behind the journal head`}</span
        >`
      : null}</span
  >`;
}

/**
 * The keys live across the watch, grouped by shape and searchable.
 *
 * Grouped because keys of different shapes are not alternatives: `(person, day)`
 * and `order_id` address different populations, and one flat alphabetical list
 * of both reads as though picking either answered the same question.
 */
function KeySelector({ groups, selectedKeyHash, query, onQuery, onSelectKey }) {
  const matching = filterWatchStateKeys(groups, query);
  return html`<div class="watch-key-lens">
    <div class="watch-key-lens-head">
      <input
        type="search"
        class="watch-key-search"
        placeholder="Filter keys by name or id…"
        value=${query ?? ""}
        onInput=${(event) => onQuery(event.currentTarget.value)}
      />
      ${selectedKeyHash
        ? html`<button type="button" class="btn-tiny" onClick=${() => onSelectKey(null)}>
            clear lens
          </button>`
        : null}
    </div>
    ${matching.length === 0
      ? html`<p class="privacy-empty">No live key matches that.</p>`
      : matching.map(
          (group) => html`<div class="watch-key-group" key=${group.shape}>
            <span class="watch-key-shape" title="The key's component names, in order.">
              ${group.shape}
            </span>
            <div class="watch-key-chips">
              ${group.keys.map(
                (key) => html`<button
                  type="button"
                  key=${key.keyHash}
                  class=${`watch-key-chip ${key.keyHash === selectedKeyHash ? "is-selected" : ""}`.trim()}
                  aria-pressed=${key.keyHash === selectedKeyHash}
                  title=${rawKeyTitle(key)}
                  onClick=${() =>
                    onSelectKey(key.keyHash === selectedKeyHash ? null : key.keyHash)}
                >
                  ${keyDisplayLabel(key)}
                  <span class="watch-key-chip-count">${key.cells}</span>
                </button>`,
              )}
            </div>
          </div>`,
        )}
  </div>`;
}

/** The raw components behind a resolved name, for the chip's hover. */
function rawKeyTitle(key) {
  const lines = key.components.map((component) =>
    component.display
      ? `${component.name} = ${component.display} (${component.raw})`
      : `${component.name} = ${component.raw}`,
  );
  lines.push(`held by ${key.nodeIds.join(", ")}`);
  return lines.join("\n");
}

// ── One node's population, in the pane ──────────────────────────────────────

/**
 * What one node is holding: its cells for the selected key, or all of them.
 *
 * With a key selected this is the slice — usually one cell, several under
 * `spawn`. Without one it is the whole population, which is what answers "what
 * is this node actually waiting on" for a watch nobody has picked a key in yet.
 */
export function WatchNodeStateSection({ node, state, selectedKeyHash }) {
  const held = state?.byNodeId.get(node.id);
  if (!state || !held) return null;
  const cells = selectedKeyHash ? cellsForKey(state, node.id, selectedKeyHash) : held.instances;
  return html`<section class="watch-pane-section">
    <h4>State ${selectedKeyHash ? "· this key" : ""}</h4>
    <${SpawnCeiling} node=${held} cells=${cells} selectedKeyHash=${selectedKeyHash} />
    ${cells.length === 0
      ? html`<p class="privacy-empty">
          ${selectedKeyHash
            ? "No cell here for the selected key — this node is not part of that slice."
            : "This node holds nothing right now."}
        </p>`
      : html`<ul class="watch-cell-list">
          ${cells.map(
            (cell) => html`<li key=${`${cell.keyHash}:${cell.instance}`} class="watch-cell">
              <div class="watch-cell-head">
                <code class="watch-cell-key" title=${cell.label}>${cellKeyText(cell)}</code>
                ${held.maxLiveInstances !== null || cell.instance > 0
                  ? html`<span class="watch-cell-instance">#${cell.instance}</span>`
                  : null}
                <span class="watch-cell-state">${cell.state}</span>
              </div>
              <${CellDetail} cell=${cell} node=${held} />
            </li>`,
          )}
        </ul>`}
    ${held.cancelledBy.length > 0
      ? html`<p class="watch-pane-note">
          Cancelled by an arrival on ${held.cancelledBy.map((id) => `\`${id}\``).join(" or ")}.
        </p>`
      : null}
  </section>`;
}

/** `spawn` opens parallel instances under one key; the cap bounds how many. */
function SpawnCeiling({ node, cells, selectedKeyHash }) {
  if (node.onCollision !== "spawn") return null;
  // Only meaningful per key: the cap is per key, so counting a whole
  // multi-key population against it would report a ceiling nothing has hit.
  const live = selectedKeyHash ? cells.length : null;
  return html`<p class="watch-pane-note">
    ${node.maxLiveInstances === null
      ? "Spawns a parallel instance per arm, with no ceiling."
      : live === null
        ? `Spawns up to ${node.maxLiveInstances} parallel instances per key.`
        : `${live} of ${node.maxLiveInstances} live instances under this key${
            live >= node.maxLiveInstances ? " — at the ceiling, so a further arm is dropped." : "."
          }`}
  </p>`;
}

function cellKeyText(cell) {
  if (cell.components.length === 0) return cell.label;
  return cell.components
    .map((component) => `${component.name}=${component.display ?? component.raw}`)
    .join(", ");
}

/** The cell as its own node type means it. */
function CellDetail({ cell, node }) {
  switch (cell.detail.kind) {
    case "wait":
      return html`<${Countdown}
        fromIso=${cell.armedAt}
        toIso=${cell.detail.firesAt}
        fromLabel="armed"
        toLabel="fires"
      />`;

    case "join": {
      const detail = cell.detail;
      return html`
        <p class="watch-cell-line">
          ${detail.arrived.length} of ${detail.required} arms arrived${detail.of !== detail.required
            ? ` (of ${detail.of} declared)`
            : ""}
        </p>
        <div class="watch-arm-row">
          ${detail.arrived.map(
            (arm) => html`<span
              key=${arm.from}
              class="watch-arm is-arrived"
              title=${`arrived at journal event ${arm.seq}`}
            >
              ${arm.from}
            </span>`,
          )}
          ${detail.outstanding.map(
            (from) => html`<span key=${from} class="watch-arm is-outstanding">${from}</span>`,
          )}
        </div>
        <${Arrivals} arrived=${detail.arrived} />
        <${Countdown}
          fromIso=${cell.armedAt}
          toIso=${cell.deadlineAt}
          fromLabel="armed"
          toLabel="expires"
        />
      `;
    }

    case "sequence": {
      const detail = cell.detail;
      return html`
        <p class="watch-cell-line">
          step ${detail.step}/${detail.of}${detail.arrived.length > 0
            ? ` — saw ${detail.arrived.map((arm) => arm.from).join(" → ")}`
            : ""}${detail.nextExpected
            ? `, waiting for ${detail.nextExpected}`
            : ", every step filled"}
        </p>
        <${Arrivals} arrived=${detail.arrived} />
        ${detail.nextExpected
          ? html`<p class="watch-pane-note">
              Anything but <code>${detail.nextExpected}</code> arriving next is dropped — an
              ordered gate that stashed an early arrival would be an unordered one.
            </p>`
          : null}
        <${Countdown}
          fromIso=${cell.armedAt}
          toIso=${cell.deadlineAt}
          fromLabel="armed"
          toLabel="expires"
        />
      `;
    }

    case "cooldown":
      return html`
        <p class="watch-cell-line">
          ${cell.detail.suppressingUntil
            ? `quiet until ${formatPrivacyDate(watchInstant(cell.detail.suppressingUntil))}`
            : `has not fired yet — the next arm goes straight through`}
        </p>
        <${Countdown}
          fromIso=${cell.lastFiredAt}
          toIso=${cell.detail.suppressingUntil}
          fromLabel="last fired"
          toLabel="free again"
        />
        <p class="watch-pane-note">At most once every ${cell.detail.minInterval}.</p>
      `;

    case "persistence":
      return html`
        <p class="watch-cell-line">
          ${cell.detail.count} of ${cell.detail.required} arms inside ${cell.detail.window}
        </p>
        <${Meter} fraction=${cell.detail.required > 0 ? cell.detail.count / cell.detail.required : 0} />
        ${cell.detail.oldestArrivalAt
          ? html`<p class="watch-pane-note">
              Oldest arm still counting: ${formatPrivacyDate(
                watchInstant(cell.detail.oldestArrivalAt),
              )}. It leaves the window before the others.
            </p>`
          : null}
      `;

    case "sql":
      return html`
        <p class="watch-cell-line">
          predicate ${cell.detail.level === null
            ? "not yet observed"
            : cell.detail.level
              ? "holding"
              : "not holding"}
        </p>
        ${cell.detail.persistence
          ? html`<${Countdown}
              fromIso=${cell.detail.heldSince}
              toIso=${cell.detail.satisfiedAt}
              fromLabel="holding since"
              toLabel=${`holds ${cell.detail.persistence}`}
            />`
          : null}
        <${Countdown}
          fromIso=${cell.armedAt}
          toIso=${cell.deadlineAt}
          fromLabel="armed"
          toLabel="expires"
        />
      `;

    case "llm":
      return html`
        <p class="watch-cell-line">deliberating (${cell.detail.mode})</p>
        <${Countdown}
          fromIso=${cell.armedAt}
          toIso=${cell.deadlineAt}
          fromLabel="armed"
          toLabel="expires"
        />
      `;

    default:
      return html`<p class="watch-pane-note">
        This build has no reading for a <code>${node.type}</code> cell, so only its own instants are
        shown above.
      </p>`;
  }
}

/**
 * A span with a now-marker: armed at one end, due at the other.
 *
 * Drawn only when both ends are readable and the span has length — a bar with
 * nothing to measure against would be decoration, and a full one would read as
 * "about to happen" when the truth is "we cannot say".
 */
function Countdown({ fromIso, toIso, fromLabel, toLabel }) {
  const fraction = spanProgress(fromIso, toIso);
  if (fraction === null) return null;
  return html`<div class="watch-countdown">
    <div class="watch-countdown-track">
      <div class="watch-countdown-fill" style=${`width:${(fraction * 100).toFixed(1)}%`}></div>
      <div class="watch-countdown-now" style=${`left:${(fraction * 100).toFixed(1)}%`}></div>
    </div>
    <div class="watch-countdown-ends">
      <span>${fromLabel} ${formatPrivacyDate(watchInstant(fromIso))}</span>
      <span>${toLabel} ${formatPrivacyRelativeDate(watchInstant(toIso))}</span>
    </div>
  </div>`;
}

/** A count against a floor, for a node that accumulates rather than waits. */
function Meter({ fraction }) {
  const width = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return html`<div class="watch-countdown-track is-meter">
    <div class="watch-countdown-fill" style=${`width:${(width * 100).toFixed(1)}%`}></div>
  </div>`;
}

// ── The watch as a whole, in the pane ───────────────────────────────────────

/**
 * What this watch will do next unprompted, and what it is stuck on.
 *
 * The canvas answers "what is armed" a node at a time; this answers it for the
 * watch, soonest first, because "when does this next act on its own" is the
 * question a reader arrives with and one that a graph makes them assemble.
 */
export function WatchWatchStateSection({ state, onSelectKey }) {
  if (!state) return null;
  return html`
    <section class="watch-pane-section">
      <h4>Upcoming</h4>
      ${state.timers.length === 0
        ? html`<p class="privacy-empty">
            Nothing is armed, so this watch will do nothing until something arrives for it.
          </p>`
        : html`<ul class="watch-timer-list">
            ${state.timers.map(
              (timer) => html`<li
                key=${`${timer.nodeId}:${timer.keyHash}:${timer.instance}:${timer.kind}`}
                class=${`watch-timer ${timer.overdue ? "is-overdue" : ""}`.trim()}
              >
                <span class="watch-timer-when">
                  ${formatPrivacyRelativeDate(watchInstant(timer.dueAt))}
                </span>
                <span class="watch-timer-what">
                  <code>${timer.nodeId}</code> · ${timer.kind}
                  ${timer.components.length > 0
                    ? html`<button
                        type="button"
                        class="watch-state-link watch-key-ref"
                        onClick=${() => onSelectKey(timer.keyHash)}
                      >
                        ${timer.components
                          .map((c) => `${c.name}=${c.display ?? c.raw}`)
                          .join(", ")}
                      </button>`
                    : null}
                </span>
                ${timer.overdue
                  ? html`<span
                      class="watch-timer-flag"
                      title="Due, but timers are only swept by an evaluation pass — it fires on the next tick."
                      >due, not yet swept</span
                    >`
                  : null}
              </li>`,
            )}
          </ul>`}
    </section>
    <section class="watch-pane-section">
      <h4>Judge</h4>
      ${state.judge
        ? html`<p class="watch-cell-line">
            ${state.judge.watchSpentToday ?? 0} of ${state.judge.perWatchDailyCap} calls today for
            this watch · ${state.judge.spentToday ?? 0} of ${state.judge.dailyCap} across the
            install
          </p>`
        : null}
      ${state.parked.length === 0
        ? html`<p class="privacy-empty">Nothing is parked: every nomination has been answered.</p>`
        : html`
            <p class="watch-pane-note">
              Nominations the judge could not answer. They are not declined — the queue drains in
              journal order once the budget allows, or once the backend is reachable again.
            </p>
            <ul class="watch-pane-list">
              ${state.parked.map(
                (nomination) => html`<li key=${`${nomination.nodeId}:${nomination.docId}`}>
                  <code>${nomination.nodeId}</code>
                  <span class=${`watch-parked-class ${nomination.failure ?? "unknown"}`}>
                    ${nomination.failure ?? "class no longer in the trace"}
                  </span>
                  <p class="watch-pane-note">
                    ${`journal event ${nomination.seq} · ${formatPrivacyDate(
                      watchInstant(nomination.at),
                    )}`}
                  </p>
                </li>`,
              )}
            </ul>
          `}
    </section>
  `;
}
