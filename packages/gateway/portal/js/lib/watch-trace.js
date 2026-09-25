// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch did, as the portal reads it.
 *
 * `GET /admin/watch/watches/:id/history` answers with one entry per journal
 * event — the path that event took through the graph, every node's verdict on
 * the way, and the ledger rows it produced. This turns that into the two things
 * a canvas and a pane need: a per-node chip to light a box with, and words for
 * a transition the runtime named in one.
 *
 * The vocabulary is mirrored from the runtime's own `TRANSITIONS` and
 * `FAILURE_CLASSES` tables, which the portal cannot import — it is served as
 * static ES modules with no bundler. Mirrored means it can drift, so a
 * transition this file has never heard of is rendered as itself rather than
 * dropped: an unknown verdict on a node is a fact worth seeing, and inventing a
 * friendly name for one would be worse than printing the runtime's word.
 *
 * Everything here takes raw JSON straight off the wire, so every reader is
 * defensive: a field of the wrong type reads as absent rather than throwing.
 */

import { WATCH_SINK_ID, isPlainObject } from "./watch-dsl.js";

/** The Watch debug tab, and one watch's canvas under it. */
export const WATCH_DEBUG_PATH = "/portal/debug/watch";

/**
 * How many events one read asks for.
 *
 * A page rather than a history: the list is a picker, and the answer carries a
 * decoded payload and every node verdict for each entry it holds.
 */
export const WATCH_HISTORY_PAGE = 50;

// ── Reading the response ────────────────────────────────────────────────────

/**
 * The history response as a list of paths, or an empty one when the payload is
 * not what this build expects.
 */
export function readWatchHistory(payload) {
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    paths: paths.map(readWatchPath).filter((path) => path !== null),
    // How much of the trace is still held, so the retention edge below is a
    // number a reader can see rather than a claim they have to take.
    retained: Number.isFinite(payload?.trace?.records) ? payload.trace.records : null,
    /**
     * Events the trace explains, and how many nothing took up.
     *
     * A gateway that does not report them answers zero, which renders as no
     * line at all — the same page it showed before this existed, rather than a
     * claim that nothing was declined.
     */
    events: {
      total: count(payload?.events?.total),
      untouched: count(payload?.events?.untouched),
      showingAll: payload?.events?.showing === "all",
      /**
       * How many declines this watch has produced in its life, against how many
       * the store still holds.
       *
       * The runtime keeps a bounded sample of them, so the rows are a sample
       * and this is the history. A page reporting the sample would say a watch
       * declined five things when it declined four thousand — and four thousand
       * with no firing is an arm too narrow to catch what it was written for.
       */
      declined: count(payload?.classes?.ignored),
    },
    /**
     * Which output fields carry a document, and the documents this page names.
     *
     * Static, from the watch's definition — the gateway computes it and this
     * only reads it. A surface holding a payload has a string and no way to
     * know whether it is a document, a person or a thread key, and the
     * alternative to carrying the answer is guessing from the field's name,
     * which renders a person id as a document that does not exist.
     *
     * A gateway that does not report it answers an empty lineage, which renders
     * exactly the page it rendered before this existed.
     */
    lineage: isPlainObject(payload?.lineage) ? payload.lineage : {},
    documents: isPlainObject(payload?.documents) ? payload.documents : {},
  };
}

function readWatchPath(raw) {
  if (!isPlainObject(raw) || !Number.isFinite(raw.seq)) return null;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  return {
    seq: raw.seq,
    at: typeof raw.at === "string" ? raw.at : null,
    // A negative sequence is a timer the runtime journaled for itself: this
    // event is a deadline elapsing rather than anything arriving.
    timer: raw.timer === true,
    traceRetained: raw.traceRetained !== false,
    outcome: typeof raw.outcome === "string" ? raw.outcome : "considered",
    forced: raw.forced === true,
    keys: Array.isArray(raw.keys) ? raw.keys.filter((key) => typeof key === "string") : [],
    nodes: nodes.filter(isPlainObject).map((node) => ({
      nodeId: typeof node.nodeId === "string" ? node.nodeId : "",
      key: typeof node.key === "string" ? node.key : "",
      verdict: typeof node.verdict === "string" ? node.verdict : "",
      detail: typeof node.detail === "string" ? node.detail : null,
      failure: typeof node.failure === "string" ? node.failure : null,
      steps: (Array.isArray(node.steps) ? node.steps : []).filter(isPlainObject).map((step) => ({
        transition: typeof step.transition === "string" ? step.transition : "",
        detail: typeof step.detail === "string" ? step.detail : null,
        failure: typeof step.failure === "string" ? step.failure : null,
      })),
    })),
    firings: (Array.isArray(raw.firings) ? raw.firings : []).filter(isPlainObject).map((firing) => ({
      nodeId: typeof firing.nodeId === "string" ? firing.nodeId : "",
      keyHash: typeof firing.keyHash === "string" ? firing.keyHash : "",
      firedAt: typeof firing.firedAt === "string" ? firing.firedAt : null,
      noticedAt: typeof firing.noticedAt === "string" ? firing.noticedAt : null,
      forced: firing.forced === true,
      documents: (Array.isArray(firing.documents) ? firing.documents : []).filter(isPlainObject),
      delivery: isPlainObject(firing.delivery) ? firing.delivery : null,
      payload: firing.payload,
    })),
  };
}

/** The path for one event, or null when nothing on the page is that event. */
export function findWatchPath(paths, seq) {
  if (!Number.isFinite(seq)) return null;
  return paths.find((path) => path.seq === seq) ?? null;
}

// ── Addressing one ──────────────────────────────────────────────────────────

/**
 * A watch's canvas, optionally with one event selected.
 *
 * The selection is in the path rather than in local state so that a firing in
 * the ledger can link straight to the moment it happened — which is the whole
 * reason this lens has a URL of its own.
 */
export function watchDebugHref(watchId, seq = null) {
  const canvas = `${WATCH_DEBUG_PATH}/${encodeURIComponent(watchId)}`;
  return seq === null || seq === undefined || !Number.isFinite(seq)
    ? canvas
    : `${canvas}/history/${encodeURIComponent(String(seq))}`;
}

// ── The runtime's vocabulary ────────────────────────────────────────────────

/**
 * What each transition means, mirroring the runtime's `TRANSITIONS`.
 *
 * `tone` is what the canvas colours a box by. It is deliberately coarser than
 * the transition — five outcomes a reader scanning a graph can tell apart at a
 * glance — while the label and meaning keep the runtime's own distinction.
 */
const TRANSITIONS = {
  armed: {
    label: "Armed",
    tone: "noted",
    meaning: "An arm input fired and opened a cell here.",
  },
  fired: {
    label: "Fired",
    tone: "fired",
    meaning: "Its condition held, and the signal went downstream.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "ended",
    meaning: "A cancel input ended the live cell before it could fire.",
  },
  expired: {
    label: "Expired",
    tone: "ended",
    meaning: "The deadline passed with the cell still waiting.",
  },
  reset: {
    label: "Restarted",
    tone: "noted",
    meaning: "A colliding arm restarted the lifecycle.",
  },
  ignored: {
    label: "Ignored",
    tone: "noted",
    meaning:
      "The event reached this node and it did not take it up — a colliding arm dropped while a"
      + " cell was already live, or a document no recall arm nominated.",
  },
  dropped: {
    label: "Dropped",
    tone: "ended",
    meaning: "The event arrived out of order: no live cell could take it, so it was discarded.",
  },
  accumulated: {
    label: "Accumulated",
    tone: "noted",
    meaning: "An arm fed a cell that outlives its firings and keeps taking arms.",
  },
  held: {
    label: "Held",
    tone: "held",
    meaning: "It evaluated and did not fire. The cell is still live.",
  },
  quarantined: {
    label: "Quarantined",
    tone: "failed",
    meaning: "The key could not be computed, so the arm was refused.",
  },
  failed: {
    label: "Failed",
    tone: "failed",
    meaning: "Evaluating this threw. The watch is paused; the run was not.",
  },
  refused: {
    label: "Refused",
    tone: "ended",
    meaning: "The node is already at its ceiling of live instances, so the spawn was refused.",
  },
  skipped: {
    label: "Skipped",
    tone: "noted",
    meaning: "An operator moved the watch past something it could not get through.",
  },
  suppressed: {
    label: "Suppressed",
    tone: "fired",
    meaning:
      "It fired and the notification did not go: the daily cap on how often this watch may"
      + " interrupt you was already spent.",
  },
  forced: {
    label: "By hand",
    tone: "fired",
    meaning:
      "An operator fired this watch by hand. Nothing was evaluated — only what happens after a"
      + " firing ran.",
  },
};

/**
 * The words for one transition. A transition this build has never heard of is
 * returned as itself, untoned, rather than as a guess.
 */
export function watchTransition(transition) {
  return (
    TRANSITIONS[transition] ?? {
      label: transition || "Unknown",
      tone: "noted",
      meaning: "This build does not recognise the transition, so it makes no claim about it.",
    }
  );
}

/**
 * What kind of thing went wrong, mirroring the runtime's `FAILURE_CLASSES`.
 *
 * A class beside a `held` is the difference between a judge that considered the
 * evidence and said no and one that never ran — and a shadow period measuring
 * precision would otherwise count the second as the first.
 */
const FAILURE_CLASSES = {
  query: {
    label: "query",
    meaning: "The watch's own analytics query would not bind, or would not run.",
  },
  provider: {
    label: "provider",
    meaning: "A judge or recall backend refused, timed out, or could not be reached.",
  },
  budget: {
    label: "budget",
    meaning: "This event needed more rounds of off-host answers than are allowed.",
  },
  internal: {
    label: "internal",
    meaning: "The runtime could not attribute it — a defect until proven otherwise.",
  },
};

/** The words for a failure class, or null when there is none. */
function watchFailureClass(failure) {
  if (typeof failure !== "string" || failure.length === 0) return null;
  return FAILURE_CLASSES[failure] ?? { label: failure, meaning: "An unrecognised failure class." };
}

/**
 * What one node's verdict means here, with the failure class folded in.
 *
 * A `held` carrying a class is not a judgement: the judge was over budget or
 * could not run, so the nomination is parked and will be asked again. Reporting
 * both as "Held" would make a model outage and a decision of no the same line.
 */
export function watchNodeVerdict(node) {
  const transition = watchTransition(node.verdict);
  const failure = watchFailureClass(node.failure);
  if (node.verdict === "held" && failure) {
    return {
      label: "Parked",
      tone: "held",
      meaning: `Parked, and will be asked again — ${failure.meaning}`,
      failure,
    };
  }
  return { ...transition, failure };
}

// ── Lighting the canvas ─────────────────────────────────────────────────────

/**
 * Which verdict wins when one node was evaluated under several keys at once.
 *
 * A broadcast arm re-judges every live cell at one tick, so a node can end that
 * moment armed under one key and failed under another. The box can carry one
 * chip, and it carries the one worth acting on.
 */
const TONE_RANK = { failed: 4, fired: 3, held: 2, ended: 1, noted: 0 };

/**
 * How much a verdict wants the box, when several compete for it.
 *
 * Tone decides, and a failure class breaks the tie inside one. A hold nothing
 * answered and a hold the judge reasoned its way to are both amber; only the
 * first is something an operator can do anything about, and a box reading
 * "Held" over a cell the budget parked would say the judge had decided when it
 * never ran.
 */
function verdictRank(verdict) {
  return (TONE_RANK[verdict.tone] ?? 0) * 2 + (verdict.failure ? 1 : 0);
}

/**
 * One trace key, with whatever ids in it are known by name.
 *
 * The runtime renders a key as `name=value` pairs joined by commas, and writes
 * that string to the trace — so what comes back here is display text, not the
 * components it was built from. Rather than parse it back apart, each pair's
 * value is looked up whole and swapped for its name when the directory knows
 * one. A value the lookup misses is left exactly as the runtime wrote it.
 *
 * `names` is what a state read resolved. It is empty when no state has loaded,
 * which renders the key the way the runtime wrote it — the honest fallback,
 * and the same thing it said before any of this.
 */
export function watchKeyDisplay(key, names = null) {
  if (typeof key !== "string" || key === "" || !names || names.size === 0) return key;
  return key
    .split(",")
    .map((pair) => {
      const at = pair.indexOf("=");
      if (at === -1) return pair;
      const value = pair.slice(at + 1);
      const display = names.get(value);
      return display ? `${pair.slice(0, at)}=${display}` : pair;
    })
    .join(",");
}

/**
 * A chip per node, for the canvas to wear.
 *
 * Keyed by node id, because that is what the canvas has. A node the event never
 * touched is absent, which is what lets the canvas dim it — a path is as much
 * about where the signal did not go as where it did.
 */
export function watchPathVerdicts(path) {
  const chips = new Map();
  for (const node of path?.nodes ?? []) {
    const verdict = watchNodeVerdict(node);
    const chip = chips.get(node.nodeId);
    if (!chip) {
      chips.set(node.nodeId, {
        label: verdict.label,
        tone: verdict.tone,
        rank: verdictRank(verdict),
        cells: [{ key: node.key, verdict, detail: node.detail }],
      });
      continue;
    }
    chip.cells.push({ key: node.key, verdict, detail: node.detail });
    if (verdictRank(verdict) > chip.rank) {
      chip.label = verdict.label;
      chip.tone = verdict.tone;
      chip.rank = verdictRank(verdict);
    }
  }
  // The count is the point on a keyed watch: a box reading "Held" over three
  // cells and one reading "Held" over one are different situations.
  for (const chip of chips.values()) {
    chip.title = chip.cells
      .map(({ key, verdict, detail }) =>
        `${key}: ${verdict.label}${detail ? ` — ${detail}` : ""}`)
      .join("\n");
    if (chip.cells.length > 1) chip.label = `${chip.label} ·${chip.cells.length}`;
  }

  // The sink is drawn by the portal, not declared by the watch, so the runtime
  // never records a transition against it and it would dim on every path — the
  // box that stands for delivery greyed out as unreached on exactly the events
  // that reached it. What happened there is the firing's delivery outcome.
  //
  // Not for a firing whose trace has rolled off, though the delivery outcome
  // survives: one lit box on an otherwise dim canvas reads as a path, and this
  // is the case where there is no path to show. Nothing lit is the true answer,
  // and the pane says so in words.
  if (path?.traceRetained !== false && path?.firings?.length > 0) {
    const delivery = watchPathDelivery(path);
    chips.set(WATCH_SINK_ID, {
      label: DELIVERY_LABELS[delivery].label,
      tone: DELIVERY_LABELS[delivery].tone,
      rank: 0,
      cells: [],
      title: DELIVERY_LABELS[delivery].meaning,
    });
  }
  return chips;
}

const DELIVERY_LABELS = {
  delivered: { label: "Delivered", tone: "fired", meaning: "The firing reached where it was sent." },
  undelivered: {
    label: "Not delivered",
    tone: "held",
    meaning: "The watch fired and nothing arrived. The firing is recorded either way.",
  },
  recorded: {
    label: "Recorded",
    // Neutral rather than the firing colour. No delivery was *recorded*, which
    // is what a watch with no delivery block looks like — and equally what a
    // watch whose channel was never wired looks like. Naming one of those as
    // the cause would be a guess, and colouring it as success would make the
    // second read as the first.
    tone: "noted",
    meaning:
      "The firing is recorded and no delivery was attempted for it. A watch with no delivery"
      + " block tells nobody; so does one whose channel is not wired.",
  },
};

/**
 * Whether a firing on this event reached anybody.
 *
 * A firing the daily cap dropped has no delivery row at all — the runtime
 * records the cap as a `suppressed` transition and never gets as far as an
 * outcome — so reading `delivered === 0` alone would report the one firing a
 * person was deliberately not told about as one that went out fine.
 */
export function watchPathDelivery(path) {
  const suppressed = (path.nodes ?? []).some((node) =>
    node.steps.some((step) => step.transition === "suppressed"),
  );
  if (suppressed) return "undelivered";
  const outcomes = (path.firings ?? []).map((firing) => firing.delivery).filter(Boolean);
  if (outcomes.length === 0) return "recorded";
  return outcomes.some((delivery) => delivery.delivered > 0) ? "delivered" : "undelivered";
}

// ── Reading one event ───────────────────────────────────────────────────────

/**
 * The one line a picker row carries: what the event was, and how it ended.
 *
 * A firing says so plainly, because that is what a reader is scanning for. An
 * event that decided nothing is named by the verdict that ended it, since "why
 * didn't it fire" is answered by the node that held rather than by the fact
 * that nothing happened.
 */
export function watchPathSummary(path) {
  if (!path.traceRetained) return "Trace no longer retained";
  if (path.forced) return "Fired by hand";
  if (path.outcome === "fired") {
    return watchPathDelivery(path) === "undelivered" ? "Fired — not delivered" : "Fired";
  }
  if (path.outcome === "failed") {
    const failed = path.nodes.find((node) => node.verdict === "failed");
    const failure = watchFailureClass(failed?.failure);
    return failure ? `Failed — ${failure.label}` : "Failed";
  }
  const decisive = decisiveNode(path);
  if (!decisive) return "Considered";
  const verdict = watchNodeVerdict(decisive);
  return `${verdict.label} at ${decisive.nodeId}`;
}

/**
 * The colour that event wears, which is the outcome rather than any one node's
 * verdict — the same reading {@link watchPathSummary} puts into words, so the
 * two can never disagree about whether something fired.
 */
export function watchPathTone(path) {
  if (!path.traceRetained) return "noted";
  if (path.outcome === "fired") return "fired";
  if (path.outcome === "failed") return "failed";
  const decisive = decisiveNode(path);
  return decisive ? watchNodeVerdict(decisive).tone : "noted";
}

/**
 * The node that ended this event, for a reader asking why nothing happened.
 *
 * The last one whose verdict was more than bookkeeping. An event whose every
 * record is an `armed` has no such node, and saying "Considered" about it is
 * the honest answer: nothing decided anything, the cells are simply live.
 *
 * A node that *fired* is never it. On an event that did not fire, a firing
 * node is one the signal passed through on its way to wherever it stopped —
 * every event that matches a source node at all begins with that node firing.
 * Naming one would put the word "Fired" on a row that did nothing, which is
 * the one distinction this whole list exists to draw.
 */
function decisiveNode(path) {
  let found = null;
  for (const node of path.nodes) {
    const { tone } = watchNodeVerdict(node);
    if (tone !== "noted" && tone !== "fired") found = node;
  }
  return found;
}
