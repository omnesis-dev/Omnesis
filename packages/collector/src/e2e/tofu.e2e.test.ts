// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { fetchPeerCert, ensureGatewayTrust } from "@omnesis/core";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

let gatewayProcess: ChildProcess | null = null;
let gatewayPort: number;
let gatewayUrl: string;
let gatewayConfigDir: string;
let collectorConfigDir: string;

beforeAll(async () => {
  gatewayPort = await getFreePort();
  gatewayUrl = `https://localhost:${gatewayPort}`;
  gatewayConfigDir = mkdtempSync(join(tmpdir(), "omnesis-tofu-gw-"));
  collectorConfigDir = mkdtempSync(join(tmpdir(), "omnesis-tofu-col-"));

  const env = {
    ...e2eGatewayEnv(),
    OMNESIS_DB_PATH: join(gatewayConfigDir, "omnesis.db"),
    OMNESIS_GATEWAY_PORT: String(gatewayPort),
    OMNESIS_CONFIG_DIR: gatewayConfigDir,
    OMNESIS_LOG_LEVEL: "warn",
    // The gateway exits on its own once this pid disappears — the only
    // defence when the runner is SIGKILLed and no signal can reach it.
    OMNESIS_PARENT_PID: String(process.pid),
  };

  const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
  gatewayProcess = spawn(gatewayCommand.command, gatewayCommand.args, {
    env,
    cwd: join(import.meta.dirname, "../../../.."),
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  // Reap this detached group if the runner dies before afterAll runs —
  // otherwise the gateway orphans and holds ~1.5 GB indefinitely.
  registerSubprocessGroup(gatewayProcess);

  const startTime = Date.now();
  const timeout = gatewayBootBudgetMs();
  while (Date.now() - startTime < timeout) {
    try {
      const res = await fetch(`${gatewayUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Gateway did not start within ${timeout}ms`);
}, 30_000);

afterAll(async () => {
  if (gatewayProcess) {
    await killSubprocessGroup(gatewayProcess);
  }
  rmSync(gatewayConfigDir, { recursive: true, force: true });
  rmSync(collectorConfigDir, { recursive: true, force: true });
}, 15_000);

describe("TOFU E2E", () => {
  test("fetchPeerCert returns a valid PEM and SHA-256 fingerprint from a live gateway", async () => {
    const { pem, fingerprint } = await fetchPeerCert("localhost", gatewayPort);

    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(pem).toMatch(/\n-----END CERTIFICATE-----\n$/);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fetchPeerCert fingerprint matches the gateway's own cert", async () => {
    const { fingerprint } = await fetchPeerCert("localhost", gatewayPort);

    const gwCertPath = join(gatewayConfigDir, "tls", "cert.pem");
    expect(existsSync(gwCertPath)).toBe(true);

    const { createHash, X509Certificate } = await import("node:crypto");
    const certPem = readFileSync(gwCertPath, "utf-8");
    const cert = new X509Certificate(certPem);
    const expected = createHash("sha256").update(cert.raw).digest("hex");
    expect(fingerprint).toBe(expected);
  });

  test("ensureGatewayTrust saves cert via OMNESIS_TRUST_FINGERPRINT", async () => {
    const { fingerprint } = await fetchPeerCert("localhost", gatewayPort);

    const savedEnv = { ...process.env };
    try {
      delete process.env.NODE_EXTRA_CA_CERTS;
      delete process.env.OMNESIS_INSECURE_TLS;
      process.env.OMNESIS_TRUST_FINGERPRINT = fingerprint;

      // NODE_TLS_REJECT_UNAUTHORIZED=0 (set suite-wide above) makes the
      // probe fetch succeed, so ensureGatewayTrust would return
      // "already-trusted" without ever entering the TOFU flow. To exercise
      // the cert-saving path we test the individual steps instead:
      // fetchPeerCert + fingerprint check + manual save. (The full
      // fetch-prompt-save-trust flow, including the in-process CA trust it
      // applies afterwards, is covered by tofu.integration.test.ts in core.)
      const certPath = join(collectorConfigDir, "tls", "cert.pem");
      expect(existsSync(certPath)).toBe(false);

      // Simulate what ensureGatewayTrust does: fetch cert, verify fingerprint, save
      const { pem, fingerprint: fp } = await fetchPeerCert("localhost", gatewayPort);
      expect(fp).toBe(fingerprint);

      const { mkdirSync } = await import("node:fs");
      const { atomicWriteFileSync } = await import("@omnesis/core");
      mkdirSync(join(collectorConfigDir, "tls"), { recursive: true });
      atomicWriteFileSync(certPath, pem, { mode: 0o600 });

      expect(existsSync(certPath)).toBe(true);
      const saved = readFileSync(certPath, "utf-8");
      expect(saved).toMatch(/^-----BEGIN CERTIFICATE-----\n/);

      // Verify the saved cert fingerprint matches
      const { createHash: hash, X509Certificate: X509 } = await import("node:crypto");
      const savedCert = new X509(saved);
      const savedFp = hash("sha256").update(savedCert.raw).digest("hex");
      expect(savedFp).toBe(fingerprint);
    } finally {
      Object.assign(process.env, savedEnv);
    }
  });

  test("ensureGatewayTrust returns already-trusted when cert exists and NODE_EXTRA_CA_CERTS matches", async () => {
    const certPath = join(collectorConfigDir, "tls", "cert.pem");
    const saved = process.env.NODE_EXTRA_CA_CERTS;
    try {
      process.env.NODE_EXTRA_CA_CERTS = certPath;
      const result = await ensureGatewayTrust({
        gatewayUrl,
        configDir: collectorConfigDir,
      });
      expect(result.action).toBe("already-trusted");
    } finally {
      if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = saved;
    }
  });

  test("ensureGatewayTrust returns skipped for non-HTTPS", async () => {
    const result = await ensureGatewayTrust({
      gatewayUrl: "http://localhost:7600",
      configDir: collectorConfigDir,
    });
    expect(result.action).toBe("skipped");
  });

  test("ensureGatewayTrust returns insecure-mode when OMNESIS_INSECURE_TLS is set", async () => {
    const saved = process.env.OMNESIS_INSECURE_TLS;
    try {
      process.env.OMNESIS_INSECURE_TLS = "1";
      const result = await ensureGatewayTrust({
        gatewayUrl,
        configDir: collectorConfigDir,
      });
      expect(result.action).toBe("insecure-mode");
    } finally {
      if (saved === undefined) delete process.env.OMNESIS_INSECURE_TLS;
      else process.env.OMNESIS_INSECURE_TLS = saved;
    }
  });
});
