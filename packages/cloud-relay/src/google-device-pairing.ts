// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { selectGoogleGateway } from "./gateway-choice-client.js";
import { authorizeGoogleDesktop } from "./google-desktop.js";
import { accountId } from "./identity.js";
import { gatewayBindingSchema, type GatewayBinding } from "./gateway-binding.js";
import { googlePairingNonce } from "./google-pairing.js";
import { exchangeRelayIdentity, readBoundedJson } from "./google-credentials.js";
import { relayOrigin } from "./network.js";
import {
  pairCloudDevice,
  type pinnedGatewayJson,
  type CloudDevicePairing,
} from "./device-pairing.js";
import type { GatewayChoice } from "./gateway-directory.js";
export {
  pinnedGatewayJson,
  GatewayRequestRefused,
  discoverDirectCandidates,
} from "./device-pairing.js";
export type { GatewayTlsTarget } from "./device-pairing.js";
export type GoogleDevicePairing = CloudDevicePairing;

/** Only the public candidate certificate is provisional. The pairing exchange is gated by local confirmation. */
export async function pairGoogleDevice(
  options: {
    relayUrl: string;
    sessionFile: string;
    clientId: string;
    clientSecret?: string;
    kind: "cli" | "collector";
    name: string;
    confirm(
      value: { gatewayUrl: string; verificationCode: string },
      signal: AbortSignal,
    ): Promise<boolean>;
    awaitApproval?(value: { gatewayUrl: string; verificationCode: string }): void;
    selectGateway?(choices: readonly GatewayChoice[], signal: AbortSignal): Promise<string>;
    signal?: AbortSignal;
  },
  dependencies: {
    authorize?: typeof authorizeGoogleDesktop;
    fetch?: typeof fetch;
    gatewayJson?: typeof pinnedGatewayJson;
    wait?: (signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<GoogleDevicePairing> {
  const relay = relayOrigin(options.relayUrl);
  return pairCloudDevice(options, {
    gatewayJson: dependencies.gatewayJson,
    wait: dependencies.wait,
    discover: async (value, signal) => {
      const credentials = await (dependencies.authorize ?? authorizeGoogleDesktop)({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        nonce: googlePairingNonce(value),
        signal,
      });
      const session = await exchangeRelayIdentity({
        relayUrl: relay.href,
        sessionFile: options.sessionFile,
        idToken: credentials.idToken,
        expectedAccountId: accountId(credentials.identity),
        fetch: dependencies.fetch,
        signal,
      });
      let candidate: GatewayBinding;
      if (options.selectGateway) {
        candidate = await selectGoogleGateway({
          relay,
          token: session.token,
          signal,
          select: options.selectGateway,
          fetch: dependencies.fetch,
        });
      } else {
        const directory = await (dependencies.fetch ?? fetch)(
          new URL("/_relay/v2/gateway", relay),
          {
            headers: { authorization: `Bearer ${session.token}` },
            redirect: "error",
            signal,
          },
        );
        if (!directory.ok)
          throw new Error(
            directory.status === 409
              ? "Multiple gateways are linked; choose a gateway before pairing"
              : "No gateway is registered for this Google account",
          );
        candidate = gatewayBindingSchema.parse(await readBoundedJson(directory));
      }
      return { candidate, identityToken: credentials.idToken, method: "google" };
    },
  });
}
