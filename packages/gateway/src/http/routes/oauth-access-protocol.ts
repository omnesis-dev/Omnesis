// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mountOAuthAuthorizationRoutes } from "./oauth-access-authorization.js";
import { mountOAuthMetadataRoutes } from "./oauth-access-metadata.js";
import { mountOAuthTokenRoutes } from "./oauth-access-token.js";
import type { AccessService } from "../../access/service.js";
import type { AccessAuthorizationNotifier } from "../../access/authorization-notifier.js";
import type { ClientMetadataDocumentResolver } from "../../access/client-metadata-document.js";
import type { RouteApp } from "./types.js";
import type { CertificateProbe } from "../../access/served-by-gateway.js";

/** Compose focused OAuth protocol collaborators behind the stable access façade. */
export function mountOAuthAccessProtocolRoutes(
  app: RouteApp,
  access: AccessService,
  options: {
    publicBaseUrl?: string;
    mcpResourceUrls?: readonly string[];
    authorizationNotifier?: Pick<AccessAuthorizationNotifier, "targetDeviceIds" | "wakeQueued">;
    clientMetadataResolver?: Pick<ClientMetadataDocumentResolver, "resolve">;
    onAuthorizationPending?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    onDeviceLevelChanged?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    tlsFingerprintSha256?: string | (() => string);
    /** See `mountOAuthAuthorizationRoutes`. */
    probeCertificate?: CertificateProbe;
  } = {},
): void {
  mountOAuthMetadataRoutes(app, access, options);
  mountOAuthAuthorizationRoutes(app, access, options);
  mountOAuthTokenRoutes(app, access, options);
}
