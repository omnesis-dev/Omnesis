// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { verifiesUnderSystemTrust } from "./tofu.js";
import type { LookupFunction } from "node:net";

const NAME = "gateway.example.test";

/** Every name resolves to the local test server. */
const toLoopback: LookupFunction = (_hostname, options, callback) => {
  if (typeof options === "object" && options.all) {
    (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
      { address: "127.0.0.1", family: 4 },
    ]);
  } else {
    callback(null, "127.0.0.1", 4);
  }
};

describe("verifiesUnderSystemTrust", () => {
  let dir: string;
  let root: string;
  let leaf: { pem: string; key: string; fingerprint: string };
  let selfSigned: { pem: string; key: string; fingerprint: string };
  const servers: Server[] = [];
  const ports: Record<string, number> = {};

  function openssl(args: string[]): void {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  }

  function read(name: string): { pem: string; key: string; fingerprint: string } {
    const pem = readFileSync(join(dir, `${name}.pem`), "utf8");
    return {
      pem,
      key: readFileSync(join(dir, `${name}.key`), "utf8"),
      fingerprint: new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(),
    };
  }

  async function serve(name: string, cert: { pem: string; key: string }): Promise<void> {
    const server = createServer({ key: cert.key, cert: cert.pem }, (socket) => socket.end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    ports[name] = address.port;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-tofu-system-trust-"));
    const ext = (name: string, body: string) => {
      writeFileSync(
        join(dir, `${name}.cnf`),
        `[req]\ndistinguished_name = dn\n[dn]\n[v3]\n${body}`,
      );
      return join(dir, `${name}.cnf`);
    };
    const san = `subjectAltName = DNS:${NAME}\n`;
    openssl(
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
        .concat(["-days", "3", "-subj", "/CN=fictional-root", "-extensions", "v3"])
        .concat(["-config", ext("root", "basicConstraints = critical, CA:TRUE\n")])
        .concat(["-keyout", join(dir, "root.key"), "-out", join(dir, "root.pem")]),
    );
    root = readFileSync(join(dir, "root.pem"), "utf8");
    openssl(
      ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
        .concat(["-subj", "/CN=leaf", "-keyout", join(dir, "leaf.key")])
        .concat(["-out", join(dir, "leaf.csr")]),
    );
    writeFileSync(join(dir, "leaf.ext"), `basicConstraints = critical, CA:FALSE\n${san}`);
    openssl(
      ["x509", "-req", "-in", join(dir, "leaf.csr"), "-CA", join(dir, "root.pem")]
        .concat(["-CAkey", join(dir, "root.key"), "-CAcreateserial", "-days", "3"])
        .concat(["-extfile", join(dir, "leaf.ext"), "-out", join(dir, "leaf.pem")]),
    );
    leaf = read("leaf");
    openssl(
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
        .concat(["-days", "3", "-subj", "/CN=self", "-extensions", "v3"])
        .concat(["-config", ext("self", `basicConstraints = critical, CA:FALSE\n${san}`)])
        .concat(["-keyout", join(dir, "self.key"), "-out", join(dir, "self.pem")]),
    );
    selfSigned = read("self");
    await serve("public", leaf);
    await serve("self", selfSigned);
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    rmSync(dir, { recursive: true, force: true });
  });

  test("true for a DNS name whose served leaf is the observed one and verifies publicly", async () => {
    await expect(
      verifiesUnderSystemTrust(NAME, ports.public!, `sha256:${leaf.fingerprint}`, {
        roots: [root],
        lookup: toLoopback,
      }),
    ).resolves.toBe(true);
  });

  test("false when the served leaf is not the one observed", async () => {
    await expect(
      verifiesUnderSystemTrust(NAME, ports.public!, selfSigned.fingerprint, {
        roots: [root],
        lookup: toLoopback,
      }),
    ).resolves.toBe(false);
  });

  test("false for a self-signed certificate or a name it does not cover", async () => {
    await expect(
      verifiesUnderSystemTrust(NAME, ports.self!, selfSigned.fingerprint, {
        roots: [root],
        lookup: toLoopback,
      }),
    ).resolves.toBe(false);
    await expect(
      verifiesUnderSystemTrust("other.example.test", ports.public!, leaf.fingerprint, {
        roots: [root],
        lookup: toLoopback,
      }),
    ).resolves.toBe(false);
  });

  test("false for an IP literal or a loopback name without dialling", async () => {
    for (const host of ["127.0.0.1", "[::1]", "localhost", "localhost.", "gateway.localhost."]) {
      await expect(
        verifiesUnderSystemTrust(host, ports.public!, leaf.fingerprint, { roots: [root] }),
      ).resolves.toBe(false);
    }
  });

  test("false when nothing answers", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const address = closed.address();
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    if (!address || typeof address === "string") throw new Error("no port");
    await expect(
      verifiesUnderSystemTrust(NAME, address.port, leaf.fingerprint, {
        roots: [root],
        lookup: toLoopback,
      }),
    ).resolves.toBe(false);
  });
});
