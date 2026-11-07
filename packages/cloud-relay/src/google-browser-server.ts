// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { GoogleBrowserRoutes } from "./google-browser-routes.js";
import { keyBindingOwnerAccount, keyBindingOwnerPublicKey } from "./gateway-key-auth.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { RelayError } from "./tunnels.js";
import type { LoginAdmission } from "./admission.js";
import type { GatewayBinding } from "./gateway-binding.js";
import type { GoogleBrowserBrokerOptions, GoogleBrowserOwner } from "./google-browser-broker.js";
import type { IncomingMessage } from "node:http";

export type GoogleBrowserServerConfiguration = Omit<
  GoogleBrowserBrokerOptions,
  "origin" | "currentOwner"
>;

/** Normal relay sessions and restored bindings still require independent owner-key authority. */
export function createGoogleBrowserRoutes(
  configuration: GoogleBrowserServerConfiguration,
  dependencies: {
    origin(): string;
    gatewayBinding(account: string): GatewayBinding | undefined;
    authenticate(
      req: IncomingMessage,
    ): Promise<{ accountId: string; identityAccountId: string; expiresAt: number }>;
  },
  admission: LoginAdmission,
): GoogleBrowserRoutes {
  const owner = (account: string): GoogleBrowserOwner | undefined => {
    const binding = dependencies.gatewayBinding(account);
    if (!binding) return undefined;
    const ownerPublicKey = keyBindingOwnerPublicKey(binding);
    if (!ownerPublicKey || keyBindingOwnerAccount(binding) !== account) return undefined;
    return {
      relayOrigin: dependencies.origin(),
      accountId: account,
      gatewayId: binding.gatewayId,
      publicOrigin: binding.publicOrigin,
      certificate: binding.certificate,
      tlsSpkiFingerprint: tlsSpkiFingerprint(binding.certificate),
      ownerPublicKey,
    };
  };
  return new GoogleBrowserRoutes(
    {
      ...configuration,
      origin: dependencies.origin,
      currentOwner: owner,
      authenticate: async (req) => {
        const session = await dependencies.authenticate(req);
        const gateway = owner(session.accountId);
        if (session.identityAccountId !== session.accountId || !gateway)
          throw new RelayError(403, "A raw gateway owner-key session is required");
        return { ...gateway, sessionExpiresAt: session.expiresAt };
      },
    },
    admission,
  );
}
