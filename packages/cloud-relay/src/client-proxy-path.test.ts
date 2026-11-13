// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { closeServer, echoGateway, fixture, listen, tlsFiles, until } from "../test/support.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
import { probeGatewayDevice } from "./adaptive-probe.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { certificateFingerprint } from "./gateway-binding.js";
import { pinnedGatewayJson } from "./google-device-pairing.js";
import { connectOrigin } from "./network.js";

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

const authorization = { authorization: "Bearer fixture-token" };
const coded = (code: string) => Object.assign(new Error(code), { code });

/**
 * A gateway behind a relay, and a device whose one home address can be made to behave like the
 * networks a laptop meets: the gateway's own (`home`), a network where that address is routed
 * nowhere and every packet is dropped (`silent`: the dial never completes and nothing refuses
 * it), one that refuses it (`refused`), and one where another machine holds it (`foreign`).
 */
async function travelling() {
  const gateway = await echoGateway();
  const stranger = await echoGateway();
  const f = await fixture();
  await f.tunnel(gateway.url);
  const state = { network: "home" as "home" | "silent" | "refused" | "foreign", relay: true };
  const homePort = Number(new URL(gateway.url).port);
  const hint = { address: "192.168.1.20", port: homePort };
  const dials = { home: 0, relay: 0 };
  const dropped = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(coded("ABORT_ERR")), { once: true }),
    );
  // Synthetic private hints map only to these isolated loopback TLS fixtures.
  const dial: typeof connectOrigin = (origin, ca, signal, opaque, pin, _host, port, spki) => {
    if (port === undefined) {
      dials.relay++;
      if (!state.relay) return Promise.reject(coded("ENETUNREACH"));
      return connectOrigin(origin, ca, signal, opaque, pin, "127.0.0.1", undefined, spki);
    }
    dials.home++;
    if (state.network === "silent") return dropped(signal!);
    if (state.network === "refused") return Promise.reject(coded("ECONNREFUSED"));
    const target = state.network === "home" ? port : Number(new URL(stranger.url).port);
    return connectOrigin(origin, ca, signal, opaque, pin, "127.0.0.1", target, spki);
  };
  const path = new AdaptiveGatewayPath({
    candidates: [hint],
    probe: (candidate, signal) => {
      if (state.network === "silent") return dropped(signal);
      if (state.network === "refused") return Promise.reject(coded("ECONNREFUSED"));
      return probeGatewayDevice(
        {
          gateway: { publicOrigin: f.gatewayUrl, certificate: gateway.certificate },
          deviceId: "00000000-0000-4000-8000-000000000001",
          token: "fixture-token",
          candidate:
            state.network === "home"
              ? candidate
              : { ...candidate, port: Number(new URL(stranger.url).port) },
          candidates: [hint],
          signal,
        },
        (target, route, body, deadline, _host, options) =>
          pinnedGatewayJson(target, route, body, deadline, "127.0.0.1", options),
      );
    },
  });
  const proxy = createRelayClientProxy(
    {
      gatewayUrl: f.gatewayUrl,
      gatewayCa: gateway.certificate,
      gatewayFingerprint: gateway.fingerprint,
      expectedGatewayToken: "fixture-token",
      adaptivePath: path,
    },
    { connect: dial },
  );
  const url = await listen(proxy.server);
  const sockets: WebSocket[] = [];
  return {
    state,
    dials,
    path,
    url,
    gateway,
    stranger,
    hint,
    relayOptions: {
      gatewayUrl: f.gatewayUrl,
      gatewayCa: gateway.certificate,
      gatewayFingerprint: gateway.fingerprint,
      expectedGatewayToken: "fixture-token",
    },
    dial,
    /** One request through the adapter; resolves to the route the gateway saw it arrive on. */
    async request(body = "payload"): Promise<string> {
      const response = await fetch(url + "/binary", {
        method: "POST",
        headers: authorization,
        body,
      });
      expect(await response.text()).toBe(body);
      return String(gateway.requests.at(-1)!.headers["x-omnesis-connection-path"]);
    },
    async socket(): Promise<{ ws: WebSocket; route: string }> {
      const ws = new WebSocket(url.replace("http:", "ws:") + "/device/ws", {
        headers: authorization,
      });
      sockets.push(ws);
      await once(ws, "open");
      ws.send("ping");
      expect(String((await once(ws, "message"))[0])).toBe("ping");
      return { ws, route: String(gateway.requests.at(-1)!.headers["x-omnesis-connection-path"]) };
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await proxy.close();
      await f.close();
      await gateway.close();
      await stranger.close();
    },
  };
}

test("started away, where the home address drops every packet, no connection waits on it", async () => {
  const t = await travelling();
  try {
    t.state.network = "silent";
    // The one look at start: nothing answers, so the adapter knows it is not at home.
    await t.path.check();
    expect(t.path.isLocal()).toBe(false);
    for (let index = 0; index < 5; index++) expect(await t.request()).toBe("relay");
    expect((await t.socket()).route).toBe("relay");
    // Not one of them dialled the home address, so none paid its timeout.
    expect(t.dials.home).toBe(0);
  } finally {
    await t.close();
  }
});

test("leaving home mid-connection moves requests, the open stream and the socket to the relay, and coming home moves them back", async () => {
  const t = await travelling();
  try {
    await t.path.check();
    expect(await t.request()).toBe("local");
    const home = await t.socket();
    expect(home.route).toBe("local");
    // A long-lived response on the home route, as an event stream or a slow download would be.
    const stream = await fetch(t.url + "/stream", { headers: authorization });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    const ended = reader.read().then(
      (chunk) => chunk.done,
      () => true,
    );
    const socketClosed = once(home.ws, "close");

    // The laptop leaves: the home address now drops every packet.
    t.state.network = "silent";
    await t.path.check();
    // One unanswered check is not yet proof; nothing is torn down for a slow reply.
    expect(t.path.isLocal()).toBe(true);
    expect(home.ws.readyState).toBe(WebSocket.OPEN);
    // A request made now waits for the home address once, completes over the relay, and its
    // failure to reach home is the second observation that releases the route.
    expect(await t.request("sent-while-leaving")).toBe("relay");
    await until(() => !t.path.isLocal());
    await socketClosed;
    expect(await ended).toBe(true);
    // The body went to the gateway exactly once.
    expect(
      t.gateway.requests.filter((row) => row.body.toString() === "sent-while-leaving"),
    ).toHaveLength(1);

    // Away: nothing dials home any more, and the reconnecting socket lands on the relay.
    const before = t.dials.home;
    expect(await t.request()).toBe("relay");
    const away = await t.socket();
    expect(away.route).toBe("relay");
    expect(t.dials.home).toBe(before);
    // A relay request that is still running when home returns is left to finish.
    const running = await fetch(t.url + "/stream", { headers: authorization });
    const runningReader = running.body!.getReader();
    await runningReader.read();

    // Home again: the next check finds it, moves the socket, and new requests go home.
    t.state.network = "home";
    const moved = once(away.ws, "close");
    await t.path.check();
    await moved;
    expect((await t.socket()).route).toBe("local");
    expect(await t.request()).toBe("local");
    const pending = await Promise.race([
      runningReader.read().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 100)),
    ]);
    expect(pending).toBe("open");
    await runningReader.cancel();
  } finally {
    await t.close();
  }
});

test("a refused home address ends the home route in one check and takes requests in flight with it", async () => {
  const t = await travelling();
  try {
    await t.path.check();
    const stream = await fetch(t.url + "/stream", { headers: authorization });
    const reader = stream.body!.getReader();
    await reader.read();
    const ended = reader.read().then(
      (chunk) => chunk.done,
      () => true,
    );
    t.state.network = "refused";
    await t.path.check();
    expect(t.path.isLocal()).toBe(false);
    expect(await ended).toBe(true);
    expect(await t.request()).toBe("relay");
  } finally {
    await t.close();
  }
});

test("on a network where another machine holds the home address, traffic uses the relay and is never blocked", async () => {
  const t = await travelling();
  try {
    t.state.network = "foreign";
    await t.path.check();
    t.path.assertUsable();
    expect(t.path.isLocal()).toBe(false);
    expect(await t.request()).toBe("relay");
    expect(t.dials.home).toBe(0);
    // Arriving there from home: the first connection meets the stranger, is completed over the
    // relay, and the adapter stops offering it the home address.
    t.state.network = "home";
    await t.path.check();
    expect(await t.request()).toBe("local");
    t.state.network = "foreign";
    expect(await t.request("met-a-stranger")).toBe("relay");
    await until(() => !t.path.isLocal());
    t.path.assertUsable();
    expect(t.stranger.requests).toEqual([]);
    // An adapter that keeps no route state skips the stranger on every connection instead.
    const plain = createRelayClientProxy(
      { ...t.relayOptions, directCandidates: [t.hint] },
      { connect: t.dial },
    );
    try {
      const response = await fetch((await listen(plain.server)) + "/binary", {
        method: "POST",
        headers: authorization,
        body: "plain",
      });
      expect(await response.text()).toBe("plain");
      expect(t.stranger.requests).toEqual([]);
    } finally {
      await plain.close();
    }
  } finally {
    await t.close();
  }
});

test("home without internet is found by the failed relay connection, not a whole interval later", async () => {
  const t = await travelling();
  try {
    t.state.network = "refused";
    await t.path.check();
    // The laptop is carried home while the internet connection there is down.
    t.state.network = "home";
    t.state.relay = false;
    const failed = await fetch(t.url + "/binary", {
      method: "POST",
      headers: authorization,
      body: "not-delivered",
    });
    expect(failed.status).toBe(502);
    await until(() => t.path.isLocal());
    expect(await t.request()).toBe("local");
    expect(
      t.gateway.requests.filter((row) => row.body.toString() === "not-delivered"),
    ).toHaveLength(0);
  } finally {
    await t.close();
  }
});

test("an upload the route stops accepting is given up, while a slow upload and a silent wait are left alone", async () => {
  // Client, adapter and gateway share this process, so the stall period must stay well clear of
  // the pauses a loaded machine imposes on it: a timer that comes due while the process is not
  // running fires before the writes that completed meanwhile are seen.
  const stallMs = 2_000;
  const directory = await mkdtemp(join(tmpdir(), "omnesis-stall-"));
  const files = tlsFiles(directory, "gateway.example.test");
  const certificate = await readFile(files.certFile, "utf8");
  let slowReceived = 0;
  const gateway = httpsServer(
    { cert: certificate, key: await readFile(files.keyFile, "utf8") },
    (req, res) => {
      // Never read: the kernel buffers fill and the route accepts nothing more.
      if (req.url === "/stalled") return;
      if (req.url === "/quiet") {
        // Nothing moves in either direction for longer than a stall period, as while transcribing.
        req.resume();
        setTimeout(() => res.end("answered"), stallMs * 1.5);
        return;
      }
      // Paced by the receiver for longer than a stall period: it takes one chunk every few
      // milliseconds, so the adapter holds unsent bytes the whole time and the route keeps
      // accepting some of them.
      const started = Date.now();
      req.on("data", (chunk: Buffer) => {
        slowReceived += chunk.length;
        if (Date.now() - started >= stallMs * 1.5) return;
        req.pause();
        setTimeout(() => req.resume(), 10);
      });
      req.on("end", () => res.end(String(Date.now() - started)));
    },
  );
  const address = await listen(gateway);
  const options = {
    gatewayUrl: address.replace("http://127.0.0.1", "https://gateway.example.test"),
    gatewayCa: certificate,
    gatewayFingerprint: certificateFingerprint(certificate),
    gatewayConnectHost: "127.0.0.1",
  };
  const proxy = createRelayClientProxy(options, { stallMs });
  const inert = createRelayClientProxy(options, { connect: async () => new PassThrough() });
  try {
    const url = await listen(proxy.server);
    const inertUrl = await listen(inert.server);
    // Far more than the receiver takes while it paces, and than the kernel can hold.
    const size = 48 * 1024 * 1024;
    const [stalled, slow, quiet] = await Promise.all([
      fetch(url + "/stalled", { method: "POST", body: Buffer.alloc(size) }).then(
        (response) => response.status,
        () => "closed",
      ),
      fetch(url + "/slow", { method: "POST", body: Buffer.alloc(size) }).then((response) =>
        response.text(),
      ),
      fetch(url + "/quiet", { method: "POST", body: "question" }).then((response) =>
        response.text(),
      ),
    ]);
    // The adapter ended it, either as a 502 or by closing the upload, long before the kernel would.
    expect([502, "closed"]).toContain(stalled);
    // Bytes kept moving, slowly, for longer than a stall period: the whole upload arrived.
    expect(slowReceived).toBe(size);
    expect(Number(slow)).toBeGreaterThanOrEqual(stallMs * 1.5);
    expect(quiet).toBe("answered");
    // A transport that is not a socket has no timer to arm; the request still fails cleanly.
    expect((await fetch(inertUrl + "/quiet")).status).toBe(502);
  } finally {
    await proxy.close();
    await inert.close();
    // Closing again, as overlapping teardown paths may, is harmless.
    await proxy.close();
    await closeServer(gateway);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("closing an adapter that never listened is not an error, and a real close failure still is", async () => {
  const options = {
    gatewayUrl: "https://gateway.example.test",
    gatewayFingerprint: "a".repeat(64),
  };
  await createRelayClientProxy(options).close();
  const failing = createRelayClientProxy(options);
  vi.spyOn(failing.server, "close").mockImplementation(function (
    this: typeof failing.server,
    done?: (error?: Error) => void,
  ) {
    done?.(new Error("close failed"));
    return this;
  });
  await expect(failing.close()).rejects.toThrow("close failed");
});
