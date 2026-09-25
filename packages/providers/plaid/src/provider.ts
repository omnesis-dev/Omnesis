// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Plaid auth + per-item identity.
 *
 * The per-account credential is never pasted. The operator's Plaid app
 * credential (`client_id`, `secret`, environment, countries) is configured once
 * through the credentials wizard, and `authFlow()` then runs a **Hosted Link**
 * session, in which Plaid serves the sign-in page itself:
 *
 *   1. mint a Link token with `hosted_link` (`/link/token/create`), which
 *      returns the URL Plaid will serve the sign-in at;
 *   2. hand that URL to the client (`callbacks.onAuthUrl`) for the user to
 *      open — anywhere, on any device;
 *   3. poll `/link/token/get` until a session finishes, and exchange its
 *      `public_token` for an `access_token` + stable `item_id`
 *      (`/item/public_token/exchange`);
 *   4. persist the item credential per-account and return its `AccountId`
 *      (the `item_id`). One session connects one bank; another bank is
 *      another add, and a bank already connected here is refused.
 *
 * Because Plaid owns the whole browser leg, an institution that authenticates
 * on its own website redirects back to Plaid rather than to Omnesis: this host
 * serves no callback and needs no reachable public URL.
 *
 * Removing an account revokes the item at Plaid (`/item/remove`) before the
 * local credential is deleted — that call is what ends the item's product
 * subscriptions.
 *
 * Where a connected item's credential lives, and how it is disconnected at
 * Plaid, is `items.ts`. A session that finishes after this flow has stopped
 * listening is settled by `pending-links.ts`, which runs at the top of every
 * add and whenever a source's context is built.
 */

import { rm } from "node:fs/promises";
import { sep } from "node:path";
import {
  createLogger,
  toErrorMessage,
  MissingCredentialsError,
  readProviderCredentials,
} from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure } from "@omnesis/source-sdk";
import { PlaidClient } from "./client.js";
import {
  defaultSleep,
  findItemForInstitution,
  itemDir,
  loadItemCredential,
  plaidDir,
  revokeItem,
  saveItemCredential,
} from "./items.js";
import {
  forgetPendingLink,
  rememberPendingLink,
  settleLinkToken,
  settlePendingLinks,
} from "./pending-links.js";
import { plaidLinkSessionInstitutionSchema } from "./schemas.js";
import { parseCountries, PLAID_ENVIRONMENTS, PLAID_FILE_KEY } from "./types.js";
import type { PlaidClientOptions } from "./client.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  ConnectionState,
} from "@omnesis/source-sdk";
import type { PlaidLinkTokenGetResponse } from "./schemas.js";
import type { PlaidCredentials, PlaidEnvironment } from "./types.js";

const log = createLogger("provider:plaid");

const PROVIDER_DISPLAY_NAME = "Plaid";

/**
 * A stable, install-scoped user handle Plaid associates the Link session with.
 * Not a Plaid credential — Plaid only requires a `client_user_id`; one per
 * install is sufficient because items are keyed by the returned `item_id`.
 */
const PLAID_CLIENT_USER_ID = "omnesis";

// ── Credentials ─────────────────────────────────────────────────────

function isPlaidEnvironment(v: unknown): v is PlaidEnvironment {
  return typeof v === "string" && (PLAID_ENVIRONMENTS as readonly string[]).includes(v);
}

/** Load the operator app credential; throws into the setup wizard when absent. */
export async function loadCredentials(configDir?: string): Promise<PlaidCredentials> {
  const fields = await readProviderCredentials(PLAID_FILE_KEY, configDir);
  if (!fields?.client_id || !fields.secret || !isPlaidEnvironment(fields.environment)) {
    throw new MissingCredentialsError(PLAID_FILE_KEY, PROVIDER_DISPLAY_NAME);
  }
  return {
    client_id: fields.client_id,
    secret: fields.secret,
    environment: fields.environment,
    countries: parseCountries(fields.countries),
  };
}

/** Build a client from stored app credentials, with optional test injections. */
export async function createClient(
  configDir?: string,
  overrides?: Partial<PlaidClientOptions>,
): Promise<PlaidClient> {
  const credentials = await loadCredentials(configDir);
  return new PlaidClient({
    clientId: credentials.client_id,
    secret: credentials.secret,
    environment: credentials.environment,
    countryCodes: credentials.countries,
    ...overrides,
  });
}

/**
 * Remove a connected item: revoke it at Plaid, then delete the local
 * credential.
 *
 * Once the stored token has been read, the local delete always happens, so a
 * half-removed item never resurfaces through `discoverAccounts()`; when the
 * revoke failed, the failure is re-thrown AFTER the delete so the collector
 * surfaces it as a cleanup warning the operator can act on in the Plaid
 * dashboard. A locked secret-store root key is the one exception: the token
 * cannot be read, so the credential is left in place (and the error
 * propagates) rather than deleted unrevoked — a later remove can still revoke it.
 */
export async function cleanupCredentials(
  accountId: string,
  configDir?: string,
  overrides?: Partial<PlaidClientOptions>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const item = loadItemCredential(accountId, configDir);
  let revokeFailure: string | undefined;
  if (item) {
    try {
      const client = await createClient(configDir, overrides);
      revokeFailure = await revokeItem(client, accountId, item.access_token, sleep);
    } catch (err) {
      // No usable app credential — nothing can reach Plaid on this item's behalf.
      revokeFailure = toErrorMessage(err);
    }
  }
  await rm(itemDir(accountId, configDir), { recursive: true, force: true });
  log.info(`Cleaned up Plaid item ${accountId}`);
  if (revokeFailure) {
    throw new Error(
      `Plaid item ${accountId} was removed locally but could not be revoked at Plaid ` +
        `(${revokeFailure}). Remove it from the Plaid dashboard to stop its subscriptions.`,
    );
  }
}

// ── Auth flow (Plaid Hosted Link) ───────────────────────────────────

/** How often the flow asks Plaid whether the hosted session has finished. */
const LINK_POLL_INTERVAL_MS = 2_000;

/**
 * How long one add waits for the user to finish at Plaid's page.
 *
 * The gateway expires an auth flow after fifteen minutes and its clock starts
 * first, so this stays comfortably under that: a flow the gateway has already
 * given up on cannot deliver this message. A session that finishes after the
 * wait cannot report the bank it connected either, which is why the Link token
 * is written down before the wait begins — `pending-links.ts` settles what the
 * wait could not.
 */
const LINK_SESSION_TIMEOUT_MS = 13 * 60 * 1000;

/** The outcome of one hosted Link session. */
interface LinkOutcome {
  /** Present when the session added an item; absent for an update-mode re-consent. */
  publicToken?: string;
  institution: { name?: string; id?: string };
  /** The Link token the session ran on, which is what its record is keyed by. */
  linkToken: string;
}

/**
 * Drive a **Hosted Link** session and register the bank the user connects.
 *
 * Plaid serves the entire sign-in page, so Omnesis hands the user a URL and
 * never embeds a widget, hosts a callback, or handles a bank's OAuth redirect —
 * the leg that has to bounce through the bank's own website happens entirely
 * between the user's browser and Plaid. The flow then polls
 * `/link/token/get` until the session finishes, exchanges its `public_token`
 * for the item's access token, and stores it.
 *
 * A session the user abandons finishes with an exit error, which is re-thrown
 * so the add reports why rather than hanging until the timeout.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  configDir?: string,
  overrides?: Partial<PlaidClientOptions>,
  timing: LinkPollTiming = {},
): Promise<AccountId[]> {
  const client = await createClient(configDir, overrides);

  // Settle anything an earlier add left behind before starting another. A
  // failed add is usually retried straight away, which makes this the first
  // chance to disconnect a bank whose sign-in finished after that add gave up.
  await settlePendingLinks(client, configDir);

  // Re-consent path: a re-auth of an EXISTING item opens Link in update mode,
  // created from the stored access token. The user re-authorizes the SAME
  // item, so the item id — and therefore the Omnesis account id and every row
  // already synced — is preserved, and the consent deadline moves out on the
  // next sync's `/item/get`.
  const reauthAccountId = callbacks?.accountId;
  const existingItem = reauthAccountId ? loadItemCredential(reauthAccountId, configDir) : null;
  if (reauthAccountId && existingItem) {
    await runHostedLink(
      client,
      callbacks,
      { accessToken: existingItem.access_token },
      timing,
      configDir,
    );
    log.info(
      `Re-consented Plaid item ${existingItem.item_id}` +
        (existingItem.institution_name ? ` (${existingItem.institution_name})` : ""),
    );
    return [AccountId(existingItem.item_id)];
  }

  const outcome = await runHostedLink(client, callbacks, {}, timing, configDir);
  if (!outcome.publicToken) {
    throw new AuthFailure(
      "cancelled",
      "Plaid finished the sign-in without returning a bank connection. Try adding the bank again.",
      { remedy: "Add the bank again and finish the sign-in on Plaid's own page." },
    );
  }

  // Refuse a bank this host already has: a second item on the same institution
  // costs a second Plaid subscription and doubles every row, because Plaid
  // mints a distinct item id even for the same login.
  const duplicate = outcome.institution.id
    ? findItemForInstitution(outcome.institution.id, configDir)
    : null;
  if (duplicate) {
    // Plaid created the item the moment the session completed, and the only
    // way to disconnect it is with an access token — so the exchange happens
    // even though the item is about to be thrown away.
    const exchange = await client.itemPublicTokenExchange(outcome.publicToken);
    const failure = await revokeItem(client, exchange.item_id, exchange.access_token);
    if (failure) {
      log.warn(`Could not revoke the duplicate Plaid item ${exchange.item_id}: ${failure}`);
    } else {
      await forgetPendingLink(outcome.linkToken, configDir);
    }
    throw new AuthFailure(
      "duplicate",
      `${outcome.institution.name ?? "That bank"} is already connected to this Omnesis. ` +
        `Remove the existing connection first if you want to reconnect it.`,
      { remedy: "Remove the existing connection first if you want to reconnect this bank." },
    );
  }

  const exchange = await client.itemPublicTokenExchange(outcome.publicToken);
  const branding = outcome.institution.id
    ? await readInstitutionBranding(client, outcome.institution.id)
    : {};
  try {
    saveItemCredential(
      {
        access_token: exchange.access_token,
        item_id: exchange.item_id,
        institution_name: outcome.institution.name,
        institution_id: outcome.institution.id,
        ...branding,
      },
      configDir,
    );
  } catch (err) {
    // The exchange already created a live, billed item at Plaid. Without a
    // stored token nothing could ever revoke it, so revoke it now (best
    // effort) before surfacing the save failure as the add's error.
    const failure = await revokeItem(client, exchange.item_id, exchange.access_token);
    if (failure) {
      log.warn(
        `Could not revoke Plaid item ${exchange.item_id} after a failed credential save: ${failure}`,
      );
    } else {
      await forgetPendingLink(outcome.linkToken, configDir);
    }
    throw err;
  }
  log.info(
    `Connected Plaid item ${exchange.item_id}` +
      (outcome.institution.name ? ` (${outcome.institution.name})` : ""),
  );
  // Clears this add's own record, and disconnects any further bank the same
  // hosted session connected — Plaid's page lets the user go back and link
  // again, and only one of those can become the account this add returns.
  await settleLinkToken(client, outcome.linkToken, configDir, exchange.item_id);
  return [AccountId(exchange.item_id)];
}

/** Injection seam so tests drive the poll loop without real time passing. */
export interface LinkPollTiming {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Mint a hosted Link token, hand the user its URL, and poll until the session
 * finishes. Returns the outcome; throws when the user abandons the session or
 * the wait runs out.
 */
async function runHostedLink(
  client: PlaidClient,
  callbacks: AuthFlowCallbacks | undefined,
  params: { accessToken?: string },
  timing: LinkPollTiming,
  configDir?: string,
): Promise<LinkOutcome> {
  if (!callbacks?.onAuthUrl) {
    throw new AuthFailure(
      "unsupported",
      "Plaid sign-in needs a client that can show a URL; run the add from the portal or the CLI.",
      { remedy: "Run the add from the portal or the CLI." },
    );
  }
  const created = await client.linkTokenCreate({
    clientUserId: PLAID_CLIENT_USER_ID,
    accessToken: params.accessToken,
  });
  if (!created.hosted_link_url) {
    throw new AuthFailure(
      "unsupported",
      "Plaid did not return a hosted sign-in URL. Check that Hosted Link is available on your " +
        "Plaid account, then try again.",
      { remedy: "Enable Hosted Link on your Plaid account, then add the bank again." },
    );
  }
  // From here the session can create an item at Plaid without this flow ever
  // hearing about it, so the token that can still be asked what happened is
  // written down first. Update mode mints no item, so it needs no record.
  if (params.accessToken === undefined) rememberPendingLink(created.link_token, configDir);
  callbacks.onAuthUrl(created.hosted_link_url);

  const pollIntervalMs = timing.pollIntervalMs ?? LINK_POLL_INTERVAL_MS;
  const timeoutMs = timing.timeoutMs ?? LINK_SESSION_TIMEOUT_MS;
  const sleep = timing.sleep ?? defaultSleep;
  const now = timing.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    await sleep(pollIntervalMs);
    const outcome = readSessionOutcome(
      await client.linkTokenGet(created.link_token),
      params.accessToken !== undefined,
    );
    if (outcome) return { ...outcome, linkToken: created.link_token };
    if (now() >= deadline) {
      throw new AuthFailure(
        "timeout",
        `Plaid sign-in was not completed within ${Math.round(timeoutMs / 60_000)} minutes. ` +
          `Start the add again to get a fresh link.`,
        {
          remedy:
            "Start the add again to get a fresh link. A sign-in that finished after the wait " +
            "connected a bank this host never saw; starting another add disconnects it.",
        },
      );
    }
  }
}

/**
 * Read an outcome out of `/link/token/get`, or `null` while the answer is
 * still to come.
 *
 * One Link token accumulates a session per attempt, and Plaid's hosted page
 * lets the user retry after a stumble. So success is looked for across ALL of
 * them first: a user whose second attempt worked must not be failed because
 * their first was abandoned. Only when nothing succeeded AND every session has
 * finished is an abandonment reported, using the last reason Plaid gave.
 *
 * In update mode Plaid mints no `public_token`, so a session that simply
 * finished IS the user having re-authorized. In the new-item flow the same
 * shape means the answer has not landed yet — Plaid can stamp `finished_at`
 * before the result is readable — so it keeps polling rather than failing an
 * add whose item may exist.
 */
function readSessionOutcome(
  response: PlaidLinkTokenGetResponse,
  isUpdate: boolean,
): Omit<LinkOutcome, "linkToken"> | null {
  const sessions = response.link_sessions ?? [];

  for (const session of sessions) {
    const added = session.results?.item_add_results?.find((r) => r.public_token);
    if (added?.public_token) {
      return {
        publicToken: added.public_token,
        institution: readInstitution(added.institution),
      };
    }
    if (session.on_success?.public_token) {
      return {
        publicToken: session.on_success.public_token,
        institution: readInstitution(session.on_success.metadata?.institution),
      };
    }
    // Update mode mints no token, so a finished session IS the re-authorization
    // — unless the user abandoned it, which Plaid reports as an exit on the
    // same session.
    const abandoned = session.exit?.error ?? session.on_exit?.error;
    if (isUpdate && session.finished_at && !abandoned) {
      return { publicToken: undefined, institution: {} };
    }
  }

  if (sessions.length === 0 || sessions.some((s) => !s.finished_at)) return null;

  const lastExit = sessions
    .map((s) => s.exit?.error ?? s.on_exit?.error)
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .pop();
  if (lastExit) {
    // The bank's own wording, which is why this is carried rather than
    // rewritten: it is the only account of what the person signing in saw.
    throw new AuthFailure(
      "cancelled",
      lastExit.display_message ??
        lastExit.error_message ??
        `Plaid sign-in ended without connecting a bank (${lastExit.error_code ?? "unknown"}).`,
      { remedy: "Add the bank again and finish the sign-in on Plaid's own page." },
    );
  }
  return null;
}

/** Pull the institution identity out of a Link session, tolerating its shape. */
function readInstitution(institution: unknown): { name?: string; id?: string } {
  const parsed = plaidLinkSessionInstitutionSchema.safeParse(institution);
  if (!parsed.success) return {};
  return {
    name: parsed.data.name ?? undefined,
    id: parsed.data.institution_id ?? undefined,
  };
}

/**
 * Plaid serves a 152×152 PNG, so anything much larger — or not base64 at all —
 * is not a logo. The icon rides on every sync page the collector sends, and an
 * oversized one is refused at the gateway's boundary, which would fail the
 * page rather than just the picture: better to have no icon at all.
 */
const MAX_LOGO_CHARS = 256 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function usableLogo(logo: string | null | undefined): string | undefined {
  if (!logo || logo.length > MAX_LOGO_CHARS || !BASE64_RE.test(logo)) return undefined;
  return logo;
}

/**
 * The institution's own mark and colour, for the connected instance's icon.
 * Branding is decoration: any failure leaves the instance on the Plaid icon.
 */
async function readInstitutionBranding(
  client: PlaidClient,
  institutionId: string,
): Promise<{ institution_logo?: string; institution_color?: string }> {
  try {
    const { institution } = await client.institutionGetById(institutionId);
    return {
      institution_logo: usableLogo(institution.logo),
      institution_color: institution.primary_color ?? undefined,
    };
  } catch (err) {
    log.debug(`No branding for Plaid institution ${institutionId}: ${toErrorMessage(err)}`);
    return {};
  }
}

// ── The same flow, through the typed session ────────────────────────

/**
 * Connect a bank, or renew the consent on one already connected, driving the
 * hosted Plaid Link session above through the typed authentication session.
 *
 * A thin adapter rather than a second implementation. Plaid's hosted page is
 * the whole of this platform's authorization — there is no pasted secret and no
 * authorize URL a provider could render itself — so what the typed session adds
 * is the vocabulary, not the mechanism: the page is a `redirect` the client is
 * told to open, and the answer comes back through Plaid rather than through the
 * client, which is why it is shown rather than asked.
 */
export async function authenticate(
  session: AuthSession,
  overrides?: Partial<PlaidClientOptions>,
  timing: LinkPollTiming = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;

  // A client that cannot put a link in front of the operator has no way
  // through this flow: the bank is chosen and the password typed on Plaid's
  // page, and nothing here can stand in for it. Refused before the Link token
  // is minted, because a token nobody can open can only time out.
  if (!session.canShow("redirect")) {
    throw new AuthFailure(
      "unsupported",
      "Connecting a bank needs a client that can open Plaid's hosted sign-in page.",
      {
        remedy:
          "Add the bank from the Omnesis portal, or from another client that can open a link.",
      },
    );
  }

  // A renewal renews the item it names. With nothing stored under that id
  // there is no access token to open update mode with, and letting the flow
  // fall through to a first-time add would connect a SECOND Plaid item under a
  // new id — leaving every row already synced attached to an id nothing
  // connects to any more.
  if (session.accountId && !loadItemCredential(session.accountId, configDir)) {
    throw new AuthFailure(
      "unknown",
      `There is no stored Plaid item for ${session.accountId}, so there is nothing to renew.`,
      {
        remedy:
          "Remove this connection and add the bank again. Renewing from here would connect a " +
          "second Plaid item under a new id and orphan everything already synced under this one.",
      },
    );
  }

  let accountIds: AccountId[];
  try {
    accountIds = await authFlow(
      undefined,
      {
        ...(session.accountId ? { accountId: session.accountId } : {}),
        onAuthUrl: (url) => {
          session.show({
            kind: "redirect",
            url,
            title: "Sign in to your bank",
            instructions:
              "Plaid hosts the sign-in. Finish it in the page that opens; this connection " +
              "completes on its own once the bank has confirmed it.",
            // Plaid's page runs the whole exchange and hands the result back
            // through the poll below, so nothing is expected from the client.
            via: "elsewhere",
          });
        },
      },
      configDir,
      overrides,
      timing,
    );
  } catch (err) {
    throw namedFailure(err, configDir);
  }

  const client = await createClient(configDir, overrides);
  const accounts = await Promise.all(
    accountIds.map(async (accountId) => {
      const item = loadItemCredential(String(accountId), configDir);
      return {
        accountId: String(accountId),
        state: item
          ? await connectedState(client, item.access_token)
          : ({ status: "connected" } as ConnectionState),
      };
    }),
  );
  return { accounts };
}

/**
 * Say what ended the flow, in the vocabulary the typed session speaks.
 *
 * Three kinds of thing arrive here. The Plaid client raises typed transport
 * failures, and the kind and scope it stamped on them decide between the
 * operator's own app credential being refused, a bank refusing the person
 * signing in, and Plaid simply being out of reach. The item store raises a
 * filesystem failure, which names the item in the path it would not write.
 *
 * The hosted session's own endings — the wait running out, a bank already
 * connected, an account without Hosted Link, someone closing the page — are
 * raised as typed failures where each of them is known, so they arrive here
 * already named and pass straight through.
 */
function namedFailure(err: unknown, configDir: string | undefined): unknown {
  if (err instanceof AuthFailure) return err;
  // The credentials wizard is opened by this error's own shape, so wrapping it
  // would turn an actionable prompt into a message.
  if (err instanceof MissingCredentialsError) return err;

  const itemId = failedStoreItemId(err, configDir);
  if (itemId) return new PlaidItemPersistFailure(itemId, err);

  if (err instanceof SyncError) return platformFailure(err);

  // Anything else is a defect rather than an outcome: every way this flow can
  // end says so at the point it ends. Reporting it as unavailable is what
  // stops an unrecognised failure being read as the operator having changed
  // their mind, which is the one arm that would look like nothing went wrong.
  return new AuthFailure("unavailable", toErrorMessage(err), {
    remedy: "Try adding the bank again; if it keeps failing the logs name what stopped it.",
  });
}

/** A typed Plaid transport failure, in the session's vocabulary. */
function platformFailure(err: SyncError): AuthFailure {
  if (err.kind === "auth") {
    // One app credential serves every connected bank, which is why the client
    // marks its refusal connection-scoped. That is the operator's own client
    // id or secret being rejected, not a bank refusing the person signing in.
    if (err.scope === "connection") {
      return new AuthFailure("credential-rejected", err.message, {
        remedy:
          "Check the Plaid client ID and secret for this environment in the Plaid dashboard — " +
          "a secret issued for one environment is refused by the others.",
      });
    }
    return new AuthFailure("denied", err.message, {
      remedy: "Sign in again at the bank and grant access to the accounts Omnesis should read.",
    });
  }
  if (err.kind === "rate-limit" || err.kind === "transient" || err.kind === "network") {
    return new AuthFailure("unavailable", err.message, {
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      remedy: "Plaid could not be reached. Add the bank again in a few minutes.",
    });
  }
  return new AuthFailure("unknown", err.message);
}

/**
 * The item whose credential could not be stored, when the store is what failed.
 *
 * Every item is written to `<configDir>/plaid/<item_id>/item.json`, so a
 * filesystem failure names the item in the path it refused — and that id is
 * the one thing the operator needs, because Plaid created the item before the
 * store was ever asked. A failure anywhere else did not come from the store.
 */
function failedStoreItemId(err: unknown, configDir: string | undefined): string | undefined {
  const path = (err as { path?: unknown } | null)?.path;
  if (typeof path !== "string") return undefined;
  const root = plaidDir(configDir) + sep;
  if (!path.startsWith(root)) return undefined;
  return path.slice(root.length).split(sep)[0] || undefined;
}

/**
 * A credential that could not be stored, in both vocabularies at once.
 *
 * The typed session reports failures as `AuthFailure`, and the credential
 * plumbing recognises a persist failure structurally — by its code, the file
 * key it belongs to and the account it was for. One failure answering to only
 * one of the two is one the other silently reads as an unclassified throw, so
 * this answers to both.
 */
class PlaidItemPersistFailure extends AuthFailure {
  readonly fileKey = PLAID_FILE_KEY;
  readonly accountId: string;

  constructor(accountId: string, cause: unknown) {
    super(
      "credential-persist-failed",
      `Connected Plaid item ${accountId}, but could not store its credential: ` +
        toErrorMessage(cause),
      {
        remedy:
          `Make the Omnesis configuration directory writable and add the bank again. Plaid ` +
          `created item ${accountId} during this attempt and Omnesis tried to disconnect it; ` +
          `if it is still listed in the Plaid dashboard, remove it there so it stops billing.`,
      },
    );
    this.accountId = accountId;
  }
}

/**
 * What the platform says about a live item, so the host does not have to ask a
 * question the flow has just answered. Plaid reports a consent deadline on the
 * item, and losing it here would mean the operator is warned only once the
 * consent has already lapsed.
 */
async function connectedState(client: PlaidClient, accessToken: string): Promise<ConnectionState> {
  try {
    const { item } = await client.itemGet(accessToken);
    const expiresAt = item.consent_expiration_time ?? undefined;
    return expiresAt ? { status: "connected", expiresAt } : { status: "connected" };
  } catch (err) {
    log.warn(
      `Could not read the Plaid consent deadline (${toErrorMessage(err)}); reporting the ` +
        `connection without one`,
    );
    return { status: "connected" };
  }
}
