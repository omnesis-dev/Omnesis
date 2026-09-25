// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway implementation of the interactive agent's READ-ONLY `LoopReadPort`
 * (experimental). Projects the Cognition Steward's `open_loops` into the compact
 * `LoopSummary` / `LoopDetail` wire shapes — no mutation surface, so the chat
 * agent can find and read what the background agent tracks but never change it.
 * Terminal (done / dismissed) loops are never surfaced; only live obligations.
 */

import {
  getOpenLoop,
  listOpenLoops,
  listOpenLoopLedger,
  listRelatedLoops,
  searchOpenLoopsLexical,
} from "./storage/open-loops.js";
import type Database from "better-sqlite3";
import type { LoopDetail, LoopSummary } from "@omnesis/core";
import type {
  LoopListPortResult,
  LoopReadPort,
  LoopSearchPortInput,
  LoopSearchPortResult,
} from "@omnesis/agent";
import type { OpenLoopRow } from "./storage/types.js";

type Db = Database.Database;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
const MAX_LEDGER = 8;

/** The active loop states `list_loops` enumerates (live obligations only). */
const ACTIVE_STATES = ["open", "snoozed"] as const;

/** True for loops the interactive agent may see — live, not terminal history. */
function isActive(loop: OpenLoopRow): boolean {
  return loop.state === "open" || loop.state === "snoozed";
}

/** Best-effort display string for the agent-owned opaque deadline structure. */
function deadlineString(deadline: unknown): string | undefined {
  if (deadline == null) return undefined;
  if (typeof deadline === "string") return deadline;
  return JSON.stringify(deadline);
}

/** Resolve person ids → canonical display names, preserving order (id as fallback). */
function resolveNames(db: Db, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare<
      string[],
      { id: string; canonical_name: string }
    >(`SELECT id, canonical_name FROM people WHERE id IN (${placeholders})`)
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r.canonical_name]));
  return ids.map((id) => byId.get(id) ?? id);
}

function loopToSummary(loop: OpenLoopRow): LoopSummary {
  return {
    loopId: loop.id,
    title: loop.title,
    description: loop.description,
    state: loop.state,
    importance: loop.importance,
    confidence: loop.confidence,
    ...(deadlineString(loop.deadline) !== undefined
      ? { deadline: deadlineString(loop.deadline) }
      : {}),
  };
}

function loopToDetail(db: Db, loop: OpenLoopRow, now: number): LoopDetail {
  const relatedLoops = listRelatedLoops(db, loop.id, now).map((l) => ({
    loopId: l.id,
    title: l.title,
    state: l.state,
    ...(l.importance !== undefined ? { importance: l.importance } : {}),
  }));
  return {
    ...loopToSummary(loop),
    actors: resolveNames(db, loop.actors),
    involved: resolveNames(db, loop.involved),
    docIds: [...loop.docs],
    ledger: listOpenLoopLedger(db, loop.id)
      .slice(-MAX_LEDGER)
      .map((e) => ({ at: e.at, note: e.note })),
    ...(relatedLoops.length > 0 ? { relatedLoops } : {}),
  };
}

export function createGatewayLoopReadPort(db: Db): LoopReadPort {
  return {
    async search(input: LoopSearchPortInput): Promise<LoopSearchPortResult> {
      const t0 = Date.now();
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const loops = searchOpenLoopsLexical(db, input.query, { limit })
        .filter(isActive)
        .map(loopToSummary);
      return { query: input.query, durationMs: Date.now() - t0, loops };
    },
    async fetch(loopId: string): Promise<LoopDetail | null> {
      const loop = getOpenLoop(db, loopId);
      if (!loop || !isActive(loop)) return null;
      return loopToDetail(db, loop, Date.now());
    },
    async list(limit: number | undefined): Promise<LoopListPortResult> {
      const t0 = Date.now();
      const cap = Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
      // Importance-first so that when the active-loop count exceeds the cap it is
      // the LEAST important loops that fall off, never a stale-but-important one.
      // Over-fetch by one to detect (not silently drop) that more exist.
      const rows = listOpenLoops(db, {
        states: [...ACTIVE_STATES],
        orderBy: "importance",
        limit: cap + 1,
      });
      return {
        durationMs: Date.now() - t0,
        loops: rows.slice(0, cap).map(loopToSummary),
        truncated: rows.length > cap,
      };
    },
  };
}
