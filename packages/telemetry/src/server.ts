// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { heartbeatSchema, type Heartbeat } from "./schema.js";
import type { TelemetryStore } from "./store.js";

const MAX_BODY = 1024;

async function body(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0] !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new Error("body");
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) throw new Error("body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new Error("body");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createTelemetryServer(options: {
  store: TelemetryStore;
  metricsToken: string;
  latestStable: () => string;
  now?: () => Date;
}) {
  if (options.metricsToken.length < 32)
    throw new Error("A separate metrics credential is required");
  const now = options.now ?? (() => new Date());
  // Global admission deliberately uses no IP, user agent, forwarded header or other visitor key.
  let tokens = 120;
  let lastRefill = now().getTime();
  const server = createServer({ maxHeaderSize: 4096 }, async (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "close");
      if (request.method === "GET" && request.url === "/health") {
        options.store.db.prepare("SELECT 1").get();
        response.writeHead(200).end("ok\n");
        return;
      }
      if (request.method === "GET" && request.url === "/metrics") {
        const provided = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${options.metricsToken}`);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("Content-Type", "text/plain; version=0.0.4");
        response.end(options.store.metrics(now(), options.latestStable()));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/heartbeat") {
        response.writeHead(404).end();
        return;
      }
      const at = now();
      tokens = Math.min(120, tokens + Math.max(0, at.getTime() - lastRefill) / 500);
      lastRefill = at.getTime();
      if (tokens < 1) {
        options.store.increment("limited");
        response.setHeader("Retry-After", "60");
        response.writeHead(429).end();
        return;
      }
      tokens--;
      let payload: Heartbeat;
      try {
        payload = heartbeatSchema.parse(await body(request));
      } catch {
        options.store.increment("rejected");
        response.writeHead(400).end();
        return;
      }
      const receivedAt = now();
      if (payload.period !== receivedAt.toISOString().slice(0, 7)) {
        options.store.increment("rejected");
        response.writeHead(400).end();
        return;
      }
      options.store.ingest(payload, receivedAt);
      response.writeHead(204).end();
    } catch {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
  });
  server.maxConnections = 128;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1;
  server.maxHeadersCount = 24;
  return server;
}
