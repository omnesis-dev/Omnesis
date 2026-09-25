// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A client whose saved copy of the gateway certificate is stale, against a
 * real HTTPS server that rotates its certificate in place. The saved copy is
 * followed when the advertised fingerprint names the new certificate, and
 * refused — with both fingerprints — when nothing does.
 *
 * Runs under the vitest forks pool, so the CA-store mutation is confined to
 * this file's process.
 */

import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ensureGatewayTrust, GatewayCertificateChangedError, retrustGateway } from "./tofu.js";

const dir = mkdtempSync(join(tmpdir(), "omnesis-tofu-rotation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mint(
  name: string,
  sans: string[] = ["DNS:localhost", "IP:127.0.0.1"],
  days = 3,
): { cert: string; key: string; fingerprint: string } {
  const cnf = join(dir, `${name}.cnf`);
  writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = ${sans.join(", ")}`,
    ].join("\n"),
  );
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(days),
      "-nodes",
      "-config",
      cnf,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const cert = readFileSync(certPath, "utf8");
  return {
    cert,
    key: readFileSync(keyPath, "utf8"),
    fingerprint: createHash("sha256").update(new X509Certificate(cert).raw).digest("hex"),
  };
}

const first = mint("first");
const second = mint("second");
const third = mint("third");
const savedEnv = process.env.OMNESIS_TRUST_FINGERPRINT;
let server: Server;
let gatewayUrl: string;
let configDir: string;

beforeAll(async () => {
  server = createServer({ cert: first.cert, key: first.key }, (_req, res) => {
    // No keep-alive: every request handshakes against the certificate served
    // now, which is the behaviour under test.
    res.setHeader("connection", "close");
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  gatewayUrl = `https://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

beforeAll(() => {
  configDir = join(dir, "client");
  mkdirSync(join(configDir, "tls"), { recursive: true });
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OMNESIS_TRUST_FINGERPRINT;
  else process.env.OMNESIS_TRUST_FINGERPRINT = savedEnv;
});

describe("a saved certificate the gateway no longer serves", () => {
  test("is applied without a probe by default, and follows the rotation when the advertised fingerprint names the new one", async () => {
    writeFileSync(join(configDir, "tls", "cert.pem"), first.cert);
    expect(await ensureGatewayTrust({ gatewayUrl, configDir })).toEqual({
      action: "trusted-in-process",
    });
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);

    server.setSecureContext({ cert: second.cert, key: second.key });
    await expect(fetch(`${gatewayUrl}/health`)).rejects.toThrow();

    // The default path still only re-applies the saved copy.
    expect(await ensureGatewayTrust({ gatewayUrl, configDir })).toEqual({
      action: "trusted-in-process",
    });

    await expect(ensureGatewayTrust({ gatewayUrl, configDir, verifyServed: true })).rejects.toThrow(
      GatewayCertificateChangedError,
    );
    try {
      await ensureGatewayTrust({ gatewayUrl, configDir, verifyServed: true });
    } catch (err) {
      const changed = err as GatewayCertificateChangedError;
      expect(changed.savedFingerprint).toBe(first.fingerprint);
      expect(changed.servedFingerprint).toBe(second.fingerprint);
      expect(changed.message).toContain(`omnesis tls trust --fingerprint ${second.fingerprint}`);
    }
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(first.cert);

    process.env.OMNESIS_TRUST_FINGERPRINT = `sha256:${second.fingerprint}`;
    const followed = await ensureGatewayTrust({ gatewayUrl, configDir, verifyServed: true });
    expect(followed).toEqual({ action: "trusted-in-process", certPem: second.cert });
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(second.cert);
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);
  });

  test("an advertised fingerprint that names some other certificate is not followed", async () => {
    // The process CA store only ever grows, so the served certificate must be
    // one no earlier step trusted.
    server.setSecureContext({ cert: third.cert, key: third.key });
    writeFileSync(join(configDir, "tls", "cert.pem"), first.cert);
    process.env.OMNESIS_TRUST_FINGERPRINT = "ab".repeat(32);
    await expect(ensureGatewayTrust({ gatewayUrl, configDir, verifyServed: true })).rejects.toThrow(
      GatewayCertificateChangedError,
    );
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(first.cert);
  });
});

describe("a fingerprint learned from discovery", () => {
  test("trusts on first sight and never moves trust that exists", async () => {
    const freshDir = join(dir, "fresh-client");
    mkdirSync(join(freshDir, "tls"), { recursive: true });
    server.setSecureContext({ cert: third.cert, key: third.key });
    // Discovery claims a certificate that is not the served one: refused.
    await expect(
      ensureGatewayTrust({
        gatewayUrl,
        configDir: freshDir,
        discoveredFingerprint: "ab".repeat(32),
      }),
    ).rejects.toThrow(/fingerprint mismatch/u);
    // The truthful one is accepted, because nothing was saved yet.
    expect(
      await ensureGatewayTrust({
        gatewayUrl,
        configDir: freshDir,
        discoveredFingerprint: third.fingerprint,
      }),
    ).toEqual({ action: "trusted-in-process" });
    expect(readFileSync(join(freshDir, "tls", "cert.pem"), "utf8")).toBe(third.cert);

    // A rotation the network vouches for is still refused. The process CA
    // store already holds every certificate trusted above, so the rotated one
    // has to be one it has never seen.
    const fourth = mint("fourth");
    server.setSecureContext({ cert: fourth.cert, key: fourth.key });
    await expect(
      ensureGatewayTrust({
        gatewayUrl,
        configDir: freshDir,
        discoveredFingerprint: fourth.fingerprint,
        verifyServed: true,
      }),
    ).rejects.toThrow(GatewayCertificateChangedError);
    expect(readFileSync(join(freshDir, "tls", "cert.pem"), "utf8")).toBe(third.cert);
  });
});

describe("refusals name their cause", () => {
  test("a saved certificate that does not cover the name it is addressed by is a hostname problem, not expiry", async () => {
    const narrow = mint("narrow", ["DNS:localhost"]);
    server.setSecureContext({ cert: narrow.cert, key: narrow.key });
    const narrowDir = join(dir, "narrow-client");
    mkdirSync(join(narrowDir, "tls"), { recursive: true });
    writeFileSync(join(narrowDir, "tls", "cert.pem"), narrow.cert);
    // The gateway is addressed by 127.0.0.1, which this certificate lacks.
    await expect(
      ensureGatewayTrust({ gatewayUrl, configDir: narrowDir, verifyServed: true }),
    ).rejects.toThrow(/does not cover the name 127\.0\.0\.1/u);
  });

  test("an expired certificate is never offered for first-sight trust", async () => {
    // This OpenSSL cannot mint a certificate that is already expired, so the
    // probe's verdict is stood in for: what matters is that the flow stops
    // before it fetches, prompts, or saves anything.
    const expiredDir = join(dir, "expired-client");
    mkdirSync(join(expiredDir, "tls"), { recursive: true });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        Object.assign(new Error("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
      );
    try {
      await expect(
        ensureGatewayTrust({
          gatewayUrl,
          configDir: expiredDir,
          discoveredFingerprint: first.fingerprint,
        }),
      ).rejects.toThrow(/has expired.*Renew it on the gateway host/u);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(existsSync(join(expiredDir, "tls", "cert.pem"))).toBe(false);
  });
});

describe("retrustGateway", () => {
  test("with the served fingerprint, replaces the saved copy; with another, refuses and keeps it", async () => {
    server.setSecureContext({ cert: first.cert, key: first.key });
    writeFileSync(join(configDir, "tls", "cert.pem"), second.cert);

    await expect(
      retrustGateway({ gatewayUrl, configDir, expectedFingerprint: second.fingerprint }),
    ).rejects.toThrow(/fingerprint mismatch/u);
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(second.cert);

    const result = await retrustGateway({
      gatewayUrl,
      configDir,
      expectedFingerprint: `SHA256:${first.fingerprint.toUpperCase()}`,
    });
    expect(result).toEqual({
      fingerprint: first.fingerprint,
      previousFingerprint: second.fingerprint,
      certPath: join(configDir, "tls", "cert.pem"),
    });
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(first.cert);
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);
  });

  test("without a fingerprint and without a terminal, says what to run", async () => {
    await expect(retrustGateway({ gatewayUrl, configDir })).rejects.toThrow(
      new RegExp(`omnesis tls trust --fingerprint ${first.fingerprint}`, "u"),
    );
  });
});
