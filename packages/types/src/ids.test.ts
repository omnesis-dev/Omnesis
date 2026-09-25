// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  BrandedIdError,
  ProviderType,
  ProviderId,
  SourceType,
  SourceId,
  AccountId,
  tryProviderType,
  tryProviderId,
  trySourceType,
  trySourceId,
  tryAccountId,
  makeSourceId,
  makeProviderId,
  parseSourceId,
  parseProviderId,
  safePathSegment,
} from "./ids.js";

describe("branded type constructors", () => {
  test("SourceId returns branded string", () => {
    const id = SourceId("gmail:user@gmail.com");
    expect(id).toBe("gmail:user@gmail.com");
    expect(typeof id).toBe("string");
  });

  test("ProviderId returns branded string", () => {
    const id = ProviderId("google:user@gmail.com");
    expect(id).toBe("google:user@gmail.com");
  });

  test("SourceType returns branded string", () => {
    const t = SourceType("gmail");
    expect(t).toBe("gmail");
  });

  test("ProviderType returns branded string", () => {
    const t = ProviderType("google");
    expect(t).toBe("google");
  });

  test("AccountId returns branded string", () => {
    const a = AccountId("user@gmail.com");
    expect(a).toBe("user@gmail.com");
  });
});

describe("makeSourceId", () => {
  test("combines sourceType and accountId with colon", () => {
    const id = makeSourceId(SourceType("gmail"), AccountId("user@gmail.com"));
    expect(id).toBe("gmail:user@gmail.com");
  });
});

describe("makeProviderId", () => {
  test("combines providerType and accountId with colon", () => {
    const id = makeProviderId(ProviderType("google"), AccountId("user@gmail.com"));
    expect(id).toBe("google:user@gmail.com");
  });
});

describe("parseSourceId", () => {
  test("splits on first colon", () => {
    const result = parseSourceId(SourceId("gmail:user@gmail.com"));
    expect(result.sourceType).toBe("gmail");
    expect(result.accountId).toBe("user@gmail.com");
  });

  test("returns 'local' accountId when no colon present", () => {
    const result = parseSourceId(SourceId("things"));
    expect(result.sourceType).toBe("things");
    expect(result.accountId).toBe("local");
  });

  test("rejects multi-colon SourceIds (one-colon limit, see ids.ts)", () => {
    // SourceId() validates shape on construction. The earlier behaviour —
    // splitting on the first colon and tolerating colons inside the
    // accountId portion — is now a hard error to keep id parsing
    // unambiguous and prevent injection-style accountIds. No production
    // codepath relies on multi-colon ids.
    expect(() => SourceId("apple-reminders:uuid:1234")).toThrow(/at most one colon/);
  });
});

describe("parseProviderId", () => {
  test("splits on first colon", () => {
    const result = parseProviderId(ProviderId("google:user@gmail.com"));
    expect(result.providerType).toBe("google");
    expect(result.accountId).toBe("user@gmail.com");
  });

  test("returns 'local' accountId when no colon present", () => {
    const result = parseProviderId(ProviderId("system"));
    expect(result.providerType).toBe("system");
    expect(result.accountId).toBe("local");
  });
});

describe("validation — throwing constructors", () => {
  // The whole point of the new constructors: rejecting malformed input
  // at the brand boundary instead of silently flowing through as a typed
  // value. The detailed message format is `BrandedIdError`'s job and
  // pinning the `kind` lets `instanceof` callers branch cleanly.
  function expectError(fn: () => unknown, kind: BrandedIdError["kind"]) {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(BrandedIdError);
      expect((err as BrandedIdError).kind).toBe(kind);
      return;
    }
    throw new Error(`expected ${kind} error, got none`);
  }

  test("SourceType: rejects empty / uppercase / spaces / leading-hyphen / oversize", () => {
    expectError(() => SourceType(""), "SourceType");
    expectError(() => SourceType("Gmail"), "SourceType"); // uppercase
    expectError(() => SourceType("gmail "), "SourceType"); // trailing space
    expectError(() => SourceType(" gmail"), "SourceType"); // leading space
    expectError(() => SourceType("gmail\n"), "SourceType"); // embedded newline
    expectError(() => SourceType("-gmail"), "SourceType"); // leading hyphen
    expectError(() => SourceType("a".repeat(65)), "SourceType"); // oversize
    expect(SourceType("gmail")).toBe("gmail");
    expect(SourceType("apple-health")).toBe("apple-health");
    expect(SourceType("a")).toBe("a"); // min length
  });

  test("ProviderType: same rules as SourceType", () => {
    expectError(() => ProviderType(""), "ProviderType");
    expectError(() => ProviderType("Google"), "ProviderType");
    expect(ProviderType("google")).toBe("google");
  });

  test("AccountId: rejects empty / whitespace / colons / control chars", () => {
    expectError(() => AccountId(""), "AccountId");
    expectError(() => AccountId(" "), "AccountId");
    expectError(() => AccountId("foo bar"), "AccountId");
    expectError(() => AccountId("foo:bar"), "AccountId");
    expectError(() => AccountId("foo\nbar"), "AccountId");
    expectError(() => AccountId("foo\tbar"), "AccountId");
    expectError(() => AccountId("a".repeat(257)), "AccountId");
    expect(AccountId("user@gmail.com")).toBe("user@gmail.com");
    expect(AccountId("+447700000000")).toBe("+447700000000");
    expect(AccountId("local")).toBe("local");
  });

  test("AccountId: rejects path-traversal shapes (SEC-14)", () => {
    // Account IDs double as on-disk credential directory names, so a
    // path-shaped value must never construct.
    expectError(() => AccountId("../../etc"), "AccountId"); // separators
    expectError(() => AccountId("a/b"), "AccountId"); // forward slash
    expectError(() => AccountId("a\\b"), "AccountId"); // backslash
    expectError(() => AccountId("."), "AccountId"); // current-dir segment
    expectError(() => AccountId(".."), "AccountId"); // parent-dir segment
    // A dot *inside* a name is still fine (e.g. a messaging handle whose
    // account ID embeds a dotted hostname).
    expect(AccountId("user@host.example.net")).toBe("user@host.example.net");
    expect(AccountId("..foo")).toBe("..foo"); // leading dots, not a traversal segment
  });

  test("tryAccountId / parse reject path-traversal shapes (SEC-14)", () => {
    expect(tryAccountId("a/b")).toBeNull();
    expect(tryAccountId("..")).toBeNull();
    expect(tryAccountId(".")).toBeNull();
    // The account half of a compound id is re-validated through AccountId().
    expectError(() => parseSourceId(SourceId("gmail:..")), "AccountId");
    expectError(() => SourceId("gmail:a/b"), "SourceId");
  });

  test("SourceId: rejects multi-colon, whitespace, empty parts", () => {
    expectError(() => SourceId(""), "SourceId");
    expectError(() => SourceId("gmail:"), "SourceId");
    expectError(() => SourceId(":user@gmail.com"), "SourceId");
    expectError(() => SourceId("gmail:foo:bar"), "SourceId");
    expectError(() => SourceId("gmail user@gmail.com"), "SourceId");
    expectError(() => SourceId("Gmail:user@gmail.com"), "SourceId");
    expect(SourceId("gmail:user@gmail.com")).toBe("gmail:user@gmail.com");
    expect(SourceId("things")).toBe("things"); // bare type
  });

  test("ProviderId: same rules as SourceId", () => {
    expectError(() => ProviderId(""), "ProviderId");
    expectError(() => ProviderId("google:foo:bar"), "ProviderId");
    expect(ProviderId("system")).toBe("system");
    expect(ProviderId("google:user@gmail.com")).toBe("google:user@gmail.com");
  });

  test("BrandedIdError carries the kind so callers can branch", () => {
    try {
      SourceId("");
    } catch (err) {
      expect(err).toBeInstanceOf(BrandedIdError);
      const e = err as BrandedIdError;
      expect(e.kind).toBe("SourceId");
      expect(e.input).toBe("");
      expect(e.name).toBe("BrandedIdError");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("validation — non-throwing tryX parallels", () => {
  test("trySourceType / tryProviderType / tryAccountId return null on bad input", () => {
    expect(trySourceType("Gmail")).toBeNull();
    expect(trySourceType("gmail")).toBe("gmail");
    expect(tryProviderType("")).toBeNull();
    expect(tryProviderType("google")).toBe("google");
    expect(tryAccountId("foo:bar")).toBeNull();
    expect(tryAccountId("user@example.com")).toBe("user@example.com");
  });

  test("trySourceId / tryProviderId return null on bad input, value on good", () => {
    expect(trySourceId("")).toBeNull();
    expect(trySourceId("gmail:foo:bar")).toBeNull();
    expect(trySourceId("gmail:user@gmail.com")).toBe("gmail:user@gmail.com");
    expect(tryProviderId("system")).toBe("system");
  });

  test("tryX accepts non-string input gracefully", () => {
    expect(trySourceId(undefined)).toBeNull();
    expect(trySourceId(42)).toBeNull();
    expect(trySourceId(null)).toBeNull();
    expect(trySourceId({})).toBeNull();
  });
});

describe("safePathSegment (SEC-14 defense-in-depth)", () => {
  test("returns safe segments unchanged", () => {
    expect(safePathSegment("user@gmail.com")).toBe("user@gmail.com");
    expect(safePathSegment("+447700000000")).toBe("+447700000000");
    expect(safePathSegment("..foo")).toBe("..foo");
  });

  test("throws on separators, traversal segments, control chars, and empties", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../x"]) {
      expect(() => safePathSegment(bad)).toThrowError(BrandedIdError);
    }
    // A space is a legal path segment — safePathSegment blocks separators
    // and traversal, not whitespace (the brand handles whitespace).
    expect(safePathSegment("x y")).toBe("x y");
  });
});
