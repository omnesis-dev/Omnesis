// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  arrivedThroughRelay,
  arrivedThroughRelayTunnel,
  clientAddress,
  forwardedClientAddress,
  fromHomeNetwork,
  isHomeNetworkIp,
  isLoopbackClient,
  isRelayedRequest,
  markRelayRequestExposure,
  relayedClientBucket,
} from "./client-ip.js";

// The gateway only reads what its own tunnel client recorded; the table itself is tested there.
const relayed = vi.hoisted(() => new Map<string, string>());
const tunnelSockets = vi.hoisted(() => new Set<string>());
vi.mock("@omnesis/cloud-relay", () => ({
  relayedClientAddress: (peer: { remoteAddress?: string; remotePort?: number }) =>
    relayed.get(`${peer.remoteAddress}|${peer.remotePort}`),
  isRelayTunnelPeer: (peer: { remoteAddress?: string; remotePort?: number }) =>
    tunnelSockets.has(`${peer.remoteAddress}|${peer.remotePort}`),
}));

function headers(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name.toLowerCase()];
}

function peer(address: string | undefined): unknown {
  return { incoming: { socket: { remoteAddress: address } } };
}

/** A proxy on another machine, believed only under OMNESIS_TRUST_PROXY. */
const PROXY = peer("198.51.100.20");

const previous = process.env.OMNESIS_TRUST_PROXY;
afterEach(() => {
  if (previous === undefined) delete process.env.OMNESIS_TRUST_PROXY;
  else process.env.OMNESIS_TRUST_PROXY = previous;
});

describe("without OMNESIS_TRUST_PROXY", () => {
  test("a direct client's forwarded headers are ignored and its socket peer is the client", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    const h = headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.11" });
    expect(forwardedClientAddress(h, peer("198.51.100.7"))).toBeUndefined();
    expect(clientAddress(h, peer("198.51.100.7"))).toBe("198.51.100.7");
    expect(forwardedClientAddress(h, peer(undefined))).toBeUndefined();
    expect(clientAddress(h, peer(undefined))).toBe("unknown");
  });

  test("a proxy on this computer is believed: its Internet clients are not loopback", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    const funnel = headers({ "x-forwarded-for": "203.0.113.10" });
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(forwardedClientAddress(funnel, peer(address))).toBe("203.0.113.10");
      expect(clientAddress(funnel, peer(address))).toBe("203.0.113.10");
      expect(isLoopbackClient(funnel, peer(address))).toBe(false);
    }
    // Only the last entry, the one the proxy wrote, counts.
    const spoofed = headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.10" });
    expect(isLoopbackClient(spoofed, peer("127.0.0.1"))).toBe(false);
    expect(clientAddress(spoofed, peer("127.0.0.1"))).toBe("203.0.113.10");
  });

  test("a same-machine caller without forwarded headers stays loopback", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    expect(isLoopbackClient(headers({}), peer("127.0.0.1"))).toBe(true);
    expect(clientAddress(headers({}), peer("127.0.0.1"))).toBe("127.0.0.1");
    expect(isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("127.0.0.1"))).toBe(
      true,
    );
  });

  test("a direct client can never claim loopback through a header", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("203.0.113.10")),
    ).toBe(false);
    expect(isLoopbackClient(headers({ "x-real-ip": "127.0.0.1" }), peer("198.51.100.20"))).toBe(
      false,
    );
  });
});

describe("with OMNESIS_TRUST_PROXY=true", () => {
  test("the flag reads 1, true, yes and on, and believes a proxy on another machine; anything else does not", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.10" });
    const remoteProxy = peer("198.51.100.20");
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      process.env.OMNESIS_TRUST_PROXY = value;
      expect(forwardedClientAddress(h, remoteProxy)).toBe("203.0.113.10");
    }
    for (const value of ["0", "false", "", "proxy"]) {
      process.env.OMNESIS_TRUST_PROXY = value;
      expect(forwardedClientAddress(h, remoteProxy)).toBeUndefined();
    }
  });

  test("the last X-Forwarded-For entry is the client: the proxy appended it", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    const h = headers({ "x-forwarded-for": "127.0.0.1, 198.51.100.9 , 203.0.113.10" });
    expect(forwardedClientAddress(h, PROXY)).toBe("203.0.113.10");
    expect(clientAddress(h, peer("127.0.0.1"))).toBe("203.0.113.10");
  });

  test("a trailing entry keeps its whitespace off, IPv6 included, and X-Forwarded-For wins over X-Real-IP", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(
      forwardedClientAddress(headers({ "x-forwarded-for": "203.0.113.10, 2001:db8::7 " }), PROXY),
    ).toBe("2001:db8::7");
    expect(
      forwardedClientAddress(
        headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.12" }),
        PROXY,
      ),
    ).toBe("203.0.113.10");
  });

  test("the socket peer is read from the request itself when the runtime exposes it there", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    expect(clientAddress(headers({}), { incoming: { remoteAddress: "198.51.100.7" } })).toBe(
      "198.51.100.7",
    );
  });

  test("X-Real-IP stands in when X-Forwarded-For is absent or empty", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(forwardedClientAddress(headers({ "x-real-ip": "203.0.113.12" }), PROXY)).toBe(
      "203.0.113.12",
    );
    expect(
      forwardedClientAddress(
        headers({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.12" }),
        PROXY,
      ),
    ).toBe("203.0.113.12");
    expect(forwardedClientAddress(headers({ "x-real-ip": "  " }), PROXY)).toBeUndefined();
  });

  test("a request without forwarded headers came straight from its socket peer", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(clientAddress(headers({}), peer("127.0.0.1"))).toBe("127.0.0.1");
    expect(isLoopbackClient(headers({}), peer("127.0.0.1"))).toBe(true);
  });

  test("a remote client behind a loopback proxy is not a loopback client", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "203.0.113.10" }), peer("127.0.0.1")),
    ).toBe(false);
    expect(isLoopbackClient(headers({ "x-real-ip": "203.0.113.10" }), peer("::1"))).toBe(false);
  });

  test("a client cannot claim loopback with its own X-Forwarded-For entry", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    const spoofed = headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.10" });
    expect(isLoopbackClient(spoofed, peer("127.0.0.1"))).toBe(false);
    expect(clientAddress(spoofed, peer("127.0.0.1"))).toBe("203.0.113.10");
  });

  test("a same-host client through the proxy stays loopback", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("127.0.0.1"))).toBe(
      true,
    );
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("203.0.113.10")),
    ).toBe(false);
  });
});

describe("on a gateway that never connected to the relay", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("a local caller keeps its loopback exemption and a local proxy is believed as before", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    vi.stubEnv("OMNESIS_CLOUD_RELAY_URL", undefined);
    for (const address of ["127.0.0.1", "::1"]) {
      expect(isLoopbackClient(headers({}), peer(address))).toBe(true);
      expect(clientAddress(headers({}), peer(address))).toBe(address);
      expect(isRelayedRequest(headers({}), peer(address))).toBe(false);
      expect(arrivedThroughRelay(headers({}), peer(address))).toBe(false);
    }
    const proxied = headers({ "x-forwarded-for": "203.0.113.10" });
    expect(clientAddress(proxied, peer("127.0.0.1"))).toBe("203.0.113.10");
    expect(isLoopbackClient(proxied, peer("127.0.0.1"))).toBe(false);
  });

  test("a client claiming the relay's header only ever gives something up", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    vi.stubEnv("OMNESIS_CLOUD_RELAY_URL", undefined);
    const claimed = headers({ "x-omnesis-cloud-relay": "1" });
    for (const from of [peer("127.0.0.1"), peer("198.51.100.20")]) {
      // Treated as remote, and withheld from as if relayed...
      expect(isLoopbackClient(claimed, from)).toBe(false);
      expect(isRelayedRequest(claimed, from)).toBe(true);
      expect(arrivedThroughRelay(claimed, from)).toBe(true);
      // ...but never taken for the tunnel, nor bucketed as a relayed client.
      expect(arrivedThroughRelayTunnel(from)).toBe(false);
      expect(relayedClientBucket(from)).toBeUndefined();
    }
    expect(clientAddress(claimed, peer("198.51.100.20"))).toBe("198.51.100.20");
  });
});

test("a gateway configured for a relay by its environment treats no loopback caller as local", () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_URL", "https://relay.example.test");
  try {
    expect(isLoopbackClient(headers({}), peer("127.0.0.1"))).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("trusted per-request relay exposure removes exemptions without affecting another app or accepting a header assertion", () => {
  const priorRelay = process.env.OMNESIS_CLOUD_RELAY_URL;
  try {
    delete process.env.OMNESIS_CLOUD_RELAY_URL;
    const direct = peer("127.0.0.1") as object,
      relayed = peer("127.0.0.1") as object;
    const release = markRelayRequestExposure(relayed);
    const releaseConcurrent = markRelayRequestExposure(relayed);
    expect(isLoopbackClient(headers({}), direct)).toBe(true);
    expect(isLoopbackClient(headers({}), relayed)).toBe(false);
    expect(isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), relayed)).toBe(false);
    expect(isRelayedRequest(headers({}), relayed)).toBe(true);
    expect(isRelayedRequest(headers({}), direct)).toBe(false);
    release();
    release();
    expect(isLoopbackClient(headers({}), relayed)).toBe(false);
    releaseConcurrent();
    expect(isLoopbackClient(headers({}), relayed)).toBe(true);
  } finally {
    if (priorRelay === undefined) delete process.env.OMNESIS_CLOUD_RELAY_URL;
    else process.env.OMNESIS_CLOUD_RELAY_URL = priorRelay;
  }
});

describe("a request through this gateway's relay tunnel", () => {
  const tunnelled = (remoteAddress: string, remotePort: number) => ({
    incoming: { socket: { remoteAddress, remotePort } },
  });
  afterEach(() => relayed.clear());

  test("is bucketed by the address the relay reported, apart from every real peer address", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    relayed.set("127.0.0.1|40100", "198.51.100.30");
    relayed.set("127.0.0.1|40101", "198.51.100.31");
    expect(clientAddress(headers({}), tunnelled("127.0.0.1", 40100))).toBe("relay:198.51.100.30");
    expect(clientAddress(headers({}), tunnelled("127.0.0.1", 40101))).toBe("relay:198.51.100.31");
    // Any other loopback socket is just a local peer.
    expect(clientAddress(headers({}), tunnelled("127.0.0.1", 40102))).toBe("127.0.0.1");
  });

  test("ignores the relayed client's own forwarded headers, even behind a trusted proxy", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    relayed.set("127.0.0.1|40100", "198.51.100.30");
    const spoofed = headers({ "x-forwarded-for": "203.0.113.99" });
    expect(clientAddress(spoofed, tunnelled("127.0.0.1", 40100))).toBe("relay:198.51.100.30");
  });

  test("a tunnel socket's forwarded headers are the remote client's own, never believed", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    tunnelSockets.add("127.0.0.1|40103");
    try {
      const spoofed = headers({ "x-forwarded-for": "203.0.113.99" });
      expect(forwardedClientAddress(spoofed, tunnelled("127.0.0.1", 40103))).toBeUndefined();
      expect(clientAddress(spoofed, tunnelled("127.0.0.1", 40103))).toBe("127.0.0.1");
    } finally {
      tunnelSockets.delete("127.0.0.1|40103");
    }
  });

  test("is looked up only for a loopback peer with a port, and grants no loopback exemption", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    relayed.set("203.0.113.5|40100", "198.51.100.30");
    expect(relayedClientBucket(tunnelled("203.0.113.5", 40100))).toBeUndefined();
    expect(relayedClientBucket(peer("127.0.0.1"))).toBeUndefined();
    expect(relayedClientBucket(undefined)).toBeUndefined();
    relayed.set("127.0.0.1|40100", "198.51.100.30");
    expect(
      isLoopbackClient(headers({ "x-omnesis-cloud-relay": "1" }), tunnelled("127.0.0.1", 40100)),
    ).toBe(false);
    expect(isRelayedRequest(headers({}), tunnelled("127.0.0.1", 40100))).toBe(true);
  });
});

describe("whether a request came through the relay", () => {
  const socket = (remoteAddress: string, remotePort: number) => ({
    incoming: { socket: { remoteAddress, remotePort } },
  });
  afterEach(() => {
    tunnelSockets.clear();
    vi.unstubAllEnvs();
  });

  test("a socket the tunnel dialled is the relay's whatever its headers say, and a local one is not", () => {
    tunnelSockets.add("127.0.0.1|40200");
    // The relay left out its forwarding header and named no client: still relayed.
    expect(arrivedThroughRelay(headers({}), socket("127.0.0.1", 40200))).toBe(true);
    // The CLI on the gateway host, and a home-network client, while remote access is on.
    expect(arrivedThroughRelay(headers({}), socket("127.0.0.1", 40201))).toBe(false);
    expect(arrivedThroughRelay(headers({}), socket("198.51.100.20", 40200))).toBe(false);
    expect(arrivedThroughRelay(headers({}), undefined)).toBe(false);
    expect(arrivedThroughRelay(headers({}), {})).toBe(false);
    // The relay's own forwarding marker counts; a client can only claim to be relayed.
    expect(
      arrivedThroughRelay(headers({ "x-omnesis-cloud-relay": "1" }), socket("198.51.100.20", 1)),
    ).toBe(true);
    // Exposure alone doesn't make a local request relayed.
    const local = socket("127.0.0.1", 40202) as object;
    const release = markRelayRequestExposure(local);
    expect(arrivedThroughRelay(headers({}), local)).toBe(false);
    release();
  });

  test("only the tunnel's own socket counts as the tunnel, never a header", () => {
    tunnelSockets.add("127.0.0.1|40200");
    expect(arrivedThroughRelayTunnel(socket("127.0.0.1", 40200))).toBe(true);
    expect(arrivedThroughRelayTunnel(socket("127.0.0.1", 40201))).toBe(false);
    expect(arrivedThroughRelayTunnel(undefined)).toBe(false);
    expect(arrivedThroughRelayTunnel({})).toBe(false);
    expect(arrivedThroughRelay(headers({ "x-omnesis-cloud-relay": "1" }), undefined)).toBe(true);
    expect(arrivedThroughRelayTunnel(socket("198.51.100.20", 40200))).toBe(false);
  });
});

describe("the home network", () => {
  test("loopback, private and link-local addresses are on it; Tailscale and public ones are not", () => {
    for (const ip of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.17.0.1",
      "192.168.0.20",
      "::ffff:192.168.0.20",
      "169.254.10.1",
      "fd12:3456::1",
      "fe80::1%eth0",
    ])
      expect(isHomeNetworkIp(ip), ip).toBe(true);
    for (const ip of [
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
      "203.0.113.7",
      "2001:db8::1",
      "172.32.0.1",
    ])
      expect(isHomeNetworkIp(ip), ip).toBe(false);
  });

  test("a request is from it when its peer is, and so is any client a trusted proxy reports", () => {
    expect(fromHomeNetwork(headers({}), peer("192.168.0.31"))).toBe(true);
    expect(fromHomeNetwork(headers({}), peer("203.0.113.7"))).toBe(false);
    // A proxy on this machine forwarding from the Internet is not the home network.
    expect(fromHomeNetwork(headers({ "x-forwarded-for": "203.0.113.7" }), peer("127.0.0.1"))).toBe(
      false,
    );
    expect(fromHomeNetwork(headers({ "x-forwarded-for": "192.168.0.31" }), peer("127.0.0.1"))).toBe(
      true,
    );
    // An untrusted peer's forwarded header is not read at all.
    expect(
      fromHomeNetwork(headers({ "x-forwarded-for": "192.168.0.31" }), peer("203.0.113.7")),
    ).toBe(false);
    expect(fromHomeNetwork(headers({}), peer(undefined))).toBe(false);
  });
});
