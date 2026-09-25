// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { registeredRedirectMatches } from "./redirect-uri.js";

describe("registeredRedirectMatches", () => {
  test("ignores only the port for native loopback redirects", () => {
    expect(
      registeredRedirectMatches(
        "http://127.0.0.1:41001/callback?channel=desktop",
        "http://127.0.0.1:52992/callback?channel=desktop",
      ),
    ).toBe(true);
    expect(
      registeredRedirectMatches("http://localhost:41001/callback", "http://localhost:52992/other"),
    ).toBe(false);
    expect(
      registeredRedirectMatches(
        "http://127.0.0.1:41001/callback",
        "http://localhost:52992/callback",
      ),
    ).toBe(false);
  });

  test("keeps non-loopback redirects byte-exact", () => {
    expect(
      registeredRedirectMatches(
        "https://client.example.org/callback",
        "https://client.example.org:8443/callback",
      ),
    ).toBe(false);
  });
});
