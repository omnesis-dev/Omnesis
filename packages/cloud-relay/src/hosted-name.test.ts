// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { listen, tlsFiles } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { gatewayKeyAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { hostedGatewayHostname, hostedGatewayLabel, hostedGatewayOrigin } from "./hosted-name.js";
import { verifyRoutingHostname } from "./hostname-proof.js";
import { RelaySessions } from "./identity.js";
import { createCloudRelay } from "./server.js";

const DOMAIN = "relay.example.test";
// Two real ids with one label, found by a second of hashing: a short name is never a secret.
const FIRST = "00000000-0000-4000-8000-0000000aee16";
const COLLIDING = "00000000-0000-4000-8000-0000001a9a49";
const SHARED = `g-m7ltfbzt.${DOMAIN}`;

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-hosted-name-"));
});
afterAll(async () => rm(directory, { recursive: true, force: true }));

async function gatewayFiles(name: string, hostname: string) {
  const home = join(directory, name);
  await mkdir(home);
  return { home, ...tlsFiles(home, hostname) };
}
function owner(gatewayId: string, publicOrigin: string, certificate: string) {
  const key = generateKeyPairSync("ed25519").publicKey;
  return {
    account: gatewayKeyAccount({
      gatewayId,
      ownerPublicKey: key.export({ type: "spki", format: "pem" }).toString(),
    }),
    binding: {
      gatewayId,
      publicOrigin,
      certificate,
      identityToken:
        KEY_BINDING_PREFIX + key.export({ type: "spki", format: "der" }).toString("base64url"),
    },
  };
}

test("the hosted label is g- and the first 40 bits of the id's SHA-256 in lowercase base32", () => {
  for (const [id, label] of [
    ["00000000-0000-4000-8000-000000000001", "g-chszj5eb"],
    ["00000000-0000-4000-8000-000000000003", "g-tezcjnh6"],
    ["c62353e6-b4c5-4a08-8f0c-0c13bd0b1460", "g-ueekyvb4"],
  ] as const) {
    expect(hostedGatewayLabel(id)).toBe(label);
    expect(hostedGatewayLabel(id.toUpperCase())).toBe(label);
    expect(hostedGatewayHostname(id.toUpperCase(), DOMAIN)).toBe(`${label}.${DOMAIN}`);
  }
  // An independent encoding of the same five bytes, most significant bit first.
  const id = randomUUID();
  const bits = [...createHash("sha256").update(id).digest().subarray(0, 5)]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("");
  expect(hostedGatewayLabel(id)).toBe(
    "g-" +
      bits
        .match(/.{5}/g)!
        .map((chunk) => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(chunk, 2)])
        .join(""),
  );
  const labels = new Set<string>();
  for (let index = 0; index < 500; index++) {
    const label = hostedGatewayLabel(randomUUID());
    expect(label).toMatch(/^g-[a-z2-7]{8}$/);
    labels.add(label);
  }
  expect(labels.size).toBe(500);
  expect(hostedGatewayLabel(FIRST)).toBe(hostedGatewayLabel(COLLIDING));
  expect(hostedGatewayHostname(COLLIDING, DOMAIN)).toBe(SHARED);
});

test("the hostname proof accepts only the gateway's own derivation, which a colliding id also passes", async () => {
  const lookup = vi.fn(async (): Promise<string[][]> => []);
  const id = "c62353e6-b4c5-4a08-8f0c-0c13bd0b1460";
  const proof = (hostname: string, gatewayId: string) =>
    verifyRoutingHostname(hostname, "account", gatewayId, DOMAIN, lookup);
  expect(await proof(`g-ueekyvb4.${DOMAIN}`, id)).toBe(true);
  expect(await proof(`g-ueekyvb4.${DOMAIN}`, id.toUpperCase())).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  for (const refused of [
    `g-${id.replaceAll("-", "")}.${DOMAIN}`,
    `g-UEEKYVB4.${DOMAIN}`,
    `g-ueekyvb.${DOMAIN}`,
    `g-ueekyvb4.other.example.test`,
    `g-ueekyvb4.sub.${DOMAIN}`,
    SHARED,
  ])
    expect(await proof(refused, id)).toBe(false);
  expect(await proof(`g-ueekyvb4.${DOMAIN}`, randomUUID())).toBe(false);
  expect(
    await verifyRoutingHostname(`g-ueekyvb4.${DOMAIN}`, "account", id, undefined, lookup),
  ).toBe(false);
  // Derivation alone cannot tell these two apart; RelayAccounts.registerBinding does.
  expect(await proof(SHARED, FIRST)).toBe(true);
  expect(await proof(SHARED, COLLIDING)).toBe(true);
});

test("a hosted name stays with the first gateway bound to it, against a colliding id and after release", async () => {
  const files = await gatewayFiles("store", SHARED);
  const certificate = await readFile(files.certFile, "utf8");
  const file = join(files.home, "relay.sqlite");
  let accounts = new RelayAccounts(file, 3);
  try {
    const first = owner(FIRST, `https://${SHARED}`, certificate);
    const thief = owner(COLLIDING, `https://${SHARED}`, certificate);
    expect(accounts.hostnameAvailable(SHARED, FIRST)).toBe(true);
    expect(accounts.hostnameAvailable(SHARED, COLLIDING)).toBe(true);
    accounts.registerKeyBinding(first.account, first.binding, true);
    expect(accounts.hostnameAvailable(SHARED, FIRST.toUpperCase())).toBe(true);
    expect(accounts.hostnameAvailable(SHARED, COLLIDING)).toBe(false);
    const refused = () => {
      expect(() => accounts.registerKeyBinding(thief.account, thief.binding, true)).toThrow(
        "Hostname already registered",
      );
      // The legacy route shares the grant.
      accounts.registerAccount("b".repeat(64));
      expect(() =>
        accounts.registerBinding("b".repeat(64), { ...thief.binding, identityToken: "legacy" }),
      ).toThrow("Hostname already registered");
      expect(accounts.gatewayBinding(thief.account)).toBeUndefined();
      expect(accounts.ownerForGateway(COLLIDING)).toBeUndefined();
      expect(accounts.keyEnrollmentExempt(thief.account, thief.binding)).toBe(false);
    };
    refused();
    expect(accounts.accountForHostname(SHARED)).toBe(first.account);
    expect(accounts.gatewayBinding(first.account)).toEqual(first.binding);
    // A fresh owner key under the first gateway's id is a different account and is refused too.
    const rekeyed = owner(FIRST, `https://${SHARED}`, certificate);
    expect(() => accounts.registerKeyBinding(rekeyed.account, rekeyed.binding, true)).toThrow(
      "another owner identity",
    );
    // Renewal by the holder is unaffected.
    accounts.registerKeyBinding(first.account, first.binding, false);

    // Moving to a custom hostname unbinds the hosted name without freeing it.
    accounts.registerKeyBinding(
      first.account,
      { ...first.binding, publicOrigin: "https://custom.example.test" },
      false,
    );
    expect(accounts.accountForHostname(SHARED)).toBeUndefined();
    expect(accounts.hostnameAvailable(SHARED, COLLIDING)).toBe(false);
    refused();
    accounts.close();
    accounts = new RelayAccounts(file, 3);
    refused();
    // Custom names are proven by DNS instead, so they are released as before.
    expect(accounts.hostnameAvailable("custom.example.test", COLLIDING)).toBe(false);
    accounts.registerKeyBinding(first.account, first.binding, false);
    expect(accounts.hostnameAvailable("custom.example.test", COLLIDING)).toBe(true);
    expect(accounts.accountForHostname(SHARED)).toBe(first.account);
  } finally {
    accounts.close();
  }
});

test("the relay refuses a colliding gateway its name, a session, a certificate challenge and its traffic", async () => {
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const create = vi.fn(async () => {}),
    remove = vi.fn(async () => {});
  const dns = await AcmeDnsChallenges.open({
    file: join(directory, "dns.json"),
    suffix: "example.test",
    provider: { create, remove },
  });
  const relay = createCloudRelay({
    accounts,
    sessions,
    acmeDns: dns,
    allowLoopbackEnrollment: true,
    relayDomain: DOMAIN,
  });
  const url = await listen(relay.server);
  const config = (gatewayId: string) => fetch(`${url}/_relay/v2/config?gatewayId=${gatewayId}`);
  const gateway = async (name: string, gatewayId: string) => {
    const files = await gatewayFiles(name, SHARED);
    return {
      relayUrl: url,
      sessionFile: join(files.home, "session"),
      gatewayId,
      publicOrigin: `https://${SHARED}`,
      certificateFile: files.certFile,
      privateKeyFile: files.keyFile,
    };
  };
  const challenge = (token: string) =>
    fetch(`${url}/_relay/v2/acme/challenge`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "a".repeat(43) }),
    });
  try {
    expect((await config(FIRST)).status).toBe(200);
    expect((await config(COLLIDING)).status).toBe(200);
    const first = await gateway("first", FIRST);
    const holder = await registerGatewayKey(first);
    expect(accounts.accountForHostname(SHARED)).toBe(holder.accountId);
    const binding = accounts.gatewayBinding(holder.accountId);

    // Discovery tells a new gateway to draw another id; the holder still reads its own name.
    const taken = await config(COLLIDING);
    expect(taken.status).toBe(409);
    expect(await taken.text()).toBe("");
    expect(await (await config(FIRST.toUpperCase())).json()).toMatchObject({
      gatewayId: FIRST,
      publicOrigin: `https://${SHARED}`,
    });

    // Enrollment is the authority: valid owner and TLS proofs for a colliding id earn nothing.
    const second = await gateway("second", COLLIDING);
    await expect(registerGatewayKey(second)).rejects.toThrow("registration refused");
    await expect(readFile(second.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(accounts.snapshot()).toMatchObject({ accounts: 1, gatewayBindings: 1 });
    expect(accounts.ownerForGateway(COLLIDING)).toBeUndefined();
    expect(accounts.gatewayBinding(holder.accountId)).toEqual(binding);
    // Neither can the holder's id be re-bound to another owner key.
    await expect(
      registerGatewayKey({ ...first, sessionFile: join(directory, "rekeyed-session") }),
    ).rejects.toThrow("registration refused");
    expect(accounts.gatewayBinding(holder.accountId)).toEqual(binding);

    // Even holding a relay session, an account without the binding gets no certificate challenge
    // and no traffic: both follow the stored binding, never a derivation.
    const outsider = await sessions.issue({
      issuer: "https://issuer.example.test",
      subject: "fictional-collider",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    accounts.registerAccount(outsider.accountId);
    expect((await challenge(outsider.token)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    const control = new WebSocket(`${url.replace("http", "ws")}/_relay/v1/tunnel`, {
      headers: {
        authorization: `Bearer ${outsider.token}`,
        "x-omnesis-tunnel-protocol": "2",
        "x-omnesis-gateway-id": COLLIDING,
      },
    });
    await new Promise((resolve) => control.once("open", resolve));
    expect(accounts.accountForHostname(SHARED)).toBe(holder.accountId);
    control.terminate();

    expect((await challenge(holder.token)).status).toBe(200);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostname: SHARED, accountId: holder.accountId }),
      expect.any(AbortSignal),
    );
  } finally {
    await relay.close();
    accounts.close();
  }
});

test("a gateway vouches for its own origin only when the saved one is its hosted name", () => {
  const gatewayId = randomUUID(),
    relayOrigin = `https://${DOMAIN}`,
    own = `https://${hostedGatewayHostname(gatewayId, DOMAIN)}`;
  expect(hostedGatewayOrigin({ relayOrigin, gatewayId, publicOrigin: own })).toBe(own);
  // The port follows the saved origin, and the relay's own port is not part of its domain.
  expect(
    hostedGatewayOrigin({
      relayOrigin: `https://${DOMAIN}:8443`,
      gatewayId: gatewayId.toUpperCase(),
      publicOrigin: `${own}:9443`,
    }),
  ).toBe(`${own}:9443`);
  // A name the relay chose instead is never this gateway's origin: its own host, another
  // gateway's name, a name outside its domain, plain HTTP, or a custom domain.
  for (const publicOrigin of [
    relayOrigin,
    `https://${hostedGatewayHostname(randomUUID(), DOMAIN)}`,
    `https://${hostedGatewayHostname(gatewayId, "relay.other.test")}`,
    own.replace("https:", "http:"),
    `${own}/portal`,
    "https://gateway.example.test",
    undefined,
  ])
    expect(hostedGatewayOrigin({ relayOrigin, gatewayId, publicOrigin })).toBeUndefined();
  expect(hostedGatewayOrigin({ relayOrigin: undefined, gatewayId, publicOrigin: own })).toBe(
    undefined,
  );
  expect(
    hostedGatewayOrigin({ relayOrigin, gatewayId: "not-a-uuid", publicOrigin: own }),
  ).toBeUndefined();
});
