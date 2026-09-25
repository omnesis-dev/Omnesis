// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch's live state, dressed for a reader.
 *
 * The runtime's snapshot is complete but unhelpful to look at: keys are raw
 * component maps of whatever the DSL extracted, instants are epoch
 * milliseconds, and a parked nomination does not say why it is parked. This
 * turns that into what a debugging surface can render — instants as ISO
 * strings like every other watch route, key components with a display form
 * beside the raw id, and a failure class joined on from the trace.
 *
 * Two joins happen here rather than in the runtime, because neither is
 * knowledge the runtime has:
 *
 * - **Display names.** A key component that is a person id is only a person id
 *   because the people table has a row for it. Nothing in the DSL says which
 *   components are people, so every scalar component is offered to the
 *   directory and whatever comes back is a name. A thread id is simply not in
 *   there, and reads as itself.
 * - **Why a nomination is parked.** The class the judge refused with goes to
 *   the trace, not to the nomination row — so it is correlated by the pair the
 *   two share, `(node, seq)`. A nomination whose trace has rolled off keeps a
 *   null class rather than being given a guessed one.
 */

import {
  renderKey,
  type ArrivedArm,
  type WatchCellDetail,
  type WatchStateSnapshot,
} from "@omnesis/watch";

import type { TraceRow } from "./traces.js";

/** One component of an instance key, raw and resolved. */
interface KeyComponentView {
  readonly name: string;
  /** The component's value as text — a person id, a thread id, a day stamp. */
  readonly raw: string;
  /** What that value is called, when the people directory knows it. */
  readonly display: string | null;
}

export interface WatchStateResponse {
  readonly watch: { readonly id: string; readonly name: string };
  readonly asOf: {
    readonly at: string;
    /** The journal event this watch's cells are consistent with. */
    readonly seq: number;
    /** Where the producer has reached. At or ahead of `seq`. */
    readonly journalHead: number;
  };
  readonly nodes: readonly {
    readonly id: string;
    readonly type: string;
    /** How many cells this node holds. Zero is a real answer. */
    readonly cells: number;
    readonly onCollision: string | null;
    readonly maxLiveInstances: number | null;
    readonly cancelledBy: readonly string[];
    readonly instances: readonly {
      readonly keyHash: string;
      readonly instance: number;
      readonly key: Readonly<Record<string, unknown>>;
      readonly keyLabel: string;
      readonly components: readonly KeyComponentView[];
      readonly state: string;
      readonly armedAt: string;
      readonly deadlineAt: string | null;
      readonly lastFiredAt: string | null;
      /** The node type's own reading of the cell, keyed by `kind`. */
      readonly detail: Record<string, unknown>;
    }[];
  }[];
  readonly timers: readonly {
    readonly nodeId: string;
    readonly keyHash: string;
    readonly instance: number;
    readonly key: Readonly<Record<string, unknown>>;
    readonly keyLabel: string;
    readonly components: readonly KeyComponentView[];
    readonly kind: string;
    readonly dueAt: string;
    /**
     * Already due at the moment of this read.
     *
     * Not the same as fired: a timer is only swept by an evaluation pass, so one
     * that came due between passes sits here until the next tick reaches it.
     */
    readonly overdue: boolean;
  }[];
  readonly parked: readonly {
    readonly nodeId: string;
    readonly docId: string;
    readonly seq: number;
    readonly at: string;
    /** `budget` or `provider`, or null when the trace that said so is gone. */
    readonly failure: string | null;
  }[];
  readonly judge: {
    readonly dailyCap: number;
    readonly perWatchDailyCap: number;
    readonly spentToday: number;
    readonly watchSpentToday: number;
  };
}

export interface StateResponseInput {
  readonly watch: { readonly id: string; readonly name: string };
  readonly snapshot: WatchStateSnapshot;
  readonly journalHead: number;
  readonly atMs: number;
  /** Display names for whichever of the ids offered name a person. */
  readonly names: ReadonlyMap<string, string>;
  /** Recent trace rows, for the class a parked nomination was refused with. */
  readonly traces: readonly TraceRow[];
  /**
   * What {@link arrivalCandidates} asked about, answered.
   *
   * An arm the journal has pruned, or a document the corpus no longer holds,
   * is simply absent — the arm still renders as the arm it is, with the seq it
   * arrived on, rather than being dropped for want of a title.
   */
  readonly arrivals: {
    readonly instants: ReadonlyMap<number, string>;
    readonly documents: ReadonlyMap<string, { id: string; title: string; sourceId: string }>;
  };
  readonly judge: {
    readonly dailyCap: number;
    readonly perWatchDailyCap: number;
    readonly spentToday: number;
    readonly watchSpentToday: number;
  };
}

/**
 * Every scalar key component in a snapshot, deduped — the candidates for a
 * display name.
 *
 * Separate from {@link stateResponse} because the directory lookup that answers
 * it is a database read the caller owns: this says what to ask about, the
 * caller asks, and the answer comes back in. Numbers and booleans are excluded
 * — a person id is a string, and offering every day-of-month in a keyed watch
 * would be a lookup per cell for nothing.
 */
export function keyComponentCandidates(snapshot: WatchStateSnapshot): string[] {
  const found = new Set<string>();
  const collect = (key: Readonly<Record<string, unknown>>): void => {
    for (const value of Object.values(key)) {
      if (typeof value === "string" && value.length > 0) found.add(value);
    }
  };
  for (const node of snapshot.nodes) for (const cell of node.cells) collect(cell.key);
  for (const timer of snapshot.timers) collect(timer.key);
  return [...found];
}

/**
 * The journal events and documents an arrived arm needs to be readable.
 *
 * Separate from {@link stateResponse} for the same reason the name lookup is: the
 * reads that answer it belong to the caller. A cell records that arm `confirmed`
 * was satisfied by event 4210 and which document it fired on — enough to find
 * the moment and the thing, and not enough to render either.
 *
 * Without this a join or a sequence can say "1 of 2 arrived" and nothing about
 * what arrived, which is the question a half-satisfied cell actually raises.
 */
export function arrivalCandidates(snapshot: WatchStateSnapshot): {
  seqs: number[];
  documentIds: string[];
} {
  const seqs = new Set<number>();
  const documentIds = new Set<string>();
  for (const node of snapshot.nodes) {
    for (const cell of node.cells) {
      const arrived = (cell.detail as { arrived?: readonly ArrivedArm[] }).arrived;
      for (const arm of arrived ?? []) {
        seqs.add(arm.seq);
        if (arm.documentId !== undefined) documentIds.add(arm.documentId);
      }
    }
  }
  return { seqs: [...seqs], documentIds: [...documentIds] };
}

export function stateResponse(input: StateResponseInput): WatchStateResponse {
  const { snapshot, atMs } = input;
  const components = (key: Readonly<Record<string, unknown>>): KeyComponentView[] =>
    Object.entries(key).map(([name, value]) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
      return { name, raw, display: input.names.get(raw) ?? null };
    });

  // Keyed on the pair a parked nomination and its trace row share. The rows
  // arrive oldest first, so the last write wins is the newest one: a nomination
  // re-asked on a later pass and refused again is parked for whatever stopped
  // it *this* time, not the first time.
  const classes = new Map<string, string>();
  for (const row of input.traces) {
    if (row.failure === null) continue;
    classes.set(`${row.nodeId}:${row.seq}`, row.failure);
  }

  return {
    watch: input.watch,
    asOf: {
      at: new Date(atMs).toISOString(),
      seq: snapshot.asOfSeq,
      journalHead: input.journalHead,
    },
    nodes: snapshot.nodes.map((node) => ({
      id: node.nodeId,
      type: node.type,
      cells: node.cells.length,
      onCollision: node.onCollision,
      maxLiveInstances: node.maxLiveInstances,
      cancelledBy: node.cancelledBy,
      instances: node.cells.map((cell) => ({
        keyHash: cell.keyHash,
        instance: cell.instance,
        key: cell.key,
        // The runtime's own rendering, so a cell and the trace rows about it
        // name the key the same way.
        keyLabel: renderKey(cell.key),
        components: components(cell.key),
        state: cell.state,
        armedAt: new Date(cell.armedAtMs).toISOString(),
        deadlineAt: cell.deadlineAtMs === null ? null : new Date(cell.deadlineAtMs).toISOString(),
        lastFiredAt:
          cell.lastFiredAtMs === null ? null : new Date(cell.lastFiredAtMs).toISOString(),
        detail: withArrivals(instantsInDetail(cell.detail), input.arrivals),
      })),
    })),
    timers: snapshot.timers.map((timer) => ({
      nodeId: timer.nodeId,
      keyHash: timer.keyHash,
      instance: timer.instance,
      key: timer.key,
      keyLabel: renderKey(timer.key),
      components: components(timer.key),
      kind: timer.kind,
      dueAt: new Date(timer.dueAtMs).toISOString(),
      overdue: timer.dueAtMs <= atMs,
    })),
    parked: snapshot.parked.map((nomination) => ({
      nodeId: nomination.nodeId,
      docId: nomination.docId,
      seq: nomination.seq,
      at: new Date(nomination.atMs).toISOString(),
      failure: classes.get(`${nomination.nodeId}:${nomination.seq}`) ?? null,
    })),
    judge: input.judge,
  };
}

/**
 * Each arrived arm with the moment it arrived and the document it fired on.
 *
 * "1 of 2 arrived" is the shape of the answer, not the answer: a reader looking
 * at a half-satisfied sequence is asking *when the first step happened and what
 * satisfied it*, and until this the cell knew both and said neither.
 *
 * Every field stays optional. An arm whose journal event has been pruned keeps
 * its sequence and loses its instant; one that fired on no document — a clock,
 * a row — never had one. Neither is a reason to drop the arm.
 */
function withArrivals(
  detail: Record<string, unknown>,
  arrivals: StateResponseInput["arrivals"],
): Record<string, unknown> {
  const arrived = detail["arrived"];
  if (!Array.isArray(arrived)) return detail;
  return {
    ...detail,
    arrived: arrived.map((arm: unknown) => {
      const { from, seq, documentId } = arm as ArrivedArm;
      const at = arrivals.instants.get(seq);
      const document = documentId === undefined ? undefined : arrivals.documents.get(documentId);
      return {
        from,
        seq,
        ...(at === undefined ? {} : { at }),
        ...(document === undefined ? {} : { document }),
      };
    }),
  };
}

/**
 * The same cell detail with its `…Ms` instants as ISO strings.
 *
 * Mechanical rather than per-kind on purpose: every detail shape names its
 * instants with the one suffix, so a node type gaining a field cannot arrive on
 * the wire as a bare epoch number because someone forgot a case here. The field
 * loses the suffix and keeps its name — `firesAtMs` becomes `firesAt`.
 */
function instantsInDetail(detail: WatchCellDetail): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(detail) as [string, unknown][]) {
    // `windowMs` is a span, not an instant — a length of time has no ISO form,
    // and it is the one thing the suffix rule cannot tell apart on its own.
    if (!name.endsWith("Ms") || name === "windowMs") {
      out[name] = value;
      continue;
    }
    out[name.slice(0, -"Ms".length)] =
      typeof value === "number" ? new Date(value).toISOString() : null;
  }
  return out;
}
