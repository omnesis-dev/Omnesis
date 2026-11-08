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
import { google } from "googleapis";
import {
  BrokerCredentialError,
  toErrorMessage,
  type BrokerBinding,
  type BrokerCredentialResult,
  type BrokeredCredentials,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { googleApiStatus, mapGoogleApiError } from "./api-error.js";
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
 * What the Google account behind one token says about itself: the address
 * it answers to, and for Contacts the account's own person id. Either may be
 * missing when the token cannot say.
 */
interface GoogleAccountAnswer {
  email?: string;
  person?: string;
}

/** A client that presents one fixed access token and never refreshes it. */
function tokenClient(accessToken: string): OAuth2Client {
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: accessToken });
  return client;
}

function asEmail(value: unknown): string | undefined {
  return typeof value === "string" && EMAIL.test(value) ? value : undefined;
}

const ACCOUNT_PROBES: Record<
  GoogleBrokerPurpose,
  (auth: OAuth2Client) => Promise<GoogleAccountAnswer>
> = {
  // The lookup the sign-in itself makes, so an account with Gmail linked is
  // stored exactly where a sign-in would have stored it.
  gmail: async (auth) => ({
    email: asEmail(
      (await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" })).data
        .emailAddress,
    ),
  }),
  drive: async (auth) => ({
    email: asEmail(
      (await google.drive({ version: "v3", auth }).about.get({ fields: "user(emailAddress)" })).data
        .user?.emailAddress,
    ),
  }),
  // A primary calendar's id is its owner's address.
  calendar: async (auth) => ({
    email: asEmail(
      (await google.calendar({ version: "v3", auth }).calendars.get({ calendarId: "primary" })).data
        .id,
    ),
  }),
  // Google documents no scope under which `people/me` must list the account's
  // own address, and a contacts-only grant is not one that promises it: the
  // answer may come back without addresses. Only an address Google attributes
  // to the account itself counts; one from the person's public profile or a
  // contact card would name whoever wrote it there. The resource name of
  // `people/me` is the account's own person id, which is recorded at link
  // time so a later token can be checked against it without an address.
  contacts: async (auth) => {
    const person = (
      await google
        .people({ version: "v1", auth })
        .people.get({ resourceName: "people/me", personFields: "emailAddresses" })
    ).data;
    const own = (person.emailAddresses ?? []).filter((e) => e.metadata?.source?.type === "ACCOUNT");
    return {
      email: asEmail((own.find((e) => e.metadata?.primary) ?? own[0])?.value),
      person:
        typeof person.resourceName === "string" && /^people\/[^/\s]+$/.test(person.resourceName)
          ? person.resourceName
          : undefined,
    };
  },
};

async function probeAccount(
  credentials: BrokeredCredentials,
  purpose: GoogleBrokerPurpose,
): Promise<GoogleAccountAnswer> {
  try {
    return await ACCOUNT_PROBES[purpose](brokeredGoogleClient(credentials, purpose));
  } catch (err) {
    // The broker's own failures already say which connection and why.
    if (err instanceof SyncError) throw err;
    // A Contacts grant Google will not answer `people/me` for cannot vouch
    // for the account; the caller decides what that means.
    if (purpose === "contacts" && googleApiStatus(err) === 403) return {};
    throw new Error(
      `Google would not say which account the ${googleBrokerPurposeLabel(purpose)} connection belongs to: ${toErrorMessage(err)}`,
      { cause: err },
    );
  }
}

/** The binding parameter that records the Contacts connection's person id. */
export const GOOGLE_CONTACTS_PERSON_PARAM = "contactsPerson";

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
): Promise<{ accountId: string; params?: Record<string, string> }> {
  const linked = GOOGLE_BROKER_PURPOSES.filter((p) => credentials.has(p.id));
  if (linked.length === 0) {
    throw new BrokerCredentialError(
      "unbound",
      "No Gmail, Google Calendar, Google Drive or Google Contacts connection is linked",
    );
  }
  const answers = await Promise.all(
    linked.map(async (p) => ({
      id: p.id,
      label: p.label,
      ...(await probeAccount(credentials, p.id)),
    })),
  );
  // Every sync checks each connection still belongs to this account (see
  // `verifyGoogleIdentity`); one that can say nothing about its account
  // could be signed in again as someone else without anyone noticing.
  const ref = (id: string) => {
    const c = credentials.binding.connections[id];
    return c ? `${c.providerConfigKey}/${c.connectionId}` : undefined;
  };
  // A purpose linked to the same connection as one that names its account is
  // the same grant and the same token, so that purpose's answer covers it;
  // `verifyGoogleIdentity` asks the same question with its own token later.
  const sharesNamed = (a: (typeof answers)[number]) =>
    a.id === "contacts" &&
    answers.some((b) => b.id !== a.id && b.email !== undefined && ref(b.id) === ref(a.id));
  const silent = answers
    .filter((a) => !a.email && !a.person && !sharesNamed(a))
    .map((a) => a.label);
  if (silent.length > 0) {
    throw new Error(
      `Google will not say which account the linked ${silent.join(", ")} connection belongs to, ` +
        "so Omnesis could not notice it being signed in again as someone else; leave it out",
    );
  }
  const named = answers.filter(
    (a): a is (typeof answers)[number] & { email: string } => a.email !== undefined,
  );
  const supplied = params.account?.trim();
  const person = answers.find((a) => a.id === "contacts")?.person;
  const recorded = person ? { params: { [GOOGLE_CONTACTS_PERSON_PARAM]: person } } : {};

  if (named.length === 0) {
    const labels = linked.map((p) => p.label).join(", ");
    if (!supplied) {
      throw new Error(
        `The linked ${labels} connection cannot say which Google account it belongs to; ` +
          "give the account's email address as `account`, or link its Gmail, Calendar or Drive too",
      );
    }
    if (!EMAIL.test(supplied)) throw new Error(`${supplied} is not an email address`);
    return { accountId: supplied.toLowerCase(), ...recorded };
  }

  const [first, ...rest] = named as [(typeof named)[number], ...typeof named];
  // A connection that cannot name its account is not vouched for by the ones
  // that can: it may be another person's grant. It joins them only when the
  // operator states the account, which is then checked against the rest.
  const unverified = answers
    .filter((a) => a.email === undefined && !sharesNamed(a))
    .map((a) => a.label);
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
  return { accountId: first.email, ...recorded };
}

/**
 * The other purposes of `binding` linked to the same broker connection as
 * `purpose`, among those that can name their account. The same connection
 * hands out the same grant, so their probes asked with `purpose`'s own token
 * say whose token it is when `purpose`'s own probe cannot (Contacts under
 * `contacts.readonly`).
 */
function sharedConnectionPurposes(
  binding: BrokerBinding,
  purpose: GoogleBrokerPurpose,
): GoogleBrokerPurpose[] {
  const mine = binding.connections[purpose];
  if (!mine) return [];
  return (["gmail", "calendar", "drive"] as const).filter((id) => {
    if (id === purpose) return false;
    const other = binding.connections[id];
    return (
      other?.providerConfigKey === mine.providerConfigKey &&
      other.connectionId === mine.connectionId
    );
  });
}

/**
 * Ask Google, with `token` alone, who the account behind it is, using the
 * `asked` purpose's question. A Contacts grant Google will not answer
 * `people/me` for says nothing rather than failing, as at link time.
 */
async function askGoogle(
  known: { id: GoogleBrokerPurpose; label: string },
  asked: GoogleBrokerPurpose,
  token: string,
): Promise<GoogleAccountAnswer> {
  try {
    return await ACCOUNT_PROBES[asked](tokenClient(token));
  } catch (err) {
    if (asked === "contacts" && googleApiStatus(err) === 403) return {};
    const mapped = mapGoogleApiError(err);
    throw new SyncError(
      mapped.kind,
      `Could not confirm which Google account the broker's ${known.label} connection belongs to: ${mapped.message}`,
      {
        cause: err,
        retryAfterMs: mapped.retryAfterMs,
        scope: mapped.scope,
        quota: mapped.quota,
      },
    );
  }
}

/**
 * The first answer naming an account from the purposes sharing `known`'s
 * connection, each asked with `token`. One that fails is passed over for the
 * next, so a Gmail limit or a Gmail switched off does not stop Contacts while
 * Calendar or Drive on the same grant can answer; when none answers, the
 * first failure is reported.
 */
async function askShared(
  known: { id: GoogleBrokerPurpose; label: string },
  siblings: GoogleBrokerPurpose[],
  token: string,
  fallback: GoogleAccountAnswer,
): Promise<GoogleAccountAnswer> {
  let failure: unknown;
  for (const sibling of siblings) {
    try {
      const answer = await askGoogle(known, sibling, token);
      if (answer.email) return answer;
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return fallback;
}

/**
 * Check each token the broker hands out still belongs to `accountId`, for
 * {@link BrokeredCredentials}' `verify` option.
 *
 * Every purpose asks Google who the token's account is with that token
 * alone (never through the broker client, whose refresh this runs inside):
 * the address Gmail, Calendar, Drive or Contacts reports must be the
 * account's, and the person id Contacts reports must be the one recorded at
 * link time. A token for which neither can be checked is refused as well,
 * so a connection signed in again at the broker as someone else, or one
 * Google stops naming, never syncs under this account. The answer is kept
 * per purpose for the token it was given for, so a token the broker hands
 * out again is not asked about twice; a refused or unanswered one is not
 * kept. A probe Google fails is reported with the kind Google's answer
 * maps to, so an outage is retried and a withdrawn grant needs attention.
 */
export function verifyGoogleIdentity(
  accountId: string,
  binding: () => BrokerBinding,
): (purpose: string, result: BrokerCredentialResult) => Promise<void> {
  const verified = new Map<string, string>();
  return async (purpose, { credential }) => {
    const known = GOOGLE_BROKER_PURPOSES.find((p) => p.id === purpose);
    if (!known) {
      throw new BrokerCredentialError(
        "unsupported",
        `Google account ${accountId} links a ${purpose} connection Omnesis does not know`,
      );
    }
    if (credential.type !== "oauth2") {
      throw new BrokerCredentialError(
        "unsupported",
        `The broker's ${known.label} connection holds ${credential.type === "api-key" ? "an API key" : "a login"}, not a Google OAuth token`,
      );
    }
    const token = credential.accessToken;
    if (verified.get(purpose) === token) return;

    let answer = await askGoogle(known, known.id, token);
    // Contacts cannot always name its account; on a connection it shares with
    // Gmail, Calendar or Drive the token is that grant's, so their question
    // asked with this same token answers for it.
    const recordedPerson = binding().params?.[GOOGLE_CONTACTS_PERSON_PARAM];
    if (known.id === "contacts" && !answer.email && !(answer.person && recordedPerson)) {
      answer = await askShared(known, sharedConnectionPurposes(binding(), known.id), token, answer);
    }

    const checks: boolean[] = [];
    if (answer.email) checks.push(answer.email.toLowerCase() === accountId.toLowerCase());
    if (answer.person && recordedPerson) checks.push(answer.person === recordedPerson);
    if (checks.includes(false)) {
      throw new BrokerCredentialError(
        "identity-changed",
        `The broker's ${known.label} connection now belongs to another Google account, not ${accountId}; link it again with \`omnesis broker link\``,
      );
    }
    if (checks.length === 0) {
      throw new BrokerCredentialError(
        "identity-changed",
        `Google will not say which account the broker's ${known.label} connection belongs to, so Omnesis cannot confirm it is still ${accountId}; link it again with \`omnesis broker link\``,
      );
    }
    verified.set(purpose, token);
  };
}

/** How a Google account takes its grants from the credential broker. */
export const googleBrokerSpec: ProviderBrokerSpec = {
  fileKey: "google",
  purposes: [...GOOGLE_BROKER_PURPOSES],
  params: [{ name: "account", label: "Google account email", required: false }],
  resolveAccount: resolveGoogleBrokerAccount,
  verify: (accountId, binding) => verifyGoogleIdentity(accountId, () => binding),
};
