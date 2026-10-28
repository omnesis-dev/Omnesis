// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Credentials held by an external broker instead of by Omnesis.
 *
 * Some installs already keep their sign-ins in a credential broker — a
 * self-hosted Nango — that other software on the same machine uses too. Signing
 * the same account in again through Omnesis would leave two grants to refresh,
 * two places to revoke, and two copies of a refresh token. A brokered account
 * instead stores only *which* broker connection holds its credential, and asks
 * the broker for a fresh value whenever it needs one. The broker owns the
 * grant: it refreshes it, and revoking it there cuts Omnesis off with everyone
 * else.
 *
 * Two files, both secret files under the config directory:
 *
 *   - `credential-broker.json` — where the broker is and the key Omnesis
 *     presents to it. One per collector host.
 *   - `<fileKey>/<accountId>/broker.json` — the binding for one account: a
 *     broker connection per purpose. A provider whose APIs each hold their own
 *     grant at the broker (one Google sign-in per Gmail, Calendar, Drive and
 *     Contacts) binds one connection per purpose; every other provider binds
 *     the single purpose {@link DEFAULT_BROKER_PURPOSE}.
 *
 * The binding lives in the account's own directory, so removing the account
 * (`clearProviderAccountCredentials`) removes the binding with it and never
 * touches the grant at the broker.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { safePathSegment, SyncError } from "@omnesis/types";
import { DEFAULT_CONFIG_DIR } from "./utils.js";
import { readSecretJsonFile, writeSecretJsonFile } from "./secret-file.js";

/** The purpose a single-connection provider binds. */
export const DEFAULT_BROKER_PURPOSE = "default";

const BROKER_CONFIG_FILE = "credential-broker.json";
const BROKER_BINDING_FILE = "broker.json";

/** How long before its stated expiry a cached access token is fetched again. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/**
 * How long a credential without an expiry (an API key, a non-expiring OAuth
 * token) is reused before asking the broker again, so a rotation or a revoke
 * at the broker reaches a running collector without a restart.
 */
const UNDATED_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * The shortest interval between two forced refreshes of one connection. A
 * forced refresh that fails is recorded against the connection at the broker
 * and holds every other program using it back for a while, so a source that
 * meets a run of refusals must not turn each into another refresh.
 */
const FORCED_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** How long Nango holds a connection back after a failed refresh. */
const BROKER_REFRESH_BACKOFF_MS = 30_000;

/** Where the broker is and the key Omnesis presents to it. */
export interface CredentialBrokerConfig {
  kind: "nango";
  /** Base URL of the broker's API, e.g. `http://127.0.0.1:3003`. */
  url: string;
  /** The broker API key, sent as a bearer token. */
  secretKey: string;
}

/** One connection at the broker. */
export interface BrokerConnectionRef {
  /** The broker's integration id (Nango's `provider_config_key`). */
  providerConfigKey: string;
  /** The broker's connection id. */
  connectionId: string;
}

/** Which broker connection holds each of one account's credentials. */
export interface BrokerBinding {
  broker: "nango";
  /** Keyed by purpose: {@link DEFAULT_BROKER_PURPOSE}, or a provider's own purposes. */
  connections: Record<string, BrokerConnectionRef>;
  /**
   * Non-secret settings the provider needs beside the credential, recorded
   * when the account is linked (an IMAP server's host, a display name).
   */
  params?: Record<string, string>;
}

/** A credential as the broker returned it, normalised across auth modes. */
export type BrokerCredential =
  | {
      type: "oauth2";
      accessToken: string;
      /** Epoch milliseconds, when the broker states one. */
      expiresAt?: number;
      /** The provider's own token response, as the broker stored it. */
      raw: Record<string, unknown>;
    }
  | { type: "api-key"; apiKey: string }
  | { type: "basic"; username: string; password: string };

/** A fetched credential plus what the broker records about the connection. */
export interface BrokerCredentialResult {
  credential: BrokerCredential;
  /** The broker's per-connection configuration (Nango `connection_config`). */
  connectionConfig: Record<string, unknown>;
  /** The broker's per-connection metadata (Nango `metadata`). */
  metadata: Record<string, unknown>;
}

/**
 * Why the broker could not supply a credential. A `SyncError`, so a source that
 * lets it propagate is routed by its kind: a connection the broker no longer
 * holds, or can no longer refresh, is `auth` and parks the source as needing
 * attention; a broker that cannot be reached is `network` and is retried.
 */
export class BrokerCredentialError extends SyncError {
  constructor(
    public readonly reason:
      | "unconfigured"
      | "unbound"
      | "rejected"
      | "not-found"
      | "refresh-exhausted"
      | "unsupported"
      | "identity-changed"
      | "unavailable",
    message: string,
    opts: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(reason === "unavailable" ? "network" : "auth", message, opts);
    this.name = "BrokerCredentialError";
  }
}

export function credentialBrokerConfigPath(configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, BROKER_CONFIG_FILE);
}

export async function readCredentialBrokerConfig(
  configDir?: string,
): Promise<CredentialBrokerConfig | null> {
  const path = credentialBrokerConfigPath(configDir);
  if (!existsSync(path)) return null;
  const value = await readSecretJsonFile<Partial<CredentialBrokerConfig>>(path, { configDir });
  if (!value || value.kind !== "nango" || !value.url || !value.secretKey) {
    throw new BrokerCredentialError("unconfigured", `${path} is not a usable broker configuration`);
  }
  return { kind: "nango", url: value.url, secretKey: value.secretKey };
}

export async function writeCredentialBrokerConfig(
  config: CredentialBrokerConfig,
  configDir?: string,
): Promise<void> {
  const url = new URL(config.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The broker URL must be http(s), not ${url.protocol}`);
  }
  // The key reaches every connection at the broker; it never crosses a
  // network in the clear.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Use https for a broker that is not on this machine (${url.hostname})`);
  }
  if (!config.secretKey.trim()) throw new Error("The broker key is empty");
  await writeSecretJsonFile(
    credentialBrokerConfigPath(configDir),
    {
      kind: config.kind,
      url: url.origin + url.pathname.replace(/\/+$/, ""),
      secretKey: config.secretKey.trim(),
    },
    { configDir },
  );
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Whether a value can be an integration or connection id. Both are spliced
 * into the broker's URL, so a value that would change the path it names (`.`,
 * `..`, a separator) or that no broker issues (control characters) is refused
 * wherever one is read or written.
 */
export function isBrokerRefPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !/[/\\?#%\u0000-\u001f\u007f]/.test(value)
  );
}

function assertRef(
  ref: BrokerConnectionRef | undefined,
  where: string,
): asserts ref is BrokerConnectionRef {
  if (!isBrokerRefPart(ref?.providerConfigKey) || !isBrokerRefPart(ref?.connectionId)) {
    throw new BrokerCredentialError("unbound", `${where} names no usable connection`);
  }
}

export function brokerBindingPath(fileKey: string, accountId: string, configDir?: string): string {
  return join(
    configDir ?? DEFAULT_CONFIG_DIR,
    fileKey,
    safePathSegment(accountId),
    BROKER_BINDING_FILE,
  );
}

/** Whether an account's credential is held by the broker. Never throws. */
export function hasBrokerBinding(fileKey: string, accountId: string, configDir?: string): boolean {
  try {
    return existsSync(brokerBindingPath(fileKey, accountId, configDir));
  } catch {
    return false;
  }
}

/**
 * Account ids whose credential the broker holds. Read by `discover()`, so like
 * `listProviderAccountIds` it skips a directory it cannot use instead of
 * throwing.
 */
export function listBrokeredAccountIds(fileKey: string, configDir?: string): string[] {
  const root = join(configDir ?? DEFAULT_CONFIG_DIR, fileKey);
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && hasBrokerBinding(fileKey, entry.name, configDir))
      ids.push(entry.name);
  }
  return ids;
}

export async function readBrokerBinding(
  fileKey: string,
  accountId: string,
  configDir?: string,
): Promise<BrokerBinding | null> {
  const path = brokerBindingPath(fileKey, accountId, configDir);
  if (!existsSync(path)) return null;
  const value = await readSecretJsonFile<Partial<BrokerBinding>>(path, { configDir });
  const connections = value?.connections;
  if (!value || value.broker !== "nango" || !connections || typeof connections !== "object") {
    throw new BrokerCredentialError("unbound", `${path} is not a usable broker binding`);
  }
  for (const [purpose, ref] of Object.entries(connections)) {
    assertRef(ref, `${path} (${purpose})`);
  }
  return { broker: "nango", connections, ...(value.params ? { params: value.params } : {}) };
}

export async function writeBrokerBinding(
  fileKey: string,
  accountId: string,
  binding: BrokerBinding,
  configDir?: string,
): Promise<void> {
  if (Object.keys(binding.connections).length === 0) {
    throw new Error("A broker binding needs at least one connection");
  }
  for (const [purpose, ref] of Object.entries(binding.connections)) assertRef(ref, purpose);
  const path = brokerBindingPath(fileKey, accountId, configDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await writeSecretJsonFile(path, binding, { configDir });
}

/** The connection bound for `purpose`, or the account's only connection. */
export function brokerConnectionFor(
  binding: BrokerBinding,
  purpose: string = DEFAULT_BROKER_PURPOSE,
): BrokerConnectionRef {
  const ref = binding.connections[purpose];
  if (ref) return ref;
  const all = Object.values(binding.connections);
  if (purpose === DEFAULT_BROKER_PURPOSE && all.length === 1) return all[0]!;
  throw new BrokerCredentialError("unbound", `No broker connection is linked for ${purpose}`);
}

export interface FetchBrokerCredentialOptions {
  /** Ask the broker to refresh even if its token has not expired. */
  forceRefresh?: boolean;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** Ask the broker for one connection's current credential. */
export async function fetchBrokerCredential(
  config: CredentialBrokerConfig,
  ref: BrokerConnectionRef,
  opts: FetchBrokerCredentialOptions = {},
): Promise<BrokerCredentialResult> {
  assertRef(ref, "The binding");
  const url = new URL(`${config.url}/connections/${encodeURIComponent(ref.connectionId)}`);
  url.searchParams.set("provider_config_key", ref.providerConfigKey);
  if (opts.forceRefresh) url.searchParams.set("force_refresh", "true");
  const label = `${ref.providerConfigKey}/${ref.connectionId}`;

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${config.secretKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BrokerCredentialError(
      "unavailable",
      `The credential broker at ${config.url} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!res.ok) throw await brokerFailure(res, label);

  let body: {
    credentials?: Record<string, unknown>;
    connection_config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Whatever answered is not the broker's API (a proxy page, a captive
    // portal); its body is not repeated, since it is not ours to log.
    throw new BrokerCredentialError(
      "unavailable",
      `The credential broker's answer for ${label} was not JSON`,
    );
  }
  return {
    credential: normaliseCredential(body.credentials, label),
    connectionConfig: body.connection_config ?? {},
    metadata: body.metadata ?? {},
  };
}

/**
 * Classify a refusal from Nango. The status alone is not enough: Nango answers
 * 424 both for a grant it has given up refreshing and for its short back-off
 * after any failed refresh, and 400 for a grant the provider rejected outright
 * as well as for request mistakes. Only a grant that is gone asks the operator
 * to act; a back-off or a blip is retried.
 */
async function brokerFailure(res: Response, label: string): Promise<BrokerCredentialError> {
  const text = await res.text().catch(() => "");
  let code = "";
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } | string };
    const error = body?.error;
    code = typeof error === "string" ? error : typeof error?.code === "string" ? error.code : "";
  } catch {
    code = "";
  }
  if (res.status === 401 || res.status === 403) {
    return new BrokerCredentialError(
      "rejected",
      `The credential broker refused Omnesis's key (HTTP ${res.status}) for ${label}`,
    );
  }
  if (code === "unknown_provider_config") {
    return new BrokerCredentialError(
      "unbound",
      `The credential broker has no integration for ${label}`,
    );
  }
  if (res.status === 404 || code === "unknown_connection") {
    return new BrokerCredentialError("not-found", `The credential broker no longer holds ${label}`);
  }
  if (code === "connection_refresh_backoff") {
    return new BrokerCredentialError(
      "unavailable",
      `The credential broker is holding ${label} back after a failed refresh; retrying shortly`,
      { retryAfterMs: BROKER_REFRESH_BACKOFF_MS },
    );
  }
  if (
    code === "connection_refresh_exhausted" ||
    (code === "refresh_token_external_error" && /invalid_grant|revoked|expired/i.test(text))
  ) {
    return new BrokerCredentialError(
      "refresh-exhausted",
      `The credential broker can no longer refresh ${label}; sign it in again at the broker`,
    );
  }
  return new BrokerCredentialError(
    "unavailable",
    `The credential broker answered HTTP ${res.status}${code ? ` (${code})` : ""} for ${label}`,
  );
}

function normaliseCredential(
  credentials: Record<string, unknown> | undefined,
  label: string,
): BrokerCredential {
  const type = typeof credentials?.type === "string" ? credentials.type : "";
  const str = (key: string) =>
    typeof credentials?.[key] === "string" && credentials[key] !== ""
      ? (credentials[key] as string)
      : undefined;
  if (type === "OAUTH2" || type === "OAUTH1") {
    const accessToken = str("access_token") ?? str("oauth_token");
    if (!accessToken) {
      throw new BrokerCredentialError(
        "not-found",
        `The credential broker holds no token for ${label}`,
      );
    }
    const expires = str("expires_at");
    const expiresAt = expires ? Date.parse(expires) : NaN;
    const raw = credentials?.raw;
    return {
      type: "oauth2",
      accessToken,
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      raw: raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {},
    };
  }
  if (type === "API_KEY") {
    const apiKey = str("apiKey");
    if (!apiKey)
      throw new BrokerCredentialError(
        "not-found",
        `The credential broker holds no key for ${label}`,
      );
    return { type: "api-key", apiKey };
  }
  if (type === "BASIC") {
    const username = str("username");
    const password = str("password");
    if (!username || !password) {
      throw new BrokerCredentialError(
        "not-found",
        `The credential broker holds no login for ${label}`,
      );
    }
    return { type: "basic", username, password };
  }
  throw new BrokerCredentialError(
    "unsupported",
    `The credential broker's ${type || "unknown"} credentials for ${label} are not a kind Omnesis can use`,
  );
}

/** The access token of an OAuth credential, or the key of an API-key one. */
export function brokerBearerToken(credential: BrokerCredential): string {
  if (credential.type === "oauth2") return credential.accessToken;
  if (credential.type === "api-key") return credential.apiKey;
  throw new BrokerCredentialError("unsupported", "This connection holds a login, not a token");
}

/**
 * One account's brokered credentials, fetched on demand and reused until they
 * are due. Built once per source context; every API call asks it for a value.
 */
export interface BrokeredCredentialsOptions {
  now?: () => number;
  fetch?: typeof fetch;
  /**
   * Check each credential the broker hands out still belongs to the account it
   * was linked as, and throw (a {@link BrokerCredentialError} with reason
   * `identity-changed`) when it does not. A connection re-authorised at the
   * broker as someone else would otherwise sync that person's data under this
   * account's id. Runs on every fresh fetch, before the value is used.
   */
  verify?: (purpose: string, result: BrokerCredentialResult) => void | Promise<void>;
}

interface CacheEntry {
  result: BrokerCredentialResult;
  validUntil: number;
  seq: number;
}

/**
 * One account's brokered credentials, fetched on demand and reused until they
 * are due. Built once per source context; every API call asks it for a value.
 */
export class BrokeredCredentials {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<
    string,
    { promise: Promise<BrokerCredentialResult>; forced: boolean }
  >();
  private readonly lastForced = new Map<string, number>();
  private seq = 0;

  constructor(
    readonly binding: BrokerBinding,
    private readonly config: CredentialBrokerConfig,
    private readonly opts: BrokeredCredentialsOptions = {},
  ) {}

  /** Load the binding and broker configuration for one account. */
  static async load(
    fileKey: string,
    accountId: string,
    configDir?: string,
    opts: BrokeredCredentialsOptions = {},
  ): Promise<BrokeredCredentials> {
    const binding = await readBrokerBinding(fileKey, accountId, configDir);
    if (!binding) {
      throw new BrokerCredentialError(
        "unbound",
        `${fileKey} account ${accountId} is not linked to the broker`,
      );
    }
    const config = await readCredentialBrokerConfig(configDir);
    if (!config) {
      throw new BrokerCredentialError(
        "unconfigured",
        `${fileKey} account ${accountId} is linked to a credential broker, but none is configured; run \`omnesis broker set\``,
      );
    }
    return new BrokeredCredentials(binding, config, opts);
  }

  /** The purposes this account has a connection for. */
  get purposes(): string[] {
    return Object.keys(this.binding.connections);
  }

  has(purpose: string): boolean {
    return purpose in this.binding.connections;
  }

  /**
   * The current credential for `purpose`, with the broker's connection details.
   *
   * `forceRefresh` asks the broker to renew an OAuth grant now, for a caller
   * whose token was just refused. It is honoured at most once per connection
   * every few minutes; within that window the caller gets the newest value
   * the broker has handed out, which is already the refreshed one.
   */
  async get(
    purpose: string = DEFAULT_BROKER_PURPOSE,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<BrokerCredentialResult> {
    const ref = brokerConnectionFor(this.binding, purpose);
    const key = `${ref.providerConfigKey}\u0000${ref.connectionId}`;
    const now = (this.opts.now ?? Date.now)();
    const cached = this.cache.get(key);
    const pending = this.inflight.get(key);

    let forced = Boolean(opts.forceRefresh);
    if (forced) {
      const last = this.lastForced.get(key);
      if (last !== undefined && now - last < FORCED_REFRESH_INTERVAL_MS) forced = false;
    }
    if (!forced) {
      // A throttled forced refresh refetches as the broker holds it, which
      // picks up a rotation another caller's refresh already made.
      if (cached && cached.validUntil > now && !opts.forceRefresh) return cached.result;
      if (pending) return pending.promise;
    } else if (pending?.forced) {
      return pending.promise;
    }

    // Only an OAuth grant has anything to refresh. A key or a login held at the
    // broker is fetched again as it stands, so a caller that suspects a rotated
    // one never depends on how the broker treats a refresh it cannot perform.
    const sendForce =
      forced &&
      cached?.result.credential.type !== "api-key" &&
      cached?.result.credential.type !== "basic";
    if (forced) this.lastForced.set(key, now);
    const seq = ++this.seq;
    const promise = fetchBrokerCredential(this.config, ref, {
      forceRefresh: sendForce,
      fetch: this.opts.fetch,
    })
      .then(async (result) => {
        await this.opts.verify?.(purpose, result);
        return result;
      })
      .then(
        (result) => {
          const fetchedAt = (this.opts.now ?? Date.now)();
          const expiresAt =
            result.credential.type === "oauth2" ? result.credential.expiresAt : undefined;
          const validUntil =
            expiresAt !== undefined
              ? Math.min(expiresAt - EXPIRY_MARGIN_MS, fetchedAt + UNDATED_TTL_MS * 6)
              : fetchedAt + UNDATED_TTL_MS;
          // A slower fetch that started earlier never replaces a newer value.
          const current = this.cache.get(key);
          if (!current || current.seq < seq) this.cache.set(key, { result, validUntil, seq });
          if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
          return this.cache.get(key)!.seq > seq ? this.cache.get(key)!.result : result;
        },
        (err: unknown) => {
          if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
          throw err;
        },
      );
    this.inflight.set(key, { promise, forced });
    return promise;
  }

  /** The bearer token for `purpose`: an OAuth access token or an API key. */
  async token(
    purpose: string = DEFAULT_BROKER_PURPOSE,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    return brokerBearerToken((await this.get(purpose, opts)).credential);
  }

  /** Forget a cached credential, so the next call asks the broker again. */
  invalidate(purpose: string = DEFAULT_BROKER_PURPOSE): void {
    const ref = brokerConnectionFor(this.binding, purpose);
    this.cache.delete(`${ref.providerConfigKey}\u0000${ref.connectionId}`);
  }
}
