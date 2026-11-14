// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  FILTER_IDENTIFIER_ERRORS,
  canonicalFilterIdentifier,
  filterIdentifierDomain,
  readTypedFilterIdentifier,
  storedSpellings,
} from "./filter-identifiers.js";
import { normalizeEmail, normalizePhone } from "./people-utils.js";

const value = (type: "phone" | "email" | "domain", raw: string) =>
  canonicalFilterIdentifier(type, raw)?.value ?? null;

/** All numbers, addresses and domains here are invented. */
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
      const once = canonicalFilterIdentifier(type, raw)!;
      expect(canonicalFilterIdentifier(type, once.value)).toEqual(once);
    }
  });

  it("refuses an oversized value before doing any work on it", () => {
    expect(canonicalFilterIdentifier("email", `${"a".repeat(600)}@example.org`)).toBeNull();
  });
  it.each([
    ["a UK mobile copied from a contact card", "+44 7700 900123", "+447700900123"],
    ["a UK mobile dialled internationally", "0044 7700 900123", "+447700900123"],
    ["a UK mobile written with dots", "+44.7700.900.123", "+447700900123"],
    ["a US number with its area code in parentheses", "+1 (555) 010-0142", "+15550100142"],
    ["a trunk zero kept after the country code", "+4407700900123", "+447700900123"],
  ])("reads %s as one standard number", (_what, raw, expected) => {
    expect(value("phone", raw)).toBe(expected);
  });

  it("reads a typed mailbox address by the rule that spells the stored one", () => {
    // A source stores `normalizeEmail(address)`; typing any spelling of the
    // same mailbox must give that same text.
    for (const typed of [
      "Fictional.Scope.Check+news@gmail.com",
      " fictional.scopecheck@GMAIL.com ",
      "mailto:FictionalScopeCheck+x+y@gmail.com",
    ]) {
      expect(value("email", typed)).toBe(normalizeEmail("fictional.scope.check@gmail.com"));
    }
    expect(value("email", "Maya.Reeves+news@example.org")).toBe(
      normalizeEmail("Maya.Reeves+news@example.org"),
    );
  });

  it("spells a typed number exactly as a source that stores valid numbers does", () => {
    for (const typed of ["+1 202 555 0123", "001 (202) 555-0142", "tel:+1-202-555-0199"]) {
      expect(value("phone", typed)).toBe(normalizePhone(typed.replace(/^tel:/, "")));
    }
    // A number that fits its country's plan without being in a published
    // range is still read, so it can be saved; no stored record holds it.
    expect(normalizePhone("+1 555 010 0123")).toBeNull();
    expect(value("phone", "+1 555 010 0123")).toBe("+15550100123");
  });

  it("refuses a type it does not know rather than passing the value through", () => {
    expect(canonicalFilterIdentifier("lid" as never, "whatsapp:12345")).toBeNull();
    expect(canonicalFilterIdentifier("phone", 12025550123 as never)).toBeNull();
  });

  it("answers a typed value with the identifier, or with the sentence to show", () => {
    expect(readTypedFilterIdentifier("phone", "+1 (202) 555-0123")).toEqual({
      identifier: { type: "phone", value: "+12025550123" },
    });
    expect(readTypedFilterIdentifier("phone", "(202) 555-0123")).toEqual({
      error: "Enter a valid phone number. Include the international country code.",
    });
    expect(readTypedFilterIdentifier("phone", "+44 (0)7700 900123")).toEqual({
      error: FILTER_IDENTIFIER_ERRORS.phone,
    });
    expect(readTypedFilterIdentifier("email", "maya")).toEqual({
      error: FILTER_IDENTIFIER_ERRORS.email,
    });
    expect(readTypedFilterIdentifier("domain", "https://example.org")).toEqual({
      error: FILTER_IDENTIFIER_ERRORS.domain,
    });
  });

  it("derives the domain a domain filter compares from an email address", () => {
    expect(filterIdentifierDomain("maya@mail.example.org")).toBe("mail.example.org");
    expect(filterIdentifierDomain("maya@xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(filterIdentifierDomain("maya")).toBeNull();
  });
});

describe("the spellings a stored record may hold", () => {
  it("gives a phone number its one spelling", () => {
    expect(storedSpellings({ type: "phone", value: "+12025550123" })).toEqual(["+12025550123"]);
  });

  it("gives a mailbox both names of its provider, canonical first", () => {
    expect(storedSpellings({ type: "email", value: "mayareeves@gmail.com" })).toEqual([
      "mayareeves@gmail.com",
      "mayareeves@googlemail.com",
    ]);
    expect(storedSpellings({ type: "domain", value: "gmail.com" })).toEqual([
      "gmail.com",
      "googlemail.com",
    ]);
  });

  it("gives an internationalized domain its Unicode form as well", () => {
    expect(storedSpellings({ type: "domain", value: "xn--bcher-kva.example" })).toEqual([
      "xn--bcher-kva.example",
      "bücher.example",
    ]);
    expect(storedSpellings({ type: "email", value: "maya@xn--bcher-kva.example" })).toEqual([
      "maya@xn--bcher-kva.example",
      "maya@bücher.example",
    ]);
  });

  it("gives a plain address or domain only itself", () => {
    expect(storedSpellings({ type: "email", value: "maya@example.org" })).toEqual([
      "maya@example.org",
    ]);
    expect(storedSpellings({ type: "domain", value: "example.org" })).toEqual(["example.org"]);
  });

  it("every spelling reads back to the canonical identifier", () => {
    for (const identifier of [
      { type: "email", value: "mayareeves@gmail.com" },
      { type: "email", value: "maya@xn--bcher-kva.example" },
      { type: "domain", value: "gmail.com" },
      { type: "domain", value: "xn--bcher-kva.example" },
      { type: "phone", value: "+447700900123" },
    ] as const) {
      for (const spelling of storedSpellings(identifier)) {
        expect(canonicalFilterIdentifier(identifier.type, spelling)).toEqual(identifier);
      }
    }
  });
});
