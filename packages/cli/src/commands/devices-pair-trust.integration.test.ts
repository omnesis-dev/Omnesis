// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis pair --trust-fingerprint` against a real HTTPS gateway serving a
 * real self-signed certificate.
 *
 * The point of the flag is that it VERIFIES rather than merely skips the
 * trust-on-first-sight prompt, so a fake would prove nothing: the assertions
 * below turn on which certificate the socket actually presented. The gateway
 * is a `node:https` server with one route, `POST /devices/pair`.
 *
 * `OMNESIS_CONFIG_DIR` is set before the CLI module is imported, because the
 * pair command resolves its trust store once at import time — and a test that
 * pinned a certificate into the developer's own config directory would be
 * writing to their live install.
 */

import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "omnesis-pair-pin-"));
const configDir = join(directory, "config");
process.env.OMNESIS_CONFIG_DIR = configDir;
delete process.env.OMNESIS_TRUST_FINGERPRINT;
delete process.env.OMNESIS_INSECURE_TLS;

const { redeemPairingCode } = await import("./devices.js");
const { ensureGatewayTrust } = await import("@omnesis/core");

const DEVICE_ID = "3f6a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const TOKEN_ID = "7c8d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const DEVICE_TOKEN = `omn_${"0123456789abcdef".repeat(2)}`;

function generateSelfSignedCert(name: string): {
  certPem: string;
  keyPem: string;
  fingerprint: string;
} {
  const configPath = join(directory, `${name}.cnf`);
  const certPath = join(directory, `${name}-cert.pem`);
  const keyPath = join(directory, `${name}-key.pem`);
  writeFileSync(
    configPath,
    `
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ext

[dn]
CN = fictional-pairing-gateway

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
`.trim(),
  );
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
      "3",
      "-nodes",
      "-config",
      configPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const certPem = readFileSync(certPath, "utf8");
  return {
    certPem,
    keyPem: readFileSync(keyPath, "utf8"),
    fingerprint: new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

async function listenInRange(server: Server): Promise<number> {
  for (let port = 17_740; port <= 17_759; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No free port in 17740-17759");
}

let server: Server;
/**
 * A second gateway, serving the certificate no test ever trusts. The tests
 * above add the first gateway's certificate to this process's CA store, after
 * which its handshake succeeds and `ensureGatewayTrust` short-circuits before
 * reaching the trust-on-first-sight branch. An untrusted host is the only way
 * to exercise that branch in the same process.
 */
let untrustedServer: Server;
let untrustedUrl: string;
let gatewayUrl: string;
let served: ReturnType<typeof generateSelfSignedCert>;
/** A certificate the gateway never serves — the fingerprint of another host. */
let otherCert: ReturnType<typeof generateSelfSignedCert>;
let pairRequests = 0;

beforeAll(async () => {
  served = generateSelfSignedCert("gateway-served");
  otherCert = generateSelfSignedCert("gateway-other");
  server = createServer({ cert: served.certPem, key: served.keyPem }, (request, response) => {
    if (request.url === "/devices/pair") {
      pairRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          device: { id: DEVICE_ID, name: "field-station", kind: "collector" },
          tokenId: TOKEN_ID,
          token: DEVICE_TOKEN,
          scopes: ["read", "write:*"],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  gatewayUrl = `https://127.0.0.1:${await listenInRange(server)}`;

  untrustedServer = createServer(
    { cert: otherCert.certPem, key: otherCert.keyPem },
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  );
  untrustedUrl = `https://127.0.0.1:${await listenInRange(untrustedServer)}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => untrustedServer.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

// Counted per test rather than cumulatively, so a reordering cannot make a
// "the code was never spent" assertion pass for the wrong reason.
beforeEach(() => {
  pairRequests = 0;
  delete process.env.OMNESIS_TRUST_FINGERPRINT;
  delete process.env.OMNESIS_INSECURE_TLS;
});

describe("omnesis pair --trust-fingerprint", () => {
  test("refuses a fingerprint the presented certificate does not match", async () => {
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, `sha256:${otherCert.fingerprint}`),
    ).rejects.toThrow(/fingerprint mismatch/i);
    // Refused before the code was spent: a single-use credential must not be
    // handed to a host that failed to prove who it is.
    expect(pairRequests).toBe(0);
    expect(existsSync(join(configDir, "tls", "cert.pem"))).toBe(false);
  });

  test("refuses anything that is not a SHA-256 fingerprint", async () => {
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, "sha256:beef"),
    ).rejects.toThrow(/not a SHA-256 certificate fingerprint/i);
    expect(pairRequests).toBe(0);
  });

  test("refuses to promise a fingerprint over a connection that has none", async () => {
    // Discovery reads the scheme out of an unauthenticated service record, so
    // `http://` here is a downgrade an attacker can ask for. A pin that the
    // transport cannot possibly keep is a refusal, not a no-op.
    await expect(
      redeemPairingCode(
        gatewayUrl.replace("https://", "http://"),
        "K7QX2M9ZB4",
        configDir,
        `sha256:${served.fingerprint}`,
      ),
    ).rejects.toThrow(/must be addressed over https/i);
    expect(pairRequests).toBe(0);
  });

  test("outranks OMNESIS_INSECURE_TLS", async () => {
    // Otherwise an environment variable already exported for some other reason
    // would silently turn a verified install back into an unverified one.
    process.env.OMNESIS_INSECURE_TLS = "1";
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, otherCert.fingerprint),
    ).rejects.toThrow(/fingerprint mismatch/i);
    expect(pairRequests).toBe(0);
  });

  test("pairs against the matching certificate and pins it for the daemon", async () => {
    const result = await redeemPairingCode(
      gatewayUrl,
      "K7QX2M9ZB4",
      configDir,
      `sha256:${served.fingerprint}`,
    );
    expect(result.device.name).toBe("field-station");
    expect(result.token).toBe(DEVICE_TOKEN);
    expect(pairRequests).toBe(1);
    // The verified certificate is saved, so the collector daemon that starts
    // next trusts the same host without a prompt of its own.
    const saved = readFileSync(join(configDir, "tls", "cert.pem"), "utf8");
    expect(new X509Certificate(saved).fingerprint256.replaceAll(":", "").toLowerCase()).toBe(
      served.fingerprint,
    );
  });

  test("accepts the shapes a fingerprint is pasted in", async () => {
    // Bare hex, and the colon-separated pairs `openssl x509 -fingerprint`
    // prints — the same certificate either way.
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, served.fingerprint.toUpperCase()),
    ).resolves.toMatchObject({ token: DEVICE_TOKEN });
    const colonised = new X509Certificate(served.certPem).fingerprint256;
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, `sha256:${colonised}`),
    ).resolves.toMatchObject({ token: DEVICE_TOKEN });
  });

  test("a pin outranks a certificate already saved from an earlier install", async () => {
    // The saved certificate proves nothing about the host being dialled now,
    // so the pin is checked against what this socket presents regardless.
    await expect(
      redeemPairingCode(gatewayUrl, "K7QX2M9ZB4", configDir, otherCert.fingerprint),
    ).rejects.toThrow(/fingerprint mismatch/i);
  });
});

describe("ensureGatewayTrust without a pin", () => {
  test("still short-circuits on a certificate saved earlier", async () => {
    // The pin is an addition, not a replacement: a call that carries none must
    // behave exactly as it did before there was one to carry.
    const saved = join(configDir, "tls", "cert.pem");
    expect(existsSync(saved)).toBe(true);
    await expect(ensureGatewayTrust({ gatewayUrl, configDir })).resolves.toEqual({
      action: "trusted-in-process",
    });
  });

  test("refuses a malformed OMNESIS_TRUST_FINGERPRINT as malformed", async () => {
    // Folded into the mismatch arm, this read as "the gateway is not the one
    // you meant" when the truth is "you mistyped 60 characters".
    process.env.OMNESIS_TRUST_FINGERPRINT = "sha256:beef";
    await expect(
      ensureGatewayTrust({
        gatewayUrl: untrustedUrl,
        configDir: join(directory, "bad-env-config"),
      }),
    ).rejects.toThrow(/not a SHA-256 certificate fingerprint/i);
  });

  test("accepts OMNESIS_TRUST_FINGERPRINT in the shapes openssl prints it", async () => {
    // The variable predates `--trust-fingerprint` and is now compared through
    // the same normalizer, so a value pasted with colons matches.
    const fresh = join(directory, "env-fingerprint-config");
    const colonised = otherCert.fingerprint.match(/../g)!.join(":").toUpperCase();
    process.env.OMNESIS_TRUST_FINGERPRINT = `sha256:${colonised}`;
    await expect(
      ensureGatewayTrust({ gatewayUrl: untrustedUrl, configDir: fresh }),
    ).resolves.toMatchObject({ action: "trusted-in-process" });
    expect(existsSync(join(fresh, "tls", "cert.pem"))).toBe(true);
  });
});
