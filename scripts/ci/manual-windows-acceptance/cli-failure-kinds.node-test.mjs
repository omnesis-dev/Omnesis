// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import test from "node:test";
import { cliFailureKinds, validateCliFailureKinds } from "./cli-failure-kinds.mjs";

test("only fixed categories survive a private child diagnostic", () => {
  const kinds = cliFailureKinds(
    "TypeError: invented-credential-that-must-not-leak; TLS certificate rejected",
  );
  assert.deepEqual(kinds, ["tls", "type"]);
  assert.equal(JSON.stringify(kinds).includes("invented-credential"), false);
});
test("connection and authorization failures remain independently observable", () => {
  assert.deepEqual(cliFailureKinds("Gateway 403: forbidden; ECONNREFUSED"), ["connection", "auth"]);
  assert.deepEqual(cliFailureKinds("invented unclassified diagnostic"), []);
});
test("controller accepts no arbitrary or duplicate category", () => {
  assert.throws(() => validateCliFailureKinds(["invented-private-text"]));
  assert.throws(() => validateCliFailureKinds(["tls", "tls"]));
  assert.deepEqual(validateCliFailureKinds(["private-file"]), ["private-file"]);
});
