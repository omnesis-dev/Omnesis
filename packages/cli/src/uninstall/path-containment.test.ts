// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { pathIsInside } from "./path-containment.js";

describe("uninstall path containment", () => {
  test.each([
    ["/owned/home", "/owned", true],
    ["/owned", "/owned", true],
    ["/owned-other/home", "/owned", false],
    ["/outside", "/owned", false],
    ["/owned/..notes/home", "/owned", true],
    [String.raw`/owned/..\notes/home`, "/owned", true],
  ])("POSIX child %s within %s is %s", (child, parent, expected) => {
    expect(pathIsInside(child, parent, posix)).toBe(expected);
  });

  test.each([
    [String.raw`C:\owned\home`, String.raw`C:\owned`, true],
    [String.raw`C:\owned`, String.raw`C:\owned`, true],
    [String.raw`C:\owned-other\home`, String.raw`C:\owned`, false],
    [String.raw`D:\checkout`, String.raw`C:\owned`, false],
    [String.raw`\\server\other\home`, String.raw`\\server\owned`, false],
    [String.raw`C:\owned\..notes\home`, String.raw`C:\owned`, true],
  ])("Windows child %s within %s is %s", (child, parent, expected) => {
    expect(pathIsInside(child, parent, win32)).toBe(expected);
  });
});
