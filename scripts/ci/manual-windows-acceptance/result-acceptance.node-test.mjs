// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedManualMode } from "./result-acceptance.mjs";

test("a successful joined application accepts only the completed manual claim", () => {
  const result = {
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "",
  };
  assert.equal(acceptedManualMode(true, result), true);
  assert.equal(acceptedManualMode(false, result), false);
});
for (const failure of ["timeout", "aborted", "spawn"])
  test(`status0 with joined ${failure} remains failed`, () => {
    // Positive cleanup proof and a target's exit0 do not complete a timed-out,
    // canceled or failed command. This is the actual public Job result boundary.
    assert.equal(acceptedManualMode(true, { exitCode: 0, signal: null, failure }), false);
  });
test("explicit uncertainty is retained even with an undefined marker payload", () => {
  for (const cleanupFailure of [undefined, new Error("invented cleanup refusal")])
    assert.equal(acceptedManualMode(true, { exitCode: 0, cleanupFailure }), false);
});
test("ordinary application nonzero remains failed after confirmed cleanup", () => {
  assert.equal(acceptedManualMode(true, { exitCode: 7 }), false);
});
