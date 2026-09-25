// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The loop directory is a second copy of something the journal already knows,
 * so the two have to be held together.
 *
 * A live install would query the loop store; a universe writes the answer down.
 * Written down, it can drift — a loop added to the journal and forgotten here
 * is a loop the compiler cannot bind, and it would fail as though the model had
 * missed it.
 */

import { describe, expect, it } from "vitest";

import { readJournal } from "../journal/read.js";
import { isKind } from "../journal/event.js";
import { journalPath } from "../universe/paths.js";
import { loadLoops } from "./loops.js";

/** Each loop as the journal first saw it — the state a compile at t0 sees. */
function loopsAtTheStart(): { loopId: string; title: string; state: string }[] {
  const first = new Map<string, { loopId: string; title: string; state: string }>();
  for (const event of readJournal(journalPath())) {
    if (!isKind(event, "loop.event")) continue;
    const { loopId, before } = event.payload;
    // A loop's first event may have no `before` — that is a loop being
    // created. The directory describes loops that already existed.
    if (first.has(loopId) || before === null) continue;
    first.set(loopId, { loopId, title: before.title, state: before.state });
  }
  return [...first.values()].sort((a, b) => (a.loopId < b.loopId ? -1 : 1));
}

describe("the loop directory", () => {
  it("names every loop the journal touches, as it stood when the window opened", () => {
    expect(loadLoops()).toEqual(loopsAtTheStart());
  });

  it("describes at least one loop, so the check above is not about an empty set", () => {
    expect(loadLoops().length).toBeGreaterThan(0);
  });

  it("is a snapshot rather than a final state", () => {
    // The tax loop is open here and resolved by the end of the replay. That is
    // the staleness a compile-time binding always carries, and stating it is
    // what stops someone 'fixing' the file to match the journal's last word.
    const journal = readJournal(journalPath());
    const resolutions = journal
      .filter((event) => isKind(event, "loop.event"))
      .map((event) => (event.payload as { after: { state: string } }).after.state);
    expect(resolutions, "no loop changes state in this journal").toContain("done");
    expect(loadLoops().map((loop) => loop.state)).not.toContain("done");
  });
});
