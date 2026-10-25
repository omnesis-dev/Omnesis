// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `count_messages` port: resolves the caller's window, then runs the count
 * ({@link countMessagesByPerson}) on the read-worker pool when a gate is
 * wired, or on the calling thread when none is. Reads every source, so only an
 * unrestricted caller is ever given one.
 */

import { countMessagesByPerson, type MessageCountsQuery } from "../domain/message-counts.js";
import { resolveTemporalRange } from "../enrichment/temporal/temporal-range.js";
import type { MessageCountPort, MessageCountPortInput, MessageCountsBody } from "@omnesis/agent";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * The narrow read-worker capability the port delegates to. The full `IoGate`
 * satisfies it structurally.
 */
export interface MessageCountGate {
  messageCounts(query: MessageCountsQuery): Promise<MessageCountsBody>;
}

/**
 * The window a call asks for. A `from` that names a day, month or year without
 * a `to` covers that period; any other `from` without a `to` runs up to now,
 * because "since Monday" means through today and not one instant on Monday.
 */
export function resolveMessageCountWindow(
  input: Pick<MessageCountPortInput, "from" | "to" | "timeZone">,
  nowMs = Date.now(),
): { fromMs: number; toExclusiveMs: number } {
  const range = resolveTemporalRange(input, nowMs);
  if (input.to === undefined && range.toExclusiveMs === range.fromMs + 1) {
    if (nowMs <= range.fromMs) throw new Error("count_messages `from` must be in the past");
    return { fromMs: range.fromMs, toExclusiveMs: nowMs };
  }
  return range;
}

export function createGatewayMessageCountPort(
  db: Db,
  opts?: { gate?: MessageCountGate },
): MessageCountPort {
  return {
    async count(input, signal) {
      signal?.throwIfAborted();
      const t0 = Date.now();
      const window = resolveMessageCountWindow(input);
      const query: MessageCountsQuery = {
        fromIso: new Date(window.fromMs).toISOString(),
        toExclusiveIso: new Date(window.toExclusiveMs).toISOString(),
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        limit: input.limit,
      };
      const body = opts?.gate
        ? await opts.gate.messageCounts(query)
        : countMessagesByPerson(db, query);
      signal?.throwIfAborted();
      return {
        ...body,
        window: {
          from: query.fromIso,
          toExclusive: query.toExclusiveIso,
          timeZone: input.timeZone,
        },
        durationMs: Date.now() - t0,
      };
    },
  };
}
