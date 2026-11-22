// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { brokerOwner, memoryStore } from "../test/dns-broker-owner.js";
import {
  DnsPublicAdmission,
  OPENED_BY_PORTAL,
  PORTAL_HANDOFF_MS,
  boundedAdmissionJson,
  turnstileVerifier,
} from "./dns-broker-public-admission.js";
import { BrokerTickets } from "./dns-broker-tickets.js";
import { brokerRequestDigest, type BrokerChallenge } from "./dns-broker-contract.js";

const origin = "https://dns.example.test";
const secret = Buffer.alloc(32, 7).toString("base64url");
function fixture() {
  const store = memoryStore();
  const clock = { now: 1_000_000 };
  const verify = vi.fn(async () => true);
  const admission = new DnsPublicAdmission({
    origin,
    secret,
    siteKey: "fixture",
    store,
    now: () => clock.now,
    verify,
    capacity: async () => ({ usage: 0, quota: 200, recordsPerName: 3, managedRecords: {} }),
  });
  return { store, clock, verify, admission };
}
function browser(
  ticket: string,
  headers: Record<string, string> = { origin, "content-type": "application/json" },
) {
  return new Request(`${origin}/_dns/v2/enroll/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ticket, token: "accepted" }),
  });
}

test("rejects incomplete configuration, missing network identity and invalid enrollment methods", async () => {
  const f = fixture();
  const request = brokerOwner().request({ type: "claim" });
  expect(
    () =>
      new DnsPublicAdmission({
        origin,
        secret,
        siteKey: "",
        store: f.store,
        verify: f.verify,
        capacity: async () => ({ usage: 0, quota: 200, recordsPerName: 3, managedRecords: {} }),
      }),
  ).toThrow("site key");
  await expect(f.admission.verification(request, undefined)).rejects.toMatchObject({
    code: "client-address-required",
  });
  const link = await f.admission.verification(request, "192.0.2.2");
  const ticket = new URL(link.url).searchParams.get("ticket")!;
  await expect(f.admission.verifyBrowser(browser(ticket, {}))).rejects.toMatchObject({
    code: "origin-refused",
  });
  await expect(f.admission.verifyBrowser(browser(ticket, { origin }))).rejects.toMatchObject({
    code: "json-required",
  });
  f.verify.mockRejectedValueOnce(new Error("offline"));
  await expect(f.admission.verifyBrowser(browser(ticket))).rejects.toMatchObject({
    code: "verification-unavailable",
  });
  f.verify.mockResolvedValueOnce(false);
  await expect(f.admission.verifyBrowser(browser(ticket))).rejects.toMatchObject({
    code: "verification-refused",
  });
  await expect(
    f.admission.page(new Request(`${origin}/_dns/v2/enroll?other=1`)),
  ).rejects.toMatchObject({ code: "invalid-request" });
  await expect(
    f.admission.page(new Request(`${origin}/_dns/v2/enroll?ticket=${"a".repeat(8193)}`)),
  ).rejects.toMatchObject({ code: "invalid-request" });
  await expect(f.admission.page(new Request(`${origin}/_dns/v2/enroll`))).rejects.toMatchObject({
    code: "verification-expired",
  });
  const nonclaim = await f.admission.verification(
    { ...request, operation: { type: "release" } },
    "192.0.2.2",
  );
  await expect(f.admission.page(new Request(nonclaim.url))).rejects.toMatchObject({
    code: "verification-expired",
  });
  f.clock.now -= 1;
  await expect(f.admission.page(new Request(link.url))).rejects.toMatchObject({
    code: "verification-expired",
  });
  f.clock.now = link.expiresAt;
  await expect(f.admission.page(new Request(link.url))).rejects.toMatchObject({
    code: "verification-expired",
  });
});

test("operation tickets expire and replay rows are bounded, pruned and removed at their deadline", async () => {
  const f = fixture();
  const request = brokerOwner().request({ type: "claim" });
  const challenge: BrokerChallenge = {
    challengeId: crypto.randomUUID(),
    brokerOrigin: origin,
    protocol: "omnesis-dns-broker-v2",
    nonce: "a".repeat(64),
    requestDigest: await brokerRequestDigest(request),
    expiresAt: f.clock.now + 1,
  };
  const signed = await f.admission.operation(request, challenge);
  expect((await f.admission.readOperation(signed.ticket!)).request).toEqual(request);
  await f.admission.consume(request, challenge);
  expect(await f.admission.expireUsed()).toBe(f.clock.now + 1);
  await expect(f.admission.consume(request, challenge)).rejects.toMatchObject({
    code: "challenge-unknown",
  });
  f.clock.now++;
  await expect(f.admission.readOperation(signed.ticket!)).rejects.toMatchObject({
    code: "challenge-unknown",
  });
  const next = { ...challenge, challengeId: crypto.randomUUID(), expiresAt: f.clock.now + 10 };
  await f.admission.consume(request, next);
  // Retain the fresh row while removing the stale one, then delete the whole empty ledger.
  await f.store.put(`used:${request.hostname}`, [
    { id: challenge.challengeId, expiresAt: f.clock.now },
    { id: next.challengeId, expiresAt: next.expiresAt },
  ]);
  expect(await f.admission.expireUsed()).toBe(next.expiresAt);
  expect(await f.store.get(`used:${request.hostname}`)).toEqual([
    { id: next.challengeId, expiresAt: next.expiresAt },
  ]);
  await f.store.put(
    `used:${request.hostname}`,
    Array.from({ length: 32 }, () => ({ id: crypto.randomUUID(), expiresAt: f.clock.now + 1 })),
  );
  await expect(
    f.admission.consume(request, { ...next, challengeId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "name-operation-rate" });
  f.clock.now += 10;
  expect(await f.admission.expireUsed()).toBeUndefined();
  expect(await f.store.get(`used:${request.hostname}`)).toBeUndefined();
  const ticket = await new BrokerTickets(secret).seal(
    JSON.stringify(["omnesis-dns-operation-v1", origin]),
    { request, challenge: { ...challenge, expiresAt: f.clock.now + 10 } },
  );
  expect((await f.admission.readOperation(ticket)).challenge.expiresAt).toBe(f.clock.now + 10);
});

test("Siteverify rejects failed, malformed and nonmatching attestation fields and body failures", async () => {
  const now = 1_000_000;
  const good = {
    success: true,
    hostname: "dns.example.test",
    action: "gateway-enrollment",
    cdata: "binding",
    challenge_ts: new Date(now).toISOString(),
  };
  const input = { token: "token", hostname: good.hostname, cData: "binding", now };
  for (const patch of [
    { success: false },
    { hostname: "other.example.test" },
    { action: "other" },
    { cdata: "wrong" },
    { challenge_ts: "bad" },
    { challenge_ts: new Date(now + 30_001).toISOString() },
    { challenge_ts: new Date(now - 300_000).toISOString() },
  ]) {
    const verify = turnstileVerifier(
      "secret",
      vi.fn(async () => Response.json({ ...good, ...patch })),
    );
    expect(await verify(input)).toBe(false);
  }
  const verify = turnstileVerifier(
    "secret",
    vi.fn(async () => new Response(null, { status: 302 })),
  );
  expect(await verify(input)).toBe(false);
  expect(() => turnstileVerifier("")).toThrow("secret");
  expect(() => turnstileVerifier("x".repeat(2049))).toThrow("secret");
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(good));
  expect(await turnstileVerifier("secret")(input)).toBe(true);
  expect(send).toHaveBeenCalled();
  send.mockRestore();
  await expect(boundedAdmissionJson(new Response(null))).rejects.toMatchObject({
    code: "invalid-json",
  });
});

test("a body timeout remains bounded when the untrusted stream also rejects cancellation", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(async () => {
      throw new Error("stream cancellation failed");
    });
    const pending = boundedAdmissionJson(
      new Response(new ReadableStream<Uint8Array>({ start() {}, cancel })),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      status: 408,
      code: "request-timeout",
    });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The security check page's own script, run against its own markup with the Turnstile widget,
 * the network and the window stood in for: what it says once the check passes.
 */
async function checkPage(
  hash: string,
  reply: { ok: boolean; body: unknown } = { ok: true, body: {} },
) {
  const { parseHTML } = await import("linkedom");
  const f = fixture();
  const link = await f.admission.verification(
    brokerOwner().request({ type: "claim" }),
    "192.0.2.2",
  );
  const html = await (await f.admission.page(new Request(link.url))).text();
  const { document } = parseHTML(html);
  const script = /<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const timers: Array<() => void> = [];
  const win: Record<string, unknown> = { addEventListener: vi.fn(), close: vi.fn() };
  let callback!: (token: string) => Promise<void>;
  const turnstile = {
    render: vi.fn((_selector: string, options: { callback: (token: string) => Promise<void> }) => {
      callback = options.callback;
    }),
  };
  const fetch = vi.fn(async () => ({ ok: reply.ok, json: async () => reply.body }));
  const history = { back: vi.fn() };
  new Function(
    "document",
    "location",
    "window",
    "history",
    "fetch",
    "turnstile",
    "setTimeout",
    "clearTimeout",
    script,
  )(
    document,
    { hash, reload: vi.fn() },
    win,
    history,
    fetch,
    turnstile,
    (run: () => void, ms: number) => (ms === PORTAL_HANDOFF_MS ? timers.push(run) : 0),
    () => {},
  );
  (win.omnesisDnsCheck as () => void)();
  await callback("accepted");
  return {
    message: () => document.querySelector("#message")!.textContent,
    widgetHidden: () => document.querySelector("#widget")!.hidden,
    elapse: () => timers.splice(0).forEach((run) => run()),
    close: win.close as ReturnType<typeof vi.fn>,
    back: history.back,
    fetch,
  };
}

test("a check opened by hand or from the CLI says it is done and that the gateway or terminal goes on", async () => {
  const page = await checkPage("");
  expect(page.fetch).toHaveBeenCalledOnce();
  expect(page.widgetHidden()).toBe(true);
  expect(page.message()).toBe(
    "Done. You can close this tab. Your gateway or terminal continues on its own.",
  );
  page.elapse();
  // A tab the person opened is theirs to close, and its history theirs to walk.
  expect(page.close).not.toHaveBeenCalled();
  expect(page.back).not.toHaveBeenCalled();
});

test("a check the portal opened goes back to the portal's page, and closes itself if it could not", async () => {
  const page = await checkPage(OPENED_BY_PORTAL);
  expect(page.message()).toBe("Verified. Taking you to your Omnesis account…");
  expect(page.message()).not.toContain("Return to");
  // Back to the portal's own page, from where the portal sends the window on.
  expect(page.back).toHaveBeenCalledOnce();
  expect(page.close).not.toHaveBeenCalled();
  page.elapse();
  expect(page.message()).toBe(
    "Done. You can close this tab. Your gateway or terminal continues on its own.",
  );
  expect(page.close).toHaveBeenCalledOnce();
});

test("a refused check says why, wherever it was opened", async () => {
  const page = await checkPage(OPENED_BY_PORTAL, { ok: false, body: { error: "dns-capacity" } });
  expect(page.message()).toBe(
    "Gateway capacity is full. Existing gateways stay connected. Try again later.",
  );
  page.elapse();
  expect(page.close).not.toHaveBeenCalled();
  expect(page.back).not.toHaveBeenCalled();
});
