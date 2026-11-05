// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { CertSpotterProvider } from "./certificate-monitor-certspotter.js";
let directory: string, der: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ct-provider-"));
  der = new X509Certificate(
    await readFile(tlsFiles(directory, "gateway.example.test").certFile),
  ).raw.toString("base64");
});
afterAll(() => rm(directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
test("uses official fixed API, exact-host wildcard search, DER expansion and opaque cursor pagination without credentials by default", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([{ id: "entry_1", cert_der: der, pubkey_sha256: "untrusted-provider-hash" }]),
    )
    .mockResolvedValueOnce(Response.json([], { headers: { "retry-after": "300" } }));
  vi.stubGlobal("fetch", transport);
  const provider = new CertSpotterProvider();
  const first = await provider.page("gateway.example.test", undefined, signal());
  expect(first.complete).toBe(false);
  expect(first.lastId).toBe("entry_1");
  expect(first.entries[0].certificateDer.toString("base64")).toBe(der);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe(
    "https://api.certspotter.com/v1/issuances?domain=gateway.example.test&match_wildcards=true&expand=cert_der",
  );
  expect(init).toMatchObject({ redirect: "error", headers: { accept: "application/json" } });
  expect(init!.headers).not.toHaveProperty("authorization");
  expect(await provider.page("gateway.example.test", first.lastId, signal())).toMatchObject({
    complete: true,
    entries: [],
    retryAfterMs: 300000,
  });
  expect(String(transport.mock.calls[1][0])).toContain("after=entry_1");
});
test("a dedicated bounded API credential file supplies only the provider authorization header", async () => {
  const file = join(directory, "api.json");
  await writeFile(file, JSON.stringify({ apiKey: "ct-test-token" }));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  const provider = new CertSpotterProvider({ apiKeyFile: file, fetch: transport });
  await provider.page("gateway.example.test", undefined, signal());
  expect(transport.mock.calls[0][1]!.headers).toEqual({
    accept: "application/json",
    authorization: "Bearer ct-test-token",
  });
  expect(String(transport.mock.calls[0][0])).not.toContain("ct-test-token");
  for (const value of [
    "null",
    JSON.stringify({ token: "device-test-token" }),
    JSON.stringify({ apiKey: "ct-test-token", idToken: "wrong-token" }),
    JSON.stringify({ apiKey: "bad\nheader" }),
    "x".repeat(65537),
  ]) {
    await writeFile(file, value);
    transport.mockClear();
    await expect(provider.page("gateway.example.test", undefined, signal())).rejects.toMatchObject({
      code: "ct-provider-unavailable",
    });
    expect(transport).not.toHaveBeenCalled();
  }
});
test("rejects malformed local targets and cursors before provider requests", async () => {
  const transport = vi.fn<typeof fetch>(),
    provider = new CertSpotterProvider({ fetch: transport });
  for (const host of [
    "a.".repeat(128) + "test",
    "gateway.example.test/path",
    "127.0.0.1",
    "https://gateway.example.test",
    "gateway.example.test:443",
  ])
    await expect(provider.page(host, undefined, signal())).rejects.toMatchObject({
      code: "ct-provider-unavailable",
    });
  await expect(provider.page("gateway.example.test", "bad cursor", signal())).rejects.toMatchObject(
    { code: "ct-provider-unavailable" },
  );
  expect(transport).not.toHaveBeenCalled();
});
test("bounds pages and bodies and reports malformed provider data instead of claiming completion", async () => {
  for (const response of [
    Response.json({}),
    Response.json(Array.from({ length: 257 }, () => ({ id: "1", cert_der: der }))),
    new Response("{"),
    new Response(null),
    new Response("x".repeat(1048577)),
  ]) {
    const provider = new CertSpotterProvider({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    await expect(provider.page("gateway.example.test", undefined, signal())).rejects.toMatchObject({
      code: "ct-provider-invalid",
    });
  }
  const provider = new CertSpotterProvider({
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json([
          { id: "good", cert_der: der },
          { id: "bad", cert_der: "!" },
          { id: "empty", cert_der: "" },
          { id: "short", cert_der: "YQ" },
          null,
        ]),
      ),
  });
  expect(await provider.page("gateway.example.test", undefined, signal())).toMatchObject({
    complete: false,
    invalidEntries: 4,
    lastId: "good",
    entries: [{ entryId: "good" }],
  });
});
test("service, rate and authentication failures have static codes and bounded Retry-After without leaking bodies", async () => {
  for (const [status, expected] of [
    [429, "ct-provider-unavailable"],
    [503, "ct-provider-unavailable"],
    [401, "ct-provider-refused"],
  ] as const) {
    const provider = new CertSpotterProvider({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("provider-private-body", { status, headers: { "retry-after": "99999999" } }),
        ),
    });
    await expect(provider.page("gateway.example.test", undefined, signal())).rejects.toMatchObject({
      message: expected,
      code: expected,
      retryAfterMs: 86400000,
    });
  }
  const noBody = new CertSpotterProvider({
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 403, headers: { "retry-after": "not-seconds" } }),
      ),
  });
  await expect(noBody.page("gateway.example.test", undefined, signal())).rejects.toMatchObject({
    code: "ct-provider-refused",
    retryAfterMs: undefined,
  });
});
test("caller cancellation and transport errors do not expose nested secret-bearing causes", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = vi.fn<typeof fetch>(),
    provider = new CertSpotterProvider({ fetch: transport });
  await expect(
    provider.page("gateway.example.test", undefined, controller.signal),
  ).rejects.toMatchObject({ code: "ct-provider-unavailable" });
  expect(transport).not.toHaveBeenCalled();
  transport.mockRejectedValue(new Error("private-path-and-api-key"));
  try {
    await provider.page("gateway.example.test", undefined, signal());
    throw new Error("Expected refusal");
  } catch (error) {
    expect(String(error)).not.toContain("private-path");
    expect(error).not.toHaveProperty("cause");
  }
  const abort = new AbortController();
  const late = new CertSpotterProvider({
    fetch: () => {
      abort.abort();
      return Promise.resolve(Response.json([]));
    },
  });
  await expect(late.page("gateway.example.test", undefined, abort.signal)).rejects.toMatchObject({
    code: "ct-provider-unavailable",
  });
});
