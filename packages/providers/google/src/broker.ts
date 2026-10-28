// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Google accounts whose grants the credential broker holds.
 *
 * A sign-in here asks for all four scopes in one consent and stores one token
 * that every source shares. At the broker each Google API is its own
 * connection, with its own grant and scopes (Nango catalogues `google-mail`,
 * `google-calendar`, `google-drive` and `google-contacts` separately), so a
 * brokered account binds one connection per API and each source calls Google
 * with the token of its own. An account links any subset of the four.
 */
import { google, type people_v1 } from "googleapis";
import { BrokerCredentialError, toErrorMessage, type BrokeredCredentials } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { googleApiStatus } from "./api-error.js";
import type { ProviderBrokerSpec } from "@omnesis/source-sdk";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** The broker connection a Google source takes its token from. */
export type GoogleBrokerPurpose = "gmail" | "calendar" | "drive" | "contacts";

/**
 * Each purpose, in the order an operator is asked for them. The generic
 * `google` catalogue entry fits every purpose: an operator who keeps one
 * Google connection with all four scopes binds it to each.
 */
export const GOOGLE_BROKER_PURPOSES: ReadonlyArray<{
  id: GoogleBrokerPurpose;
  label: string;
  brokerProviders: string[];
  required: false;
}> = [
  { id: "gmail", label: "Gmail", brokerProviders: ["google-mail", "google"], required: false },
  {
    id: "calendar",
    label: "Google Calendar",
    brokerProviders: ["google-calendar", "google"],
    required: false,
  },
  {
    id: "drive",
    label: "Google Drive",
    brokerProviders: ["google-drive", "google"],
    required: false,
  },
  {
    id: "contacts",
    label: "Google Contacts",
    brokerProviders: ["google-contacts", "google"],
    required: false,
  },
];

/** What an operator calls a purpose ("Gmail"). */
export function googleBrokerPurposeLabel(purpose: GoogleBrokerPurpose): string {
  return GOOGLE_BROKER_PURPOSES.find((p) => p.id === purpose)?.label ?? purpose;
}

/**
 * A client for one purpose's broker connection.
 *
 * It holds no refresh token and no OAuth client id: whenever its access token
 * is missing or inside google-auth-library's eager-refresh window (five
 * minutes), the library calls `refreshHandler` instead of Google's token
 * endpoint, and that asks the broker. `BrokeredCredentials` reuses a token
 * until five minutes before it expires, so the two windows coincide and a
 * token the broker rotates is picked up on the next refresh. A token the
 * broker gives no expiry for is marked due at once, so every request asks
 * `BrokeredCredentials`, whose own cache decides when that reaches the broker.
 *
 * Nothing is persisted: the library emits `tokens` only after a refresh it
 * made against Google itself, which this client never makes, and no listener
 * is attached in any case.
 *
 * `forceRefreshOnFailure` is left off. Google keeps an access token valid
 * until it expires even after a newer one is minted, so a 401 on a token the
 * broker still hands out means the grant was withdrawn, which a forced refresh
 * cannot mend; and the library's retry also fires on every 403, which here is
 * mostly a quota answer that a second request would only spend more of. The
 * failure reaches `mapGoogleApiError` as it does for a signed-in account.
 */
export function brokeredGoogleClient(
  credentials: BrokeredCredentials,
  purpose: GoogleBrokerPurpose,
): OAuth2Client {
  const client = new google.auth.OAuth2();
  client.refreshHandler = async () => {
    const { credential } = await credentials.get(purpose);
    if (credential.type !== "oauth2") {
      throw new BrokerCredentialError(
        "unsupported",
        `The broker's ${googleBrokerPurposeLabel(purpose)} connection holds ${credential.type === "api-key" ? "an API key" : "a login"}, not a Google OAuth token`,
      );
    }
    return {
      access_token: credential.accessToken,
      expiry_date: credential.expiresAt ?? Date.now(),
    };
  };
  return client;
}

/** The client of every purpose this account links. */
export function brokeredGoogleClients(
  credentials: BrokeredCredentials,
): Map<GoogleBrokerPurpose, OAuth2Client> {
  const clients = new Map<GoogleBrokerPurpose, OAuth2Client>();
  for (const { id } of GOOGLE_BROKER_PURPOSES) {
    if (credentials.has(id)) clients.set(id, brokeredGoogleClient(credentials, id));
  }
  return clients;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * The address the Google account behind a purpose's token answers to, or
 * `undefined` when that token cannot say.
 */
const ACCOUNT_PROBES: Record<GoogleBrokerPurpose, (auth: OAuth2Client) => Promise<unknown>> = {
  // The lookup the sign-in itself makes, so an account with Gmail linked is
  // stored exactly where a sign-in would have stored it.
  gmail: async (auth) =>
    (await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" })).data
      .emailAddress,
  drive: async (auth) =>
    (await google.drive({ version: "v3", auth }).about.get({ fields: "user(emailAddress)" })).data
      .user?.emailAddress,
  // A primary calendar's id is its owner's address.
  calendar: async (auth) =>
    (await google.calendar({ version: "v3", auth }).calendars.get({ calendarId: "primary" })).data
      .id,
  // Google documents no scope under which `people/me` must list the account's
  // own address, and a contacts-only grant is not one that promises it: the
  // answer may come back without addresses, or be refused, and then this
  // purpose cannot vouch for the account. Only an address Google attributes
  // to the account itself counts; one from the person's public profile or a
  // contact card would name whoever wrote it there.
  contacts: async (auth) => {
    let person: people_v1.Schema$Person;
    try {
      person = (
        await google
          .people({ version: "v1", auth })
          .people.get({ resourceName: "people/me", personFields: "emailAddresses" })
      ).data;
    } catch (err) {
      if (googleApiStatus(err) === 403) return undefined;
      throw err;
    }
    const own = (person.emailAddresses ?? []).filter((e) => e.metadata?.source?.type === "ACCOUNT");
    return (own.find((e) => e.metadata?.primary) ?? own[0])?.value;
  },
};

async function probeAccount(
  credentials: BrokeredCredentials,
  purpose: GoogleBrokerPurpose,
): Promise<string | undefined> {
  let found: unknown;
  try {
    found = await ACCOUNT_PROBES[purpose](brokeredGoogleClient(credentials, purpose));
  } catch (err) {
    // The broker's own failures already say which connection and why.
    if (err instanceof SyncError) throw err;
    throw new Error(
      `Google would not say which account the ${googleBrokerPurposeLabel(purpose)} connection belongs to: ${toErrorMessage(err)}`,
      { cause: err },
    );
  }
  return typeof found === "string" && EMAIL.test(found) ? found : undefined;
}

/**
 * Which Google account the linked connections belong to.
 *
 * Every linked purpose that can name its account is asked, and they must all
 * name the same one: connections of two different people bound under one
 * account would interleave two mailboxes, calendars or drives in one place.
 * The id is the address as the first of them reports it, Gmail first, which
 * is what the sign-in stores an account under. A purpose that cannot say
 * (Contacts, usually) is accepted only with the operator's `account`: alone,
 * it is taken on trust; beside purposes that can, it must match them.
 */
export async function resolveGoogleBrokerAccount(
  credentials: BrokeredCredentials,
  params: Record<string, string>,
): Promise<{ accountId: string }> {
  const linked = GOOGLE_BROKER_PURPOSES.filter((p) => credentials.has(p.id));
  if (linked.length === 0) {
    throw new BrokerCredentialError(
      "unbound",
      "No Gmail, Google Calendar, Google Drive or Google Contacts connection is linked",
    );
  }
  const answers = await Promise.all(
    linked.map(async (p) => ({ label: p.label, email: await probeAccount(credentials, p.id) })),
  );
  const named = answers.filter((a): a is { label: string; email: string } => a.email !== undefined);
  const supplied = params.account?.trim();

  if (named.length === 0) {
    const labels = linked.map((p) => p.label).join(", ");
    if (!supplied) {
      throw new Error(
        `The linked ${labels} connection cannot say which Google account it belongs to; ` +
          "give the account's email address as `account`, or link its Gmail, Calendar or Drive too",
      );
    }
    if (!EMAIL.test(supplied)) throw new Error(`${supplied} is not an email address`);
    return { accountId: supplied.toLowerCase() };
  }

  const [first, ...rest] = named as [{ label: string; email: string }, ...typeof named];
  // A connection that cannot name its account is not vouched for by the ones
  // that can: it may be another person's grant. It joins them only when the
  // operator states the account, which is then checked against the rest.
  const unverified = answers.filter((a) => a.email === undefined).map((a) => a.label);
  if (unverified.length > 0 && !supplied) {
    throw new Error(
      `The linked ${unverified.join(", ")} connection cannot say which Google account it belongs to; ` +
        `give \`account=${first.email}\` to confirm it is that account's, or leave it out`,
    );
  }
  const others = supplied ? [...rest, { label: "the account given", email: supplied }] : rest;
  for (const other of others) {
    if (other.email.toLowerCase() !== first.email.toLowerCase()) {
      throw new Error(
        `The ${first.label} connection belongs to ${first.email}, but ${other.label} is ${other.email}; ` +
          "link connections of one Google account",
      );
    }
  }
  return { accountId: first.email };
}

/** How a Google account takes its grants from the credential broker. */
export const googleBrokerSpec: ProviderBrokerSpec = {
  fileKey: "google",
  purposes: [...GOOGLE_BROKER_PURPOSES],
  params: [{ name: "account", label: "Google account email", required: false }],
  resolveAccount: resolveGoogleBrokerAccount,
};
