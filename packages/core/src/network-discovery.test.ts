// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, expect } from "vitest";
import {
  discoverTailscale,
  realLanIpv4s,
  isVirtualInterface,
  safeNetworkInterfaces,
  networkInterfacesUsable,
  isCertificateIpAddress,
  localMdnsHostname,
  tailscaleIdentitiesFromStatus,
} from "./network-discovery.js";
import type { NetworkInterfaceInfo } from "node:os";

/** Build a minimal IPv4 NetworkInterfaceInfo. */
function ip4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:11:22:33:44:55",
    internal,
    cidr: `${address}/24`,
  };
}

describe("localMdnsHostname", () => {
  test.each([
    ["Studio-Northstar", "studio-northstar.local"],
    ["studio-northstar.example.org", "studio-northstar.local"],
    ["studio-northstar.local", "studio-northstar.local"],
    ["", "omnesis.local"],
    ["localhost", "omnesis.local"],
    ["under_score", "omnesis.local"],
    ["-leading-hyphen", "omnesis.local"],
  ])("normalizes %s", (input, expected) => {
    expect(localMdnsHostname(input)).toBe(expected);
  });
});

test("network discovery falls through a logged-out CLI to the connected macOS app", async () => {
  const home = mkdtempSync(join(tmpdir(), "omnesis-network-tailnet-"));
  try {
    const disconnected = join(home, "bin/tailscale");
    const app = join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale");
    mkdirSync(dirname(disconnected), { recursive: true });
    mkdirSync(dirname(app), { recursive: true });
    writeFileSync(disconnected, '#!/bin/sh\nprintf \'{"BackendState":"NeedsLogin"}\\n\'\n');
    writeFileSync(
      app,
      '#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1\nprintf \'{"BackendState":"Running","Self":{"DNSName":"gw.example.ts.net.","TailscaleIPs":["100.101.102.103"]}}\\n\'\n',
    );
    chmodSync(disconnected, 0o755);
    chmodSync(app, 0o755);
    const identities = await discoverTailscale([
      { file: disconnected, bundledApp: false },
      { file: app, bundledApp: true },
    ]);
    expect(identities.map((identity) => identity.address)).toEqual([
      "gw.example.ts.net",
      "100.101.102.103",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("isCertificateIpAddress", () => {
  test.each([
    ["192.0.2.60", true],
    ["2001:db8::60", true],
    ["::ffff:192.0.2.60", true],
    ["::2", true],
    ["0.0.0.0", false],
    ["127.0.0.2", false],
    ["::", false],
    ["::1", false],
    ["::ffff:127.0.0.2", false],
    ["::ffff:0.0.0.0", false],
    ["fe80::60", false],
    ["fe90::60", false],
    ["febf::60", false],
    ["fec0::60", true],
    ["2001:db8::60%eth0", false],
    ["not-an-address", false],
  ])("classifies %s", (address, expected) => {
    expect(isCertificateIpAddress(address)).toBe(expected);
  });
});

describe("isVirtualInterface", () => {
  test.each([
    ["docker0", true],
    ["br-1a2b3c", true],
    ["veth9f8e", true],
    ["virbr0", true],
    ["vmnet1", true],
    ["tun0", true],
    ["wg0", true],
    ["utun4", true],
    ["tailscale0", true],
    ["zt5u4f", true],
    ["awdl0", true],
    ["enP7s7", false], // modern predictable name — real
    ["eth0", false],
    ["en0", false],
    ["wlp2s0", false],
  ])("%s -> virtual=%s", (name, expected) => {
    expect(isVirtualInterface(name)).toBe(expected);
  });
});

describe("realLanIpv4s", () => {
  test("excludes docker/tailscale/loopback, returns the real LAN IP", () => {
    const ifaces = {
      lo: [ip4("127.0.0.1", true)],
      enP7s7: [ip4("192.168.1.81")], // real home LAN
      docker0: [ip4("172.17.0.1")], // Docker bridge — RFC1918, must be excluded by NAME
      tailscale0: [ip4("100.101.102.103")], // tailnet
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(realLanIpv4s(ifaces)).toEqual(["192.168.1.81"]);
  });

  test("returns every real LAN IP on a multi-homed host, preferred-name first", () => {
    const ifaces = {
      eth0: [ip4("192.168.1.10")], // ranked 0
      enP7s7: [ip4("10.0.5.20")], // unlisted -> rank 99
      docker0: [ip4("172.17.0.1")],
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(realLanIpv4s(ifaces)).toEqual(["192.168.1.10", "10.0.5.20"]);
  });

  test("excludes Tailscale CGNAT even on a non-overlay interface name", () => {
    const ifaces = {
      eth0: [ip4("100.101.102.103")], // a 100.64/10 CGNAT addr (tailnet) on eth0
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(realLanIpv4s(ifaces)).toEqual([]);
  });

  test("returns empty when the host has only virtual/loopback interfaces", () => {
    const ifaces = {
      lo: [ip4("127.0.0.1", true)],
      docker0: [ip4("172.17.0.1")],
      tailscale0: [ip4("100.101.102.103")],
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(realLanIpv4s(ifaces)).toEqual([]);
  });
});

describe("safeNetworkInterfaces", () => {
  test("passes through the provider's result when it succeeds", () => {
    const ifaces = {
      enP7s7: [ip4("192.168.1.81")],
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(safeNetworkInterfaces(() => ifaces)).toBe(ifaces);
  });

  test("returns an empty map instead of throwing when the syscall fails (EAFNOSUPPORT)", () => {
    // Reproduces the host quirk where uv_interface_addresses throws
    // "Unknown system error 97" — the caller must degrade, not 500.
    expect(
      safeNetworkInterfaces(() => {
        throw new Error("uv_interface_addresses returned Unknown system error 97");
      }),
    ).toEqual({});
  });

  test("realLanIpv4s degrades to [] when interface enumeration fails", () => {
    expect(
      realLanIpv4s(
        safeNetworkInterfaces(() => {
          throw new Error("boom");
        }),
      ),
    ).toEqual([]);
  });
});

describe("networkInterfacesUsable", () => {
  test("true when the syscall succeeds", () => {
    expect(
      networkInterfacesUsable(() => ({}) as ReturnType<typeof import("node:os").networkInterfaces>),
    ).toBe(true);
  });

  test("false when the syscall throws (EAFNOSUPPORT) — the mDNS crash guard", () => {
    expect(
      networkInterfacesUsable(() => {
        throw new Error("uv_interface_addresses returned Unknown system error 97");
      }),
    ).toBe(false);
  });
});

describe("tailscaleIdentitiesFromStatus", () => {
  test("surfaces the MagicDNS name (cert-matching) first, then the tailnet IPv4", () => {
    const stdout = JSON.stringify({
      Self: {
        DNSName: "edge.tailnet-example.ts.net.", // trailing dot, as tailscale emits
        TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::aa12:3456"], // IPv4 + IPv6
        HostName: "edge",
      },
      MagicDNSSuffix: "tailnet-example.ts.net",
    });
    const ids = tailscaleIdentitiesFromStatus(stdout);
    // MagicDNS first — the only identity a `tailscale cert` certificate covers,
    // with the trailing dot stripped.
    expect(ids[0]).toEqual({
      address: "edge.tailnet-example.ts.net",
      label: "Tailscale (MagicDNS, off-LAN)",
      kind: "tailscale-magicdns",
      offLan: true,
    });
    // Tailnet IPv4 next; the IPv6 address is dropped (IPv4-only matcher).
    expect(ids[1]).toEqual({
      address: "100.101.102.103",
      label: "Tailscale (100.x, off-LAN)",
      kind: "tailscale",
      offLan: true,
    });
    expect(ids).toHaveLength(2);
  });

  test("returns [] on invalid JSON (e.g. a tailscale CLI upgrade changed output)", () => {
    expect(tailscaleIdentitiesFromStatus("not json at all")).toEqual([]);
  });

  test("returns [] when not logged in (no Self section)", () => {
    expect(tailscaleIdentitiesFromStatus(JSON.stringify({ MagicDNSSuffix: "x" }))).toEqual([]);
  });
});
