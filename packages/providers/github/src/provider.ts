// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  clearProviderAccountAndLegacyCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  hasProviderCredentials,
  listProviderAccountDirs,
  listProviderAccountIds,
  loadOrAdoptProviderAccountCredentials,
  MissingCredentialsError,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import {
  AuthFailure,
  config as configSchema,
  credentialsChallenge,
  type AuthFlowCallbacks,
  type AuthResult,
  type AuthSession,
  type SourceLifecycleContext,
} from "@omnesis/source-sdk";
import { GithubClient } from "./client.js";
import { githubCredentialsSpec } from "./credentials-spec.js";

const log = createLogger("provider:github");

const GITHUB_FILE_KEY = "github";

/**
 * Characters a label may use. Account ids become directory names, so the
 * label excludes separators and anything the branded `AccountId` rejects.
 */
export const ACCOUNT_LABEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The account id for a token: the GitHub login, or `login@label` when the
 * operator named the connection.
 *
 * A label is needed because one person can hold several tokens that see
 * different worlds — a fine-grained token is bound to a single resource
 * owner, so an organization's private repositories need their own token —
 * and every one of those tokens authenticates as the same login. The
 * resource owner is not reported by any API the token can call: alongside
 * its grant a token also reads public repositories the user is affiliated
 * with, so the owners of the repositories it can list say nothing reliable
 * about the scope it was issued for. Hence the label is declared, not
 * inferred; unlabelled connections keep the bare login they have always had.
 */
export function accountIdFor(login: string, label?: string): string {
  const lower = login.toLowerCase();
  if (label === undefined || label.trim() === "") return lower;
  const trimmed = label.trim();
  if (!ACCOUNT_LABEL_REGEX.test(trimmed)) {
    throw new Error(
      `Account label "${trimmed}" is not usable: use letters, digits, dashes or underscores ` +
        `(for example the organization name).`,
    );
  }
  return `${lower}@${trimmed.toLowerCase()}`;
}

/** The login portion of an account id, with any label stripped. */
export function accountLogin(accountId: string): string {
  return accountId.toLowerCase().split("@")[0];
}

/** Load one account's stored token. */
export async function loadToken(accountId: string, configDir?: string): Promise<string> {
  const fields = await loadOrAdoptProviderAccountCredentials(GITHUB_FILE_KEY, accountId, configDir);
  if (!fields?.token) throw new MissingCredentialsError(GITHUB_FILE_KEY, "GitHub");
  return fields.token;
}

/** Whether this account's token is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  if (hasProviderAccountCredentials(GITHUB_FILE_KEY, accountId, configDir)) return true;
  if (listProviderAccountIds(GITHUB_FILE_KEY, configDir).length > 0) return false;
  return hasProviderCredentials(GITHUB_FILE_KEY, configDir);
}

/**
 * Validate a pasted token against `GET /user`, resolve the account (the
 * GitHub login), and store the token under that account. Nothing is written
 * until the probe succeeds, so a bad token leaves no trace.
 */
/**
 * Connect a GitHub account.
 *
 * The token is asked for rather than pre-collected, which is what lets a
 * re-authentication offer a fresh one instead of failing because the stored
 * credential is the very thing that stopped working. The account id is derived
 * from whoever the token authenticates as, so a token belonging to a different
 * login is refused rather than silently rebinding an existing source to
 * somebody else's repositories.
 */
export async function authenticate(session: AuthSession): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;

  // A client of the older shape collected the token on a wizard before the
  // flow started. Asking again would be asking twice; asking only when it is
  // absent is what makes both clients work from one code path.
  const challenge = credentialsChallenge(githubCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect a GitHub account",
    instructions:
      "Paste a personal access token. A fine-grained token needs read access to the " +
      "repositories you want indexed; a classic token needs the repo scope.",
  });
  // A second token for the same person is a separate account, and only the
  // operator can say so: a fine-grained token is bound to one resource owner
  // and no API it can call will name that owner. Asked here rather than left
  // on a settings form, because by the time the form is filled in the account
  // it would have named has already been resolved.
  if (!reauthAccountId) {
    challenge.schema = configSchema.object({
      ...challenge.schema.fields,
      accountLabel: configSchema.string({
        label: "Connection name (optional)",
        help:
          "Only for a second token for the same GitHub user, such as one scoped to an " +
          "organization. Name it after that scope.",
        placeholder: "acme-org",
        pattern: ACCOUNT_LABEL_REGEX.source,
        patternHint:
          "Use letters, digits, dashes or underscores — for example the organization name.",
      }),
    });
  }

  const suppliedToken = session.supplied.token?.trim();
  const answered = suppliedToken ? session.supplied : await session.ask(challenge);
  const token = String(answered.token ?? "");
  if (!token) throw new MissingCredentialsError(GITHUB_FILE_KEY, "GitHub");
  const accountLabel = String(answered.accountLabel ?? "").trim() || undefined;

  session.show({ kind: "wait", title: "Checking the token" });

  let login: string;
  let name: string | null | undefined;
  try {
    ({ login, name } = await new GithubClient(token).getUser());
  } catch (err) {
    // A token GitHub rejects is the operator's to fix; anything else is
    // GitHub being unreachable, which clears on its own.
    const message = err instanceof Error ? err.message : String(err);
    throw new AuthFailure(/\b401\b|unauthor/i.test(message) ? "denied" : "unavailable", message);
  }

  if (reauthAccountId && accountLogin(reauthAccountId) !== login.toLowerCase()) {
    throw new AuthFailure(
      "identity-mismatch",
      `This token belongs to GitHub account ${login}, not ${reauthAccountId}.`,
      { remedy: "Add it as a separate source instead of re-authenticating this one." },
    );
  }
  const accountId = reauthAccountId
    ? AccountId(reauthAccountId)
    : AccountId(accountIdFor(login, accountLabel));

  if (!reauthAccountId && hasCredentials(String(accountId), configDir)) {
    log.warn(
      `Replacing the stored token for GitHub account ${accountId}. If this is a second token ` +
        `with a different scope, remove this source and add it again with a connection name, ` +
        `so the two keep separate accounts.`,
    );
  }

  try {
    await writeProviderAccountCredentials(GITHUB_FILE_KEY, String(accountId), { token }, configDir);
  } catch (err) {
    throw new AuthFailure(
      "credential-persist-failed",
      `Authenticated as ${login}, but the token could not be stored: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  log.info(
    `Authenticated with GitHub as ${name ?? login} (account ${accountId}, token ${fingerprint(token)})`,
  );
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
): Promise<AccountId> {
  const configDir = ctx?.configDir;
  const reauthAccountId = callbacks?.accountId;
  const token =
    callbacks?.credentials?.token ??
    (reauthAccountId
      ? (await loadOrAdoptProviderAccountCredentials(GITHUB_FILE_KEY, reauthAccountId, configDir))
          ?.token
      : undefined);
  if (!token) throw new MissingCredentialsError(GITHUB_FILE_KEY, "GitHub");

  const { login, name } = await new GithubClient(token).getUser();
  const derived = AccountId(accountIdFor(login, _params?.accountLabel));

  // A re-auth refreshes the account it was invoked for. Compare the login
  // rather than the whole account id, since a labelled account carries a
  // scope the token itself cannot report. Refusing a token belonging to a
  // different login keeps a re-auth from silently rebinding an existing
  // source to somebody else's repositories.
  if (reauthAccountId && accountLogin(reauthAccountId) !== login.toLowerCase()) {
    throw new Error(
      `This token belongs to GitHub account ${login}, not ${reauthAccountId}. ` +
        `Add it as a separate source instead of re-authenticating this one.`,
    );
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : derived;

  // Every token for one person authenticates as that person, so a second
  // token connected without a name resolves here to the account the first
  // one already owns and replaces its credential — after which the first
  // token's repositories quietly leave the listing. Re-adding an account to
  // replace a rotated token is legitimate and reaches this same path, so
  // this cannot refuse; it says plainly what it is about to do.
  if (!reauthAccountId && hasCredentials(String(accountId), configDir)) {
    log.warn(
      `Replacing the stored token for GitHub account ${accountId}. If this is a second token ` +
        `with a different scope, remove this source and add it again with a connection name, ` +
        `so the two keep separate accounts.`,
    );
  }

  try {
    await writeProviderAccountCredentials(GITHUB_FILE_KEY, String(accountId), { token }, configDir);
  } catch (err) {
    throw new CredentialPersistError(GITHUB_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with GitHub as ${name ?? login} (account ${accountId}, token ${fingerprint(token)})`,
  );
  return accountId;
}

/** Non-reversible token fingerprint for log lines. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Resolve configured accounts offline — the provider-instantiation path
 * derives its instances from this alone, so it must never hit the network.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const stored = listProviderAccountIds(GITHUB_FILE_KEY, configDir);
  if (stored.length > 0) return stored.map((id) => AccountId(id));
  if (!hasProviderCredentials(GITHUB_FILE_KEY, configDir)) return [];
  return listProviderAccountDirs(GITHUB_FILE_KEY, configDir).flatMap((name) => {
    try {
      return [AccountId(name)];
    } catch {
      return [];
    }
  });
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountAndLegacyCredentials(GITHUB_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up GitHub credentials for account ${accountId}`);
}
