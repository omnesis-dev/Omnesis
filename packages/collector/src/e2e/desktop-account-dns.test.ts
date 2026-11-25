// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Resolver } from "node:dns/promises";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { startDesktopAccountDns } from "./desktop-account-dns.js";

test("the owned DNS fixture answers real A/TXT/CAA queries and never forwards production names", async () => {
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/txt")
          ? [["invented-acme-digest"]]
          : [{ critical: 0, issue: "fixture-ca; accounturi=https://acme.example.test/account/1" }],
      ),
    );
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("The fixture DNS API did not bind");
  const dns = await startDesktopAccountDns(`http://127.0.0.1:${address.port}`);
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([`127.0.0.1:${dns.port}`]);
  try {
    expect(await resolver.resolve4("relay.example.test")).toEqual(["127.0.0.1"]);
    expect(await resolver.resolveTxt("_acme-challenge.g-fixture.relay.example.test")).toEqual([
      ["invented-acme-digest"],
    ]);
    expect(await resolver.resolveCaa("g-fixture.relay.example.test")).toMatchObject([
      { critical: 0, issue: "fixture-ca; accounturi=https://acme.example.test/account/1" },
    ]);
    await expect(resolver.resolve4("unowned.example.org")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    expect(dns.productionQueries.size).toBe(0);
  } finally {
    resolver.cancel();
    await dns.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
