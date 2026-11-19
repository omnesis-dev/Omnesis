// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { z } from "zod";
import { BrokerError } from "./dns-broker-error.js";
import { PublicAdmissionError } from "./dns-broker-admission-budget.js";
import { BrowserVerificationRequired } from "./dns-broker-public-admission.js";
import { brokerHttp, brokerOrigin } from "./dns-broker-http.js";

type Service = Parameters<typeof brokerHttp>[1];
const ORIGIN = "https://dns.example.test";
function service(): Service {
  return {
    ready: undefined,
    health: vi.fn(() => ({
      protocol: "omnesis-dns-broker-v2" as const,
      relayDomain: "relay.example.test",
      caa: { issuer: "letsencrypt.org", accountUriPrefix: "https://acme.example.test/account/" },
    })),
    challenge: vi.fn(async (input: unknown) => ({ challenge: input })),
    complete: vi.fn(async (input: unknown) => ({ complete: input })),
  };
}
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`${ORIGIN}/_dns/v2/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        }),
  });

test.each([
  ["https://DNS.example.test:443/", "https://dns.example.test"],
  ["http://127.0.0.1:17821", "http://127.0.0.1:17821"],
  ["http://localhost:17821", "http://localhost:17821"],
  ["http://[::1]:17821", "http://[::1]:17821"],
])("accepts only an origin (or explicit local test origin): %s", (input, expected) => {
  expect(brokerOrigin(input)).toBe(expected);
});

test.each([
  "http://dns.example.test",
  "ftp://dns.example.test",
  "https://user@dns.example.test",
  "https://:password@dns.example.test",
  "https://dns.example.test/path",
  "https://dns.example.test/?query=1",
  "https://dns.example.test/#fragment",
])("rejects an unsafe broker origin %s", (input) => {
  expect(() => brokerOrigin(input)).toThrow("HTTPS origin");
});

test("waits for state initialization before serving even health and maps readiness failure", async () => {
  const backend = service();
  let ready!: () => void;
  backend.ready = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = brokerHttp(request("health"), backend);
  expect(backend.health).not.toHaveBeenCalled();
  ready();
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  backend.ready = Promise.reject(new Error("private provider details"));
  const failed = await brokerHttp(request("health"), backend);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: "broker-failure" });
});

test("forwards JSON only to the selected challenge or completion service", async () => {
  const backend = service();
  for (const path of ["challenge", "complete"]) {
    const response = await brokerHttp(request(path, "POST", { input: path }), backend);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ [path]: { input: path } });
  }
  expect(backend.challenge).toHaveBeenCalledOnce();
  expect(backend.complete).toHaveBeenCalledOnce();
  const notJson = new Request(`${ORIGIN}/_dns/v2/challenge`, { method: "POST", body: "{}" });
  expect((await brokerHttp(notJson, backend)).status).toBe(415);
  const tooLarge = await brokerHttp(request("complete", "POST", "x".repeat(16_384)), backend);
  expect(tooLarge.status).toBe(413);
  expect(backend.complete).toHaveBeenCalledOnce();
});

test("keeps public verification routes unavailable without public admission and restricts methods", async () => {
  const backend = service();
  for (const path of ["enroll", "enroll/verify", "import", "unknown"])
    expect((await brokerHttp(request(path), backend)).status).toBe(404);
  backend.publicAdmission = {
    page: vi.fn(
      async () => new Response("managed check", { headers: { "content-type": "text/html" } }),
    ),
    verify: vi.fn(async () => ({ verified: true })),
  };
  expect(await (await brokerHttp(request("enroll"), backend)).text()).toBe("managed check");
  expect(await (await brokerHttp(request("enroll/verify", "POST"), backend)).json()).toEqual({
    verified: true,
  });
  for (const [path, method] of [
    ["enroll", "POST"],
    ["enroll/verify", "GET"],
    ["health", "POST"],
    ["challenge", "GET"],
    ["complete", "GET"],
  ])
    expect((await brokerHttp(request(path!, method), backend)).status).toBe(405);
  expect(backend.publicAdmission.page).toHaveBeenCalledOnce();
  expect(backend.publicAdmission.verify).toHaveBeenCalledOnce();
});

test("authorizes import before reading the body and applies its separate body bound", async () => {
  const backend = service();
  backend.importRegistry = vi.fn(async (authorization, read) => {
    if (authorization !== "Bearer fixture-import") throw new BrokerError(403, "forbidden");
    return { imported: await read() };
  });
  const forbidden = await brokerHttp(
    new Request(`${ORIGIN}/_dns/v2/import`, { method: "POST", body: "not JSON" }),
    backend,
  );
  expect(forbidden.status).toBe(403);
  const authorized = request("import", "POST", "x".repeat(20_000));
  authorized.headers.set("authorization", "Bearer fixture-import");
  expect((await brokerHttp(authorized, backend)).status).toBe(200);
  const tooLarge = request("import", "POST", "x".repeat(1_048_576));
  tooLarge.headers.set("authorization", "Bearer fixture-import");
  expect((await brokerHttp(tooLarge, backend)).status).toBe(413);
  expect((await brokerHttp(request("import"), backend)).status).toBe(405);
});

test("returns only fixed error codes, except the explicit safe verification prompt", async () => {
  const backend = service();
  const verification = {
    url: `${ORIGIN}/_dns/v2/enroll?ticket=fixture`,
    expiresAt: 1_900_000_000_000,
  };
  const schemaError = z.string().safeParse(7);
  if (schemaError.success) throw new Error("Expected fixture schema error");
  for (const [error, status, body] of [
    [new BrokerError(409, "conflict"), 409, { error: "conflict" }],
    [new PublicAdmissionError(429, "admission-limited"), 429, { error: "admission-limited" }],
    [schemaError.error, 400, { error: "invalid-request" }],
    [new Error("private provider details"), 500, { error: "broker-failure" }],
    [
      new BrowserVerificationRequired(verification),
      428,
      { error: "browser-verification-required", verification },
    ],
  ] as const) {
    backend.challenge = async () => {
      throw error;
    };
    const response = await brokerHttp(request("challenge", "POST", {}), backend);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
