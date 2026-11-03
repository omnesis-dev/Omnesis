// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { hostNetworkFromText, hostNetworkIdentities, parseHostNetwork } from "./host-network.js";

describe("parseHostNetwork", () => {
  it("reads the port, the .local name and every IPv4 interface address", () => {
    expect(
      parseHostNetwork(
        [
          "# The network of this host, as the Omnesis launcher last read it.",
          "port 8443",
          "local-name Studio-Northstar.local",
          "interface en0 192.168.1.20",
          "interface eth0@if12 192.168.1.50",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      port: 8443,
      localName: "studio-northstar.local",
      interfaces: [
        { name: "en0", address: "192.168.1.20" },
        { name: "eth0", address: "192.168.1.50" },
      ],
    });
  });

  it("skips malformed lines and keeps the rest", () => {
    expect(
      parseHostNetwork(
        [
          "port 70000",
          "port seven",
          "local-name not-a-local-name.example.com",
          "local-name localhost.local",
          "interface en0 2001:db8::47",
          "interface en0 999.1.1.1",
          "interface en0",
          "interface en0 192.168.1.20 extra",
          "unknown-key value",
          "interface en1 192.168.1.50",
        ].join("\n"),
      ),
    ).toEqual({
      port: null,
      localName: null,
      interfaces: [{ name: "en1", address: "192.168.1.50" }],
    });
  });
});

describe("hostNetworkIdentities", () => {
  it("judges recorded interfaces by the rules native discovery uses", () => {
    const identities = hostNetworkIdentities({
      port: 7600,
      localName: "studio-northstar.local",
      interfaces: [
        { name: "lo0", address: "127.0.0.1" },
        { name: "wlp2s0", address: "192.168.1.50" },
        { name: "en0", address: "192.168.1.20" },
        { name: "en1", address: "169.254.10.2" },
        { name: "docker0", address: "172.17.0.1" },
        { name: "br-1a2b3c", address: "172.20.0.5" },
        { name: "bridge100", address: "198.51.100.1" },
        { name: "utun2", address: "10.1.2.3" },
        { name: "utun4", address: "100.64.0.7" },
        { name: "tailscale0", address: "100.64.0.8" },
        { name: "en5", address: "100.64.0.9" },
      ],
    });
    expect(identities.map((i) => [i.kind, i.address])).toEqual([
      ["lan", "192.168.1.20"],
      ["lan", "192.168.1.50"],
      ["mdns", "studio-northstar.local"],
      ["tailscale", "100.64.0.7"],
      ["tailscale", "100.64.0.8"],
    ]);
  });

  it("gives a host with no recorded name no .local identity", () => {
    expect(
      hostNetworkFromText("port 7600\ninterface eth0 192.168.1.20").identities.map((i) => i.kind),
    ).toEqual(["lan"]);
  });
});
