// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The loop directory.
 *
 * Binding "my tax-return loop" is a compile-time act: the compiler resolves the
 * prose to a loop id and freezes it into the plan, the same trade-off the
 * people directory makes for person ids. That needs a directory of the loops
 * that exist, and unlike sources and analytics tables — which describe a
 * *contract* — loops are ordinary data, so they arrive as their own file rather
 * than as part of the ontology snapshot. In a live install this is a query
 * against the loop store; here it is `loops.json` beside the journal.
 *
 * A directory is a snapshot of a moving thing, and the instant it describes is
 * the one a compilation happens at: the state each loop was in when the
 * replayed window opens. The journal then moves them — the tax loop is open in
 * the directory and resolved by the end of the replay — which is the same
 * staleness a live compile has, and `loops.test.ts` pins the two together so
 * the file cannot drift from the journal it belongs to.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { universeDir } from "../universe/paths.js";

const loopDirectoryEntrySchema = z
  .object({
    loopId: z.string().min(1),
    title: z.string().min(1),
    state: z.enum(["open", "snoozed", "done", "dismissed"]),
  })
  .strict();

const loopDirectorySchema = z.array(loopDirectoryEntrySchema);

export type LoopDirectoryEntry = z.infer<typeof loopDirectoryEntrySchema>;

/** A universe's loop directory, or an empty one when it declares no loops. */
export function loadLoops(universe?: string): LoopDirectoryEntry[] {
  const path = join(universeDir(universe), "loops.json");
  if (!existsSync(path)) return [];
  return loopDirectorySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
