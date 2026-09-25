// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The event directory.
 *
 * A request can point at one specific thing — "the dinner", "my flight", "the
 * deadline" — and binding it is a compile-time act, the same one the people and
 * loop directories exist for. The compiler resolves the prose to an identity,
 * freezes it into the plan with provenance, and the operator approves a plan
 * that says *which* dinner it means. A wrong resolution is then caught by a
 * person at creation rather than discovered at firing.
 *
 * Without a directory there is nothing to resolve against, and a compiler has
 * only two honest moves: refuse, or write a watch bound to nothing. Which of
 * those a given compiler takes says little about the compiler and everything
 * about the substrate — the question is unanswerable either way.
 *
 * Carrying more than one is the point. A directory holding a single dinner
 * cannot tell a compiler that resolved it correctly from one that had no
 * choice, so a corpus that means to exercise resolution has to offer a wrong
 * answer as well as a right one.
 *
 * Like loops, these are ordinary data rather than a contract, so they arrive as
 * their own file rather than inside the ontology snapshot. In a live install
 * this is a query against the calendar store; here it is `events.json` beside
 * the journal.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { universeDir } from "../universe/paths.js";

const eventDirectoryEntrySchema = z
  .object({
    /** The identity a watch binds. A calendar event's stable id. */
    eventId: z.string().min(1),
    title: z.string().min(1),
    /** When it happens, and what a horizon is derived from. */
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime().optional(),
    /**
     * Who is on it, as person ids.
     *
     * The disambiguator. Two dinners are two candidates until something in the
     * request reaches one of them, and the person a request names is the thing
     * it most often has: "the dinner" is ambiguous, "Alice ... the dinner" is
     * not. Without a way through, a compiler following the rule it is given
     * should refuse rather than pick — so a directory that offers no route from
     * the request to one entry is a directory that makes every dated request
     * unanswerable.
     */
    people: z.array(z.uuid()).default([]),
  })
  .strict();

const eventDirectorySchema = z.array(eventDirectoryEntrySchema);

export type EventDirectoryEntry = z.infer<typeof eventDirectorySchema>[number];

/** A universe's event directory, or an empty one when it declares no events. */
export function loadEvents(universe?: string): EventDirectoryEntry[] {
  const path = join(universeDir(universe), "events.json");
  if (!existsSync(path)) return [];
  return eventDirectorySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * A day past the end of the event.
 *
 * The question usually outlives the occasion by a little: a dinner declined an
 * hour before it starts is still the thing the watch was written for, and one
 * that expired at the first minute of the event would miss exactly that case. A
 * day rather than an hour because asking one day too long costs a day of
 * nothing, while stopping one hour too early costs the answer.
 */
export function horizonOf(event: EventDirectoryEntry): string {
  return new Date(Date.parse(event.endsAt ?? event.startsAt) + 86_400_000).toISOString();
}
