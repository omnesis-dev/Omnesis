// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Activation reaches the wire: a certificate the lifecycle activates through
 * `https.Server.setSecureContext` is what the next client handshake sees,
 * with the server never restarted and its listening socket untouched.
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { afterAll, expect, test } from "vitest";
import { generateSelfSigned } from "../tls.js";
import { TlsLifecycleService } from "./service.js";
import type { AddressInfo } from "node:net";

const configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-activation-"));
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // The test reads the presented leaf; there is nothing to verify it against.
    const socket = connect(
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      { host: "127.0.0.1", port, rejectUnauthorized: false },
      () => {
        const fingerprint = socket.getPeerCertificate().fingerprint256;
        socket.destroy();
        resolve(fingerprint.replace(/:/gu, "").toLowerCase());
      },
    );
    socket.on("error", reject);
  });
}

test("a certificate activated by the lifecycle is the one the next handshake presents", async () => {
  const first = generateSelfSigned();
  const second = generateSelfSigned();
  mkdirSync(join(configDir, "tls"), { recursive: true });
  writeFileSync(join(configDir, "tls", "cert.pem"), first.cert);
  writeFileSync(join(configDir, "tls", "key.pem"), first.key);

  const server = createServer({ cert: first.cert, key: first.key }, (_req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const service = new TlsLifecycleService({
      configDir,
      initial: { cert: first.cert, key: first.key },
      activate: (material) => server.setSecureContext(material),
      materialPaths: () => ({}),
      requiredHosts: () => ["localhost"],
      minter: { mint: async () => second },
      settings: () => ({ autoRenew: true, renewBeforeDays: 30 }),
    });
    expect(await servedFingerprint(port)).toBe(first.fingerprintSha256);

    // Renewed in-process: the wire follows without a restart.
    const outcome = await service.renew(new AbortController().signal, { force: true });
    expect(outcome.ok).toBe(true);
    expect(await servedFingerprint(port)).toBe(second.fingerprintSha256);

    // Replaced on disk by another tool, then picked up by a tick.
    const third = generateSelfSigned();
    writeFileSync(join(configDir, "tls", "cert.pem"), third.cert);
    writeFileSync(join(configDir, "tls", "key.pem"), third.key);
    await service.refresh(new AbortController().signal);
    expect(await servedFingerprint(port)).toBe(third.fingerprintSha256);
    expect(service.fingerprintSha256()).toBe(third.fingerprintSha256);
  } finally {
    server.close();
  }
}, 30_000);
