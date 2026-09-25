// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseCommand } from "./args.mjs";

const spec = {
  wait: {
    values: ["url", "key"],
    numbers: ["timeout"],
    booleans: ["quiet"],
    required: ["url", "key"],
  },
  get: { values: ["url", "key"] },
};

describe("parseCommand", () => {
  it("parses values, numbers and booleans for the named command", () => {
    expect(
      parseCommand(
        ["wait", "--url", "http://x", "--key", "code", "--timeout", "30", "--quiet"],
        spec,
      ),
    ).toEqual({
      command: "wait",
      flags: { url: "http://x", key: "code", timeout: 30, quiet: true },
    });
  });

  it("refuses an unknown command, including inherited object keys", () => {
    expect(() => parseCommand(["serve"], spec)).toThrow(/usage: <wait\|get>/);
    expect(() => parseCommand(["toString"], spec)).toThrow(/usage/);
    expect(() => parseCommand([], spec)).toThrow(/usage/);
  });

  it("refuses a misspelt flag, a flag of another command and a stray argument", () => {
    expect(() => parseCommand(["get", "--ulr", "x"], spec)).toThrow(/unknown flag --ulr/);
    expect(() => parseCommand(["get", "--timeout", "3"], spec)).toThrow(/unknown flag --timeout/);
    expect(() => parseCommand(["get", "x"], spec)).toThrow(/unexpected argument x/);
  });

  it("refuses a missing value, a non-numeric or negative number, and a missing required flag", () => {
    expect(() => parseCommand(["get", "--url"], spec)).toThrow(/--url needs a value/);
    expect(() =>
      parseCommand(["wait", "--url", "u", "--key", "k", "--timeout", "abc"], spec),
    ).toThrow(/non-negative number, got abc/);
    expect(() =>
      parseCommand(["wait", "--url", "u", "--key", "k", "--timeout", "-1"], spec),
    ).toThrow(/non-negative number/);
    expect(() =>
      parseCommand(["wait", "--url", "u", "--key", "k", "--timeout", " "], spec),
    ).toThrow(/non-negative number/);
    expect(() => parseCommand(["wait", "--url", "u"], spec)).toThrow(/--key is required/);
  });
});
