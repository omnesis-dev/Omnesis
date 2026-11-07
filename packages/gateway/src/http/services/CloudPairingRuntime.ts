// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { GooglePairingRequests, type GoogleBrowserPort } from "@omnesis/cloud-relay";
import { ManagedWebGooglePairing } from "./ManagedWebGooglePairing.js";
import { WebGooglePairing } from "./WebGooglePairing.js";
import type { CloudPairingIdentity } from "./CloudPairingConfiguration.js";

type PairingCreator = ConstructorParameters<typeof GooglePairingRequests>[0]["createPairing"];
type WebConfiguration = Pick<
  ConstructorParameters<typeof WebGooglePairing>[0],
  "clientId" | "clientSecret" | "publicBaseUrl"
>;

/** Each verified owner gets an isolated approval/OAuth state; changing owner cannot adopt old requests. */
export class CloudPairingRuntime {
  private current:
    | {
        owner: string;
        origin: string | undefined;
        pairing: GooglePairingRequests;
        web?: WebGooglePairing | ManagedWebGooglePairing;
        managedClient?: string;
        configurationKey?: string;
        webOrigin?: string;
      }
    | undefined;

  constructor(
    private readonly options: {
      identity(): CloudPairingIdentity | undefined;
      broker?(): GoogleBrowserPort | undefined;
      publicOrigin(): string | undefined;
      webConfiguration(origin: string | undefined): WebConfiguration | undefined;
      fingerprint(): string;
      createPairing: PairingCreator;
    },
  ) {}

  resolve(): typeof this.current {
    const identity = this.options.identity();
    const broker = this.options.broker?.();
    const managedClient = broker?.clientId("device-enrollment");
    if (!identity) {
      if (this.current?.web instanceof ManagedWebGooglePairing) this.current.web.cancel();
      this.current = undefined;
      return undefined;
    }
    // A configured public identity may still be initializing or recovering its TLS context.
    // Keep discovery closed until a real certificate is available; never substitute the direct certificate.
    if (!/^[a-f0-9]{64}$/.test(this.options.fingerprint())) {
      if (this.current?.web instanceof ManagedWebGooglePairing) this.current.web.cancel();
      this.current = undefined;
      return undefined;
    }
    const origin = this.options.publicOrigin();
    if (
      this.current?.owner === identity.ownerAccountId &&
      this.current.origin === origin &&
      this.current.managedClient === managedClient &&
      this.current.configurationKey === identity.configurationKey
    )
      return this.current;
    if (this.current?.web instanceof ManagedWebGooglePairing) this.current.web.cancel();
    const pairing = new GooglePairingRequests({
      ...identity,
      gatewayFingerprint: this.options.fingerprint,
      createPairing: this.options.createPairing,
    });
    const webConfiguration = this.options.webConfiguration(origin);
    this.current = {
      owner: identity.ownerAccountId,
      origin,
      pairing,
      managedClient,
      configurationKey: identity.configurationKey,
      ...(!webConfiguration && managedClient
        ? { web: new ManagedWebGooglePairing({ broker: broker!, pairing }) }
        : {}),
      ...(webConfiguration
        ? {
            web: new WebGooglePairing({
              ...webConfiguration,
              identity: identity.identity,
              pairing,
            }),
            webOrigin: new URL(webConfiguration.publicBaseUrl).origin,
          }
        : {}),
    };
    return this.current;
  }
}
