// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";

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

/**
 * A gateway's origin on its relay's domain, derived by the gateway itself: the saved public
 * origin counts only when its host is this gateway's hosted name under the relay's host, so a
 * relay that chose some other name (its own, or another gateway's) never makes the gateway vouch
 * for it. Undefined for a custom domain or any mismatch. The port follows the saved origin.
 */
export function hostedGatewayOrigin(input: {
  relayOrigin: string | undefined;
  gatewayId: string | undefined;
  publicOrigin: string | undefined;
}): string | undefined {
  try {
    const gatewayId = z.string().uuid().parse(input.gatewayId);
    const relay = bindingOrigin(z.string().parse(input.relayOrigin));
    const saved = bindingOrigin(z.string().parse(input.publicOrigin));
    return saved.hostname === hostedGatewayHostname(gatewayId, relay.hostname)
      ? saved.origin
      : undefined;
  } catch {
    return undefined;
  }
}
