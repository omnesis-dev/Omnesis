// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { createServer, request } from "node:https";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { tlsFiles, until } from "../test/support.js";
import { createTlsRouter } from "./tls-router.js";
import { connectOrigin } from "./network.js";
import { certificateFingerprint } from "./gateway-binding.js";

let directory: string;
let key: string;
let cert: string;
const host = "gateway.example.test";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-opaque-tls-"));
  const files = tlsFiles(directory, host);
  [key, cert] = await Promise.all([
    readFile(files.keyFile, "utf8"),
    readFile(files.certFile, "utf8"),
  ]);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const port = (server: { address(): unknown }): number => (server.address() as AddressInfo).port;
const bind = async (
  server: { listen(port: number, host: string): unknown } & NodeJS.EventEmitter,
): Promise<void> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
};

test("TLS terminates only at the gateway; the relay sees no HTTP path, token or payload", async () => {
  const secret = "fictional-secret-document-body-opaque-tls";
  const token = "Bearer opaque-test-token";
  const received: string[] = [];
  const encrypted: Buffer[] = [];
  const gateway = createServer({ key, cert, minVersion: "TLSv1.3" }, (req, res) => {
    void (async () => {
      for await (const chunk of req) received.push(Buffer.from(chunk).toString());
      expect(req.headers.authorization).toBe(token);
      expect(req.url).toBe("/mcp/private-document");
      res.end(secret);
    })().catch(() => res.destroy());
  });
  await bind(gateway);
  const router = createTlsRouter({
    accountForHostname: (name) => (name === host ? "fictional-account" : undefined),
    open: async (account, _signal, client) => {
      expect(account).toBe("fictional-account");
      // The address the encrypted connection came from, for the gateway's rate limits.
      expect(client).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
      const socket = connect(port(gateway), "127.0.0.1");
      await once(socket, "connect");
      socket.on("data", (data: Buffer) => encrypted.push(Buffer.from(data)));
      return socket;
    },
  });
  router.server.prependListener("connection", (socket) => {
    socket.on("data", (data: Buffer) => encrypted.push(Buffer.from(data)));
  });
  await bind(router.server);
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: port(router.server),
          servername: host,
          ca: cert,
          minVersion: "TLSv1.3",
          method: "POST",
          path: "/mcp/private-document",
          headers: { authorization: token },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on("error", reject);
      req.end(secret);
    });
    expect(reply).toBe(secret);
    expect(received.join("")).toBe(secret);
    const wire = Buffer.concat(encrypted).toString("latin1");
    for (const plaintext of [secret, token, "/mcp/private-document", "POST ", "HTTP/1.1"])
      expect(wire).not.toContain(plaintext);
    expect(wire).toContain(host); // SNI is deliberately public routing metadata.
  } finally {
    await router.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

test("even another trusted certificate for the same hostname cannot replace a pinned gateway", async () => {
  const otherDir = await mkdtemp(join(tmpdir(), "omnesis-substitute-cert-"));
  const files = tlsFiles(otherDir, host);
  const otherCert = await readFile(files.certFile, "utf8");
  let requests = 0;
  const attacker = createServer(
    { key: await readFile(files.keyFile), cert: otherCert },
    (_, res) => {
      requests++;
      res.end();
    },
  );
  attacker.on("tlsClientError", () => {});
  await bind(attacker);
  try {
    // Trust both roots: CA trust alone would accept the substitution.
    const origin = new URL(`https://localhost:${port(attacker)}`);
    const accepted = await connectOrigin(origin, cert + otherCert);
    accepted.destroy();
    await expect(
      connectOrigin(origin, cert + otherCert, undefined, false, certificateFingerprint(cert)),
    ).rejects.toThrow("pin mismatch");
    expect(requests).toBe(0);
  } finally {
    attacker.closeAllConnections();
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
    await rm(otherDir, { recursive: true, force: true });
  }
});

test.each([0, -1, NaN, 2_147_483_648])("rejects invalid limits %s", (limit) => {
  const options = { accountForHostname: () => undefined, open: async () => new PassThrough() };
  expect(() => createTlsRouter({ ...options, maxConnections: limit })).toThrow();
  expect(() => createTlsRouter({ ...options, helloTimeoutMs: limit })).toThrow();
});

test("bounds idle peers, rejects plaintext and oversize inputs, and drains sockets on shutdown", async () => {
  let opens = 0;
  const peerClosed = (socket: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      // A deliberately rejected peer may receive FIN or RST, depending on the OS.
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.once("close", () => resolve());
    });
  const router = createTlsRouter({
    accountForHostname: () => undefined,
    open: async () => {
      opens++;
      return new PassThrough();
    },
    helloTimeoutMs: 50,
    maxConnections: 1,
  });
  await bind(router.server);
  try {
    const first = connect(port(router.server), "127.0.0.1");
    const firstClosed = peerClosed(first);
    await once(first, "connect");
    const second = connect(port(router.server), "127.0.0.1");
    await peerClosed(second);
    await firstClosed;
    const plaintext = connect(port(router.server), "127.0.0.1");
    const plaintextClosed = peerClosed(plaintext);
    plaintext.end("GET /private HTTP/1.1\r\n\r\n");
    await plaintextClosed;
    const huge = connect(port(router.server), "127.0.0.1");
    const hugeClosed = peerClosed(huge);
    huge.write(Buffer.alloc(100_000));
    await hugeClosed;
    const idle = connect(port(router.server), "127.0.0.1");
    const closed = peerClosed(idle);
    await once(idle, "connect");
    await router.close();
    await closed;
    expect(opens).toBe(0);
  } finally {
    if (router.server.listening) await router.close();
  }
});

test("unknown SNI and failed destinations never receive application bytes", async () => {
  for (const unknown of [true, false]) {
    const router = createTlsRouter({
      accountForHostname: () => (unknown ? undefined : "account"),
      open: async () => {
        throw new Error("Gateway offline");
      },
    });
    await bind(router.server);
    try {
      await expect(
        new Promise((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port: port(router.server),
              servername: host,
              ca: cert,
              agent: false,
            },
            resolve,
          );
          req.on("error", reject);
          req.end();
        }),
      ).rejects.toThrow();
    } finally {
      await router.close();
    }
  }
});

test("a disconnected client cancels pending admission and destroys a late destination", async () => {
  let finish: ((stream: PassThrough) => void) | undefined;
  let signal: AbortSignal | undefined;
  const router = createTlsRouter({
    accountForHostname: () => "account",
    open: async (_, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await bind(router.server);
  const req = request({
    hostname: "127.0.0.1",
    port: port(router.server),
    servername: host,
    ca: cert,
    agent: false,
  });
  req.on("error", () => {});
  req.end();
  try {
    await until(() => Boolean(finish));
    req.destroy();
    await until(() => Boolean(signal?.aborted));
    const stream = new PassThrough();
    finish!(stream);
    await until(() => stream.destroyed);
  } finally {
    await router.close();
  }
});

function routingHello(): Buffer[] {
  const short = (value: number): Buffer => Buffer.from([value >> 8, value & 255]);
  const name = Buffer.from(host);
  const sni = Buffer.concat([short(name.length + 3), Buffer.from([0]), short(name.length), name]);
  const extensions = Buffer.concat([short(0), short(sni.length), sni]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    short(2),
    Buffer.from([0x13, 1, 1, 0]),
    short(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
  return [handshake.subarray(0, 3), handshake.subarray(3)].map((fragment) =>
    Buffer.concat([Buffer.from([22, 3, 1]), short(fragment.length), fragment]),
  );
}

test("fragmented TCP headers and TLS records preserve every byte, and destination resets close the peer", async () => {
  const destination = new PassThrough();
  const transferred: Buffer[] = [];
  destination.on("data", (chunk: Buffer) => transferred.push(Buffer.from(chunk)));
  let chunks = 0;
  let opens = 0;
  const router = createTlsRouter({
    accountForHostname: () => "account",
    open: async () => {
      opens++;
      return destination;
    },
  });
  router.server.prependListener("connection", (socket) => socket.on("data", () => chunks++));
  await bind(router.server);
  const client = connect(port(router.server), "127.0.0.1");
  client.on("error", () => {});
  client.resume();
  try {
    await once(client, "connect");
    client.setNoDelay(true);
    const records = routingHello();
    client.write(records[0]!.subarray(0, 2));
    await until(() => chunks === 1);
    client.write(records[0]!.subarray(2, 6));
    await until(() => chunks === 2);
    client.write(records[0]!.subarray(6));
    await until(() => chunks === 3);
    expect(opens).toBe(0);
    client.write(records[1]!);
    await until(() => opens === 1 && transferred.length > 0);
    expect(Buffer.concat(transferred)).toEqual(Buffer.concat(records));
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    destination.emit("error", new Error("Destination connection reset"));
    await closed;
    expect(destination.destroyed).toBe(true);
  } finally {
    client.destroy();
    await router.close();
  }
});

test("bounds incomplete oversized records and contains client-side connection resets", async () => {
  const router = createTlsRouter({
    accountForHostname: () => "account",
    open: async () => new PassThrough(),
  });
  await bind(router.server);
  try {
    for (const input of [
      Buffer.from([22, 3, 1, 255, 255]),
      (() => {
        // A plausible handshake cannot finish until the fourth full record,
        // whose wire length exceeds the initial-buffer budget.
        const fragments = Array.from({ length: 4 }, () => Buffer.alloc(18_000));
        fragments[0]!.set([1, 0, 234, 96]);
        return Buffer.concat(
          fragments.map((fragment) => Buffer.concat([Buffer.from([22, 3, 1, 70, 80]), fragment])),
        );
      })(),
    ]) {
      const client = connect(port(router.server), "127.0.0.1");
      client.on("error", () => {});
      await once(client, "connect");
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.write(input);
      await closed;
    }
    let accepted: import("node:net").Socket | undefined;
    router.server.once("connection", (socket) => {
      accepted = socket;
    });
    const client = connect(port(router.server), "127.0.0.1");
    client.on("error", () => {});
    await until(() => Boolean(accepted));
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    accepted!.emit("error", new Error("Connection reset by peer"));
    await closed;
  } finally {
    await router.close();
  }
  await expect(router.close()).rejects.toThrow();
});

test("an independent raw TCP front layer preserves SNI routing and opaque gateway TLS without vendor metadata", async () => {
  const applicationToken = "Bearer front-test-token";
  const applicationBody = "synthetic-private-front-layer-payload";
  const captured: Buffer[] = [];
  const routed: string[] = [];
  const active = new Set<Socket>();
  let receivedSni: string | false | undefined;
  const gateway = createServer({ key, cert }, (req, res) => {
    expect(req.headers.host).toBe(host);
    expect(req.headers.authorization).toBe(applicationToken);
    expect(req.headers["cf-connecting-ip"]).toBeUndefined();
    receivedSni = (req.socket as import("node:tls").TLSSocket).servername ?? undefined;
    res.end(applicationBody);
  });
  await bind(gateway);
  const router = createTlsRouter({
    accountForHostname(name) {
      routed.push(name);
      return name === host ? "synthetic-gateway" : undefined;
    },
    open: async (account, signal) => {
      expect(account).toBe("synthetic-gateway");
      return connectOrigin(new URL(`https://localhost:${port(gateway)}`), undefined, signal, true);
    },
  });
  await bind(router.server);
  const front = createTcpServer((socket) => {
    const upstream = connect(port(router.server), "127.0.0.1");
    for (const connection of [socket, upstream]) {
      active.add(connection);
      connection.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
      connection.once("close", () => {
        active.delete(connection);
        socket.destroy();
        upstream.destroy();
      });
    }
    socket.on("data", (chunk) => captured.push(Buffer.from(chunk)));
    socket.pipe(upstream).pipe(socket);
  });
  await bind(front);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: port(front),
          servername: host,
          ca: cert,
          agent: false,
          path: "/mcp",
          headers: { host, authorization: applicationToken },
        },
        (res) => {
          const body: Buffer[] = [];
          res.on("data", (chunk) => body.push(Buffer.from(chunk)));
          res.on("end", () => resolve(Buffer.concat(body).toString()));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(response).toBe(applicationBody);
    expect(receivedSni).toBe(host);
    expect(routed).toEqual([host]);
    const bytes = Buffer.concat(captured);
    expect(bytes.includes(Buffer.from(host))).toBe(true);
    for (const plaintext of [
      applicationToken,
      applicationBody,
      "GET /mcp",
      "CF-Connecting-IP",
      "PROXY ",
    ])
      expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
  } finally {
    for (const socket of active) socket.destroy();
    gateway.closeAllConnections();
    await Promise.all([
      router.close(),
      new Promise<void>((resolve) => front.close(() => resolve())),
      new Promise<void>((resolve) => gateway.close(() => resolve())),
    ]);
  }
});
