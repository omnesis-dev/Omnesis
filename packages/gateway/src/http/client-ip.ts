// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a request came from, for rate limiting, audit lines and the loopback
 * exemptions.
 *
 * By default the answer is the TCP peer. Forwarded headers are attacker
 * controlled on a gateway that is reachable directly, so they are ignored
 * unless `OMNESIS_TRUST_PROXY=true`, which means exactly one reverse proxy
 * sits in front of the gateway and every request passes through it (the
 * gateway bound to loopback with `OMNESIS_BIND`). That proxy appends the
 * address it accepted the connection from to `X-Forwarded-For`, so the
 * trustworthy entry is the last one; the entries before it were supplied by
 * the client and may say anything. `X-Real-IP`, which a proxy sets rather
 * than appends to, is the fallback. The proxy has to set or append that
 * header itself: one that passes a client's `X-Forwarded-For` through
 * untouched, or a gateway bound to every interface with the flag on, lets a
 * direct client choose its own rate-limit bucket. The loopback exemption
 * stays closed either way, since the socket peer must itself be loopback.
 */

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
 * The client address the trusted proxy reports, or undefined when no proxy
 * is trusted or the request carries no forwarded header (a caller that
 * reached the gateway without passing through the proxy).
 */
export function forwardedClientAddress(header: HeaderReader): string | undefined {
  if (!reverseProxyTrusted()) return undefined;
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

/** Best-effort client address: the trusted proxy's word, else the socket peer. */
export function clientAddress(header: HeaderReader, env: unknown): string {
  return forwardedClientAddress(header) ?? socketPeerAddress(env) ?? "unknown";
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
 * when a proxy is trusted, the address it reports must be loopback too, so
 * that a proxy on the gateway host, whose every connection arrives over
 * loopback, does not exempt the whole Internet.
 */
export function isLoopbackClient(header: HeaderReader, env: unknown): boolean {
  const peer = socketPeerAddress(env);
  if (peer === undefined || !isLoopbackIp(peer)) return false;
  const forwarded = forwardedClientAddress(header);
  return forwarded === undefined || isLoopbackIp(forwarded);
}
