// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { gatewayDirectCandidates } from "./DirectCandidates.js";
import type { safeNetworkInterfaces } from "@omnesis/core";
const item = (address: string, family = "IPv4", internal = false) => ({
  address,
  family,
  internal,
  netmask: "255.255.255.0",
  cidr: null,
  mac: "00:00:00:00:00:00",
});
const interfaces = () =>
  ({
    en0: [
      item("192.168.1.20"),
      item("8.8.8.8"),
      item("fd00::1", "IPv6"),
      item("fe80::1", "IPv6"),
      item("fd00::2", "IPv6", true),
    ],
    docker0: [item("172.17.0.1"), item("fd00::3", "IPv6")],
    lo: [item("127.0.0.1", "IPv4", true)],
    empty: undefined,
  }) as ReturnType<typeof safeNetworkInterfaces>;

test("advertises only private physical LAN/ULA addresses, never loopback wildcard VPN public or virtual addresses", () => {
  const dependencies = { interfaces, hostNetwork: vi.fn().mockReturnValue(null) };
  expect(gatewayDirectCandidates({ port: 7600 }, dependencies)).toEqual({
    version: 1,
    candidates: [
      { address: "192.168.1.20", port: 7600 },
      { address: "fd00::1", port: 7600 },
    ],
  });
  expect(dependencies.hostNetwork).not.toHaveBeenCalled();
  expect(gatewayDirectCandidates({}, dependencies).candidates).toEqual([]);
  expect(
    gatewayDirectCandidates({ configDir: "private", port: 0 }, dependencies).candidates,
  ).toEqual([]);
});

test("trusted Docker host record replaces container addresses and uses its published host port", () => {
  const dependencies = {
    interfaces,
    hostNetwork: vi.fn().mockReturnValue({
      port: 8443,
      identities: [
        { kind: "lan", address: "10.0.0.4" },
        { kind: "lan", address: "10.0.0.4" },
        { kind: "mdns", address: "synthetic.local" },
        { kind: "tailscale", address: "100.64.0.1" },
        { kind: "lan", address: "0.0.0.0" },
      ],
    }),
  };
  expect(gatewayDirectCandidates({ configDir: "private", port: 7600 }, dependencies)).toEqual({
    version: 1,
    candidates: [{ address: "10.0.0.4", port: 8443 }],
  });
  dependencies.hostNetwork.mockReturnValue({
    port: null,
    identities: Array.from({ length: 12 }, (_, n) => ({ kind: "lan", address: `10.0.0.${n + 1}` })),
  });
  expect(
    gatewayDirectCandidates({ configDir: "private", port: 7600 }, dependencies).candidates,
  ).toHaveLength(8);
});
