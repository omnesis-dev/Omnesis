// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { testPasskeyAuthorization } from "../test/account-admission.js";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { passkeyCountersignatureNonce, passkeyProofChallenge } from "./device-enrollment.js";
import { GatewaySignInVerifier } from "./gateway-sign-in-proof.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { Passkeys } from "./passkeys.js";

const origin = "https://relay.example.test";
const browser = () => randomBytes(32).toString("base64url");
const cookieFor = (binding: string) => `__Host-omnesis-account-browser=${binding}`;
type Finished = Awaited<ReturnType<Passkeys["finishRegistration"]>>;
/** A new account's first passkey is stored at once. */
function stored(result: Finished) {
  if ("endorse" in result) throw new Error("Expected a stored passkey");
  return result;
}
/** A passkey for an existing account is held under this name until a sign-in vouches for it. */
function held(result: Finished): string {
  if (!("endorse" in result)) throw new Error("Expected a held passkey");
  return result.endorse;
}
/** Creates a passkey for an existing account and leaves it waiting to be vouched for. */
async function park(
  service: Passkeys,
  accounts: OmnesisAccounts,
  account: { accountId: string; version: number },
  label = "Passkey",
) {
  const authenticator = passkeyAuthenticator(),
    binding = browser();
  const begin = await service.beginRegistration(
    binding,
    account,
    label,
    testPasskeyAuthorization(accounts, account),
  );
  const endorse = held(
    await service.finishRegistration(
      begin.ceremonyId,
      binding,
      authenticator.registration(begin.options.challenge),
    ),
  );
  return { authenticator, binding, endorse, cookie: cookieFor(binding), begin };
}
/** The account's Google sign-in vouches for a held passkey, which stores it. */
function vouchWithGoogle(
  service: Passkeys,
  parked: { endorse: string; cookie: string },
  account: { accountId: string; version: number },
) {
  service.endorsements.recordProof(parked.endorse, parked.cookie, {
    type: "google",
    accountId: account.accountId,
    idToken: "fictional-google-token",
    nonce: service.endorsements.googleProofNonce(parked.endorse, parked.cookie),
  });
  return service.endorsements.complete(parked.endorse, parked.cookie, account);
}

test("a real synced passkey creates a provider-independent account and authenticates without Google", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    const authenticator = passkeyAuthenticator(),
      binding = browser();
    const begin = await service.beginRegistration(
      binding,
      undefined,
      "Passkey",
      testPasskeyAuthorization(accounts),
    );
    expect(begin.options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    const response = authenticator.registration(begin.options.challenge);
    const session = stored(await service.finishRegistration(begin.ceremonyId, binding, response));
    expect(session.accountId).toMatch(/^[a-f0-9]{64}$/);
    expect(accounts.list(session.accountId)).toMatchObject({
      federated: [],
      passkeys: [{ id: authenticator.id, label: "Passkey", backedUp: true }],
    });
    for (let index = 0; index < 2; index++) {
      const login = await service.beginAuthentication(binding);
      const assertion = authenticator.authentication(
        login.options.challenge,
        begin.options.user.id,
      );
      expect(
        await service.finishAuthentication(login.ceremonyId, binding, assertion),
      ).toMatchObject({ accountId: session.accountId, version: session.version });
      await expect(
        service.finishAuthentication(login.ceremonyId, binding, assertion),
      ).rejects.toThrow("unavailable");
    }
    service.close();
  } finally {
    db.close();
  }
});

test("a passkey added to an existing account is held until a sign-in the account already has vouches for it", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    const google = "a".repeat(64),
      accountId = accounts.signInFederated("google", google);
    const account = { accountId, version: 1 };
    expect(accounts.signInFederated("google", google)).toBe(accountId);
    // Registration verifies the new passkey and stores nothing.
    const first = await park(service, accounts, account, "Passkey 1");
    expect(first.begin.options.user.id).toBe(Buffer.from(accountId, "hex").toString("base64url"));
    expect(first.endorse).toMatch(/^[0-9a-f-]{36}$/);
    expect(accounts.passkey(first.authenticator.id)).toBeUndefined();
    expect(accounts.list(accountId).passkeys).toEqual([]);
    expect(service.endorsements.endorsers(first.endorse, first.cookie)).toEqual([]);
    // The account's Google sign-in vouches for it, and that sign-in is kept with the passkey.
    expect(vouchWithGoogle(service, first, account)).toEqual({ id: first.authenticator.id });
    expect(accounts.list(accountId).passkeys).toMatchObject([
      { id: first.authenticator.id, label: "Passkey 1" },
    ]);
    expect(accounts.passkeyKeys(accountId)[0]!.endorsement).toMatchObject({
      type: "google",
      idToken: "fictional-google-token",
    });
    // A second passkey is vouched for by the first, and the browser is offered only that one.
    const second = await park(service, accounts, account, "Passkey 2");
    const endorsers = service.endorsements.endorsers(second.endorse, second.cookie);
    expect(endorsers).toEqual([first.authenticator.id]);
    const login = await service.beginAuthentication(
      second.binding,
      service.endorsements.proofCommitment(second.endorse, second.cookie),
      endorsers,
    );
    expect(login.options.allowCredentials).toEqual([
      expect.objectContaining({ id: first.authenticator.id }),
    ]);
    const evidence = await service.finishAuthentication(
      login.ceremonyId,
      second.binding,
      first.authenticator.authentication(login.options.challenge, first.begin.options.user.id),
    );
    service.endorsements.recordProof(second.endorse, second.cookie, {
      type: "passkey",
      accountId: evidence.accountId,
      challenge: evidence.challenge,
      credential: evidence.credential,
      credentialPublicKey: evidence.credentialPublicKey,
    });
    service.endorsements.complete(second.endorse, second.cookie, account);
    const keys = accounts.passkeyKeys(accountId);
    expect(keys.map((key) => key.id).sort()).toEqual(
      [first.authenticator.id, second.authenticator.id].sort(),
    );
    expect(keys.find((key) => key.id === second.authenticator.id)!.endorsement).toMatchObject({
      type: "passkey",
      credential: { id: first.authenticator.id },
    });
    // Without a list the browser may offer any passkey.
    expect((await service.beginAuthentication(browser())).options.allowCredentials).toBeUndefined();
    const other = accounts.signInFederated("google", "b".repeat(64));
    expect(() => accounts.linkFederated(other, "google", google)).toThrow(
      "another Omnesis account",
    );
    expect(accounts.federatedAccount("google", google)).toBe(accountId);
    // Shutdown forgets every passkey still waiting.
    const waiting = await park(service, accounts, account, "Passkey 3");
    service.close();
    expect(() => service.endorsements.describe(waiting.endorse, waiting.cookie)).toThrow(
      "no longer waiting",
    );
  } finally {
    db.close();
  }
});

test("the passkey being added countersigns the account's other sign-ins with its own key, and nothing else can", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    const google = "a".repeat(64),
      accountId = accounts.signInFederated("google", google),
      account = { accountId, version: 1 };
    // A passkey added before countersignatures existed is stored without one.
    const first = await park(service, accounts, account, "Passkey 1");
    vouchWithGoogle(service, first, account);
    expect(accounts.passkeyKeys(accountId)[0]).not.toHaveProperty("countersignature");
    const firstKey = accounts.passkeyKeys(accountId)[0]!.publicKey;
    const second = await park(service, accounts, account, "Passkey 2");
    expect(service.endorsements.describe(second.endorse, second.cookie)).toMatchObject({
      needsCountersignature: true,
    });
    // It commits to the sign-ins the account had when the passkey was created.
    const { commitment } = service.endorsements.countersigning(second.endorse, second.cookie);
    const signIns = {
      google: [google],
      passkeys: [{ id: first.authenticator.id, publicKey: firstKey }],
    };
    expect(commitment.nonce).toBe(passkeyCountersignatureNonce(accountId, signIns));
    const handle = second.begin.options.user.id;
    const ceremony = () =>
      service.beginCountersignature(second.binding, second.endorse, second.cookie);
    const begin = await ceremony();
    // Only the new passkey is offered, and the challenge is the commitment a gateway recomputes.
    expect(begin.options.allowCredentials).toEqual([
      expect.objectContaining({ id: second.authenticator.id }),
    ]);
    expect(begin.options.challenge).toBe(
      passkeyProofChallenge(commitment.salt, commitment.issuedAt, commitment.nonce),
    );
    const finish = (
      ceremonyId: string,
      response: unknown,
      binding = second.binding,
      endorse = second.endorse,
      cookie = second.cookie,
    ) => service.finishCountersignature(ceremonyId, binding, endorse, cookie, response);
    // The account's other passkey can't sign in the new one's place, even for the right challenge.
    await expect(
      finish(begin.ceremonyId, first.authenticator.authentication(begin.options.challenge, handle)),
    ).rejects.toThrow("did not sign");
    for (const attempt of [
      // A signature over anything else.
      async (id: string) => finish(id, second.authenticator.authentication("d3Jvbmc", handle, 1)),
      // Another account's user handle.
      async (id: string, challenge: string) =>
        finish(
          id,
          second.authenticator.authentication(
            challenge,
            Buffer.alloc(32, 7).toString("base64url"),
            1,
          ),
        ),
      // Another browser, or the passkey waiting under another name.
      async (id: string, challenge: string) =>
        finish(id, second.authenticator.authentication(challenge, handle, 1), browser()),
      async (id: string, challenge: string) =>
        finish(
          id,
          second.authenticator.authentication(challenge, handle, 1),
          second.binding,
          first.endorse,
        ),
    ]) {
      const attemptBegin = await ceremony();
      await expect(
        attempt(attemptBegin.ceremonyId, attemptBegin.options.challenge),
      ).rejects.toThrow(/did not sign|unavailable/);
    }
    expect(service.endorsements.describe(second.endorse, second.cookie)).toMatchObject({
      needsCountersignature: true,
    });
    // The new passkey's own signature is kept, and the ceremony can't be used twice.
    const signing = await ceremony(),
      signature = second.authenticator.authentication(signing.options.challenge, handle, 5);
    await finish(signing.ceremonyId, signature);
    await expect(finish(signing.ceremonyId, signature)).rejects.toThrow("unavailable");
    expect(service.endorsements.describe(second.endorse, second.cookie)).toMatchObject({
      needsCountersignature: false,
      needsProof: true,
    });
    vouchWithGoogle(service, second, account);
    const stored = accounts
      .passkeyKeys(accountId)
      .find((key) => key.id === second.authenticator.id)!;
    expect(stored.countersignature).toEqual({
      proof: {
        type: "passkey",
        salt: commitment.salt,
        issuedAt: commitment.issuedAt,
        credential: signature,
      },
      ...signIns,
    });
    // It reached counter 5, so the stored passkey starts from there.
    expect(accounts.passkey(second.authenticator.id)!.credential.counter).toBe(5);
    // A gateway that pinned the new passkey verifies it, and learns the account's other sign-ins.
    const verifier = new GatewaySignInVerifier({
      google: () => undefined,
      relayOrigin: () => origin,
      passkeyOrigins: () => [],
      trusted: () => [],
    });
    const pin = {
      type: "passkey" as const,
      id: stored.id,
      publicKey: stored.publicKey,
      addedAt: 1,
      source: "link-page" as const,
    };
    expect(
      await verifier.verifyCountersignature(stored.countersignature, stored, accountId, [pin]),
    ).toEqual(signIns);
    // Removing the passkey removes its countersignature with it.
    accounts.removePasskey(accountId, second.authenticator.id, ["google"], account.version);
    expect(
      db.prepare("SELECT count(*) AS count FROM omnesis_passkey_countersignatures").get(),
    ).toEqual({ count: 0 });
    service.close();
  } finally {
    db.close();
  }
});

test("registration rejects origin, challenge, user-verification, replay and browser-binding substitution", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    for (const attack of ["origin", "challenge", "uv", "rawId"]) {
      const authenticator = passkeyAuthenticator(),
        binding = browser();
      const begin = await service.beginRegistration(
        binding,
        undefined,
        "Passkey",
        testPasskeyAuthorization(accounts),
      );
      const response = authenticator.registration(
        attack === "challenge" ? "wrong" : begin.options.challenge,
        attack === "origin" ? "https://unrelated.example.test" : origin,
        attack === "uv" ? 0x59 : 0x5d,
      );
      if (attack === "rawId") response.rawId = "other";
      await expect(
        service.finishRegistration(begin.ceremonyId, browser(), response),
      ).rejects.toThrow("unavailable");
      await expect(service.finishRegistration(begin.ceremonyId, binding, response)).rejects.toThrow(
        "did not complete",
      );
      await expect(service.finishRegistration(begin.ceremonyId, binding, response)).rejects.toThrow(
        "unavailable",
      );
    }
    expect(
      (db.prepare("SELECT count(*) AS count FROM omnesis_accounts").get() as { count: number })
        .count,
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("real assertion verification rejects substituted identity, signatures, RP, origin, challenge and user verification", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    const authenticator = passkeyAuthenticator(),
      binding = browser();
    const registration = await service.beginRegistration(
      binding,
      undefined,
      "Passkey",
      testPasskeyAuthorization(accounts),
    );
    await service.finishRegistration(
      registration.ceremonyId,
      binding,
      authenticator.registration(registration.options.challenge),
    );
    for (const attack of [
      "rawId",
      "unknown",
      "short-handle",
      "handle",
      "signature",
      "origin",
      "challenge",
      "uv",
      "rp",
    ]) {
      const login = await service.beginAuthentication(binding);
      const response = (
        attack === "rp" ? passkeyAuthenticator("other.example.test") : authenticator
      ).authentication(
        attack === "challenge" ? "wrong-challenge" : login.options.challenge,
        registration.options.user.id,
        0,
        attack === "origin" ? "https://unrelated.example.test" : origin,
        attack === "uv" ? 0x19 : 0x1d,
      );
      if (attack === "rawId") response.rawId = "other";
      if (attack === "unknown") {
        response.id = "unknown";
        response.rawId = "unknown";
      }
      if (attack === "short-handle") response.response.userHandle = "short";
      if (attack === "handle") response.response.userHandle = browser();
      if (attack === "signature") {
        const signature = Buffer.from(response.response.signature, "base64url");
        signature[signature.length - 1]! ^= 1;
        response.response.signature = signature.toString("base64url");
      }
      if (attack === "rp") {
        response.id = authenticator.id;
        response.rawId = authenticator.id;
      }
      await expect(
        service.finishAuthentication(login.ceremonyId, binding, response),
      ).rejects.toThrow("did not complete");
    }
    expect(accounts.passkey(authenticator.id)!.revision).toBe(1);
  } finally {
    db.close();
  }
});

test("invalid self attestation cannot create an account", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin }),
      binding = browser();
    const registration = await service.beginRegistration(
      binding,
      undefined,
      "Passkey",
      testPasskeyAuthorization(accounts),
    );
    await expect(
      service.finishRegistration(
        registration.ceremonyId,
        binding,
        passkeyAuthenticator().registration(
          registration.options.challenge,
          origin,
          0x5d,
          "invalid-self",
        ),
      ),
    ).rejects.toThrow("did not complete");
    expect(db.prepare("SELECT count(*) AS count FROM omnesis_accounts").get()).toEqual({
      count: 0,
    });
  } finally {
    db.close();
  }
});

test("ceremony limits, expiry, purpose and shutdown bound both generation and verification", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      binding = browser();
    for (const options of [
      { maxPending: 0 },
      { ceremonyTtlMs: 0 },
      { ceremonyTtlMs: 300001 },
      { androidOrigins: ["android:apk-key-hash:invalid"] },
    ])
      expect(() => new Passkeys(accounts, { origin, ...options })).toThrow();
    let now = Date.now();
    const service = new Passkeys(accounts, {
      origin,
      now: () => now,
      ceremonyTtlMs: 100,
      maxPending: 1,
    });
    await expect(service.beginAuthentication("invalid")).rejects.toThrow("Browser binding");
    const registration = await service.beginRegistration(
      binding,
      undefined,
      "Passkey",
      testPasskeyAuthorization(accounts),
    );
    await expect(service.beginAuthentication(binding)).rejects.toThrow("Too many");
    await expect(
      service.finishAuthentication(registration.ceremonyId, binding, {}),
    ).rejects.toThrow("unavailable");
    now += 101;
    await expect(service.finishRegistration(registration.ceremonyId, binding, {})).rejects.toThrow(
      "expired",
    );
    await service.beginAuthentication(binding);
    now += 101;
    expect((await service.beginAuthentication(binding)).ceremonyId).toBeTruthy();
    service.close();
    await expect(
      service.beginRegistration(binding, undefined, "Passkey", testPasskeyAuthorization(accounts)),
    ).rejects.toThrow("closed");
    for (const kind of ["registration", "authentication"] as const) {
      const closing = new Passkeys(accounts, { origin });
      const generating =
        kind === "registration"
          ? closing.beginRegistration(
              binding,
              undefined,
              "Passkey",
              testPasskeyAuthorization(accounts),
            )
          : closing.beginAuthentication(binding);
      closing.close();
      await expect(generating).rejects.toThrow("closed");
    }
  } finally {
    db.close();
  }
});

test("expired or closed verification and account revocation cannot commit a pending registration", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      binding = browser();
    for (const attack of ["closed", "expired", "revoked"] as const) {
      let now = Date.now();
      const service = new Passkeys(accounts, { origin, now: () => now, ceremonyTtlMs: 100 });
      const accountId = accounts.signInFederated(
        "google",
        (attack === "closed" ? "a" : attack === "expired" ? "b" : "c").repeat(64),
      );
      const account = { accountId, version: 1 },
        authenticator = passkeyAuthenticator();
      accounts.registerPasskey(
        accountId,
        {
          credential: { id: `${attack}-spare`, publicKey: new Uint8Array([1]), counter: 0 },
          label: "Spare",
          deviceType: "singleDevice",
          backedUp: false,
        },
        false,
      );
      const authorization = testPasskeyAuthorization(accounts, account);
      const pending = await service.beginRegistration(binding, account, "Passkey", authorization);
      if (attack === "revoked") accounts.removePasskey(accountId, `${attack}-spare`, ["google"]);
      const result = service.finishRegistration(
        pending.ceremonyId,
        binding,
        authenticator.registration(pending.options.challenge),
      );
      if (attack === "closed") service.close();
      if (attack === "expired") now += 101;
      await expect(result).rejects.toThrow("did not complete");
      expect(accounts.passkey(authenticator.id)).toBeUndefined();
      if (attack === "revoked")
        await expect(
          service.beginRegistration(binding, account, "Passkey", authorization),
        ).rejects.toThrow("Sign in again");
    }
  } finally {
    db.close();
  }
});

test("passkey removal while real assertion verification is in flight cannot authenticate a revoked credential", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      binding = browser(),
      service = new Passkeys(accounts, { origin });
    const accountId = accounts.signInFederated("google", "d".repeat(64));
    const parked = await park(service, accounts, { accountId, version: 1 });
    vouchWithGoogle(service, parked, { accountId, version: 1 });
    const authenticator = parked.authenticator;
    const login = await service.beginAuthentication(binding);
    const pending = service.finishAuthentication(
      login.ceremonyId,
      binding,
      authenticator.authentication(login.options.challenge, parked.begin.options.user.id),
    );
    accounts.removePasskey(accountId, authenticator.id, ["google"]);
    await expect(pending).rejects.toThrow("did not complete");
  } finally {
    db.close();
  }
});

test("adding a passkey requires the account session that started it to stay signed in through verification", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db);
    const account = { accountId: accounts.signInFederated("google", "d".repeat(64)), version: 1 };
    for (const attack of ["logout-before", "logout-during"] as const) {
      const service = new Passkeys(accounts, { origin });
      const authorization = testPasskeyAuthorization(accounts, account);
      if (authorization.kind !== "account-session") throw new Error("Expected account session");
      const binding = browser(),
        authenticator = passkeyAuthenticator();
      const begin = await service.beginRegistration(binding, account, "Extra", authorization);
      const response = authenticator.registration(begin.options.challenge);
      if (attack === "logout-before")
        accounts.revokeSession(account.accountId, authorization.sessionId);
      const finishing = service.finishRegistration(begin.ceremonyId, binding, response);
      if (attack === "logout-during")
        accounts.revokeSession(account.accountId, authorization.sessionId);
      await expect(finishing).rejects.toThrow("did not complete");
      expect(accounts.passkey(authenticator.id)).toBeUndefined();
      service.close();
    }
    // A gateway admission is no authority over an existing account, and neither is nothing at all.
    const service = new Passkeys(accounts, { origin });
    for (const authorization of [testPasskeyAuthorization(accounts), undefined])
      await expect(
        service.beginRegistration(browser(), account, "Extra", authorization),
      ).rejects.toThrow("Sign in again");
    service.close();
  } finally {
    db.close();
  }
});

test("anonymous and revoked gateway admissions cannot allocate persistent passkey accounts", async () => {
  const db = new Database(":memory:");
  try {
    const accounts = new OmnesisAccounts(db),
      service = new Passkeys(accounts, { origin });
    await expect(service.beginRegistration(browser())).rejects.toThrow("Start account setup");
    const authorization = testPasskeyAuthorization(accounts);
    if (authorization.kind !== "gateway-owner") throw new Error("Expected gateway admission");
    const binding = browser(),
      authenticator = passkeyAuthenticator();
    const begin = await service.beginRegistration(binding, undefined, "First", authorization);
    authorization.admission.assertCurrent = () => {
      throw new Error("Gateway ownership revoked");
    };
    await expect(
      service.finishRegistration(
        begin.ceremonyId,
        binding,
        authenticator.registration(begin.options.challenge),
      ),
    ).rejects.toThrow("did not complete");
    expect(accounts.canAdmitGateway(authorization.admission.gatewayId)).toBe(true);
    expect(accounts.passkey(authenticator.id)).toBeUndefined();
    authorization.admission.assertCurrent = () => {};
    const retry = await service.beginRegistration(binding, undefined, "First", authorization);
    await service.finishRegistration(
      retry.ceremonyId,
      binding,
      authenticator.registration(retry.options.challenge),
    );
    const created = accounts.passkey(authenticator.id)!.accountId;
    // The gateway may start over until it is linked to its account; after that it holds the one.
    expect(accounts.canAdmitGateway(authorization.admission.gatewayId)).toBe(true);
    accounts.linkGateway(created, authorization.admission.ownerAccountId, "c".repeat(43));
    expect(accounts.canAdmitGateway(authorization.admission.gatewayId)).toBe(false);
    await expect(
      service.beginRegistration(binding, undefined, "Duplicate", authorization),
    ).rejects.toThrow("already allocated");
    expect(accounts.passkey(authenticator.id)?.accountId).toBe(created);
    service.close();
  } finally {
    db.close();
  }
});
