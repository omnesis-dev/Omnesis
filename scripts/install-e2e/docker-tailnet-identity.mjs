// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// Runs inside the exact image. Only hashes and public certificate metadata leave.
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { join } from "node:path";

export function inspectIdentity(configDir, certificatePath, expectedPin) {
  const database = join(configDir, "omnesis.db");
  assert(statSync(database).isFile() && statSync(database).size >= 16, "nonempty database");
  const descriptor = openSync(database, "r"),
    header = Buffer.alloc(16);
  try {
    assert.equal(readSync(descriptor, header, 0, 16, 0), 16);
  } finally {
    closeSync(descriptor);
  }
  assert.notEqual(header.toString(), "SQLite format 3\0", "database encrypted at rest");
  const bounded = (path) => {
    assert(
      statSync(path).isFile() && statSync(path).size > 0 && statSync(path).size <= 65536,
      "bounded identity file",
    );
    return readFileSync(path);
  };
  const token = bounded(join(configDir, "token"));
  const mainKey = bounded(join(configDir, "keyring/storage-keys/main-db.json"));
  for (const [raw, marker] of [
    [token, "omnesis.secret-file"],
    [mainKey, "omnesis.storage-key"],
  ]) {
    let envelope;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      throw new Error("identity artifact is not an encrypted envelope");
    }
    assert(
      envelope && typeof envelope === "object" && envelope.omnesis === marker,
      "wrapped identity envelope",
    );
    assert(envelope.version === 1, "known identity envelope version");
    assert(envelope.alg === "aes-256-gcm", "encrypted identity algorithm");
    assert(typeof envelope.ciphertext === "string" && envelope.ciphertext.length > 0);
    if (marker === "omnesis.storage-key")
      assert(envelope.keyName === "main-db", "main database key identity");
    else assert(envelope.scope === "config:token", "bootstrap token scope");
  }
  const certificate = bounded(certificatePath);
  const pin =
    "sha256:" + new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
  assert.equal(pin, expectedPin, "mounted certificate matches verified endpoint pin");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return { token: hash(token), mainKey: hash(mainKey), certificate: hash(certificate), pin };
}
if (process.argv[1] === "-") {
  console.log(
    JSON.stringify(inspectIdentity("/var/lib/omnesis", "/run/t3-tls/cert.pem", process.argv[2])),
  );
}
