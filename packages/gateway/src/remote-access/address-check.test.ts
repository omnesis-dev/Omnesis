// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  ADDRESS_CHECK_PATH,
  AddressChecks,
  certificateSentence,
  type AddressCheckDeps,
} from "./address-check.js";

/** An address that forwards to `answer`, which stands for whatever serves there. */
function deps(
  over: Partial<AddressCheckDeps> & {
    answer?: (path: string) => Promise<{ status: number; body: string }>;
  } = {},
) {
  let now = 1_000;
  const checks: { value?: AddressChecks } = {};
  const base: AddressCheckDeps = {
    resolve: async () => "203.0.113.7",
    certificateProblem: async () => null,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      const reply = over.answer
        ? await over.answer(path)
        : // This gateway, behind the address: it answers the nonce it issued.
          checks.value!.answer(path.slice(ADDRESS_CHECK_PATH.length + 1))
          ? { status: 200, body: path.slice(ADDRESS_CHECK_PATH.length + 1) }
          : { status: 404, body: "" };
      return { status: reply.status, text: async () => reply.body };
    },
    now: () => now,
    ...over,
  };
  checks.value = new AddressChecks(base);
  return { checks: checks.value, advance: (ms: number) => (now += ms) };
}

describe("AddressChecks", () => {
  test("an address that resolves, has a valid certificate and reaches this gateway passes every step", async () => {
    const { checks } = deps();
    const result = await checks.check("https://omnesis.example.org/some/path");
    expect(result.url).toBe("https://omnesis.example.org");
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.id, s.ok])).toEqual([
      ["resolves", true],
      ["certificate", true],
      ["answers", true],
    ]);
    expect(result.steps[0]!.detail).toContain("203.0.113.7");
  });

  test("stops at a name that does not resolve", async () => {
    const certificateProblem = vi.fn();
    const { checks } = deps({
      resolve: async () => Promise.reject(new Error("ENOTFOUND")),
      certificateProblem,
    });
    const result = await checks.check("https://missing.example.org");
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([expect.objectContaining({ id: "resolves", ok: false })]);
    expect(certificateProblem).not.toHaveBeenCalled();
  });

  test("an IPv6 literal is resolved and verified without its brackets", async () => {
    const seen: string[] = [];
    const { checks } = deps({
      resolve: async (host) => (seen.push(host), host),
      certificateProblem: async (host) => (seen.push(host), null),
    });
    await checks.check("https://[2001:db8::7]:8443");
    expect(seen).toEqual(["2001:db8::7", "2001:db8::7"]);
  });

  test("a TLS failure is told as a fixed sentence, never what the far end sent", () => {
    const failure = (code: string) =>
      Object.assign(new Error(`Hostname/IP does not match: DNS:internal.example.net`), { code });
    expect(certificateSentence(failure("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(
      "It is for a different name.",
    );
    expect(certificateSentence(failure("CERT_HAS_EXPIRED"))).toBe("It has expired.");
    expect(certificateSentence(failure("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe(
      "It is not from an authority this computer trusts.",
    );
    expect(certificateSentence(failure("ECONNREFUSED"))).toBe(
      "Nothing accepted a connection there.",
    );
    expect(certificateSentence(failure("SOMETHING_ELSE"))).toBe("It could not be verified.");
  });

  test("stops at a certificate the platform does not accept, naming why", async () => {
    const { checks } = deps({ certificateProblem: async () => "self-signed certificate" });
    const result = await checks.check("https://omnesis.example.org:8443");
    expect(result.steps.at(-1)).toEqual({
      id: "certificate",
      ok: false,
      detail: "The certificate was not accepted: self-signed certificate",
    });
  });

  test("something else answering at the address is not this gateway", async () => {
    const { checks } = deps({ answer: async () => ({ status: 200, body: "a different server" }) });
    const result = await checks.check("https://omnesis.example.org");
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ id: "answers", ok: false });
    expect(result.steps.at(-1)!.detail).toContain("200");
  });

  test("an address that does not answer in time fails the last step", async () => {
    const { checks } = deps({ fetch: async () => Promise.reject(new Error("aborted")) });
    const result = await checks.check("https://omnesis.example.org");
    expect(result.steps.at(-1)).toEqual({
      id: "answers",
      ok: false,
      detail: "The address did not answer in time.",
    });
  });

  test("a nonce is answered once, only while current, and never one this gateway did not issue", async () => {
    let issued = "";
    const { checks } = deps({
      answer: async (path) => {
        issued = path.slice(ADDRESS_CHECK_PATH.length + 1);
        return { status: 404, body: "" };
      },
    });
    expect(checks.answer("never-issued-nonce-value")).toBe(false);
    await checks.check("https://omnesis.example.org");
    // The check spends its nonce when it ends, answered or not.
    expect(checks.answer(issued)).toBe(false);
  });

  test("an issued nonce expires", async () => {
    let issued = "";
    let delay = 0;
    const { checks, advance } = deps({
      answer: async (path) => {
        issued = path.slice(ADDRESS_CHECK_PATH.length + 1);
        advance(delay);
        return { status: 200, body: checks.answer(issued) ? issued : "" };
      },
    });
    delay = 31_000;
    const late = await checks.check("https://omnesis.example.org");
    expect(late.steps.at(-1)).toMatchObject({ id: "answers", ok: false });
  });
});
