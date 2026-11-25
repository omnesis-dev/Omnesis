// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  pairCloudDevice,
  type CloudDevicePairingOptions,
  type pinnedGatewayJson,
} from "./device-pairing.js";
import { authorizeAccountDesktop } from "./account-desktop-client.js";
import { readOrCreateDeviceKey } from "./device-key-file.js";
import { selectAccountGateway } from "./gateway-choice-client.js";
import { relayOrigin } from "./network.js";
import type { SecretFileOptions } from "@omnesis/core";
import type { GatewayChoice } from "./gateway-directory.js";

/** Browser sign-in only requests enrollment. Trusted gateway approval and code comparison issue the data credential. */
export async function pairAccountDevice(
  options: CloudDevicePairingOptions & {
    relayUrl: string;
    deviceKeyFile: string;
    deviceKeySecretOptions?: SecretFileOptions;
    selectGateway(choices: readonly GatewayChoice[], signal: AbortSignal): Promise<string>;
    /** Shown beside the browser launch so a machine without one can finish on another device. */
    onConnectCode?(value: { connectUrl: string; connectShortUrl?: string; code: string }): void;
  },
  dependencies: {
    readDeviceKey?: typeof readOrCreateDeviceKey;
    authorize?: typeof authorizeAccountDesktop;
    fetch?: typeof fetch;
    gatewayJson?: typeof pinnedGatewayJson;
    wait?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const relay = relayOrigin(options.relayUrl);
  return pairCloudDevice(options, {
    gatewayJson: dependencies.gatewayJson,
    wait: dependencies.wait,
    deviceKey: await (dependencies.readDeviceKey ?? readOrCreateDeviceKey)(
      options.deviceKeyFile,
      options.deviceKeySecretOptions,
    ),
    discover: async (request, signal) => {
      const discovery = await (dependencies.authorize ?? authorizeAccountDesktop)(
        {
          relayUrl: relay.href,
          nonce: request.enrollmentNonce!,
          kind: request.kind,
          name: request.name,
          signal,
          onConnectCode: options.onConnectCode,
        },
        { fetch: dependencies.fetch },
      );
      signal.throwIfAborted();
      const result = await selectAccountGateway({
        relay,
        token: discovery.discoveryToken,
        accountId: discovery.accountId,
        expiresAt: discovery.expiresAt,
        signal,
        select: options.selectGateway,
        fetch: dependencies.fetch,
      });
      return {
        candidate: result.binding,
        identityToken: result.identityToken,
        method: "account",
        ...(discovery.signInProof ? { proof: discovery.signInProof } : {}),
      };
    },
  });
}
