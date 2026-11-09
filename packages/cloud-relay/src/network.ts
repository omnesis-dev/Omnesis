// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect as connectTcp, isIP } from "node:net";
import { connect as connectTls, checkServerIdentity } from "node:tls";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Agent, request, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline, type Duplex } from "node:stream";
import { GatewayTlsIdentityRefused, verifyPinnedGatewayKey } from "./pinned-key.js";

export const SESSION_HEADER = "x-omnesis-relay-session";

export function relayOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Relay URL must be an origin without credentials, path, query or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Relay requires HTTPS except on loopback");
  }
  return url;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function websocketUrl(origin: URL, path: string): string {
  const url = new URL(path, origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * How long an upstream connection may be idle before the operating system starts asking the peer
 * whether it is still there. Without it a connection whose network vanished (a laptop that left,
 * a relay that lost power) looks healthy for as long as nothing is sent on it.
 */
export const UPSTREAM_KEEPALIVE_MS = 15_000;

/** Fixed destinations only: the relay can never ask a gateway to dial another host. */
export async function connectOrigin(
  origin: URL,
  ca?: string,
  signal?: AbortSignal,
  opaqueTls = false,
  fingerprint?: string,
  connectHost?: string,
  connectPort?: number,
  spkiFingerprint?: string,
): Promise<Duplex> {
  if (
    connectPort !== undefined &&
    (!Number.isInteger(connectPort) || connectPort < 1 || connectPort > 65535)
  )
    throw new Error("Gateway connection port is invalid");
  if (spkiFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(spkiFingerprint))
    throw new Error("Invalid gateway public key pin");
  if (spkiFingerprint !== undefined && (origin.protocol !== "https:" || opaqueTls))
    throw new Error("Public key pin requires gateway TLS");
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  if (connectHost !== undefined && isIP(connectHost) === 0)
    throw new Error("Gateway connection override must be an IP address");
  const options = {
    host: connectHost ?? hostname,
    port: connectPort ?? (Number(origin.port) || (origin.protocol === "https:" ? 443 : 80)),
  };
  const socket =
    origin.protocol === "https:" && !opaqueTls
      ? connectTls({
          ...options,
          servername: isIP(hostname) === 0 ? hostname : undefined,
          ca,
          rejectUnauthorized: spkiFingerprint === undefined,
          allowPartialTrustChain: Boolean(ca && fingerprint),
          checkServerIdentity: (host, certificate) => {
            const error = checkServerIdentity(host, certificate);
            if (error)
              return new GatewayTlsIdentityRefused("Gateway certificate hostname mismatch");
            if (
              fingerprint !== undefined &&
              createHash("sha256").update(certificate.raw).digest("hex") !== fingerprint
            )
              return new GatewayTlsIdentityRefused("Gateway certificate pin mismatch");
            return undefined;
          },
        })
      : connectTcp(options);
  const abort = (): void => {
    socket.destroy(
      Object.assign(new Error("Destination connection aborted"), { code: "ABORT_ERR" }),
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", abort));
  if (signal?.aborted) abort();
  socket.setKeepAlive(true, UPSTREAM_KEEPALIVE_MS);
  const slow = (): void => {
    socket.destroy(
      Object.assign(new Error("Destination connection timed out"), { code: "ETIMEDOUT" }),
    );
  };
  socket.setTimeout(15_000, slow);
  try {
    await once(socket, origin.protocol === "https:" && !opaqueTls ? "secureConnect" : "connect");
    if (spkiFingerprint !== undefined) {
      verifyPinnedGatewayKey(
        hostname,
        (socket as import("node:tls").TLSSocket).getPeerCertificate(),
        spkiFingerprint,
      );
    }
    // The handshake deadline must not outlive the handshake: a caller's own idle timer on this
    // socket would otherwise fire it too.
    socket.setTimeout(0);
    socket.off("timeout", slow);
    return socket;
  } catch (error) {
    socket.destroy();
    // An accepted self-signed SPKI session can have authorizationError too.
    // Only the corresponding TLS verification error, never a reset or abort, is an identity refusal.
    const authorization = (socket as import("node:tls").TLSSocket).authorizationError as unknown;
    if (
      origin.protocol === "https:" &&
      !opaqueTls &&
      !signal?.aborted &&
      typeof authorization === "string" &&
      error instanceof Error &&
      "code" in error &&
      error.code === authorization
    ) {
      // Keep rejected-peer details out of recursively logged error causes.
      throw new GatewayTlsIdentityRefused(
        "Gateway certificate trust verification failed",
        error.code,
      );
    }
    throw error;
  }
}

/** Stream HTTP bodies without buffering; the underlying duplex may be a native tunnel. */
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  stream: Duplex,
  host: string,
): void {
  const headers = forwardedHeaders(req, host);
  delete headers.connection;
  delete headers.upgrade;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => stream;
  const upstream = request({ method: req.method, path: req.url, headers, agent });
  const stop = (): void => {
    upstream.destroy();
    stream.destroy();
    agent.destroy();
  };
  res.on("close", stop);
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
    stop();
  });
  upstream.on("response", (reply) => {
    const replyHeaders = { ...reply.headers };
    delete replyHeaders[SESSION_HEADER];
    res.writeHead(reply.statusCode!, replyHeaders);
    pipeline(reply, res, () => {
      stop();
    });
  });
  pipeline(req, upstream, (error) => {
    if (error) stop();
  });
}

/** Preserve the gateway's WebSocket handshake, including its device auth subprotocol. */
export function forwardUpgrade(
  req: Pick<IncomingMessage, "method" | "url" | "headers">,
  socket: Duplex,
  head: Buffer,
  stream: Duplex,
  host: string,
): void {
  const headers = forwardedHeaders(req, host);
  stream.write(
    `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
      .flatMap(([key, values]) =>
        (Array.isArray(values) ? values : [String(values)]).map((value) => `${key}: ${value}\r\n`),
      )
      .join("")}\r\n`,
  );
  if (head.length) stream.write(head);
  // Each pipe preserves backpressure. A shared close handler avoids attaching
  // two pipeline completion stacks to the same TLS socket.
  const stop = (): void => {
    socket.destroy();
    stream.destroy();
  };
  socket.once("error", stop);
  stream.once("error", stop);
  socket.once("close", stop);
  stream.once("close", stop);
  socket.pipe(stream);
  stream.pipe(socket);
}

export function forwardedHeaders(
  req: Pick<IncomingMessage, "headers">,
  host: string,
): IncomingMessage["headers"] {
  const headers: IncomingMessage["headers"] = { ...req.headers, host };
  delete headers[SESSION_HEADER];
  delete headers["x-omnesis-relay-ticket"];
  delete headers["x-omnesis-gateway-id"];
  delete headers["x-real-ip"];
  headers["x-omnesis-cloud-relay"] = "1";
  delete headers["forwarded"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  return headers;
}

/** How far a gateway's clock and its relay's may disagree before a fresh challenge is refused. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Whether a challenge the relay just issued for a minute is one to sign. The two machines never
 * read the same instant, so an exact bound refuses every relay whose clock is a moment ahead.
 */
export function challengeIsFresh(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt > now - CLOCK_SKEW_MS && expiresAt <= now + 60_000 + CLOCK_SKEW_MS;
}
