// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Identity, declared instead of inferred.
 *
 * The cases below are the inferences this replaces, not a survey of the type.
 * Two of them are in the tree today: an account is taken to be the operator's
 * own address because its id contains an `@`, and a provider that had to
 * distinguish two connections for one person put a second separator inside the
 * id and taught four other places to strip it out again.
 */

import { describe, expect, test } from "vitest";
import {
  accountEmail,
  accountLabel,
  isAccountDescriptor,
  toAccountDescriptor,
  type AccountDescriptor,
} from "./account-descriptor.js";

describe("a source says as much as it knows, and no more", () => {
  test("a bare id is a descriptor with nothing else claimed", () => {
    expect(toAccountDescriptor("local")).toEqual({ id: "local" });
  });

  test("a descriptor passes through untouched", () => {
    const declared: AccountDescriptor = {
      id: "someone@example.com",
      subject: { kind: "email", value: "someone@example.com" },
    };
    expect(toAccountDescriptor(declared)).toBe(declared);
  });

  test("the two forms are told apart by shape, not by guessing", () => {
    expect(isAccountDescriptor({ id: "a" })).toBe(true);
    expect(isAccountDescriptor("a")).toBe(false);
    expect(isAccountDescriptor(null)).toBe(false);
    expect(isAccountDescriptor({})).toBe(false);
  });
});

describe("what to show a person", () => {
  test("a declared label wins", () => {
    expect(accountLabel({ id: "ws_8f2a", label: "a readable workspace name" })).toBe(
      "a readable workspace name",
    );
  });

  test("a subject stands in when there is no label", () => {
    expect(
      accountLabel({ id: "ws_8f2a", subject: { kind: "email", value: "maya@example.com" } }),
    ).toBe("maya@example.com");
  });

  test("the id is the fallback, because it is what every client shows today", () => {
    // A source that declares nothing must lose nothing.
    expect(accountLabel({ id: "local" })).toBe("local");
  });
});

describe("the operator's own address, declared rather than sniffed", () => {
  test("a declared email is returned", () => {
    expect(accountEmail({ id: "x", subject: { kind: "email", value: "maya@example.com" } })).toBe(
      "maya@example.com",
    );
  });

  test("an alias supplies it when the subject is something else", () => {
    // A platform whose account id is an opaque handle can still say which
    // address belongs to it.
    expect(
      accountEmail({
        id: "U0421",
        subject: { kind: "handle", value: "maya" },
        aliases: [
          { kind: "phone", value: "+15550100123" },
          { kind: "email", value: "m@example.com" },
        ],
      }),
    ).toBe("m@example.com");
  });

  test("a handle that looks like an address is not one", () => {
    // The near miss already in the tree: a connection named after the
    // organization it is scoped to reads as `login@organization`, contains an
    // `@`, and is not an address. Declaring the kind removes the question.
    expect(
      accountEmail({ id: "octocat@acme-org", subject: { kind: "handle", value: "octocat" } }),
    ).toBeUndefined();
  });

  test("a source that says nothing yields nothing, rather than a guess", () => {
    expect(accountEmail({ id: "octocat@acme-org" })).toBeUndefined();
  });
});

describe("two connections for one person", () => {
  test("the tenant is a field, not a second separator inside the id", () => {
    const work: AccountDescriptor = {
      id: "octocat@acme-org",
      subject: { kind: "handle", value: "octocat" },
      tenant: { id: "acme-org", label: "Acme" },
    };
    const personal: AccountDescriptor = {
      id: "octocat",
      subject: { kind: "handle", value: "octocat" },
    };

    // Same person, two accounts — and the thing that distinguishes them is
    // readable without parsing anything.
    expect(work.subject).toEqual(personal.subject);
    expect(work.tenant?.label).toBe("Acme");
    expect(personal.tenant).toBeUndefined();
  });
});
