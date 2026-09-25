// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { PERSON_IDENTIFIER_KINDS, personIdentifiers, type PersonMention } from "./document.js";

/**
 * A mention names its identifiers one of two ways, and every consumer reads
 * the result of this function rather than either spelling. What it has to get
 * right is that the two are the same assertion: a source that moves to the
 * namespaced list must not change which person its documents resolve to.
 */
describe("the identifiers a mention carries", () => {
  const mention = (over: Partial<PersonMention>): PersonMention => ({ role: "sender", ...over });

  test("the older per-kind arrays are read as identifiers of that kind", () => {
    expect(
      personIdentifiers(
        mention({ emails: ["a@example.org"], phones: ["+15550100142"], lids: ["whatsapp:1"] }),
      ),
    ).toEqual([
      { kind: "email", value: "a@example.org" },
      { kind: "phone", value: "+15550100142" },
      { kind: "lid", value: "whatsapp:1" },
    ]);
  });

  test("the namespaced list says the same thing", () => {
    expect(
      personIdentifiers(
        mention({
          identifiers: [
            { kind: "email", value: "a@example.org" },
            { kind: "phone", value: "+15550100142" },
            { kind: "lid", value: "whatsapp:1" },
          ],
        }),
      ),
    ).toEqual(
      personIdentifiers(
        mention({ emails: ["a@example.org"], phones: ["+15550100142"], lids: ["whatsapp:1"] }),
      ),
    );
  });

  test("a mention using both spellings carries both, without dropping either", () => {
    // Not refused, unlike a snapshot's two spellings: these are additive
    // rather than contradictory — a source migrating one kind at a time is a
    // real intermediate state, and losing an identifier splits a person.
    expect(
      personIdentifiers(
        mention({
          emails: ["a@example.org"],
          identifiers: [{ kind: "email", value: "b@example.org" }],
        }),
      ),
    ).toEqual([
      { kind: "email", value: "a@example.org" },
      { kind: "email", value: "b@example.org" },
    ]);
  });

  test("order is the declared kind order, whichever spelling arrived", () => {
    // Callers break ties by position — the display name falls back to the
    // first identifier — so the same mention must not order differently for
    // having been written the other way.
    const legacy = personIdentifiers(
      mention({ phones: ["+15550100142"], emails: ["a@example.org"] }),
    );
    const declared = personIdentifiers(
      mention({
        identifiers: [
          { kind: "phone", value: "+15550100142" },
          { kind: "email", value: "a@example.org" },
        ],
      }),
    );
    expect(legacy).toEqual(declared);
    expect(legacy[0]).toEqual({ kind: "email", value: "a@example.org" });
  });

  test("a mention with no identifiers carries none", () => {
    expect(personIdentifiers(mention({ name: "someone" }))).toEqual([]);
  });

  test("the kinds are the alias types the store uses, and exclude the name", () => {
    // A name is an alias type but not an identifier: two people share one, and
    // nothing may be merged on it.
    expect([...PERSON_IDENTIFIER_KINDS]).toEqual(["email", "phone", "lid"]);
    expect([...PERSON_IDENTIFIER_KINDS]).not.toContain("name");
  });
});
