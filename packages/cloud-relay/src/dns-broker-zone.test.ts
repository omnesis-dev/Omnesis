// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
import { BROKER_RECORD_TAG, cloudflareBrokerZone } from "./dns-broker-zone.js";

const NAME = "g-abcdefgh.relay.example.test";
const CAA = "letsencrypt.org; validationmethods=dns-01; accounturi=https://ca.example.test/acct/1";
const signal = () => AbortSignal.timeout(5000);

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(fetch?: typeof globalThis.fetch) {
  const cloudflare = fakeCloudflare();
  const zone = cloudflareBrokerZone({
    zoneId: cloudflare.zoneId,
    zoneName: "example.test",
    relayDomain: "relay.example.test",
    token: cloudflare.token,
    fetch: fetch ?? cloudflare.fetch,
  });
  return { cloudflare, zone };
}
const lease = {
  id: "5f0c0f39-0d0b-4c55-b1a2-2a7a8e2f4c11",
  hostname: NAME,
  value: "v".repeat(43),
  expiresAt: 9,
};

test("challenge records are created and only the exact tagged one is removed", async () => {
  const { cloudflare, zone } = setup();
  await zone.createTxt(lease, signal());
  const name = `_acme-challenge.${NAME}`;
  cloudflare.add({ type: "TXT", name, content: lease.value, comment: "someone else" });
  cloudflare.add({
    type: "TXT",
    name,
    content: "other",
    comment: `${BROKER_RECORD_TAG}:${lease.id}:9`,
  });
  await zone.removeTxt(lease, signal());
  expect(cloudflare.records.map((record) => record.comment)).toEqual([
    "someone else",
    `${BROKER_RECORD_TAG}:${lease.id}:9`,
  ]);
});

test("a provider that answers with another record is refused", async () => {
  const { cloudflare } = setup();
  const tampered =
    (change: Record<string, unknown>) =>
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await cloudflare.fetch(input, init);
      if (init?.method !== "POST") return response;
      const body = (await response.json()) as { result: Record<string, unknown> };
      return Response.json({ ...body, result: { ...body.result, ...change } });
    };
  await expect(setup(tampered({ content: "x" })).zone.createTxt(lease, signal())).rejects.toThrow(
    "different record",
  );
  await expect(setup(tampered({ name: "x" })).zone.createTxt(lease, signal())).rejects.toThrow(
    "different record",
  );
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.1" });
  await expect(
    setup(
      tampered({ data: { flags: 0, tag: "issue", value: "evil.example.test" } }),
    ).zone.publishName(NAME, CAA, signal()),
  ).rejects.toThrow("different record");
});

test("a name gets the wildcard's addresses and exactly one account-bound CAA record", async () => {
  const { cloudflare, zone } = setup();
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.1" });
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.2" });
  cloudflare.add({ type: "A", name: NAME, content: "192.0.2.2" });
  cloudflare.add({ type: "A", name: NAME, content: "198.51.100.9" });
  cloudflare.add({ type: "AAAA", name: NAME, content: "2001:db8::9" });
  cloudflare.add({
    type: "CAA",
    name: NAME,
    data: { flags: 0, tag: "issue", value: "other.example.test" },
  });
  await zone.publishName(NAME, CAA, signal());
  const at = () =>
    cloudflare.records
      .filter((record) => record.name === NAME)
      .map((record) => `${record.type} ${record.data?.value ?? record.content}`)
      .sort();
  expect(at()).toEqual(["A 192.0.2.1", "A 192.0.2.2", `CAA ${CAA}`]);
  // Already right: nothing is written, and a duplicate is removed.
  cloudflare.add({ type: "CAA", name: NAME, data: { flags: 0, tag: "issue", value: CAA } });
  cloudflare.writes.length = 0;
  await zone.publishName(NAME, CAA, signal());
  expect(cloudflare.writes).toEqual([`delete CAA ${NAME} undefined`]);
  expect(at()).toEqual(["A 192.0.2.1", "A 192.0.2.2", `CAA ${CAA}`]);
  await zone.removeName(NAME, signal());
  expect(at()).toEqual([]);
});

test("a name is never published without an address to answer with", async () => {
  const { cloudflare, zone } = setup();
  await expect(zone.publishName(NAME, CAA, signal())).rejects.toThrow("no wildcard address");
  expect(cloudflare.writes).toEqual([]);
});

test("only single-label gateway names under the relay domain are written", async () => {
  const { cloudflare, zone } = setup();
  for (const hostname of [
    "relay.example.test",
    "a.g-x.relay.example.test",
    "g-x.example.test",
    "Bad_Name",
  ])
    await expect(zone.removeName(hostname, signal())).rejects.toThrow();
  expect(cloudflare.writes).toEqual([]);
  expect(() =>
    cloudflareBrokerZone({
      zoneId: cloudflare.zoneId,
      zoneName: "example.test",
      relayDomain: "relay.other.test",
      token: "t",
    }),
  ).toThrow("outside the configured zone");
  expect(() =>
    cloudflareBrokerZone({
      zoneId: cloudflare.zoneId,
      zoneName: "example.test",
      relayDomain: "example.test",
      token: "t",
    }),
  ).not.toThrow();
});

test("provider failures, oversized or paged answers, and other records are refused", async () => {
  const { cloudflare } = setup();
  const answer =
    (body: unknown, status = 200) =>
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  await expect(setup(answer({}, 500)).zone.removeTxt(lease, signal())).rejects.toThrow("refused");
  await expect(setup(answer("x".repeat(300_000))).zone.removeTxt(lease, signal())).rejects.toThrow(
    "too large",
  );
  await expect(
    setup(answer({ success: true, result: [], result_info: { total_pages: 2 } })).zone.removeTxt(
      lease,
      signal(),
    ),
  ).rejects.toThrow("limit");
  await expect(
    setup(async () => new Response(null)).zone.removeTxt(lease, signal()),
  ).rejects.toThrow();
  // A listing may carry other names; they are never touched.
  const listed = setup(
    answer({
      success: true,
      result: [
        { id: "b".repeat(32), type: "TXT", name: "elsewhere.example.test", content: lease.value },
      ],
    }),
  );
  await listed.zone.removeTxt(lease, signal());
  expect(cloudflare.writes).toEqual([]);
});

test("the platform fetch and an alternative API origin are used as given", async () => {
  const cloudflare = fakeCloudflare();
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    seen.push(String(input));
    return cloudflare.fetch(
      String(input).replace("http://127.0.0.1:9", "https://api.cloudflare.com/client/v4"),
      init,
    );
  });
  const zone = cloudflareBrokerZone({
    zoneId: cloudflare.zoneId,
    zoneName: "example.test",
    relayDomain: "relay.example.test",
    token: cloudflare.token,
    apiUrl: "http://127.0.0.1:9",
  });
  await zone.createTxt(lease, signal());
  expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:9\/zones\//);
});
