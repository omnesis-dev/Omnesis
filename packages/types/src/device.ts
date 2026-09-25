// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Device identity and permission types for the star-topology architecture.
 *
 * A "device" is anything that connects to the gateway: a collector daemon,
 * the operator CLI, the portal, the iOS app, a query agent.
 * Each device holds one or more tokens. Each token carries a set of scopes.
 */
import { BrandedIdError, SourceType } from "./ids.js";
import type { Brand } from "./brand.js";

// Both DeviceId and TokenId are minted via `randomUUID()` in the gateway;
// the validator pins the v4 UUID shape so a malformed "dev_…" string from
// an older codepath or a bad DB row fails loud at the boundary instead of
// silently flowing through as a typed value. Case-insensitive because
// some codepaths upper-case (HTTP path params have been seen lowercased
// in tests; browsers sometimes uppercase Cookie values).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque device identifier — UUID v4. */
export type DeviceId = Brand<string, "DeviceId">;

export function DeviceId(s: string): DeviceId {
  if (typeof s !== "string" || !UUID_REGEX.test(s)) {
    throw new BrandedIdError("DeviceId", String(s), "must be a UUID");
  }
  return s as DeviceId;
}

export function tryDeviceId(s: unknown): DeviceId | null {
  return typeof s === "string" && UUID_REGEX.test(s) ? (s as DeviceId) : null;
}

/** Opaque token identifier — UUID v4. */
export type TokenId = Brand<string, "TokenId">;

export function TokenId(s: string): TokenId {
  if (typeof s !== "string" || !UUID_REGEX.test(s)) {
    throw new BrandedIdError("TokenId", String(s), "must be a UUID");
  }
  return s as TokenId;
}

export function tryTokenId(s: unknown): TokenId | null {
  return typeof s === "string" && UUID_REGEX.test(s) ? (s as TokenId) : null;
}

/**
 * Kinds of devices recognized by the gateway.
 *
 * `ios` and `android` are the native phone-app clients that pair with the
 * gateway and act as read/interact clients over its corpus.
 *
 * `agent` is a paired first-party external-agent integration (OpenClaw or
 * Hermes). It receives privacy-safe subscription wakes over the authenticated
 * device WebSocket and contributes conversations through a separate
 * least-privilege ingestion credential.
 *
 * `browser` is a paired browser extension that acts as a push-based collector:
 * it captures the rendered, authenticated DOM of pages the user dwells on and
 * pushes them to the gateway over HTTP (`POST /documents` / `POST
 * /analytics/ingest`). Like the iOS app hosting Apple Health, it exists only as
 * a push client — the desktop collector never syncs on its behalf. Its token
 * carries `write:web` only: the device kind is the physical client, but the
 * source it contributes captures to is the unified `web` source (#895). See
 * #791 — browser-capture extension.
 *
 * `integration` is third-party code that asks Omnesis questions on the
 * operator's behalf — a voice assistant's handler, a home-automation hook, a
 * script. Unlike the operator's own clients it is not trusted with the
 * corpus: its tokens carry only answer-bounded scopes (see
 * `isAnswerBoundedScope`), and what its answers may use is decided by the
 * access level the operator puts it on. An integration on no access level is
 * answered nothing.
 */
export const DEVICE_KINDS = [
  "collector",
  "cli",
  "portal",
  "ios",
  "android",
  "agent",
  "browser",
  "integration",
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export function isDeviceKind(s: string): s is DeviceKind {
  return (DEVICE_KINDS as readonly string[]).includes(s);
}

/**
 * Scope grants permission to a capability. Valid shapes:
 *   - "read"                  — query, search, retrieve documents
 *   - "admin"                 — manage sources, devices, tokens
 *   - "push:claim"            — claim notifications for this token's device
 *   - "write:*"               — push documents for any source type
 *   - "write:<source-type>"   — push documents for a specific source type
 *
 * Scopes are independent: a device can carry any combination.
 */
export type Scope = Brand<string, "Scope">;

export function Scope(s: string): Scope {
  if (typeof s !== "string" || !isValidScope(s)) {
    throw new BrandedIdError(
      "Scope",
      String(s),
      "must be one of read|read:bulk|answer|admin|push:claim|subscriptions:manage|subscriptions:receive|subscriptions:answer|subscriptions:outcome|write:*|write:<source-type>",
    );
  }
  return s as Scope;
}

export function tryScope(s: unknown): Scope | null {
  return typeof s === "string" && isValidScope(s) ? (s as Scope) : null;
}

/** Well-known scope constants. */
export const SCOPE_READ: Scope = Scope("read");
/**
 * Bulk / whole-corpus reads: full-document enumeration and dumps (list, ids),
 * bulk people-per-document, and row-level analytics-table dumps. Held in
 * addition to `read`, it separates "enumerate the entire corpus" from ordinary
 * bounded reads (a single document, a search query), so a plain `read` token —
 * e.g. a bring-your-own-agent credential — cannot walk the whole corpus at once.
 */
export const SCOPE_READ_BULK: Scope = Scope("read:bulk");
/** Submit questions only through the privacy-reviewed external answer boundary. */
export const SCOPE_ANSWER: Scope = Scope("answer");
export const SCOPE_ADMIN: Scope = Scope("admin");
/** Claim and confirm queued notifications for the token's own device. */
export const SCOPE_PUSH_CLAIM: Scope = Scope("push:claim");
/** Create, inspect, update, and revoke subscriptions owned by this device. */
export const SCOPE_SUBSCRIPTIONS_MANAGE: Scope = Scope("subscriptions:manage");
/** Receive approved subscription wakes over the authenticated device socket. */
export const SCOPE_SUBSCRIPTIONS_RECEIVE: Scope = Scope("subscriptions:receive");
/** Short-lived authority for one firing's privacy-reviewed Answer endpoint. */
export const SCOPE_SUBSCRIPTIONS_ANSWER: Scope = Scope("subscriptions:answer");
/**
 * Authority to report what one firing's woken workflow did.
 *
 * Separate from the Answer scope because it authorizes the opposite direction:
 * an inbound account of a run, carrying no corpus content out. It therefore
 * outlives the Answer authority — a workflow whose answer was held for approval
 * finishes hours later, and a report that cannot be filed is the silence this
 * exists to end.
 */
export const SCOPE_SUBSCRIPTIONS_OUTCOME: Scope = Scope("subscriptions:outcome");
export const SCOPE_WRITE_ALL: Scope = Scope("write:*");
/** Build a per-source-type write scope, e.g. write:apple-health */
export function writeScope(type: SourceType): Scope {
  return Scope(`write:${type}`);
}

/** Validate that a string is a well-formed scope. Does not check authorization. */
export function isValidScope(s: string): boolean {
  if (
    s === "read" ||
    s === "read:bulk" ||
    s === "answer" ||
    s === "admin" ||
    s === "push:claim" ||
    s === "subscriptions:manage" ||
    s === "subscriptions:receive" ||
    s === "subscriptions:answer" ||
    s === "subscriptions:outcome" ||
    s === "write:*" ||
    // The two spellings of a retired automation feature. Still parsed, never
    // offered: a token minted with one is still a token, and refusing to
    // construct it would lock its holder out rather than deny it the thing it
    // named. `classifyScope` answers what it grants, which is nothing.
    s === "read:triggers" ||
    s === "admin:triggers"
  ) {
    return true;
  }
  if (s.startsWith("write:")) {
    const type = s.slice("write:".length);
    // Non-empty, no colon, no whitespace, not "*" (that's write:*).
    // Reject `write:triggers` explicitly: it was the first spelling of a scope
    // that is now retired, and letting it through here would read it as a
    // per-source-type write scope for a source called "triggers".
    return (
      type.length > 0 &&
      !type.includes(":") &&
      !/\s/.test(type) &&
      type !== "*" &&
      type !== "triggers"
    );
  }
  return false;
}

/** Parse a scope string, returning null if malformed. */
export function parseScope(s: string): Scope | null {
  return isValidScope(s) ? Scope(s) : null;
}

/**
 * The source types each device kind hosts itself and pushes to the gateway,
 * rather than having the desktop collector sync on its behalf.
 *
 * This is the single source of truth for which `write:<source-type>` scopes a
 * paired device of each kind needs. `defaultScopesForDeviceKind` derives the
 * pairing grant from it, and the gateway re-derives the same set on every
 * device handshake so a device paired before a source shipped picks up the new
 * scope without re-pairing (`reconcileDeviceTokenScopes`).
 *
 * Keeping it in one place matters because the failure it prevents is silent:
 * a phone that lacks `write:<type>` for one source gets a 403 on that source's
 * batches, and the entire push queue behind them stalls.
 *
 * A kind absent from a list hosts nothing — the desktop collector (granted
 * `read` + `write:*`) and the read-only clients (`cli`, `portal`) push no
 * source of their own.
 */
export const DEVICE_HOSTED_SOURCE_TYPES: Readonly<Record<DeviceKind, readonly SourceType[]>> = {
  // Syncs every source on the operator's behalf — granted `read` + `write:*` instead.
  collector: [],
  cli: [],
  portal: [],
  ios: [
    // HealthKit metrics + workouts, pushed to /analytics/ingest.
    SourceType("apple-health"),
    // CMMotionActivityManager's passive motion log, merged into segments.
    SourceType("activity-segments"),
    // On-device photo library: OCR + analysis summaries only, never bytes.
    SourceType("photos"),
    // CLVisit arrivals/departures, reverse-geocoded on-device.
    SourceType("core-location-visits"),
  ],
  android: [
    // Health Connect — the Android analogue of Apple Health.
    SourceType("health-connect"),
    SourceType("android-call-log"),
    SourceType("android-app-usage"),
    SourceType("android-activity-segments"),
    SourceType("photos"),
  ],
  // Receives subscription wakes; contributes conversations through a
  // separate least-privilege ingestion credential, not its device token.
  agent: [],
  // The extension's device kind is the physical client; the source it
  // captures into is the unified `web` source (#895).
  browser: [SourceType("web")],
  // Asks questions; hosts no source of its own.
  integration: [],
};

/**
 * Kinds that contribute sources — a collector, or a kind that pushes at
 * least one source type itself. The other kinds (cli, portal, agent) act on
 * sources as operators and never sync one.
 */
export const SOURCE_HOSTING_DEVICE_KINDS: readonly DeviceKind[] = DEVICE_KINDS.filter(
  (kind) => kind === "collector" || DEVICE_HOSTED_SOURCE_TYPES[kind].length > 0,
);

/**
 * The scopes a freshly paired device of this kind is granted.
 *
 * Phone clients also carry `admin` + `read` because they are full interactive
 * clients over the corpus. The browser extension deliberately gets neither —
 * it can only contribute captures, never query.
 */
export function defaultScopesForDeviceKind(kind: DeviceKind): Scope[] {
  const hosted = DEVICE_HOSTED_SOURCE_TYPES[kind].map(writeScope);
  switch (kind) {
    case "collector":
      // `write:*` for the documents it pushes; `read` for `GET /config`, which
      // it fetches at startup and on every config change.
      return [SCOPE_READ, SCOPE_WRITE_ALL];
    case "cli":
      // A paired CLI is a full interactive client over the corpus, like the
      // phones and the portal: `status`, `search` and `answer` are the whole
      // reason a client-only install exists. `admin` does NOT imply `read` --
      // scopeSatisfies grants `read` only for `read` or `read:bulk` -- so
      // without this the CLI takes a 403 on every read route it is meant to
      // use. Found by forge I23: a paired cli device reported
      // "synced 0 notes" for a corpus of three documents.
      return [SCOPE_ADMIN, SCOPE_READ];
    case "portal":
      return [SCOPE_ADMIN, SCOPE_READ];
    case "ios":
    case "android":
      return [SCOPE_ADMIN, SCOPE_READ, SCOPE_PUSH_CLAIM, ...hosted];
    case "agent":
      return [SCOPE_SUBSCRIPTIONS_RECEIVE];
    case "browser":
      // Minimal trust: contribute only. Never `read` or `admin`.
      return hosted;
    case "integration":
      // Asks through the access level it is put on; reads nothing else.
      return [SCOPE_ANSWER];
  }
  const _exhaustive: never = kind;
  throw new Error(`unhandled device kind: ${_exhaustive}`);
}

/**
 * The `write:<source-type>` scopes this device kind should hold that `granted`
 * is missing, in declaration order. Empty when nothing is missing.
 *
 * A `write:*` holder is already covered for every source type, so it never has
 * anything missing. Callers use this both to decide whether a persisted repair
 * is needed at all and to perform it, so the two can't disagree.
 */
export function missingHostedWriteScopes(granted: readonly Scope[], kind: DeviceKind): Scope[] {
  const held = new Set(granted);
  if (held.has(SCOPE_WRITE_ALL)) return [];
  return DEVICE_HOSTED_SOURCE_TYPES[kind].map(writeScope).filter((s) => !held.has(s));
}

/** Classification of a scope for permission checks. */
export type ScopeClass =
  | { kind: "read" }
  | { kind: "read-bulk" }
  | { kind: "answer" }
  | { kind: "admin" }
  | { kind: "push-claim" }
  | { kind: "subscriptions-manage" }
  | { kind: "subscriptions-receive" }
  | { kind: "subscriptions-answer" }
  | { kind: "subscriptions-outcome" }
  | { kind: "write-all" }
  | { kind: "write"; sourceType: SourceType }
  /**
   * A scope from the retired automation feature.
   *
   * Classified, never minted. Tokens an operator issued before it was removed
   * still carry these strings, and a token whose scopes cannot be classified
   * is a token nothing can describe — so the operator could see it in a list
   * but not understand what they were revoking.
   */
  | { kind: "retired-automation" };

export function classifyScope(scope: Scope): ScopeClass | null {
  if (scope === "read") return { kind: "read" };
  if (scope === "read:bulk") return { kind: "read-bulk" };
  if (scope === "answer") return { kind: "answer" };
  if (scope === "admin") return { kind: "admin" };
  if (scope === "push:claim") return { kind: "push-claim" };
  if (scope === "subscriptions:manage") return { kind: "subscriptions-manage" };
  if (scope === "subscriptions:receive") return { kind: "subscriptions-receive" };
  if (scope === "subscriptions:answer") return { kind: "subscriptions-answer" };
  if (scope === "subscriptions:outcome") return { kind: "subscriptions-outcome" };
  if (scope === "write:*") return { kind: "write-all" };
  if (scope === "read:triggers" || scope === "admin:triggers") {
    return { kind: "retired-automation" };
  }
  if (scope.startsWith("write:")) {
    return { kind: "write", sourceType: scope.slice("write:".length) as SourceType };
  }
  return null;
}

/**
 * Whether a scope reaches the corpus, if at all, only through `/answer`.
 *
 * An access level narrows what an integration's `/answer` requests may read.
 * It is a boundary only while the integration holds nothing that reads another
 * way:
 * `answer` itself, `push:claim` (its own notifications) and `write:*` (pushing
 * data in) are bounded; `admin`, `read` and `read:bulk` read directly, and the
 * subscription scopes lead to firing answers the level does not govern.
 */
export function isAnswerBoundedScope(scope: Scope): boolean {
  const kind = classifyScope(scope)?.kind;
  return kind === "answer" || kind === "push-claim" || kind === "write" || kind === "write-all";
}

/** Whether every scope in a grant is {@link isAnswerBoundedScope}. */
export function scopesAreAnswerBounded(scopes: readonly Scope[]): boolean {
  return scopes.every(isAnswerBoundedScope);
}

/**
 * Whether a device of `kind` may hold a token with `scopes`. An integration
 * holds only answer-bounded scopes, whatever mints the token — pairing, an
 * extra token, a repair — so its access level is the whole of what it can
 * read. The other kinds' grants are not restricted here.
 */
export function scopesAllowedForDeviceKind(kind: DeviceKind, scopes: readonly Scope[]): boolean {
  return kind !== "integration" || scopesAreAnswerBounded(scopes);
}

/**
 * Does a set of granted scopes satisfy a required scope?
 *
 * Rules:
 *   - "read"                 — granted if "read" or "read:bulk" is present
 *   - "read:bulk"            — granted only if "read:bulk" is present (guards
 *                              additionally accept "admin"; see scope.readBulk)
 *   - "answer"               — granted if "answer" or "admin" is present
 *   - "admin"                — granted if "admin" is present
 *   - "write:<t>"            — granted if "write:*" or "write:<t>" is present
 *   - "write:*"              — granted only if "write:*" is present
 */
export function scopeSatisfies(
  granted: ReadonlySet<Scope> | readonly Scope[],
  required: Scope,
): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  if (set.has(required)) return true;
  const req = classifyScope(required);
  if (!req) return false;
  if (req.kind === "write") return set.has(SCOPE_WRITE_ALL);
  // A bulk-read token is a superset of ordinary read.
  if (req.kind === "read") return set.has(SCOPE_READ_BULK);
  if (req.kind === "answer") return set.has(SCOPE_ADMIN);
  if (req.kind === "subscriptions-manage") return set.has(SCOPE_ADMIN);
  if (req.kind === "subscriptions-receive") return set.has(SCOPE_ADMIN);
  if (req.kind === "subscriptions-answer") return false;
  if (req.kind === "push-claim") return false;
  // A scope from the retired automation feature satisfies nothing: there is
  // no route left that asks for it.
  if (req.kind === "retired-automation") return false;
  return false;
}

/**
 * How several devices may serve one source. `exclusive` — one host, a
 * second add is refused; `handoff` — any member may sync, one at a time,
 * over one shared cursor; `replicated` — every member syncs its own replica
 * on its own cursor and documents converge on cross-device-stable external
 * ids; `partitioned` — each member contributes a disjoint stream. The gateway
 * owns its `stream_id`; providers keep external ids local-upstream-native and
 * do not embed a device or stream key in them.
 */
export const MULTI_DEVICE_MODES = ["exclusive", "handoff", "replicated", "partitioned"] as const;
export type MultiDeviceMode = (typeof MULTI_DEVICE_MODES)[number];

export function isMultiDeviceMode(s: string): s is MultiDeviceMode {
  return (MULTI_DEVICE_MODES as readonly string[]).includes(s);
}

/** Modes whose members each keep their own `sync_state` row rather than the shared one. */
export function hasPerDeviceCursor(mode: MultiDeviceMode): boolean {
  return mode === "replicated" || mode === "partitioned";
}

/**
 * Declared capabilities of a device. Sent in the `hello` message when
 * the device connects to the gateway. Used by admin clients to know
 * what a device can do (which sources it can host, etc.).
 */
export interface DeviceCapability {
  /** Supported source sync wire revisions; absent on legacy collectors. */
  sourceContract?: { min: number; max: number };
  /** Source types this device can host. */
  hostableSourceTypes?: SourceType[];
  /** Hostable source types whose data is pushed by an external runtime. */
  pushBasedSourceTypes?: SourceType[];
  /**
   * The multi-device mode of each source type this device's descriptors
   * declare, omitting the `exclusive` default. Announced at connect so the
   * gateway can apply a type's membership rules without a live descriptor
   * round-trip.
   */
  multiDeviceModes?: Record<string, MultiDeviceMode>;
  /** Shared-row version contract advertised by source descriptors. */
  replicaVersionPolicies?: Record<string, "source-updated-at">;
  /** Member-scoped parameter names understood for each hostable source type. */
  memberScopedParams?: Record<string, string[]>;
  /**
   * The device claims the sync lease before it syncs a handoff or replicated
   * source, so the gateway may hold its pages to the lease: a handoff page
   * from a device that does not hold the lease is refused. A replicated
   * member may still contribute ordinary rows, but its snapshot reconcile is
   * deferred and a page carrying explicit tombstones is retained for replay.
   * A device that does not announce this keeps syncing ungated.
   */
  syncLease?: boolean;
  /** Accepts correlated collector-local health-check commands. */
  deviceDoctor?: true;
  /** First-party external-agent integration delivery contract. */
  agentIntegration?: {
    harness: "openclaw" | "hermes";
    deliveryProtocolMin: number;
    deliveryProtocolMax: number;
    maxConcurrentRuns: number;
    /** Understands privacy-policy decisions on Watch creation and revision. */
    watchPrivacyPolicyVersion?: 1;
  };
  /** Device hostname, for display. */
  hostname?: string;
  /** Platform: "macos" | "linux" | "ios" | "web" | ... */
  platform?: string;
  /** Application identity used to select this phone's push transport. */
  pushAppId?: string;
  /** BCP 47 locale captured from the operating system. */
  locale?: string;
  /** ISO 3166-1 alpha-2 default region for national-format phone numbers. */
  phoneRegion?: string;
  /** Device software version. */
  version?: string;
  /** Exact completed source commit this running daemon started from. */
  sourceCommit?: string;
  /**
   * Name the device wants to be called when it has no admin-supplied name.
   * Only consulted at pair time (`POST /devices/pair`) when the pairing code
   * was issued without one. Falls back to a `<kind>-<short-id>` default if
   * neither is present.
   */
  suggestedName?: string;
  /**
   * Stable per-install identity the client mints once and persists (Keychain
   * on iOS, encrypted preferences on Android, browser storage for the portal
   * and the extension, the config dir for the CLI). At pair time the gateway adopts the existing
   * device row carrying the same `(kind, installId)`, so a re-pair keeps the
   * device's id — and everything keyed by it — no matter what the row has
   * been renamed to.
   */
  installId?: string;
  /**
   * The device id this client was last paired as, when it knows one. Consulted
   * when no row carries the client's `installId` yet, so a row paired without
   * an install identity is adopted — and stamped with one — on re-pair.
   */
  previousDeviceId?: string;
}

/**
 * APNs (Apple Push Notification service) registration for an iOS
 * device. Set through unified push registration whenever iOS rotates the
 * device token. Used to send the fixed carrier wake to paired iOS devices.
 */
export interface ApnsRegistration {
  /** Hex device token as APNs expects. Validated as 64-char hex at the boundary. */
  deviceToken: string;
  /** "sandbox" for debug builds, "production" for TestFlight / App Store. */
  environment: "sandbox" | "production";
  /** App bundle identifier (e.g. `dev.omnesis.ios`). Sent as the APNs `apns-topic`. */
  bundleId: string;
  /** When the iOS app last registered/refreshed this token (unix ms). */
  updatedAt: number;
}

/** Firebase Cloud Messaging registration for an Android device. */
export interface FcmRegistration {
  /** Opaque registration token issued by Firebase Messaging. */
  registrationToken: string;
  /** When the Android app last registered/refreshed this token (unix ms). */
  updatedAt: number;
}

/** A phone owner's device-scoped authorization to use the content-blind relay. */
export interface PushRelayConsent {
  /** Published application identity the disclosure and authorization cover. */
  appId: string;
  /** When the phone recorded the authorization with the gateway (unix ms). */
  grantedAt: number;
}

/** The wake transport selected independently for each paired device. */
export const PUSH_TRANSPORTS = ["direct-apns", "direct-fcm", "relay", "socket"] as const;
export type PushTransport = (typeof PUSH_TRANSPORTS)[number];

export function isPushTransport(value: string): value is PushTransport {
  return (PUSH_TRANSPORTS as readonly string[]).includes(value);
}

/** Phone-reported OS state that determines whether a push becomes a visible alert. */
export const NOTIFICATION_DELIVERY_HEALTH_STATES = [
  "healthy",
  "not-determined",
  "permission-denied",
  "scheduled-summary",
  "alerts-disabled",
] as const;
export type NotificationDeliveryHealth = (typeof NOTIFICATION_DELIVERY_HEALTH_STATES)[number];

export function isNotificationDeliveryHealth(value: string): value is NotificationDeliveryHealth {
  return (NOTIFICATION_DELIVERY_HEALTH_STATES as readonly string[]).includes(value);
}

/** Record representing a device row. Dates serialized as numbers (unix ms). */
export interface DeviceRecord {
  id: DeviceId;
  name: string;
  kind: DeviceKind;
  capabilities: DeviceCapability;
  /**
   * The lockstep product version the client last reported, or null when it
   * never has. Hoisted out of `capabilities` into a column of its own so the
   * version ledger can order and query it. A client built before the ledger
   * reports nothing and stays null — which is a supported state, not a fault:
   * the hello never rejects a device for omitting its version.
   */
  version: string | null;
  /** When the gateway last recorded `version` (unix ms), or null if never. */
  versionSeenAt: number | null;
  /**
   * The device-socket protocol number of this device's last completed
   * handshake, or null for a device that has never opened one (the browser
   * extension pairs and pushes over HTTP). A number below the gateway's own
   * protocol means the device can no longer connect at all.
   */
  protocolVersion: number | null;
  pairedAt: number;
  lastSeenAt: number | null;
  /**
   * When the device was revoked (unix ms), or null while paired. A
   * revoked device keeps its row — the id is a durable identity that
   * per-device cursors and stream keys hang off — with its tokens and
   * push registrations invalidated. Its sources and memberships stay
   * attached and go dormant. Pairing again under the same name adopts
   * the row and clears this.
   */
  revokedAt: number | null;
  /**
   * The client's per-install identity (see `DeviceCapability.installId`), or
   * null for a device paired by a client that has none. The pair-time
   * adoption key; the name is display only.
   */
  installId: string | null;
  /**
   * Operator-supplied identifiers belonging to *the human owning this
   * device*. Distinct from `capabilities` (which describe the
   * software-side identity). Used to bootstrap the canonical self
   * person on a fresh install before a contacts source has synced —
   * sources running on this device that emit `isSelf: true` mentions
   * resolve cleanly even on day one. Set via `omnesis devices set-self`.
   *
   * Phones must be E.164 (validated via `normalizePhone` at the HTTP /
   * CLI boundary). Emails are lowercased / `normalizeEmail`-d at the
   * boundary too. Empty arrays mean "not annotated".
   */
  selfEmails: string[];
  selfPhones: string[];
  /**
   * Access level whose Answer rule applies to what this device asks over
   * `POST /answer` — the sources the answer may draw on, whether it is
   * reviewed, and the privacy policy that reviews it — or null for every
   * source under the default privacy policy. Set from a portal session with
   * `PUT /admin/access/devices/:id/level`.
   */
  accessLevelId: string | null;
  /**
   * iOS-only. Present once the Omnesis iOS app has registered for
   * remote notifications and POSTed its device token. Null on every
   * non-iOS device kind and on iOS devices that haven't completed APNs
   * registration yet (notification permission denied, no network at
   * launch, etc.).
   */
  apnsRegistration: ApnsRegistration | null;
  /**
   * Android-only. Present once the app has registered its Firebase
   * Messaging token with the gateway. Null for other device kinds and for
   * Android devices that have not completed push registration.
   */
  fcmRegistration: FcmRegistration | null;
  /** Persisted transport choice; null until the device completes push registration. */
  pushTransport: PushTransport | null;
  /** Relay selected by the app build, or null for direct/socket transports. */
  relayUrl: string | null;
  /** Device-token-scoped relay credential, or null for direct/socket transports. */
  relayCredential: string | null;
  /** Per-device, app-bound relay authorization; absent from older HTTP responses. */
  relayConsent?: PushRelayConsent | null;
  /** Last OS-level visible-delivery state reported by the phone, or null before first report. */
  notificationDeliveryHealth?: NotificationDeliveryHealth | null;
  /** Gateway receipt time for notificationDeliveryHealth (unix ms). */
  notificationDeliveryHealthUpdatedAt?: number | null;
  /**
   * The internal release or exact-commit target an operator asked this device
   * to update itself to, or null when nothing is owed. It is cleared once the
   * device reports back on that target, so a non-null value means an update is outstanding
   * — including for a device that was offline when the operator asked, which
   * takes the command on its next connection.
   */
  desiredVersion: string | null;
  /** How far that request has got, or null if none was ever made. */
  updateState: DeviceUpdateState | null;
  /** One line about the current state: a failure, or a restart still owed. */
  updateDetail: string | null;
  /** When `updateState` last changed (unix ms). */
  updateStateAt: number | null;
}

/**
 * Where a commanded self-update stands, from the gateway's point of view.
 *
 * - `pending` — recorded, not yet delivered. The device is offline; the
 *   command goes out when it reconnects.
 * - `dispatched` — the device acknowledged the command and is updating.
 * - `installed` — the device reported the new build in place and is
 *   restarting onto it; its reconnection on that build closes the request.
 * - `restart-pending` — installed, but the device could not restart onto it
 *   (an agent harness whose restart did not start), so the operator must.
 * - `failed` — the device refused the command or its update did not finish.
 * - `unsupported` — the build the device runs does not implement the command,
 *   so it can only be updated on its own machine. The gateway does not ask it
 *   again until it reports a different version.
 */
export const DEVICE_UPDATE_STATES = [
  "pending",
  "dispatched",
  "installed",
  "restart-pending",
  "failed",
  "unsupported",
] as const;
export type DeviceUpdateState = (typeof DEVICE_UPDATE_STATES)[number];

export function isDeviceUpdateState(value: string): value is DeviceUpdateState {
  return (DEVICE_UPDATE_STATES as readonly string[]).includes(value);
}

/** Record representing a token row (minus the secret). */
export interface TokenRecord {
  id: TokenId;
  deviceId: DeviceId;
  scopes: Scope[];
  name: string | null;
  createdAt: number;
  revokedAt: number | null;
}
