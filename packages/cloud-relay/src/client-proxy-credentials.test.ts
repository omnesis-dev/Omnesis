// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { websocketAuthProtocol } from "@omnesis/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, echoGateway, listen } from "../test/support.js";
import { createRelayClientProxy } from "./client-proxy.js";

beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
afterEach(() => vi.unstubAllEnvs());

type Headers = Record<string, string | string[]>;
async function rawStatus(
  url: string,
  headers: Headers = {},
  method = "GET",
  upgrade = false,
): Promise<number> {
  const values: Headers = {
    host: new URL(url).host,
    ...(upgrade
      ? {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "AAECAwQFBgcICQoLDA0ODw==",
        }
      : {}),
    ...headers,
  };
  const fields = Object.entries(values).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values]).flatMap((value) => [name, value]),
  );
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: fields }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end(headers["content-length"] === "1" ? "x" : undefined);
  });
}

test("a device-file adapter refuses other gateway credentials before opening TLS and never injects its saved token", async () => {
  const f = await fixture();
  const gateway = await echoGateway();
  const proxy = createRelayClientProxy({
    gatewayUrl: f.gatewayUrl,
    gatewayCa: gateway.certificate,
    gatewayFingerprint: gateway.fingerprint,
    gatewayConnectHost: "127.0.0.1",
    expectedGatewayToken: "fixture-token",
  });
  const url = await listen(proxy.server);
  try {
    await f.tunnel(gateway.url);
    const before = gateway.requests.length;
    for (const headers of [
      {},
      { authorization: "Bearer old-gateway-token" },
      { authorization: "Basic fixture-token" },
      { authorization: ["Bearer fixture-token", "Bearer old-gateway-token"] },
      { authorization: "Bearer fixture-token", cookie: "old-gateway-session=private" },
      { "sec-websocket-protocol": websocketAuthProtocol("fixture-token") },
    ] as Headers[])
      expect(await rawStatus(`${url}/api/status`, headers)).toBe(403);
    expect(await rawStatus(`${url}/health?token=old-gateway-token`)).toBe(403);
    expect(await rawStatus(`${url}/health`, {}, "POST")).toBe(403);
    expect(await rawStatus(`${url}/health`, { "content-length": "1" })).toBe(403);
    expect(await rawStatus(`${url}/health`, { "transfer-encoding": "chunked" })).toBe(403);
    expect(gateway.requests.length).toBe(before);
    expect(await rawStatus(`${url}/health`)).toBe(200);
    expect(await rawStatus(`${url}/health`, { "content-length": "0" }, "HEAD")).toBe(200);
    expect(gateway.requests.at(-1)!.headers.authorization).toBeUndefined();
    expect(await rawStatus(`${url}/api/status`, { authorization: "Bearer fixture-token" })).toBe(
      200,
    );
    expect(gateway.requests.at(-1)!.headers.authorization).toBe("Bearer fixture-token");
    expect(JSON.stringify(gateway.requests)).not.toContain("old-gateway-token");
  } finally {
    await proxy.close();
    await f.close();
    await gateway.close();
  }
});

test("WebSocket credentials are destination-bound and ambiguous transports cannot leak a stale account token", async () => {
  const f = await fixture();
  const gateway = await echoGateway();
  const proxy = createRelayClientProxy({
    gatewayUrl: f.gatewayUrl,
    gatewayCa: gateway.certificate,
    gatewayFingerprint: gateway.fingerprint,
    gatewayConnectHost: "127.0.0.1",
    expectedGatewayToken: "fixture-token",
  });
  const url = await listen(proxy.server);
  try {
    await f.tunnel(gateway.url);
    const before = gateway.requests.length;
    for (const headers of [
      {},
      { "sec-websocket-protocol": "unrelated-protocol" },
      { "sec-websocket-protocol": websocketAuthProtocol("old-gateway-token") },
      {
        "sec-websocket-protocol": `${websocketAuthProtocol("fixture-token")},${websocketAuthProtocol("old-gateway-token")}`,
      },
      { "sec-websocket-protocol": [websocketAuthProtocol("fixture-token"), "unrelated-protocol"] },
      {
        "sec-websocket-protocol": websocketAuthProtocol("fixture-token"),
        authorization: "Bearer fixture-token",
      },
      { "sec-websocket-protocol": `${websocketAuthProtocol("fixture-token")} bad` },
      { "sec-websocket-protocol": websocketAuthProtocol("x".repeat(4097)) },
    ] as Headers[])
      expect(await rawStatus(`${url}/device/ws`, headers, "GET", true)).toBe(403);
    expect(gateway.requests.length).toBe(before);
    for (const credential of ["header", "protocol"]) {
      const ws =
        credential === "header"
          ? new WebSocket(`${url.replace("http:", "ws:")}/device/ws`, {
              headers: { authorization: "Bearer fixture-token" },
            })
          : new WebSocket(`${url.replace("http:", "ws:")}/device/ws`, [
              "application-protocol",
              websocketAuthProtocol("fixture-token"),
            ]);
      await once(ws, "open");
      const echoed = once(ws, "message");
      ws.send("destination-bound-message");
      expect((await echoed)[0].toString()).toBe("destination-bound-message");
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
    expect(JSON.stringify(gateway.requests)).not.toContain("old-gateway-token");
  } finally {
    await proxy.close();
    await f.close();
    await gateway.close();
  }
});

test("invalid expected token configurations are refused without creating a listener", () => {
  for (const token of ["", "bad token", "x".repeat(4097)])
    expect(() =>
      createRelayClientProxy({
        gatewayUrl: "https://gateway.example.test",
        gatewayFingerprint: "a".repeat(64),
        expectedGatewayToken: token,
      }),
    ).toThrow("device token is invalid");
});
