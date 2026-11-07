// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolveTxt } from "node:dns/promises";

/** Hosted names are UUID-scoped; custom names require an independent DNS proof. */
export async function verifyRoutingHostname(
  hostname: string,
  account: string,
  gatewayId: string,
  relayDomain?: string,
  lookup: (name: string) => Promise<string[][]> = resolveTxt,
): Promise<boolean> {
  if (
    relayDomain !== undefined &&
    hostname === `g-${gatewayId.toLowerCase().replaceAll("-", "")}.${relayDomain}`
  )
    return true;
  try {
    const records = await lookup(`_omnesis-gateway.${hostname}`);
    const expected = `omnesis-relay-v2:${account}:${gatewayId}`;
    return records.some((chunks) => chunks.join("") === expected);
  } catch {
    return false;
  }
}
