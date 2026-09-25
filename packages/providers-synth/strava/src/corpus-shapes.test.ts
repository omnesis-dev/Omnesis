// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Guards on shapes the synthetic corpus carries deliberately.
 *
 * Both were found in a real install and are easy to lose: they look like
 * mistakes. A timestamp spelled the way a datastore renders one reads as a
 * typo next to its ISO-8601 neighbours, and a repeated fixture entry reads as
 * an editing slip. Deleting either would leave the corpus tidier and quietly
 * stop exercising a defect class the journal now has code to absorb — with no
 * test failing to say so. Hence these.
 */

import { describe, expect, test } from "vitest";
import { toCanonicalInstant, toCanonicalWallClock } from "@omnesis/core";
import { loadActivities } from "./fixtures.js";

describe("shapes the corpus keeps on purpose", () => {
  test("an instant spelled the way a store renders one, not the way an API sends it", () => {
    // A provider writes `2026-07-31T14:09:00Z` and reads back
    // `2026-07-31 15:09:00+01`. A phase that re-emits what it read hands the
    // second spelling on, and everything comparing rendered values calls it a
    // change. The corpus carries one so the canonicalization is exercised
    // rather than assumed.
    const rendered = loadActivities().filter((a) => /\d \d{2}:\d{2}/.test(a.startTime));
    expect(rendered.length, "no store-rendered instant left in the corpus").toBeGreaterThan(0);

    for (const activity of rendered) {
      // It is a real instant, and it names the same moment as its ISO spelling.
      const canonical = toCanonicalInstant(activity.startTime);
      expect(canonical, `${activity.externalId} has an unparseable startTime`).not.toBeNull();
      expect(canonical).toBe(toCanonicalInstant(activity.startTime.replace(" ", "T")));
    }
  });

  test("a local stamp carrying a designator that means nothing", () => {
    // The other half of the same flap: a wall-clock reading rendered with a
    // trailing `Z` it has no right to. Honouring it would move the reading.
    const withDesignator = loadActivities().filter((a) => /[Z+]/.test(a.startTimeLocal ?? ""));
    expect(withDesignator.length).toBeGreaterThan(0);
    for (const activity of withDesignator) {
      expect(toCanonicalWallClock(activity.startTimeLocal)).not.toBeNull();
    }
  });

  test("the same activity delivered twice in one page", () => {
    // A writer emitting more than one notification per change. From the
    // journal's side these are byte-identical events about one document, which
    // is the case the document-path dedup exists for.
    const byExternalId = new Map<string, number>();
    for (const activity of loadActivities()) {
      byExternalId.set(activity.externalId, (byExternalId.get(activity.externalId) ?? 0) + 1);
    }
    const repeated = [...byExternalId].filter(([, count]) => count > 1);
    expect(repeated.length, "no repeated delivery left in the corpus").toBeGreaterThan(0);

    // Identical, not merely sharing an id: a differing pair would be an
    // ordinary update and would exercise nothing.
    for (const [externalId] of repeated) {
      const [first, ...rest] = loadActivities().filter((a) => a.externalId === externalId);
      for (const other of rest) {
        expect(JSON.stringify(other), `${externalId} deliveries differ`).toBe(
          JSON.stringify(first),
        );
      }
    }
  });
});
