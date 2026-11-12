// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { expect, test } from "vitest";
import { expiredCertificate } from "../test/expired-certificate.js";
import { connectOrigin } from "./network.js";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import type { AddressInfo, Socket } from "node:net";

test("an exact signed leaf can anchor pinned bootstrap without trusting its issuing CA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-pinned-leaf-"));
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  const sockets = new Set<Socket>();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      file("root.key"),
      "-out",
      file("root.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fictional test authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    );
    openssl(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      file("leaf.key"),
      "-out",
      file("leaf.csr"),
      "-subj",
      "/CN=gateway.example.test",
    );
    await writeFile(
      file("leaf.ext"),
      "subjectAltName=DNS:gateway.example.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    );
    openssl(
      "x509",
      "-req",
      "-in",
      file("leaf.csr"),
      "-CA",
      file("root.pem"),
      "-CAkey",
      file("root.key"),
      "-CAcreateserial",
      "-out",
      file("leaf.pem"),
      "-days",
      "1",
      "-extfile",
      file("leaf.ext"),
    );
    const cert = await readFile(file("leaf.pem"), "utf8");
    const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    server = createServer({ cert, key: await readFile(file("leaf.key"), "utf8") }, (socket) =>
      socket.end(),
    );
    server.on("tlsClientError", () => {});
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = new URL(
      `https://gateway.example.test:${(server.address() as AddressInfo).port}`,
    );
    const pinned = await connectOrigin(origin, cert, undefined, false, fingerprint, "127.0.0.1");
    pinned.destroy();
    await expect(
      connectOrigin(origin, cert, undefined, false, undefined, "127.0.0.1"),
    ).rejects.toThrow();
    await expect(
      connectOrigin(origin, cert, undefined, false, "f".repeat(64), "127.0.0.1"),
    ).rejects.toThrow("pin mismatch");
    const wrongHost = new URL(`https://another.example.test:${origin.port}`);
    await expect(
      connectOrigin(wrongHost, cert, undefined, false, fingerprint, "127.0.0.1"),
    ).rejects.toBeInstanceOf(GatewayTlsIdentityRefused);
    expiredCertificate({
      certificateFile: file("leaf.pem"),
      privateKeyFile: file("leaf.key"),
      outputFile: file("expired.pem"),
      issuer: { certificateFile: file("root.pem"), privateKeyFile: file("root.key") },
    });
    const expired = await readFile(file("expired.pem"), "utf8");
    const expiredPin = createHash("sha256").update(new X509Certificate(expired).raw).digest("hex");
    server.setSecureContext({ cert: expired, key: await readFile(file("leaf.key"), "utf8") });
    await expect(
      connectOrigin(origin, expired, undefined, false, expiredPin, "127.0.0.1"),
    ).rejects.toMatchObject({ code: "CERT_HAS_EXPIRED" });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
