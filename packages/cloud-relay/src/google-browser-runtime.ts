// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { googleIdentityProvider } from "./identity.js";
import { readPrivateJson } from "./google-credentials.js";
import { relayOrigin } from "./network.js";
import type { GoogleBrowserOAuthClient } from "./google-browser-broker.js";
import type { GoogleBrowserServerConfiguration } from "./google-browser-server.js";

/** Only the operator's relay process loads shared web-client secrets. Gateways discover public client IDs. */
export async function googleBrowserConfiguration(
  env: NodeJS.ProcessEnv,
  deviceEnrollment: GoogleBrowserOAuthClient | undefined,
  deviceClientIds: readonly string[],
  deviceAuthorizedParties: readonly string[],
): Promise<GoogleBrowserServerConfiguration | undefined> {
  const secretFile = env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE;
  const id = env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID;
  const origin = env.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN;
  if (secretFile && (!id || !origin))
    throw new Error(
      "Managed Google owner sign-in requires an operator client ID and public relay origin",
    );
  if (!origin) return undefined;
  relayOrigin(origin);
  let ownerLink: GoogleBrowserOAuthClient | undefined;
  if (secretFile && id) {
    try {
      const value = z
        .object({
          web: z.object({
            client_id: z.literal(id),
            client_secret: z.string().trim().min(1).max(8192),
          }),
        })
        .parse(await readPrivateJson(secretFile));
      ownerLink = {
        clientId: id,
        clientSecret: value.web.client_secret,
        identity: googleIdentityProvider(id),
      };
    } catch {
      throw new Error("Invalid operator Google owner web credential file");
    }
  }
  if (!ownerLink && !deviceEnrollment && deviceClientIds.length === 0) return undefined;
  return { ownerLink, deviceEnrollment, deviceClientIds, deviceAuthorizedParties };
}
