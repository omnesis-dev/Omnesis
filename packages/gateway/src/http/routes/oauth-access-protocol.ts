// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mountOAuthAuthorizationRoutes } from "./oauth-access-authorization.js";
import { mountOAuthMetadataRoutes } from "./oauth-access-metadata.js";
import { mountOAuthTokenRoutes } from "./oauth-access-token.js";
import type { AccessService } from "../../access/service.js";
import type { AccessAuthorizationNotifier } from "../../access/authorization-notifier.js";
import type { ClientAssertionVerifier } from "../../access/client-assertion.js";
import type { ClientMetadataDocumentResolver } from "../../access/client-metadata-document.js";
import type { RouteApp } from "./types.js";
import type { CertificateProbe } from "../../access/served-by-gateway.js";
import type { AgentCertificateTrust } from "../../tls-lifecycle/agent-trust.js";
import type { McpAddresses } from "../../remote-access/mcp-addresses.js";

/** Compose focused OAuth protocol collaborators behind the stable access façade. */
export function mountOAuthAccessProtocolRoutes(
  app: RouteApp,
  access: AccessService,
  options: {
    /** The gateway's public address, read on every request so a saved one applies at once. */
    publicAddress?: import("../../public-address.js").PublicAddressSource;
    /** Actual same-machine gateway origin advertised for local-only setup. */
    loopbackBaseUrl?: string;
    additionalOAuthIssuerUrls?: import("../../access/oauth-urls.js").OAuthIssuerSource;
    authorizationNotifier?: Pick<AccessAuthorizationNotifier, "targetDeviceIds" | "wakeQueued">;
    clientMetadataResolver?: Pick<ClientMetadataDocumentResolver, "resolve">;
    clientAssertionVerifier?: Pick<ClientAssertionVerifier, "verify">;
    onAuthorizationPending?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    onDeviceLevelChanged?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    tlsFingerprintSha256?: string | (() => string);
    /** See `mountOAuthAuthorizationRoutes`. */
    listenPort?: number;
    /** See `mountOAuthAuthorizationRoutes`. */
    probeCertificate?: CertificateProbe;
    /** See `mountOAuthAuthorizationRoutes`. */
    agentCertificateTrust?: () => AgentCertificateTrust;
    /** See `mountOAuthAuthorizationRoutes`. */
    mcpAddresses?: Pick<
      McpAddresses,
      "answersAt" | "settle" | "hostReach" | "homeResource" | "homeNetwork"
    >;
    /** See `mountOAuthAuthorizationRoutes`. */
    localMcp?: () => import("../../local-mcp-listener.js").LocalMcpState;
    pendingCertificateOrigins?: () => Promise<ReadonlySet<string>>;
  } = {},
): void {
  mountOAuthMetadataRoutes(app, access, options);
  mountOAuthAuthorizationRoutes(app, access, options);
  mountOAuthTokenRoutes(app, access, options);
}
