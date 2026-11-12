// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { GooglePairingRequests, type GoogleBrowserPort } from "@omnesis/cloud-relay";
import { ManagedWebGooglePairing } from "./ManagedWebGooglePairing.js";
import { ManagedWebAccountPairing } from "./ManagedWebAccountPairing.js";
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
        web?: WebGooglePairing | ManagedWebGooglePairing | ManagedWebAccountPairing;
        account?: boolean;
        managedClient?: string;
        configurationKey?: string;
        webOrigin?: string;
      }
    | undefined;

  constructor(
    private readonly options: {
      identity(): CloudPairingIdentity | undefined;
      broker?(): GoogleBrowserPort | undefined;
      account?(): {
        activated: boolean;
        identity?: CloudPairingIdentity;
        broker?: import("@omnesis/cloud-relay").AccountBrowserPort;
      };
      publicOrigin(): string | undefined;
      webConfiguration(origin: string | undefined): WebConfiguration | undefined;
      fingerprint(): string;
      createPairing: PairingCreator;
      onPending?: ConstructorParameters<typeof GooglePairingRequests>[0]["onPending"];
    },
  ) {}

  resolve(): typeof this.current {
    const account = this.options.account?.();
    const identity = account?.activated ? account.identity : this.options.identity();
    const broker = this.options.broker?.();
    const managedClient = account?.activated
      ? account.broker?.authorizationOrigin()
      : broker?.clientId("device-enrollment");
    if (!identity) {
      if (
        this.current?.web instanceof ManagedWebGooglePairing ||
        this.current?.web instanceof ManagedWebAccountPairing
      )
        this.current.web.cancel();
      this.current = undefined;
      return undefined;
    }
    // A configured public identity may still be initializing or recovering its TLS context.
    // Keep discovery closed until a real certificate is available; never substitute the direct certificate.
    if (!/^[a-f0-9]{64}$/.test(this.options.fingerprint())) {
      if (
        this.current?.web instanceof ManagedWebGooglePairing ||
        this.current?.web instanceof ManagedWebAccountPairing
      )
        this.current.web.cancel();
      this.current = undefined;
      return undefined;
    }
    const origin = this.options.publicOrigin();
    if (
      this.current?.owner === identity.ownerAccountId &&
      this.current.account === Boolean(account?.activated) &&
      this.current.origin === origin &&
      this.current.managedClient === managedClient &&
      this.current.configurationKey === identity.configurationKey
    )
      return this.current;
    if (
      this.current?.web instanceof ManagedWebGooglePairing ||
      this.current?.web instanceof ManagedWebAccountPairing
    )
      this.current.web.cancel();
    const pairing = new GooglePairingRequests({
      ...identity,
      gatewayFingerprint: this.options.fingerprint,
      createPairing: this.options.createPairing,
      onPending: this.options.onPending,
    });
    const webConfiguration = account?.activated ? undefined : this.options.webConfiguration(origin);
    this.current = {
      owner: identity.ownerAccountId,
      origin,
      pairing,
      managedClient,
      configurationKey: identity.configurationKey,
      account: Boolean(account?.activated),
      ...(account?.activated && account.broker
        ? { web: new ManagedWebAccountPairing({ broker: account.broker, pairing }) }
        : {}),
      ...(!account?.activated && !webConfiguration && managedClient
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
