// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Declarative descriptor for a data source.
 * Provider packages export these so the CLI can drive add/auth flows
 * without knowing source internals.
 */

import {
  type ProviderCredentialsSpec,
  type SerializedProviderCredentialsSpec,
  serializeCredentialsSpec,
} from "@omnesis/core";
import type { AccountId, SourceType, ProviderType } from "@omnesis/types";
import type { AuthResult, AuthSession } from "./auth-session.js";
import type { AccountDescriptor } from "./account-descriptor.js";
import type { ExecutionMode } from "./execution-mode.js";
import type {
  AnalyticsTableSchema,
  DocumentEventProfile,
  DocumentTemporalProjectionSpec,
} from "./structured-source.js";
import type { SourceIcon, SourceAttribution, HistoryImportSpec } from "./source.js";

/**
 * Callbacks for streaming auth flow events to a remote CLI.
 * When provided, the auth flow sends events through these callbacks
 * instead of printing directly to the console.
 */
export interface AuthFlowCallbacks {
  /** Called with the OAuth authorization URL the user must open. */
  onAuthUrl?: (url: string) => void;
  /** Called with QR code data (for WhatsApp-style pairing). */
  onQrCode?: (qr: string) => void;
  /**
   * Harness-provided code-delivery channel. Resolves with a DECODED,
   * single-use authorization code delivered out-of-band — via the
   * gateway's `/oauth/callback` redirect, `POST /admin/auth-flows/:id/code`,
   * or a manual CLI paste. Every transport guarantees the code is already
   * percent-decoded; the provider uses it verbatim in the token exchange.
   * Rejects when the flow times out or is cancelled before a code arrives.
   * Providers that run their own localhost callback listener can ignore it.
   */
  receiveCode?: () => Promise<string>;
  /**
   * Gateway-assigned flow id. Embed as the `state=` parameter in authorize
   * URLs so the gateway's `/oauth/callback` can route the redirect back to
   * this flow (and from there to `receiveCode`). Unset when the auth flow
   * runs without a gateway-orchestrated flow (e.g. direct CLI invocation).
   */
  flowId?: string;
  /**
   * Set when the flow is a re-auth of an existing account (portal
   * Reauthenticate banner, `cli reauth`). Providers may use it to reuse
   * stored per-account parameters instead of requiring them again. Unset
   * on first-time add flows.
   */
  accountId?: string;
  /**
   * Fields the user pasted for a `perAccount` credentials spec (see
   * `ProviderCredentialsSpec.perAccount`). Delivered over the auth
   * subprocess's private stdin pipe — never argv, which is world-readable via
   * `/proc/<pid>/cmdline`, and never the environment. Already validated and
   * trimmed against the spec's declared fields by the collector.
   *
   * The provider probes with these, derives the account id, and only then
   * persists them under that account. Unset for every provider whose
   * credential is shared across accounts, and for a re-auth that reuses a
   * stored credential.
   */
  credentials?: Record<string, string>;
  /**
   * The gateway's externally-reachable HTTPS base URL (scheme + host +
   * optional port, no trailing slash) when the operator configured
   * `gateway.publicBaseUrl`. An OAuth or aggregator provider builds its
   * redirect URI as `${publicBaseUrl}/oauth/callback` — the gateway already
   * hosts that public route and routes the redirect back to this flow by
   * `flowId` — so the bank-side OAuth redirect works even though the
   * collector is outbound-only / NAT'd. Aggregators that require a
   * pre-registered redirect URI (Plaid, SnapTrade, …) register this exact
   * value. Unset → the provider falls back to its local-only callback
   * (e.g. `http://localhost:3003/...`), which only works on the same
   * machine.
   */
  publicBaseUrl?: string;
  /**
   * Hand the client a hosted-widget configuration to render (auth type
   * `link-widget`). `kind` is an opaque, source-declared widget identifier
   * (e.g. `"snaptrade-connect"`); `payload` carries the string fields the widget
   * needs (e.g. a short-lived `link_token`). The client renders the widget
   * generically from `kind` + `payload` — it never hardcodes a source name.
   * The next aggregator (SnapTrade Connect, Yodlee FastLink, …) reuses this
   * channel with its own `kind`.
   */
  onWidgetConfig?: (config: { kind: string; payload: Record<string, string> }) => void;
  /**
   * Harness-provided result channel for a hosted-widget flow (auth type
   * `link-widget`). Resolves with the opaque result token the widget yields
   * (e.g. a Plaid `public_token`) plus optional metadata (selected
   * institution / accounts). Results queue in arrival order; a provider whose
   * widget yields several per session calls this once per result. Rejects
   * when the flow times out or is cancelled before a result arrives.
   */
  receiveWidgetResult?: () => Promise<{ token: string; metadata?: Record<string, unknown> }>;
}

/** Context threaded through source lifecycle hooks that run outside `create()`. */
/**
 * One account a source found, with its id already branded.
 *
 * The brand is applied at the collector boundary, which is the seam where an
 * id stops being an unconstrained string and becomes something that will name
 * a directory.
 */
export type DiscoveredAccount = AccountDescriptor & { id: AccountId };

export interface SourceLifecycleContext {
  /**
   * Absolute path to the collector's resolved config directory. Providers
   * should use this for discover/auth/cleanup filesystem IO instead of
   * re-deriving `DEFAULT_CONFIG_DIR`, so isolated test instances and parallel
   * worktrees do not touch the operator's live credentials.
   */
  configDir?: string;
}

/**
 * A parameter the user must supply when adding a source.
 * E.g. vault path for Obsidian, or account selection for Google.
 */
export interface SourceParam {
  /** Machine key used in config (e.g. "vaultPath") */
  name: string;
  /** Human-readable label shown in CLI/UI (e.g. "Vault path") */
  label: string;
  /**
   * Parameter type.
   *
   * `secret` is a rendering instruction as much as a type: a client masks the
   * input and never echoes it. Collapsing it into `string` is how a pasted
   * token comes to be typed into a visible box and printed in a terminal.
   */
  type: "string" | "path" | "select" | "secret";
  /**
   * Where the configured value belongs. Source-scoped values are shared by
   * every member; member-scoped values describe one host's local environment.
   * Omitted means `"source"` for compatibility with existing descriptors.
   */
  scope?: "source" | "member";
  /** Whether this parameter is required */
  required?: boolean;
  /** Placeholder/hint shown in input */
  placeholder?: string;
  /**
   * A serialisable shape check a client applies before submitting.
   *
   * It describes the form of the value, not the value, so it is safe to carry
   * for a secret — and carrying it is what lets a client say "that is not a
   * token from this platform" instead of making the operator wait for a probe
   * to say the same thing more slowly.
   */
  pattern?: string;
  /** What to say when {@link pattern} does not match. */
  patternHint?: string;
  /**
   * One line explaining the setting, shown beside the input.
   *
   * The place to say what a blank value means, which for an optional setting
   * is the question an operator actually has. A label alone can only say what
   * the field is called.
   */
  help?: string;
  /** For "select" type: available options */
  options?: Array<{ value: string; label: string }>;
  /** Validation function — returns error message or null if valid */
  validate?: (value: string) => string | null;
  /** Run server-side validation even when the optional field is blank (for auto-detected defaults). */
  validateWhenEmpty?: boolean;
  /**
   * The fixed account ID for which a non-empty value that passes `validate`
   * proves this source is available on the member, even when parameterless
   * discovery does not find it. Use only for member-scoped paths whose
   * validator checks the actual local store.
   */
  provesLocalAvailabilityForAccount?: string;
}

/**
 * Information about the provider/platform a source belongs to.
 */
export interface ProviderInfo {
  /** Provider type (e.g. "google", "apple", "obsidian") */
  id: ProviderType;
  /** Human-readable name (e.g. "Google", "Apple", "Obsidian") */
  name: string;
}

/**
 * Auth type for a source.
 * - "oauth": Browser-based OAuth flow (Google)
 * - "qr": QR code pairing (WhatsApp)
 * - "api-key": A pasted API key / personal access token IS the per-account
 *   credential — no browser leg. The credentials wizard collects the key
 *   (stored at `<fileKey>-credentials.json`), then `authFlow()` validates it
 *   against a liveness probe and returns the derived account id (Granola).
 * - "link-widget": A hosted, client-rendered widget (Plaid Link, SnapTrade
 *   Connect, Yodlee FastLink, …) performs the credential exchange. The
 *   provider has no pasted secret as the per-account credential and no
 *   provider-rendered authorize URL: it mints a widget config server-side
 *   (`AuthFlowCallbacks.onWidgetConfig`), the client renders the widget
 *   generically from a `{ kind, payload }` shape, and the provider receives
 *   an opaque result token + metadata back (`receiveWidgetResult`). The
 *   operator's *app* credential (client id + secret) is still a
 *   `ProviderCredentialsSpec`; `link-widget` describes the add flow, not the
 *   app-credential config. A widget that registers several accounts in one
 *   session resolves `AccountId[]` from `authFlow`.
 *   No in-tree source uses this: an aggregator whose vendor serves the
 *   sign-in page itself needs no embedding, and therefore no CSP relaxation.
 *   The contract exists for one whose vendor only ships an embeddable widget.
 * - "local": No auth needed, reads local files (Apple, Things, Chrome, Obsidian)
 */
export type AuthType = "oauth" | "qr" | "api-key" | "link-widget" | "local";

/**
 * External widget-vendor origins a source's hosted `link-widget` needs the
 * browser to reach. A `link-widget` source (Plaid Link, SnapTrade Connect,
 * Yodlee FastLink, …) loads its vendor's SDK from the vendor's CDN and opens a
 * vendor-hosted iframe — neither can be self-hosted/vendored the way the
 * portal's own assets are. The portal serves a deliberately strict, zero-
 * external-load Content-Security-Policy, so without an explicit allow-list the
 * vendor SDK and iframe are blocked and the widget can never open in the
 * browser.
 *
 * Each declared origin maps to a CSP fetch directive:
 *   - `script`  → `script-src`  — where the vendor SDK `<script src>` loads from.
 *   - `frame`   → `frame-src`   — origins the widget renders an `<iframe>` from.
 *   - `connect` → `connect-src` — origins the widget's XHR/fetch/WebSocket reach.
 *
 * Values are full CSP source expressions (scheme + host, optionally a leading
 * `*.` wildcard label), e.g. `"https://cdn.plaid.com"` or `"https://*.plaid.com"`.
 * The gateway aggregates the union across every registered source descriptor
 * into the portal CSP, generically — no source name is hardcoded downstream.
 * Omitting a directive (or the whole field) widens nothing.
 */
export interface WidgetOrigins {
  /** Origins added to the portal CSP `script-src` (the vendor SDK `<script src>`). */
  script?: string[];
  /** Origins added to the portal CSP `frame-src` (the vendor-hosted widget `<iframe>`). */
  frame?: string[];
  /** Origins added to the portal CSP `connect-src` (the widget's XHR/fetch/WebSocket). */
  connect?: string[];
}

/**
 * Provider-owned browser module that renders a hosted `link-widget` kind.
 *
 * Shared clients receive only an opaque `{ kind, payload }` auth-flow event.
 * A source/provider that introduces a widget vendor declares the module that
 * knows that vendor's SDK URL, global API, payload shape, callbacks, and
 * teardown semantics. The collector registers the union with the gateway, and
 * the portal dynamically imports the gateway-served module by `kind`.
 *
 * `modulePath` is an absolute filesystem path to an ES module owned by the
 * provider package. The module exports `open({ payload, onResult, onExit,
 * onError })`, returning an optional cleanup function.
 */
export interface WidgetRendererSpec {
  /** Opaque widget kind emitted by `AuthFlowCallbacks.onWidgetConfig`. */
  kind: string;
  /** Absolute path to the provider-owned browser ES module for this widget. */
  modulePath: string;
}

export type SourceMultiDeviceContract =
  | {
      mode: "exclusive" | "handoff" | "partitioned";
      replicaVersionPolicy?: never;
    }
  | {
      mode: "replicated";
      /**
       * Shared-row conflict contract for replicas whose `sourceUpdatedAt` is
       * monotone and canonical UTC ISO 8601. Omit when the provider's own
       * convergence contract does not use a monotone record timestamp.
       */
      replicaVersionPolicy?: "source-updated-at";
    };

/**
 * Operating systems a source can run on. Subset of NodeJS.Platform —
 * the three desktop OSes the Node-based collector runs on. Sources that
 * read OS-specific local databases (Apple Notes, Things, Screen Time)
 * declare the narrower set; cross-platform sources omit the field. iOS
 * push-based sources (Apple Health) are advertised by the iOS app and
 * not subject to this gating.
 */
export type SourcePlatform = "darwin" | "linux" | "win32";

/**
 * Self-identity hook — declares how a source's per-account identifier maps
 * to a stable LID alias the source's own normalizer attaches to documents
 * that represent the user themselves (a Strava athlete profile, an Apple
 * Health account).
 *
 * The gateway's self-detection pass (`detectSelfFromSourceIds`) pairs every
 * synced source account against the matching declared spec so the LID the
 * source emits on its self-authored PersonMentions resolves to the canonical
 * self person — instead of branching on a hardcoded source name. This keeps
 * the "what is this source's self LID shape" knowledge inside the source
 * package; the collector pushes the union of declared specs to the gateway on
 * boot (mirrors `urlHub`), and the gateway reads them generically.
 *
 * Example (Strava): `{ aliasPrefix: "strava-athlete", accountPattern: "^\\d+$" }`
 * pairs `strava-activities:43560449` → LID `strava-athlete:43560449`.
 */
export interface SelfIdentitySpec {
  /**
   * Prefix the source's normalizer prepends to the account id when emitting
   * the self LID. The gateway forms the alias as `${aliasPrefix}:${account}`,
   * where `account` is the part of the source id after the first `:`.
   */
  aliasPrefix: string;
  /**
   * Optional regex (matched with `new RegExp`) the account portion must
   * satisfy for the pairing to apply. Lets a source restrict the hook to
   * accounts shaped like its real identifier (e.g. Strava's numeric athlete
   * id) and skip placeholder / non-identity accounts. Omitted → every account
   * for this source type is paired.
   *
   * A capture group names the identity *within* the account id, for sources
   * whose account id carries more than the identity. GitHub's second
   * credential for the same user — scoped to an organization — is a distinct
   * account (`login@org`) whose documents still carry the plain `github:login`
   * LID, so it declares `^([^@]+)` and the gateway pairs on the captured
   * login. Without a group the whole account is used, as before.
   */
  accountPattern?: string;
}

/**
 * Declarative descriptor for a data source.
 * Each provider package exports one or more of these.
 */
export interface SourceDescriptor {
  /** Source ID — matches the source base ID (e.g. "gmail", "obsidian-notes", "apple-notes") */
  id: SourceType;
  /** Human-readable name (e.g. "Gmail", "Obsidian Notes", "Apple Notes") */
  name: string;
  /** Short description for CLI/UI */
  description: string;
  /** Provider this source belongs to */
  provider: ProviderInfo;
  /** Auth mechanism needed */
  authType: AuthType;
  /**
   * The source's `authFlow` consumes externally delivered authorization
   * codes via `callbacks.receiveCode`. Gates the CLI / portal paste-code
   * affordances — see `SourceDefinition.acceptsAuthCode`.
   */
  acceptsAuthCode?: boolean;
  /**
   * Experimental / not-yet-battle-tested source. The collector only advertises
   * it (and only instantiates configured instances of it) when the operator
   * opts in via `OMNESIS_EXPERIMENTAL` — see `SourceDefinition.experimental`.
   * Present on the wire so admin clients can render an "experimental" badge.
   */
  experimental?: boolean;
  /**
   * External widget-vendor origins this source's hosted `link-widget` needs the
   * browser to reach (its SDK CDN, iframe host, and API endpoints). The gateway
   * aggregates the union across every registered descriptor into the portal's
   * Content-Security-Policy so the widget can load. Only meaningful for
   * `authType: "link-widget"` sources; omitted otherwise. See `WidgetOrigins`.
   */
  widgetOrigins?: WidgetOrigins;
  /**
   * Provider-owned browser renderer for this source's hosted `link-widget`.
   * Only meaningful for `authType: "link-widget"`. See `WidgetRendererSpec`.
   */
  widgetRenderer?: WidgetRendererSpec;
  /** Human-friendly name for the unit of data (e.g. "emails", "messages", "notes") */
  unitName?: string;
  /**
   * Which data plane is this source's *headline* count? A source that produces
   * both indexable documents and a secondary analytics table sets this so the
   * per-source Count uses the right plane instead of the generic heuristic's
   * pick (`logical-unit → analytics-rows → documents`).
   *
   * The motivating case is the Web Pages dataset (#40): it holds thousands of
   * `webpage` documents plus a small `page_visits` analytics log, so the
   * heuristic would surface the tiny visit count as the headline. Declaring
   * `"documents"` shows the page total instead. `"analytics"` forces the
   * analytics-row count even when a differing logical-unit total exists.
   * Omitted → the heuristic decides. Read generically by the portal/CLI count
   * column — no source name is hardcoded downstream.
   */
  primaryCount?: "documents" | "analytics";
  /**
   * This source is hosted **by the gateway itself**, not synced or pushed by a
   * collector. The unified Web Pages dataset is the case: its documents arrive
   * via the browser extension's HTTP push and no collector ever syncs it.
   *
   * Ownership of the descriptor follows the host: a gateway-hosted source is
   * advertised (in `/admin/source-descriptors`) and has its display identity
   * seeded by the **gateway**, and collectors deliberately **exclude** it from
   * the descriptors they advertise — even though they may still carry the
   * provider package in their registry. Without this, a gateway-hosted source's
   * metadata would parasitically depend on a collector being online to advertise
   * it. Read generically — no source name is hardcoded downstream.
   */
  gatewayHosted?: boolean;
  /** See `SourceDefinition.urlHub`. */
  urlHub?: boolean;
  /** See `SourceDefinition.urlTargetRole`. */
  urlTargetRole?: "fallback" | "reference";
  /**
   * Definition-level icon. Travels to the portal/CLI "Add Source" picker via
   * `serializeDescriptor()` and to the running instance via the collector's
   * `instance.icon ?? def.icon` fallback at registration time. Per-account
   * differentiation (e.g. browser-history chrome vs safari) is an opt-in
   * override exposed through `SourceInstance.icon` — most sources just set
   * this once on the definition.
   */
  icon?: SourceIcon;
  /**
   * Brand attribution requirements declared by the source package.
   * Travels through to clients (portal, iOS) which render
   * `attribution.itemFooter` near each item from this source. Per-item
   * deep links live on `DocumentMetadata.sourceUrl` and are unrelated.
   */
  attribution?: SourceAttribution;
  /** Parameters the user must supply (e.g. vault path) */
  params?: SourceParam[];

  /**
   * Every member-scoped setting this source declares, advanced ones included.
   *
   * Separate from {@link params} because those two answer different questions.
   * `params` is what a form shows, and an advanced setting is deliberately not
   * on the add form — it is an escape hatch, not a setup question. The
   * member-config contract is not about forms at all: it is the host and the
   * device agreeing on which settings belong to one machine, and a setting
   * left out of that agreement cannot be written at all.
   *
   * Folding the two together made an advanced member-scoped setting
   * unsettable: the device advertised the names its form carried, the host
   * expected the names the source declared, and the two disagreed by exactly
   * the advanced ones.
   */
  memberScopedParamNames?: string[];

  /**
   * One-time bulk-history import capability. Present when the source's
   * instance implements `importHistory`. Clients render a generic form from
   * `historyImport.fields` and POST the values to the import endpoint.
   */
  historyImport?: HistoryImportSpec;

  /** Who runs this source. See `SourceDefinition.execution`. */
  execution?: ExecutionMode;

  /**
   * @deprecated Read `execution`. Derived from it, so a consumer that has not
   * migrated keeps the answer it had.
   */
  pushBased?: boolean;

  /**
   * Analytics table schemas this source produces (for structured data sources).
   * Present when the source was registered via `defineStructuredSource()`.
   */
  analyticsSchemas?: AnalyticsTableSchema[];
  /**
   * Deterministic projections over typed document metadata fields.
   *
   * `undefined` preserves the gateway's current declaration, a non-empty
   * array creates or replaces it, and `[]` explicitly retires it.
   */
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];

  /**
   * What this source's documents can be asked about: the document types it
   * emits, the person roles it populates, and the metadata fields that carry
   * meaning. The collector publishes the declaration to the gateway, which
   * persists it for subscription compilation. See `DocumentEventProfile`.
   */
  documentEventProfile?: DocumentEventProfile;

  /**
   * Describes how reliably this source reproduces its full content on
   * each sync cycle.
   *
   * - `"complete"` (default): the source always provides the complete,
   *   authoritative content for a document. Re-extraction can safely
   *   delete-and-rebuild derived data (links, etc.) from the new content.
   *
   * - `"best-effort"`: the source may lose older content between syncs
   *   (e.g. WhatsApp's transient on-device buffer rolls over). Derived
   *   data extracted from prior versions of the document must be
   *   preserved — the gateway uses additive-only link extraction
   *   (insert new links, never delete existing ones).
   */
  contentRetention?: "complete" | "best-effort";

  /**
   * Whether this source emits conversation docs and renders audio inline
   * (transcribed into the message stream) rather than as separate
   * attachment child-docs — see `SourceDefinition.conversational`. Shared
   * code routes audio by this flag rather than branching on a source name.
   */
  conversational?: boolean;

  /**
   * Self-identity hook — how this source's account id maps to the self LID
   * alias its normalizer emits. See `SelfIdentitySpec`.
   */
  selfIdentity?: SelfIdentitySpec;

  /**
   * Whether a host admits at most one instance of this source. E.g. Apple Notes
   * reads the one local database of the logged-in user — there is no second
   * instance to add on that machine.
   *
   * The contract is about the source, not about presentation: clients read it
   * to decide whether "add another account" is meaningful, and each surfaces
   * that as it sees fit. Scope is per HOST, so a source already configured on
   * one collector is still addable on another.
   *
   * Defaults to false (multi-account capable).
   */
  singleInstance?: boolean;

  /**
   * How multiple devices may serve this source. Absent = `"exclusive"`.
   *
   * A source is one account (`<type>:<accountId>`); this declares which of
   * four contribution modes that account's data supports when more than
   * one device could serve it:
   *
   * - `"exclusive"` — one device by nature (e.g. a single linked-device
   *   slot). A second device's add is refused; moving the source is an
   *   explicit hand-over.
   * - `"handoff"` — cloud-authoritative data with an account-side cursor.
   *   Any capable device may sync, one at a time; the shared cursor is the
   *   baton. Declaring it requires provider-specific acceptance with two
   *   independently authenticated real collectors: mid-backfill takeover,
   *   portable cursors, lease fencing, and retry-safe document plus analytics
   *   writes.
   * - `"replicated"` — the same data is visible on every device (platform
   *   sync). Each device keeps a private cursor over its own replica;
   *   documents converge because external ids are cross-device stable.
   *   Declaring this obliges the source's external ids to be identical for
   *   the same item on every device and its convergence, deletion, and
   *   self-healing lifecycle to have provider-specific multi-replica
   *   acceptance coverage.
   * - `"partitioned"` — each device observes a genuinely distinct stream;
   *   the union is the truth. External ids identify items within one device's
   *   local stream and may therefore be identical across devices. The gateway
   *   owns the contributing stream key and scopes documents, analytics rows,
   *   snapshots, tombstones, and cursors to it. Declaring it requires
   *   provider-specific acceptance for independent streams, resync, and
   *   member detach.
   */
  multiDevice?: SourceMultiDeviceContract;

  /** See `SourceDefinition.supportedPlatforms`. */
  supportedPlatforms?: SourcePlatform[];

  /**
   * Suggested default sync interval for this source type (duration string,
   * e.g. "30m"). Applied to the source's config at `addSources` time so
   * rate-limited providers (Notion) can pick a safer cadence than the
   * global `defaultSyncInterval`. User can still override per-source.
   */
  defaultSyncInterval?: string;

  /**
   * OAuth credentials spec — present only on sources whose provider needs
   * the user to bring their own OAuth client (or has an overridable
   * bundled one). The CLI / portal use this to render the credentials
   * setup wizard. Mirrored across every source under the same provider.
   */
  credentials?: ProviderCredentialsSpec;

  /**
   * Run the auth/setup flow interactively.
   * Returns the account identifier (email, phone, vault name, etc.)
   * For "local" sources, this validates access and returns a fixed identifier.
   * Params correspond to the fields declared in `params` above.
   * Callbacks allow streaming auth events (URLs, QR codes, widget config) to
   * a remote CLI.
   *
   * Returns one `AccountId` for the common single-account flow, or an
   * `AccountId[]` when a single auth session registers several accounts at
   * once, each with its own per-account credential. Each
   * returned account is registered independently under the same provider.
   */
  authFlow?: (
    params?: Record<string, string>,
    callbacks?: AuthFlowCallbacks,
    ctx?: SourceLifecycleContext,
  ) => Promise<AccountId | AccountId[]>;

  /**
   * Connect an account through the typed session. See
   * `SourceDefinition.authenticate`. A descriptor carrying both is run through
   * this one.
   */
  authenticate?: (session: AuthSession) => Promise<AuthResult>;

  /**
   * Check if this source can be auto-discovered on the current system.
   * E.g. Apple Notes checks for NoteStore.sqlite existence.
   * Returns the accounts it found, or empty when it cannot run here. Each
   * carries a branded id and whatever the source knows about who the account
   * belongs to — see {@link AccountDescriptor}. A source with nothing more to
   * say returns just the id, which the collector wraps.
   */
  discover?: (ctx?: SourceLifecycleContext) => Promise<DiscoveredAccount[]>;
  /** Source-owned local identity resolution; called by the collector before add. */
  resolveAccountId?: (
    params: Record<string, string>,
    existing: readonly {
      accountId: string;
      params?: Record<string, string>;
    }[],
  ) => string | Promise<string>;

  /**
   * Clean up credentials/auth state for a specific account.
   * Called when the user runs `remove` with data deletion.
   */
  cleanupCredentials?: (accountId: AccountId, ctx?: SourceLifecycleContext) => Promise<void>;
}

/**
 * JSON-safe projection of a SourceDescriptor (functions stripped, branded types
 * widened to plain strings). Returned by gateway/collector APIs so admin
 * clients (CLI / portal / iOS) can drive add/auth flows without importing
 * provider code.
 */
export interface SerializedDescriptor {
  id: string;
  name: string;
  description: string;
  unitName?: string;
  /** See `SourceDescriptor.primaryCount`. */
  primaryCount?: "documents" | "analytics";
  /** See `SourceDescriptor.gatewayHosted`. */
  gatewayHosted?: boolean;
  /** See `SourceDescriptor.urlHub`. */
  urlHub?: boolean;
  /** See `SourceDescriptor.urlTargetRole`. */
  urlTargetRole?: "fallback" | "reference";
  provider: { id: string; name: string };
  authType: AuthType;
  /**
   * The source's `authFlow` consumes externally delivered authorization
   * codes via `receiveCode`. Admin clients (CLI / portal) offer the
   * paste-code affordance only when this is true — for any other flow a
   * pasted code would be buffered unread and strand the flow.
   */
  acceptsAuthCode: boolean;
  /**
   * Experimental / not-yet-battle-tested source. Only present in the
   * advertised set when the operator opted in via `OMNESIS_EXPERIMENTAL`;
   * admin clients render an "experimental" badge from it.
   */
  experimental: boolean;
  /**
   * External widget-vendor origins this source's `link-widget` needs. JSON-safe
   * (string arrays only), travels over the wire as-is. The gateway folds the
   * union across registered descriptors into the portal CSP. See
   * `WidgetOrigins`. Omitted when the source declares none.
   */
  widgetOrigins?: WidgetOrigins;
  /**
   * Whether this source renders audio inline (conversation) vs. as
   * attachment child-docs (document). See `SourceDescriptor.conversational`.
   */
  conversational: boolean;
  singleInstance: boolean;
  /** Multi-device contribution mode; see `SourceDescriptor.multiDevice`. */
  multiDeviceMode: "exclusive" | "handoff" | "replicated" | "partitioned";
  pushBased: boolean;
  hasAuthFlow: boolean;
  hasDiscover: boolean;
  hasResolveAccountId?: boolean;
  /** Generic import form-spec. Present when the source supports importing. */
  historyImport?: HistoryImportSpec;
  /**
   * Platforms this source supports. Omitted on the wire when undefined
   * (cross-platform). Mostly informational on the client side — the
   * collector has already filtered descriptors before sending.
   */
  supportedPlatforms?: SourcePlatform[];
  /**
   * Definition-level icon. `SourceIcon` is JSON-safe (string fields only),
   * so it travels over the wire as-is. Read by the portal's add-source
   * picker before any source has synced (see `descriptorIcon` in
   * `packages/gateway/portal/js/views/add-source.js`).
   */
  icon?: SourceIcon;
  /**
   * Brand attribution declared by the source package. JSON-safe, travels
   * over the wire as-is. Consumed by the portal/iOS to render a generic
   * per-item byline (e.g. "Powered by Strava").
   */
  attribution?: SourceAttribution;
  analyticsSchemas?: AnalyticsTableSchema[];
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];
  documentEventProfile?: DocumentEventProfile;
  /**
   * See `SourceDescriptor.memberScopedParamNames`. Carried separately from
   * `params` because `params` is the form's list and leaves advanced settings
   * out, while this is the whole per-machine contract — a client routing a
   * value to the right place needs the latter, not the former.
   */
  memberScopedParamNames?: string[];
  params?: Array<{
    name: string;
    label: string;
    type: SourceParam["type"];
    /** Omitted means `"source"`; see `SourceParam.scope`. */
    scope?: SourceParam["scope"];
    required?: boolean;
    placeholder?: string;
    /** See `SourceParam.help`. */
    help?: string;
    /** See `SourceParam.pattern`. */
    pattern?: string;
    /** See `SourceParam.patternHint`. */
    patternHint?: string;
    options?: Array<{ value: string; label: string }>;
    /** See `SourceParam.validateWhenEmpty`. */
    validateWhenEmpty?: boolean;
    /** See `SourceParam.provesLocalAvailabilityForAccount`. */
    provesLocalAvailabilityForAccount?: string;
  }>;
  /** See `SourceDescriptor.contentRetention`. */
  contentRetention?: "complete" | "best-effort";
  /** OAuth credentials spec — set only on providers that surface a wizard. */
  credentials?: SerializedProviderCredentialsSpec;
}

/**
 * Strip functions / brand wrappers so the descriptor can travel over JSON.
 */
export function serializeDescriptor(d: SourceDescriptor): SerializedDescriptor {
  return {
    id: String(d.id),
    name: d.name,
    description: d.description,
    unitName: d.unitName,
    primaryCount: d.primaryCount,
    gatewayHosted: d.gatewayHosted,
    urlHub: d.urlHub,
    urlTargetRole: d.urlTargetRole,
    provider: { id: String(d.provider.id), name: d.provider.name },
    authType: d.authType,
    acceptsAuthCode: d.acceptsAuthCode ?? false,
    experimental: d.experimental ?? false,
    widgetOrigins: d.widgetOrigins,
    conversational: d.conversational ?? false,
    singleInstance: d.singleInstance ?? false,
    multiDeviceMode: d.multiDevice?.mode ?? "exclusive",
    pushBased: d.pushBased ?? false,
    hasAuthFlow: !!d.authFlow || !!d.authenticate,
    hasDiscover: !!d.discover,
    hasResolveAccountId: !!d.resolveAccountId,
    historyImport: d.historyImport,
    supportedPlatforms: d.supportedPlatforms,
    icon: d.icon,
    attribution: d.attribution,
    analyticsSchemas: d.analyticsSchemas,
    documentTemporalProjections: d.documentTemporalProjections,
    documentEventProfile: d.documentEventProfile,
    memberScopedParamNames: d.memberScopedParamNames,
    params: d.params?.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      scope: p.scope,
      required: p.required,
      placeholder: p.placeholder,
      help: p.help,
      pattern: p.pattern,
      patternHint: p.patternHint,
      options: p.options,
      validateWhenEmpty: p.validateWhenEmpty,
      provesLocalAvailabilityForAccount: p.provesLocalAvailabilityForAccount,
    })),
    contentRetention: d.contentRetention,
    credentials: d.credentials ? serializeCredentialsSpec(d.credentials) : undefined,
  };
}

/**
 * True when a source has no background sync loop and no document/attachment
 * pipeline — i.e. it is push-based (data arrives from an external pusher such
 * as the iOS app) or analytics-only (it emits analytics tables, not indexable
 * documents). For these sources the per-source knobs `syncInterval`,
 * `extractAttachments`, the `attachment*` settings, and `maxAge` are inert.
 * Shared so the add flow, the post-add config editor, and the CLI
 * agree on which sources to gate — keeps the source-specific signal owned by
 * the descriptor and read generically downstream.
 */
export function isPushOrAnalyticsOnly(d: {
  pushBased?: boolean;
  analyticsSchemas?: AnalyticsTableSchema[];
}): boolean {
  return !!d.pushBased || (Array.isArray(d.analyticsSchemas) && d.analyticsSchemas.length > 0);
}
