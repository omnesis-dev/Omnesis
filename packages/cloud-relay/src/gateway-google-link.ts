// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { z } from "zod";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { authorizeGoogleDesktop } from "./google-desktop.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { readGoogleDesktopSecret, saveGoogleCredentials } from "./google-credentials.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { relayOrigin } from "./network.js";
import type { GoogleCredentials } from "./google-oauth.js";

const keyEnvironment = z.object({
  OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
  OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_GATEWAY_ID: z.string().uuid(),
  OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: z.string().min(1).optional(),
});

async function googleAuthorization(config: z.infer<typeof keyEnvironment>, env: NodeJS.ProcessEnv) {
  const clientId = z.string().min(1).parse(env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID);
  const credentialsFile = z.string().min(1).parse(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE);
  const secretFile = env.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE;
  return {
    credentialsFile,
    options: {
      clientId,
      clientSecret: secretFile ? await readGoogleDesktopSecret(secretFile, clientId) : undefined,
      nonce: gatewayBindingNonce({
        gatewayId: config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
        publicOrigin: publicGatewayOrigin(env),
        certificate: new X509Certificate(
          await readFile(publicGatewayCertificateFile(env)),
        ).toString(),
      }),
    },
  };
}

/** Link affects discovery only. It cannot replace the stable owner key or authorize a device. */
export async function runGatewayGoogleLink(
  command: "link-google" | "unlink-google",
  env: NodeJS.ProcessEnv,
  dependencies: {
    authorize?: typeof authorizeGoogleDesktop;
    registerKey?: typeof registerGatewayKey;
    fetch?: typeof fetch;
  } = {},
): Promise<void> {
  const config = keyEnvironment.parse(env);
  const relay = relayOrigin(config.OMNESIS_CLOUD_RELAY_URL);
  const google = command === "link-google" ? await googleAuthorization(config, env) : undefined;
  const owner = await (dependencies.registerKey ?? registerGatewayKey)({
    relayUrl: relay.origin,
    sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    gatewayId: config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
    publicOrigin: publicGatewayOrigin(env),
    certificateFile: publicGatewayCertificateFile(env),
    privateKeyFile: publicGatewayPrivateKeyFile(env),
    ownerKeyFile: config.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    enrollmentTokenFile: config.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
    recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
    fetch: dependencies.fetch,
  });
  const credentials: GoogleCredentials | undefined = google
    ? await (dependencies.authorize ?? authorizeGoogleDesktop)(google.options)
    : undefined;
  const response = await (dependencies.fetch ?? fetch)(
    new URL("/_relay/v2/key/google-link", relay),
    {
      method: credentials ? "POST" : "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      ...(credentials ? { body: JSON.stringify({ identityToken: credentials.idToken }) } : {}),
    },
  );
  if (response.status !== 204) throw new Error("Google gateway discovery link change refused");
  if (credentials) {
    // Account metadata enables optional gateway pairing; key-owned control never needs a Google refresh grant.
    await saveGoogleCredentials(google!.credentialsFile, google!.options.clientId, {
      idToken: credentials.idToken,
      identity: credentials.identity,
    });
  }
}
