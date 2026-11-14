// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { connect } from "node:tls";
import { once } from "node:events";
import { X509Certificate } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { localAcmeAuthority } from "../test/acme-authority.js";
import { tlsFiles, listen, closeServer } from "../test/support.js";
import { GatewayAcmeRenewal } from "./acme-gateway.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-gateway-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
test("real ACME JWS, nonce, DNS01 and CSR issuance renews a running gateway TLS context without exporting its private key", async () => {
  const hostname = "gateway.example.test",
    files = tlsFiles(directory, hostname);
  const key = await readFile(files.keyFile, "utf8"),
    original = await readFile(files.certFile, "utf8");
  const dns = new Map<string, string>(),
    authority = await localAcmeAuthority(directory, hostname, dns);
  const server = createServer({ cert: original, key });
  const url = await listen(server);
  const created: string[] = [],
    removed: string[] = [];
  const renewal = new GatewayAcmeRenewal({
    directoryUrl: authority.directoryUrl,
    publicOrigin: `https://${hostname}`,
    certificateFile: files.certFile,
    privateKeyFile: files.keyFile,
    accountKeyFile: join(directory, "account.key"),
    trustedRoots: [authority.root],
    presenter: {
      async create(value) {
        dns.set("lease", value);
        created.push(value);
        return { id: "lease" };
      },
      async remove(id) {
        dns.delete(id);
        removed.push(id);
      },
    },
    // DNS lookups use the isolated fixture's record map; the ACME server independently verifies the RFC8555 digest.
    issuer: async (options) =>
      (await import("./acme-client.js")).issueAcmeCertificate({
        ...options,
        lookup: async (_hostname, value) => [...dns.values()].includes(value),
      }),
    activate: async () => {
      server.setSecureContext({ cert: await readFile(files.certFile, "utf8"), key });
    },
  });
  try {
    expect(
      await Promise.all([
        renewal.renew(new AbortController().signal),
        renewal.renew(new AbortController().signal),
      ]),
    ).toEqual([true, true]);
    expect(created).toHaveLength(1);
    expect(removed).toEqual(["lease"]);
    expect(dns.size).toBe(0);
    const issued = await readFile(files.certFile, "utf8");
    expect(issued).not.toBe(original);
    expect(await readFile(files.keyFile, "utf8")).toBe(key);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "account.key"))).mode & 0o777).toBe(0o600);
    }
    expect(authority.payloads.join("\n")).not.toContain("PRIVATE KEY");
    expect(authority.payloads.join("\n")).not.toContain(key);
    const socket = connect({
      host: "127.0.0.1",
      port: Number(new URL(url).port),
      servername: hostname,
      ca: authority.root,
      rejectUnauthorized: true,
    });
    await once(socket, "secureConnect");
    expect(socket.authorized).toBe(true);
    expect(socket.getPeerCertificate().fingerprint256).toBe(
      new X509Certificate(issued).fingerprint256,
    );
    socket.destroy();
    expect(await renewal.renew(new AbortController().signal)).toBe(false);
  } finally {
    await closeServer(server);
    await authority.close();
  }
});

test("a real ACME authority cannot substitute another hostname before DNS publication or replace the gateway certificate", async () => {
  const hostname = "gateway.example.test",
    files = tlsFiles(directory, hostname),
    original = await readFile(files.certFile, "utf8");
  const dns = new Map<string, string>(),
    authority = await localAcmeAuthority(directory, hostname, dns);
  authority.setIdentifier("victim.example.test");
  const create = vi.fn(async () => ({ id: "never" }));
  const renewal = new GatewayAcmeRenewal({
    directoryUrl: authority.directoryUrl,
    publicOrigin: `https://${hostname}`,
    certificateFile: files.certFile,
    privateKeyFile: files.keyFile,
    accountKeyFile: join(directory, "account.key"),
    trustedRoots: [authority.root],
    presenter: { create, async remove() {} },
    activate: async () => {},
  });
  try {
    await expect(renewal.renew(new AbortController().signal)).rejects.toThrow("outside");
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(files.certFile, "utf8")).toBe(original);
  } finally {
    await authority.close();
  }
});
