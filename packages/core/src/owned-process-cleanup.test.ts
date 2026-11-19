// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";

test.each([undefined, null, false, 0, new Error("Invented join refusal")])(
  "an explicit own cleanup marker preserves payload %j through an error cause",
  (failure) => {
    const receipt = Object.assign(new Error("Invented native operation"), {
      cleanupFailure: failure,
      cleanupPending: true,
    });
    expect(ownedProcessCleanupReceipt(receipt)).toEqual({ failure, pending: true });
    expect(ownedProcessCleanupReceipt(new Error("Operation wrapper", { cause: receipt }))).toEqual({
      failure,
      pending: true,
    });
  },
);

test("inherited properties cannot mint cleanup uncertainty or pending ownership", () => {
  expect(ownedProcessCleanupReceipt(Object.create({ cleanupFailure: undefined }))).toBeUndefined();
  const receipt: object = Object.create({ cleanupPending: true });
  Object.defineProperty(receipt, "cleanupFailure", { value: undefined });
  expect(ownedProcessCleanupReceipt(receipt)).toEqual({ failure: undefined, pending: false });
});

test("ordinary failures and cyclic causes do not manufacture an owned receipt", () => {
  const error = Object.assign(new Error("Invented absent file"), { code: "ENOENT" });
  Object.defineProperty(error, "cause", { value: error });
  for (const value of [error, undefined, null, "interrupted", 0])
    expect(ownedProcessCleanupReceipt(value)).toBeUndefined();
});
