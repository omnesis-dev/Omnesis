// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type CloudRelayManagementError =
  | "relay-service-unavailable"
  | "relay-service-mismatch"
  | "configuration-invalid"
  | "dns-verification-required"
  | "dns-capacity"
  | "dns-allocation-rate"
  | "relay-unreachable"
  | "invite-invalid"
  | "invite-expired"
  | "invite-used"
  | "invitation-required"
  | "enrollment-refused"
  | "hostname-required"
  | "hostname-conflict"
  | "ca-terms-required"
  | "operation-in-progress"
  | "already-connected"
  | "google-unavailable"
  | "google-link-failed"
  | "account-unavailable"
  | "account-link-failed"
  | "tunnel-disconnected"
  | "certificate-setup-failed"
  | "certificate-renewal-failed"
  | "public-endpoint-unreachable"
  | "passkey-origin-unavailable"
  | "passkey-not-confirmed"
  | "passkey-not-on-account";

export interface CloudRelayNetworkIdentity {
  id: "direct" | "cloud";
  names: string[];
  label?: string;
  kind: "self-signed" | "public-ca" | "local-ca" | "external" | "unconfigured";
  state: "unconfigured" | "valid" | "expiring" | "expired" | "failed";
  expiresAt?: string;
  pinPolicy: "existing-device-policy" | "strict-key-pin-or-public-pki";
}

/**
 * A passkey's label and when it was added to the account (Unix seconds), as the account's listing
 * last gave them. The relay chooses both, so they are shown to the owner and decide nothing.
 * Absent for a Google account, and when the relay gave none (one from before labels).
 */
interface PasskeyName {
  label?: string;
  createdAt?: number;
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
  publicMcp: {
    ready: boolean;
    url?: string;
    lastError?: "public-endpoint-unreachable";
    /** Actual public-route probe completion and expiry, Unix milliseconds; not assistant usage. */
    checkedAt?: number;
    validUntil?: number;
  };
  google: {
    configured: boolean;
    linked?: boolean;
    canLink?: boolean;
    canUnlink?: boolean;
    linkOrigin?: string;
    lastError?: "google-link-failed" | "google-unavailable";
  };
  account?: {
    activated: boolean;
    configured: boolean;
    linked: boolean;
    canLink: boolean;
    canUnlink: boolean;
    pendingUnlink: boolean;
    lastError?: "account-unavailable" | "account-link-failed";
  };
  /** Progress of connecting by sign-in. Present while a connection is under way or just ended. */
  connect?: {
    state: "idle" | "waiting" | "registering" | "linking" | "done" | "failed";
    /** The choice the owner made: creating an account, or signing in to one they have. */
    intent?: "create" | "existing";
    /**
     * While `registering`: what the gateway is doing. `registering` with the relay, getting its
     * `certificate`, then opening its `tunnel` and checking its address answers.
     */
    step?: "registering" | "certificate" | "tunnel";
    /**
     * Once `done`: the owner chose to create an account, but the sign-in already had one, so the
     * gateway was linked to that account and the invite was not used. Absent when the relay
     * doesn't say which happened.
     */
    existingAccount?: true;
    /** An independent DNS broker check before this gateway obtains its public name. */
    verification?: { url: string; expiresAt: number };
    authorizeUrl?: string;
    connectUrl?: string;
    /** For display only: the relay's short address for the same connect page. */
    connectShortUrl?: string;
    code?: string;
    expiresAt?: number;
    error?:
      | "not-allowed"
      | "capacity"
      | "expired"
      | "enrollment-refused"
      | "account-link-failed"
      | "dns-capacity"
      | "dns-allocation-rate"
      | "invite-invalid"
      | "invite-expired"
      | "invite-used";
  };
  /**
   * The certificate monitor saw a certificate for this gateway's name with a key the gateway
   * doesn't hold. Until the owner acknowledges it on the gateway itself, every new device waits
   * for approval. `certificates` are SHA-256 fingerprints of those certificates.
   */
  incidentHold?: { since: string; certificates: string[] };
  /** Local choices about new devices. These are never sent to the relay. */
  deviceEnrollment?: {
    policy: "automatic" | "ask";
    /** Linked, and no sign-in confirmed here yet: every new device waits for a person. */
    confirmationNeeded: boolean;
    trustedSignIns: ({
      type: "google" | "passkey";
      id: string;
      addedAt: number;
      source: import("./gateway-sign-in-proof.js").TrustedSignInSource;
      /** Whether the owner also confirmed it on this gateway (`confirmedSignIns`). */
      confirmed: boolean;
    } & PasskeyName)[];
    /** Sign-ins the owner confirmed on this gateway, and how. */
    confirmedSignIns: ({
      type: "google" | "passkey";
      id: string;
      at: number;
      via: import("./gateway-sign-in-proof.js").ConfirmedSignInVia;
    } & PasskeyName)[];
    /** The gateway's own origin, where a passkey can be confirmed; absent when it has none. */
    confirmOrigin?: string;
    /**
     * The account listed a passkey when this gateway last read it, so one can be confirmed here
     * whether or not this gateway pinned it. Only says what setup can offer; it trusts nothing.
     */
    accountPasskey?: true;
  };
  /**
   * The relay no longer has this gateway, so it went back to not being connected: its Omnesis
   * account was deleted, or it was unlinked on the account page (`gateway-removed`). Shown until
   * it connects again or restarts.
   */
  notice?: "account-deleted" | "gateway-removed";
  /**
   * Connecting started on this gateway and never finished: it holds a reserved address it has
   * never been reachable at, so that address is offered nowhere. `error` is why the last attempt
   * stopped, when the gateway knows; absent, it was interrupted. Connecting again resumes with the
   * same address; starting over discards it.
   */
  unfinished?: {
    error?: CloudRelayManagementError | NonNullable<CloudRelayManagementStatus["connect"]>["error"];
  };
  /**
   * The relay's accounts need approval, and this is where to ask for it. Present only before this
   * gateway is linked to an account, once the relay has said so.
   */
  signup?: import("./gateway-signup-contract.js").GatewaySignupAccess;
  can: {
    configure: boolean;
    enable: boolean;
    disable: boolean;
    reconnect: boolean;
    renew: boolean;
    /**
     * Discard an unfinished connection, so the gateway is as if it never connected. Absent from a
     * gateway that predates starting over.
     */
    startOver?: boolean;
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
  managedAccountBrowser?(): import("./account-browser-client.js").AccountBrowserPort | undefined;
  accountModeActivated?(): boolean;
  verifiedAccountId?(): string | undefined;
  accountPairingIdentity?():
    | {
        identity: import("./identity.js").IdentityProvider;
        ownerAccountId: string;
        configurationKey: string;
        enrollment: import("./google-pairing.js").GatewayEnrollment;
      }
    | undefined;
  /** `intent` picks the sign-in page's first view: creating an account, or signing in to one. */
  connect?(input: {
    termsAccepted?: boolean;
    intent?: "create" | "existing";
    invite?: string;
  }): Promise<CloudRelayManagementStatus>;
  cancelConnect?(): Promise<CloudRelayManagementStatus>;
  /**
   * Says the owner has been told that the sign-in already had an account: `existingAccount`
   * leaves the status, so it is said once when connecting completes and not on later visits.
   */
  acknowledgeConnect?(): Promise<CloudRelayManagementStatus>;
  /**
   * Discards a connection that never finished: the reserved address, the gateway id, its keys and
   * the saved choices, so the gateway is as if it had never connected. Refused once the gateway
   * has connected; unlinking is the way out then.
   */
  startOver?(): Promise<CloudRelayManagementStatus>;
  setEnrollmentPolicy?(policy: "automatic" | "ask"): Promise<CloudRelayManagementStatus>;
  /** Lifts an incident hold. Callers must refuse a request that came through the relay. */
  acknowledgeIncidentHold?(): Promise<CloudRelayManagementStatus>;
  removeTrustedSignIn?(id: string): Promise<CloudRelayManagementStatus>;
  /**
   * Reads the account's sign-ins again now, as the periodic check-in does: the owner is looking at
   * the account page, perhaps just back from changing the account. Throttled; adds no trust.
   */
  refreshAccount?(): Promise<CloudRelayManagementStatus>;
  /** Starts confirming a passkey on the gateway's own page (`pin-passkey`). */
  passkeyConfirmation?(): Promise<import("./gateway-account-link.js").GatewayPasskeyCeremony>;
  /** Finishes it with the `gateway-passkey` assertion the page made. */
  confirmPasskey?(proof: unknown): Promise<CloudRelayManagementStatus>;
  accountLink?(input: { requestOrigin: string }): Promise<{ authorizeUrl: string; cookie: string }>;
  accountCallback?(input: {
    url: string;
    cookie?: string;
  }): Promise<{ redirectUrl: string; cookie: string }>;
  accountUnlink?(): Promise<CloudRelayManagementStatus>;
  managedGoogleBrowser?(): import("./google-browser-client.js").GoogleBrowserPort | undefined;
  status(): Promise<CloudRelayManagementStatus>;
  /** Reads the relay's public signup access when it is due; `status()` then carries it. */
  refreshSignupAccess?(): Promise<void>;
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
    readonly status: 400 | 403 | 409 | 503,
    readonly code: CloudRelayManagementError,
  ) {
    super(code);
  }
}
