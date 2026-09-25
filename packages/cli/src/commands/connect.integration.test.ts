// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { buildTlsTrust } from "./connect.js";
import type { IncomingMessage, ServerResponse } from "node:http";

function generateSelfSignedCert(
  directory: string,
  name: string,
): {
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
CN = fictional-connect-gateway

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
  for (let port = 17_720; port <= 17_739; port += 1) {
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
  throw new Error("No free port in 17720-17739");
}

let directory: string;
let configDirectory: string;
let server: Server;
let gatewayUrl: string;
let fingerprint: string;
let originalCertificate: ReturnType<typeof generateSelfSignedCert>;
let rotatedCertificate: ReturnType<typeof generateSelfSignedCert>;
let previousTrustFingerprint: string | undefined;
let healthRequests = 0;
let healthStatus = 200;

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === "/health") healthRequests += 1;
  response.writeHead(healthStatus, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok" }));
}

/**
 * Put the gateway on a given certificate, keeping its address. Which
 * certificate is being served is what every test here is about, so a block
 * that depends on one says so rather than inheriting whatever ran before it.
 */
async function serveCertificate(
  certificate: ReturnType<typeof generateSelfSignedCert>,
): Promise<void> {
  const port = Number(new URL(gatewayUrl).port);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createServer({ cert: certificate.certPem, key: certificate.keyPem }, handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-connect-tls-"));
  configDirectory = join(directory, "config");
  originalCertificate = generateSelfSignedCert(directory, "gateway-a");
  rotatedCertificate = generateSelfSignedCert(directory, "gateway-b");
  fingerprint = originalCertificate.fingerprint;
  server = createServer(
    { cert: originalCertificate.certPem, key: originalCertificate.keyPem },
    handleRequest,
  );
  gatewayUrl = `https://127.0.0.1:${await listenInRange(server)}`;
  previousTrustFingerprint = process.env.OMNESIS_TRUST_FINGERPRINT;
  process.env.OMNESIS_TRUST_FINGERPRINT = fingerprint;
}, 30_000);

// Several tests set this deliberately; restoring it keeps one test's shortcut
// from becoming the next one's silent precondition.
afterEach(() => {
  process.env.OMNESIS_TRUST_FINGERPRINT = fingerprint;
});

afterAll(async () => {
  if (previousTrustFingerprint === undefined) {
    delete process.env.OMNESIS_TRUST_FINGERPRINT;
  } else {
    process.env.OMNESIS_TRUST_FINGERPRINT = previousTrustFingerprint;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe("connect TLS ceremony", () => {
  test("trusts a live self-signed gateway before health verification and pins the same leaf", async () => {
    const trust = await buildTlsTrust(gatewayUrl, configDirectory);

    expect(trust).toMatchObject({ leafFingerprintSha256: fingerprint });
    expect(trust?.caPem).toContain("BEGIN CERTIFICATE");
    expect(readFileSync(join(configDirectory, "tls", "cert.pem"), "utf8")).toBe(trust?.caPem);
    expect(healthRequests).toBe(1);
  });

  test("requires an exact fingerprint to rotate the saved pin, then replaces it atomically", async () => {
    await serveCertificate(rotatedCertificate);

    process.env.OMNESIS_TRUST_FINGERPRINT = fingerprint;
    await expect(buildTlsTrust(gatewayUrl, configDirectory)).rejects.toThrow(
      /rotation fingerprint mismatch/,
    );
    expect(readFileSync(join(configDirectory, "tls", "cert.pem"), "utf8")).not.toBe(
      rotatedCertificate.certPem,
    );

    process.env.OMNESIS_TRUST_FINGERPRINT = rotatedCertificate.fingerprint;
    healthStatus = 503;
    await expect(buildTlsTrust(gatewayUrl, configDirectory)).rejects.toThrow(
      /health check failed with HTTP 503/,
    );
    expect(readFileSync(join(configDirectory, "tls", "cert.pem"), "utf8")).not.toBe(
      rotatedCertificate.certPem,
    );

    healthStatus = 200;
    const rotated = await buildTlsTrust(gatewayUrl, configDirectory);
    expect(rotated).toEqual({
      caPem: rotatedCertificate.certPem,
      leafFingerprintSha256: rotatedCertificate.fingerprint,
    });
    expect(readFileSync(join(configDirectory, "tls", "cert.pem"), "utf8")).toBe(
      rotatedCertificate.certPem,
    );
    expect(healthRequests).toBe(3);
  });
});

describe("connect certificate pin", () => {
  /** A config directory of its own, so one pin cannot inherit another's trust. */
  function freshConfigDirectory(name: string): string {
    return join(directory, `config-${name}`);
  }

  // Which certificate is served is the subject of every test below, so it is
  // set here rather than inherited from whatever ran before.
  beforeAll(async () => {
    await serveCertificate(rotatedCertificate);
  });

  test("verifies the certificate actually presented, outranking the environment", async () => {
    // The server serves the rotated certificate by now, and the environment
    // still names the original. A pin is a claim about which gateway is on the
    // other end, so it is the pin that decides — in both directions.
    process.env.OMNESIS_TRUST_FINGERPRINT = fingerprint;
    const trust = await buildTlsTrust(gatewayUrl, freshConfigDirectory("match"), {
      expectedFingerprint: `sha256:${rotatedCertificate.fingerprint}`,
    });

    expect(trust).toEqual({
      caPem: rotatedCertificate.certPem,
      leafFingerprintSha256: rotatedCertificate.fingerprint,
    });
    expect(readFileSync(join(freshConfigDirectory("match"), "tls", "cert.pem"), "utf8")).toBe(
      rotatedCertificate.certPem,
    );
  });

  test("a pin naming another certificate refuses before the gateway is asked anything", async () => {
    process.env.OMNESIS_TRUST_FINGERPRINT = rotatedCertificate.fingerprint;
    const preflight = vi.fn(async () => {});

    await expect(
      buildTlsTrust(gatewayUrl, freshConfigDirectory("mismatch"), {
        expectedFingerprint: fingerprint,
        preflight,
      }),
    ).rejects.toThrow(/fingerprint mismatch/);
    expect(preflight).not.toHaveBeenCalled();
    expect(existsSync(join(freshConfigDirectory("mismatch"), "tls", "cert.pem"))).toBe(false);
  });

  test("a pin outranks a saved certificate rather than being shortcut by it", async () => {
    // The saved-certificate path is what makes every later run cheap; a pin has
    // to run before it, or the promise would be kept only on the first run.
    const configuration = freshConfigDirectory("saved");
    mkdirSync(join(configuration, "tls"), { recursive: true });
    writeFileSync(join(configuration, "tls", "cert.pem"), rotatedCertificate.certPem);

    await expect(
      buildTlsTrust(gatewayUrl, configuration, { expectedFingerprint: fingerprint }),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  test("a pin over http:// is refused, because nothing there can keep it", async () => {
    await expect(
      buildTlsTrust("http://127.0.0.1:17740", freshConfigDirectory("plaintext"), {
        expectedFingerprint: fingerprint,
      }),
    ).rejects.toThrow(/must be addressed over https/);
  });

  test("a run the gateway refuses leaves the trust on this host as it was", async () => {
    // The pinned certificate is saved at the end, once the gateway has
    // answered — the same point the unpinned rotation path writes at — so a
    // refusal does not replace the certificate every other command here reads.
    const configuration = freshConfigDirectory("refused");
    mkdirSync(join(configuration, "tls"), { recursive: true });
    writeFileSync(join(configuration, "tls", "cert.pem"), "stale certificate\n");
    healthStatus = 503;
    try {
      await expect(
        buildTlsTrust(gatewayUrl, configuration, {
          expectedFingerprint: rotatedCertificate.fingerprint,
        }),
      ).rejects.toThrow(/health check failed/);
    } finally {
      healthStatus = 200;
    }
    expect(readFileSync(join(configuration, "tls", "cert.pem"), "utf8")).toBe(
      "stale certificate\n",
    );

    const trust = await buildTlsTrust(gatewayUrl, configuration, {
      expectedFingerprint: rotatedCertificate.fingerprint,
    });
    expect(trust?.leafFingerprintSha256).toBe(rotatedCertificate.fingerprint);
    expect(readFileSync(join(configuration, "tls", "cert.pem"), "utf8")).toBe(
      rotatedCertificate.certPem,
    );
  });

  test("a malformed pin is a refusal, not a fingerprint that matches nothing", async () => {
    await expect(
      buildTlsTrust(gatewayUrl, freshConfigDirectory("malformed"), {
        expectedFingerprint: "sha256:beef",
      }),
    ).rejects.toThrow(/Not a SHA-256 certificate fingerprint/);
  });
});
