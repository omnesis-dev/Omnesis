// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { type Duplex } from "node:stream";
import {
  experimentalEnabled,
  parseWebSocketAuthProtocolHeader,
  WS_AUTH_PROTOCOL_PREFIX,
} from "@omnesis/core";
import { connectPreferredGateway, type DirectCandidate } from "./direct-path.js";
import { connectOrigin, forwardHttp, forwardUpgrade, relayOrigin } from "./network.js";
import { rejectUpgrade, validateTarget } from "./server.js";
import type { AdaptiveGatewayPath } from "./adaptive-path.js";
import type { AddressInfo } from "node:net";

/** Loopback adapter lets unmodified CLI/collector clients preserve their gateway credentials. */
export function createRelayClientProxy(
  options: {
    gatewayUrl: string;
    gatewayCa?: string;
    gatewayFingerprint: string;
    gatewayConnectHost?: string;
    directCandidates?: DirectCandidate[];
    tlsSpkiFingerprint?: string;
    adaptivePath?: AdaptiveGatewayPath;
    /** Reject another saved account credential instead of forwarding it to this pinned destination. */
    expectedGatewayToken?: string;
  },
  dependencies: { connect?: typeof connectOrigin } = {},
): { server: Server; close(): Promise<void> } {
  if (!experimentalEnabled()) throw new Error("Cloud relay requires OMNESIS_EXPERIMENTAL=1");
  const gateway = relayOrigin(options.gatewayUrl);
  if (gateway.protocol !== "https:" || !/^[a-f0-9]{64}$/.test(options.gatewayFingerprint))
    throw new Error("Relay client requires a verified gateway HTTPS origin and certificate pin");
  if (
    options.expectedGatewayToken !== undefined &&
    !/^[A-Za-z0-9._~-]{1,4096}$/.test(options.expectedGatewayToken)
  )
    throw new Error("Expected gateway device token is invalid");
  const expectedTokenHash =
    options.expectedGatewayToken === undefined
      ? undefined
      : createHash("sha256").update(options.expectedGatewayToken).digest();
  const server = createServer();
  const active = new Set<Duplex>();
  const incoming = new Set<Duplex>();
  const shutdown = new AbortController();
  const upgrades = new Map<Duplex, "local" | "relay">();
  const unsubscribe = options.adaptivePath?.onTransition((event) => {
    for (const [stream, path] of upgrades) {
      if (
        event === "blocked" ||
        (event === "local" && path === "relay") ||
        (event === "lost" && path === "local")
      )
        stream.destroy();
    }
  });
  server.on("connection", (socket) => {
    incoming.add(socket);
    socket.once("close", () => incoming.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  const open = async (
    signal: AbortSignal,
  ): Promise<{ stream: Duplex; path: "local" | "relay" }> => {
    options.adaptivePath?.assertUsable();
    let path: "local" | "relay" = "relay";
    const connect: typeof connectOrigin = async (...args) => {
      const stream = await (dependencies.connect ?? connectOrigin)(...args);
      path = args[6] === undefined ? "relay" : "local";
      return stream;
    };
    const stream = await connectPreferredGateway(
      {
        origin: gateway,
        certificate: options.gatewayCa,
        fingerprint: options.gatewayFingerprint,
        tlsSpkiFingerprint: options.tlsSpkiFingerprint,
        candidates: options.adaptivePath?.candidates() ?? options.directCandidates ?? [],
        signal: AbortSignal.any([shutdown.signal, signal]),
        connectHost: options.gatewayConnectHost,
      },
      connect,
    );
    active.add(stream);
    stream.once("close", () => {
      active.delete(stream);
    });
    return { stream, path };
  };
  // A browser must not be able to use a loopback adapter's pinned connection via
  // DNS rebinding or a cross-origin fetch. Native clients send neither Origin
  // nor Sec-Fetch-Site; browser clients use the public gateway origin instead.
  const nativeClient = (headers: Record<string, unknown>): boolean =>
    !headers.origin &&
    !headers["sec-fetch-site"] &&
    /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(headers.host));
  const boundCredential = (req: IncomingMessage, upgrade: boolean): boolean => {
    if (expectedTokenHash === undefined) return true;
    if (req.headers.cookie !== undefined) return false;
    const names = req.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map((name) => name.toLowerCase());
    if (
      names.filter((name) => name === "authorization").length > 1 ||
      names.filter((name) => name === "sec-websocket-protocol").length > 1
    )
      return false;
    const protocol = req.headers["sec-websocket-protocol"];
    if (protocol !== undefined && !upgrade) return false;
    const authProtocols =
      protocol?.split(",").filter((part) => part.trim().startsWith(WS_AUTH_PROTOCOL_PREFIX)) ?? [];
    if (
      authProtocols.length > 1 ||
      (req.headers.authorization !== undefined && authProtocols.length > 0)
    )
      return false;
    const credential =
      req.headers.authorization !== undefined
        ? /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(req.headers.authorization)?.[1]
        : parseWebSocketAuthProtocolHeader(protocol);
    if (credential !== null && credential !== undefined)
      return (
        credential.length <= 4096 &&
        timingSafeEqual(createHash("sha256").update(credential).digest(), expectedTokenHash)
      );
    // Anonymous checks carry neither application credentials nor request bodies.
    return (
      !upgrade &&
      req.headers.authorization === undefined &&
      protocol === undefined &&
      (req.method === "GET" || req.method === "HEAD") &&
      [
        "/health",
        "/healthz",
        "/status",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ].includes(req.url!) &&
      (req.headers["content-length"] === undefined || req.headers["content-length"] === "0") &&
      req.headers["transfer-encoding"] === undefined
    );
  };
  server.on("request", (req, res) => {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    void (async () => {
      validateTarget(req);
      if (
        !nativeClient(req.headers) ||
        req.url?.startsWith("/_relay/") ||
        !boundCredential(req, false)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const { stream, path } = await open(controller.signal);
      if (res.destroyed) {
        stream.destroy();
        return;
      }
      req.headers["x-omnesis-connection-path"] = path;
      forwardHttp(req, res, stream, gateway.host);
    })().catch(() => {
      res.writeHead(502);
      res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    void (async () => {
      validateTarget(req);
      if (
        !nativeClient(req.headers) ||
        req.url?.startsWith("/_relay/") ||
        !boundCredential(req, true)
      ) {
        rejectUpgrade(socket, 403);
        return;
      }
      const { stream, path } = await open(controller.signal);
      if (socket.destroyed) {
        stream.destroy();
        return;
      }
      req.headers["x-omnesis-connection-path"] = path;
      upgrades.set(stream, path);
      stream.once("close", () => upgrades.delete(stream));
      forwardUpgrade(req, socket, head, stream, gateway.host);
    })().catch(() => rejectUpgrade(socket, 502));
  });
  // The adapter is intentionally loopback-only, even if a caller supplies a
  // different listen address. Check at bind time before accepting requests.
  server.on("listening", () => {
    const address = server.address() as AddressInfo;
    if (address.address !== "127.0.0.1" && address.address !== "::1") {
      server.close();
      server.emit("error", new Error("Relay client proxy must bind loopback"));
    }
  });
  server.on("close", () => {
    shutdown.abort();
    unsubscribe?.();
    options.adaptivePath?.close();
    for (const stream of active) stream.destroy();
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        shutdown.abort();
        unsubscribe?.();
        options.adaptivePath?.close();
        for (const stream of active) stream.destroy();
        for (const socket of incoming) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
