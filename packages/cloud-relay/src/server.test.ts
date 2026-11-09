// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixture, echoGateway, openWs, listen } from "../test/support.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { SESSION_HEADER } from "./network.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";
import type { WebSocket } from "ws";

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("opaque cloud relay transport", () => {
  test("native adapters preserve HTTP methods, bodies and gateway auth inside pinned TLS", async () => {
    const f = await fixture();
    const gateway = await echoGateway();
    const proxy = f.proxy(gateway);
    const url = await listen(proxy.server);
    try {
      await f.tunnel(gateway.url);
      expect((await fetch(`${url}/api/documents`)).status).toBe(401);
      const response = await fetch(`${url}/mcp?session=fictional`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-token",
          [SESSION_HEADER]: "must-not-cross-data-plane",
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
        },
        body: '{"jsonrpc":"2.0"}',
      });
      expect(response.status).toBe(200);
      expect(response.headers.has(SESSION_HEADER)).toBe(false);
      expect(await response.json()).toEqual({
        path: "/mcp?session=fictional",
        method: "POST",
        body: '{"jsonrpc":"2.0"}',
        authorization: "Bearer fixture-token",
      });
      const forwarded = gateway.requests.at(-1)!;
      expect(forwarded.headers[SESSION_HEADER]).toBeUndefined();
      expect(forwarded.headers["x-forwarded-for"]).toBeUndefined();
      expect(forwarded.headers["x-real-ip"]).toBeUndefined();
      const body = randomBytes(2 * 1024 * 1024);
      const binary = await fetch(`${url}/binary`, {
        method: "PUT",
        headers: { authorization: "Bearer fixture-token" },
        body,
      });
      expect(binary.status).toBe(201);
      expect(Buffer.from(await binary.arrayBuffer())).toEqual(body);
      expect(
        (await fetch(`${url}/disconnect`, { headers: { authorization: "Bearer fixture-token" } }))
          .status,
      ).toBe(502);
    } finally {
      await proxy.close();
      await f.close();
      await gateway.close();
    }
  });

  test("control listener refuses all application paths even with valid routing identity", async () => {
    const f = await fixture();
    try {
      for (const path of ["/api/status", "/mcp", "/_relay/not-real"]) {
        for (const headers of [
          {},
          { [SESSION_HEADER]: f.session.token },
          { [SESSION_HEADER]: "forged" },
        ] as Record<string, string>[])
          expect((await fetch(f.url + path, { headers })).status).toBe(404);
      }
      const health = await fetch(`${f.url}/healthz`);
      expect(await health.json()).toEqual({ ok: true, protocol: 2 });
      expect(health.headers.has("access-control-allow-origin")).toBe(false);
      await expect(openWs(`${f.url}/device/ws`)).rejects.toThrow("401");
      await expect(
        openWs(`${f.url}/device/ws`, { [SESSION_HEADER]: f.session.token }),
      ).rejects.toThrow("404");
      for (const token of ["invalid", "x".repeat(4097)])
        await expect(
          openWs(`${f.url}/_relay/v1/data`, { [SESSION_HEADER]: token }),
        ).rejects.toThrow("401");
    } finally {
      await f.close();
    }
  });

  test("one gateway per account and one-use data tickets remain account-bound", async () => {
    const f = await fixture();
    const gatewayId = f.register();
    const headers = {
      [SESSION_HEADER]: f.session.token,
      "x-omnesis-gateway-id": gatewayId,
      "x-omnesis-tunnel-protocol": "2",
    };
    let control: WebSocket | undefined;
    try {
      await expect(
        openWs(`${f.url}/_relay/v1/tunnel`, { [SESSION_HEADER]: f.session.token }),
      ).rejects.toThrow("426");
      await expect(
        openWs(`${f.url}/_relay/v1/tunnel`, {
          [SESSION_HEADER]: f.session.token,
          "x-omnesis-tunnel-protocol": "2",
        }),
      ).rejects.toThrow("400");
      control = await openWs(`${f.url}/_relay/v1/tunnel`, headers);
      await expect(openWs(`${f.url}/_relay/v1/tunnel`, headers)).rejects.toThrow("409");
      await expect(
        openWs(`${f.url}/_relay/v1/data`, { [SESSION_HEADER]: f.session.token }),
      ).rejects.toThrow("403");
      const other = await f.login("other-fictional-account");
      const next = once(control, "message");
      const client = f.probe();
      const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      const ticket = JSON.parse((await next)[0].toString()).ticket as string;
      await expect(
        openWs(`${f.url}/_relay/v1/data`, {
          [SESSION_HEADER]: other.token,
          "x-omnesis-relay-ticket": ticket,
        }),
      ).rejects.toThrow("403");
      const data = await openWs(`${f.url}/_relay/v1/data`, {
        [SESSION_HEADER]: f.session.token,
        "x-omnesis-relay-ticket": ticket,
      });
      await expect(
        openWs(`${f.url}/_relay/v1/data`, {
          [SESSION_HEADER]: f.session.token,
          "x-omnesis-relay-ticket": ticket,
        }),
      ).rejects.toThrow("403");
      data.terminate();
      await clientClosed;
      const close = once(control, "close");
      control.close();
      await close;
      await expect(
        openWs(`${f.url}/_relay/v1/tunnel`, { ...headers, "x-omnesis-gateway-id": randomUUID() }),
      ).rejects.toThrow("409");
      control = await openWs(`${f.url}/_relay/v1/tunnel`, headers);
      control.send("invalid control payload");
      await once(control, "close");
    } finally {
      control?.terminate();
      await f.close();
    }
  });

  test("gateway and encrypted stream admission are bounded and disconnect drains pending work", async () => {
    const f = await fixture({
      limits: {
        ...DEFAULT_TUNNEL_LIMITS,
        maxGateways: 1,
        maxStreams: 2,
        maxStreamsPerGateway: 1,
        connectTimeoutMs: 100,
      },
    });
    let control: WebSocket | undefined;
    try {
      const gatewayId = f.register();
      control = await openWs(`${f.url}/_relay/v1/tunnel`, {
        [SESSION_HEADER]: f.session.token,
        "x-omnesis-gateway-id": gatewayId,
        "x-omnesis-tunnel-protocol": "2",
      });
      const other = await f.login("other-fictional-account");
      await expect(
        openWs(`${f.url}/_relay/v1/tunnel`, {
          [SESSION_HEADER]: other.token,
          "x-omnesis-gateway-id": randomUUID(),
          "x-omnesis-tunnel-protocol": "2",
        }),
      ).rejects.toThrow("503");
      const opened = once(control, "message");
      const first = f.probe();
      const closedFirst = new Promise<void>((resolve) => first.once("close", () => resolve()));
      await opened;
      const second = f.probe();
      await new Promise<void>((resolve) => second.once("close", () => resolve()));
      await closedFirst;
      const next = once(control, "message");
      const pending = f.probe();
      const closedPending = new Promise<void>((resolve) => pending.once("close", () => resolve()));
      await next;
      control.terminate();
      await closedPending;
    } finally {
      control?.terminate();
      await f.close();
    }
  });
});

describe("identity exchange boundary", () => {
  test("validates body, content type, credential, size, and login capacity", async () => {
    const f = await fixture();
    try {
      expect((await fetch(`${f.url}/_relay/v1/login`, { method: "POST", body: "{}" })).status).toBe(
        415,
      );
      for (const body of ["not json", "{}", '{"idToken":1}', '{"idToken":"x","extra":true}'])
        expect(
          (
            await fetch(`${f.url}/_relay/v1/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await fetch(`${f.url}/_relay/v1/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"idToken":"invalid"}',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${f.url}/_relay/v1/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(20_001),
          })
        ).status,
      ).toBe(413);
    } finally {
      await f.close();
    }
  });
});

describe("gateway directory boundary", () => {
  test("registration validates identity, account, hostname ownership, body size and method", async () => {
    const proof = vi.fn(async () => true);
    const f = await fixture({ hostnameProof: proof });
    const gateway = await echoGateway();
    const route = `${f.url}/_relay/v2/gateway`;
    const headers = { [SESSION_HEADER]: f.session.token, "content-type": "application/json" };
    const value = {
      gatewayId: randomUUID(),
      publicOrigin: f.gatewayUrl,
      certificate: gateway.certificate,
    };
    const identityToken = await new SignJWT({ nonce: gatewayBindingNonce(value) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("omnesis-local-test")
      .setSubject("fictional-account")
      .setAudience("omnesis-cloud-relay")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(f.key);
    const binding = { ...value, identityToken };
    const post = (body: string) => fetch(route, { method: "POST", headers, body });
    try {
      expect((await fetch(route)).status).toBe(401);
      expect((await fetch(route, { headers: { [SESSION_HEADER]: "invalid" } })).status).toBe(401);
      expect((await fetch(route, { headers })).status).toBe(404);
      expect((await fetch(route, { method: "DELETE", headers })).status).toBe(405);
      for (const body of [
        "invalid",
        "{}",
        JSON.stringify({ ...binding, identityToken: "forged" }),
        JSON.stringify({ ...binding, gatewayId: randomUUID() }),
      ])
        expect((await post(body)).status).toBe(400);
      expect((await post("x".repeat(40_001))).status).toBe(413);
      proof.mockResolvedValueOnce(false);
      expect((await post(JSON.stringify(binding))).status).toBe(403);
      expect((await post(JSON.stringify(binding))).status).toBe(204);
      const response = await fetch(route, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(binding);
      expect(proof).toHaveBeenCalledWith(
        "gateway.example.test",
        f.session.accountId,
        value.gatewayId,
      );
      const other = await f.login("another-fictional-account");
      expect((await fetch(route, { headers: { [SESSION_HEADER]: other.token } })).status).toBe(404);
      expect(
        (
          await fetch(route, {
            method: "POST",
            headers: { ...headers, [SESSION_HEADER]: other.token },
            body: JSON.stringify(binding),
          })
        ).status,
      ).toBe(400);
    } finally {
      await f.close();
      await gateway.close();
    }
  });

  test("standard bearer control credentials reject duplicates, conflicting headers and malformed schemes", async () => {
    const f = await fixture();
    const route = `${f.url}/_relay/v2/gateway`;
    try {
      for (const headers of [
        { authorization: `Bearer ${f.session.token}` },
        { authorization: `bearer ${f.session.token}` },
        { [SESSION_HEADER]: f.session.token },
      ])
        expect(await rawStatus(route, headers)).toBe(404);
      for (const headers of [
        { authorization: "Basic fictional" },
        { authorization: "Bearer" },
        { authorization: "Bearer invalid extra" },
        { authorization: "Bearer invalid" },
        { authorization: `Bearer ${"a".repeat(4097)}` },
        { authorization: [`Bearer ${f.session.token}`, `Bearer ${f.session.token}`] },
        { [SESSION_HEADER]: [f.session.token, f.session.token] },
        { authorization: `Bearer ${f.session.token}`, [SESSION_HEADER]: f.session.token },
      ])
        expect(await rawStatus(route, headers)).toBe(401);
      const ws = await openWs(`${f.url}/_relay/v1/tunnel`, {
        authorization: `Bearer ${f.session.token}`,
        "x-omnesis-gateway-id": randomUUID(),
        "x-omnesis-tunnel-protocol": "2",
      });
      ws.terminate();
    } finally {
      await f.close();
    }
  });

  test("operator-hosted gateway names use the relay domain ownership proof", async () => {
    const gatewayId = randomUUID();
    const hostname = hostedGatewayHostname(gatewayId, "relay.example.test");
    const f = await fixture({ relayDomain: "relay.example.test" });
    const gateway = await echoGateway(hostname);
    try {
      const binding = {
        gatewayId,
        publicOrigin: `https://${hostname}:${f.dataPort}`,
        certificate: gateway.certificate,
      };
      const identityToken = await new SignJWT({ nonce: gatewayBindingNonce(binding) })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("omnesis-local-test")
        .setSubject("fictional-account")
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(f.key);
      expect(
        (
          await fetch(`${f.url}/_relay/v2/gateway`, {
            method: "POST",
            headers: { [SESSION_HEADER]: f.session.token },
            body: JSON.stringify({ ...binding, identityToken }),
          })
        ).status,
      ).toBe(204);
      expect(f.accounts.accountForHostname(hostname)).toBe(f.session.accountId);
    } finally {
      await f.close();
      await gateway.close();
    }
  });

  test("registration is unavailable without a separate gateway identity provider", async () => {
    const f = await fixture({ gatewayIdentity: undefined });
    try {
      expect(
        (
          await fetch(`${f.url}/_relay/v2/gateway`, {
            method: "POST",
            headers: { [SESSION_HEADER]: f.session.token },
            body: "{}",
          })
        ).status,
      ).toBe(503);
    } finally {
      await f.close();
    }
  });
});

describe("native client adapter", () => {
  test("CLI/collector HTTP and WebSocket traffic uses pinned TLS without routing credentials", async () => {
    const f = await fixture();
    const gateway = await echoGateway();
    const proxy = f.proxy(gateway);
    const url = await listen(proxy.server);
    try {
      await f.tunnel(gateway.url);
      const response = await fetch(`${url}/api/status`, {
        headers: { authorization: "Bearer fixture-token" },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).authorization).toBe("Bearer fixture-token");
      expect((await fetch(`${url}/api/status`)).status).toBe(401);
      const ws = await openWs(`${url}/device/ws`, { authorization: "Bearer fixture-token" });
      const reply = once(ws, "message");
      ws.send("device-hello");
      expect((await reply)[0].toString()).toBe("device-hello");
      const closed = once(ws, "close");
      await proxy.close();
      await closed;
    } finally {
      if (proxy.server.listening) await proxy.close();
      await f.close();
      await gateway.close();
    }
  });

  test("an adapter refuses plaintext origins and absent or malformed pins", () => {
    for (const options of [
      { gatewayUrl: "http://127.0.0.1:1", gatewayFingerprint: "a".repeat(64) },
      { gatewayUrl: "https://gateway.example.test", gatewayFingerprint: "" },
      { gatewayUrl: "https://gateway.example.test", gatewayFingerprint: "a".repeat(63) },
    ])
      expect(() => createRelayClientProxy(options)).toThrow(
        "verified gateway HTTPS origin and certificate pin",
      );
  });

  test("blocks browser requests, rebinding hosts, and control-plane access", async () => {
    const proxy = createRelayClientProxy({
      gatewayUrl: "https://localhost:1",
      gatewayFingerprint: "a".repeat(64),
    });
    const url = await listen(proxy.server);
    try {
      for (const headers of [
        { origin: "https://attacker.example.test" },
        { "sec-fetch-site": "cross-site" },
        { host: "attacker.example.test" },
      ])
        expect(await rawStatus(`${url}/api/status`, headers)).toBe(403);
      expect((await fetch(`${url}/_relay/v1/tunnel`)).status).toBe(403);
      await expect(openWs(`${url}/_relay/v1/tunnel`)).rejects.toThrow("403");
      await expect(
        openWs(`${url}/device/ws`, { origin: "https://attacker.example.test" }),
      ).rejects.toThrow("403");
      expect((await fetch(`${url}/api/status`)).status).toBe(502);
      await expect(openWs(`${url}/device/ws`)).rejects.toThrow("502");
    } finally {
      await proxy.close();
    }
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
    expect(() =>
      createRelayClientProxy({ gatewayUrl: url, gatewayFingerprint: "a".repeat(64) }),
    ).toThrow("OMNESIS_CLOUD_RELAY_ENABLED=1");
  });

  test("shutdown terminates an active streaming response", async () => {
    const f = await fixture();
    const gateway = await echoGateway();
    const proxy = f.proxy(gateway);
    const url = await listen(proxy.server);
    try {
      await f.tunnel(gateway.url);
      const response = await fetch(`${url}/stream`, {
        headers: { authorization: "Bearer fixture-token" },
      });
      const reader = response.body!.getReader();
      await reader.read();
      await proxy.close();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      if (proxy.server.listening) await proxy.close();
      await f.close();
      await gateway.close();
    }
  });
});

async function rawStatus(
  url: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const fields = Object.entries(headers).flatMap(([name, values]) =>
      values === undefined
        ? []
        : (Array.isArray(values) ? values : [values]).flatMap((value) => [name, value]),
    );
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "host"))
      fields.push("Host", new URL(url).host);
    const req = request(url, { headers: fields }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}
