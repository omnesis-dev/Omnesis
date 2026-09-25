// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared runner for the batch tools (`search_many` / `fetch_many` /
 * `annotate_many`).
 *
 * One model tool call fans out to N children that execute concurrently
 * (bounded), streams per-child start/result progress through the
 * {@link ToolContext} hooks so each client animates one live ephemeral card per
 * child, and returns the per-item results in INPUT order even when children
 * settle out of order. A child that throws is captured as a `kind:"error"`
 * item in its slot, so one failure never discards the whole batch.
 */

import type { ToolResult } from "@omnesis/core";

import type { ToolContext } from "../backend.js";

/** Upper bound on concurrent child operations within a single batch. */
export const BATCH_MAX_CONCURRENCY = 8;

/** Upper bound on children per batch call (schema-enforced, bounds fan-out). */
export const BATCH_MAX_ITEMS = 16;

export interface BatchChild<TArgs> {
  args: TArgs;
  /** One-line label for the live card (query text, document id, …). */
  summary?: string;
}

/**
 * Execute `children` through `run`, streaming per-child events via `ctx`, and
 * return results index-aligned to `children`. `run` should resolve to its own
 * `kind:"error"` ToolResult on a handled failure; a thrown error is captured as
 * one. The shared `next` cursor is race-free: JS runs the increment to
 * completion before any `await` yields the event loop.
 */
export async function runBatch<TArgs>(
  tool: string,
  children: ReadonlyArray<BatchChild<TArgs>>,
  ctx: ToolContext,
  run: (args: TArgs, index: number) => Promise<ToolResult>,
  concurrency: number = BATCH_MAX_CONCURRENCY,
): Promise<ToolResult[]> {
  const items = new Array<ToolResult>(children.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= children.length) return;
      const child = children[i]!;
      ctx.onChildStart?.({ index: i, tool, argsSummary: child.summary });
      let result: ToolResult;
      try {
        result = await run(child.args, i);
      } catch (err) {
        result = {
          kind: "error",
          code: "batch_child_failed",
          message: (err as Error)?.message ?? "batch child failed",
        };
      }
      items[i] = result;
      ctx.onChildResult?.({ index: i, result });
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, children.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return items;
}
