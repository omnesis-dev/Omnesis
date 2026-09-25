// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Flag resolution for `omnesis doctor`.
 *
 * The checks themselves are evaluated by the shared `evaluateDoctor()` in
 * `@omnesis/core/doctor` and are covered by that package's
 * `doctor/checks.test.ts`, which both this command and the gateway's
 * `/admin/doctor` route depend on.
 */

import { describe, test, expect } from "vitest";
import { resolveIncludeSecurity } from "./doctor.js";

describe("resolveIncludeSecurity", () => {
  test("security posture is included by default — no flag needed", () => {
    expect(resolveIncludeSecurity({})).toBe(true);
  });

  test("--no-security opts out (e.g. an operational-only health script)", () => {
    expect(resolveIncludeSecurity({ "no-security": true })).toBe(false);
  });

  test("--fix-permissions still runs the security checks even with --no-security", () => {
    expect(resolveIncludeSecurity({ "no-security": true, "fix-permissions": true })).toBe(true);
  });
});
