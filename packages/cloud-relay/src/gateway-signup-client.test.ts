// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeSignupRelay, signupRelayOrigin } from "../test/fake-signup-relay.js";
import {
  GatewaySignupClient,
  GatewaySignupInviteRefused,
  relayInviteStatus,
  relaySignupAccess,
} from "./gateway-signup-client.js";
import { inviteLink, signInvite } from "./invites.js";
import {
  gatewaySignupStart,
  gatewaySignupTranscript,
  gatewaySignupUnsigned,
} from "./gateway-signup-contract.js";
import { readOrCreateGatewayOwnerKey, type registerGatewayKey } from "./gateway-key-client.js";

const { hostname } = vi.hoisted(() => ({ hostname: vi.fn<() => string>() }));
vi.mock(import("node:os"), async (original) => {
  const actual = await original();
  hostname.mockImplementation(actual.hostname);
  return { ...actual, hostname };
});

let directory: string, ownerKeyFile: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "signup-client-"));
  ownerKeyFile = join(directory, "owner.key");
  await readOrCreateGatewayOwnerKey(ownerKeyFile);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const register = (async () => ({ token: "owner-session" })) as unknown as typeof registerGatewayKey;
const client = (relay: ReturnType<typeof fakeSignupRelay>, global = false) =>
  new GatewaySignupClient({
    relayUrl: signupRelayOrigin,
    gatewayId: randomUUID(),
    ownerKeyFile,
    ...(global ? {} : { fetch: relay.fetch }),
  });
const signal = () => new AbortController().signal;

test("start signs a bounded request, poll and link verify the relay's answer, and the global transport is the default", async () => {
  const relay = fakeSignupRelay();
  relay.poll({ status: "approved" });
  vi.stubGlobal("fetch", relay.fetch);
  const signup = client(relay, true);
  const pending = await signup.start(signal());
  expect(pending).toMatchObject({
    connectUrl: `${signupRelayOrigin}/_relay/connect`,
    code: "ABCD-EF23",
    nonce: relay.started()!.nonce,
  });
  expect(pending).not.toHaveProperty("connectShortUrl");
  expect(relay.started()!.displayName).toBeTruthy();
  expect((await signup.poll(pending, signal())).status).toBe("approved");
  expect(await signup.link(pending, register, {} as Parameters<typeof registerGatewayKey>[0])).toBe(
    relay.accountId,
  );
  const withSignal = await signup.start(signal());
  expect(
    await signup.link(withSignal, register, {
      signal: signal(),
    } as Parameters<typeof registerGatewayKey>[0]),
  ).toBe(relay.accountId);
});

test("start names which view the person sees first, signing in unless told to create, without signing that choice", async () => {
  const relay = fakeSignupRelay(),
    signup = client(relay);
  await signup.start(signal());
  expect(relay.started()).toMatchObject({ intent: "existing" });
  await signup.start(signal(), "existing");
  expect(relay.started()).toMatchObject({ intent: "existing" });
  await signup.start(signal(), "create");
  const { intent, ownerSignature, ...unsigned } = relay.started()!;
  expect(intent).toBe("create");
  // The person can switch on the page, so the owner key signs the request without it.
  expect(
    verify(
      null,
      gatewaySignupTranscript(signupRelayOrigin, gatewaySignupUnsigned.parse(unsigned)),
      createPublicKey(String(unsigned.ownerPublicKey)),
      Buffer.from(String(ownerSignature), "base64url"),
    ),
  ).toBe(true);
  expect(gatewaySignupStart.parse({ ...unsigned, ownerSignature }).intent).toBe("existing");
  expect(() =>
    gatewaySignupStart.parse({ ...unsigned, ownerSignature, intent: "other" }),
  ).toThrow();
});

test("a machine name with nothing printable is left out of the signed request", async () => {
  hostname.mockReturnValueOnce("\u0001\u0002");
  const relay = fakeSignupRelay();
  await client(relay).start(signal());
  expect(relay.started()).not.toHaveProperty("displayName");
});

test("a relay's short connect address is kept for display, and a malformed one refuses the reply", async () => {
  const relay = fakeSignupRelay({
    started: (reply) => ({ ...reply, connectShortUrl: "https://front.example.test/connect" }),
  });
  expect(await client(relay).start(signal())).toMatchObject({
    connectUrl: `${signupRelayOrigin}/_relay/connect`,
    connectShortUrl: "https://front.example.test/connect",
  });
  expect(relay.calls.every((path) => path.startsWith("/_relay/"))).toBe(true);
  for (const connectShortUrl of [
    "http://front.example.test/connect",
    "https://name:secret@front.example.test/connect",
    "front.example.test/connect",
    "https://front.example.test/" + "c".repeat(200),
    7,
  ]) {
    const malformed = fakeSignupRelay({ started: (reply) => ({ ...reply, connectShortUrl }) });
    await expect(client(malformed).start(signal())).rejects.toThrow();
  }
});

test("the relay cannot redirect the sign-in or answer for another operation", async () => {
  for (const change of [
    { operationId: randomUUID() },
    { authorizeUrl: "https://foreign.example.test/_relay/v3/signup/begin" },
    { connectUrl: "https://foreign.example.test/_relay/connect" },
    { authorizeUrl: "https://user@relay.example.test/_relay/v3/signup/begin" },
    { authorizeUrl: "https://:secret@relay.example.test/_relay/v3/signup/begin" },
  ]) {
    const relay = fakeSignupRelay({ started: (reply) => ({ ...reply, ...change }) });
    await expect(client(relay).start(signal())).rejects.toThrow("destination was refused");
  }
  const shortLived = fakeSignupRelay({ startedExpiresAt: (requested) => requested - 100 });
  const pending = await client(shortLived).start(signal());
  expect(pending.expiresAt).toBe((shortLived.started()!.expiresAt as number) - 100);
});

test("refusals, missing account keys and a link for another account all fail closed", async () => {
  const refused = fakeSignupRelay();
  refused.handle("/_relay/v3/signup/start", () => new Response("busy", { status: 503 }));
  await expect(client(refused).start(signal())).rejects.toThrow("refused (503)");
  const empty = fakeSignupRelay();
  empty.handle("/_relay/v3/signup/start", () => new Response(null, { status: 429 }));
  await expect(client(empty).start(signal())).rejects.toThrow("refused (429)");

  const keys = fakeSignupRelay();
  keys.handle("/_relay/v3/account-keys", () => new Response(null, { status: 503 }));
  const keyless = client(keys);
  await expect(
    keyless.link(
      await keyless.start(signal()),
      register,
      {} as Parameters<typeof registerGatewayKey>[0],
    ),
  ).rejects.toThrow("Account verification is unavailable");

  const other = fakeSignupRelay({ linkedAccountId: "e".repeat(64) });
  const changed = client(other);
  await expect(
    changed.link(
      await changed.start(signal()),
      register,
      {} as Parameters<typeof registerGatewayKey>[0],
    ),
  ).rejects.toThrow("account changed");
});

test("cancel is best effort", async () => {
  const relay = fakeSignupRelay();
  const signup = client(relay);
  const pending = await signup.start(signal());
  await signup.cancel(pending);
  expect(relay.calls.at(-1)).toBe("/_relay/v3/signup/cancel");
  relay.handle("/_relay/v3/signup/cancel", () => {
    throw new Error("offline");
  });
  await expect(signup.cancel(pending)).resolves.toBeUndefined();
});

test("the relay's signup access is read with a plain public request, and says only whether it is invite-only", async () => {
  const answer = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    );
  const read = (transport: typeof fetch) =>
    relaySignupAccess("https://relay.example.test", AbortSignal.timeout(5000), transport);
  const transport = answer({
    protocol: 9,
    signup: { inviteOnly: true, unknownField: "ignored" },
    anotherField: true,
  });
  // Fields this gateway does not know are ignored, so a relay can add some.
  expect(await read(transport)).toEqual({ inviteOnly: true });
  const [target, init] = transport.mock.calls[0]!;
  expect(String(target)).toBe("https://relay.example.test/_relay/v3/signup/access");
  expect(init).toMatchObject({ redirect: "error" });
  expect(init).not.toHaveProperty("method");
  expect(init).not.toHaveProperty("headers");
  expect(init).not.toHaveProperty("body");
  for (const signup of [{ inviteOnly: "true" }, { inviteOnly: false }, {}, "invite-only", null])
    expect(await read(answer({ signup })), JSON.stringify(signup)).toBeUndefined();
  for (const transport of [
    answer({}),
    answer([]),
    answer("null"),
    answer({ signup: { inviteOnly: true } }, 404),
  ])
    expect(await read(transport)).toBeUndefined();
  await expect(read(answer("{"))).rejects.toThrow();
});

const invite = signInvite(generateKeyPairSync("ed25519").privateKey, {
  origin: signupRelayOrigin,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

test("start sends only the token of a pasted invite link, unsigned, and refuses what is no invite", async () => {
  const relay = fakeSignupRelay(),
    signup = client(relay);
  await signup.start(signal(), "create", `  ${inviteLink(signupRelayOrigin, invite)}\n`);
  const { invite: sent, intent, ownerSignature, ...unsigned } = relay.started()!;
  expect(sent).toBe(invite);
  expect(intent).toBe("create");
  // The relay checks the invite's own signature; the owner key signs the request without it.
  expect(
    verify(
      null,
      gatewaySignupTranscript(signupRelayOrigin, gatewaySignupUnsigned.parse(unsigned)),
      createPublicKey(String(unsigned.ownerPublicKey)),
      Buffer.from(String(ownerSignature), "base64url"),
    ),
  ).toBe(true);
  await signup.start(signal(), "existing");
  expect(relay.started()).not.toHaveProperty("invite");
  const calls = relay.calls.length;
  await expect(signup.start(signal(), "create", "not an invite")).rejects.toMatchObject({
    name: "GatewaySignupInviteRefused",
    reason: "invite-invalid",
  });
  expect(relay.calls).toHaveLength(calls);
});

test("the relay's refusal of an invite reaches the gateway with its reason, and any other refusal stays generic", async () => {
  const relay = fakeSignupRelay(),
    signup = client(relay);
  const refuse = (status: number, body: unknown, type = "application/json") =>
    relay.handle(
      "/_relay/v3/signup/start",
      () => new Response(JSON.stringify(body), { status, headers: { "content-type": type } }),
    );
  for (const reason of ["invite-invalid", "invite-expired", "invite-used"] as const) {
    refuse(403, { error: reason });
    const error = await signup.start(signal(), "create", invite).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GatewaySignupInviteRefused);
    expect(error).toMatchObject({ reason });
  }
  for (const [status, body, type] of [
    [403, { error: "gateway-removed" }, "application/json"],
    [403, { error: "invite-used" }, "text/plain"],
    [400, { error: "invite-used" }, "application/json"],
    [403, "{", "application/json"],
    [403, null, "application/json"],
  ] as const) {
    relay.handle(
      "/_relay/v3/signup/start",
      () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": type },
        }),
    );
    const error = await signup.start(signal(), "create", invite).catch((value: unknown) => value);
    expect(error).not.toBeInstanceOf(GatewaySignupInviteRefused);
    expect(String(error)).toContain(`refused (${status})`);
  }
});

test("an invite is checked with the relay before connecting, and only its token is sent", async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "valid", expiresAt: 1_900_000_000 }),
  );
  expect(
    await relayInviteStatus(
      signupRelayOrigin,
      inviteLink(signupRelayOrigin, invite),
      AbortSignal.timeout(5000),
      transport,
    ),
  ).toEqual({ status: "valid", expiresAt: 1_900_000_000 });
  const [target, init] = transport.mock.calls[0]!;
  expect(String(target)).toBe(`${signupRelayOrigin}/_relay/v3/signup/invite`);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(String(init!.body))).toEqual({ invite });
  for (const status of ["invalid", "expired", "used"] as const) {
    transport.mockResolvedValueOnce(Response.json({ status }));
    expect(
      await relayInviteStatus(signupRelayOrigin, invite, AbortSignal.timeout(5000), transport),
    ).toEqual({ status });
  }
  const calls = transport.mock.calls.length;
  expect(
    await relayInviteStatus(signupRelayOrigin, "nonsense", AbortSignal.timeout(5000), transport),
  ).toEqual({ status: "invalid" });
  expect(transport).toHaveBeenCalledTimes(calls);
  transport.mockResolvedValueOnce(new Response("busy", { status: 429 }));
  await expect(
    relayInviteStatus(signupRelayOrigin, invite, AbortSignal.timeout(5000), transport),
  ).rejects.toThrow("(429)");
  transport.mockResolvedValueOnce(Response.json({ status: "maybe" }));
  await expect(
    relayInviteStatus(signupRelayOrigin, invite, AbortSignal.timeout(5000), transport),
  ).rejects.toThrow();
  // Without a transport the global fetch is used.
  vi.stubGlobal("fetch", transport);
  transport.mockResolvedValueOnce(Response.json({ status: "used" }));
  expect(await relayInviteStatus(signupRelayOrigin, invite, AbortSignal.timeout(5000))).toEqual({
    status: "used",
  });
});
