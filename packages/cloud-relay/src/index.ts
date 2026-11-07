// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export { createCloudRelay } from "./server.js";
export { googleIdentityProvider, localIdentityProvider, RelaySessions } from "./identity.js";
export type { Identity, IdentityProvider } from "./identity.js";
export { RelayAccounts } from "./accounts.js";
export { GatewayTunnel } from "./tunnel-client.js";
export { createRelayClientProxy } from "./client-proxy.js";
export { startGatewayCloudTunnel, readRelaySession } from "./gateway-integration.js";
export {
  GooglePairingRequests,
  googlePairingNonce,
  googlePairingVerificationCode,
} from "./google-pairing.js";
export {
  verifyGatewayBinding,
  gatewayBindingNonce,
  certificateFingerprint,
} from "./gateway-binding.js";
export {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  refreshGoogleAuthorization,
} from "./google-oauth.js";
export type { GoogleAuthorization, GoogleCredentials } from "./google-oauth.js";
export { authorizeGoogleDesktop } from "./google-desktop.js";
export {
  saveGoogleCredentials,
  googleRoutingTokenSource,
  googleRelaySessionSource,
  exchangeRelayIdentity,
} from "./google-credentials.js";
export { pairGoogleDevice } from "./google-device-pairing.js";
export type { GoogleDevicePairing } from "./google-device-pairing.js";

export {
  GatewayKeyAuthentication,
  gatewayKeyAccount,
  keyAuthenticationTranscript,
} from "./gateway-key-auth.js";
export {
  registerGatewayKey,
  gatewayKeySessionSource,
  prepareGatewayOwner,
} from "./gateway-key-client.js";
export type { GatewayKeySessionOptions } from "./gateway-key-client.js";

export {
  directCandidateSchema,
  directCandidatesSchema,
  privateDirectAddress,
} from "./direct-path.js";
export type { DirectCandidate } from "./direct-path.js";
export { tlsSpkiFingerprint } from "./pinned-key.js";

export { createGatewayAcmeController } from "./acme-integration.js";
export {
  publicGatewayOrigin,
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
} from "./gateway-certificate.js";

export { GatewayPublicSni } from "./acme-sni.js";

export type {
  CloudRelayManagement,
  CloudRelayManagementStatus,
  CloudRelayConfigureInput,
  CloudRelayManagementError,
  CloudRelayNetworkIdentity,
} from "./management.js";

export { CloudRelayManagementFailure } from "./management.js";

export { GatewayCloudRelayManagement } from "./management-service.js";
export type { CloudRelayManagerOptions } from "./management-service.js";

export {
  createRecoveryAuthority,
  signRecoveryReceipt,
  signRecoveryPolicy,
} from "./recovery-authority.js";
export { recoveryPolicyDigest } from "./recovery-contract.js";
export type {
  RecoveryReceipt,
  RecoveryReceiptPayload,
  RecoveryPolicy,
  RecoveryPolicyPayload,
} from "./recovery-contract.js";
export { loadTrustedRecoveryPolicy, verifyRecoveryReceipt } from "./recovery-verifier.js";
export type { RecoveryTrust, TrustedRecoveryPolicy } from "./recovery-verifier.js";

export type { GoogleBrowserPort, GoogleBrowserPending } from "./google-browser-client.js";
export {
  GOOGLE_BROWSER_PROTOCOL,
  GOOGLE_BROWSER_PATH,
  googleBrowserCallbackPath,
  googleBrowserCallbackUrl,
  googleBrowserConfigSchema,
  googleBrowserUnsignedStartSchema,
  googleBrowserStartSchema,
  googleBrowserStartResultSchema,
  googleBrowserRedeemSchema,
  googleBrowserRedeemResultSchema,
  googleBrowserStartTranscript,
} from "./google-browser-contract.js";
export type {
  GoogleBrowserPurpose,
  GoogleBrowserConfig,
  GoogleBrowserUnsignedStart,
  GoogleBrowserStart,
  GoogleBrowserStartResult,
  GoogleBrowserStartContext,
} from "./google-browser-contract.js";
