// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one decode point for a delivery block's spelling.
 *
 * A watch is stored as the document it was accepted as, verbatim, and an
 * install has a directory of them on disk. So a delivery kind cannot simply be
 * renamed: a definition this build cannot parse is not refused loudly, it is
 * *skipped* — the watch leaves the runtime and nothing says so.
 *
 * The compat therefore lives here, in the package that owns the DSL, and every
 * consumer that parses inherits it. This file is what stops it being deleted
 * by someone tidying up: without a test, removing the preprocess keeps the
 * whole package green and takes every stored watch off the air.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { CURRENT_NOTIFY_KIND, isNotifyDeliveryKind, watchDslSchema } from "./schema.js";

/** The smallest watch the schema accepts, with whatever delivery is under test. */
function watchWith(delivery: unknown): unknown {
  return {
    watch: {
      name: "a-parcel-shipped",
      firing_policy: "stays_active",
      nodes: [
        {
          id: "shipped",
          type: "source.document_event",
          filter: { source: "mailbox:someone@example.com", event: ["created"] },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "shipped", output_map: { evidence: "$n.shipped.doc_id" } },
      ...(delivery === undefined ? {} : { delivery }),
    },
  };
}

describe("a delivery block's spelling on the way in", () => {
  it("takes a watch stored under the old spelling and reads it as the current one", () => {
    // The property everything else rests on. Without it a stored watch stops
    // parsing, and a watch that does not parse is skipped rather than
    // refused — so an operator's watch would simply stop, silently.
    const parsed = watchDslSchema.parse(watchWith({ kind: "ios-push", title: "A parcel" }));

    expect(parsed.watch.delivery).toEqual({ kind: CURRENT_NOTIFY_KIND, title: "A parcel" });
  });

  it("keeps everything else the block carried", () => {
    const parsed = watchDslSchema.parse(
      watchWith({ kind: "ios-push", title: "A parcel", body: "It shipped." }),
    );

    expect(parsed.watch.delivery).toMatchObject({ title: "A parcel", body: "It shipped." });
  });

  it("leaves the current spelling alone", () => {
    const parsed = watchDslSchema.parse(watchWith({ kind: CURRENT_NOTIFY_KIND }));

    expect(parsed.watch.delivery).toEqual({ kind: CURRENT_NOTIFY_KIND });
  });

  it("does not touch the other kind", () => {
    const parsed = watchDslSchema.parse(
      watchWith({ kind: "agent-wake", integration: "openclaw", instruction: "Draft a reply." }),
    );

    expect(parsed.watch.delivery?.kind).toBe("agent-wake");
  });

  it("does not rewrite the caller's own object", () => {
    // A watch document is passed around by several callers at once — validated,
    // stored, rendered. A normaliser that edited it in place would change what
    // one of them is holding partway through.
    const delivery = { kind: "ios-push" as const };
    watchDslSchema.parse(watchWith(delivery));

    expect(delivery.kind).toBe("ios-push");
  });

  it("still refuses a kind that is neither", () => {
    // The compat widens one value, not the field. An unknown kind is a watch
    // this build cannot run, and saying so is the whole point of the union.
    expect(() => watchDslSchema.parse(watchWith({ kind: "email" }))).toThrow();
    expect(() => watchDslSchema.parse(watchWith({ kind: 7 }))).toThrow();
    expect(() => watchDslSchema.parse(watchWith("ios-push"))).toThrow();
  });

  it("still accepts a watch that delivers nowhere, which is most of them", () => {
    expect(watchDslSchema.parse(watchWith(undefined)).watch.delivery).toBeUndefined();
  });
});

describe("the referents a wake carries", () => {
  /** A wake block with whatever bindings are under test. */
  function wakeWith(bindings: unknown): unknown {
    return watchWith({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "Reply in the conversation this came from.",
      ...(bindings === undefined ? {} : { bindings }),
    });
  }

  it("carries them through untouched", () => {
    // Opaque by contract: a key means whatever the instruction says it means,
    // and a schema that normalised either half would be reading them.
    const parsed = watchDslSchema.parse(
      wakeWith({ conversation: "thread-8821", reply_to: "maya.reeves@example.com" }),
    );

    expect(parsed.watch.delivery).toMatchObject({
      bindings: { conversation: "thread-8821", reply_to: "maya.reeves@example.com" },
    });
  });

  it("accepts a wake that names none, which is most of them", () => {
    const parsed = watchDslSchema.parse(wakeWith(undefined));

    expect(parsed.watch.delivery).not.toHaveProperty("bindings");
  });

  it("refuses a value that is not a string", () => {
    // The pair is forwarded verbatim into the delivery envelope. A nested
    // object would arrive at the agent as something it has to guess at.
    expect(() => watchDslSchema.parse(wakeWith({ conversation: { id: 7 } }))).toThrow();
    expect(() => watchDslSchema.parse(wakeWith({ conversation: 7 }))).toThrow();
  });

  it("refuses an empty name or an empty referent", () => {
    expect(() => watchDslSchema.parse(wakeWith({ "": "thread-8821" }))).toThrow();
    expect(() => watchDslSchema.parse(wakeWith({ conversation: "" }))).toThrow();
  });

  it("refuses a name or a referent past its bound", () => {
    expect(() => watchDslSchema.parse(wakeWith({ ["k".repeat(65)]: "x" }))).toThrow();
    expect(() => watchDslSchema.parse(wakeWith({ conversation: "x".repeat(513) }))).toThrow();
  });

  it("refuses more than the ceiling", () => {
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`k${index}`, `referent-${index}`]),
    );

    expect(() => watchDslSchema.parse(wakeWith(many))).toThrow();
    expect(() =>
      watchDslSchema.parse(wakeWith(Object.fromEntries(Object.entries(many).slice(0, 32)))),
    ).not.toThrow();
  });

  it("leaves the notify kind unable to carry them", () => {
    // Only an instruction has referents. A notify block that accepted them
    // would be a field nothing reads, on the one kind that never wakes anyone.
    expect(() =>
      watchDslSchema.parse(
        watchWith({ kind: CURRENT_NOTIFY_KIND, bindings: { conversation: "thread-8821" } }),
      ),
    ).toThrow();
  });
});

describe("recognising the notify kind on a document nothing has parsed", () => {
  it("answers for both spellings", () => {
    // For the readers that take the stored JSON apart by hand — the report
    // projection and the portal's delivery badge — which never see the
    // schema's normalisation.
    expect(isNotifyDeliveryKind("ios-push")).toBe(true);
    expect(isNotifyDeliveryKind(CURRENT_NOTIFY_KIND)).toBe(true);
  });

  it("answers for nothing else", () => {
    for (const other of ["agent-wake", "", "notify", undefined, null, 7, {}]) {
      expect(isNotifyDeliveryKind(other), `${JSON.stringify(other)} read as notify`).toBe(false);
    }
  });
});
