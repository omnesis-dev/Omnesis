// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `tls provision` is exempt from the CLI's trust preflight, so on a
 * self-signed install it must trust the gateway's saved certificate itself
 * before asking the gateway to activate what it minted. A real HTTPS server
 * with a throwaway self-signed certificate stands in for that gateway.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { trustSavedGatewayCertificate } from "./tls-provision.js";
import type { AddressInfo } from "node:net";

let dir: string;
let server: Server;
let url: string;
let requests = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-tls-provision-trust-"));
  const cnf = join(dir, "req.cnf");
  writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3_ext",
      "[dn]",
      "CN = omnesis-test-gateway",
      "[v3_ext]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = DNS:localhost, IP:127.0.0.1",
    ].join("\n"),
  );
  const certPath = join(dir, "served.pem");
  const keyPath = join(dir, "served-key.pem");
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
      "2",
      "-nodes",
      "-config",
      cnf,
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://localhost:${(server.address() as AddressInfo).port}`;
  // The gateway's own copy, where it keeps it and where the CLI saves trust.
  mkdirSync(join(dir, "config", "tls"), { recursive: true });
  writeFileSync(join(dir, "config", "tls", "cert.pem"), readFileSync(certPath));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("trustSavedGatewayCertificate", () => {
  it("adds nothing and dials nothing when no certificate is saved", async () => {
    const empty = join(dir, "empty-config");
    mkdirSync(empty, { recursive: true });
    await trustSavedGatewayCertificate(url, empty);
    expect(requests).toBe(0);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("makes the self-signed gateway on this machine reachable with full verification", async () => {
    await trustSavedGatewayCertificate(url, join(dir, "config"));
    const res = await fetch(`${url}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
