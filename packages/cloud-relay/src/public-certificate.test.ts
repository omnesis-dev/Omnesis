// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ConnectionOptions, type Server } from "node:tls";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { certificateIsPubliclyLogged, hasEmbeddedSct } from "./public-certificate.js";
import type { AddressInfo } from "node:net";

const host = "gateway.example.test";
const { fake } = vi.hoisted(() => ({ fake: { peer: undefined as object | undefined } }));
// The gateway name is fictional, so the real TLS client is pointed at the local server.
vi.mock(import("node:tls"), async (original) => {
  const tls = await original();
  return {
    ...tls,
    connect: ((options: ConnectionOptions) => {
      if (fake.peer) {
        const peer = fake.peer;
        const socket = Object.assign(new EventEmitter(), {
          authorized: true,
          getPeerCertificate: () => peer,
          destroy: vi.fn(),
        });
        queueMicrotask(() => socket.emit("secureConnect"));
        return socket;
      }
      return tls.connect({ ...options, host: "127.0.0.1" });
    }) as typeof tls.connect,
  };
});

let directory = "";
const servers: Server[] = [];
interface Leaf {
  certificate: string;
  certFile: string;
  keyFile: string;
}
function leaf(name: string, sct: boolean): Leaf {
  const keyFile = join(directory, `${name}-key.pem`),
    certFile = join(directory, `${name}-cert.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      // An SCT list extension; its content is not parsed, only its presence matters.
      ...(sct ? ["-addext", "1.3.6.1.4.1.11129.2.4.2=DER:0400"] : []),
    ],
    { stdio: "ignore" },
  );
  return { certFile, keyFile, certificate: readFileSync(certFile, "utf8") };
}
async function serve(value: Leaf): Promise<string> {
  const server = createServer(
    { cert: await readFile(value.certFile), key: await readFile(value.keyFile) },
    (socket) => socket.end(),
  );
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `https://${host}:${(server.address() as AddressInfo).port}/`;
}
let logged: Leaf, unlogged: Leaf;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "public-certificate-"));
  logged = leaf("logged", true);
  unlogged = leaf("unlogged", false);
});
afterAll(async () => {
  for (const server of servers) server.close();
  await rm(directory, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

test("the SCT list extension is recognised by its OID alone", () => {
  expect(hasEmbeddedSct(Buffer.from(new X509Certificate(logged.certificate).raw))).toBe(true);
  expect(hasEmbeddedSct(Buffer.from(new X509Certificate(unlogged.certificate).raw))).toBe(false);
});

test("a trusted certificate with embedded SCTs that matches the proposal is publicly logged", async () => {
  const publicOrigin = await serve(logged);
  const env = { OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: logged.certFile };
  expect(
    await certificateIsPubliclyLogged(
      { publicOrigin, certificate: logged.certificate },
      signal(),
      env,
    ),
  ).toBe(true);
  // The same server is not trusted without the extra CA.
  expect(
    await certificateIsPubliclyLogged({ publicOrigin, certificate: logged.certificate }, signal()),
  ).toBe(false);
  // A proposal for another certificate never matches what the server presents.
  expect(
    await certificateIsPubliclyLogged(
      { publicOrigin, certificate: unlogged.certificate },
      signal(),
      env,
    ),
  ).toBe(false);
  // Cancelling first contact answers no rather than failing pairing.
  const controller = new AbortController();
  controller.abort();
  expect(
    await certificateIsPubliclyLogged(
      { publicOrigin, certificate: logged.certificate },
      controller.signal,
      env,
    ),
  ).toBe(false);
});

test("a trusted certificate without SCTs is not publicly logged", async () => {
  const publicOrigin = await serve(unlogged);
  expect(
    await certificateIsPubliclyLogged(
      { publicOrigin, certificate: unlogged.certificate },
      signal(),
      { OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: unlogged.certFile },
    ),
  ).toBe(false);
});

test("an unreachable gateway or a peer without a certificate is not publicly logged", async () => {
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  await once(closed, "close");
  expect(
    await certificateIsPubliclyLogged(
      { publicOrigin: `https://${host}:${port}/`, certificate: logged.certificate },
      signal(),
      {},
    ),
  ).toBe(false);
  fake.peer = {};
  try {
    expect(
      await certificateIsPubliclyLogged(
        { publicOrigin: `https://${host}/`, certificate: logged.certificate },
        signal(),
        {},
      ),
    ).toBe(false);
  } finally {
    fake.peer = undefined;
  }
});
