// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { Passkeys } from "../src/passkeys.js";
import { testPasskeyAuthorization } from "./account-admission.js";
import { passkeyAuthenticator } from "./passkey-authenticator.js";
import type { OmnesisAccounts } from "../src/omnesis-accounts.js";

export const fixtureBrowser = () =>
  `__Host-omnesis-account-browser=${randomBytes(32).toString("base64url")}`;

/** Adds a real passkey to an existing account, outside any operation. */
export async function registeredPasskey(
  accounts: OmnesisAccounts,
  account: { accountId: string; version: number },
  origin = "https://relay.example.test",
) {
  const passkeys = new Passkeys(accounts, { origin }),
    authenticator = passkeyAuthenticator(),
    binding = randomBytes(32).toString("base64url");
  const begun = await passkeys.beginRegistration(
    binding,
    account,
    "Fixture passkey",
    testPasskeyAuthorization(accounts, account),
  );
  const parked = await passkeys.finishRegistration(
    begun.ceremonyId,
    binding,
    authenticator.registration(begun.options.challenge),
  );
  if (!("endorse" in parked)) throw new Error("Expected a passkey waiting to be vouched for");
  // A fixture token stands in for the Google sign-in that vouches for the new passkey.
  const cookie = `__Host-omnesis-account-browser=${binding}`,
    endorsements = passkeys.endorsements;
  endorsements.recordProof(parked.endorse, cookie, {
    type: "google",
    accountId: account.accountId,
    idToken: "fixture-google-token",
    nonce: endorsements.googleProofNonce(parked.endorse, cookie),
  });
  endorsements.complete(parked.endorse, cookie, account);
  passkeys.close();
  return { authenticator, userHandle: begun.options.user.id };
}

/** The sign-in a browser performs on an operation page. Returns the session cookie it set. */
export async function signInOnOperation(
  url: string,
  query: string,
  operationCookie: string,
  passkey: Awaited<ReturnType<typeof registeredPasskey>>,
  origin = "https://relay.example.test",
): Promise<string> {
  const headers = {
    origin,
    cookie: `${operationCookie}; ${fixtureBrowser()}`,
    "content-type": "application/json",
  };
  const begun = await fetch(url + "/_relay/account/api/passkeys/authenticate/options" + query, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (!begun.ok) throw new Error(`Passkey options refused with ${begun.status}`);
  const ceremony = await begun.json();
  const completed = await fetch(
    url + "/_relay/account/api/passkeys/authenticate/complete" + query,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ceremonyId: ceremony.ceremonyId,
        credential: passkey.authenticator.authentication(
          ceremony.options.challenge,
          passkey.userHandle,
        ),
      }),
    },
  );
  if (!completed.ok) throw new Error(`Passkey sign-in refused with ${completed.status}`);
  return (completed.headers.getSetCookie()[0] ?? "").split(";")[0]!;
}
