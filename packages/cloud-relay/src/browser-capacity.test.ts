// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request, type ClientRequest } from "node:https";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { echoGateway, fixture } from "../test/support.js";
import { SESSION_HEADER } from "./network.js";
import type { IncomingMessage } from "node:http";

test("same-address native streams and a browser's six parallel module requests coexist through opaque TLS", async () => {
  const gateway = await echoGateway();
  const relay = await fixture();
  const requests: ClientRequest[] = [];
  const native: IncomingMessage[] = [];
  const start = (path: string): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      // Separate HTTP/1 connections model the browser's six-slot origin pool;
      // native streams deliberately share its public client-address bucket.
      const req = request(
        relay.gatewayUrl + path,
        {
          hostname: "127.0.0.1",
          servername: "gateway.example.test",
          ca: gateway.certificate,
          agent: false,
          headers: { authorization: "Bearer fixture-token" },
        },
        resolve,
      );
      requests.push(req);
      req.on("error", reject);
      req.end();
    });
  try {
    await relay.tunnel(gateway.url);
    for (let i = 0; i < 3; i++) native.push(await start("/stream"));
    // Submit all six browser requests before any can finish. The gateway returns
    // complete assets, never a timing-dependent slow response.
    const modules = await Promise.all(
      Array.from({ length: 6 }, (_, i) => start(`/module-${i}.js`)),
    );
    const bodies = await Promise.all(
      modules.map(async (response) => {
        expect(response.statusCode).toBe(200);
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString()) as { path: string };
      }),
    );
    expect(bodies.map((body) => body.path)).toEqual(
      Array.from({ length: 6 }, (_, i) => `/module-${i}.js`),
    );
    expect(native.every((response) => !response.destroyed && !response.complete)).toBe(true);
    expect(relay.relay.metrics()).not.toContain(
      'cloud_relay_stream_events_total{event="client_capacity"}',
    );
  } finally {
    for (const req of requests) req.destroy();
    await relay.close();
    await gateway.close();
  }
});

test.each([false, true])(
  "the control handshake negotiates channel refusal without changing legacy ready frames (capable=%s)",
  async (capable) => {
    const relay = await fixture();
    const gatewayId = relay.register();
    try {
      const control = new WebSocket(relay.url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
        headers: {
          [SESSION_HEADER]: relay.session.token,
          "x-omnesis-tunnel-protocol": "2",
          "x-omnesis-gateway-id": gatewayId,
          ...(capable ? { "x-omnesis-reject-channels": "1" } : {}),
        },
      });
      try {
        const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
          control.once("message", (raw) => resolve(JSON.parse(raw.toString())));
          control.once("error", reject);
        });
        expect(ready).toEqual({
          type: "ready",
          version: 1,
          heartbeatMs: 30_000,
          ...(capable ? { rejectChannels: true } : {}),
        });
      } finally {
        control.terminate();
      }
    } finally {
      await relay.close();
    }
  },
);
