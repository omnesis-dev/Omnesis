// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { deviceJoinedLabel } from "./relay-device-enrollment.js";

test("how a device joined reads in plain words", () => {
  // Signing in is one way to join, whatever the sign-in method was.
  for (const signIn of ["google", "passkey", undefined])
    expect(deviceJoinedLabel({ method: "automatic", signIn })).toBe("Joined with Omnesis account");
  expect(deviceJoinedLabel({ method: "approved", signIn: "google" })).toBe("Approved");
  for (const value of [undefined, null, "automatic", { method: "unknown" }])
    expect(deviceJoinedLabel(value)).toBeNull();
});
