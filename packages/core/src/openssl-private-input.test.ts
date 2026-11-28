// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, X509Certificate, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runOpenSslWithPrivateInput } from "./openssl-private-input.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.skipIf(process.platform === "win32")(
  "actual OpenSSL receives an in-memory key through a real pipe without private files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-cert-pipe-"));
    directories.push(directory);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const path = join(directory, "certificate.pem");
    const config = join(directory, "inherited.cnf");
    await writeFile(
      config,
      "openssl_conf=fixture\n[fixture]\nproviders=missing\n[missing]\nbroken=broken\n[broken]\nmodule=/missing-fixture-module\nactivate=1\n",
    );
    vi.stubEnv("OPENSSL_CONF", config);
    vi.stubEnv("OPENSSL_MODULES", "/missing-fixture-modules");
    vi.stubEnv("OPENSSL_ENGINES", "/missing-fixture-engines");
    await runOpenSslWithPrivateInput(
      [
        "req",
        "-new",
        "-x509",
        "-key",
        "/dev/stdin",
        "-out",
        path,
        "-days",
        "1",
        "-subj",
        "/CN=fixture.example.test",
      ],
      Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })),
    );
    const certificate = new X509Certificate(await readFile(path));
    expect(certificate.publicKey.export({ type: "spki", format: "der" })).toEqual(
      createPublicKey(privateKey).export({ type: "spki", format: "der" }),
    );
    expect(await readdir(directory)).toEqual(["certificate.pem", "inherited.cnf"]);
  },
);

test.skipIf(process.platform === "win32")(
  "arguments remain literal and rejected secret input never reaches errors",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-cert-pipe-"));
    directories.push(directory);
    const marker = join(directory, "must-not-exist");
    const error = await runOpenSslWithPrivateInput(
      ["req", "-new", "-key", "/dev/stdin", "-subj", `$(touch ${marker})`],
      Buffer.from("fixture-secret-material"),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("fixture-secret-material");
    expect(await readdir(directory)).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "cancellation drains an actual owned pipeline within its bound",
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await expect(
        runOpenSslWithPrivateInput(
          ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:16384"],
          Buffer.from("fixture-input"),
          { signal: controller.signal },
        ),
      ).rejects.toThrow("cancelled");
    } finally {
      clearTimeout(timer);
    }
  },
  8_000,
);
