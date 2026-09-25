// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  createLogger,
  CredentialPersistError,
  MissingCredentialsError,
  providerCredentialsPath,
  readProviderCredentials,
  toErrorMessage,
  writeProviderCredentials,
} from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure, config as configSchema } from "@omnesis/source-sdk";
import { EnableBankingClient, EnableBankingRedirectNotAllowedError } from "./client.js";
import {
  ENABLE_BANKING_FILE_KEY,
  bootstrapAccountDir,
  clearBootstrapCache,
  listAccountIds,
  loadSession,
  markBootstrapComplete,
  removeAccountData,
  saveSession,
  writeBootstrapPage,
} from "./session.js";
import type {
  AuthFlowCallbacks,
  AuthNotice,
  AuthResult,
  AuthSession,
  FieldsChallenge,
} from "@omnesis/source-sdk";
import type {
  EbAspsp,
  EbSessionAccount,
  EbSessionResponse,
  StoredSession,
  StoredSessionAccount,
} from "./types.js";

const log = createLogger("provider:enable-banking");

const PROVIDER_DISPLAY_NAME = "Enable Banking";

/** Consent lifetime requested at authorization — the 180-day ASPSP maximum. */
const CONSENT_VALIDITY_DAYS = 180;

/**
 * Safety cap on prefetched full-history pages per account. A continuation
 * key that never terminates would otherwise loop forever; at hundreds of
 * transactions per page this is far beyond any personal account's history.
 */
const MAX_BOOTSTRAP_PAGES = 200;

/**
 * Markets where Enable Banking has per-country bank coverage
 * (https://enablebanking.com/coverage/) — the EU/EEA plus the UK.
 *
 * The list a country is chosen from, and the gate on a country handed in by a
 * client: a code outside it has no bank list to offer.
 */
export const EB_MARKETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "AT", label: "Austria" },
  { value: "BE", label: "Belgium" },
  { value: "BG", label: "Bulgaria" },
  { value: "HR", label: "Croatia" },
  { value: "CY", label: "Cyprus" },
  { value: "CZ", label: "Czechia" },
  { value: "DK", label: "Denmark" },
  { value: "EE", label: "Estonia" },
  { value: "FI", label: "Finland" },
  { value: "FR", label: "France" },
  { value: "DE", label: "Germany" },
  { value: "GR", label: "Greece" },
  { value: "HU", label: "Hungary" },
  { value: "IS", label: "Iceland" },
  { value: "IE", label: "Ireland" },
  { value: "IT", label: "Italy" },
  { value: "LV", label: "Latvia" },
  { value: "LI", label: "Liechtenstein" },
  { value: "LT", label: "Lithuania" },
  { value: "LU", label: "Luxembourg" },
  { value: "MT", label: "Malta" },
  { value: "NL", label: "Netherlands" },
  { value: "NO", label: "Norway" },
  { value: "PL", label: "Poland" },
  { value: "PT", label: "Portugal" },
  { value: "RO", label: "Romania" },
  { value: "SK", label: "Slovakia" },
  { value: "SI", label: "Slovenia" },
  { value: "ES", label: "Spain" },
  { value: "SE", label: "Sweden" },
  { value: "GB", label: "United Kingdom" },
];

// ── Credentials ─────────────────────────────────────────────────────

/**
 * The stored `private_key` named a file, and the file is not there.
 *
 * Typed rather than recognised by its wording, because the two readers want
 * different things from it: a sync failure quotes the message, which names the
 * path so the operator can look; a connect flow must not, because its message
 * is copied onto a flow record the admin listing hands to every caller.
 */
export class PrivateKeyFileMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateKeyFileMissingError";
  }
}

export interface EnableBankingCredentials {
  applicationId: string;
  privateKeyPem: string;
  redirectUrl: string;
  /** Set when the credentials file held a path; the auth flow re-persists content. */
  privateKeySourcePath?: string;
}

/**
 * Re-wrap a PEM whose newlines were mangled in transit (pasted as one line,
 * literal `\n` escapes, extra indentation…). Extracts the base64 body
 * between header and footer, strips all whitespace, and re-wraps at 64
 * columns — the canonical PEM layout node:crypto accepts.
 */
export function normalizePrivateKeyPem(raw: string): string {
  const unescaped = raw.replace(/\\n/g, "\n").trim();
  const match = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/.exec(unescaped);
  if (!match) {
    throw new Error(
      "Private key does not look like a PEM (missing BEGIN/END markers). " +
        "Paste the full content of the downloaded .pem file, or its absolute path.",
    );
  }
  const label = match[1];
  const body = match[2].replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length === 0) {
    throw new Error("Private key PEM body is not valid base64.");
  }
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * Load the Enable Banking application credentials. The `private_key` field
 * holds either PEM content (detected via the BEGIN marker) or an absolute
 * path on the collector machine to the downloaded `<application_id>.pem`.
 */
export async function loadCredentials(configDir?: string): Promise<EnableBankingCredentials> {
  const fields = await readProviderCredentials(ENABLE_BANKING_FILE_KEY, configDir);
  if (!fields?.application_id || !fields?.private_key || !fields?.redirect_url) {
    throw new MissingCredentialsError(ENABLE_BANKING_FILE_KEY, PROVIDER_DISPLAY_NAME);
  }

  const rawKey = fields.private_key;
  let privateKeyPem: string;
  let privateKeySourcePath: string | undefined;
  if (rawKey.includes("-----BEGIN")) {
    privateKeyPem = normalizePrivateKeyPem(rawKey);
  } else {
    privateKeySourcePath = rawKey.trim();
    if (!existsSync(privateKeySourcePath)) {
      throw new PrivateKeyFileMissingError(
        `Private key file not found at ${privateKeySourcePath} — provide the absolute path ` +
          "on the machine running the collector, or paste the PEM content itself.",
      );
    }
    privateKeyPem = normalizePrivateKeyPem(readFileSync(privateKeySourcePath, "utf-8"));
  }

  return {
    applicationId: fields.application_id,
    privateKeyPem,
    redirectUrl: fields.redirect_url,
    privateKeySourcePath,
  };
}

// ── Account id ──────────────────────────────────────────────────────

/** `<bank>-<country>` lowercased, e.g. "revolut-de". Stable across re-consent. */
export function bankAccountSlug(bankName: string, country: string): string {
  return `${bankName}-${country}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── ASPSP matching ──────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/** Closest ASPSP names to a query — substring matches first, then edit distance. */
export function closestAspspNames(query: string, names: string[], limit = 8): string[] {
  const q = query.toLowerCase();
  const ranked = names
    .map((name) => {
      const n = name.toLowerCase();
      const tier = n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2;
      return { name, tier, dist: levenshtein(q, n) };
    })
    .sort((a, b) => a.tier - b.tier || a.dist - b.dist || a.name.localeCompare(b.name));
  return ranked.slice(0, limit).map((r) => r.name);
}

// ── Session account mapping ─────────────────────────────────────────

/**
 * Stable identity for a session account. `identification_hash` is the
 * designed cross-session key; the rare account missing it falls back to
 * the first entry of `identification_hashes`, then to the session `uid`
 * (which sacrifices cross-session stability — logged so it's diagnosable).
 */
function stableAccountKey(account: EbSessionAccount): string | null {
  const key = account.identification_hash ?? account.identification_hashes?.[0] ?? null;
  if (key) return key;
  if (account.uid) {
    log.warn(
      "Session account has no identification_hash — falling back to the session uid as its key (identity will not survive re-consent)",
    );
    return account.uid;
  }
  return null;
}

function toStoredAccounts(accounts: EbSessionAccount[]): StoredSessionAccount[] {
  const stored: StoredSessionAccount[] = [];
  for (const account of accounts) {
    const accountKey = stableAccountKey(account);
    if (!accountKey || !account.uid) {
      log.warn("Skipping session account with no usable identity (missing uid and hashes)");
      continue;
    }
    stored.push({
      account_key: accountKey,
      uid: account.uid,
      iban: account.account_id?.iban ?? null,
      currency: account.currency ?? null,
      name: account.name ?? null,
      cash_account_type: account.cash_account_type ?? null,
      product: account.product ?? null,
    });
  }
  return stored;
}

// ── Connecting a bank ───────────────────────────────────────────────

/** Transports {@link authenticate}'s tests substitute. */
export interface AuthenticateDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Connect a bank over PSD2 open banking, or renew a consent that is running
 * out.
 *
 * Which bank is two questions, not one: Enable Banking lists banks per
 * country, so the country has to be answered before the bank can even be
 * offered. Asking them in that order is what makes the second question
 * unanswerable-by-construction — the operator picks from the banks Enable
 * Banking is serving for that country right now, rather than typing a name
 * that is checked against that list afterwards.
 *
 * The consent itself is one strong-authentication round at the bank. It is
 * spent the moment it succeeds, which is why the session is written to disk
 * before anything else is attempted with it.
 */
export function authenticate(session: AuthSession): Promise<AuthResult> {
  return authenticateWith(session, {});
}

/** {@link authenticate}, with the Enable Banking transport its tests substitute. */
export async function authenticateWith(
  session: AuthSession,
  deps: AuthenticateDeps = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const now = (): Date => session.host.now();

  const creds = await applicationCredentials(configDir);
  const client = new EnableBankingClient({
    applicationId: creds.applicationId,
    privateKeyPem: creds.privateKeyPem,
    fetchImpl: deps.fetchImpl,
    now,
  });

  const { aspsp, country } = session.accountId
    ? await storedBank(session.accountId, client, configDir)
    : await chooseBank(session, client);

  const validUntil = addDays(now(), CONSENT_VALIDITY_DAYS).toISOString();
  let authorization: { url: string };
  try {
    authorization = await client.startAuth({
      validUntil,
      aspspName: aspsp.name,
      country,
      redirectUrl: creds.redirectUrl,
      // The gateway routes the code it catches back by this id.
      state: session.flowId || randomUUID(),
    });
  } catch (err) {
    throw ebFailure(err);
  }

  const { code } = await session.ask({
    kind: "redirect",
    via: "gateway",
    url: authorization.url,
    title: `Approve access at ${aspsp.name}`,
    instructions:
      "Your bank will ask you to confirm read-only access to your accounts. Omnesis can read " +
      "balances and transactions and can never move money. Approval lasts up to 180 days, " +
      "after which the bank asks again.",
  });

  let consent: EbSessionResponse;
  try {
    consent = await client.createSession(code);
  } catch (err) {
    throw ebFailure(
      err,
      "The approval could not be exchanged for a session. Start the connection again and " +
        "complete the bank's sign-in without leaving it waiting.",
    );
  }

  const accountId = bankAccountSlug(aspsp.name, country);
  const storedAccounts = toStoredAccounts(consent.accounts);
  const stored: StoredSession = {
    session_id: consent.session_id,
    valid_until: consent.access?.valid_until ?? addDays(now(), CONSENT_VALIDITY_DAYS).toISOString(),
    aspsp: { name: aspsp.name, country },
    accounts: storedAccounts,
  };

  // Persisted FIRST: the strong authentication is already spent, so a failure
  // in the prefetch below must not lose the consent it bought. With the session
  // on disk an interrupted prefetch costs history, not the connection.
  try {
    saveSession(accountId, stored, configDir);
  } catch (err) {
    throw new CredentialPersistError(ENABLE_BANKING_FILE_KEY, accountId, err);
  }

  // Eager full-history prefetch — it has to happen now, while the post-approval
  // window is open, and it happens once per consent.
  const failures = await prefetchFullHistory(client, stored, accountId, configDir);

  // The key was supplied as a file path: persist the PEM content into the
  // 0600 credentials store so the flow no longer depends on that file.
  if (creds.privateKeySourcePath) {
    await writeProviderCredentials(
      ENABLE_BANKING_FILE_KEY,
      {
        application_id: creds.applicationId,
        private_key: creds.privateKeyPem,
        redirect_url: creds.redirectUrl,
      },
      configDir,
    );
    log.info(
      `Private key content persisted into the credentials store; the original file at ${creds.privateKeySourcePath} can be deleted`,
    );
  }

  log.info(
    `Authenticated with ${aspsp.name} (${country}) via Enable Banking — ${storedAccounts.length} account(s), session valid until ${stored.valid_until}`,
  );
  return {
    accounts: [
      {
        accountId,
        // The consent's own deadline. This flow is the only place it is ever
        // seen, so a state that did not carry it would be a deadline nothing
        // downstream could warn about.
        state: { status: "connected", expiresAt: stored.valid_until },
      },
    ],
    ...(failures.length > 0 ? { notices: [historyNotice(failures)] } : {}),
  };
}

/**
 * The bank a renewal is for, read from the consent it is renewing.
 *
 * Never from parameters: a re-authentication is started from a banner that
 * carries none, and reading a bank from anywhere else would let a renewal of a
 * half-removed account connect a different bank under the old account's slug.
 */
async function storedBank(
  accountId: string,
  client: EnableBankingClient,
  configDir: string | undefined,
): Promise<{ aspsp: EbAspsp; country: string }> {
  const existing = loadSession(accountId, configDir);
  if (!existing) {
    throw new AuthFailure(
      "unknown",
      `There is no stored consent for ${accountId}, so there is nothing here to renew.`,
      {
        remedy:
          "Remove this connection and add the bank again. Asking which bank to connect from " +
          "here would attach a different bank to this account's existing data.",
      },
    );
  }
  const country = existing.aspsp.country.toUpperCase();
  log.info(
    `Re-consenting ${accountId} against its stored bank ${existing.aspsp.name} (${country})`,
  );
  const aspsps = await listAspsps(client, country);
  const aspsp = aspsps.find((a) => a.name.toLowerCase() === existing.aspsp.name.toLowerCase());
  if (!aspsp) {
    throw new AuthFailure(
      "unsupported",
      `Enable Banking no longer lists ${existing.aspsp.name} for ${country}.`,
      {
        remedy:
          "Remove this connection and add the bank again — it may now be listed under a " +
          "different name.",
      },
    );
  }
  return { aspsp, country };
}

/**
 * Ask which bank, one question at a time.
 *
 * A value a client of the older shape collected on the add form arrives on
 * `supplied`, and is used when it still resolves — asking again for something
 * the operator has already answered is what the bridge exists to avoid. A
 * country outside the covered markets, or a bank name that no longer matches
 * anything the country serves, is treated as unanswered rather than as an
 * error: the question has an answer, and the operator is the one who can give
 * it.
 */
async function chooseBank(
  session: AuthSession,
  client: EnableBankingClient,
): Promise<{ aspsp: EbAspsp; country: string }> {
  const country = await resolveCountry(session);
  const aspsps = await listAspsps(client, country);
  if (aspsps.length === 0) {
    throw new AuthFailure(
      "unsupported",
      `Enable Banking serves no banks for ${countryLabel(country)}.`,
      {
        remedy:
          "Choose a country Enable Banking covers, or connect this bank through a different " +
          "source.",
      },
    );
  }

  const names = [...new Set(aspsps.map((a) => a.name))].sort((a, b) => a.localeCompare(b));
  const suppliedBank = session.supplied.bank?.trim();
  const matched = suppliedBank
    ? aspsps.find((a) => a.name.toLowerCase() === suppliedBank.toLowerCase())
    : undefined;
  if (matched) return { aspsp: matched, country };

  const challenge: FieldsChallenge = {
    kind: "fields",
    title: `Choose your bank in ${countryLabel(country)}`,
    instructions: suppliedBank
      ? `Enable Banking does not list "${suppliedBank}" for ${countryLabel(country)}. Pick your ` +
        "bank from the ones it serves there."
      : "These are the banks Enable Banking serves in that country right now.",
    schema: configSchema.object({
      bank: configSchema.select({
        label: "Bank",
        required: true,
        options: names.map((name) => ({ value: name, label: name })),
      }),
    }),
  };
  const answer = await session.ask(challenge);
  const chosen = aspsps.find((a) => a.name === answer.bank);
  if (!chosen) {
    // The answer is checked against the same option list this challenge was
    // built from, so reaching here means the list changed under the question.
    throw new AuthFailure(
      "unavailable",
      `Enable Banking no longer lists "${String(answer.bank)}" for ${countryLabel(country)}.`,
      { remedy: "Start the connection again to see the current list of banks." },
    );
  }
  return { aspsp: chosen, country };
}

/** The country, from the add form if a client filled one in, else asked. */
async function resolveCountry(session: AuthSession): Promise<string> {
  // Normalised by hand: a value that arrived on `supplied` never went through
  // a challenge, so nothing has parsed it.
  const supplied = session.supplied.country?.trim().toUpperCase();
  if (supplied && EB_MARKETS.some((m) => m.value === supplied)) return supplied;

  const challenge: FieldsChallenge = {
    kind: "fields",
    title: "Choose the country your bank is in",
    instructions:
      "Enable Banking covers the EU and EEA plus the United Kingdom, and which banks it can " +
      "reach depends on the country.",
    schema: configSchema.object({
      country: configSchema.select({ label: "Country", required: true, options: [...EB_MARKETS] }),
    }),
  };
  const answer = await session.ask(challenge);
  return String(answer.country);
}

/** The banks a country serves, with an Enable Banking refusal mapped. */
async function listAspsps(client: EnableBankingClient, country: string): Promise<EbAspsp[]> {
  try {
    return await client.getAspsps(country);
  } catch (err) {
    throw ebFailure(err);
  }
}

function countryLabel(code: string): string {
  return EB_MARKETS.find((m) => m.value === code)?.label ?? code;
}

/**
 * The application credentials, with the two ways they can be present and
 * unusable named for the operator.
 *
 * The path variant deliberately drops the original message: it interpolates an
 * absolute path on the collector's machine, and a flow's message is copied
 * onto a record every admin caller can read. The credential field is what the
 * operator has to change anyway.
 */
async function applicationCredentials(configDir?: string): Promise<EnableBankingCredentials> {
  try {
    return await loadCredentials(configDir);
  } catch (err) {
    // Nothing configured at all — routes into the credentials wizard rather
    // than into this flow.
    if (err instanceof MissingCredentialsError) throw err;
    if (err instanceof PrivateKeyFileMissingError) {
      throw new AuthFailure(
        "credential-rejected",
        "The Enable Banking private key is stored as a file path, and no file exists at that " +
          "path on the machine running the collector.",
        {
          remedy:
            "Edit the Enable Banking credentials and put the contents of the downloaded .pem " +
            "file in the private key field, or a path that exists on this machine.",
        },
      );
    }
    throw new AuthFailure("credential-rejected", toErrorMessage(err), {
      remedy:
        "Edit the Enable Banking credentials and paste the private key exactly as it appears " +
        "in the downloaded .pem file, from the BEGIN line to the END line.",
    });
  }
}

/**
 * What the operator loses when the one-shot history capture does not happen.
 *
 * The connection is fine, so this is not a failure — but the window it missed
 * does not come back until the next approval, and an operator told only
 * "connected" has no reason to look for the gap.
 */
function historyNotice(failures: PrefetchFailure[]): AuthNotice {
  const accounts = failures.map((f) => f.account).join(", ");
  const plural = failures.length === 1 ? "account" : "accounts";
  return {
    title: `Older transactions were not captured for ${failures.length} ${plural}`,
    detail:
      `Enable Banking serves a full transaction history only in the few minutes after the bank ` +
      `approval, once per approval, and that fetch failed for ${accounts}. Those accounts start ` +
      `from the last 90 days instead. Authorize this bank again to make another attempt.`,
  };
}

/**
 * What an Enable Banking refusal means for the operator.
 *
 * The client answers 401 and 403 with one `auth` kind, so a refused
 * application key and a spent authorization cannot be told apart here — and
 * both are a credential presented and not accepted, which is
 * `credential-rejected` rather than `denied`: an operator refusing consent at
 * their bank never reaches this, because the bank redirects with an error the
 * host catches and the waiting challenge reports itself. Everything else is
 * Enable Banking or the bank being unreachable.
 */
function ebFailure(err: unknown, remedy?: string): Error {
  if (err instanceof AuthFailure) return err;
  if (err instanceof EnableBankingRedirectNotAllowedError) {
    // The redirect URL is one of the credential fields: the platform refused
    // a value the operator supplied, and the way forward is supplying one it
    // accepts — which is what `credential-rejected` means to a client.
    return new AuthFailure("credential-rejected", err.message, {
      remedy:
        `Add ${err.redirectUrl} to the allowed redirect URLs on your application in the ` +
        "Enable Banking control panel, or reconnect with a redirect URL that is already " +
        "allowed there.",
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          remedy ??
          "Check that the Enable Banking application is still active and that the private key " +
            "stored here is the one issued for it.",
      });
    }
    if (err.kind === "rate-limit" || err.kind === "transient" || err.kind === "network") {
      // The platform said when, so pass it on. Telling an operator to come
      // back is a different instruction from telling them when to come back,
      // and this one can be a matter of hours.
      return new AuthFailure("unavailable", message, {
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      });
    }
  }
  return new AuthFailure("unknown", message);
}

// ── Auth flow ───────────────────────────────────────────────────────

export interface AuthFlowDeps {
  configDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Interactive consent flow:
 *
 *  1. validate the requested bank against `GET /aspsps` for the country;
 *  2. `POST /auth` (state = the gateway flow id) and surface the SCA URL;
 *  3. await the redirect code over the harness code-delivery channel
 *     (`callbacks.receiveCode` — EB production redirect URLs are HTTPS,
 *     so there is no collector-local listener);
 *  4. `POST /sessions` to mint the session and persist `session.json`
 *     (atomic, 0600) immediately — a crash later in the flow must never
 *     lose the freshly minted session (the SCA is already spent);
 *  5. eagerly prefetch FULL transaction history into the bootstrap cache —
 *     Revolut serves complete history only within ~5 minutes of SCA, one
 *     shot per 180-day consent; failures degrade to the 90-day sync window;
 *  6. return the accountId slug.
 *
 * Re-running for the same bank+country yields the same accountId and
 * REPLACES the session — that is the re-consent path. Re-auth surfaces
 * (portal banner, `cli reauth`) start the flow without params; when
 * `callbacks.accountId` names an existing connection, the stored session's
 * bank + country are reused so the user just redoes SCA.
 */
export async function authFlow(
  params: Record<string, string> | undefined,
  callbacks: AuthFlowCallbacks | undefined,
  deps: AuthFlowDeps = {},
): Promise<AccountId> {
  const now = deps.now ?? (() => new Date());
  let country = params?.country?.trim().toUpperCase();
  let bank = params?.bank?.trim();
  if ((!country || !bank) && callbacks?.accountId) {
    // Re-auth path: no connect params, but the flow targets an existing
    // account — re-consent the bank stored in its session.json.
    const existing = loadSession(callbacks.accountId, deps.configDir);
    if (existing) {
      bank = existing.aspsp.name;
      country = existing.aspsp.country.toUpperCase();
      log.info(`Re-consenting ${callbacks.accountId} against its stored bank ${bank} (${country})`);
    }
  }
  if (!country || !bank) {
    throw new Error(
      "Both 'country' and 'bank' are required to connect a bank account. " +
        "To re-consent an existing connection, re-run the add flow with the same bank and country.",
    );
  }
  const receiveCode = callbacks?.receiveCode;
  if (!receiveCode) {
    throw new Error(
      "Enable Banking authorization needs the code-delivery channel (gateway /oauth/callback " +
        "or CLI paste) — run the auth flow via the portal or the omnesis CLI.",
    );
  }

  const creds = await loadCredentials(deps.configDir);
  const client = new EnableBankingClient({
    applicationId: creds.applicationId,
    privateKeyPem: creds.privateKeyPem,
    fetchImpl: deps.fetchImpl,
    now,
  });

  const aspsps = await client.getAspsps(country);
  const match = aspsps.find((a) => a.name.toLowerCase() === bank.toLowerCase());
  if (!match) {
    const closest = closestAspspNames(
      bank,
      aspsps.map((a) => a.name),
    );
    throw new Error(
      `Bank "${bank}" not found for country ${country}. Closest matches: ${closest.join(", ")}`,
    );
  }

  const session = await runConsent(client, match, creds.redirectUrl, callbacks, receiveCode, now);
  const accountId = bankAccountSlug(match.name, country);
  const storedAccounts = toStoredAccounts(session.accounts);

  // Persist the session FIRST: the SCA is already spent, so a crash during
  // the prefetch below must not lose the consent — with session.json on
  // disk, an interrupted prefetch merely degrades the bootstrap to the
  // 90-day network window.
  const stored: StoredSession = {
    session_id: session.session_id,
    valid_until: session.access?.valid_until ?? addDays(now(), CONSENT_VALIDITY_DAYS).toISOString(),
    aspsp: { name: match.name, country },
    accounts: storedAccounts,
  };
  saveSession(accountId, stored, deps.configDir);

  // Eager full-history prefetch — must happen NOW, while the post-SCA
  // window is open. Any failure degrades gracefully: sync falls back to
  // the 90-day window for accounts without a complete cache.
  await prefetchFullHistory(client, stored, accountId, deps.configDir);

  // The key was supplied as a file path: persist the PEM content into the
  // 0600 credentials store so the flow no longer depends on that file.
  if (creds.privateKeySourcePath) {
    await writeProviderCredentials(
      ENABLE_BANKING_FILE_KEY,
      {
        application_id: creds.applicationId,
        private_key: creds.privateKeyPem,
        redirect_url: creds.redirectUrl,
      },
      deps.configDir,
    );
    log.info(
      `Private key content persisted into the credentials store; the original file at ${creds.privateKeySourcePath} can be deleted`,
    );
  }

  log.info(
    `Authenticated with ${match.name} (${country}) via Enable Banking — ${storedAccounts.length} account(s), session valid until ${stored.valid_until}`,
  );
  return AccountId(accountId);
}

async function runConsent(
  client: EnableBankingClient,
  aspsp: EbAspsp,
  redirectUrl: string,
  callbacks: AuthFlowCallbacks,
  receiveCode: () => Promise<string>,
  now: () => Date,
) {
  const validUntil = addDays(now(), CONSENT_VALIDITY_DAYS).toISOString();
  const state = callbacks.flowId ?? randomUUID();
  const { url } = await client.startAuth({
    validUntil,
    aspspName: aspsp.name,
    country: aspsp.country,
    redirectUrl,
    state,
  });
  if (callbacks.onAuthUrl) {
    callbacks.onAuthUrl(url);
  } else {
    log.info(`Open this URL in your browser to authorize: ${url}`);
  }
  const code = await receiveCode();
  log.info(`Received authorization code (codeLen=${code.length}); creating session`);
  return client.createSession(code);
}

/**
 * One account whose full-history prefetch did not complete, named the way the
 * operator would recognise it.
 */
interface PrefetchFailure {
  account: string;
  message: string;
}

async function prefetchFullHistory(
  client: EnableBankingClient,
  session: StoredSession,
  accountId: string,
  configDir?: string,
): Promise<PrefetchFailure[]> {
  const failures: PrefetchFailure[] = [];
  for (const account of session.accounts) {
    const dir = bootstrapAccountDir(accountId, account.account_key, configDir);
    let fetching = false;
    try {
      // Wipe any cache left by a previous consent — pages are renumbered.
      await clearBootstrapCache(dir);
      let continuationKey: string | undefined;
      let pages = 0;
      do {
        fetching = true;
        const page = await client.getTransactions(account.uid, {
          transactionStatus: "BOOK",
          continuationKey,
        });
        fetching = false;
        writeBootstrapPage(dir, pages, page, configDir);
        pages++;
        continuationKey = page.continuation_key ?? undefined;
      } while (continuationKey && pages < MAX_BOOTSTRAP_PAGES);
      if (continuationKey) {
        log.warn(
          `Full-history prefetch hit the ${MAX_BOOTSTRAP_PAGES}-page cap for account …${account.account_key.slice(-6)}; history beyond the cap is truncated`,
        );
      }
      // The marker stamps the consent epoch so a drain cursor minted against
      // this cache can detect a later re-consent rewriting it.
      markBootstrapComplete(dir, pages, session.session_id, configDir);
      log.info(
        `Prefetched full history for account …${account.account_key.slice(-6)}: ${pages} page(s)`,
      );
    } catch (err) {
      // Storage failures must not turn an irreplaceable history spool into a
      // successful consent with a silently shortened network fallback.
      if (!fetching) throw err;
      log.warn(
        `Full-history prefetch failed for account …${account.account_key.slice(-6)} (${(err as Error).message}); sync will fall back to the last 90 days`,
      );
      failures.push({
        account: account.name ?? `…${account.account_key.slice(-6)}`,
        message: toErrorMessage(err),
      });
    }
  }
  return failures;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

// ── Discover / cleanup ──────────────────────────────────────────────

/**
 * Resolve connected banks offline from the per-account session files —
 * the collector derives accounts solely from this, so it must work
 * without any network call.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  return listAccountIds(configDir).map((id) => AccountId(id));
}

/**
 * Remove everything stored for one connected bank. The shared application
 * credentials file is removed only when no other connected bank remains —
 * "remaining" uses the same predicate as `discover()` (a directory with a
 * `session.json`), so an orphan directory left by an interrupted flow can
 * never keep the credentials file alive.
 */
export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await removeAccountData(accountId, configDir);
  const remaining = listAccountIds(configDir).length;
  if (remaining === 0) {
    await rm(providerCredentialsPath(ENABLE_BANKING_FILE_KEY, configDir), { force: true });
  }
  log.info(
    `Cleaned up Enable Banking data for ${accountId}${remaining === 0 ? " (last account — credentials removed too)" : ""}`,
  );
}
