// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { BROWSER_EXTENSION_DOCS_URL, browserExtensionTrust } from "./browser-trust.js";
import type { TlsLifecycleSnapshot, TlsOwnership } from "@omnesis/core";

type Served = TlsLifecycleSnapshot["served"];

function served(overrides: Partial<Served> = {}): Served {
  return {
    state: "valid",
    fingerprintSha256: "ab".repeat(32),
    subject: "CN=gateway.example.com",
    issuer: "CN=Example CA",
    selfSigned: false,
    notBefore: "2026-09-01T00:00:00.000Z",
    notAfter: "2026-12-01T00:00:00.000Z",
    daysRemaining: 60,
    names: ["gateway.example.com"],
    uncoveredHosts: [],
    ...overrides,
  };
}

function snapshot(
  ownership: TlsOwnership,
  servedOverrides: Partial<Served> = {},
  proxiedHosts?: string[],
) {
  return {
    ownership,
    served: served(servedOverrides),
    ...(proxiedHosts ? { proxiedHosts } : {}),
  };
}

const native = { inContainer: false };
const container = { inContainer: true };

describe("browserExtensionTrust", () => {
  test("a self-signed certificate is untrusted, says why, and names the native fixes", () => {
    const verdict = browserExtensionTrust(
      snapshot("self-signed", { selfSigned: true, names: ["localhost", "gateway.local"] }),
      native,
    );
    expect(verdict).toMatchObject({
      status: "untrusted",
      certificate: "self-signed",
      reason: "self-signed",
      names: ["localhost", "gateway.local"],
      proxiedHosts: [],
      docsUrl: BROWSER_EXTENSION_DOCS_URL,
    });
    expect(verdict.title).toContain("Chrome extension cannot connect to this gateway");
    expect(verdict.message).toContain("self-signed certificate");
    expect(verdict.message).toContain("cannot click through a certificate warning");
    // The error the operator would otherwise meet with no explanation.
    expect(verdict.message).toContain("The connection to the gateway failed before it answered.");
    expect(verdict.remedy).toContain("re-run the installer on the gateway host");
    expect(verdict.remedy).toContain("with Tailscale up");
    expect(verdict.remedy).toContain("`omnesis tls provision`");
  });

  test("inside a container the fix never names `omnesis tls provision`, which refuses to run there", () => {
    const verdict = browserExtensionTrust(snapshot("self-signed", { selfSigned: true }), container);
    expect(verdict.status).toBe("untrusted");
    expect(verdict.remedy).toContain("re-run the installer on the gateway host");
    expect(verdict.remedy).toContain("https://omnesis.dev/docs/install#docker-tls");
    expect(verdict.remedy).not.toContain("tls provision");
  });

  test("a Tailscale certificate is trusted and needs no message", () => {
    expect(browserExtensionTrust(snapshot("tailscale"), native)).toEqual({
      status: "trusted",
      certificate: "tailscale",
      reason: null,
      names: ["gateway.example.com"],
      proxiedHosts: [],
      title: null,
      message: null,
      remedy: null,
      docsUrl: BROWSER_EXTENSION_DOCS_URL,
    });
  });

  test("material for a trusted tier that still serves the self-signed certificate is judged by what is served", () => {
    const verdict = browserExtensionTrust(snapshot("tailscale", { selfSigned: true }), native);
    expect(verdict).toMatchObject({ status: "untrusted", reason: "self-signed" });
  });

  test("an mkcert certificate is trusted only where its authority is installed", () => {
    const verdict = browserExtensionTrust(snapshot("mkcert"), native);
    expect(verdict).toMatchObject({ status: "local-ca", reason: null });
    expect(verdict.title).toContain("mkcert authority");
    expect(verdict.message).toContain("mkcert");
    expect(verdict.message).toContain("only on a machine where that mkcert authority is installed");
    expect(verdict.remedy).toContain("another machine");
  });

  test("an operator's certificate is unknown, with a softer note and no fix to run", () => {
    const verdict = browserExtensionTrust(snapshot("external"), native);
    expect(verdict).toMatchObject({ status: "unknown", reason: null, remedy: null });
    expect(verdict.title).toContain("the certificate you supplied");
    expect(verdict.message).toContain("connects only if Chrome trusts its issuer");
    expect(`${verdict.title} ${verdict.message}`).not.toContain("cannot connect");
  });

  test("an operator's self-signed certificate is untrusted like the gateway's own", () => {
    const verdict = browserExtensionTrust(snapshot("external", { selfSigned: true }), native);
    expect(verdict).toMatchObject({ status: "untrusted", reason: "self-signed" });
  });

  test("an expired certificate is untrusted whatever minted it, with a renewal the gateway can run", () => {
    const expired = { state: "expired" as const, notAfter: "2026-10-01T00:00:00.000Z" };
    for (const ownership of ["tailscale", "mkcert"] as const) {
      const verdict = browserExtensionTrust(snapshot(ownership, expired), native);
      expect(verdict).toMatchObject({ status: "untrusted", reason: "expired" });
      expect(verdict.message).toContain("expired on 2026-10-01");
      expect(verdict.remedy).toContain("`omnesis tls renew`");
    }
    const external = browserExtensionTrust(snapshot("external", expired), native);
    expect(external).toMatchObject({ status: "untrusted", reason: "expired" });
    expect(external.remedy).toContain("Replace the certificate you supplied");
  });

  test("a certificate that is not valid yet is untrusted and points at the clock", () => {
    const verdict = browserExtensionTrust(
      snapshot("tailscale", { state: "not-yet-valid", notBefore: "2027-01-01T00:00:00.000Z" }),
      native,
    );
    expect(verdict).toMatchObject({ status: "untrusted", reason: "not-yet-valid" });
    expect(verdict.message).toContain("not valid until 2027-01-01");
    expect(verdict.remedy).toContain("clock");
  });

  test("an expiring certificate is still valid, so it is judged by its tier", () => {
    expect(
      browserExtensionTrust(snapshot("tailscale", { state: "expiring", daysRemaining: 3 }), native)
        .status,
    ).toBe("trusted");
  });

  test("behind a trusted reverse proxy, an untrusted own certificate points at the proxy's address", () => {
    const verdict = browserExtensionTrust(
      snapshot("self-signed", { selfSigned: true }, ["omnesis.example.com"]),
      native,
    );
    expect(verdict).toMatchObject({
      status: "unknown",
      reason: "self-signed",
      proxiedHosts: ["omnesis.example.com"],
    });
    expect(verdict.title).toContain("through your reverse proxy");
    expect(verdict.message).toContain("self-signed certificate");
    expect(verdict.message).toContain("omnesis.example.com");
    expect(verdict.remedy).toContain("reverse proxy's address");
  });

  test("a proxy changes nothing about a trusted own certificate", () => {
    expect(
      browserExtensionTrust(snapshot("tailscale", {}, ["omnesis.example.com"]), native).status,
    ).toBe("trusted");
  });
});
