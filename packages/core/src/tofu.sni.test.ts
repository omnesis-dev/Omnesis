// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fetchPeerCert } from "./tofu.js";

/**
 * A front that serves several names, such as Tailscale's serve and Funnel,
 * refuses a handshake that names no host. The certificate probe behind
 * `--trust-fingerprint` must name the host it dials.
 */
describe("fetchPeerCert names the host it dials", () => {
  let dir: string;
  let server: Server;
  let port: number;
  const named: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-tofu-sni-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const cnfPath = join(dir, "cert.cnf");
    writeFileSync(
      cnfPath,
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "x509_extensions = v3_ext",
        "[dn]",
        "CN = localhost",
        "[v3_ext]",
        "subjectAltName = DNS:localhost, IP:127.0.0.1",
      ].join("\n"),
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
        cnfPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    // Called only for a handshake that names a host, before the certificate is sent.
    server = createServer({
      key,
      cert,
      SNICallback: (name, done) => {
        named.push(name);
        done(null, undefined);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test("sends a host name as SNI and never an IP address", async () => {
    named.length = 0;
    await fetchPeerCert("localhost", port);
    await fetchPeerCert("127.0.0.1", port);
    expect(named).toEqual(["localhost"]);
  });
});
