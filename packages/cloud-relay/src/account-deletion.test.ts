// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { listen, tlsFiles } from "../test/support.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { RelayAccounts } from "./accounts.js";
import { GatewayUnregistered, registerGatewayKey } from "./gateway-key-client.js";
import { releaseGateway } from "./gateway-release.js";
import { gatewayKeyAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { RelaySessions } from "./identity.js";
import { createCloudRelay, type CloudRelayOptions } from "./server.js";
import type { AcmeDnsChallenges } from "./acme-dns.js";
import type { RecoveryReceipt } from "./recovery-contract.js";

const origin = "https://relay.example.test";
const domain = "relay.example.test";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-account-deletion-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Every row of every table in the relay database, so a table added later is looked at too. */
function everyRow(path: string): Map<string, string[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return new Map(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM ${name}`)
          .all()
          .map((row) => JSON.stringify(row)),
      ]),
    );
  } finally {
    db.close();
  }
}

const released = (gatewayId: string) =>
  `sha256:${createHash("sha256").update(`omnesis-released-gateway:${gatewayId}`).digest("hex")}`;

/** A gateway registered with its own owner key under a hosted name, as a signup leaves it. */
function registeredGateway(
  accounts: RelayAccounts,
  certificate: string,
  receipt?: RecoveryReceipt,
) {
  const key = generateKeyPairSync("ed25519").publicKey,
    gatewayId = randomUUID(),
    hostname = hostedGatewayHostname(gatewayId, domain);
  const owner = gatewayKeyAccount({
    gatewayId,
    ownerPublicKey: key.export({ format: "pem", type: "spki" }).toString(),
  });
  accounts.registerKeyBinding(
    owner,
    {
      gatewayId,
      publicOrigin: `https://${hostname}`,
      certificate,
      identityToken:
        KEY_BINDING_PREFIX + key.export({ format: "der", type: "spki" }).toString("base64url"),
    },
    true,
    receipt,
  );
  return { owner, gatewayId, hostname };
}

test("deleting an account removes every row about it and its gateways, in every table, and leaves another account alone", async () => {
  const path = join(directory, "relay.sqlite");
  const accounts = new RelayAccounts(path),
    identities = accounts.identities,
    sessions = new RelaySessions(randomBytes(32));
  const certificate = await readFile(tlsFiles(directory, "*.relay.example.test").certFile, "utf8");
  try {
    const receipt = { fixture: "recovery-receipt" } as unknown as RecoveryReceipt;
    const first = registeredGateway(accounts, certificate, receipt),
      second = registeredGateway(accounts, certificate),
      other = registeredGateway(accounts, certificate);
    const digest = "a".repeat(64),
      legacy = "b".repeat(64),
      passkey = "fixture-deleted-passkey";
    // The account its first gateway created, with Google and a vouched-for passkey that
    // countersigned the Google sign-in.
    const account = identities.signInFederated("google", digest, {
      gatewayId: first.gatewayId,
      ownerAccountId: first.owner,
      assertCurrent() {},
    });
    identities.bindGoogleAliases(digest, [digest, legacy]);
    identities.registerPasskey(
      account,
      {
        credential: { id: passkey, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        deviceType: "multiDevice",
        backedUp: true,
        label: "Fixture passkey",
      },
      false,
      undefined,
      undefined,
      { type: "google", idToken: "fixture-token", salt: "c".repeat(43) },
      {
        proof: {
          type: "passkey",
          salt: "d".repeat(43),
          issuedAt: "1793318400",
          credential: {
            id: passkey,
            rawId: passkey,
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: "Zml4dHVyZQ",
              authenticatorData: "Zml4dHVyZQ",
              signature: "Zml4dHVyZQ",
              userHandle: "Zml4dHVyZQ",
            },
          },
        },
        google: [digest],
        passkeys: [],
      },
    );
    identities.registerSession(account, 1, randomUUID(), Math.floor(Date.now() / 1000) + 600);
    for (const gateway of [first, second])
      identities.linkGateway(
        account,
        gateway.owner,
        sessions.sealAccountGatewayLink(origin, account, gateway.owner),
      );
    // An association from before accounts existed, and a sign-in that never registered a gateway.
    accounts.linkGoogleAccount(legacy, second.owner);
    accounts.registerAccount(digest);
    // Somebody else's account and gateway.
    const kept = identities.signInFederated("google", "e".repeat(64), {
      gatewayId: other.gatewayId,
      ownerAccountId: other.owner,
      assertCurrent() {},
    });
    identities.linkGateway(
      kept,
      other.owner,
      sessions.sealAccountGatewayLink(origin, kept, other.owner),
    );
    const before = everyRow(path);
    const named = (rows: Map<string, string[]>, value: string) =>
      [...rows].filter(([, values]) => values.some((row) => row.includes(value))).map(([t]) => t);
    // The fixture really did put the account or its gateways in every table there is.
    const about = [account, digest, legacy, passkey, first.owner, second.owner, first.gatewayId];
    expect([...before.keys()].filter((table) => !table.startsWith("sqlite_"))).toEqual(
      [...new Set(about.flatMap((value) => named(before, value)))].sort(),
    );

    // A session from before a sign-in method changed deletes nothing.
    expect(() => accounts.deleteAccount(account, 2)).toThrow("Account changed; sign in again");
    expect(everyRow(path)).toEqual(before);
    expect(accounts.registered(first.owner)).toBe(true);
    expect(accounts.deleteAccount(account, 1).sort()).toEqual(
      [first.owner, second.owner, digest, legacy].sort(),
    );

    const after = everyRow(path);
    for (const value of [...about, second.gatewayId]) expect(named(after, value)).toEqual([]);
    // A hosted name keeps a digest in place of its gateway's id: it routes nowhere, nobody else
    // can be granted it, and the same gateway may ask for its address again.
    expect(after.get("relay_hosted_names")!.sort()).toEqual(
      [
        JSON.stringify({ hostname: first.hostname, gateway_id: released(first.gatewayId) }),
        JSON.stringify({ hostname: second.hostname, gateway_id: released(second.gatewayId) }),
        JSON.stringify({ hostname: other.hostname, gateway_id: other.gatewayId }),
      ].sort(),
    );
    for (const gateway of [first, second]) {
      expect(accounts.registered(gateway.owner)).toBe(false);
      expect(accounts.accountForHostname(gateway.hostname)).toBeUndefined();
      expect(accounts.hostnameAvailable(gateway.hostname, gateway.gatewayId)).toBe(true);
      expect(accounts.hostnameAvailable(gateway.hostname, randomUUID())).toBe(false);
    }
    // Nothing of the other account went with it.
    for (const [table, rows] of before)
      expect(after.get(table)).toEqual(
        expect.arrayContaining(
          rows.filter((row) => row.includes(kept) || row.includes(other.owner)),
        ),
      );
    expect(identities.gatewayLinks(kept)).toHaveLength(1);
    expect(accounts.accountForHostname(other.hostname)).toBe(other.owner);
    // There is no account left to delete, and the sign-in can be used for a new one.
    expect(() => accounts.deleteAccount(account)).toThrow("Omnesis account sign-in required");
    expect(identities.federatedAccount("google", digest)).toBeUndefined();
    expect(identities.canAdmitGateway(first.gatewayId)).toBe(true);
  } finally {
    accounts.close();
  }
});

async function relayWithGateway(extra: Partial<CloudRelayOptions> = {}) {
  const accounts = new RelayAccounts(join(directory, "relay.sqlite")),
    sessions = new RelaySessions(randomBytes(32));
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    relayDomain: domain,
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
    },
    ...extra,
  });
  const url = await listen(relay.server);
  const gatewayId = randomUUID(),
    hostname = hostedGatewayHostname(gatewayId, domain),
    tls = tlsFiles(directory, hostname);
  const enrollmentTokenFile = join(directory, "invitation.json");
  const options = {
    relayUrl: origin,
    sessionFile: join(directory, "session.json"),
    gatewayId,
    publicOrigin: `https://${hostname}`,
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
    enrollmentTokenFile,
    fetch: (async (input, init) =>
      fetch(`${url}${new URL(String(input)).pathname}`, init)) as typeof fetch,
  };
  await writeFile(
    enrollmentTokenFile,
    JSON.stringify({
      enrollmentToken: await sessions.issueEnrollmentInvitation(gatewayId, origin),
    }),
  );
  const gateway = await registerGatewayKey(options);
  // The person's account, linked to the gateway, and their signed-in browser.
  const account = accounts.identities.signInFederated("google", "a".repeat(64), {
    gatewayId,
    ownerAccountId: gateway.accountId,
    assertCurrent() {},
  });
  accounts.identities.linkGateway(
    account,
    gateway.accountId,
    sessions.sealAccountGatewayLink(origin, account, gateway.accountId),
  );
  const signedIn = await sessions.issueAccountSession(
    { accountId: account, version: 1 },
    "passkey",
    origin,
  );
  accounts.identities.registerSession(account, 1, signedIn.sessionId, signedIn.expiresAt);
  const page = await fetch(url + "/_relay/account");
  const cookie = `${page.headers.getSetCookie()[0]!.split(";")[0]}; __Host-omnesis-account=${signedIn.token}`;
  const tunnel = (token: string) =>
    new WebSocket(url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-omnesis-tunnel-protocol": "2",
        "x-omnesis-gateway-id": gatewayId,
      },
    });
  return {
    accounts,
    sessions,
    url,
    options,
    enrollmentTokenFile,
    gateway,
    account,
    hostname,
    tunnel,
    deleteAccount: () =>
      fetch(url + "/_relay/account/api/delete", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ accountId: account }),
      }),
    session: () =>
      fetch(url + "/_relay/account/api/session", { headers: { cookie } }).then(
        (response) => response.json() as Promise<{ authenticated: boolean }>,
      ),
    async close() {
      await relay.close();
      accounts.close();
    },
  };
}

test("deleting from the account page drops the gateway's live tunnel, refuses its session and tells its next registration that it is gone", async () => {
  const forget = vi.fn(async () => {
    throw new Error("Fixture DNS provider is down");
  });
  const f = await relayWithGateway({
    acmeDns: { forget, close: async () => {} } as unknown as AcmeDnsChallenges,
  });
  try {
    const live = f.tunnel(f.gateway.token);
    await new Promise<void>((resolve, reject) => {
      live.once("message", () => resolve());
      live.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => live.once("close", () => resolve()));
    expect(await f.session()).toMatchObject({ authenticated: true, accountId: f.account });

    const deleted = await f.deleteAccount();
    expect(deleted.status).toBe(200);
    await closed;
    expect(await f.session()).toEqual(expect.objectContaining({ authenticated: false }));
    expect(f.accounts.identities.sessionVersion(f.account)).toBeUndefined();
    expect(f.accounts.accountForHostname(f.hostname)).toBeUndefined();
    expect(f.accounts.snapshot()).toMatchObject({ accounts: 0, gatewayBindings: 0 });
    // A lease it may have held is dropped; a DNS provider failure does not undo the deletion.
    expect(forget).toHaveBeenCalledWith(f.gateway.accountId);

    // Its session token is still validly signed, and still opens nothing: 401 makes the gateway
    // prove its keys again instead of retrying the same token.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = f.tunnel(f.gateway.token);
      socket.on("error", () => {});
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode!);
        response.resume();
        socket.terminate();
      });
      socket.once("open", () => reject(new Error("A deleted gateway reopened its tunnel")));
    });
    expect(status).toBe(401);
    // Proving its keys gets the one answer that means "you are no longer registered here"...
    await expect(registerGatewayKey(f.options)).rejects.toBeInstanceOf(GatewayUnregistered);
    // ...and neither that nor its spent invitation registers it again or brings the account back.
    expect(f.accounts.snapshot()).toMatchObject({ accounts: 0, gatewayBindings: 0 });
    expect(f.accounts.identities.snapshot()).toMatchObject({
      identityAccounts: 0,
      identityGatewayLinks: 0,
    });
    // A gateway that was never registered here is simply refused: it has nothing to forget.
    await expect(
      registerGatewayKey({
        ...f.options,
        sessionFile: join(directory, "never-enrolled.json"),
        enrollmentTokenFile: undefined,
      }),
    ).rejects.toThrow("Gateway key registration refused");
  } finally {
    await f.close();
  }
});

test("a relay without managed DNS deletes the same way, and a gateway whose id someone else holds is only refused", async () => {
  const f = await relayWithGateway();
  try {
    // Another owner key claiming this registered gateway id is refused, not told it is gone.
    await expect(
      registerGatewayKey({
        ...f.options,
        sessionFile: join(directory, "imposter.json"),
        ownerKeyFile: join(directory, "imposter.key"),
        enrollmentTokenFile: undefined,
      }),
    ).rejects.toThrow("Gateway key registration refused");
    expect((await f.deleteAccount()).status).toBe(200);
    expect(f.accounts.registered(f.gateway.accountId)).toBe(false);
    await expect(registerGatewayKey(f.options)).rejects.toBeInstanceOf(GatewayUnregistered);
  } finally {
    await f.close();
  }
});

test("a gateway its owner disconnects loses its registration and tunnel, while the account and its other gateway stay", async () => {
  const forget = vi.fn(async () => {});
  const f = await relayWithGateway({
    acmeDns: { forget, close: async () => {} } as unknown as AcmeDnsChallenges,
  });
  try {
    const certificate = await readFile(f.options.certificateFile, "utf8");
    const other = registeredGateway(f.accounts, certificate);
    f.accounts.identities.linkGateway(
      f.account,
      other.owner,
      f.sessions.sealAccountGatewayLink(origin, f.account, other.owner),
    );
    const live = f.tunnel(f.gateway.token);
    await new Promise<void>((resolve, reject) => {
      live.once("message", () => resolve());
      live.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => live.once("close", () => resolve()));
    // What the gateway does when its owner disconnects it: its own key asks the relay.
    const record = {
      version: 1 as const,
      relayUrl: f.options.relayUrl,
      gatewayId: f.options.gatewayId,
      publicOrigin: f.options.publicOrigin,
      sessionFile: f.options.sessionFile,
      certificateFile: f.options.certificateFile,
      privateKeyFile: f.options.privateKeyFile,
      createdAt: Date.now(),
    };
    const dependencies = {
      register: registerGatewayKey,
      fetch: f.options.fetch,
      signal: AbortSignal.timeout(10_000),
    };
    await releaseGateway(record, dependencies);
    await closed;
    expect(forget).toHaveBeenCalledExactlyOnceWith(f.gateway.accountId);
    expect(f.accounts.registered(f.gateway.accountId)).toBe(false);
    expect(f.accounts.gatewayBinding(f.gateway.accountId)).toBeUndefined();
    expect(f.accounts.accountForHostname(f.hostname)).toBeUndefined();
    // The account is as it was, with its other gateway, and the person is still signed in.
    expect(await f.session()).toMatchObject({ authenticated: true, accountId: f.account });
    expect(f.accounts.identities.gatewayLinks(f.account).map((link) => link.ownerAccount)).toEqual([
      other.owner,
    ]);
    expect(f.accounts.accountForHostname(other.hostname)).toBe(other.owner);
    expect(f.accounts.registered(other.owner)).toBe(true);
    // Asked again, the relay has nothing left to drop, and says so to the gateway's keys.
    await releaseGateway(record, dependencies);
    await expect(registerGatewayKey(f.options)).rejects.toBeInstanceOf(GatewayUnregistered);
    // Its address stays its own: nobody else can take it, and the same gateway may come back
    // once a person signs in for it again, which is what an invitation stands for.
    expect(f.accounts.hostnameAvailable(f.hostname, randomUUID())).toBe(false);
    expect(f.accounts.hostnameAvailable(f.hostname, f.options.gatewayId)).toBe(true);
    await rm(f.options.sessionFile);
    await writeFile(
      f.enrollmentTokenFile,
      JSON.stringify({
        enrollmentToken: await f.sessions.issueEnrollmentInvitation(f.options.gatewayId, origin),
      }),
    );
    const back = await registerGatewayKey(f.options);
    expect(back.accountId).toBe(f.gateway.accountId);
    expect(f.accounts.accountForHostname(f.hostname)).toBe(f.gateway.accountId);
    // Registered again, the name is plainly its own again.
    expect(f.accounts.hostnameAvailable(f.hostname, f.options.gatewayId)).toBe(true);
    expect(f.accounts.hostnameAvailable(f.hostname, randomUUID())).toBe(false);
    // Registered again is not linked again: that takes the account's own sign-in.
    expect(f.accounts.identities.gatewayAccount(f.gateway.accountId)).toBeUndefined();
  } finally {
    await f.close();
  }
});
