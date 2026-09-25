// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { parseAuthCodeInput } from "./auth-code-input.js";

describe("parseAuthCodeInput", () => {
  test("full https redirect URL with code + state → the code", () => {
    expect(parseAuthCodeInput("https://auth.example.com/redirect?code=abc123&state=flow-9")).toBe(
      "abc123",
    );
  });

  test("URL code parameter is percent-decoded (code ending %40 → '@')", () => {
    expect(parseAuthCodeInput("https://auth.example.com/cb?state=f1&code=user%2Fcode%40")).toBe(
      "user/code@",
    );
  });

  test("gateway-callback-shaped URL", () => {
    expect(
      parseAuthCodeInput(
        "https://gateway.example.org:7600/oauth/callback?state=2f6f7a1c&code=4%2FxyzToken",
      ),
    ).toBe("4/xyzToken");
  });

  test("bare code passes through verbatim when it contains no '%'", () => {
    expect(parseAuthCodeInput("plain-code_123.456~x")).toBe("plain-code_123.456~x");
  });

  test("bare code containing '%' is percent-decoded", () => {
    expect(parseAuthCodeInput("enc%40oded%2Fcode")).toBe("enc@oded/code");
  });

  test("surrounding whitespace is tolerated", () => {
    expect(parseAuthCodeInput("  spaced-code \n")).toBe("spaced-code");
    expect(parseAuthCodeInput("  https://a.example.com/cb?code=ok ")).toBe("ok");
  });

  test("empty input throws with a clear message", () => {
    expect(() => parseAuthCodeInput("")).toThrow(/Empty input/);
    expect(() => parseAuthCodeInput("   \n ")).toThrow(/Empty input/);
  });

  test("URL without a code parameter throws", () => {
    expect(() => parseAuthCodeInput("https://auth.example.com/cb?state=f1")).toThrow(
      /No `code` query parameter/,
    );
  });

  test("multi-word garbage throws", () => {
    expect(() => parseAuthCodeInput("this is not a code")).toThrow(
      /doesn't look like an authorization code/,
    );
  });

  test("invalid percent-encoding in a bare code throws", () => {
    expect(() => parseAuthCodeInput("broken%GGcode")).toThrow(/could not be decoded/);
  });
});
