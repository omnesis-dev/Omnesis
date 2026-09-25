// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { validateAuthAccounts } from "./auth-subprocess-result.js";

test("first connection and renewal preserve all reported accounts", () => {
  expect(validateAuthAccounts(["one", "two"])).toEqual(["one", "two"]);
  expect(validateAuthAccounts(["one", "two"], "two")).toEqual(["one", "two"]);
});

test("a renewal cannot succeed as a different account", () => {
  expect(() => validateAuthAccounts(["two"], "one")).toThrow(
    expect.objectContaining({ code: "identity-mismatch" }),
  );
});

test("empty and malformed identities cannot be announced", () => {
  expect(() => validateAuthAccounts([])).toThrow("no account");
  expect(() => validateAuthAccounts(["../unsafe"])).toThrow();
});
