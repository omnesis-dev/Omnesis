// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Stable, deliberately thin mount façade for the OAuth/access route family. */
import { mountOAuthAccessProtocolRoutes } from "./oauth-access-protocol.js";
import type { AccessService } from "../../access/service.js";
import type { AccessAuthorizationNotifier } from "../../access/authorization-notifier.js";
import type { ClientAssertionVerifier } from "../../access/client-assertion.js";
import type { ClientMetadataDocumentResolver } from "../../access/client-metadata-document.js";
import type { RouteApp } from "./types.js";
import type { CertificateProbe } from "../../access/served-by-gateway.js";

export function mountOAuthAccessRoutes(
  app: RouteApp,
  access: AccessService,
  options: {
    publicBaseUrl?: string;
    mcpResourceUrls?: readonly string[];
    authorizationNotifier?: Pick<AccessAuthorizationNotifier, "targetDeviceIds" | "wakeQueued">;
    clientMetadataResolver?: Pick<ClientMetadataDocumentResolver, "resolve">;
    clientAssertionVerifier?: Pick<ClientAssertionVerifier, "verify">;
    /** See `mountOAuthAuthorizationRoutes`. */
    onDeviceLevelChanged?: () => void;
    onAuthorizationPending?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    tlsFingerprintSha256?: string | (() => string);
    /** See `mountOAuthAuthorizationRoutes`. */
    probeCertificate?: CertificateProbe;
  } = {},
): void {
  mountOAuthAccessProtocolRoutes(app, access, options);
}
