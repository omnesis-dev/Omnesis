// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { runFixtureOpenSsl } from "./fixture-openssl.mjs";
import type { OwnedChildProcess } from "@omnesis/core";

const waitingServer = ["s_server", "-accept", "127.0.0.1:0", "-nocert", "-quiet", "-ign_eof"];

test("actual fixture crypto produces a verifiable certificate before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-qa-crypto-"));
  let owner: OwnedChildProcess | undefined;
  let failure: unknown;
  let failed = false;
  try {
    await runFixtureOpenSsl(
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=fixture.example.test",
      ],
      {},
      (current) => {
        owner = current;
      },
    );
    expect(owner?.joinedConfirmed).toBe(true);
    const certificate = new X509Certificate(await readFile(join(directory, "cert.pem")));
    expect(certificate.verify(certificate.publicKey)).toBe(true);
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    await owner?.stop();
    if (owner && !owner.joinedConfirmed) throw new Error("Owned fixture crypto has not joined");
  } catch (cleanupError) {
    throw Object.assign(
      new AggregateError(
        failed ? [failure, cleanupError] : [cleanupError],
        "Fixture crypto test cleanup is unconfirmed",
        { cause: cleanupError },
      ),
      { cleanupFailure: "qa-crypto-test" },
    );
  }
  if (failed && ownedProcessCleanupReceipt(failure)) throw failure;
  await rm(directory, { recursive: true, force: true });
  if (failed) throw failure;
}, 20000);

test.each(["deadline", "cancelled"] as const)(
  "real waiting OpenSSL %s physically joins before refusal",
  async (mode) => {
    const controller = new AbortController();
    let owner: OwnedChildProcess | undefined;
    let actualClose = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = runFixtureOpenSsl(
        waitingServer,
        {
          timeoutMs: mode === "deadline" ? 250 : 10000,
          signal: controller.signal,
        },
        (current) => {
          owner = current;
          current.child.once("close", () => {
            actualClose = true;
          });
          if (mode === "cancelled")
            void current.ready.then(
              () => {
                timer = setTimeout(() => controller.abort(), 100);
              },
              () => {},
            );
        },
      );
      await expect(result).rejects.toThrow(`Fixture crypto ${mode}; child joined`);
      expect(actualClose).toBe(true);
      expect(owner?.joinedConfirmed).toBe(true);
      expect(owner?.child.exitCode !== null || owner?.child.signalCode !== null).toBe(true);
    } finally {
      clearTimeout(timer);
      await owner?.stop();
      expect(owner?.joinedConfirmed).toBe(true);
    }
  },
  12000,
);

test("actual crypto output above the bound is discarded and physically joined", async () => {
  let owner: OwnedChildProcess | undefined;
  try {
    await expect(
      runFixtureOpenSsl(["rand", "131072"], {}, (current) => {
        owner = current;
      }),
    ).rejects.toThrow("Fixture crypto output; child joined");
    expect(owner?.joinedConfirmed).toBe(true);
  } finally {
    await owner?.stop();
    expect(owner?.joinedConfirmed).toBe(true);
  }
});
