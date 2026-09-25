// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweep dial and the files behind it are generated together from one list,
 * so a dot cannot point at prose belonging to a different sweep. This asserts
 * the page carries what the generator produces today, and that the list itself
 * still holds what the section claims: one dot per shipped sweep, each with
 * the prompt that actually runs.
 */

import { expect, test } from "vitest";
import { SWEEPS, renderFile } from "./render-sweep-examples.mjs";

test("website/brain.html carries a freshly rendered sweep section", async () => {
  const { before, after } = await renderFile();
  expect(before).toBe(after);
});

test("every sweep has an id, a cadence and a prompt", () => {
  const incomplete = SWEEPS.filter(
    (s) => !s.id || !s.name || !s.cadence || !s.at || !s.prompt || s.prompt.length < 80,
  ).map((s) => s.id ?? "(no id)");
  expect(incomplete).toEqual([]);
});

test("no sweep's prose was mangled on the way out of the gateway", () => {
  // The prompts are UTF-8 and use em dashes; a byte-wise unescape turns those
  // into "â€”" and the page ships mojibake that only a reader would notice.
  const mangled = SWEEPS.filter((s) => /Ã|â‚¬|â€|�/.test(s.prompt)).map((s) => s.id);
  expect(mangled).toEqual([]);
});

test("each dot sits on the ring its cadence names", () => {
  const expected = { "1d": "Daily", "7d": "Weekly", "14d": "Fortnightly", "30d": "Monthly" };
  const wrong = SWEEPS.filter((s) => expected[s.cadence] !== s.band).map((s) => s.id);
  expect(wrong).toEqual([]);
});

test("no two dots on the same side sit within a line of each other", () => {
  const tooClose = [];
  for (const side of ["left", "right"]) {
    const ys = SWEEPS.filter((s) => s.side === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ys.length; i++) {
      if (ys[i].y - ys[i - 1].y < 24) tooClose.push(`${ys[i - 1].id}/${ys[i].id}`);
    }
  }
  expect(tooClose).toEqual([]);
});
