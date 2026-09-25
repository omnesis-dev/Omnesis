// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record a Watch V2 watch keeps here so it can wake an agent.
 *
 * Watch V2 evaluates in its own runtime, against its own journal, in its own
 * database. What it does not have is the apparatus around a wake: a device to
 * anchor capabilities on, an approval and a grant, an answer authority, a
 * privacy reviewer and an egress ledger. All of that exists here and is the
 * reason a wake is safe to send, so a V2 watch that wants to wake an agent
 * keeps a record here rather than growing a second copy of it.
 *
 * **This plan is a descriptor, not a program.** Every other compiled plan in
 * this union is executable — the trigger engine renders it to SQL or to a
 * match predicate and evaluates it. This one names a watch that is evaluated
 * somewhere else entirely, and nothing in the trigger machinery may arm it. If
 * it ever did, one watch would be evaluated by two engines and fire twice.
 * `buildManagedSubscriptionTriggerSpec` returns no spec for it, and a test
 * pins that, because the failure is silent duplication rather than an error.
 *
 * ## The one field that decides what an agent may learn
 *
 * `evidence` is a classification, not a description. A firing that carries
 * document ids is answerable with the documents themselves; a firing that does
 * not is answerable only as "the approved condition became true". Which one a
 * V2 watch is depends on what it watches — a document-plane watch matches
 * documents, an analytics or time watch matches rows and clocks — so the
 * watch declares it and this carries it.
 *
 * It is stated per-watch rather than inferred because the inference would have
 * to live in `isConditionOnlyPlan`, where a wrong answer is not an error: too
 * permissive and a condition-only firing tries to hand over documents it never
 * had, too strict and a document firing is reduced to a sentence. Both are
 * silent.
 */

import { z } from "zod";

/**
 * How much of a firing is answerable.
 *
 * `documents` — the firing matched documents, and their ids are its evidence.
 * `condition-only` — the firing is the fact that something became true, and
 * there is nothing to hand over but that fact.
 */
export const watchV2EvidenceKindSchema = z.enum(["documents", "condition-only"]);

export type WatchV2EvidenceKind = z.infer<typeof watchV2EvidenceKindSchema>;

/**
 * Who asked for this watch.
 *
 * `operator` — installed from the admin surface. The record exists only so the
 * watch has somewhere to wake through, and it is hidden from every listing an
 * integration reads: an agent must never find a record it did not author.
 * `integration` — an agent asked for the watch in prose and this is the record
 * of that request, so it appears in that agent's own listings and waits on the
 * operator's approval like any other thing an agent asked to be allowed to do.
 *
 * Defaulted rather than required, because every record written before the
 * distinction existed was an operator's.
 */
export const watchV2AuthorSchema = z.enum(["operator", "integration"]).default("operator");

export type WatchV2Author = z.infer<typeof watchV2AuthorSchema>;

/**
 * The plan discriminator, frozen at its current spelling.
 *
 * It is a **stored value**, not a name in the code: it is written into
 * `subscription_revisions.compiled_plan_json` when an anchor is minted, and
 * read back out of that JSON by two raw SQL predicates — one of which decides
 * which records an integration is allowed to see, and one of which exempts
 * operator watches from a privacy sweep. Renaming it here changes what new
 * rows say and nothing about the old ones, so those predicates would silently
 * start classifying a record's own history two different ways.
 *
 * There is no migration that makes it safe, because the two spellings would
 * have to be accepted simultaneously in raw SQL against JSON — and the
 * classification is the thing an approval hangs on. It stays as it is. See
 * `WATCH_V2_PLAN_KIND`, and the `watch2-db` storage key, which is frozen for
 * the same class of reason.
 */
export const WATCH_V2_PLAN_KIND = "watch-v2";

export const watchV2PlanSchema = z
  .object({
    version: z.literal(5),
    predicate: z
      .object({
        /** Frozen: a stored value two raw SQL predicates match on. */
        kind: z.literal(WATCH_V2_PLAN_KIND),
        /** The V2 watch this record belongs to — the anchor's provenance. */
        watchId: z.string().min(1).max(128),
        /** Its name, so an operator reading either ledger recognises it. */
        watchName: z.string().min(1).max(200),
        evidence: watchV2EvidenceKindSchema,
        authoredBy: watchV2AuthorSchema,
      })
      .strict(),
  })
  .strict();

export type WatchV2Plan = z.infer<typeof watchV2PlanSchema>;

/** Whether a compiled plan is a Watch V2 descriptor. */
export function isWatchV2Plan(plan: { predicate: { kind: string } }): plan is WatchV2Plan {
  return plan.predicate.kind === WATCH_V2_PLAN_KIND;
}

/**
 * A watch firing's full identity, as the wake path stores it.
 *
 * `<watchId>:<seq>:<nodeId>:<keyHash>` — four components, because a broadcast
 * arm re-judges every live cell at the tick's own sequence number, so several
 * distinct firings share one `watchId:seq`. The anchor is unique on this
 * string, which is what stops the first arm of a fan-out swallowing the rest.
 *
 * Minted by the engine host and read back here. One function for both, so the
 * shape is stated once: a reader that parsed it by hand would go on returning
 * plausible numbers after the shape changed.
 */
export function watchV2FiringKey(input: {
  watchId: string;
  seq: number;
  nodeId: string;
  keyHash: string;
}): string {
  return `${input.watchId}:${input.seq}:${input.nodeId}:${input.keyHash}`;
}

/**
 * The journal event a stored firing key names, or null when the key is not one
 * of these.
 *
 * `watchId` is supplied rather than taken from the key: the authority on which
 * watch a record belongs to is its compiled plan, and a key that disagrees with
 * the plan is not this watch's firing however well-formed it looks. Null is the
 * right answer for a firing written before this shape existed — a deep link
 * built from a guess would open a canvas showing somebody else's moment.
 */
export function watchV2FiringSeq(eventKey: string, watchId: string): number | null {
  const prefix = `${watchId}:`;
  if (!eventKey.startsWith(prefix)) return null;
  const rest = eventKey.slice(prefix.length);
  const [seq, nodeId, ...hash] = rest.split(":");
  // A sequence, a node, and a key hash — which itself carries the instance
  // after a colon, so the hash is whatever is left rather than one component.
  // Anything shorter is a different shape that happens to share a prefix.
  if (seq === undefined || nodeId === undefined || hash.length === 0) return null;
  if (nodeId.length === 0 || hash.join(":").length === 0) return null;
  // A sequence can be negative: the runtime's own counter numbers deadlines and
  // hand-fired firings below zero, and those are moments the canvas addresses
  // exactly like an arrival.
  if (!/^-?\d+$/.test(seq)) return null;
  return Number(seq);
}

/**
 * What the operator approved, in one sentence, for a watch that has no
 * document evidence to offer.
 *
 * This is the *entire* answerable payload of a condition-only firing: the
 * agent is told the condition and when it became true, and nothing else. So it
 * has to read as a claim a person made, because a person did — it is the
 * request the watch was written from.
 */
export function watchV2ConditionSummary(watchName: string, request: string | undefined): string {
  const asked = request?.replace(/\s+/g, " ").trim();
  return asked && asked.length > 0
    ? asked
    : `The watch "${watchName}" reached the condition it was written to watch for.`;
}
