// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This entry is emitted beside the compiled production helper in the fixture.
const { runOpenSslWithPrivateInput } = await import(
  new URL("./openssl-private-input.js", import.meta.url).href
);

const directory = await mkdtemp(join(tmpdir(), "omnesis-native-private-key-"));
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const key = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
const certificate = join(directory, "public-certificate.pem");
const args = [
  "req",
  "-x509",
  "-new",
  "-key",
  "/dev/stdin",
  "-sha256",
  "-days",
  "1",
  "-subj",
  "/CN=fixture.example.test",
  "-out",
  certificate,
];
try {
  await runOpenSslWithPrivateInput(args, key);
  assert.equal(new X509Certificate(await readFile(certificate)).verify(publicKey), true);
  assert.deepEqual(await readdir(directory), ["public-certificate.pem"]);
  assert.equal((await readFile(certificate, "utf8")).includes("PRIVATE KEY"), false);

  const cancelled = join(directory, "cancelled.pem");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runOpenSslWithPrivateInput([...args.slice(0, -1), cancelled], key, {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await assert.rejects(stat(cancelled), { code: "ENOENT" });

  const sentinel = "Invented private certificate input must never enter diagnostics";
  await assert.rejects(runOpenSslWithPrivateInput(args, Buffer.from(sentinel)), (error) => {
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
  process.stdout.write("private-key-pipe:passed\n");
} finally {
  key.fill(0);
  await rm(directory, { recursive: true, force: true });
}
