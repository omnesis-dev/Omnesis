// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  recoveryReceiptPayloadSchema,
  recoveryPolicyPayloadSchema,
  recoveryReceiptTranscript,
  recoveryPolicyTranscript,
  type RecoveryReceipt,
  type RecoveryPolicy,
} from "./recovery-contract.js";

/** Offline authority only. Never install this private key in the relay's configuration or database. */
export function createRecoveryAuthority(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
function signature(privateKey: string, transcript: Buffer): string {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Recovery signing requires an Ed25519 private key");
  return sign(null, transcript, key).toString("base64url");
}
export function signRecoveryReceipt(input: unknown, privateKey: string): RecoveryReceipt {
  const payload = recoveryReceiptPayloadSchema.parse(input);
  return { payload, signature: signature(privateKey, recoveryReceiptTranscript(payload)) };
}
export function signRecoveryPolicy(input: unknown, privateKey: string): RecoveryPolicy {
  const payload = recoveryPolicyPayloadSchema.parse(input);
  return { payload, signature: signature(privateKey, recoveryPolicyTranscript(payload)) };
}
