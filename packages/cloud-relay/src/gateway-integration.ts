// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cloudRelayEnabled } from "@omnesis/core";
import { z } from "zod";
import { gatewayKeySessionSource, GatewayUnregistered } from "./gateway-key-client.js";
import { GatewayTunnel } from "./tunnel-client.js";
import { readPrivateJson, googleRelaySessionSource } from "./google-credentials.js";

const sessionFileSchema = z.object({ token: z.string().min(1).max(4096) });

export async function readRelaySession(path: string): Promise<string> {
  return sessionFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).token;
}

/** Absent configuration leaves every existing gateway path untouched. */
export function startGatewayCloudTunnel(
  gatewayUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  /** Called when the relay says it no longer has this gateway, which no retry will change. */
  unregistered?: () => void,
): GatewayTunnel | undefined {
  // A relay URL alone only chooses the service; a gateway without an ID is connected from the portal.
  if (
    !cloudRelayEnabled(env) ||
    !env.OMNESIS_CLOUD_RELAY_URL ||
    !env.OMNESIS_CLOUD_RELAY_GATEWAY_ID
  )
    return undefined;
  if (!env.OMNESIS_CLOUD_RELAY_SESSION_FILE) {
    throw new Error("Cloud relay requires a session file and stable gateway ID");
  }
  const sessionFile = env.OMNESIS_CLOUD_RELAY_SESSION_FILE;
  const googleCredentials = env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE;
  const gatewayClientId = env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID;

  const publicCertificate = env.OMNESIS_ACME_DIRECTORY_URL
    ? env.OMNESIS_ACME_CERT_FILE
    : env.OMNESIS_TLS_CERT;
  const privateKey = env.OMNESIS_ACME_DIRECTORY_URL
    ? (env.OMNESIS_ACME_KEY_FILE ?? (publicCertificate ? `${publicCertificate}.key` : undefined))
    : env.OMNESIS_TLS_KEY;
  const publicOrigin = env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN ?? env.OMNESIS_PUBLIC_BASE_URL;
  const keySource =
    publicCertificate && privateKey && publicOrigin
      ? gatewayKeySessionSource({
          relayUrl: env.OMNESIS_CLOUD_RELAY_URL,
          sessionFile,
          gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
          publicOrigin,
          certificateFile: publicCertificate,
          privateKeyFile: privateKey,
          ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
          enrollmentTokenFile: env.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
          recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
        })
      : undefined;
  let ownerMode = Boolean(
    env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE || existsSync(`${sessionFile}.owner-key`),
  );
  if (googleCredentials && !gatewayClientId && !ownerMode)
    throw new Error("Google routing refresh requires the gateway OAuth client ID");
  const googleSource =
    googleCredentials && gatewayClientId
      ? googleRelaySessionSource({
          relayUrl: env.OMNESIS_CLOUD_RELAY_URL,
          sessionFile,
          credentialsFile: googleCredentials,
          clientId: gatewayClientId,
          clientSecretFile: env.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE,
        })
      : undefined;
  const session = async (signal?: AbortSignal) => {
    ownerMode ||= Boolean(
      env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE || existsSync(`${sessionFile}.owner-key`),
    );
    try {
      const stored = await readPrivateJson(sessionFile);
      if (
        typeof stored === "object" &&
        stored !== null &&
        "authentication" in stored &&
        stored.authentication === "gateway-key-v2"
      )
        ownerMode = true;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      if (keySource && !googleSource) ownerMode = true;
    }
    if (ownerMode) {
      if (!keySource)
        throw new Error(
          "Owner-key routing requires the gateway TLS certificate, private key and public origin",
        );
      return keySource(signal).catch((error: unknown) => {
        if (error instanceof GatewayUnregistered) unregistered?.();
        throw error;
      });
    }
    return googleSource ? googleSource() : readRelaySession(sessionFile);
  };
  const tunnel = new GatewayTunnel({
    relayUrl: env.OMNESIS_CLOUD_RELAY_URL,
    gatewayUrl,
    gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
    session,
    invalidateSession: () => {
      if (ownerMode) keySource?.invalidate();
    },
  });
  tunnel.start();
  return tunnel;
}
