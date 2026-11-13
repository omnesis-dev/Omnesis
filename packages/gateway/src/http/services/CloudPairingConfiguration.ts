// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { openSync, closeSync, readSync } from "node:fs";
import {
  googleIdentityProvider,
  publicGatewayOrigin,
  type IdentityProvider,
} from "@omnesis/cloud-relay";
import { z } from "zod";

export interface CloudPairingIdentity {
  identity: IdentityProvider;
  ownerAccountId: string;
  configurationKey?: string;
  enrollment?: import("@omnesis/cloud-relay").GatewayEnrollment;
}

/** Private configuration is bounded before parsing and never included in HTTP responses. */
function privateJson(path: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 65_536) throw new Error("Private configuration is too large");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } catch {
    throw new Error("Invalid private Google configuration file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function cloudPairingIdentity(
  env: NodeJS.ProcessEnv,
  provided?: CloudPairingIdentity,
): CloudPairingIdentity | undefined {
  if (provided) return provided;
  const clients = [
    ...new Set([
      ...(env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID?.split(",").map((id) => id.trim()) ?? []),
      ...(env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID
        ? [env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID]
        : []),
    ]),
  ];
  if (clients.length === 0) return undefined;
  const owner =
    env.OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT ??
    (env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE
      ? z
          .object({ accountId: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(privateJson(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE)).accountId
      : undefined);
  if (!owner) return undefined;
  const authorizedParties = [
    ...new Set([
      ...clients,
      ...(env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID?.split(",").map((id) => id.trim()) ??
        []),
    ]),
  ];
  return {
    identity: googleIdentityProvider(clients, undefined, { authorizedParties }),
    configurationKey: JSON.stringify([clients, authorizedParties]),
    ownerAccountId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(owner),
  };
}

export function webGooglePairingConfiguration(
  env: NodeJS.ProcessEnv,
  publicBaseUrl?: string,
):
  | {
      clientId: string;
      clientSecret: string;
      publicBaseUrl: string;
    }
  | undefined {
  const clientId = env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID;
  const secretFile = env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE;
  if (!clientId || !secretFile) return undefined;
  const origin =
    env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN !== undefined ? publicGatewayOrigin(env) : publicBaseUrl;
  if (!origin) return undefined;
  const credentials = z
    .object({
      web: z.object({ client_id: z.literal(clientId), client_secret: z.string().min(1).max(8192) }),
    })
    .safeParse(privateJson(secretFile));
  if (!credentials.success) throw new Error("Invalid Google web OAuth credential file");
  return { clientId, clientSecret: credentials.data.web.client_secret, publicBaseUrl: origin };
}

/** Managed links update the verified owner at runtime; static configuration keeps its existing semantics. */
export function cloudPairingIdentitySource(
  env: NodeJS.ProcessEnv,
  verifiedOwner: () => string | undefined,
  managedIdentity?: () =>
    { clientIds: readonly string[]; authorizedParties: readonly string[] } | undefined,
): () => CloudPairingIdentity | undefined {
  let initialized = false;
  let owner: string | undefined;
  let configured: CloudPairingIdentity | undefined;
  let clients = "";
  return () => {
    const next = verifiedOwner();
    const managed = managedIdentity?.();
    const nextClients = JSON.stringify(managed);
    if (!initialized || owner !== next || clients !== nextClients) {
      const combined = managed
        ? {
            ...env,
            OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: [
              ...managed.clientIds,
              ...(env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID?.split(",") ?? []),
            ].join(","),
            OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID: [
              ...managed.authorizedParties,
              ...(env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID?.split(",") ?? []),
            ].join(","),
          }
        : env;
      configured = cloudPairingIdentity(
        next === undefined ? combined : { ...combined, OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: next },
      );
      clients = nextClients;
      owner = next;
      initialized = true;
    }
    return configured;
  };
}
