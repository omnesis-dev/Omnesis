// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { connect } from "node:tls";
import { once } from "node:events";
import { X509Certificate } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { markedFileError, onWindowsBoundary } from "../test/private-operation-fixture.js";
import { localAcmeAuthority } from "../test/acme-authority.js";
import { tlsFiles, listen, closeServer } from "../test/support.js";
import { GatewayAcmeRenewal } from "./acme-gateway.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-gateway-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
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
    } else {
      expect(
        core.inspectWindowsPrivatePathSync(join(directory, "account.key"), "file").private,
      ).toBe(true);
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

test.each(["read", "publication"] as const)(
  "uncertain ACME account-key %s never proceeds to the issuer",
  async (phase) => {
    const tls = tlsFiles(directory, "gateway.example.test"),
      accountKeyFile = join(directory, "uncertain-account.key");
    const key = await readFile(tls.keyFile, "utf8"),
      certificate = await readFile(tls.certFile, "utf8");
    const failure = markedFileError(phase === "read" ? "ENOENT" : "EPRIVATE", "cause");
    const missing = Object.assign(new Error("Invented account-key absence"), { code: "ENOENT" });
    vi.spyOn(core, "readWindowsPrivateFile").mockImplementation(async (path) => {
      if (path === tls.keyFile) return Buffer.from(key);
      if (path === accountKeyFile) throw phase === "read" ? failure : missing;
      throw new Error("Invented unexpected private read");
    });
    vi.spyOn(core, "acquireGatewayLock").mockResolvedValue({
      path: join(directory, "fixture.lock"),
      release: vi.fn(),
    });
    let temporary: string | undefined;
    const writer = vi.spyOn(core, "atomicWriteFile").mockImplementationOnce(async (path, bytes) => {
      temporary = path;
      await writeFile(path, bytes, { mode: 0o600 });
      throw failure;
    });
    const issuer = vi
      .fn<NonNullable<ConstructorParameters<typeof GatewayAcmeRenewal>[0]["issuer"]>>()
      .mockRejectedValue(new Error("Invented unexpected issuer"));
    const renewal = new GatewayAcmeRenewal({
      directoryUrl: "https://ca.example.test/directory",
      publicOrigin: "https://gateway.example.test",
      certificateFile: tls.certFile,
      privateKeyFile: tls.keyFile,
      accountKeyFile,
      presenter: { create: vi.fn(), remove: vi.fn() },
      activate: vi.fn(),
      issuer,
    });
    await onWindowsBoundary(async () => {
      await expect(renewal.renew(new AbortController().signal)).rejects.toBe(failure);
      expect(issuer).not.toHaveBeenCalled();
      if (phase === "read") expect(writer).not.toHaveBeenCalled();
      else {
        expect(temporary).toBeDefined();
        expect(await readFile(temporary!, "utf8")).toContain("PRIVATE KEY");
      }
      expect(await readFile(tls.certFile, "utf8")).toBe(certificate);
      expect(await readFile(tls.keyFile, "utf8")).toBe(key);
    });
  },
);
