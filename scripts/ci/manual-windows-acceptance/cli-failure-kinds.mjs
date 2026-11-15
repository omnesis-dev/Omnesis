// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";

const patterns = [
  ["connection", /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Cannot reach gateway/iu],
  ["tls", /CERT_|certificate|\bTLS\b|\bSSL\b/iu],
  [
    "auth",
    /Gateway 40[13]|unauthorized|forbidden|missing.{0,40}token|no.{0,40}token|admin token|invalid.{0,40}credential/iu,
  ],
  ["type", /TypeError|Cannot read properties|is not a function|is not iterable/iu],
  ["private-file", /EPRIVATE|EACCES|EPERM|private file|keyring|storage key/iu],
  ["config", /configuration|invalid config|missing settings/iu],
  ["syntax", /SyntaxError|Unexpected token/iu],
  ["wrapper", /AUDIT_OWNED_CLI:.{0,256}(?:spawn-failed|control-failed)/u],
];
const allowed = new Set(patterns.map(([kind]) => kind));

/** Fixed categories only; never return any substring from a child's diagnostic. */
export function cliFailureKinds(stderr) {
  assert.equal(typeof stderr, "string");
  return patterns.filter(([, pattern]) => pattern.test(stderr)).map(([kind]) => kind);
}

export function validateCliFailureKinds(value) {
  assert.ok(Array.isArray(value) && value.length <= allowed.size);
  assert.equal(new Set(value).size, value.length);
  assert.ok(value.every((kind) => allowed.has(kind)));
  return [...value];
}
