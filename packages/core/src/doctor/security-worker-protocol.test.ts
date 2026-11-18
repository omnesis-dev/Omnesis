// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { doctorSecurityWorkerError } from "./security-worker-protocol.js";

test.each([undefined, false, 0, "invented-proof"])(
  "the explicit receipt survives structured clone (%#)",
  (failure) => {
    const original = new Error("Invented outer audit failure", {
      cause: Object.assign(new Error("invented native operation"), { cleanupFailure: failure }),
    });
    const message = structuredClone(doctorSecurityWorkerError(original));
    expect(message.type).toBe("error");
    expect(Object.hasOwn(message, "cleanupFailure")).toBe(true);
    if (message.type === "error") expect(message.cleanupFailure).toBe(failure);
  },
);

test("an ordinary joined error has no invented receipt", () => {
  const message = structuredClone(
    doctorSecurityWorkerError(new Error("Invented unavailable state")),
  );
  expect(message).toEqual({ type: "error", error: "Invented unavailable state" });
  expect(Object.hasOwn(message, "cleanupFailure")).toBe(false);
});

test("a rejected pending marker cannot claim an exposed late-join promise across the port", () => {
  const message = doctorSecurityWorkerError(
    Object.assign(new Error("Invented rejected source"), {
      cleanupFailure: undefined,
      cleanupPending: true,
    }),
  );
  expect(Object.hasOwn(message, "cleanupFailure")).toBe(true);
  expect(Object.hasOwn(message, "cleanupPending")).toBe(false);
});
