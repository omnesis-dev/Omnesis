// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every number a watch binds, and whether its request said so.
 *
 * A paired measurement asks whether a compilation can be rebuilt from a
 * request. It can only mean that if everything the reference binds is either
 * present in the request or admitted to be a free choice — otherwise the answer
 * key is asking for information it never supplied, and the attempts it fails
 * were never winnable.
 *
 * Three of the corpus's seventeen watches were in that state: one fired on the
 * opposite of what its request asked for, one counted four events where the
 * request said three, and one matched on content the request never named.
 *
 * This module pulls the bound values out of a watch. `reconstructible.test.ts`
 * checks each against the request; `free-parameters.ts` is where a watch admits
 * the ones the request genuinely leaves open.
 */

import { parseCron } from "../time/cron.js";
import { parseDuration } from "../time/duration.js";
import type { WatchDefinition, WatchNode } from "../dsl/schema.js";

/** A value a watch binds, located so a person can go and look at it. */
export interface BoundParameter {
  /** `weekly_cap.min_interval` — the node and the field. */
  readonly at: string;
  readonly kind: "duration" | "count" | "hour";
  /** Milliseconds for a duration, the number itself otherwise. */
  readonly value: number;
  /** As written in the watch, for a message a reader can act on. */
  readonly written: string;
}

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  business_days: 86_400_000,
  weeks: 604_800_000,
};

const DURATION_FIELDS = ["duration", "deadline", "min_interval", "timer", "window"] as const;
const COUNT_FIELDS = ["min_events", "n", "max_live_instances"] as const;

/** Every duration, count and tick-hour a watch binds. */
export function boundParameters(watch: WatchDefinition): BoundParameter[] {
  return watch.nodes.flatMap((node) => [
    ...durationsOf(node),
    ...countsOf(node),
    ...tickHoursOf(node),
  ]);
}

function durationsOf(node: WatchNode): BoundParameter[] {
  const found: BoundParameter[] = [];
  for (const field of DURATION_FIELDS) {
    const written: unknown = (node as unknown as Record<string, unknown>)[field];
    // "infinite" is a declared absence of a bound, not a bound.
    if (typeof written !== "string" || written === "infinite") continue;
    const parsed = parseDuration(written);
    const unit = parsed ? UNIT_MS[parsed.unit] : undefined;
    if (!parsed || unit === undefined) continue;
    found.push({
      at: `${node.id}.${field}`,
      kind: "duration",
      value: parsed.amount * unit,
      written,
    });
  }
  return found;
}

function countsOf(node: WatchNode): BoundParameter[] {
  const found: BoundParameter[] = [];
  for (const field of COUNT_FIELDS) {
    const value: unknown = (node as unknown as Record<string, unknown>)[field];
    if (typeof value !== "number") continue;
    found.push({ at: `${node.id}.${field}`, kind: "count", value, written: String(value) });
  }
  return found;
}

/**
 * The hour a recurring source ticks at.
 *
 * Only the hour: the day-of-week and day-of-month are what a request means by
 * "weekly" or "on the first", and are checked as named values, while the hour
 * is what a request almost never says.
 */
function tickHoursOf(node: WatchNode): BoundParameter[] {
  const recurring: unknown = (node as unknown as Record<string, unknown>).recurring;
  if (typeof recurring !== "string") return [];
  const cron = parseCron(recurring);
  if (!cron || cron.hours.size !== 1) return [];
  return [
    {
      at: `${node.id}.recurring.hour`,
      kind: "hour",
      value: [...cron.hours][0]!,
      written: recurring,
    },
  ];
}

/**
 * The semantic content a watch matches on: recall queries and judge
 * propositions. A request that never names the subject cannot be compiled into
 * a watch that matches one.
 */
/**
 * Every value the watch freezes into itself as a constant.
 *
 * A constant is the most extreme thing a watch can bind: it is not derived from
 * the ontology at all, so a compilation has literally nowhere to read it from
 * except the request. The travel watch froze a passport expiry date whose
 * provenance note says it was read off a scanned document, and three
 * compilations in five refused the request for exactly that reason — correctly,
 * and were marked wrong for it.
 */
export function boundConstants(watch: WatchDefinition): { at: string; written: string }[] {
  return Object.entries(watch.constants ?? {}).map(([name, constant]) => ({
    at: `constants.${name}`,
    written: String(constant.value),
  }));
}

export function boundContent(watch: WatchDefinition): { at: string; text: string }[] {
  return watch.nodes.flatMap((node) => {
    const found: { at: string; text: string }[] = [];
    if ("recall" in node && node.recall?.semantic) {
      found.push({ at: `${node.id}.recall_query`, text: node.recall.semantic.query });
    }
    // A lexical arm's terms are matched subjects too — literal ones. A watch
    // nominating on a token its request never names is matching on something
    // nobody asked for, exactly as a recall query would be.
    // One entry per term, not the terms joined. Joined, a watch nominating on
    // ["XR-4471", "acme-internal"] passes the "matched subject the request
    // names" check on the strength of the first term and the second is never
    // looked at — and a term nobody asked for is exactly what that check is for.
    if ("recall" in node && node.recall?.lexical) {
      for (const [index, term] of node.recall.lexical.terms.entries()) {
        found.push({ at: `${node.id}.lexical_terms.${index}`, text: term });
      }
    }
    if (node.type === "llm") found.push({ at: `${node.id}.proposition`, text: node.proposition });
    return found;
  });
}
