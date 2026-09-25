// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isTlsCertError } from "./tofu.js";

// Boundary test that pins the EXACT depth cutoff in isTlsCertError. The guard
// is `depth > 10` — the recursion may inspect a node sitting at depth === 10
// but must bail before depth 11. A TLS code parked at exactly depth 10 is the
// single fixture that distinguishes `> 10` (current: still inspected → true)
// from `>= 10` (mutant: bailed early → false).

describe("isTlsCertError — depth cutoff boundary", () => {
  /**
   * Build a cause chain whose leaf carries a TLS code, wrapped `wraps` times.
   * The outermost wrapper is visited at depth 0, so the TLS leaf is reached at
   * depth === wraps.
   */
  function wrapTlsLeaf(wraps: number): unknown {
    let err: unknown = { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
    for (let i = 0; i < wraps; i++) {
      err = { code: "ERR_WRAP", cause: err };
    }
    return err;
  }

  test("discovers a TLS code sitting at exactly depth 10 (inclusive upper bound)", () => {
    // TLS leaf reached at depth === 10. Guard `depth > 10` is false at 10, so
    // the code IS inspected and matched → true. A `depth >= 10` mutant bails at
    // depth 10 before inspecting the code → false.
    expect(isTlsCertError(wrapTlsLeaf(10))).toBe(true);
  });

  test("does not discover a TLS code one hop past the budget (depth 11)", () => {
    // TLS leaf reached at depth === 11. Guard `depth > 10` is true at 11, so
    // the recursion bails before inspecting the leaf → false. This pins the
    // upper edge: depth 10 is inspected, depth 11 is not.
    expect(isTlsCertError(wrapTlsLeaf(11))).toBe(false);
  });
});
