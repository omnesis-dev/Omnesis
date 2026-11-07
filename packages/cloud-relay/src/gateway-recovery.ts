// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey } from "node:crypto";
import { readPrivateJson } from "./google-credentials.js";
import {
  gatewayKeyAccount,
  publicKeyFingerprint,
  type KeyRegistration,
} from "./gateway-key-auth.js";
import {
  recoveryReceiptSchema,
  recoveryGatewayIdSchema,
  recoveryPublicKeySchema,
  type RecoveryReceipt,
} from "./recovery-contract.js";
import { relayOrigin } from "./network.js";
import { bindingOrigin } from "./gateway-binding.js";

export interface GatewayRecoveryOptions {
  relayUrl: string;
  sessionFile: string;
  recoveryReceiptFile?: string;
}

/** Public identity only: an offline authority adds its own epoch, lifetime, issuer, domain and signature. */
export function gatewayRecoveryDraft(
  options: Pick<GatewayRecoveryOptions, "relayUrl">,
  identity: Pick<KeyRegistration, "gatewayId" | "publicOrigin" | "ownerPublicKey">,
) {
  const gatewayId = recoveryGatewayIdSchema.parse(identity.gatewayId.toLowerCase());
  const ownerPublicKey = recoveryPublicKeySchema.parse(identity.ownerPublicKey);
  return {
    protocol: "omnesis-relay-recovery" as const,
    version: 1 as const,
    relayOrigin: relayOrigin(options.relayUrl).origin,
    gatewayId,
    publicOrigin: bindingOrigin(identity.publicOrigin).origin,
    ownerPublicKey,
    ownerSpkiFingerprint: publicKeyFingerprint(createPublicKey(ownerPublicKey)),
    accountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
  };
}

/** An absent receipt preserves ordinary enrollment. A malformed or different local identity never falls back. */
export async function readGatewayRecoveryReceipt(
  options: GatewayRecoveryOptions,
  registration: Pick<KeyRegistration, "gatewayId" | "publicOrigin" | "ownerPublicKey">,
): Promise<RecoveryReceipt | undefined> {
  let input: unknown;
  try {
    input = await readPrivateJson(
      options.recoveryReceiptFile ?? `${options.sessionFile}.recovery.json`,
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  const receipt = recoveryReceiptSchema.parse(input);
  const expected = gatewayRecoveryDraft(options, registration);
  const value = receipt.payload;
  if (
    value.gatewayId !== expected.gatewayId ||
    value.relayOrigin !== expected.relayOrigin ||
    value.publicOrigin !== expected.publicOrigin ||
    value.ownerPublicKey !== expected.ownerPublicKey ||
    value.ownerSpkiFingerprint !== expected.ownerSpkiFingerprint ||
    value.accountId !== expected.accountId
  )
    throw new Error("Gateway recovery receipt does not match this local owner identity");
  if (value.issuedAt > Math.floor(Date.now() / 1000) || value.expiresAt <= Date.now() / 1000)
    throw new Error("Gateway recovery receipt is not current");
  // The independently configured relay verifier checks authority signatures and current revocations.
  return receipt;
}
