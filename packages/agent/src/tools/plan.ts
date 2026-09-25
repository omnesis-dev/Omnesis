// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `plan` — the agent's transient TODO list, surfaced to the user as a
 * small pinned panel above the composer.
 *
 * The tool replaces the prose-style "Let me search…", "Now I'll check…"
 * narration the agent would otherwise sprinkle through a turn. Two
 * operations: `add` appends new items, `complete` marks them done by
 * server-assigned id. The result echoes the full current plan with
 * computed statuses so clients render the three visual states
 * (`pending` / `in_progress` / `done`) without any inference of their
 * own — the rule is fixed: the topmost non-`done` item is
 * `in_progress`, everything below it is `pending`.
 *
 * State is per-session, per-message. Each new assistant turn starts
 * with an empty plan. A turn's plan is auto-discarded once the
 * surrounding session ends or after a generous TTL — entries from a
 * resumed conversation are intentionally not replayed, since the
 * panel is meant to convey *in-flight* progress, not history.
 *
 * Ids are simple monotonic strings (`p1`, `p2`…) scoped per turn so
 * the model can refer to them across multiple `plan` calls within
 * the same assistant message without juggling UUIDs.
 */

import { z } from "zod";

import type { PlanItem, ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export const planArgsSchema = z
  .object({
    add: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "Short imperative items to append to the plan, e.g. " +
          "['Search messages from Claire', 'Check purchase history']. " +
          "Keep each item ≤ ~8 words. The first non-`done` item is " +
          "automatically `in_progress` — don't write 'Currently doing X', " +
          "just list the steps.",
      ),
    complete: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        "Ids of items to mark `done` (ids are the `p1`, `p2`… strings " +
          "returned by prior `plan` calls in the same turn). The next " +
          "non-done item becomes `in_progress` automatically.",
      ),
  })
  .refine((v) => (v.add && v.add.length > 0) || (v.complete && v.complete.length > 0), {
    message: "plan() must include `add`, `complete`, or both",
  });

export type PlanArgs = z.infer<typeof planArgsSchema>;

/** One entry as the tool tracks it internally (no `status` — that's computed). */
interface PlanEntry {
  id: string;
  label: string;
  done: boolean;
}

/** Per-(sessionId,messageId) tuple. */
interface PlanStateKey {
  sessionId: string;
  messageId: string;
}

/**
 * In-memory plan store. Lifetime tied to the agent service process —
 * plans evaporate on gateway restart, which is fine because they're
 * UI state, not durable history.
 *
 * Keyed by `<sessionId>|<messageId>` so a single session running
 * multiple assistant turns over its lifetime keeps each turn's plan
 * isolated. We expose `reset(sessionId, messageId)` so callers (the
 * session, when it starts a new turn) can clear state explicitly,
 * and `prune(beforeMs)` so a long-running gateway doesn't leak
 * entries forever.
 */
export class PlanStore {
  private readonly entries = new Map<string, { items: PlanEntry[]; touchedAt: number }>();

  private key(k: PlanStateKey): string {
    return `${k.sessionId}|${k.messageId}`;
  }

  /** Read-only snapshot. Returns an empty list if the key isn't tracked. */
  snapshot(k: PlanStateKey): PlanItem[] {
    const slot = this.entries.get(this.key(k));
    if (!slot) return [];
    return toRendered(slot.items);
  }

  /** Apply an add+complete delta and return the resulting snapshot. */
  update(k: PlanStateKey, delta: PlanArgs): PlanItem[] {
    const key = this.key(k);
    const slot = this.entries.get(key) ?? { items: [], touchedAt: Date.now() };
    if (delta.add) {
      for (const label of delta.add) {
        const id = `p${slot.items.length + 1}`;
        slot.items.push({ id, label, done: false });
      }
    }
    if (delta.complete) {
      const toComplete = new Set(delta.complete);
      for (const item of slot.items) {
        if (toComplete.has(item.id)) item.done = true;
      }
      // Silently ignore ids the agent passes that aren't in the plan —
      // hallucinated ids shouldn't fail the call.
    }
    slot.touchedAt = Date.now();
    this.entries.set(key, slot);
    return toRendered(slot.items);
  }

  /** Drop all state for a session — called on session teardown. */
  forgetSession(sessionId: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${sessionId}|`)) this.entries.delete(key);
    }
  }

  /** Evict entries whose last touch is older than `cutoffMs`. */
  prune(cutoffMs: number): void {
    for (const [key, slot] of this.entries) {
      if (slot.touchedAt < cutoffMs) this.entries.delete(key);
    }
  }
}

/**
 * Translate the internal `done`-flag entries into the wire shape with
 * computed `status`. Rule: the first non-done entry is `in_progress`;
 * everything after it is `pending`; done entries keep `done`. Order is
 * preserved (we never reshuffle — completed items stay in place until
 * the client auto-removes them).
 */
function toRendered(items: ReadonlyArray<PlanEntry>): PlanItem[] {
  let activeAssigned = false;
  const out: PlanItem[] = [];
  for (const e of items) {
    if (e.done) {
      out.push({ id: e.id, label: e.label, status: "done" });
      continue;
    }
    if (!activeAssigned) {
      out.push({ id: e.id, label: e.label, status: "in_progress" });
      activeAssigned = true;
    } else {
      out.push({ id: e.id, label: e.label, status: "pending" });
    }
  }
  return out;
}

export interface PlanToolDeps {
  store: PlanStore;
}

export function createPlanTool(deps: PlanToolDeps): ToolHandle {
  return {
    name: "plan",
    description:
      "Show the user a small TODO list of what you're about to do. Use " +
      "this when a question needs more than one sequential step (multiple " +
      "searches, then a verification pass, then a summary). Call once at " +
      "the start with `add: [...]` listing 2–5 short imperative steps; as " +
      "each step finishes, call again with `complete: [<id>]` using the " +
      "ids returned. The first non-done item is automatically shown as " +
      "`in_progress` — never list a 'currently doing X' item, just list " +
      "the steps. The panel is transient: it disappears once everything " +
      "is done, so don't use it for the final answer. For trivial one-step " +
      "questions, skip the plan tool entirely.",
    schema: planArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      const bits: string[] = [];
      if (Array.isArray(a.add) && a.add.length > 0) bits.push(`+${a.add.length}`);
      if (Array.isArray(a.complete) && a.complete.length > 0) bits.push(`✓${a.complete.length}`);
      return bits.length > 0 ? bits.join(" ") : undefined;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = planArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const items = deps.store.update(
        { sessionId: ctx.sessionId, messageId: ctx.messageId },
        parsed.data,
      );
      return { kind: "plan.updated", items };
    },
  };
}
