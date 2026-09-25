// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Flags declared with a leading `no-` reach the code through citty, and citty
 * reads any `--no-x` as a negation of `x`. So `--no-security` arrives as
 * `security: false`, never as `args["no-security"]` — and a flag read only
 * under its declared key is silently inert on a real command line.
 *
 * Every earlier test of these flags passed an object literal
 * (`resolveIncludeSecurity({ "no-security": true })`), a shape the parser
 * cannot produce, so all of them passed while `omnesis doctor --no-security`
 * did nothing. These tests go THROUGH the parser, which is the only way this
 * class of defect is visible.
 *
 * Observed before the fix, on a real install:
 *   doctor --json                 -> 7 security.* checks
 *   doctor --json --no-security   -> 7 security.* checks   (flag ignored)
 */

import { describe, test, expect } from "vitest";
import { parseArgs } from "citty";
import { resolveIncludeSecurity } from "./commands/doctor.js";
import { noKeyringRequested } from "./service/hardened-bootstrap.js";

/** What the command actually receives when an operator types these words. */
function parsed(argv: string[], def: Record<string, { type: "boolean" | "string" }>) {
  return parseArgs(argv, def) as Record<string, unknown>;
}

describe("citty turns a declared no-* flag into a negation", () => {
  test("--no-security does not arrive under its declared key", () => {
    const args = parsed(["--no-security"], { "no-security": { type: "boolean" } });
    expect(args["no-security"]).toBeUndefined();
    expect(args.security).toBe(false);
  });

  test("--no-keyring does not arrive under its declared key", () => {
    const args = parsed(["--no-keyring"], { "no-keyring": { type: "boolean" } });
    expect(args["no-keyring"]).toBeUndefined();
    expect(args.keyring).toBe(false);
  });
});

describe("doctor --no-security, through the parser", () => {
  test("opts out of the security posture", () => {
    const args = parsed(["--no-security"], { "no-security": { type: "boolean" } });
    expect(resolveIncludeSecurity(args)).toBe(false);
  });

  test("the security posture is still included when the flag is absent", () => {
    const args = parsed([], { "no-security": { type: "boolean" } });
    expect(resolveIncludeSecurity(args)).toBe(true);
  });

  test("--fix-permissions still wins over --no-security", () => {
    const args = parsed(["--no-security", "--fix-permissions"], {
      "no-security": { type: "boolean" },
      "fix-permissions": { type: "boolean" },
    });
    expect(resolveIncludeSecurity(args)).toBe(true);
  });

  test("a programmatic caller passing the declared key still opts out", () => {
    expect(resolveIncludeSecurity({ "no-security": true })).toBe(false);
  });
});

describe("service install --hardened --no-keyring, through the parser", () => {
  const def = {
    hardened: { type: "boolean" },
    "no-keyring": { type: "boolean" },
  } as const;

  test("is recognised as asking for no encryption at rest", () => {
    const args = parsed(["gateway", "--hardened", "--no-keyring"], { ...def });
    expect(noKeyringRequested(args)).toBe(true);
  });

  test("its absence is not mistaken for asking", () => {
    const args = parsed(["gateway", "--hardened"], { ...def });
    expect(noKeyringRequested(args)).toBe(false);
  });

  test("a programmatic caller passing the declared key is still recognised", () => {
    expect(noKeyringRequested({ "no-keyring": true })).toBe(true);
  });
});
