// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The served certificate's lifecycle against a real gateway: what
 * `/admin/tls` reports about the self-signed pair the gateway minted, a
 * renewal on request that the wire follows without a restart, the pairing
 * code that now carries the rotated fingerprint, material replaced on disk
 * by another tool and activated through `reload`, the real CLI's `tls`
 * commands, and a restart that serves what the renewal wrote.
 *
 * The tests run in declaration order and share one gateway: each rotation
 * is the starting point of the next.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchPeerCert, type TlsLifecycleSnapshot } from "@omnesis/core";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

type RenewOutcome =
  | { ok: true; fingerprintSha256: string; snapshot: TlsLifecycleSnapshot }
  | { ok: false; reason: string; snapshot: TlsLifecycleSnapshot };

describe("tls lifecycle: inspect, renew, activate, restart", () => {
  let harness: MultiCollectorHarness;
  let scratch: string;

  const admin = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${harness.gatewayUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${harness.bootstrapToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const onTheWire = async (): Promise<string> =>
    (await fetchPeerCert("localhost", harness.gatewayPort)).fingerprint;
  const onDisk = (): string =>
    readFileSync(join(harness.gatewayConfigDir, "tls", "cert.pem"), "utf8");

  beforeAll(async () => {
    // The replacement written by hand below is valid for 30 days; the default
    // renewal band would make the hourly tick re-mint it under the test.
    harness = new MultiCollectorHarness({
      gatewayConfig: { gateway: { tls: { renewBeforeDays: 1 } } },
    });
    await harness.start();
    scratch = mkdtempSync(join(tmpdir(), "omnesis-tls-e2e-"));
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
    rmSync(scratch, { recursive: true, force: true });
  });

  let initialFingerprint = "";
  let renewedFingerprint = "";
  let previousFingerprint = "";
  let initialCertPem = "";

  test("the gateway reports the self-signed pair it minted, and it is what the wire presents", async () => {
    const snapshot = await admin<TlsLifecycleSnapshot>("/admin/tls");
    expect(snapshot.ownership).toBe("self-signed");
    expect(snapshot.certPath).toBe(join(harness.gatewayConfigDir, "tls", "cert.pem"));
    expect(snapshot.served.state).toBe("valid");
    expect(snapshot.served.selfSigned).toBe(true);
    expect(snapshot.served.names).toContain("localhost");
    expect(snapshot.served.daysRemaining).toBeGreaterThan(3600);
    expect(snapshot.renewal.mode).toBe("automatic");
    expect(snapshot.rotation).toBeNull();
    initialFingerprint = snapshot.served.fingerprintSha256!;
    initialCertPem = onDisk();
    expect(await onTheWire()).toBe(initialFingerprint);
  });

  test("a renewal that is not due is refused; a forced one rotates the served certificate without a restart", async () => {
    const pid = harness.gatewayPid;
    const refused = await admin<RenewOutcome>("/admin/tls/renew", { method: "POST", body: "{}" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/not due for renewal/u);

    const renewed = await admin<RenewOutcome>("/admin/tls/renew", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    renewedFingerprint = renewed.fingerprintSha256;
    expect(renewedFingerprint).not.toBe(initialFingerprint);
    expect(renewed.snapshot.rotation).toEqual({
      previousFingerprintSha256: initialFingerprint,
      rotatedAt: expect.any(String),
    });
    expect(renewed.snapshot.renewal.lastRenewedAt).toEqual(expect.any(String));
    expect(await onTheWire()).toBe(renewedFingerprint);
    expect(harness.gatewayPid).toBe(pid);
    // The pair on disk is what the wire serves, so a restart serves the same.
    expect(new X509Certificate(onDisk()).fingerprint256.replace(/:/gu, "").toLowerCase()).toBe(
      renewedFingerprint,
    );
    const afterwards = await admin<TlsLifecycleSnapshot>("/admin/tls");
    expect(afterwards.served.fingerprintSha256).toBe(renewedFingerprint);
    expect(afterwards.pendingReplacement).toBeNull();
  });

  test("a pairing code minted after the rotation carries the fingerprint now served", async () => {
    const pending = await admin<{ tlsFingerprint: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "rotation-check", kind: "ios", scopes: ["read"] }),
    });
    expect(pending.tlsFingerprint).toBe(renewedFingerprint);
  });

  test("the real CLI reads, renews and reloads through the same routes", async () => {
    const status = await harness.runCli(["tls", "status", "--json"]);
    expect(status.exitCode).toBe(0);
    const snapshot = JSON.parse(status.stdout) as TlsLifecycleSnapshot;
    expect(snapshot.served.fingerprintSha256).toBe(renewedFingerprint);

    const renew = await harness.runCli(["tls", "renew", "--force", "--json"]);
    expect(renew.exitCode).toBe(0);
    const outcome = JSON.parse(renew.stdout) as RenewOutcome;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    renewedFingerprint = outcome.fingerprintSha256;
    expect(await onTheWire()).toBe(renewedFingerprint);

    // The CLI's own trust followed: its saved copy is the gateway's file.
    const reload = await harness.runCli(["tls", "reload", "--json"]);
    expect(reload.exitCode).toBe(0);
    const reloaded = JSON.parse(reload.stdout) as TlsLifecycleSnapshot;
    expect(reloaded.served.fingerprintSha256).toBe(renewedFingerprint);
    expect(reloaded.pendingReplacement).toBeNull();
  });

  test("material replaced on disk by another tool is activated on reload, and an unusable pair is refused", async () => {
    const tlsDir = join(harness.gatewayConfigDir, "tls");
    const before = readFileSync(join(tlsDir, "key.pem"), "utf8");
    const cnf = join(scratch, "openssl.cnf");
    writeFileSync(
      cnf,
      "[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = replaced\n[v3]\nbasicConstraints = CA:FALSE\nsubjectAltName = DNS:localhost, IP:127.0.0.1\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-keyout",
        join(scratch, "key.pem"),
        "-out",
        join(scratch, "cert.pem"),
        "-config",
        cnf,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    // A certificate beside the old key: refused, the served pair stays.
    writeFileSync(join(tlsDir, "cert.pem"), readFileSync(join(scratch, "cert.pem")));
    const refused = await admin<TlsLifecycleSnapshot>("/admin/tls/reload", { method: "POST" });
    expect(refused.pendingReplacement?.error).toMatch(/does not belong/u);
    expect(refused.served.fingerprintSha256).toBe(renewedFingerprint);
    expect(await onTheWire()).toBe(renewedFingerprint);
    expect(readFileSync(join(tlsDir, "key.pem"), "utf8")).toBe(before);

    // The matching key completes the pair: activated, and the wire follows.
    writeFileSync(join(tlsDir, "key.pem"), readFileSync(join(scratch, "key.pem")));
    const activated = await admin<TlsLifecycleSnapshot>("/admin/tls/reload", { method: "POST" });
    expect(activated.pendingReplacement).toBeNull();
    expect(activated.served.fingerprintSha256).not.toBe(renewedFingerprint);
    expect(activated.served.state).toBe("valid");
    previousFingerprint = renewedFingerprint;
    renewedFingerprint = activated.served.fingerprintSha256!;
    expect(await onTheWire()).toBe(renewedFingerprint);
  });

  test("a restarted gateway serves what the last activation wrote and remembers the rotation", async () => {
    await harness.restartGateway();
    expect(await onTheWire()).toBe(renewedFingerprint);
    const snapshot = await admin<TlsLifecycleSnapshot>("/admin/tls");
    expect(snapshot.served.fingerprintSha256).toBe(renewedFingerprint);
    expect(snapshot.rotation).toEqual({
      previousFingerprintSha256: previousFingerprint,
      rotatedAt: expect.any(String),
    });
    expect(snapshot.renewal.lastRenewedAt).toEqual(expect.any(String));
  }, 120_000);

  test("a CLI host whose saved copy is stale is refused with both fingerprints, and re-trusts by fingerprint", async () => {
    // A machine that trusted the gateway before the rotations above.
    const stale = join(scratch, "stale-host");
    mkdirSync(join(stale, "tls"), { recursive: true });
    writeFileSync(join(stale, "tls", "cert.pem"), initialCertPem);
    const env = { OMNESIS_CONFIG_DIR: stale };

    const refused = await harness.runCli(["tls", "status", "--json"], { extraEnv: env });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`Served: sha256:${renewedFingerprint}`);
    expect(refused.stderr).toContain(`omnesis tls trust --fingerprint ${renewedFingerprint}`);

    const wrong = await harness.runCli(["tls", "trust", "--fingerprint", "ab".repeat(32)], {
      extraEnv: env,
    });
    expect(wrong.exitCode).not.toBe(0);
    expect(readFileSync(join(stale, "tls", "cert.pem"), "utf8")).toBe(initialCertPem);

    const trusted = await harness.runCli(["tls", "trust", "--fingerprint", renewedFingerprint], {
      extraEnv: env,
    });
    expect(trusted.exitCode).toBe(0);
    const status = await harness.runCli(["tls", "status", "--json"], { extraEnv: env });
    expect(status.exitCode).toBe(0);
    expect((JSON.parse(status.stdout) as TlsLifecycleSnapshot).served.fingerprintSha256).toBe(
      renewedFingerprint,
    );
  });
});
