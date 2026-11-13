// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeSignupRelay, signupRelayOrigin } from "../test/fake-signup-relay.js";
import { GatewaySignupClient, relaySignupAccess } from "./gateway-signup-client.js";
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

test("the relay's signup access is read with a plain public request and checked again on the gateway", async () => {
  const requestAccessUrl = "https://groups.example.com/g/fictional-testers";
  const answer = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    );
  const read = (transport: typeof fetch) =>
    relaySignupAccess("https://relay.example.test", AbortSignal.timeout(5000), transport);
  const transport = answer({
    protocol: 9,
    signup: { inviteOnly: true, requestAccessUrl, unknownField: "ignored" },
    anotherField: true,
  });
  // Fields this gateway does not know are ignored, so a relay can add some.
  expect(await read(transport)).toEqual({ inviteOnly: true, requestAccessUrl });
  const [target, init] = transport.mock.calls[0]!;
  expect(String(target)).toBe("https://relay.example.test/_relay/v3/signup/access");
  expect(init).toMatchObject({ redirect: "error" });
  expect(init).not.toHaveProperty("method");
  expect(init).not.toHaveProperty("headers");
  expect(init).not.toHaveProperty("body");
  for (const signup of [
    { inviteOnly: true, requestAccessUrl: "http://groups.example.com/g/fictional-testers" },
    { inviteOnly: true, requestAccessUrl: "https://name:secret@groups.example.com/" },
    { inviteOnly: true, requestAccessUrl: "https://:secret@groups.example.com/" },
    { inviteOnly: true, requestAccessUrl: `https://groups.example.com/${"a".repeat(2048)}` },
    { inviteOnly: true, requestAccessUrl: "javascript:alert(1)" },
    { inviteOnly: true, requestAccessUrl: "not a url" },
    { inviteOnly: true, requestAccessUrl: 42 },
    { inviteOnly: true, requestAccessUrl: [requestAccessUrl] },
    { inviteOnly: "true", requestAccessUrl },
    { requestAccessUrl },
    "invite-only",
    null,
  ])
    expect(await read(answer({ signup })), JSON.stringify(signup)).toBeUndefined();
  for (const transport of [
    answer({}),
    answer([]),
    answer("null"),
    answer({ signup: { inviteOnly: true, requestAccessUrl } }, 404),
  ])
    expect(await read(transport)).toBeUndefined();
  await expect(read(answer("{"))).rejects.toThrow();
});
