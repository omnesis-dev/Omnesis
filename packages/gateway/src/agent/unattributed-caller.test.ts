// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The nobody sentinel, and the cross-package invariant that makes it safe.
 *
 * A boundary that cannot say who is asking answers `UNATTRIBUTED_CALLER` — an
 * integration whose slug is the empty string. That is only the narrowest
 * audience because no watch can ever declare the empty string as the
 * integration it wakes: the watch DSL types `delivery.integration` as a
 * non-empty lowercase kebab name. Loosen that regex to accept `""` and this
 * sentinel silently becomes a wildcard that matches every wake watch on the
 * install.
 *
 * The two halves live in different packages — `@omnesis/agent` holds the
 * sentinel, `@omnesis/watch` holds the schema — so neither package's own suite
 * can see the dependency. This file is where they meet.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { UNATTRIBUTED_CALLER } from "@omnesis/agent";
import { watchDslSchema } from "@omnesis/watch";

function wakeWatch(integration: unknown): unknown {
  return {
    watch: {
      name: "a-parcel-shipped",
      nl_query: "tell me when a parcel ships",
      firing_policy: "stays_active",
      ontology_fingerprint: "an-install-fingerprint",
      nodes: [
        {
          id: "shipped",
          type: "source.document_event",
          filter: { source: "mailbox:someone@example.com", event: ["created"] },
          output_map: { doc_id: "$e.docId" },
          recall: { lexical: { terms: ["shipped"], match: "token" } },
          judge: { proposition: "the message says a parcel has shipped", output_schema: {} },
        },
      ],
      sink: { input: "shipped", output_map: { evidence: "$n.shipped.doc_id" } },
      delivery: { kind: "agent-wake", integration, instruction: "say a parcel shipped" },
    },
  };
}

describe("the caller a boundary falls back to", () => {
  it("is an integration, not the operator", () => {
    expect(UNATTRIBUTED_CALLER.kind).toBe("integration");
  });

  it("is named with the empty string", () => {
    expect(UNATTRIBUTED_CALLER).toEqual({ kind: "integration", slug: "" });
  });

  // Frozen because it is compared by value across three packages; a caller that
  // mutated it in place would rename nobody into somebody everywhere at once.
  it("cannot be renamed by whoever holds it", () => {
    expect(Object.isFrozen(UNATTRIBUTED_CALLER)).toBe(true);
  });
});

describe("the watch DSL, which is why that slug matches nothing", () => {
  it("accepts a real integration name", () => {
    expect(watchDslSchema.safeParse(wakeWatch("openclaw")).success).toBe(true);
  });

  it("rejects the empty integration name the sentinel carries", () => {
    expect(watchDslSchema.safeParse(wakeWatch(UNATTRIBUTED_CALLER.slug)).success).toBe(false);
  });

  it.each([
    ["whitespace", " "],
    ["leading digit", "1password"],
    ["uppercase", "OpenClaw"],
    ["a name with a separator the slug could be built from", "open claw"],
  ])("rejects %s, so no near-miss becomes the empty slug either", (_label, name) => {
    expect(watchDslSchema.safeParse(wakeWatch(name)).success).toBe(false);
  });
});
