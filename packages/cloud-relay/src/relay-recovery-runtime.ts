// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { atomicWriteFile } from "@omnesis/core";
import { z } from "zod";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { loadTrustedRecoveryPolicy, type TrustedRecoveryPolicy } from "./recovery-verifier.js";
import { runRecoveryAuthorityTool } from "./recovery-tool.js";
import { prepareGatewayRecoveryRequest } from "./gateway-key-client.js";
import { publicGatewayOrigin } from "./gateway-certificate.js";
import {
  assertRecoveryArtifactDestination,
  recoveryArtifactPaths,
} from "./recovery-artifact-paths.js";

const required = (value: string | undefined) => z.string().min(1).parse(value);
const recoveryFields = [
  "OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE",
  "OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE",
  "OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256",
  "OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID",
  "OMNESIS_CLOUD_RELAY_RECOVERY_MIN_POLICY_EPOCH",
] as const;

/** A clean relay receives only independent public trust anchors, never the authority's signing key. */
export async function loadRelayRecoveryPolicy(
  env: NodeJS.ProcessEnv,
): Promise<TrustedRecoveryPolicy | undefined> {
  if (env.OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE)
    throw new Error("The offline recovery signing key must not be configured on a relay");
  if (!recoveryFields.some((name) => env[name] !== undefined)) return undefined;
  for (const name of recoveryFields) required(env[name]);
  const publicKey = await readFile(
    required(env.OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE),
    "utf8",
  );
  return loadTrustedRecoveryPolicy(
    await readPrivateJson(required(env.OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE)),
    {
      publicKey,
      keyId: required(env.OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID),
      policySha256: required(env.OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256),
      minimumPolicyEpoch: z.coerce
        .number()
        .int()
        .positive()
        .parse(env.OMNESIS_CLOUD_RELAY_RECOVERY_MIN_POLICY_EPOCH),
      relayOrigin: required(env.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN),
      relayDomain: required(env.OMNESIS_CLOUD_RELAY_DOMAIN),
    },
  );
}

/** Rotation writes a new relay-only HMAC secret; restarting the relay invalidates all old sessions/invitations. */
export async function rotateRelaySessionKey(env: NodeJS.ProcessEnv): Promise<void> {
  const target = resolve(required(env.OMNESIS_CLOUD_RELAY_KEY_FILE));
  const protectedPaths = recoveryArtifactPaths(env, false);
  assertRecoveryArtifactDestination(target, protectedPaths);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const destination = assertRecoveryArtifactDestination(target, protectedPaths);
  await atomicWriteFile(destination, randomBytes(32), { mode: 0o600 });
}

/** Offline/local explicit-path operations. No command here connects to a relay, Google, DNS or a CA. */
export async function runRelayRecoveryCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const operations = {
    "recovery-create-authority": "create",
    "recovery-sign-receipt": "receipt",
    "recovery-sign-policy": "policy",
    "recovery-policy-digest": "digest",
  } as const;
  let result: { policySha256?: string; publicKey?: string; restartRequired?: boolean };
  if (Object.hasOwn(operations, command)) {
    const operation = operations[command as keyof typeof operations];
    result = await runRecoveryAuthorityTool(operation, {
      privateKeyFile:
        operation === "digest" ? "" : required(env.OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE),
      publicKeyFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE,
      inputFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE,
      outputFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE,
      protectedPaths: recoveryArtifactPaths(
        env,
        true,
        operation === "policy" || operation === "receipt" ? operation : undefined,
      ),
    });
  } else if (command === "recovery-rotate-session-key") {
    await rotateRelaySessionKey(env);
    result = { restartRequired: true };
  } else if (command === "recovery-request") {
    const request = await prepareGatewayRecoveryRequest({
      relayUrl: required(env.OMNESIS_CLOUD_RELAY_URL),
      sessionFile: required(env.OMNESIS_CLOUD_RELAY_SESSION_FILE),
      gatewayId: required(env.OMNESIS_CLOUD_RELAY_GATEWAY_ID),
      publicOrigin: publicGatewayOrigin(env),
      ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    });
    const output = required(env.OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE);
    const protectedPaths = recoveryArtifactPaths(env, true);
    assertRecoveryArtifactDestination(output, protectedPaths);
    await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
    const destination = assertRecoveryArtifactDestination(output, protectedPaths);
    await savePrivateJson(destination, request);
    result = {};
  } else return false;
  process.stdout.write(JSON.stringify(result) + "\n");
  return true;
}
