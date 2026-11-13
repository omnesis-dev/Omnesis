// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, expect, test, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ apiFetch: request }));
import {
  relayManagement,
  relayError,
  relayHttpsUrl,
  gatewayVersion,
  googleAuthorizationUrl,
  accountAuthorizationUrl,
  relaySignupAccess,
  // @ts-expect-error portal JS
} from "./cloud-relay-api.js";
afterEach(() => vi.clearAllMocks());
test("uses authenticated same-origin status and mutation calls with cancellation", async () => {
  const status = { enabled: false };
  request.mockResolvedValue({ ok: true, json: async () => status });
  const signal = new AbortController().signal;
  expect(await relayManagement("", undefined, signal)).toEqual(status);
  expect(request).toHaveBeenLastCalledWith("/admin/cloud-relay", { cache: "no-store", signal });
  await relayManagement("enable", { invitation: "fictional-invitation" }, signal);
  expect(request).toHaveBeenLastCalledWith("/admin/cloud-relay/enable", {
    cache: "no-store",
    signal,
    method: "POST",
    body: '{"invitation":"fictional-invitation"}',
  });
});
test("never displays server bodies, unknown codes, paths or credentials", async () => {
  request.mockResolvedValue({ ok: false, text: () => "private-key-secret" });
  await expect(relayManagement("disable", {})).rejects.toThrow("Couldn't update your Omnesis account settings");
  expect(relayError()).toBe("");
  expect(relayError("unknown-secret-path")).toBe("An operation failed. Check settings and retry.");
  expect(relayError("__proto__")).toBe("An operation failed. Check settings and retry.");
  for (const code of [
    "relay-service-mismatch",
    "relay-service-unavailable",
    "configuration-invalid",
    "relay-unreachable",
    "invitation-required",
    "enrollment-refused",
    "tunnel-disconnected",
    "certificate-setup-failed",
    "certificate-renewal-failed",
    "public-endpoint-unreachable",
    "not-allowed",
  ])
    expect(relayError(code)).not.toContain("An operation failed");
});
test("an invite-only relay's request link is shown only as a safe https address, with its host", () => {
  const requestAccessUrl = "https://groups.example.com/g/fictional-testers";
  expect(relaySignupAccess({ signup: { inviteOnly: true, requestAccessUrl } })).toEqual({
    url: requestAccessUrl,
    host: "groups.example.com",
  });
  for (const status of [
    null,
    {},
    { signup: null },
    { signup: { inviteOnly: "true", requestAccessUrl } },
    { signup: { inviteOnly: true, requestAccessUrl: "http://groups.example.com/" } },
    { signup: { inviteOnly: true, requestAccessUrl: "https://a:b@groups.example.com/" } },
    { signup: { inviteOnly: true, requestAccessUrl: ["https://groups.example.com/"] } },
  ])
    expect(relaySignupAccess(status)).toBeNull();
});
test("the gateway version is read from health and is never an error or an odd string", async () => {
  request.mockResolvedValue({ ok: true, json: async () => ({ version: "9.8.7-rc.1" }) });
  expect(await gatewayVersion()).toBe("9.8.7-rc.1");
  expect(request).toHaveBeenLastCalledWith("/health", { cache: "no-store" });
  for (const reply of [
    { ok: false, json: async () => ({ version: "9.8.7" }) },
    { ok: true, json: async () => ({ version: "9.8.7\nInjected: line" }) },
    { ok: true, json: async () => ({ version: 7 }) },
    { ok: true, json: async () => ({}) },
  ]) {
    request.mockResolvedValue(reply);
    expect(await gatewayVersion()).toBe("");
  }
  request.mockRejectedValue(new Error("offline"));
  expect(await gatewayVersion()).toBe("");
});
test("only known typed refusal codes cross the API error boundary", async () => {
  request.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ code: "ca-terms-required", error: "secret" }),
  });
  await expect(relayManagement("enable", {})).rejects.toMatchObject({ code: "ca-terms-required" });
  for (const body of [null, { code: "secret" }]) {
    request.mockResolvedValueOnce({ ok: false, json: async () => body });
    await expect(relayManagement("enable", {})).rejects.not.toHaveProperty("code");
  }
});
test("public terms links allow HTTPS without credentials and refuse invalid or executable URLs", () => {
  expect(relayHttpsUrl("https://ca.example.test/terms")).toBe("https://ca.example.test/terms");
  for (const value of [
    undefined,
    42,
    "https://" + "x".repeat(2050),
    "invalid",
    "http://ca.example.test/terms",
    "javascript:alert(1)",
    "https://user@ca.example.test/terms",
    "https://:password@ca.example.test/terms",
  ])
    expect(relayHttpsUrl(value)).toBeNull();
});

test("Google account linking can navigate only the fixed Google authorization endpoint", () => {
  expect(
    googleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=fictional"),
  ).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  for (const value of [
    undefined,
    "https://attacker.example.test/o/oauth2/v2/auth",
    "https://accounts.google.com/other",
    "http://accounts.google.com/o/oauth2/v2/auth",
  ])
    expect(() => googleAuthorizationUrl(value)).toThrow("Google authorization is unavailable");
});

test("a conflicting SNI hostname gets clear guidance without exposing certificate paths", () => {
  expect(relayError("hostname-conflict")).toBe(
    "Choose a different public gateway hostname. This name is already covered by the direct/default certificate.",
  );
});

test("certificate log check failures read as one of two plain sentences", () => {
  const sentences = new Set<string>();
  for (const code of [
    "ct-configuration-invalid",
    "ct-provider-unavailable",
    "ct-provider-refused",
    "ct-provider-invalid",
    "ct-scan-incomplete",
    "ct-journal-invalid",
    "ct-journal-write-failed",
  ]) {
    expect(relayError(code)).toContain("The check for unexpected certificates");
    sentences.add(relayError(code));
  }
  expect(sentences.size).toBe(2);
});

test("managed owner linking permits only the enrolled installation origin and exact launch contract", () => {
  const origin = "https://relay.example.test";
  const query = "operationId=00000000-0000-4000-8000-000000000000&ticket=" + "a".repeat(43);
  const url = origin + "/_relay/v2/google/browser/begin?" + query;
  expect(googleAuthorizationUrl(url, origin)).toBe(url);
  for (const invalid of [undefined, "http://relay.example.test", "https://other.example.test"])
    expect(() => googleAuthorizationUrl(url, invalid)).toThrow(
      "Google authorization is unavailable",
    );
  for (const invalid of [
    url + "#fragment",
    url + "&extra=1",
    url + "&ticket=" + "b".repeat(43),
    url.replace("operationId=00000000-0000-4000-8000-000000000000", "operationId=invalid"),
    url.replace("ticket=" + "a".repeat(43), "ticket=short"),
    origin +
      "/_relay/v2/google/browser/begin?operationId=00000000-0000-4000-8000-000000000000&operationId=00000000-0000-4000-8000-000000000000",
    origin +
      "/_relay/v2/google/browser/begin?ticket=" +
      "a".repeat(43) +
      "&ticket=" +
      "b".repeat(43),
    url.replace("/begin?", "/callback?"),
    url.replace("relay.example.test", "attacker.example.test"),
  ])
    expect(() => googleAuthorizationUrl(invalid, origin)).toThrow(
      "Google authorization is unavailable",
    );
});

test("account handoffs never accept Google URLs or another authority's launch capability", async () => {
  const origin = "https://relay.example.test",
    query = "operationId=00000000-0000-4000-8000-000000000000&ticket=" + "a".repeat(43),
    url = origin + "/_relay/v3/account-browser/begin?" + query;
  expect(accountAuthorizationUrl(url, origin)).toBe(url);
  for (const invalid of [undefined, "http://relay.example.test", "https://other.example.test"])
    expect(() => accountAuthorizationUrl(url, invalid)).toThrow();
  for (const invalid of [
    undefined,
    "javascript:alert(1)",
    "https://accounts.google.com/o/oauth2/v2/auth",
    url + "#fragment",
    url + "&extra=1",
    url.replace("ticket=" + "a".repeat(43), "ticket=short"),
    url.replace("relay.example.test", "foreign.example.test"),
    url.replace("/begin?", "/redeem?"),
    origin +
      "/_relay/v3/account-browser/begin?ticket=" +
      "a".repeat(43) +
      "&ticket=" +
      "b".repeat(43),
  ])
    expect(() => accountAuthorizationUrl(invalid, origin)).toThrow();
});

test("account launch refuses a capability with either required query field absent", () => {
  const origin = "https://relay.example.test",
    base = origin + "/_relay/v3/account-browser/begin?";
  for (const query of [
    "ticket=" + "a".repeat(43) + "&extra=1",
    "operationId=00000000-0000-4000-8000-000000000001&extra=1",
  ])
    expect(() => accountAuthorizationUrl(base + query, origin)).toThrow();
});

// @ts-expect-error portal JS
import { relayDate, relayClock } from "./cloud-relay-api.js";
test("enrollment policy uses PUT with a body", async () => {
  request.mockResolvedValue({ ok: true, json: async () => ({}) });
  await relayManagement("enrollment", { policy: "ask" }, undefined, "PUT");
  expect(request).toHaveBeenLastCalledWith("/admin/cloud-relay/enrollment", {
    cache: "no-store",
    signal: undefined,
    method: "PUT",
    body: '{"policy":"ask"}',
  });
});
test("dates and clock times accept ISO strings, milliseconds and Unix seconds, and refuse garbage", () => {
  const ms = Date.UTC(2027, 0, 10, 12);
  const date = new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  expect(relayDate(ms)).toBe(date);
  expect(relayDate(ms / 1000)).toBe(date);
  expect(relayDate(new Date(ms).toISOString())).toBe(date);
  for (const value of [undefined, null, "", "not a date"]) expect(relayDate(value)).toBe("");
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  expect(relayClock(ms)).toBe(time);
  expect(relayClock(ms / 1000)).toBe(time);
  for (const value of [undefined, "12:00", Number.NaN]) expect(relayClock(value)).toBe("");
});
