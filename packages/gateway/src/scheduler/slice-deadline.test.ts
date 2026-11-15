// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { sliceDeadline } from "./slice-deadline.js";

test("stops once its slice has passed, and not before", () => {
  let now = 1_000;
  const stop = sliceDeadline({ requested: () => false }, 100, () => now);
  expect(stop()).toBe(false);
  now = 1_099;
  expect(stop()).toBe(false);
  now = 1_100;
  expect(stop()).toBe(true);
});

test("stops at once when the scheduler asks for the writer back", () => {
  let requested = false;
  const stop = sliceDeadline({ requested: () => requested }, 100, () => 0);
  expect(stop()).toBe(false);
  requested = true;
  expect(stop()).toBe(true);
});

test("measures from when it is made", () => {
  let now = 5_000;
  const stop = sliceDeadline({ requested: () => false }, 50, () => now);
  now = 5_049;
  expect(stop()).toBe(false);
  now = 5_050;
  expect(stop()).toBe(true);
});
