// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_CAPTURE_RULES } from "@omnesis/provider-web/capture-policy";
import { CapturePolicyClient, CapturePolicyError } from "./capture-policy.js";
import { FakeFetch, jsonResponse } from "./test-fakes.js";

const GATEWAY = "https://gateway.example.ts.net:7600";
const policy = {
  updatedAt: "2026-02-01T10:00:00.000Z",
  pause: null,
  excludedDomains: ["bank.example"],
  ownedDomains: ["notes.example"],
  rules: DEFAULT_WEB_CAPTURE_RULES,
  removedPages: ["abc"],
  removedPagesTruncated: false,
};

describe("CapturePolicyClient", () => {
  it("reads the policy with the bearer token and no body", async () => {
    const fake = new FakeFetch(() => jsonResponse(200, policy));
    const client = new CapturePolicyClient(GATEWAY, "tok", fake.fetch);
    expect(await client.read()).toEqual(policy);
    expect(fake.requests[0]).toMatchObject({
      url: `${GATEWAY}/web-capture-policy`,
      method: "GET",
      headers: { authorization: "Bearer tok" },
      body: "",
      redirect: "error",
    });
    expect(fake.requests[0].headers["content-type"]).toBeUndefined();
  });

  it("sends each edit as its own request and returns the gateway's policy", async () => {
    const fake = new FakeFetch((req) =>
      req.method === "POST"
        ? jsonResponse(200, { policy, purged: 3 })
        : jsonResponse(200, { ...policy, pause: { until: null } }),
    );
    const client = new CapturePolicyClient(GATEWAY, "tok", fake.fetch);
    expect(await client.addExcludedDomain("Bank.Example", true)).toEqual({ policy, purged: 3 });
    expect((await client.setPause(null)).pause).toEqual({ until: null });
    await client.clearPause();
    await client.removeExcludedDomain("bank.example");
    expect(
      fake.requests.map((req) => [req.method, req.url.slice(GATEWAY.length), req.body]),
    ).toEqual([
      ["POST", "/web-capture-policy/excluded-domains", { domain: "Bank.Example", purge: true }],
      ["PUT", "/web-capture-policy/pause", { until: null }],
      ["DELETE", "/web-capture-policy/pause", ""],
      ["DELETE", "/web-capture-policy/excluded-domains/bank.example", ""],
    ]);
  });

  it("surfaces the gateway's reason on a refusal and rejects an unreadable policy", async () => {
    const refusing = new CapturePolicyClient(
      GATEWAY,
      "tok",
      new FakeFetch(() => jsonResponse(400, { error: "Not a valid domain" })).fetch,
    );
    await expect(refusing.addExcludedDomain("nope", false)).rejects.toMatchObject({
      name: "CapturePolicyError",
      status: 400,
      message: "Not a valid domain",
    });
    const garbled = new CapturePolicyClient(
      GATEWAY,
      "tok",
      new FakeFetch(() => jsonResponse(200, { unexpected: true })).fetch,
    );
    await expect(garbled.read()).rejects.toBeInstanceOf(CapturePolicyError);
  });

  it("gives up on a stalled request instead of holding the worker", async () => {
    const client = new CapturePolicyClient(GATEWAY, "tok", () => new Promise(() => undefined), 5);
    await expect(client.read()).rejects.toThrow(/timed out/);
  });
});
