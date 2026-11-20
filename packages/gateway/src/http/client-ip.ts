// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a request came from, for rate limiting, audit lines and the loopback
 * exemptions.
 *
 * By default the answer is the TCP peer. A proxy reports the client it
 * forwards for in `X-Forwarded-For`, appending (or, like Tailscale Serve and
 * Funnel, setting) the address it accepted the connection from, so the
 * trustworthy entry is the last one; the entries before it were supplied by
 * the client and may say anything. `X-Real-IP`, which a proxy sets rather
 * than appends to, is the fallback.
 *
 * Those headers are believed on a connection from this computer itself: a
 * proxy on the gateway's machine (Tailscale Serve or Funnel, Caddy, nginx, a
 * tunnel client) reaches it over loopback, and a client that connects
 * directly from anywhere else never does, so it cannot choose its own
 * address. A program on the gateway's machine that names another address
 * only gives up the loopback exemption. A proxy on another machine reaches
 * the gateway from that machine's address, which the gateway cannot tell
 * apart from a direct client; `OMNESIS_TRUST_PROXY=true` declares that
 * exactly one proxy sits in front and every request passes through it (the
 * gateway bound to loopback with `OMNESIS_BIND`, or reachable only from the
 * proxy), and the headers are then believed from any peer. A proxy that
 * passes a client's `X-Forwarded-For` through untouched lets that client
 * choose its rate-limit bucket either way.
 *
 * Requests through this gateway's own cloud relay tunnel are counted by the
 * address the relay reported for them instead (`relayedClientBucket`), and
 * requests through its own tailnet device by the address Tailscale reported
 * (`tailnetClientBucket`).
 */

import { isRelayTunnelPeer, relayedClientAddress } from "@omnesis/cloud-relay";
import { tailnetCallerAddress, tailnetCallerOfEnv } from "../tailscale-embed/caller.js";

const exposedRequests = new WeakMap<object, number>();

/** Trusted request bindings only. An opaque relay cannot inject an HTTP policy marker. */
export function markRelayRequestExposure(env: object): () => void {
  exposedRequests.set(env, (exposedRequests.get(env) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = exposedRequests.get(env)! - 1;
    if (remaining === 0) exposedRequests.delete(env);
    else exposedRequests.set(env, remaining);
  };
}

type HeaderReader = (name: string) => string | undefined;

interface RawPeer {
  remoteAddress?: string;
  socket?: { remoteAddress?: string };
}

/** Address the request's own socket was accepted from, when the runtime exposes it. */
export function socketPeerAddress(env: unknown): string | undefined {
  const raw = (env as { incoming?: RawPeer } | undefined)?.incoming;
  return raw?.remoteAddress ?? raw?.socket?.remoteAddress;
}

const ON_SENTINELS = new Set(["1", "true", "yes", "on"]);

/** Whether `OMNESIS_TRUST_PROXY` declares one reverse proxy in front of the gateway. */
export function reverseProxyTrusted(): boolean {
  const raw = process.env.OMNESIS_TRUST_PROXY?.trim().toLowerCase();
  return raw !== undefined && ON_SENTINELS.has(raw);
}

/**
 * Whether the request's forwarded headers come from a proxy the gateway
 * trusts: one on this computer, connecting over loopback, or any peer under
 * `OMNESIS_TRUST_PROXY`. The relay tunnel's sockets are loopback too, but the
 * headers on them are the remote client's own.
 */
function forwardedHeadersTrusted(env: unknown): boolean {
  if (reverseProxyTrusted()) return true;
  const socket = (
    env as { incoming?: { socket?: { remoteAddress?: string; remotePort?: number } } }
  )?.incoming?.socket;
  if (socket && isRelayTunnelPeer(socket)) return false;
  const peer = socketPeerAddress(env);
  return peer !== undefined && isLoopbackIp(peer);
}

/**
 * The client address a trusted proxy reports, or undefined when the
 * request's peer is not a trusted proxy or the request carries no forwarded
 * header (a caller that reached the gateway without passing through one).
 */
export function forwardedClientAddress(header: HeaderReader, env: unknown): string | undefined {
  if (!forwardedHeadersTrusted(env)) return undefined;
  const forwardedFor = header("x-forwarded-for");
  if (forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const last = entries[entries.length - 1];
    if (last) return last;
  }
  const realIp = header("x-real-ip")?.trim();
  return realIp ? realIp : undefined;
}

/**
 * The address the cloud relay reported for a request that arrived through
 * this gateway's own relay tunnel, as `relay:<address>`. Every relayed
 * request reaches the gateway from the tunnel's loopback socket; only the
 * tunnel client in this process can record which client is behind which of
 * those sockets. The prefix keeps it apart from any real peer address.
 */
export function relayedClientBucket(env: unknown): string | undefined {
  const raw = (env as { incoming?: { socket?: { remoteAddress?: string; remotePort?: number } } })
    ?.incoming?.socket;
  if (!raw?.remoteAddress || !isLoopbackIp(raw.remoteAddress)) return undefined;
  const relayed = relayedClientAddress(raw);
  return relayed === undefined ? undefined : `relay:${relayed}`;
}

/**
 * The address Tailscale reported for a request that came through this
 * gateway's own tailnet device: `tailnet:<address>` for a device on the
 * tailnet, `tailscale-public:<address>` for a request through the public
 * address. Only the gateway's private socket listener records these, so no
 * header can produce one.
 */
export function tailnetClientBucket(env: unknown): string | undefined {
  const caller = tailnetCallerOfEnv(env);
  if (!caller) return undefined;
  const prefix = caller.via === "public" ? "tailscale-public" : "tailnet";
  return `${prefix}:${tailnetCallerAddress(caller)}`;
}

/**
 * Best-effort client address for rate limits and audit lines, never for
 * authorization: the tailnet device's word for a request it forwarded, the
 * relay's word for a relayed request (a relayed client's own forwarded
 * headers are never trusted), else the trusted proxy's word, else the socket
 * peer.
 */
export function clientAddress(header: HeaderReader, env: unknown): string {
  return (
    tailnetClientBucket(env) ??
    relayedClientBucket(env) ??
    forwardedClientAddress(header, env) ??
    socketPeerAddress(env) ??
    "unknown"
  );
}

/**
 * Whether a request may have reached the gateway through its cloud relay,
 * and so from the open internet: the tunnel recorded its client, the relay
 * marked it, or the gateway was exposing itself when it arrived. Use it only
 * to withhold something; a client can claim to be relayed but never claim
 * not to be.
 */
export function isRelayedRequest(header: HeaderReader, env: unknown): boolean {
  return (
    (typeof env === "object" && env !== null && exposedRequests.has(env)) ||
    relayedClientBucket(env) !== undefined ||
    header("x-omnesis-cloud-relay") === "1"
  );
}

/**
 * Whether a client address is on this machine or a private network: loopback,
 * RFC 1918 and link-local IPv4 (also IPv4-mapped), and IPv6 unique-local or
 * link-local — never a Tailscale address, which is the tailnet's.
 */
export function isHomeNetworkIp(ip: string): boolean {
  if (isLoopbackIp(ip)) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(v4);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ip.toLowerCase().split("%", 1)[0]!;
  if (v6.startsWith("fd7a:115c:a1e0:")) return false;
  return /^f[cd][0-9a-f]{0,2}:/u.test(v6) || /^fe[89ab][0-9a-f]?:/u.test(v6);
}

/**
 * Whether a request's socket peer, and any client a trusted proxy in front
 * reports, are on this machine or a private network.
 */
export function fromHomeNetwork(header: HeaderReader, env: unknown): boolean {
  const peer = socketPeerAddress(env);
  if (peer === undefined || !isHomeNetworkIp(peer)) return false;
  const forwarded = forwardedClientAddress(header, env);
  return forwarded === undefined || isHomeNetworkIp(forwarded);
}

/**
 * Whether an address is loopback: IPv4 `127.0.0.0/8`, IPv6 `::1`, and the
 * IPv4-mapped `::ffff:127.x` forms.
 */
export function isLoopbackIp(ip: string): boolean {
  if (ip === "::1" || ip === "localhost") return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  return v4.startsWith("127.");
}

/**
 * Whether the request originated on the gateway host itself. A loopback
 * caller already has the token file, the config and the databases, so a
 * per-address rate limit buys nothing against it; the limiters exempt it so
 * same-host tooling is not throttled by limits sized for a WAN-exposed
 * gateway.
 *
 * The socket peer must be loopback: a remote caller cannot claim `127.0.0.1`
 * through a header, since headers are read only from a trusted proxy. And
 * the address a proxy reports must be loopback too, so that a proxy on the
 * gateway host, whose every connection arrives over loopback, does not
 * exempt the whole Internet.
 */
export function isLoopbackClient(header: HeaderReader, env: unknown): boolean {
  // Relay traffic arrives on a local tunnel socket but remains remote traffic.
  // This marker can only remove an exemption; it never grants access.
  if (
    exposedRequests.has(env as object) ||
    process.env.OMNESIS_CLOUD_RELAY_URL ||
    header("x-omnesis-cloud-relay") === "1"
  )
    return false;
  const peer = socketPeerAddress(env);
  if (peer === undefined || !isLoopbackIp(peer)) return false;
  const forwarded = forwardedClientAddress(header, env);
  return forwarded === undefined || isLoopbackIp(forwarded);
}

/**
 * Whether this request came through the gateway's cloud relay: its socket is
 * one the relay tunnel in this process dialled, or it carries the relay's
 * forwarding header. Unlike `isRelayedRequest`, which also counts every
 * request while the gateway is exposed, this is false for a local or
 * home-network request while remote access is on, so it can gate what only
 * the owner on the gateway itself may do. A relay can't make its requests
 * look local: the tunnel's sockets are recorded here, not by the relay.
 * Any client can send the header, so use it only to withhold something;
 * `arrivedThroughRelayTunnel` is the answer a client cannot claim.
 */
export function arrivedThroughRelay(header: HeaderReader, env: unknown): boolean {
  return arrivedThroughRelayTunnel(env) || header("x-omnesis-cloud-relay") === "1";
}

/**
 * Whether this request's socket is one the relay tunnel in this process
 * dialled. Every request through the relay arrives this way, and no header
 * can make another request look like one, so unlike `arrivedThroughRelay` it
 * may exempt a request from a check that applies to every other way in.
 */
export function arrivedThroughRelayTunnel(env: unknown): boolean {
  const socket = (
    env as { incoming?: { socket?: { remoteAddress?: string; remotePort?: number } } }
  )?.incoming?.socket;
  return socket !== undefined && isRelayTunnelPeer(socket);
}
