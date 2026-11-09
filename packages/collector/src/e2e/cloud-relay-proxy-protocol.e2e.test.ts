// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A real relay daemon behind a TCP front layer that speaks PROXY protocol v2,
 * as the production relay sits behind HAProxy with `send-proxy-v2`. Every
 * connection the relay gets through the front comes from the front's own
 * address; only the header tells clients apart. The relay must count its
 * sign-in limits per header address, and a real gateway behind it must count
 * its own limits per the address the relay reports for each stream.
 */

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import {
  connect,
  createServer,
  isIPv4,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EnrollmentGateway, EnrollmentWorld, RELAY_HOST } from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

/** The front layer's own address. Linux routes all of 127/8 to loopback. */
const FRONT = "127.0.0.9";

function addressBytes(address: string): Buffer {
  if (isIPv4(address)) return Buffer.from(address.split(".").map(Number));
  const [head = "", tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  return Buffer.from(groups.map((group) => group.padStart(4, "0")).join(""), "hex");
}

/** A PROXY v2 header for a TCP connection from `source` to the front's public port. */
function proxyV2(source: string): Buffer {
  const v4 = isIPv4(source);
  const ports = Buffer.alloc(4);
  ports.writeUInt16BE(40_000);
  ports.writeUInt16BE(443, 2);
  const block = Buffer.concat([
    addressBytes(source),
    addressBytes(v4 ? "192.0.2.1" : "2001:db8::1"),
    ports,
  ]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(block.length);
  return Buffer.concat([
    Buffer.from("0d0a0d0a000d0a515549540a", "hex"),
    Buffer.from([0x21, v4 ? 0x11 : 0x21]),
    length,
    block,
  ]);
}

/**
 * A raw TCP front: dials `target` from the front's own address, prepends a
 * PROXY v2 header naming the client, and pipes bytes unchanged both ways, as
 * HAProxy does in TCP mode. Each local test client (a 127/8 source address)
 * is presented as the public address the test maps it to.
 */
async function startFront(target: number, publicAddress: (loopback: string) => string) {
  const server: Server = createServer((client) => {
    client.on("error", () => client.destroy());
    const upstream = connect({ host: "127.0.0.1", port: target, localAddress: FRONT });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      upstream.write(proxyV2(publicAddress(client.remoteAddress!.replace(/^::ffff:/, ""))));
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One HTTPS POST from a chosen loopback source address, returning its status. */
function post(
  source: string,
  port: number,
  hostname: string,
  path: string,
  body: unknown,
): Promise<number> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        localAddress: source,
        servername: hostname,
        path,
        method: "POST",
        rejectUnauthorized: false,
        agent: false,
        headers: {
          host: `${hostname}:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        signal: AbortSignal.timeout(15_000),
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

/** Sends until one request is refused for its rate, returning how many got through. */
async function exhaust(send: () => Promise<number>, most: number): Promise<number> {
  for (let admitted = 0; admitted < most; admitted++) if ((await send()) === 429) return admitted;
  throw new Error(`No request was refused for its rate after ${most}`);
}

/** Whether a TLS handshake for `servername` completes on a connection from `from` that first sent `prefix`. */
async function handshake(
  port: number,
  from: string,
  servername: string,
  prefix?: Buffer,
): Promise<boolean> {
  const raw: Socket = connect({ host: "127.0.0.1", port, localAddress: from });
  raw.on("error", () => {});
  await once(raw, "connect");
  if (prefix) raw.write(prefix);
  const tls = connectTls({ socket: raw, servername, rejectUnauthorized: false });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), 10_000);
    function finish(secure: boolean): void {
      clearTimeout(timer);
      tls.destroy();
      raw.destroy();
      resolve(secure);
    }
    tls.once("secureConnect", () => finish(true));
    tls.once("error", () => finish(false));
    tls.once("close", () => finish(false));
  });
}

describe("a relay behind a PROXY protocol front layer", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let gateway: EnrollmentGateway;
  let control: Awaited<ReturnType<typeof startFront>>;
  let data: Awaited<ReturnType<typeof startFront>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-relay-proxy-"));
    world = await EnrollmentWorld.create(directory, {
      signupPolicy: "invitation",
      extraEnv: {
        // Only the front may (and must) send a header. The gateway's own tunnel
        // reaches the relay directly from 127.0.0.1, as an unlisted peer.
        OMNESIS_CLOUD_RELAY_PROXY_PROTOCOL_FROM: `${FRONT}/32`,
        OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT: "4",
      },
    });
    gateway = await EnrollmentGateway.start(world, "proxied");
    // Local test clients 127.0.0.N appear to the relay as these public addresses.
    const publicAddress = (loopback: string) =>
      ({
        "127.0.0.2": "203.0.113.2",
        "127.0.0.3": "2001:db8:3::1",
        "127.0.0.4": "203.0.113.4",
        "127.0.0.5": "198.51.100.5",
        "127.0.0.6": "2001:db8:6::1",
      })[loopback] ?? "192.0.2.200";
    control = await startFront(world.relayPort, publicAddress);
    data = await startFront(world.dataPort, publicAddress);
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    try {
      await control?.close();
      await data?.close();
      await gateway?.close();
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("the relay counts sign-in starts per client named in the header", async () => {
    const start = (source: string) =>
      post(source, control.port, RELAY_HOST, "/_relay/v3/desktop/start", {
        nonce: randomBytes(32).toString("base64url"),
        challenge: randomBytes(32).toString("base64url"),
        kind: "collector",
        name: "Fictional rate probe",
      });
    // All of these reach the relay from the front's one address.
    expect(await exhaust(() => start("127.0.0.5"), 10)).toBe(4);
    expect(await start("127.0.0.5")).toBe(429);
    expect(await start("127.0.0.6")).not.toBe(429);
  }, 120_000);

  test("a gateway behind the relay counts each client named in the header apart", async () => {
    const challenge = (source: string) =>
      post(source, data.port, gateway.hostname, "/devices/account/challenge", {});
    const admitted = await exhaust(() => challenge("127.0.0.2"), 30);
    expect(admitted).toBeGreaterThanOrEqual(10);
    expect(await challenge("127.0.0.2")).toBe(429);
    // This gateway has no linked account, so a request the limiter admits is then
    // refused as unavailable; only the limiter answers 429.
    expect(await challenge("127.0.0.3")).not.toBe(429);
    expect(await challenge("127.0.0.4")).not.toBe(429);
  }, 120_000);

  test("a header from any other peer is refused, and the front cannot skip its own", async () => {
    const header = proxyV2("203.0.113.66");
    for (const [port, servername] of [
      [world.relayPort, RELAY_HOST],
      [world.dataPort, gateway.hostname],
    ] as const) {
      // A direct client that forges a header gets no further than it would have before.
      expect(await handshake(port, "127.0.0.1", servername, header)).toBe(false);
      // The front itself must send one.
      expect(await handshake(port, FRONT, servername)).toBe(false);
      // A direct client without one is served as before, and the front's clients are too.
      expect(await handshake(port, "127.0.0.1", servername)).toBe(true);
    }
    expect(await handshake(control.port, "127.0.0.7", RELAY_HOST)).toBe(true);
    expect(await handshake(data.port, "127.0.0.7", gateway.hostname)).toBe(true);
    const health = await fetch(`https://127.0.0.1:${world.relayPort}/healthz`);
    expect(health.status).toBe(200);
  }, 120_000);
});
