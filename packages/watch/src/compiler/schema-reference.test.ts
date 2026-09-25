// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the compiler is allowed to see, and one thing it is not.
 *
 * The schema in the prompt is generated from the DSL rather than written beside
 * it, which is what keeps the two from drifting — and which also means anything
 * added to the DSL is offered to a model the moment it lands, whether or not
 * that was the intent.
 *
 * `delivery` is the case where it is not. It says whether a firing interrupts a
 * person, which is a judgement about how much someone wants to be disturbed
 * rather than about what the watch should look for; a model shown a field with
 * that name will fill it in for any request that sounds urgent. It is turned on
 * afterwards, by whoever will be interrupted.
 */

import { describe, expect, it } from "vitest";

import { dslSchemaReference } from "./schema-reference.js";

describe("the schema the compiler writes against", () => {
  it("does not offer a way to start notifying someone", () => {
    const reference = dslSchemaReference();
    expect(reference, "the compiler can now turn delivery on").not.toContain("delivery");
    expect(reference).not.toContain("omnesis-notify");
  });

  it("still describes the watch itself", () => {
    // The deletion is surgical, and a schema that lost more than one field
    // would fail quietly — the model would simply write worse watches.
    const reference = dslSchemaReference();
    for (const field of ["nodes", "sink", "firing_policy", "name", "expires_at", "constants"]) {
      expect(reference, `the schema lost ${field}`).toContain(field);
    }
  });
});
