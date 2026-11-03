// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Recorded stalls, and the ranking `GET /admin/stalls` serves. */

import { formatFrame } from "./profile-summary.js";
import type { ProfileSummary } from "./flight-recorder.js";
import type { StallEvent } from "./stall-protocol.js";

/** Garbage collection that overlapped a stall. */
export interface GcWindow {
  count: number;
  totalMs: number;
  maxMs: number;
  maxKind: string;
}

/**
 * How a stall's culprit was named:
 *
 *   - `running` — a marked activity was executing synchronously during the
 *     stall. That is the code that held the loop.
 *   - `in-flight` — nothing marked was executing, but exactly one marked
 *     asynchronous activity was in flight, so the stall was almost certainly
 *     one of its continuations.
 *   - `code` — neither, but the watchdog's snapshot of the stall named the
 *     code it was in, and the culprit is that code location.
 *   - `none` — nothing could be named. The `inFlight` list still names the
 *     candidates; a flight-recorder profile names the code.
 */
export type StallAttribution = "running" | "in-flight" | "code" | "none";

export interface StallRecord extends StallEvent {
  /** `startedAt`, as the ring's ordering key. */
  ts: number;
  attribution: StallAttribution;
  culprit: string | null;
  gc: GcWindow | null;
}

export function attributeStall(stall: StallEvent, gc: GcWindow | null): StallRecord {
  const single = stall.inFlight.length === 1 ? stall.inFlight[0]! : null;
  const code = stall.code ? formatFrame(stall.code) : null;
  const [attribution, culprit]: [StallAttribution, string | null] = stall.activity
    ? ["running", stall.activity]
    : single
      ? ["in-flight", single]
      : code
        ? ["code", code]
        : ["none", null];
  return { ...stall, ts: stall.startedAt, attribution, culprit, gc };
}

export interface StallTotals {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface StallRankEntry extends StallTotals {
  /**
   * An activity name or, for a stall only a snapshot explained, a code
   * location (see {@link StallAttribution}); null gathers every stall
   * nothing could be named for.
   */
  culprit: string | null;
  lastSeenAt: string;
}

/** Stalls grouped by culprit, most total blocked time first. */
export function rankStalls(records: readonly StallRecord[]): {
  summary: StallTotals;
  ranking: StallRankEntry[];
} {
  const summary: StallTotals = { count: 0, totalMs: 0, maxMs: 0 };
  const groups = new Map<string | null, StallRankEntry & { lastTs: number }>();
  for (const r of records) {
    summary.count += 1;
    summary.totalMs += r.durationMs;
    summary.maxMs = Math.max(summary.maxMs, r.durationMs);
    let g = groups.get(r.culprit);
    if (!g) {
      g = { culprit: r.culprit, count: 0, totalMs: 0, maxMs: 0, lastSeenAt: "", lastTs: 0 };
      groups.set(r.culprit, g);
    }
    g.count += 1;
    g.totalMs += r.durationMs;
    g.maxMs = Math.max(g.maxMs, r.durationMs);
    g.lastTs = Math.max(g.lastTs, r.ts);
  }
  const ranking = [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .map(({ lastTs, ...entry }) => ({ ...entry, lastSeenAt: new Date(lastTs).toISOString() }));
  return { summary, ranking };
}

export interface StallView extends Omit<StallRecord, "ts" | "startedAt"> {
  startedAt: string;
}

export interface StallReport {
  generatedAt: string;
  /** Whether stalls are being recorded: detection is on and the watchdog is alive. */
  enabled: boolean;
  thresholdMs: number;
  windowMinutes: number;
  /** Stalls shorter than this are left out of everything below. */
  minMs: number;
  summary: StallTotals;
  ranking: StallRankEntry[];
  /** The newest stalls, newest first. */
  recent: StallView[];
  /** The flight-recorder capture in progress, if any. */
  capturing: string | null;
  /** Kept profile summaries, newest first. */
  profiles: ProfileSummary[];
}

export function stallView({ ts: _ts, startedAt, ...rest }: StallRecord): StallView {
  return { ...rest, startedAt: new Date(startedAt).toISOString() };
}
