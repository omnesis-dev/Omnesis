// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the runtime is holding for one watch, right now, as a reader can use it.
 *
 * The state store keeps cells in the shape the engine writes them: `slots`,
 * `arrivals`, `level`, `heldSinceMs`, a `deadlineAtMs` that means the fire time
 * on one node type and the give-up time on another. Reading that raw requires
 * knowing which field each node type uses and what it uses it for, which is
 * precisely the knowledge a debugging surface should not have to reproduce. So
 * the reading happens here, next to the engine that writes it, and what comes
 * out says `3 of 4 arms arrived` rather than `slots: {…}`.
 *
 * A "watch instance" is not a thing this can return: each stateful node owns its
 * own population of keyed cells, and two nodes may key differently, so the
 * snapshot is per node — a population apiece, each cell carrying its own raw key
 * components. Whoever is looking joins them by key if they want to.
 *
 * **One moment, not several.** The cursor commits in the same transaction as the
 * cell, timer and nomination changes an event caused, so reading all four
 * together outside a transaction of the engine's own yields a set that was true
 * at one commit boundary — and {@link WatchStateSnapshot.asOfSeq} is the journal
 * event that boundary followed. A caller that shares its connection with a
 * running engine has to read this while the engine is between events; the
 * gateway does that by taking its write-lease turn.
 *
 * Read-only throughout: nothing here writes, and nothing decides anything the
 * engine will act on.
 */

import { nodeInputs, type WatchDefinition, type WatchNode } from "../dsl/schema.js";
import { durationMs, parseDuration } from "../time/duration.js";

import type { NodeCell, TimerRow, WatchStateStore } from "./state.js";

/** Everything the runtime holds for one watch, cut at one commit boundary. */
export interface WatchStateSnapshot {
  /**
   * The journal event this watch's state has been evaluated through.
   *
   * The consumer cursor, not the journal head: the head is what the producer has
   * written, and a watch catching up is legitimately behind it. This is the seq
   * every cell, timer and parked nomination below is consistent with.
   */
  readonly asOfSeq: number;
  /** One entry per declared node, in declaration order, cells or not. */
  readonly nodes: readonly WatchNodeState[];
  /** Every armed timer on the watch, soonest first. */
  readonly timers: readonly WatchArmedTimer[];
  /** Nominations waiting on judge budget, oldest first. */
  readonly parked: readonly WatchParkedNomination[];
}

/** One node's live population. */
export interface WatchNodeState {
  readonly nodeId: string;
  readonly type: WatchNode["type"];
  /** What a second arm on a live key does. Absent where the DSL leaves it out. */
  readonly onCollision: string | null;
  /** The ceiling `spawn` is bounded by, or null for an unbounded node. */
  readonly maxLiveInstances: number | null;
  /** The upstream nodes whose arrival kills a live cell here. */
  readonly cancelledBy: readonly string[];
  /** Live cells, by key and then by instance. */
  readonly cells: readonly WatchCellState[];
}

/** One live cell: which key-instance it is, and what it is waiting for. */
export interface WatchCellState {
  readonly keyHash: string;
  readonly instance: number;
  /** The key's raw components, as the engine computed them. */
  readonly key: Readonly<Record<string, unknown>>;
  readonly state: "live" | "accumulating";
  readonly armedAtMs: number;
  readonly deadlineAtMs: number | null;
  readonly lastFiredAtMs: number | null;
  /** What this cell holds, read for the node type that wrote it. */
  readonly detail: WatchCellDetail;
}

/**
 * A cell as its own node type means it.
 *
 * `opaque` is the honest answer for a node type that holds a cell this reader
 * has no special reading for — the cell's own timestamps still apply, and
 * inventing a shape for it would be worse than saying nothing.
 */
/**
 * One arm that has arrived at a join or a sequence.
 *
 * The sequence is the journal event that satisfied it, which is what a reader
 * uses to find the moment; the document is what it fired on, when it fired on
 * one. A time source or a row-driven arm has no document, and says so by
 * omitting it rather than by carrying an empty string.
 */
export interface ArrivedArm {
  readonly from: string;
  readonly seq: number;
  readonly documentId?: string;
}

export type WatchCellDetail =
  | {
      readonly kind: "wait";
      /** When this cell fires. A wait's deadline *is* its fire. */
      readonly firesAtMs: number | null;
    }
  | {
      readonly kind: "join";
      /** The arms that have arrived, in the node's own input order. */
      readonly arrived: readonly ArrivedArm[];
      readonly outstanding: readonly string[];
      /** How many arms complete it: `n` for a threshold, all of them otherwise. */
      readonly required: number;
      /** How many arms it has to draw from. */
      readonly of: number;
    }
  | {
      readonly kind: "sequence";
      /** How many steps of `order` are filled. */
      readonly step: number;
      readonly of: number;
      readonly arrived: readonly ArrivedArm[];
      /** The only arrival that advances it; anything else is dropped. */
      readonly nextExpected: string | null;
    }
  | {
      readonly kind: "cooldown";
      /** Nothing fires on this key before this instant. */
      readonly suppressingUntilMs: number | null;
      readonly minInterval: string;
    }
  | {
      readonly kind: "persistence";
      /** Arms inside the window, which is what `min_events` is compared to. */
      readonly count: number;
      readonly required: number;
      readonly window: string;
      readonly windowMs: number;
      /** The oldest arm still inside the window, or null when there are none. */
      readonly oldestArrivalAtMs: number | null;
    }
  | {
      readonly kind: "sql";
      /** The last boolean observed, which a rising edge is measured against. */
      readonly level: boolean | null;
      /** When the predicate became true; cleared when it lapses. */
      readonly heldSinceMs: number | null;
      /** When persistence is satisfied, or null when the node declares none. */
      readonly satisfiedAtMs: number | null;
      readonly persistence: string | null;
    }
  | {
      readonly kind: "llm";
      readonly mode: string;
    }
  | { readonly kind: "opaque" };

/** A timer the runtime will act on unprompted. */
export interface WatchArmedTimer {
  readonly nodeId: string;
  readonly keyHash: string;
  readonly instance: number;
  readonly key: Readonly<Record<string, unknown>>;
  readonly kind: TimerRow["kind"];
  readonly dueAtMs: number;
}

/** A nomination the judge could not afford, waiting to be asked again. */
export interface WatchParkedNomination {
  readonly nodeId: string;
  readonly docId: string;
  /** The journal event that nominated it, and the order the queue drains in. */
  readonly seq: number;
  readonly atMs: number;
}

export interface ReadWatchStateOptions {
  readonly watch: WatchDefinition;
  /** The identity the state is kept under — the host's watch id, not the name. */
  readonly watchId: string;
  readonly store: WatchStateStore;
  /** How many parked nominations to return. They drain oldest first. */
  readonly parkedLimit: number;
}

/**
 * Read one watch's live state out of the store.
 *
 * Every declared node gets an entry whether or not it holds anything, because
 * "this node holds nothing" is an answer and a missing entry is not. Cells are
 * enumerated from the store rather than from a table of which types are
 * stateful: the store is what actually has them, and a node type whose
 * statefulness depends on its own fields would otherwise be read through a
 * predicate that has to be kept in step with the engine.
 */
export function readWatchState(options: ReadWatchStateOptions): WatchStateSnapshot {
  const { watch, watchId, store } = options;
  const nodes = watch.nodes.map((node) => readNode(node, watchId, store));
  return {
    // Read last, so it is never ahead of the cells above it: within one commit
    // boundary the order does not matter, and outside one this is the
    // conservative direction — a cursor behind the cells describes state the
    // runtime has already reached, where the reverse would claim state it has
    // not yet computed.
    asOfSeq: store.cursor(watchId),
    nodes,
    timers: store
      // Everything armed, not merely everything overdue: the question is what
      // this watch will do next without being asked, and that is the whole set.
      .dueTimers(watchId, Number.MAX_SAFE_INTEGER)
      .map((timer) => ({
        nodeId: timer.nodeId,
        keyHash: timer.keyHash,
        instance: timer.instance,
        key: timer.key,
        kind: timer.kind,
        dueAtMs: timer.dueAtMs,
      })),
    parked: store.pendingNominations(watchId, options.parkedLimit),
  };
}

function readNode(node: WatchNode, watchId: string, store: WatchStateStore): WatchNodeState {
  const inputs = nodeInputs(node);
  const cells = [...store.cellsFor(watchId, node.id)].sort(
    (a, b) =>
      (a.keyHash < b.keyHash ? -1 : a.keyHash > b.keyHash ? 1 : 0) || a.instance - b.instance,
  );
  return {
    nodeId: node.id,
    type: node.type,
    onCollision: "on_collision" in node && node.on_collision ? node.on_collision : null,
    maxLiveInstances:
      "max_live_instances" in node && node.max_live_instances !== undefined
        ? node.max_live_instances
        : null,
    cancelledBy: Object.entries(inputs)
      .filter(([, input]) => input.role === "cancel")
      .map(([from]) => from),
    cells: cells.map((cell) => ({
      keyHash: cell.keyHash,
      instance: cell.instance,
      key: cell.key,
      state: cell.state,
      armedAtMs: cell.armedAtMs,
      deadlineAtMs: cell.deadlineAtMs,
      lastFiredAtMs: cell.lastFiredAtMs,
      detail: readDetail(node, cell),
    })),
  };
}

function readDetail(node: WatchNode, cell: NodeCell): WatchCellDetail {
  switch (node.type) {
    case "stateful.wait":
      // The wait is the deadline: the engine stores one instant and expiring it
      // is the fire, so naming it `firesAtMs` is not a rename but the meaning.
      return { kind: "wait", firesAtMs: cell.deadlineAtMs };

    case "stateful.and":
    case "stateful.threshold": {
      const arms = armInputs(node);
      return {
        kind: "join",
        arrived: arrivals(arms, cell),
        outstanding: arms.filter((from) => cell.slots[from] === undefined),
        required: node.type === "stateful.threshold" ? node.n : arms.length,
        of: arms.length,
      };
    }

    case "stateful.sequence": {
      // Only the arm inputs can occupy a step. A broadcast input may be named in
      // `order`, but a broadcast never fills a slot, so counting one would leave
      // the expected position permanently ahead of what has arrived.
      const arms = armInputs(node);
      const ordered = node.order.filter((from) => arms.includes(from));
      const step = Object.keys(cell.slots).length;
      return {
        kind: "sequence",
        step,
        of: ordered.length,
        arrived: arrivals(ordered, cell),
        nextExpected: ordered[step] ?? null,
      };
    }

    case "stateful.cooldown": {
      const interval = parseDuration(node.min_interval);
      return {
        kind: "cooldown",
        // Derived, not stored: the cell keeps when it last fired, and the quiet
        // period is that instant plus the declared interval.
        suppressingUntilMs:
          cell.lastFiredAtMs === null || interval === null
            ? null
            : cell.lastFiredAtMs + durationMs(interval),
        minInterval: node.min_interval,
      };
    }

    case "stateful.persistence": {
      const window = parseDuration(node.duration);
      return {
        kind: "persistence",
        count: cell.arrivals.length,
        required: node.min_events,
        window: node.duration,
        windowMs: window === null ? 0 : durationMs(window),
        oldestArrivalAtMs: cell.arrivals.length === 0 ? null : Math.min(...cell.arrivals),
      };
    }

    case "sql": {
      const persistence = node.persistence === undefined ? null : parseDuration(node.persistence);
      return {
        kind: "sql",
        level: cell.level,
        heldSinceMs: cell.heldSinceMs,
        satisfiedAtMs:
          persistence === null || cell.heldSinceMs === null
            ? null
            : cell.heldSinceMs + durationMs(persistence),
        persistence: node.persistence ?? null,
      };
    }

    case "llm":
      return { kind: "llm", mode: node.mode };

    default:
      return { kind: "opaque" };
  }
}

/** The inputs that can fill a slot: arms, and never a broadcast. */
function armInputs(node: WatchNode): string[] {
  return Object.entries(nodeInputs(node))
    .filter(([, input]) => input.role === "arm" && input.broadcast !== true)
    .map(([from]) => from);
}

/** Which of `order` have arrived, with the event each arrived on. */
function arrivals(order: readonly string[], cell: NodeCell): ArrivedArm[] {
  return order.flatMap((from) => {
    const slot = cell.slots[from];
    if (!slot) return [];
    // The document this arm fired on, read off the chain the signal carried
    // rather than out of the payload — a payload holds whatever the author's
    // `output_map` named, which need not mention a document at all. Keyed by
    // the arm's own node, because that is the link of the chain that matched.
    const documentId = slot.provenance?.[from]?.documentId;
    return [{ from, seq: slot.seq, ...(typeof documentId === "string" ? { documentId } : {}) }];
  });
}
