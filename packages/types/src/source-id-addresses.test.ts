// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One id addressing another.
 *
 * This predicate had five independent implementations before it had one, and
 * the divergences were not theoretical: one shipped as a watch that validated,
 * installed, sat active and never fired. So the cases below are the ones the
 * copies disagreed about, not a survey of the obvious.
 */

import { describe, expect, test } from "vitest";
import { sourceAccountOf, sourceIdAddresses, sourceTypeOf } from "./ids.js";

describe("naming a type widens; naming an account is exact", () => {
  test("a bare type covers every account of it", () => {
    expect(sourceIdAddresses("gmail", "gmail:someone@example.com")).toBe(true);
    expect(sourceIdAddresses("gmail", "gmail:other@example.com")).toBe(true);
  });

  test("a qualified id covers only itself", () => {
    expect(sourceIdAddresses("gmail:someone@example.com", "gmail:someone@example.com")).toBe(true);
    expect(sourceIdAddresses("gmail:someone@example.com", "gmail:other@example.com")).toBe(false);
    // The failure that shipped: equality alone. Every fixture universe names
    // its sources by bare type, so a broken widening passes a whole suite and
    // then matches nothing on an install that has ever added an account.
    expect(sourceIdAddresses("gmail:someone@example.com", "gmail")).toBe(false);
  });

  test("an id is addressed by itself when neither names an account", () => {
    expect(sourceIdAddresses("things", "things")).toBe(true);
  });
});

describe("the comparison is on the type, not on the characters", () => {
  test("a type does not swallow a longer type that starts with it", () => {
    // A prefix test would say yes, and these are different sources.
    expect(sourceIdAddresses("gmail", "gmail-archive:someone@example.com")).toBe(false);
    expect(sourceIdAddresses("apple", "apple-health:local")).toBe(false);
  });

  test("a type does not match a longer bare type", () => {
    expect(sourceIdAddresses("gmail", "gmail-archive")).toBe(false);
  });
});

describe("it is total, because every caller is inside a loop it did not choose", () => {
  // A throw here abandons the rest of a config teardown, a drain batch or a
  // reconcile pass, rather than skipping the one entry that was malformed.
  test.each([
    ["", ""],
    ["", "gmail:a@example.com"],
    ["gmail", ""],
    [":", "gmail:a@example.com"],
    ["gmail:", "gmail:a@example.com"],
    ["gmail:a:b", "gmail:a@example.com"],
    ["gmail", "gmail:a:b"],
  ])("does not throw on (%s, %s)", (named, sourceId) => {
    expect(() => sourceIdAddresses(named, sourceId)).not.toThrow();
    expect(typeof sourceIdAddresses(named, sourceId)).toBe("boolean");
  });

  test("an empty name addresses nothing", () => {
    expect(sourceIdAddresses("", "gmail:a@example.com")).toBe(false);
  });

  test("a trailing colon is an account-qualified name of nothing", () => {
    // It contains a colon, so it is exact — and it equals nothing real.
    expect(sourceIdAddresses("gmail:", "gmail:a@example.com")).toBe(false);
  });
});

describe("an account id that contains the separator's neighbours", () => {
  test("an email account is matched whole", () => {
    expect(sourceIdAddresses("gmail:a+b@example.com", "gmail:a+b@example.com")).toBe(true);
  });

  test("a labelled account is not matched by the login it extends", () => {
    // Two tokens for one person are two accounts, and the label is what says
    // so. Widening across it would merge them.
    expect(sourceIdAddresses("github:octocat", "github:octocat@acme-org")).toBe(false);
  });
});

describe("the two halves of a source id", () => {
  test("a qualified id splits at the first colon", () => {
    expect(sourceTypeOf("gmail:someone@example.com")).toBe("gmail");
    expect(sourceAccountOf("gmail:someone@example.com")).toBe("someone@example.com");
  });

  test("an account id may itself contain the separator", () => {
    // The split is at the FIRST colon, so everything after it — colons
    // included — is one account id. Splitting at the last one would rename
    // the account and address a source that does not exist.
    expect(sourceTypeOf("gmail:a:b")).toBe("gmail");
    expect(sourceAccountOf("gmail:a:b")).toBe("a:b");
  });

  test("an id naming no account has no account half", () => {
    expect(sourceTypeOf("things")).toBe("things");
    expect(sourceAccountOf("things")).toBe("");
  });

  test("a trailing colon names no account", () => {
    expect(sourceTypeOf("gmail:")).toBe("gmail");
    expect(sourceAccountOf("gmail:")).toBe("");
  });

  test("an id with no usable type half answers with itself", () => {
    // `""` would be worse than useless: it collides with every other
    // malformed id, and it addresses all of them.
    expect(sourceTypeOf(":account")).toBe(":account");
    expect(sourceAccountOf(":account")).toBe("");
    expect(sourceIdAddresses("", ":account")).toBe(true);
  });

  test("the type half of an id addresses that id", () => {
    // The property that makes these safe to use where the addressing rule is
    // what matters — grouping rows by type, widening a config key.
    for (const id of [
      "things",
      "gmail:someone@example.com",
      "gmail:a:b",
      "gmail:",
      ":account",
      "",
    ]) {
      expect(sourceIdAddresses(sourceTypeOf(id), id), id).toBe(true);
    }
  });

  test("every malformed shape has an answer, and it is this one", () => {
    // Asserting "does not throw" says nothing about a function with no throw
    // path. The values are the part a careless rewrite would get wrong.
    expect(
      ["", ":", "::", "a:", ":a"].map((id) => [sourceTypeOf(id), sourceAccountOf(id)]),
    ).toEqual([
      ["", ""],
      [":", ""],
      ["::", ""],
      ["a", ""],
      [":a", ""],
    ]);
  });
});
