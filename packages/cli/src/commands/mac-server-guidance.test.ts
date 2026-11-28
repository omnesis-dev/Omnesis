// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { macServerGuidance } from "./mac-server-guidance.js";

test("Mac gateway installation includes actionable host power guidance", () => {
  const guidance = macServerGuidance("darwin", true);
  expect(guidance).toContain("Settings > Energy");
  expect(guidance).toContain("Battery > Options");
  expect(guidance).toContain("display can turn off");
  expect(guidance).toContain("https://omnesis.dev/docs/install#mac-server");
});

test("a client or collector-only Mac and a non-Mac gateway do not receive host sleep instructions", () => {
  expect(macServerGuidance("darwin", false)).toBeNull();
  expect(macServerGuidance("linux", true)).toBeNull();
  expect(macServerGuidance("win32", true)).toBeNull();
});
