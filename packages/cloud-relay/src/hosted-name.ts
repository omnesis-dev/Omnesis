// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The hosted DNS label of a gateway: `g-` and the first 40 bits of SHA-256 of its lowercase id,
 * in lowercase RFC 4648 base32. Forty bits can be ground, so the label is only a derivation:
 * a name belongs to the gateway the relay first bound it to, never to whoever derives it.
 */
export function hostedGatewayLabel(gatewayId: string): string {
  const digest = createHash("sha256").update(gatewayId.toLowerCase()).digest();
  let label = "g-";
  for (let index = 0; index < 8; index++)
    label += BASE32[(digest.readUIntBE(0, 5) / 2 ** (35 - 5 * index)) & 31];
  return label;
}

export function hostedGatewayHostname(gatewayId: string, relayDomain: string): string {
  return `${hostedGatewayLabel(gatewayId)}.${relayDomain}`;
}
