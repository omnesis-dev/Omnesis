// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Watch DSL, as zod schemas.
 *
 * zod is the source of truth here and the TypeScript types are derived from it,
 * so there is exactly one place a DSL field is described.
 *
 * The split between this file and `validator/` is deliberate and worth holding
 * onto: **schema is shape, validator is meaning.** A schema failure means the
 * JSON is not a watch at all (`nodes` is a number, `on_collision` is `"maybe"`).
 * Everything that requires looking at more than one field at once — does this
 * node id exist, is `spawn` legal on this node type, does gmail declare
 * `extra.threadId`, do the arm and cancel keys agree — lives in the validator,
 * which reports machine-readable diagnostics designed as the compiler's
 * feedback API rather than as prose.
 */

import { z } from "zod";
import { PERSON_ROLES } from "@omnesis/types";

/** Node ids are snake_case identifiers so they can be spelled in `$n.<id>.…`. */
const nodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "node ids are lower_snake_case and start with a letter");

/** A duration, checked for shape here and parsed by the validator. */
const durationSchema = z.string().min(1);

/** An expression, parsed by the validator against the surrounding context. */
const expressionSchema = z.string().min(1);

const outputMapSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/, "output field names are lower_snake_case"),
  expressionSchema,
);

const firingPolicySchema = z.enum(["once_ever", "stays_active"]);

const collisionModeSchema = z.enum(["reset", "ignore", "spawn", "accumulate"]);

const edgeRoleSchema = z.enum(["arm", "cancel"]);

const fireOnSchema = z.enum(["every_true", "rising_edge"]);

const initialLevelSchema = z.enum(["assume_false", "first_observation"]);

const nodeInputSchema = z
  .object({
    role: edgeRoleSchema,
    /**
     * Per-edge key extractor. Each component is an expression evaluated against
     * *this edge's* arriving payload — `".thread_id"` reads the upstream node's
     * `thread_id` output field.
     */
    key: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), expressionSchema).optional(),
    /** Required on a keyless input (a timer) feeding a keyed node. */
    broadcast: z.boolean().optional(),
  })
  .strict();

const inputsSchema = z.record(nodeIdSchema, nodeInputSchema);

/** A DSL type expression: `"string"`, `"date"`, `"enum[a, b]"`, `"list<id>"`. */
const typeExpressionSchema = z.string().min(1);

const typedOutputSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), typeExpressionSchema);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A value the compiler resolved from the corpus once, at compile time, because
 * it will never arrive as an event — a passport expiry date, say. The
 * provenance document is mandatory: an unattributed constant is a magic number
 * the operator cannot audit and the compiler cannot re-verify.
 */
const constantSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "date", "timestamp"]),
    value: z.union([z.string(), z.number(), z.boolean()]),
    provenance_doc: z.string().min(1),
    /** How the compiler read the value out of that document. */
    provenance_note: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Source node filters
// ---------------------------------------------------------------------------

const stringOrArray = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/**
 * `deleted` is accepted by the schema and rejected by the validator. Nothing in
 * the substrate emits a document deletion today, so the spelling is reserved
 * rather than absent: a compiler that reaches for it gets a diagnostic naming
 * the reason instead of a shape error naming nothing.
 */
const documentEventOpSchema = z.enum(["created", "updated", "deleted"]);

const metadataPredicateSchema = z
  .object({
    path: z.string().min(1),
    op: z.enum(["eq", "neq", "in", "not_in", "contains", "exists"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  })
  .strict();

/**
 * A role-based person predicate. `{role, person}` names one human;
 * `{role, isSelf}` is the direction idiom. There is no direction field on a
 * document, so inbound is a `sender` mention that is not self and outbound is a
 * `sender` mention that is.
 */
const personPredicateSchema = z
  .object({
    role: z.enum(PERSON_ROLES),
    person: z.string().min(1).optional(),
    isSelf: z.boolean().optional(),
  })
  .strict();

/**
 * Nomination: the ways a document can be put in front of the judge.
 *
 * The arms are OR-composed — a document nominated by any of them is judged
 * once — and at least one is required. Nomination is never firing, whatever
 * arm did the nominating; the judge is the only thing that turns a nomination
 * into a signal, and it is mandatory wherever `recall` appears.
 *
 * Two arms today, and they are blind in opposite places. Embedding similarity
 * captures meaning and is near-useless on rare tokens — an order number scored
 * 0.066 against a 0.35 floor on a document where a topical phrase fired, which
 * is why identifier requests were refused outright. Literal terms are exact
 * where the embedding is blind, and blind to meaning where it is strong.
 */
const recallSchema = z
  .object({
    semantic: z
      .object({
        query: z.string().min(1),
        /**
         * Per-chunk max cosine floor. Required, and written into the plan
         * rather than read from a knob at evaluation time: a watch that
         * silently changed its recall floor when an operator retuned the search
         * default would stop meaning what it was compiled to mean.
         */
        threshold: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    lexical: z
      .object({
        /**
         * Literal terms, materialized by the compiler rather than scored.
         *
         * Not a BM25 threshold: BM25 is corpus-relative and its IDF shifts as
         * the corpus grows, so a frozen `bm25 > k` in a compiled plan drifts
         * silently. Literal terms are deterministic under replay, checkable
         * against the ontology, immune to corpus drift, and honest in the
         * approval interpretation — "I will also nominate any document
         * containing 'XR-4471'".
         */
        terms: z.array(z.string().min(1)).min(1),
        /**
         * What kind of term this is, which the validator holds you to.
         *
         * Not a runtime branch: after normalization a padded substring search
         * is whole-word matching for a one-word needle and adjacent-phrase
         * matching for a longer one, so one test serves both. What `match`
         * buys is a checkable claim — a term with a space declared `token` is
         * a diagnostic rather than a silent reinterpretation.
         */
        match: z.enum(["token", "phrase"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((recall) => recall.semantic !== undefined || recall.lexical !== undefined, {
    message: "recall needs at least one arm: semantic, lexical, or both",
  });

const judgeSchema = z
  .object({
    proposition: z.string().min(1),
    output_schema: typedOutputSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const nodeBase = {
  id: nodeIdSchema,
  /** Free-text note from the compiler about why this node exists. */
  comment: z.string().optional(),
  output_map: outputMapSchema.optional(),
};

const documentEventSourceSchema = z
  .object({
    ...nodeBase,
    type: z.literal("source.document_event"),
    filter: z
      .object({
        source: stringOrArray,
        event: z.array(documentEventOpSchema).min(1),
        documentType: stringOrArray.optional(),
        metadata: z.array(metadataPredicateSchema).optional(),
        people: z.array(personPredicateSchema).optional(),
      })
      .strict(),
    recall: recallSchema.optional(),
    judge: judgeSchema.optional(),
  })
  .strict()
  .refine((node) => node.recall === undefined || node.judge !== undefined, {
    message: "a source with a recall block needs a judge: nomination is never firing",
    path: ["judge"],
  })
  .refine((node) => node.judge === undefined || node.recall !== undefined, {
    message: "a judge with nothing to judge: add a recall block or drop the judge",
    path: ["recall"],
  });

const analyticsRowSourceSchema = z
  .object({
    ...nodeBase,
    type: z.literal("source.analytics_row"),
    table: z.string().min(1),
    /**
     * Which arrivals to listen to — and `inserted` does not mean what it looks
     * like it means.
     *
     * It means **the first time this journal has seen this row's primary key**,
     * not "the row was created upstream just now". The journal learns keys as
     * they arrive, so a record that has existed in the source for years is
     * `inserted` the first time anything touches it after the journal started:
     * a calendar event created months ago and edited today arrives as
     * `inserted`, because its key had never been journaled before.
     *
     * So `op: ["inserted"]` is "something I had not seen before", which is the
     * right predicate for a watch on genuinely new things and the wrong one for
     * a watch that must fire only on upstream creation. For the latter, filter
     * on a creation timestamp the row itself carries. Backfill is a separate
     * axis — see `backfill` below — and does not rescue this distinction,
     * because an edit to an old row is live traffic, not a replay.
     */
    op: z.array(z.enum(["inserted", "updated"])).min(1),
    /** A boolean SQL expression over the arriving row's columns. */
    predicate: z.string().min(1).optional(),
    /**
     * What to do with rows a source replayed rather than reported — its first
     * sync, or an imported archive.
     *
     * `ignore` by default, because the overwhelmingly common reading of "tell
     * me when I spend more than five hundred" is about the next such payment
     * and not about every one since the account opened. Connecting a source
     * would otherwise wake a watch once per historical row, which is the
     * failure this default exists to make impossible rather than unlikely.
     *
     * `include` is for the trip-wire that feeds an aggregate: a running
     * monthly total is wrong without the history, so a watch that sums wants
     * every row and a watch that reacts wants none.
     */
    backfill: z.enum(["ignore", "include"]).default("ignore"),
  })
  .strict();

const openLoopSourceSchema = z
  .object({
    ...nodeBase,
    type: z.literal("source.open_loop"),
    op: z.array(z.enum(["created", "updated", "resolved"])).min(1),
    /** Compiler-resolved loop ids. Omitted means "any loop". */
    loop_ids: z.array(z.string().min(1)).min(1).optional(),
    filter: z
      .object({
        state: z
          .array(z.enum(["open", "snoozed", "done", "dismissed"]))
          .min(1)
          .optional(),
        actors: z.array(z.string().min(1)).min(1).optional(),
        involved: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const timeSourceSchema = z
  .object({
    ...nodeBase,
    type: z.literal("source.time"),
    /** An ISO-8601 instant. Exactly one of `one_off` / `recurring`. */
    one_off: z.string().min(1).optional(),
    /**
     * Five-field cron. There is no cron daemon behind it: a recurring time
     * source compiles to a persisted due-gate — a next-due instant that a
     * coarse tick interrogates — so a boundary missed during downtime fires
     * once on the way back up rather than N times.
     */
    recurring: z.string().min(1).optional(),
  })
  .strict();

const orNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateless.or"),
    inputs: inputsSchema,
  })
  .strict();

const transformNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateless.transform"),
    inputs: inputsSchema,
    /** A FROM-less DuckDB expression projecting a `fires` column. */
    query: z.string().min(1),
  })
  .strict();

const waitNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.wait"),
    inputs: inputsSchema,
    /** The wait itself is the deadline — its expiry is the fire. */
    duration: durationSchema,
    on_collision: collisionModeSchema,
    max_live_instances: z.number().int().positive().optional(),
  })
  .strict();

const deadlineSchema = z.union([durationSchema, z.literal("infinite")]);

const andNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.and"),
    inputs: inputsSchema,
    deadline: deadlineSchema,
    on_collision: collisionModeSchema,
  })
  .strict();

const thresholdNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.threshold"),
    inputs: inputsSchema,
    n: z.number().int().positive(),
    deadline: deadlineSchema,
    on_collision: collisionModeSchema,
  })
  .strict();

const sequenceNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.sequence"),
    inputs: inputsSchema,
    /** The arm inputs in the order they must arrive. */
    order: z.array(nodeIdSchema).min(2),
    deadline: deadlineSchema,
    on_collision: collisionModeSchema,
  })
  .strict();

const cooldownNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.cooldown"),
    inputs: inputsSchema,
    min_interval: durationSchema,
    /** Only `accumulate` is meaningful — the cell must outlive firings. */
    on_collision: z.literal("accumulate").optional(),
  })
  .strict();

const persistenceNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("stateful.persistence"),
    inputs: inputsSchema,
    /** The window the input must keep firing within. */
    duration: durationSchema,
    /** How many arms inside that window constitute "kept firing". */
    min_events: z.number().int().min(2),
    on_collision: z.literal("accumulate").optional(),
  })
  .strict();

const sqlNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("sql"),
    inputs: inputsSchema,
    /** DuckDB over the analytics catalog. Must project a `fires` column. */
    query: z.string().min(1),
    fire_on: fireOnSchema.optional(),
    initial_level: initialLevelSchema.optional(),
    /** Re-run the query on this interval until fire, cancel or deadline. */
    timer: durationSchema.optional(),
    /** The predicate must hold this long before the node fires. */
    persistence: durationSchema.optional(),
    deadline: deadlineSchema.optional(),
    on_collision: collisionModeSchema.optional(),
    max_live_instances: z.number().int().positive().optional(),
  })
  .strict();

const llmNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal("llm"),
    inputs: inputsSchema,
    /** `judge` sees typed upstream evidence only; `investigation` gets tools. */
    mode: z.enum(["judge", "investigation"]),
    proposition: z.string().min(1),
    output_schema: typedOutputSchema,
    /** A predicate over this node's own output. Defaults to `decision`. */
    fire_when: z.string().min(1).optional(),
    /** Investigation mode: how far back the deliberation may look. */
    scope: z.object({ horizon: durationSchema }).strict().optional(),
    tools: z.array(z.string().min(1)).optional(),
    budget: z
      .object({ tool_calls: z.number().int().positive(), tokens: z.number().int().positive() })
      .strict()
      .optional(),
    deadline: deadlineSchema.optional(),
    on_collision: collisionModeSchema.optional(),
    max_live_instances: z.number().int().positive().optional(),
  })
  .strict();

export const nodeSchema = z.discriminatedUnion("type", [
  documentEventSourceSchema,
  analyticsRowSourceSchema,
  openLoopSourceSchema,
  timeSourceSchema,
  orNodeSchema,
  transformNodeSchema,
  waitNodeSchema,
  andNodeSchema,
  thresholdNodeSchema,
  sequenceNodeSchema,
  cooldownNodeSchema,
  persistenceNodeSchema,
  sqlNodeSchema,
  llmNodeSchema,
]);

const sinkSchema = z
  .object({
    input: nodeIdSchema,
    output_map: outputMapSchema.optional(),
  })
  .strict();

/**
 * A delivery kind's spelling before `omnesis-notify`.
 *
 * Still accepted, because watches are stored as the DSL document they were
 * accepted as, verbatim, and an install has a directory of them on disk. A
 * rename that made those stop parsing would not degrade anything — it would
 * take the watch out of the runtime entirely, and silently, because a
 * definition this build cannot read is skipped rather than raised.
 *
 * Goes at the major bump, alongside the two other old spellings kept for the
 * same reason: the `gateway.watchV2` config key and the `/admin/watch-v2/*`
 * route prefix.
 */
const LEGACY_NOTIFY_KIND = "ios-push";

/**
 * What a notify delivery is called now — and what it is called on the way out,
 * whichever spelling it arrived in.
 */
export const CURRENT_NOTIFY_KIND = "omnesis-notify";

/**
 * One decode point for the old spelling.
 *
 * Placed on the field rather than inside the union so `deliverySchema` stays
 * a plain discriminated union: `WatchDelivery` is then the *current* shape
 * only, and every reader that parses gets the new kind without knowing an old
 * one exists. The rewrite is a copy, so a caller keeps holding what it passed.
 *
 * This reaches parsing readers. A consumer that reads the stored JSON by hand
 * — the report projection, the portal's delivery badge — has to accept the old
 * spelling itself, and each one says so where it does it.
 */
function withCurrentDeliveryKind(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const block = value as { kind?: unknown };
  if (block.kind !== LEGACY_NOTIFY_KIND) return value;
  return { ...block, kind: CURRENT_NOTIFY_KIND };
}

/** True for either spelling of the notify kind, on a raw stored document. */
export function isNotifyDeliveryKind(kind: unknown): boolean {
  return kind === CURRENT_NOTIFY_KIND || kind === LEGACY_NOTIFY_KIND;
}

/**
 * How many referents one wake may carry.
 *
 * A ceiling rather than a budget: the bindings ride in the same envelope as the
 * instruction, and a caller with dozens of them is describing a corpus rather
 * than naming the few things one instruction points at.
 */
const MAX_WAKE_BINDINGS = 32;

/**
 * Where a firing goes, when it goes anywhere.
 *
 * Absent means a firing is a row and a trace and nothing else — which is the
 * default and stays the default. Delivery interrupts a person, so it is opted
 * into per watch rather than configured once for all of them: a watch that is
 * worth a row is not automatically worth a banner, and the two decisions are
 * not made at the same time or by the same reasoning.
 *
 * A discriminated `kind` rather than a bare literal, because the next kind is
 * a matter of when rather than whether, and the discriminant is what lets one
 * be added without every reader having to change shape.
 */
const deliverySchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        /**
         * The agent opens a conversation and tells you something, with a
         * notification pointing at that message.
         *
         * Not named for a platform. What happens is the same wherever the
         * notification lands, and a kind called after one phone would have to
         * be renamed the day it reaches another — in every stored watch on
         * disk, which is the one place a rename is expensive.
         */
        kind: z.literal("omnesis-notify"),
        /**
         * What the banner says, when the asker chose words for it.
         *
         * Absent, the runtime composes it from the request, which is the right
         * default: a watch says what was asked for. Present, it is what
         * somebody wrote on purpose, and dropping it would quietly answer a
         * different question than the one they asked.
         */
        title: z.string().min(1).max(200).optional(),
        body: z.string().min(1).max(500).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("agent-wake"),
        /**
         * Which agent is woken. A harness name, resolved to the device holding
         * that integration when the watch is installed — naming a device id
         * would make a watch stop working the day the harness re-paired.
         */
        integration: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z][a-z0-9-]*$/, "an integration is named in lowercase kebab-case"),
        /**
         * What the agent should do about it, in the operator's own words.
         *
         * The division of labour this whole kind exists for: the watch decides
         * *when* — deterministically, explainably, in a trace — and this says
         * *what to do about it*. Tasks for an agent are prose, and prose is
         * what this is; nothing parses it.
         *
         * Bounded well under the 16 KiB the delivery envelope permits, because
         * the instruction is forwarded verbatim into the agent's prompt and an
         * instruction that fills a context window is not an instruction.
         */
        instruction: z.string().min(1).max(8_000),
        /**
         * The referents the instruction names, as whoever wrote it supplied
         * them.
         *
         * Opaque, and deliberately: a key means whatever the instruction says
         * it means, and nothing between here and the woken agent reads either
         * half. "Reply in the conversation this came from" names a thing the
         * author knew and the agent does not, and a binding is how the thing
         * itself travels rather than the word for it.
         *
         * Bounded on all three axes because the pair is forwarded verbatim into
         * the delivery envelope alongside the instruction, and a map that fills
         * one is not a set of referents.
         */
        bindings: z
          .record(z.string().min(1).max(64), z.string().min(1).max(512))
          .refine((value) => Object.keys(value).length <= MAX_WAKE_BINDINGS, {
            message: `a wake carries at most ${MAX_WAKE_BINDINGS} bindings`,
          })
          .optional(),
      })
      .strict(),
  ])
  .describe("where a firing is delivered; absent means nowhere");

export const watchDslSchema = z
  .object({
    watch: z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "watch names are lowercase kebab-case"),
        /**
         * The request this watch was compiled from, in the words it was asked
         * in. A compiled plan is unreadable prose to the person who asked for
         * it, and recompiling from the stored request is how a watch survives
         * a change to the DSL or the ontology — so the prose is part of the
         * watch, not a note beside it.
         */
        nl_query: z.string().min(1).optional(),
        firing_policy: firingPolicySchema,
        /**
         * When this watch stops being worth asking, as an ISO instant.
         *
         * A watch bound to a dated thing — a dinner, a flight, a deadline — has
         * a natural horizon, and past it the question has ended rather than
         * been answered. Distinct from `once_ever`, which ends a watch because
         * it got what it was waiting for.
         */
        expires_at: z.iso.datetime().optional(),
        /**
         * The ontology fingerprint this watch was compiled against. The runtime
         * pauses on drift instead of misfiring against a moved contract.
         */
        ontology_fingerprint: z.string().min(1).optional(),
        constants: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), constantSchema).optional(),
        nodes: z.array(nodeSchema).min(1),
        sink: sinkSchema,
        /** Absent = shadow: the firing is recorded and nothing is sent. */
        delivery: z.preprocess(withCurrentDeliveryKind, deliverySchema).optional(),
      })
      .strict(),
  })
  .strict();

export type WatchDsl = z.infer<typeof watchDslSchema>;
export type WatchDefinition = WatchDsl["watch"];
export type WatchNode = z.infer<typeof nodeSchema>;
export type WatchNodeType = WatchNode["type"];
export type CollisionMode = z.infer<typeof collisionModeSchema>;
export type WatchSink = WatchDefinition["sink"];
export type WatchDelivery = NonNullable<WatchDefinition["delivery"]>;
export type WatchConstant = NonNullable<WatchDefinition["constants"]>[string];

/**
 * Per-node types are projections of the node union rather than separate
 * inferences, so the union stays the single place a node type is declared.
 */
type NodeOfType<T extends WatchNodeType> = Extract<WatchNode, { type: T }>;

type OrNode = NodeOfType<"stateless.or">;
export type SqlNode = NodeOfType<"sql">;
export type LlmNode = NodeOfType<"llm">;

export type NodeInput = OrNode["inputs"][string];

/** Node types that are trip-wires: no inputs, instantiated by the journal. */
export const SOURCE_NODE_TYPES = [
  "source.document_event",
  "source.analytics_row",
  "source.open_loop",
  "source.time",
] as const satisfies readonly WatchNodeType[];

export function isSourceNode(node: WatchNode): boolean {
  return (SOURCE_NODE_TYPES as readonly string[]).includes(node.type);
}

/** Every node except the source nodes carries an `inputs` map. */
export function nodeInputs(node: WatchNode): Record<string, NodeInput> {
  return "inputs" in node ? node.inputs : {};
}
