// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { canonicalScopeIdentifier } from "./scope-identifiers.js";

const value = (type: "phone" | "email" | "domain", raw: string) =>
  canonicalScopeIdentifier(type, raw)?.value ?? null;

describe("canonical source-filter identifiers", () => {
  it.each([
    "+12025550123",
    "+1 (202) 555-0123",
    "+1 202 555 0123",
    "+1.202.555.0123",
    "+1-202-555-0123",
    "  +1 202-555-0123\n",
    "+1 202 555 0123",
    "+1 202‑555–0123",
    "0012025550123",
    "00 1 202 555 0123",
    "tel:+1-202-555-0123",
    "＋１２０２５５５０１２３",
  ])("reads the international phone number written as %j", (raw) => {
    expect(value("phone", raw)).toBe("+12025550123");
  });

  it.each([
    ["no country code", "12025550123"],
    ["national format", "(202) 555-0123"],
    ["a national trunk zero", "02025550123"],
    ["an ambiguous trunk prefix", "+44 (0)7700 900123"],
    ["a messaging address", "12025550123@s.whatsapp.net"],
    ["an opaque platform id", "224466880011@lid"],
    ["a group address", "120363000000000001@g.us"],
    ["too few digits", "+12"],
    ["too many digits", `+${"9".repeat(16)}`],
    ["a leading zero country code", "+012025550123"],
    ["letters", "+1 202 555 CALL"],
    ["an extension", "+12025550123x4"],
    ["nothing", ""],
  ])("refuses a phone number with %s", (_reason, raw) => {
    expect(value("phone", raw)).toBeNull();
  });

  it.each([
    ["maya@example.org", "maya@example.org"],
    ["  Maya@Example.ORG ", "maya@example.org"],
    ["<maya@example.org>", "maya@example.org"],
    ["Maya Reeves <Maya@example.org>", "maya@example.org"],
    ['"Reeves, Maya" <maya@example.org>', "maya@example.org"],
    ["mailto:maya@example.org", "maya@example.org"],
    ["maya@example.org.", "maya@example.org"],
    ["maya+receipts@example.org", "maya+receipts@example.org"],
    ["maya.reeves@example.org", "maya.reeves@example.org"],
    ["Fictional.Scope.Check+Filter@gmail.com", "fictionalscopecheck@gmail.com"],
    ["fictional.scope.check@googlemail.com", "fictionalscopecheck@gmail.com"],
    ["o'neil&co/billing=7@example.org", "o'neil&co/billing=7@example.org"],
    ["maya@BÜCHER.example", "maya@xn--bcher-kva.example"],
    ["maya@xn--bcher-kva.example", "maya@xn--bcher-kva.example"],
    ["ｍａｙａ＠ｅｘａｍｐｌｅ．ｏｒｇ", "maya@example.org"],
  ])("canonicalizes the email address %j", (raw, expected) => {
    expect(value("email", raw)).toBe(expected);
  });

  it.each(["maya", "@example.org", "maya@", "maya@localhost", "maya reeves@example.org", ""])(
    "refuses %j as an email address",
    (raw) => {
      expect(value("email", raw)).toBeNull();
    },
  );

  it.each([
    ["example.org", "example.org"],
    ["EXAMPLE.Org", "example.org"],
    ["@example.org", "example.org"],
    [" example.org. ", "example.org"],
    ["mail.example.org", "mail.example.org"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["googlemail.com", "gmail.com"],
  ])("canonicalizes the domain %j", (raw, expected) => {
    expect(value("domain", raw)).toBe(expected);
  });

  it.each([
    "localhost",
    "*.example.org",
    "example.org/path",
    "https://example.org",
    "maya@example.org",
    "example..org",
    "-example.org",
    "example.123",
    "",
  ])("refuses %j as a domain", (raw) => {
    expect(value("domain", raw)).toBeNull();
  });

  it("is idempotent, so a saved value re-read from storage never changes", () => {
    for (const [type, raw] of [
      ["phone", "00 1 (202) 555-0123"],
      ["email", "Maya Reeves <Fictional.Scope.Check+Filter@GoogleMail.com>"],
      ["email", "maya@BÜCHER.example."],
      ["domain", "@BÜCHER.example."],
    ] as const) {
      const once = canonicalScopeIdentifier(type, raw)!;
      expect(canonicalScopeIdentifier(type, once.value)).toEqual(once);
    }
  });

  it("refuses an oversized value before doing any work on it", () => {
    expect(canonicalScopeIdentifier("email", `${"a".repeat(600)}@example.org`)).toBeNull();
  });
});
