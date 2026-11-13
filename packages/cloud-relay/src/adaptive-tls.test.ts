// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { fixture, echoGateway, listen } from "../test/support.js";
import { probeGatewayDevice } from "./adaptive-probe.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { connectOrigin } from "./network.js";
import { pinnedGatewayJson } from "./google-device-pairing.js";
afterEach(() => vi.unstubAllEnvs());

test("verified authenticated LAN return migrates an existing relay WebSocket without replaying HTTP, then revocation fails closed", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  let authorized = true,
    lan = false;
  const gateway = await echoGateway(
    "gateway.example.test",
    (value) => authorized && value === "Bearer fixture-token",
  );
  const f = await fixture();
  let relayConnections = 0;
  f.relay.dataServer.on("connection", () => relayConnections++);
  const hint = { address: "192.168.1.20", port: Number(new URL(gateway.url).port) };
  // Synthetic private hints map only to this isolated local TLS fixture.
  const dial: typeof connectOrigin = (origin, ca, signal, opaque, pin, _host, port, spki) => {
    if (port !== undefined && !lan)
      return Promise.reject(Object.assign(new Error("Away from home"), { code: "ECONNREFUSED" }));
    return connectOrigin(origin, ca, signal, opaque, pin, "127.0.0.1", port, spki);
  };
  const path = new AdaptiveGatewayPath({
    candidates: [hint],
    probe: async (candidate, signal) => {
      if (!lan) throw Object.assign(new Error("Away from home"), { code: "ECONNREFUSED" });
      return probeGatewayDevice(
        {
          gateway: { publicOrigin: f.gatewayUrl, certificate: gateway.certificate },
          deviceId: "00000000-0000-4000-8000-000000000001",
          token: "fixture-token",
          candidate,
          candidates: [hint],
          signal,
        },
        (target, path, body, deadline, _host, options) =>
          pinnedGatewayJson(target, path, body, deadline, "127.0.0.1", options),
      );
    },
  });
  const proxy = createRelayClientProxy(
    {
      gatewayUrl: f.gatewayUrl,
      gatewayCa: gateway.certificate,
      gatewayFingerprint: gateway.fingerprint,
      expectedGatewayToken: "fixture-token",
      directCandidates: [hint],
      adaptivePath: path,
    },
    { connect: dial },
  );
  const sockets: WebSocket[] = [];
  try {
    await f.tunnel(gateway.url);
    const url = await listen(proxy.server);
    const open = async () => {
      const socket = new WebSocket(url.replace("http:", "ws:") + "/device/ws", {
        headers: { authorization: "Bearer fixture-token", "x-omnesis-connection-path": "spoofed" },
      });
      sockets.push(socket);
      await once(socket, "open");
      return socket;
    };
    const relay = await open();
    expect(gateway.requests.at(-1)!.headers["x-omnesis-connection-path"]).toBe("relay");
    relay.send("before-lan");
    expect(String((await once(relay, "message"))[0])).toBe("before-lan");
    await path.check();
    expect(relay.readyState).toBe(WebSocket.OPEN);
    lan = true;
    const closed = once(relay, "close");
    await path.check();
    await closed;
    const count = relayConnections;
    const local = await open();
    expect(gateway.requests.at(-1)!.headers["x-omnesis-connection-path"]).toBe("local");
    expect(relayConnections).toBe(count);
    local.send("after-lan");
    expect(String((await once(local, "message"))[0])).toBe("after-lan");
    const body = "private-upload-with-ambiguous-reply";
    expect(
      (
        await fetch(url + "/disconnect", {
          method: "POST",
          headers: { authorization: "Bearer fixture-token" },
          body,
        })
      ).status,
    ).toBe(502);
    expect(gateway.requests.filter((value) => value.body.toString() === body)).toHaveLength(1);
    // A probe must not interrupt an unrelated body or restart the already-local WS.
    await path.check();
    expect(local.readyState).toBe(WebSocket.OPEN);
    expect(gateway.requests.filter((value) => value.body.toString() === body)).toHaveLength(1);
    lan = false;
    const localClosed = once(local, "close");
    await path.check();
    await localClosed;
    const remote = await open();
    expect(gateway.requests.at(-1)!.headers["x-omnesis-connection-path"]).toBe("relay");
    lan = true;
    authorized = false;
    const revoked = once(remote, "close");
    await path.check();
    await revoked;
    const before = relayConnections;
    expect(
      (await fetch(url + "/api/private", { headers: { authorization: "Bearer fixture-token" } }))
        .status,
    ).toBe(502);
    expect(relayConnections).toBe(before);
    expect(() => path.assertUsable()).toThrow("Repair pairing");
  } finally {
    for (const socket of sockets) socket.terminate();
    await proxy.close();
    await f.close();
    await gateway.close();
  }
});
