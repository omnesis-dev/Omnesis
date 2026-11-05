// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type CloudRelayManagementError =
  | "relay-service-unavailable"
  | "relay-service-mismatch"
  | "configuration-invalid"
  | "relay-unreachable"
  | "invitation-required"
  | "enrollment-refused"
  | "hostname-required"
  | "hostname-conflict"
  | "ca-terms-required"
  | "operation-in-progress"
  | "google-unavailable"
  | "google-link-failed"
  | "tunnel-disconnected"
  | "certificate-setup-failed"
  | "certificate-renewal-failed"
  | "public-endpoint-unreachable";

export interface CloudRelayNetworkIdentity {
  id: "direct" | "cloud";
  names: string[];
  label?: string;
  kind: "self-signed" | "public-ca" | "local-ca" | "external" | "unconfigured";
  state: "unconfigured" | "valid" | "expiring" | "expired" | "failed";
  expiresAt?: string;
  pinPolicy: "existing-device-policy" | "strict-key-pin-or-public-pki";
}

export interface CloudRelayManagementStatus {
  certificateMonitor?: import("./gateway-certificate-monitor.js").GatewayCertificateMonitorStatus;
  recovery?: import("./gateway-recovery-status.js").GatewayRecoveryReceiptStatus;
  identities?: CloudRelayNetworkIdentity[];
  directCertificate?: { state: CloudRelayNetworkIdentity["state"]; expiresAt?: string };
  revision: number;
  enabled: boolean;
  configured: boolean;
  serviceConfigured?: boolean;
  serviceError?: "relay-service-unavailable" | "relay-service-mismatch";
  gatewayId?: string;
  hostname?: string;
  publicOrigin?: string;
  config: {
    relayUrl?: string;
    publicOrigin?: string;
    acmeDirectoryUrl?: string;
    acmeTermsUrl?: string;
    termsAccepted: boolean;
    invitationRequired: boolean;
  };
  enrollment: {
    state: "unconfigured" | "pending" | "enrolled" | "failed";
    error?: CloudRelayManagementError;
  };
  tunnel: {
    state: "disabled" | "offline" | "connecting" | "online";
    lastConnectedAt?: string;
    lastError?: CloudRelayManagementError;
  };
  certificate: {
    state: "unconfigured" | "bootstrap" | "valid" | "expiring" | "expired" | "failed";
    expiresAt?: string;
    lastRenewedAt?: string;
    lastError?: CloudRelayManagementError;
  };
  publicMcp: { ready: boolean; url?: string; lastError?: "public-endpoint-unreachable" };
  google: {
    configured: boolean;
    linked?: boolean;
    canLink?: boolean;
    canUnlink?: boolean;
    linkOrigin?: string;
    lastError?: "google-link-failed" | "google-unavailable";
  };
  can: {
    configure: boolean;
    enable: boolean;
    disable: boolean;
    reconnect: boolean;
    renew: boolean;
  };
}

export interface CloudRelayConfigureInput {
  relayUrl?: string;
  publicOrigin?: string;
  acmeDirectoryUrl?: string;
  termsAccepted?: boolean;
}

/** All status is public metadata. Invitations and private key material never appear in responses. */
export interface CloudRelayManagement {
  managedGoogleBrowser?(): import("./google-browser-client.js").GoogleBrowserPort | undefined;
  status(): Promise<CloudRelayManagementStatus>;
  configure(input: CloudRelayConfigureInput): Promise<CloudRelayManagementStatus>;
  enable(input?: { invitation?: string }): Promise<CloudRelayManagementStatus>;
  disable(): Promise<CloudRelayManagementStatus>;
  reconnect(): Promise<CloudRelayManagementStatus>;
  renew(): Promise<CloudRelayManagementStatus>;
  googleLink?(input: { requestOrigin: string }): Promise<{ authorizeUrl: string; cookie: string }>;
  googleCallback?(input: {
    url: string;
    cookie?: string;
  }): Promise<{ redirectUrl: string; cookie: string }>;
  googleUnlink?(): Promise<CloudRelayManagementStatus>;
}

/** Only this fixed code/status pair crosses management HTTP error boundaries. */
export class CloudRelayManagementFailure extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: CloudRelayManagementError,
  ) {
    super(code);
  }
}
