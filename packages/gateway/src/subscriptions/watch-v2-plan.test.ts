// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two properties a Watch V2 descriptor rests on.
 *
 * The descriptor is a record kept so a V2 watch can wake an agent through the
 * apparatus that already makes a wake safe. It is the only member of the
 * compiled-plan union that is not executable, and both of the things that
 * follow from that fail *silently* if they are wrong — which is why they are
 * pinned here rather than left to inspection.
 *
 * **Nothing may arm it.** A trigger built for a descriptor would evaluate a
 * watch the V2 runtime is already evaluating. Neither engine would be wrong on
 * its own terms; the watch would simply fire twice, and the only symptom would
 * be an operator hearing about one thing two times.
 *
 * **Its evidence classification must be deliberate.** The default for an
 * unclassified plan is "documents, and a firing must carry at least one" —
 * which is enforced at fire, at validate, and at project. A kind nobody
 * classified therefore fails closed in three places rather than quietly
 * handing an agent evidence it never had.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  conditionEvidenceKind,
  planEvidenceRule,
  storedSubscriptionCompiledPlanCodec,
} from "./store-codecs.js";
import {
  isWatchV2Plan,
  watchV2FiringKey,
  watchV2FiringSeq,
  watchV2PlanSchema,
  WATCH_V2_PLAN_KIND,
} from "./watch-v2-plan.js";
import type { SubscriptionCompiledPlan } from "./store-codecs.js";

/** A descriptor for a V2 watch, evidence classification supplied by the caller. */
function descriptor(evidence: "documents" | "condition-only"): SubscriptionCompiledPlan {
  return watchV2PlanSchema.parse({
    version: 5,
    predicate: {
      kind: "watch-v2",
      watchId: "w-1",
      watchName: "an-order-shipped",
      evidence,
    },
  });
}

/** A plan written by the retired evaluator, as the contrast. */
const LEGACY_PLAN: SubscriptionCompiledPlan = {
  version: 1,
  predicate: { kind: "title-equals", value: "Quote" },
};

const ANALYTICS_PLAN = {
  version: 3,
  predicate: {
    kind: "analytics-event",
    table: "health_body",
    where: { kind: "always" },
    catalogFingerprint: "f",
  },
} as unknown as SubscriptionCompiledPlan;

describe("the evidence classification", () => {
  it("follows what the watch declared, in both directions", () => {
    expect(planEvidenceRule(descriptor("condition-only"))).toBe("none");
    expect(planEvidenceRule(descriptor("documents"))).toBe("optional");
  });

  it("lets a document watch fire with nothing behind it", () => {
    // The reason the rule is `optional` rather than `required`. A watch that is
    // true either when a message arrives or when a deadline passes has
    // documents behind the first and nothing behind the second, and demanding
    // evidence would lose the second firing at the moment it mattered.
    expect(planEvidenceRule(descriptor("documents"))).not.toBe("required");
  });

  it("gives a plan from the retired evaluator the narrowest rule", () => {
    // Such a plan cannot fire — nothing evaluates it, and the service refuses
    // to activate its record — so this is only ever reached by a caller
    // writing directly to the store. `none` is the answer that discloses
    // least: a firing carrying documents nobody classified is refused.
    expect(planEvidenceRule(LEGACY_PLAN)).toBe("none");
    expect(planEvidenceRule(ANALYTICS_PLAN)).toBe("none");
  });

  it("names the shape a firing with no documents falls back to", () => {
    // Every plan has one. A row recorded by the retired evaluator answers as
    // the catalog watch it was, rather than being read as a document firing
    // with an empty list — which is corruption, and would throw on a record
    // the operator can still see listed.
    expect(conditionEvidenceKind(descriptor("documents"))).toBe("watch-v2");
    expect(conditionEvidenceKind(descriptor("condition-only"))).toBe("watch-v2");
    expect(conditionEvidenceKind(ANALYTICS_PLAN)).toBe("catalog-watch");
    expect(conditionEvidenceKind(LEGACY_PLAN)).toBe("catalog-watch");
  });

  it("fails closed on a classification nobody made", () => {
    // The property the whole design leans on: a kind that reaches this
    // function without being one the watch engine wrote carries no evidence
    // at all, and a firing that tried to attach some is refused at fire time.
    const unclassified = {
      version: 9,
      predicate: { kind: "some-later-thing" },
    } as unknown as SubscriptionCompiledPlan;
    expect(planEvidenceRule(unclassified)).toBe("none");
  });
});

describe("the descriptor as stored data", () => {
  it("round-trips through the stored-plan union", () => {
    // It has to be readable by the same codec every other plan is read by, or
    // a subscription carrying one cannot be loaded at all.
    const parsed = storedSubscriptionCompiledPlanCodec.parse(descriptor("documents"));
    expect(isWatchV2Plan(parsed)).toBe(true);
  });

  it("refuses a descriptor with no watch behind it", () => {
    // The identity is the whole point: it is what lets a reader get from an
    // entry in the egress ledger back to the watch that caused it.
    expect(() =>
      watchV2PlanSchema.parse({
        version: 5,
        predicate: { kind: "watch-v2", watchId: "", watchName: "x", evidence: "documents" },
      }),
    ).toThrow();
  });

  it("refuses an evidence kind outside the two that exist", () => {
    expect(() =>
      watchV2PlanSchema.parse({
        version: 5,
        predicate: { kind: "watch-v2", watchId: "w", watchName: "x", evidence: "maybe" },
      }),
    ).toThrow();
  });
});

describe("the plan discriminator is frozen", () => {
  it("is still `watch-v2`, whatever the runtime is called now", () => {
    // Deliberately not renamed alongside everything else, and this test exists
    // so that finishing the rename reddens something that says why.
    //
    // It is a stored value: written into
    // `subscription_revisions.compiled_plan_json` when an anchor is minted,
    // and matched by two RAW SQL predicates over that JSON — one deciding
    // which records an integration may see, one exempting operator watches
    // from a privacy sweep. Renaming it changes what new rows say and nothing
    // about the old ones, so both predicates would start classifying a
    // record's own history two different ways, silently, with an approval
    // hanging on the answer.
    expect(WATCH_V2_PLAN_KIND).toBe("watch-v2");
    expect(descriptor("documents").predicate.kind).toBe("watch-v2");
  });

  /**
   * The firing key is minted by the engine host and read back by the firings
   * projection, so a wake can reach the canvas that explains it. Both halves
   * live in one function precisely so a reader that parsed it by hand cannot go
   * on returning plausible numbers after the shape changes.
   */
  it("reads back the journal event a firing key names", () => {
    const key = watchV2FiringKey({
      watchId: "w_shipped",
      seq: 4210,
      nodeId: "supplier_mail",
      keyHash: "abc123:0",
    });

    expect(watchV2FiringSeq(key, "w_shipped")).toBe(4210);
  });

  it("reads back a deadline, whose sequence the runtime numbers below zero", () => {
    // A deadline coming due and a firing forced by hand both take a sequence
    // from the runtime's own counter rather than the journal. Both are moments
    // the canvas addresses; a reader that accepted only digits would refuse
    // exactly the events an operator most often asks about.
    const key = watchV2FiringKey({
      watchId: "w_shipped",
      seq: -2,
      nodeId: "unpaid_a_week",
      keyHash: "abc123:0",
    });

    expect(watchV2FiringSeq(key, "w_shipped")).toBe(-2);
  });

  // A link built on a guess opens the canvas on somebody else's moment, which
  // is worse than no link at all.
  it.each([
    ["a key belonging to a different watch", "w_other:4210:node:hash", "w_shipped"],
    ["a key with too few components", "w_shipped:4210:node", "w_shipped"],

    ["a sequence that is not a number", "w_shipped:later:node:hash", "w_shipped"],
    ["a shape from before the runtime stamped one", "sf_0193abcd", "w_shipped"],
    // A watch id that is a prefix of the real one must not match: the colon is
    // what separates the id from the sequence, and without it `w_ship` would
    // read `ped:4210:node:hash` as the rest of the key.
    ["a watch id that is only a prefix", "w_shipped:4210:node:hash", "w_ship"],
  ])("declines to name an event from %s", (_label, key, watchId) => {
    expect(watchV2FiringSeq(key, watchId)).toBeNull();
  });

  it("is the same string the SQL predicates match on", () => {
    // The two readers are raw SQL, so nothing but this connects them to the
    // constant. If one is edited without the other, an anchor stops being
    // recognised as one and appears on a listing it must never appear on.
    const readers = [
      new URL("./store-queries.ts", import.meta.url),
      // A third reader, and the reason this counts across files rather than
      // one: the watch's disclosure is resolved by its own SQL over the same
      // stored kind, and a rename that missed it would leave every wake watch
      // looking like it discloses to nobody.
      new URL("../watch/disclosure.ts", import.meta.url),
    ];
    const matches = readers.flatMap(
      (reader) => readFileSync(reader, "utf8").match(/'watch-v2'/g) ?? [],
    );
    expect(matches, "a SQL predicate no longer matches the stored kind").toHaveLength(3);
  });
});
