// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";
import { interfaceIdentities, type NetworkIdentity } from "./network-discovery.js";

/**
 * The network of the host a Docker gateway runs on, as the host's launcher
 * last read it.
 *
 * Behind Docker's bridge network a gateway discovers only its container's
 * own address and name, which no phone can reach, while Docker publishes its
 * port on every interface of the host. The `omnesis` launcher the Docker
 * installer writes runs on the host, so it records the host's interfaces, its
 * `.local` name when the host answers mDNS, and the published port in
 * `<config>/host-network` before every command it forwards. The gateway reads
 * the file each time it offers addresses, and judges the interfaces by the
 * same rules as its own (`interfaceIdentities`), so a new address from the
 * router is offered from the next command on.
 *
 * The launcher writes the file only for a gateway whose port Docker
 * publishes, and removes it otherwise; the gateway reads it only inside a
 * container.
 */

/** The file in the config directory the launcher writes. */
export const HOST_NETWORK_FILE = "host-network";

export interface HostNetworkFacts {
  /** The host port Docker publishes the gateway's listen port on, if recorded. */
  port: number | null;
  /** The host's own `.local` name, recorded only when the host answers mDNS. */
  localName: string | null;
  /** The host's IPv4 interface addresses, by interface name. */
  interfaces: Array<{ name: string; address: string }>;
}

/** A Docker host's network as pairing uses it: where phones reach it, and at which port. */
export interface HostNetwork {
  port: number | null;
  identities: NetworkIdentity[];
}

const INTERFACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/u;
const LOCAL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/u;

/**
 * Parse the launcher's file: one fact per line, `port <n>`,
 * `local-name <name>.local` and `interface <name> <IPv4>`. Comments, blank
 * lines and anything malformed are skipped, so a hand-edited or truncated
 * file costs only the lines it broke.
 */
export function parseHostNetwork(text: string): HostNetworkFacts {
  const facts: HostNetworkFacts = { port: null, localName: null, interfaces: [] };
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [key, ...values] = line.split(/\s+/u);
    if (key === "port" && values.length === 1 && /^\d{1,5}$/u.test(values[0]!)) {
      const port = Number(values[0]);
      if (port >= 1 && port <= 65535) facts.port = port;
    } else if (key === "local-name" && values.length === 1) {
      const name = values[0]!.toLowerCase().replace(/\.$/u, "");
      if (LOCAL_NAME.test(name) && name !== "localhost.local") facts.localName = name;
    } else if (key === "interface" && values.length === 2) {
      // A Linux interface inside a network namespace reads `eth0@if12`.
      const name = values[0]!.replace(/@.*$/u, "");
      const address = values[1]!;
      if (INTERFACE_NAME.test(name) && isIP(address) === 4) {
        facts.interfaces.push({ name, address });
      }
    }
  }
  return facts;
}

/**
 * The identities a host's recorded facts give it: its LAN addresses, its
 * `.local` name, then its Tailscale addresses, the order the gateway's own
 * discovery lists them in. A loopback address is internal, as
 * `os.networkInterfaces()` would mark it.
 */
export function hostNetworkIdentities(facts: HostNetworkFacts): NetworkIdentity[] {
  const ifaces: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {};
  for (const { name, address } of facts.interfaces) {
    (ifaces[name] ??= []).push({
      address,
      family: "IPv4",
      internal: address.startsWith("127."),
    });
  }
  const { lan, tailscaleIps } = interfaceIdentities(ifaces);
  return [
    ...lan,
    ...(facts.localName
      ? [{ address: facts.localName, label: "mDNS (.local)", kind: "mdns" as const, offLan: false }]
      : []),
    ...tailscaleIps,
  ];
}

/** The host's network from the launcher's file text. */
export function hostNetworkFromText(text: string): HostNetwork {
  const facts = parseHostNetwork(text);
  return { port: facts.port, identities: hostNetworkIdentities(facts) };
}
