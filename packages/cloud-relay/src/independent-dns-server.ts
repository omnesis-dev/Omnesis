// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { assertRecoveryPolicyCurrent } from "./recovery-verifier.js";
import { LoginAdmission, type LoginLimits } from "./admission.js";
import { RelayError } from "./tunnels.js";
import {
  IndependentDnsService,
  type IndependentDnsServiceOptions,
} from "./independent-dns-service.js";
import type { Socket } from "node:net";

async function input(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new RelayError(415, "JSON required");
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 40_000) throw new RelayError(413, "DNS proof request is too large");
    parts.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new RelayError(400, "Invalid DNS proof request");
  }
}

/** Run with its own token/journal/policy files and independent deployment identity, not inside the relay process. */
export function createIndependentDnsBroker(
  options: IndependentDnsServiceOptions & {
    tls?: { cert: string; key: string };
    loginLimits?: LoginLimits;
  },
) {
  const service = new IndependentDnsService(options);
  const admission = LoginAdmission.fromLimits(options.loginLimits);
  const server = options.tls ? createHttpsServer(options.tls) : createServer();
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 64;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      let current = true;
      try {
        assertRecoveryPolicyCurrent(options.policy);
      } catch {
        current = false;
      }
      res.writeHead(current ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      req.resume();
      res.end(
        JSON.stringify({
          ok: current,
          protocol: "omnesis-independent-dns-v1",
          recovery: {
            epoch: options.policy.epoch,
            expiresAt: options.policy.expiresAt,
            state: current ? "current" : "expired",
          },
        }),
      );
      return;
    }
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const timer = setTimeout(() => {
      abort.abort();
      req.destroy();
      res.destroy();
    }, 15_000);
    void admission
      .run(async () => {
        if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
        if (req.url !== "/_dns/v1/challenge" && req.url !== "/_dns/v1/complete")
          throw new RelayError(404, "Unknown independent DNS endpoint");
        const body = await input(req);
        const result =
          req.url === "/_dns/v1/challenge"
            ? service.challenge(body)
            : await service.complete(body, abort.signal);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      }, req)
      .catch((error: unknown) => {
        res.shouldKeepAlive = false;
        if (!res.headersSent)
          res.writeHead(error instanceof RelayError ? error.status : 400, {
            "cache-control": "no-store",
          });
        res.end(undefined, () => req.destroy());
      })
      .finally(() => clearTimeout(timer));
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      return (closing ??= (async () => {
        service.close();
        const stopped = server.listening
          ? new Promise<Error | undefined>((resolve) => server.close((error) => resolve(error)))
          : Promise.resolve(undefined);
        for (const socket of sockets) socket.destroy();
        const [dns] = await Promise.allSettled([options.dns.close(), stopped]);
        if (dns.status === "rejected") throw dns.reason;
        const error = await stopped;
        if (error) throw error;
      })());
    },
  };
}
