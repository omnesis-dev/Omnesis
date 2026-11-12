// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSecureContext, type SecureContext, type TlsOptions } from "node:tls";

/** Gateway-only public TLS context. Replacement retains one context rather than accumulating server.addContext entries. */
export class GatewayPublicSni {
  private current: { hostname: string; context: SecureContext } | undefined;
  readonly callback: NonNullable<TlsOptions["SNICallback"]> = (hostname, callback) => {
    callback(
      null,
      this.current?.hostname === hostname.toLowerCase() ? this.current.context : undefined,
    );
  };
  activate(material: { hostname: string; cert: string; key: string }): void {
    const context = createSecureContext({ cert: material.cert, key: material.key });
    this.current = { hostname: material.hostname.toLowerCase(), context };
  }
}
