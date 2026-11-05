// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { cloudflareDnsProvider } from "./cloudflare-dns.js";
afterEach(() => vi.unstubAllGlobals());
const lease = {
  id: randomUUID(),
  accountId: "a".repeat(64),
  hostname: "gateway.example.test",
  value: "a".repeat(43),
  expiresAt: Date.now() + 60000,
};
const record = {
  id: "b".repeat(32),
  type: "TXT",
  name: `_acme-challenge.${lease.hostname}`,
  content: lease.value,
  comment: `omnesis-acme-v1:${lease.id}:${lease.expiresAt}`,
};
const options = {
  zoneId: "a".repeat(32),
  zoneName: "example.test",
  token: "fixture-private-dns-token",
};
test("provider writes only the scoped TXT and removes only its exact tagged record without redirects", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ success: true, result: record }))
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: [
          record,
          { ...record, id: "c".repeat(32), comment: "unrelated-record" },
          { ...record, id: "d".repeat(32), type: "A" },
          { ...record, id: "e".repeat(32), name: "_acme-challenge.other.example.test" },
          { ...record, id: "f".repeat(32), content: "different" },
        ],
        result_info: { total_pages: 1 },
      }),
    )
    .mockResolvedValueOnce(Response.json({ success: true, result: { id: record.id } }));
  const provider = cloudflareDnsProvider({ ...options, fetch });
  const signal = new AbortController().signal;
  await provider.create(lease, signal);
  await provider.remove(lease, signal);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toMatch(
      /^https:\/\/api.cloudflare.com\/client\/v4\/zones\/[a-f0-9]{32}\/dns_records/,
    );
    expect(init).toMatchObject({
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${options.token}` },
    });
  }
  expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({
    type: "TXT",
    name: record.name,
    content: lease.value,
    comment: record.comment,
    ttl: 120,
  });
  expect(String(fetch.mock.calls[2][0])).toContain(`/${record.id}`);
  await expect(
    provider.create({ ...lease, hostname: "example.test.attacker.test" }, signal),
  ).rejects.toThrow("outside");
});
test("provider rejects bad configuration, failed/malformed replies, unexpected records and unbounded record listings", async () => {
  for (const patch of [
    { zoneId: "invalid" },
    { zoneName: "*.example.test" },
    { token: "secret with whitespace" },
  ])
    expect(() => cloudflareDnsProvider({ ...options, ...patch })).toThrow();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const provider = cloudflareDnsProvider({ ...options, fetch });
  const signal = new AbortController().signal;
  for (const response of [
    new Response("sensitive-provider-details", { status: 403 }),
    Response.json({ success: false, result: record }),
    Response.json({ success: true, result: { ...record, name: "other" } }),
    Response.json({ success: true, result: { ...record, type: "A" } }),
    Response.json({ success: true, result: { ...record, content: "other" } }),
    Response.json({ success: true, result: { ...record, comment: "other" } }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(provider.create(lease, signal)).rejects.toThrow();
  }
  fetch.mockResolvedValueOnce(
    Response.json({ success: true, result: [], result_info: { total_pages: 2 } }),
  );
  await expect(provider.remove(lease, signal)).rejects.toThrow("limit");
  fetch.mockResolvedValueOnce(Response.json({ success: true, result: [] }));
  await provider.remove(lease, signal);
});

test("a gateway-owned zone may validate its apex without granting sibling or deceptive suffix names", async () => {
  const apex = { ...lease, hostname: options.zoneName };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json({ success: true, result: { id: record.id, ...JSON.parse(String(init!.body)) } }),
  );
  const provider = cloudflareDnsProvider({ ...options, fetch });
  await provider.create(apex, new AbortController().signal);
  expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).name).toBe(
    "_acme-challenge.example.test",
  );
  for (const hostname of ["sibling.test", "evil-example.test", "example.test.attacker.test"])
    await expect(
      provider.create({ ...lease, hostname }, new AbortController().signal),
    ).rejects.toThrow("outside");
});

test("the default transport uses the configured API recipient rather than a caller-supplied DNS endpoint", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ success: true, result: record }),
  );
  vi.stubGlobal("fetch", fetch);
  await cloudflareDnsProvider(options).create(lease, new AbortController().signal);
  expect(String(fetch.mock.calls[0][0])).toContain("https://api.cloudflare.com/client/v4/zones/");
});
