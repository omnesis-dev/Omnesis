// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Integration proof for `resolveHostToLoopback`: a gateway serving a
 * certificate that names only its tailnet host is reached over loopback by
 * that name — `fetch` and raw `node:tls` both follow — while the certificate
 * is still verified against the name, so a name the certificate does not
 * carry is refused exactly as before.
 *
 * The names end in `.invalid` (RFC 6761), which never resolve: a connection
 * that succeeds can only have gone through the loopback resolution. Runs under
 * the vitest forks pool, so the CA-store and `dns.lookup` changes stay in this
 * file's process.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveHostToLoopback, resolvesToLoopback } from "./local-gateway-url.js";
import { applyCaTrustInProcess } from "./tofu.js";
import type { AddressInfo } from "node:net";

const GATEWAY_HOST = "studio.omnesis-test.invalid";
const OTHER_HOST = "other.omnesis-test.invalid";

let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-loopback-name-"));
  const cnfPath = join(dir, "cert.cnf");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  writeFileSync(
    cnfPath,
    `
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ext

[dn]
CN = ${GATEWAY_HOST}

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:${GATEWAY_HOST}
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
      cnfPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  applyCaTrustInProcess(certPath);
  server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) =>
    res.end(JSON.stringify({ host: req.headers.host })),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

describe("resolveHostToLoopback", () => {
  test("a name resolved to loopback reaches the local listener, verified against that name", async () => {
    const before = await fetch(`https://${GATEWAY_HOST}:${port}/health`).catch((err) => err);
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(errorCode(before));

    resolveHostToLoopback(GATEWAY_HOST);
    expect(resolvesToLoopback(GATEWAY_HOST)).toBe(true);
    expect(resolvesToLoopback(OTHER_HOST)).toBe(false);

    const res = await fetch(`https://${GATEWAY_HOST}:${port}/health`);
    expect(await res.json()).toEqual({ host: `${GATEWAY_HOST}:${port}` });

    const authorized = await new Promise<boolean>((resolve, reject) => {
      const socket = tlsConnect({ host: GATEWAY_HOST, port }, () => {
        resolve(socket.authorized);
        socket.end();
      });
      socket.on("error", reject);
    });
    expect(authorized).toBe(true);
  });

  test("the certificate is still checked: a name it does not carry is refused over loopback", async () => {
    resolveHostToLoopback(OTHER_HOST);
    const err = await fetch(`https://${OTHER_HOST}:${port}/health`).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    // And loopback's own name is no shortcut past it either.
    const viaLocalhost = await fetch(`https://localhost:${port}/health`).catch((e: unknown) => e);
    expect(errorCode(viaLocalhost)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });
});
