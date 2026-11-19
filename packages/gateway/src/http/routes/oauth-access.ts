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
import type { AgentCertificateTrust } from "../../tls-lifecycle/agent-trust.js";
import type { McpAddresses } from "../../remote-access/mcp-addresses.js";

export function mountOAuthAccessRoutes(
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
    /** See `mountOAuthAuthorizationRoutes`. */
    onDeviceLevelChanged?: () => void;
    onAuthorizationPending?: () => void;
    /** See `mountOAuthAuthorizationRoutes`. */
    tlsFingerprintSha256?: string | (() => string);
    /** See `mountOAuthAuthorizationRoutes`. */
    listenPort?: number;
    /** See `mountOAuthAuthorizationRoutes`. */
    probeCertificate?: CertificateProbe;
    /** See `mountOAuthAuthorizationRoutes`. */
    agentCertificateTrust?: () => AgentCertificateTrust;
    /** See `mountOAuthAuthorizationRoutes`. */
    mcpAddresses?: Pick<McpAddresses, "answersAt" | "settle" | "hostReach">;
    pendingCertificateOrigins?: () => Promise<ReadonlySet<string>>;
  } = {},
): void {
  mountOAuthAccessProtocolRoutes(app, access, options);
}
