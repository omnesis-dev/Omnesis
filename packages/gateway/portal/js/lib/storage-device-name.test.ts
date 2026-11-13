// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { portalDeviceName, setPortalDeviceName } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());

test("a device name set by a sign-in is the one this browser keeps using", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
  const minted = portalDeviceName();
  expect(minted).toMatch(/^Portal [a-f0-9]{8}$/);
  setPortalDeviceName("Portal 1a2b3c4d");
  expect(portalDeviceName()).toBe("Portal 1a2b3c4d");
});

test("a browser without storage ignores the name instead of failing the sign-in", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("synthetic storage refusal");
    },
  });
  expect(() => setPortalDeviceName("Portal 1a2b3c4d")).not.toThrow();
});
