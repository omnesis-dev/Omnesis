// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { type Duplex } from "node:stream";
import { Socket, type AddressInfo } from "node:net";
import {
  cloudRelayEnabled,
  parseWebSocketAuthProtocolHeader,
  WS_AUTH_PROTOCOL_PREFIX,
} from "@omnesis/core";
import { connectPreferredGateway, type DirectCandidate } from "./direct-path.js";
import { connectOrigin, forwardHttp, forwardUpgrade, relayOrigin } from "./network.js";
import { rejectUpgrade, validateTarget } from "./server.js";
import type { AdaptiveGatewayPath } from "./adaptive-path.js";

/**
 * How long the adapter holds bytes the route will not take before it gives the connection up.
 *
 * It is deliberately not a plain idle timeout. A healthy request can be silent in both directions
 * for hours (a transcription waits on the gateway with nothing to say), and a quiet event stream
 * is healthy too; TCP keepalive already finds a dead peer on those. What keepalive cannot see is
 * the upload whose route died mid-body: unacknowledged data suppresses its probes and the
 * operating system retries for many minutes. That case alone leaves unsent bytes queued here, so
 * that is what the timer requires. An upload that still moves bytes, however slowly, restarts it
 * with every chunk the route accepts. The apps use the same two minutes.
 */
export const UPSTREAM_STALL_MS = 120_000;

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
  dependencies: { connect?: typeof connectOrigin; stallMs?: number } = {},
): { server: Server; close(): Promise<void> } {
  if (!cloudRelayEnabled()) throw new Error("Cloud relay requires OMNESIS_CLOUD_RELAY_ENABLED=1");
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
  const incoming = new Set<Duplex>();
  const shutdown = new AbortController();
  const adaptive = options.adaptivePath;
  // Every upstream connection with the route it took, so a route that is declared gone takes its
  // connections with it instead of leaving each to discover that on its own.
  const routed = new Map<Duplex, { path: "local" | "relay"; upgrade: boolean }>();
  const unsubscribe = adaptive?.onTransition((event) => {
    for (const [stream, use] of routed) {
      if (
        event === "lost"
          ? // Requests in flight on the home network cannot finish there any more.
            use.path === "local"
          : // A relay request in flight is left to finish; only long-lived sockets move home.
            use.upgrade && (event === "blocked" || use.path === "relay")
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
    upgrade: boolean,
  ): Promise<{ stream: Duplex; path: "local" | "relay" }> => {
    adaptive?.assertUsable();
    // An adapter that tracks the route asks the home addresses only while it is at home: away,
    // each of them would cost every connection a timeout before the relay is even tried.
    const home = adaptive?.isLocal() ?? true;
    let path: "local" | "relay" = "relay";
    const connect: typeof connectOrigin = async (...args) => {
      const stream = await (dependencies.connect ?? connectOrigin)(...args);
      path = args[6] === undefined ? "relay" : "local";
      return stream;
    };
    let stream: Duplex;
    try {
      stream = await connectPreferredGateway(
        {
          origin: gateway,
          certificate: options.gatewayCa,
          fingerprint: options.gatewayFingerprint,
          tlsSpkiFingerprint: options.tlsSpkiFingerprint,
          candidates: home ? (adaptive?.candidates() ?? options.directCandidates ?? []) : [],
          signal: AbortSignal.any([shutdown.signal, signal]),
          connectHost: options.gatewayConnectHost,
          onRefusedHint: (candidate) => adaptive?.reportRefusedHint(candidate),
        },
        connect,
      );
    } catch (error) {
      // Away with no relay can also be home without internet: look now, not at the next interval.
      if (!home) void adaptive?.check();
      throw error;
    }
    // At home but the home addresses did not answer: the route may just have gone.
    if (home && path === "relay") void adaptive?.check();
    routed.set(stream, { path, upgrade });
    stream.once("close", () => {
      routed.delete(stream);
    });
    if (stream instanceof Socket)
      stream.setTimeout(dependencies.stallMs ?? UPSTREAM_STALL_MS, () => {
        if (stream.writableLength > 0) stream.destroy();
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
      const { stream, path } = await open(controller.signal, false);
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
      const { stream, path } = await open(controller.signal, true);
      if (socket.destroyed) {
        stream.destroy();
        return;
      }
      req.headers["x-omnesis-connection-path"] = path;
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
    adaptive?.close();
    for (const stream of routed.keys()) stream.destroy();
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        shutdown.abort();
        unsubscribe?.();
        adaptive?.close();
        for (const stream of routed.keys()) stream.destroy();
        for (const socket of incoming) socket.destroy();
        // Closing an adapter that never listened, or closing it twice, has nothing left to do.
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        );
      }),
  };
}
