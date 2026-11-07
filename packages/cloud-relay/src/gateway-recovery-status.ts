// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readPrivateJson } from "./google-credentials.js";
import { recoveryReceiptSchema } from "./recovery-contract.js";
import { prepareGatewayRecoveryRequest } from "./gateway-key-client.js";
import type { GatewayKeySessionOptions } from "./gateway-key-client.js";

/** Local artifact health only. The relay independently verifies its authority signature and current policy. */
export interface GatewayRecoveryReceiptStatus {
  receipt: "missing" | "present" | "expired" | "invalid";
  expiresAt?: string;
}
export async function gatewayRecoveryReceiptStatus(
  options: Pick<
    GatewayKeySessionOptions,
    | "relayUrl"
    | "sessionFile"
    | "gatewayId"
    | "publicOrigin"
    | "ownerKeyFile"
    | "recoveryReceiptFile"
  >,
  now = Math.floor(Date.now() / 1000),
): Promise<GatewayRecoveryReceiptStatus> {
  let input: unknown;
  try {
    input = await readPrivateJson(
      options.recoveryReceiptFile ?? `${options.sessionFile}.recovery.json`,
    );
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? { receipt: "missing" }
      : { receipt: "invalid" };
  }
  try {
    const receipt = recoveryReceiptSchema.parse(input);
    const expected = await prepareGatewayRecoveryRequest(options);
    const actual = receipt.payload;
    if (
      actual.gatewayId !== expected.gatewayId ||
      actual.publicOrigin !== expected.publicOrigin ||
      actual.relayOrigin !== expected.relayOrigin ||
      actual.ownerPublicKey !== expected.ownerPublicKey ||
      actual.accountId !== expected.accountId ||
      actual.ownerSpkiFingerprint !== expected.ownerSpkiFingerprint ||
      !Number.isSafeInteger(now) ||
      actual.issuedAt > now
    )
      return { receipt: "invalid" };
    return {
      receipt: actual.expiresAt <= now ? "expired" : "present",
      expiresAt: new Date(actual.expiresAt * 1000).toISOString(),
    };
  } catch {
    return { receipt: "invalid" };
  }
}
