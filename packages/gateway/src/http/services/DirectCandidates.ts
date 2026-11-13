// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { interfaceIdentities, isVirtualInterface, safeNetworkInterfaces } from "@omnesis/core";
import { directCandidateSchema, type DirectCandidate } from "@omnesis/cloud-relay";
import { readHostNetwork } from "../../host-network.js";

/** Local network hints are disclosed only to an already approved gateway device. */
export function gatewayDirectCandidates(
  options: { configDir?: string; port?: number },
  dependencies = { interfaces: safeNetworkInterfaces, hostNetwork: readHostNetwork },
): { version: 1; candidates: DirectCandidate[] } {
  const host = options.configDir ? dependencies.hostNetwork(options.configDir) : null;
  const port = host?.port ?? options.port;
  const interfaces = dependencies.interfaces();
  const addresses = host
    ? host.identities.filter((value) => value.kind === "lan").map((value) => value.address)
    : [
        ...interfaceIdentities(interfaces).lan.map((value) => value.address),
        ...Object.entries(interfaces)
          .filter(([name]) => !isVirtualInterface(name))
          .flatMap(([, values]) =>
            (values ?? [])
              .filter((value) => !value.internal && value.family === "IPv6")
              .map((value) => value.address),
          ),
      ];
  const candidates: DirectCandidate[] = [];
  for (const address of new Set(addresses)) {
    const parsed = directCandidateSchema.safeParse({ address, port });
    if (parsed.success) candidates.push(parsed.data);
    if (candidates.length === 8) break;
  }
  return { version: 1, candidates };
}
