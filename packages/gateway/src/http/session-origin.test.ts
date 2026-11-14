// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  credentialedCorsOrigins,
  csrfTokenMatches,
  portalSessionMayAct,
} from "./session-origin.js";

const TOKEN = "a".repeat(64);
const HOST = "g-fictional1.relay.example.test";

function request(method: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, header: (name: string) => lower[name.toLowerCase()] };
}

describe("portalSessionMayAct", () => {
  test("safe methods never need proof", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"])
      expect(portalSessionMayAct(request(method, { "Sec-Fetch-Site": "cross-site" }), TOKEN)).toBe(
        true,
      );
  });

  test("the synchronizer token is proof on its own", () => {
    expect(portalSessionMayAct(request("POST", { "X-Omnesis-CSRF": TOKEN }), TOKEN)).toBe(true);
    expect(
      portalSessionMayAct(request("DELETE", { "X-Omnesis-CSRF": "b".repeat(64) }), TOKEN),
    ).toBe(false);
    expect(portalSessionMayAct(request("PATCH", { "X-Omnesis-CSRF": "short" }), TOKEN)).toBe(false);
  });

  test("fetch metadata decides when the browser sends it", () => {
    const at = (site: string, origin?: string) =>
      portalSessionMayAct(
        request("POST", {
          "Sec-Fetch-Site": site,
          Host: HOST,
          ...(origin ? { Origin: origin } : {}),
        }),
        TOKEN,
      );
    expect(at("same-origin")).toBe(true);
    expect(at("none")).toBe(true);
    expect(at("same-site", "https://g-other.relay.example.test")).toBe(false);
    expect(at("cross-site", "https://attacker.example.test")).toBe(false);
    // The browser said same-site; naming this host as the origin changes nothing.
    expect(at("same-site", `https://${HOST}`)).toBe(false);
  });

  test("without fetch metadata, only an Origin naming this host passes", () => {
    const from = (origin: string | undefined, host: string | null = HOST) =>
      portalSessionMayAct(
        request("POST", { ...(host ? { Host: host } : {}), ...(origin ? { Origin: origin } : {}) }),
        TOKEN,
      );
    expect(from(`https://${HOST}`)).toBe(true);
    expect(from(`https://${HOST}`, `${HOST}:443`)).toBe(true);
    expect(from("https://localhost:7600", "localhost:7600")).toBe(true);
    expect(from("https://localhost:7601", "localhost:7600")).toBe(false);
    expect(from("https://g-other.relay.example.test")).toBe(false);
    expect(from(`https://${HOST}.attacker.example.test`)).toBe(false);
    expect(from("null")).toBe(false);
    expect(from("not a url")).toBe(false);
    expect(from(undefined)).toBe(false);
    expect(from(`https://${HOST}`, null)).toBe(false);
  });

  test("an origin the operator allowed for credentialed CORS passes", () => {
    const allowed = ["https://app.example.test"];
    expect(
      portalSessionMayAct(
        request("POST", { "Sec-Fetch-Site": "same-site", Origin: "https://app.example.test" }),
        TOKEN,
        allowed,
      ),
    ).toBe(true);
    expect(
      portalSessionMayAct(
        request("POST", { "Sec-Fetch-Site": "same-site", Origin: "https://other.example.test" }),
        TOKEN,
        allowed,
      ),
    ).toBe(false);
  });
});

describe("credentialedCorsOrigins", () => {
  test("only a credentialed policy contributes, and never its wildcard", () => {
    expect(credentialedCorsOrigins(undefined)).toEqual([]);
    expect(credentialedCorsOrigins({ allowedOrigins: ["https://app.example.test"] })).toEqual([]);
    expect(
      credentialedCorsOrigins({
        allowedOrigins: ["https://app.example.test", "*"],
        allowCredentials: true,
      }),
    ).toEqual(["https://app.example.test"]);
  });
});

test("csrfTokenMatches compares exactly", () => {
  expect(csrfTokenMatches(TOKEN, TOKEN)).toBe(true);
  expect(csrfTokenMatches(undefined, TOKEN)).toBe(false);
  expect(csrfTokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
});
