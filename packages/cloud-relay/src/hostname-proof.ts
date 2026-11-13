// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolveTxt } from "node:dns/promises";
import { hostedGatewayHostname } from "./hosted-name.js";

/**
 * A hosted name must be the gateway's own derivation; a custom name needs an independent DNS
 * proof. Passing only makes a name eligible: the account store grants it to one gateway.
 */
export async function verifyRoutingHostname(
  hostname: string,
  account: string,
  gatewayId: string,
  relayDomain?: string,
  lookup: (name: string) => Promise<string[][]> = resolveTxt,
): Promise<boolean> {
  if (relayDomain !== undefined && hostname === hostedGatewayHostname(gatewayId, relayDomain))
    return true;
  try {
    const records = await lookup(`_omnesis-gateway.${hostname}`);
    const expected = `omnesis-relay-v2:${account}:${gatewayId}`;
    return records.some((chunks) => chunks.join("") === expected);
  } catch {
    return false;
  }
}
