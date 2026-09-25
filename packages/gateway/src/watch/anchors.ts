// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The join between a Watch V2 watch and the subscription record it wakes
 * through.
 *
 * A watch that declares `agent-wake` keeps one **anchor** among the
 * subscriptions: the record that owns the approval, the grant, the answer
 * authority and the place a firing is reported. This module is the only thing
 * that knows both halves — the V2 side calls it with a watch, the subscription
 * side is asked for a record, and neither has to learn the other's vocabulary.
 *
 * ## The two rules an anchor lives by
 *
 * **It is never orphaned.** Its lifetime is the delivery block's, changed in
 * the same request that changes the block. An anchor whose watch stopped waking
 * agents — or stopped existing — is a record nobody authored and nobody can
 * explain, and the only way to be certain one never exists is to retire it at
 * the moment the reason for it goes away rather than to sweep for it later.
 *
 * **It is never mistaken for a subscription someone made.** It is filtered out
 * of every surface that lists what an integration created, because an operator
 * reading any screen must never find a record they did not author. What they
 * *did* author is the watch, and the watch is where it is shown.
 *
 * Provenance runs both directions: the anchor's plan names the watch, and the
 * watch's trace records the anchor's firing id. Either ledger gets you to the
 * other in one step, which is what "why did this egress entry happen" needs.
 */

import { createHash } from "node:crypto";
import { createLogger, type Logger } from "@omnesis/core";
import { watchDslSchema } from "@omnesis/watch";
import {
  isWatchV2Plan,
  type WatchV2Author,
  type WatchV2EvidenceKind,
} from "../subscriptions/watch-v2-plan.js";
import {
  subscriptionOwnerId,
  subscriptionStatusForRequest,
} from "../subscriptions/store-queries.js";
import {
  ANCHOR_ORDER,
  isSpentAnchorStatus,
  isStandingAnchorStatus,
  STANDING_ANCHOR_SQL,
} from "./anchor-order.js";
import { wakeEvidenceKind } from "./wake-evidence.js";
import { ANCHOR_DEVICE_GONE_NOTE, ANCHOR_UNMINTED_NOTE } from "./health.js";
import type { StoredWatch } from "./definitions.js";
import type { SubscriptionService } from "../subscriptions/service.js";
import type { WatchWakeAnchorPort } from "./wake.js";
import type { Db } from "../data/types.js";

const log: Logger = createLogger("gateway").child("watch-v2:anchors");

/**
 * The reason this module stamps on a revocation it performs itself.
 *
 * A watch whose delivery block changes retires its anchor and mints a new one,
 * because an approved instruction cannot be edited in place. Those are two
 * writes to two stores, and a crash between them leaves a live watch with a
 * revoked record and nothing standing.
 *
 * Repairing that is only safe if the machine's revocation can be told from a
 * person's. An operator saying no, or an integration withdrawing its own
 * record, is a decision with nobody left to ask — minting a replacement would
 * overturn it. A revocation stamped with this is the first half of a change
 * this host was in the middle of making, and finishing it is what the operator
 * already asked for.
 */
export const MACHINE_ANCHOR_RETIREMENT = "watch-anchor-superseded";

/**
 * The referents a wake carries, opaque to everything that transports them.
 *
 * A key means whatever the instruction says it means. Nothing between the
 * delivery block and the woken agent reads either half, so nothing here has an
 * opinion about what a "thread" or a "conversation" is.
 */
export type WakeBindings = Record<string, string>;

/**
 * The bindings of a wake in one comparable string.
 *
 * Sorted by key, because a map is unordered and two writes of the same
 * referents in different order are the same wake — hashing the enumeration
 * order instead would retire and re-mint an anchor for a rewrite that changed
 * nothing.
 */
function canonicalBindings(bindings: WakeBindings | undefined): string {
  const entries = Object.entries(bindings ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

/** True when a wake names no referents at all. */
function noBindings(canonical: string): boolean {
  return canonical === "{}";
}

/**
 * A bindings map read from something this module did not write.
 *
 * Shallow and forgiving, like every other read of a stored definition here: a
 * value that is not a string is dropped rather than failing the read, because
 * the alternative is that one malformed pair retires the anchor of a watch that
 * is waking an agent perfectly well.
 */
function readBindings(value: unknown): WakeBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const bindings: WakeBindings = {};
  for (const [key, referent] of Object.entries(value)) {
    if (typeof referent === "string") bindings[key] = referent;
  }
  return bindings;
}

/** The same, from the JSON text a `json_extract` of an object column returns. */
function parseBindings(json: string | null): WakeBindings {
  if (json === null) return {};
  try {
    return readBindings(JSON.parse(json));
  } catch {
    return {};
  }
}

/** An anchor as the subscriptions hold it, with everything a watch can change. */
export interface AnchorRow {
  readonly subscriptionId: string;
  readonly revision: number;
  readonly watchId: string;
  readonly status: string;
  readonly deviceId: string;
  readonly instruction: string;
  /** The referents the instruction names; empty for a wake that names none. */
  readonly bindings: WakeBindings;
  readonly evidence: WatchV2EvidenceKind;
  readonly authoredBy: WatchV2Author;
  /**
   * Whether this module revoked the record itself, rather than a person doing
   * so. False for every record that is not revoked, and for every revocation
   * written before the reason was recorded — the conservative reading, and the
   * one an upgraded install lands on without a backfill.
   */
  readonly machineRetired: boolean;
}

/**
 * Every anchor a watch still owns, by the watch it belongs to.
 *
 * Read from the compiled plan rather than a column of its own: the plan is
 * already the authority on what a subscription is, and a second marker could
 * disagree with it.
 *
 * Revoked and denied records are left out — only a record that still stands is
 * an answer to "where does this watch wake through". The retired ones are not
 * deleted: an egress-ledger entry points at their firings, and erasing them
 * would leave a record of a disclosure with no account of what caused it.
 *
 * What remains can still hold more than one record for a watch, so the rows
 * arrive in {@link ANCHOR_ORDER} and the first one wins. Taking the last
 * enumerated row instead — which is what an unordered read amounts to — would
 * let this and the disclosure page describe the same watch differently, from
 * the same rows, on the same install.
 */
export function readAnchors(db: Db): Map<string, AnchorRow> {
  const rows = db
    .prepare<
      [],
      {
        id: string;
        current_revision: number;
        status: string;
        integration_device_id: string;
        compiled_plan_json: string;
        instruction: string | null;
        bindings: string | null;
      }
    >(
      `SELECT s.id, s.current_revision, s.status, s.integration_device_id,
              r.compiled_plan_json,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.instruction') END AS instruction,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.bindings') END AS bindings
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
        WHERE s.status NOT IN ('revoked', 'denied')
        ${ANCHOR_ORDER}`,
    )
    .all();
  const anchors = new Map<string, AnchorRow>();
  for (const row of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(row.compiled_plan_json);
    } catch {
      // A row this build cannot read is not an anchor as far as it is
      // concerned. Throwing here would take down every wake in the install
      // because one unrelated subscription was written by a newer version.
      continue;
    }
    if (!isPlanShaped(plan) || !isWatchV2Plan(plan)) continue;
    if (anchors.has(plan.predicate.watchId)) continue;
    anchors.set(plan.predicate.watchId, {
      subscriptionId: row.id,
      revision: row.current_revision,
      watchId: plan.predicate.watchId,
      status: row.status,
      deviceId: row.integration_device_id,
      instruction: row.instruction ?? "",
      bindings: parseBindings(row.bindings),
      evidence: plan.predicate.evidence,
      // Read defensively rather than through the schema. This is a shallow
      // shape check by design, so the zod default never runs — and a record
      // written before the field existed genuinely has no author. All of those
      // are the operator's, which is what the default says too.
      authoredBy: (plan.predicate as { authoredBy?: WatchV2Author }).authoredBy ?? "operator",
      // Always false here: this read excludes the revoked outright, so there
      // is no revocation for a reason to describe.
      machineRetired: false,
    });
  }
  return anchors;
}

/**
 * The last record this watch owned, standing or spent, or null if it never had
 * one.
 *
 * What a repair has to read before it mints anything. A record carries three
 * facts a definition cannot: the device it was minted against (an agent that
 * asked to be woken named *itself*, and the definition records only the
 * harness), who asked for it (which decides whether it self-approves), and
 * whether the operator has already decided about it. Re-deriving those from the
 * definition alone is how a repair wakes a sibling, grants itself an approval
 * nobody gave, or puts back a record its owner denied.
 *
 * Every status, including `revoked` and `denied` — those are exactly the ones a
 * repair must see rather than step over.
 */
export function lastAnchorOf(db: Db, watchId: string): AnchorRow | null {
  const rows = db
    .prepare<
      [string],
      {
        id: string;
        current_revision: number;
        status: string;
        integration_device_id: string;
        compiled_plan_json: string;
        instruction: string | null;
        bindings: string | null;
        revoked_reason: string | null;
      }
    >(
      `SELECT s.id, s.current_revision, s.status, s.integration_device_id,
              s.revoked_reason,
              r.compiled_plan_json,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.instruction') END AS instruction,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.bindings') END AS bindings
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
        WHERE json_valid(r.compiled_plan_json)
          AND json_extract(r.compiled_plan_json, '$.predicate.kind') = 'watch-v2'
          AND json_extract(r.compiled_plan_json, '$.predicate.watchId') = ?
        ${ANCHOR_ORDER}`,
    )
    .all(watchId);
  for (const row of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(row.compiled_plan_json);
    } catch {
      continue;
    }
    if (!isPlanShaped(plan) || !isWatchV2Plan(plan)) continue;
    return {
      subscriptionId: row.id,
      revision: row.current_revision,
      watchId,
      status: row.status,
      deviceId: row.integration_device_id,
      instruction: row.instruction ?? "",
      bindings: parseBindings(row.bindings),
      evidence: plan.predicate.evidence,
      authoredBy: (plan.predicate as { authoredBy?: WatchV2Author }).authoredBy ?? "operator",
      machineRetired: row.revoked_reason === MACHINE_ANCHOR_RETIREMENT,
    };
  }
  return null;
}

/**
 * Every standing record one watch owns, in {@link ANCHOR_ORDER}.
 *
 * {@link readAnchors} keeps one row per watch, which is the right answer for
 * "where does this watch wake through" and the wrong one for repairing a watch
 * that holds two: the second is exactly the row that map drops. The order is
 * the shared one, so the record this keeps and the record every other reader
 * reaches are the same record.
 */
export function standingAnchorsOf(db: Db, watchId: string): AnchorRow[] {
  const rows = db
    .prepare<
      [],
      {
        id: string;
        current_revision: number;
        status: string;
        integration_device_id: string;
        compiled_plan_json: string;
        instruction: string | null;
        bindings: string | null;
      }
    >(
      `SELECT s.id, s.current_revision, s.status, s.integration_device_id,
              r.compiled_plan_json,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.instruction') END AS instruction,
              CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.bindings') END AS bindings
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
        WHERE ${STANDING_ANCHOR_SQL}
        ${ANCHOR_ORDER}`,
    )
    .all();
  const anchors: AnchorRow[] = [];
  for (const row of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(row.compiled_plan_json);
    } catch {
      continue;
    }
    if (!isPlanShaped(plan) || !isWatchV2Plan(plan)) continue;
    if (plan.predicate.watchId !== watchId) continue;
    anchors.push({
      subscriptionId: row.id,
      revision: row.current_revision,
      watchId,
      status: row.status,
      deviceId: row.integration_device_id,
      instruction: row.instruction ?? "",
      bindings: parseBindings(row.bindings),
      evidence: plan.predicate.evidence,
      authoredBy: (plan.predicate as { authoredBy?: WatchV2Author }).authoredBy ?? "operator",
      // Always false here: this read is of standing records only, and a record
      // that stands has not been revoked for any reason.
      machineRetired: false,
    });
  }
  return anchors;
}

function isPlanShaped(value: unknown): value is { predicate: { kind: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { predicate?: unknown }).predicate === "object" &&
    (value as { predicate: { kind?: unknown } }).predicate !== null &&
    typeof (value as { predicate: { kind?: unknown } }).predicate.kind === "string"
  );
}

/**
 * Whether a watch's definition declares an agent wake.
 *
 * Read from the DSL rather than from a column, because the delivery block is
 * the authority on what a watch does and a second marker could disagree with
 * it. Read shallowly, and deliberately: a full validation would answer "no" for
 * a definition that fails for a reason having nothing to do with delivery — a
 * node type a newer build wrote, say — and the anchor of a watch that is waking
 * an agent perfectly well would be retired under it.
 */
export function wakesAnAgent(dsl: unknown): boolean {
  return wakeDelivery(dsl) !== null;
}

/**
 * Whom a watch's definition says it wakes, with what instruction, and which
 * referents that instruction names.
 *
 * Read shallowly, for the same reason {@link wakesAnAgent} is: a definition
 * that fails to validate for a reason having nothing to do with delivery — a
 * node type a newer build wrote — still wakes an agent, and a full parse would
 * answer "nobody" and retire the record of a watch that is working.
 *
 * An `agent-wake` block missing its integration is not a wake anybody can
 * carry out, so it reads as none rather than as a record pointing at nothing.
 */
export function wakeDelivery(
  dsl: unknown,
): { integration: string; instruction: string; bindings: WakeBindings } | null {
  const delivery = (
    dsl as {
      watch?: {
        delivery?: {
          kind?: unknown;
          integration?: unknown;
          instruction?: unknown;
          bindings?: unknown;
        };
      };
    } | null
  )?.watch?.delivery;
  if (delivery?.kind !== "agent-wake") return null;
  const integration = delivery.integration;
  if (typeof integration !== "string" || integration.length === 0) return null;
  return {
    integration,
    // An `agent-wake` block whose instruction is missing or not a string reads
    // as the empty string. Nothing valid produces one — the DSL requires it —
    // and `apply` refuses to mint against it rather than writing a record that
    // says nothing.
    instruction: typeof delivery.instruction === "string" ? delivery.instruction : "",
    // A block that names no referents reads as none, which is the common case:
    // most instructions are self-contained prose.
    bindings: readBindings(delivery.bindings),
  };
}

export interface WakeAnchorsDeps {
  readonly db: Db;
  readonly subscriptions: () => SubscriptionService | null;
  /**
   * The watch as it is stored right now, or null when there is no such watch.
   *
   * Read here rather than passed in, and that is what makes an anchor a
   * *reading* of the delivery block rather than an application of whichever
   * request happened to arrive. Two requests changing one watch's delivery both
   * write the definition and then both ask for the anchor; whichever asks last
   * reads the definition both of them left behind, so the record and the
   * document cannot end up disagreeing about whom the watch wakes and with what
   * instruction.
   */
  readonly definition: (watchId: string) => StoredWatch | null;
  /**
   * Stop a watch that cannot be armed, and say why on the watch itself.
   *
   * A log line is not enough for this one. A watch whose anchor cannot be
   * minted goes on evaluating, judging and spending its budget while waking
   * nobody, and that silence is indistinguishable from a condition that has not
   * happened — so the fact has to be written where an operator already looks.
   * Required, not optional: a caller that forgot to wire it would get every
   * other behaviour of this module and silently lose this one, which is the
   * shape a feature ships in when nobody notices it is not connected.
   */
  readonly hold: (watchId: string, note: string) => Promise<void>;
}

/**
 * What a watch's firings may hand an agent, and the sentence they answer.
 *
 * Both are read off the definition here rather than at each caller: evidence
 * decides what a woken agent may *learn*, and two surfaces classifying one
 * watch differently would make that depend on which of them installed it.
 *
 * A definition this build cannot parse is classified `condition-only` — the
 * narrower of the two, so a watch whose shape cannot be read cannot be the
 * reason a document crosses to an agent.
 */
function wakeEvidence(dsl: unknown): WatchV2EvidenceKind {
  const parsed = watchDslSchema.safeParse(dsl);
  return parsed.success ? wakeEvidenceKind(parsed.data.watch) : "condition-only";
}

/** The request a watch was written from, when its document still parses. */
function wakeRequest(dsl: unknown): string | undefined {
  const parsed = watchDslSchema.safeParse(dsl);
  return parsed.success ? parsed.data.watch.nl_query : undefined;
}

/**
 * The device holding a named integration, or null when none does.
 *
 * Resolved by harness name rather than stored as a device id, because a device
 * id changes when a harness re-pairs and a watch written against one would stop
 * waking anybody the day that happened — silently, since the watch would go on
 * firing perfectly well.
 */
function integrationDevice(db: Db, integration: string): string | null {
  const row = db
    .prepare<[string], { id: string }>(
      `SELECT id FROM devices
        WHERE kind = 'agent' AND json_extract(capabilities, '$.agentIntegration.harness') = ?
        ORDER BY paired_at DESC, id LIMIT 1`,
    )
    .get(integration);
  return row?.id ?? null;
}

/**
 * What the anchor was minted for, in one string.
 *
 * A subscription is idempotent on the request that created it, so re-installing
 * an unchanged watch has to converge on the record it already has while a watch
 * whose delivery block changed has to mint a fresh one. Keying on the shape of
 * the wake rather than on the watch alone is what makes both true at once.
 *
 * The referents are part of that shape: an instruction pointed at a different
 * conversation is a different wake however identical its words, and an anchor
 * that converged on the old key would carry the old ones.
 */
function anchorKey(
  watchId: string,
  deviceId: string,
  instruction: string,
  bindings: WakeBindings,
  evidence: WatchV2EvidenceKind,
  authoredBy: WatchV2Author,
): string {
  // The referents join the digest only when there are any, so a wake that
  // names none keys exactly as one written before referents could be named —
  // the alternative re-mints every anchor on the install for a change none of
  // those watches made.
  const canonical = canonicalBindings(bindings);
  const shape = [deviceId, instruction, evidence, authoredBy];
  if (!noBindings(canonical)) shape.push(canonical);
  const digest = createHash("sha256").update(shape.join("\u0000")).digest("hex").slice(0, 16);
  return `watch2_${watchId}_${digest}`;
}

/**
 * How many spent key slots one wake shape may accumulate before this gives up.
 *
 * A slot is spent by a delivery change away from this shape, so reaching the
 * ceiling means one watch has been toggled between two deliveries a thousand
 * times. Bounded regardless: an unbounded probe loop over a corrupt table
 * would hang the install rather than fail it.
 */
const MAX_ANCHOR_KEY_SLOTS = 1000;

/**
 * The key this generation of a wake should be minted under, or null when there
 * is none to be had.
 *
 * A derived key names a *shape* — this device, this instruction, this evidence
 * rule — and two requests carrying that shape are the same request only while
 * the record made for the first one still stands. The store's idempotency
 * lookup does not read status, so converging on a spent key returns a record
 * that carries nothing while every log line reports an install.
 *
 * So a spent slot is stepped over. The suffix depends only on what is in the
 * table, which is what keeps the retry case working: two concurrent installs of
 * one shape see the same spent slots, derive the same key, and converge through
 * the store's own idempotency.
 *
 * Only a *derived* key is walked. A key an integration supplied is that
 * caller's own name for its request, and a retry of it must return the record
 * it made — spent or not — rather than quietly minting a second one.
 */
function freeAnchorKey(db: Db, deviceId: string, base: string): string | null {
  const owner = subscriptionOwnerId(deviceId);
  for (let slot = 0; slot < MAX_ANCHOR_KEY_SLOTS; slot += 1) {
    const key = slot === 0 ? base : `${base}_${slot}`;
    const status = subscriptionStatusForRequest(db, owner, key);
    if (status === null || isStandingAnchorStatus(status)) return key;
  }
  // Every slot spent. Refusing is the honest answer: reusing the base key
  // converges on a record that is over, and reports a wake nobody receives.
  log.warn(`wake anchor key ${base} has no free slot after ${MAX_ANCHOR_KEY_SLOTS} retirements`);
  return null;
}

/**
 * Whom a watch wakes.
 *
 * A watch the operator wrote names a **harness** — `openclaw` — and the device
 * is looked up from it, because a device id changes when a harness re-pairs and
 * a watch written against one would stop waking anybody the day that happened,
 * silently, while going on firing perfectly well.
 *
 * A watch an agent asked for names the **device that asked**, and must: the
 * harness name would resolve to whichever device holding that name paired most
 * recently, which on a host running two of them is not reliably the caller. An
 * agent that asked to be woken and woke a sibling instead is the one mistake
 * this has to be incapable of making.
 */
export type WakeTarget =
  | { readonly kind: "harness"; readonly name: string }
  | {
      readonly kind: "device";
      readonly deviceId: string;
      /**
       * The harness this device holds.
       *
       * Carried alongside the id rather than looked up, because both are
       * needed and only the caller knows they belong together: the anchor is
       * minted against the *device*, so an agent is woken over its own
       * connection, while the definition records the *harness*, so the watch
       * survives that agent re-pairing under a new device id.
       */
      readonly harness: string;
    };

/** What a watch does when it fires, and for whom. */
export interface WakeDelivery {
  readonly target: WakeTarget;
  readonly instruction: string;
  /**
   * The referents the instruction names, transported without interpretation.
   *
   * Absent and empty mean the same thing — an instruction that stands on its
   * own — and both key the anchor identically, so most watches carry neither.
   */
  readonly bindings?: WakeBindings;
  /** Defaults to the operator; see {@link WatchV2Author}. */
  readonly authoredBy?: WatchV2Author;
  /**
   * The key this record is identified by, when the asker supplied one.
   *
   * An operator's watch has no such key and gets one derived from the shape of
   * the wake, so re-installing an unchanged watch converges. An integration
   * brought its own and the record has to carry *that*, or two concurrent
   * retries of one request each mint a watch.
   */
  readonly idempotencyKey?: string;
}

/** What only the asker knows, when the definition cannot say it. */
export interface WakeAsker {
  /**
   * The device to wake, when it must be this one and not whichever device
   * holds the harness.
   *
   * An agent that asked to be woken names itself: resolving the harness would
   * pick whichever device holding that name paired most recently, which on a
   * host running two of them is not reliably the caller, and waking a sibling
   * instead is the one mistake this has to be incapable of making.
   */
  readonly target?: WakeTarget;
  /** Defaults to the operator; see {@link WatchV2Author}. */
  readonly authoredBy?: WatchV2Author;
  /**
   * The key this record is identified by, when the asker supplied one.
   *
   * An operator's watch has no such key and gets one derived from the shape of
   * the wake, so re-installing an unchanged watch converges. An integration
   * brought its own and the record has to carry *that*, or two concurrent
   * retries of one request each mint a watch.
   */
  readonly idempotencyKey?: string;
}

export interface WakeAnchors extends WatchWakeAnchorPort {
  /**
   * Bring one watch's anchor into line with its delivery block, and report the
   * record that now carries it — or null when the watch wakes nobody, or when
   * nothing could be minted. The id is how a caller that *asked* for the watch
   * reads back the record it will be approving.
   *
   * Takes a watch id and reads the definition, rather than being handed a
   * delivery: the definition is the authority on whom a watch wakes, and a
   * caller passing its own copy is how the record and the document come to
   * disagree. A watch that no longer exists, or no longer wakes an agent,
   * retires whatever it held.
   *
   * **Serialised per watch.** The walk from reading the existing record to
   * creating the new one spans several awaits, and two requests interleaving
   * through it both retire the same record and then both create one — two
   * standing anchors for one watch, of which every reader here sees only the
   * first, and the second holds a grant no screen lists and no sweep retires.
   */
  set(watchId: string, asker?: WakeAsker): Promise<string | null>;
  /**
   * Retire every anchor no longer owned by a live watch.
   *
   * A watch and its anchor are written by two stores that cannot share a
   * transaction, so a crash between them can leave an anchor whose watch was
   * removed, or whose delivery block was turned off. Reconciling against the
   * live set at start is what makes that window recoverable rather than
   * permanent; nothing else ever notices, because a watch that does not exist
   * never fires.
   *
   * Takes a {@link WatchCensus} rather than a bare set, because an empty set
   * is ambiguous in a way that costs the operator real state: retiring on it
   * revokes every wake subscription in the main database, which no amount of
   * putting files back restores. A caller has to say whether it is reporting
   * an answer or the absence of one.
   */
  reconcile(census: WatchCensus): Promise<number>;
}

/**
 * What is known about the live watch set, at the moment reconciliation runs.
 *
 * `known` carries the ids of every watch that currently wants to wake an
 * agent — including none of them, which is a real and actionable answer: the
 * operator turned their last wake off, and the anchors should follow.
 *
 * `unknown` is the other case, and it exists because the two are not
 * distinguishable from a set. A journal that was created on this boot lists no
 * watches because it has never held any; a journal that could not be opened
 * lists none because nothing was read. Treating either as "the operator
 * removed them all" retires every anchor, and an anchor carries a grant and an
 * approval that cannot be reconstructed from the watch it belonged to.
 */
export type WatchCensus =
  | { readonly kind: "known"; readonly wakingWatchIds: ReadonlySet<string> }
  | { readonly kind: "unknown"; readonly why: string };

/** How a watch's anchor set departs from the one record it should hold. */
export interface AnchorBreach {
  readonly watchId: string;
  /** How many records still stand for it: 0 when it wakes nobody, 2+ when it
   *  holds a record no surface can reach. */
  readonly standing: number;
}

/**
 * The delivery-bearing watches that do not hold exactly one standing anchor.
 *
 * Both departures are invisible from every other surface, which is why they are
 * worth a query of their own. A watch with **none** evaluates, judges and
 * records exactly as a healthy one does; the only difference is that nothing
 * arrives at the other end. A watch with **two** wakes through whichever
 * {@link ANCHOR_ORDER} ranks first, while the other holds a grant that no
 * screen lists and no sweep retires — every reader here is one-per-watch, so a
 * shadowed record is unreachable rather than merely redundant.
 *
 * Counted from the rows rather than from {@link readAnchors}, whose map keeps
 * one row per watch and so cannot see the second.
 *
 * Reported rather than repaired. Minting a missing record needs the delivery
 * block — whom to wake, under what instruction — which lives in the watch's
 * definition, not in a set of ids; and retiring one of a pair means choosing
 * which grant an operator keeps. Both are decisions, not cleanups.
 */
export function watchAnchorBreaches(
  db: Db,
  wakingWatchIds: Iterable<string>,
): readonly AnchorBreach[] {
  const standing = new Map<string, number>();
  const rows = db
    .prepare<[], { compiled_plan_json: string }>(
      `SELECT r.compiled_plan_json
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
        WHERE json_valid(r.compiled_plan_json)
          AND json_extract(r.compiled_plan_json, '$.predicate.kind') = 'watch-v2'
          AND ${STANDING_ANCHOR_SQL}`,
    )
    .all();
  for (const row of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(row.compiled_plan_json);
    } catch {
      continue;
    }
    if (!isPlanShaped(plan) || !isWatchV2Plan(plan)) continue;
    const watchId = plan.predicate.watchId;
    standing.set(watchId, (standing.get(watchId) ?? 0) + 1);
  }
  const breaches: AnchorBreach[] = [];
  for (const watchId of wakingWatchIds) {
    const count = standing.get(watchId) ?? 0;
    if (count !== 1) breaches.push({ watchId, standing: count });
  }
  return breaches;
}

/**
 * Report firings into anchors, and keep the anchor set in step with the
 * watches that own it.
 */
export function createWakeAnchors(deps: WakeAnchorsDeps): WakeAnchors {
  /**
   * Retire one anchor, and say whether it was retired.
   *
   * The answer is the point. Without a subscription service there is nothing to
   * revoke through, and a caller that assumed otherwise reports a repair that
   * did not happen — the record goes on standing with its grant, the next boot
   * reads the same set in the same order and skips the same one, and the count
   * says it was dealt with every time.
   */
  async function retire(anchor: AnchorRow, why: string): Promise<boolean> {
    const service = deps.subscriptions();
    if (!service) {
      log.warn(
        `the wake anchor for watch ${anchor.watchId} still stands (${why}): nothing is wired to retire it`,
      );
      return false;
    }
    // The marker says a repair may finish what this retirement started, so it
    // is stamped only where finishing it can restore no more than what was
    // taken away. A record that was `active` came back active and nothing
    // moved. A record that was `paused` or `pending_approval` is one a person
    // stopped or has not yet answered, and the replacement would be neither —
    // an operator's re-mint self-approves, handing back the wake they paused.
    // Left unmarked, those read as a person's revocation and repair holds,
    // which is the outcome an operator can still act on.
    const reason = anchor.status === "active" ? MACHINE_ANCHOR_RETIREMENT : undefined;
    await service.revokeTrusted(anchor.subscriptionId, reason);
    log.info(`retired the wake anchor for watch ${anchor.watchId}: ${why}`);
    return true;
  }

  /**
   * One at a time per watch, in the order the callers arrived.
   *
   * Keyed on the watch rather than global: two operators changing two watches
   * have nothing to do with each other, and a single queue would make the
   * slower one wait on a subscription write it has no interest in.
   */
  const turns = new Map<string, Promise<unknown>>();
  async function single<T>(watchId: string, work: () => Promise<T>): Promise<T> {
    const ahead = turns.get(watchId) ?? Promise.resolve();
    let release!: () => void;
    const mine = ahead.catch(() => {}).then(() => new Promise<void>((done) => (release = done)));
    turns.set(watchId, mine);
    // Awaited rather than chained onto, so an earlier failure cannot propagate
    // into this caller — the chain is only ever resolved by its own release.
    await ahead.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (turns.get(watchId) === mine) turns.delete(watchId);
    }
  }

  /**
   * One watch's anchor, brought into line with what its definition now says.
   *
   * Called only through {@link single}, which is what makes the walk below —
   * read, retire, probe for a free key, create — one turn rather than four
   * interleavable awaits.
   */
  async function apply(watchId: string, asker?: WakeAsker): Promise<string | null> {
    const service = deps.subscriptions();
    const watch = deps.definition(watchId);
    const existing = readAnchors(deps.db).get(watchId);
    // Read from the definition, so the last request to reach here decides —
    // and so a watch that was removed, or whose delivery block was turned off,
    // retires what it held rather than leaving a record nobody authored.
    const declared = watch === null ? null : wakeDelivery(watch.dsl);

    if (!service) {
      if (declared) {
        log.warn(`watch ${watch?.name ?? watchId} wants to wake an agent but none is configured`);
      }
      return null;
    }

    if (!declared || watch === null) {
      if (existing) {
        await retire(
          existing,
          watch === null ? "its watch was removed" : `watch ${watch.name} no longer wakes an agent`,
        );
      }
      return null;
    }

    // Refused before anything is retired, because a record carrying no
    // instruction is one the store rejects when it reads it back — and by then
    // the record this was replacing is gone. The DSL requires an instruction,
    // so reaching here means a definition written by something that did not go
    // through it.
    if (declared.instruction.length === 0) {
      log.warn(`watch ${watch.name} declares an agent wake with no instruction; none was minted`);
      return null;
    }

    const evidence = wakeEvidence(watch.dsl);
    const request = wakeRequest(watch.dsl);
    const delivery: WakeDelivery = {
      target: asker?.target ?? { kind: "harness", name: declared.integration },
      instruction: declared.instruction,
      ...(noBindings(canonicalBindings(declared.bindings)) ? {} : { bindings: declared.bindings }),
      ...(asker?.authoredBy === undefined ? {} : { authoredBy: asker.authoredBy }),
      ...(asker?.idempotencyKey === undefined ? {} : { idempotencyKey: asker.idempotencyKey }),
    };

    const target = delivery.target;
    const deviceId =
      target.kind === "device" ? target.deviceId : integrationDevice(deps.db, target.name);
    if (!deviceId) {
      // The watch is stopped, and the reason goes where an operator reads it.
      // Left running it evaluates, judges, spends its budget and wakes nobody
      // for as long as it exists, and that silence is indistinguishable from an agent that read
      // every wake and did nothing — so the fact goes where an operator already
      // looks. Nothing here can repair it: a wake needs a device, and choosing
      // one on the operator's behalf is the sibling-waking mistake anchoring is
      // built to be incapable of. Pairing the harness again and installing the
      // watch from it is the answer, and the note says so.
      log.warn(
        `watch ${watch.name} names integration '${target.kind === "harness" ? target.name : target.deviceId}', which no paired device holds — holding it`,
      );
      await deps.hold(watch.id, ANCHOR_DEVICE_GONE_NOTE);
      return null;
    }
    const authoredBy = delivery.authoredBy ?? "operator";
    const bindings = delivery.bindings ?? {};
    if (existing) {
      const unchanged =
        existing.deviceId === deviceId &&
        existing.instruction === delivery.instruction &&
        // Compared like everything else the record carries. An instruction
        // whose words did not move but whose referents did is a wake at a
        // different thing, and a record left standing would go on handing the
        // agent the ones it was approved with.
        canonicalBindings(existing.bindings) === canonicalBindings(bindings) &&
        existing.evidence === evidence &&
        existing.authoredBy === authoredBy;
      // Converge only on a record that still stands. An expired anchor is
      // read here — it is not revoked — but it wakes nobody, and returning it
      // would report a successful install of a watch whose delivery has
      // quietly stopped working; re-installing is how an operator asks for it
      // back. A paused one is the opposite case and must be returned: the
      // pause is somebody's decision, and minting a replacement beside it
      // would hand back the wake they just stopped.
      if (unchanged && isStandingAnchorStatus(existing.status)) return existing.subscriptionId;
      // An anchor cannot be edited into a different one: the instruction it
      // carries is what the operator approved, and rewriting an approved
      // record in place would leave the ledger claiming a wake was sent under
      // words nobody agreed to. So a changed delivery block retires the old
      // anchor and mints a new one, and the firings of each stay attached to
      // the instruction they were sent under. A record already spent has
      // nothing to retire.
      if (isStandingAnchorStatus(existing.status)) {
        // Minting beside a record that is still standing is the one outcome
        // worse than not minting at all: two standing anchors, of which every
        // reader here sees only the first, and the second holds a grant no
        // screen lists and no sweep retires.
        if (!(await retire(existing, `watch ${watch.name} changed what it wakes, or whom`))) {
          return null;
        }
      }
    }

    let idempotencyKey = delivery.idempotencyKey;
    if (idempotencyKey === undefined) {
      const free = freeAnchorKey(
        deps.db,
        deviceId,
        anchorKey(watch.id, deviceId, delivery.instruction, bindings, evidence, authoredBy),
      );
      if (free === null) return null;
      idempotencyKey = free;
    }

    const anchor = await service.createWatchV2Anchor({
      integrationDeviceId: deviceId,
      watchId: watch.id,
      watchName: watch.name,
      request,
      instruction: delivery.instruction,
      // Empty for the common case, and the record leaves the field out rather
      // than writing a map that names nothing — what an operator reads back is
      // what was authored.
      bindings,
      evidence,
      authoredBy,
      // The compile that produced the plan this record is the front of. A
      // delivery change mints a fresh anchor without recompiling anything,
      // so the new record points at the same compile as the old one — which
      // is the truth: the watch was reasoned about once.
      ...(watch.compileRunId ? { compileRunId: watch.compileRunId } : {}),
      idempotencyKey,
    });
    // What came back, rather than what was asked for. The key was chosen from
    // a read taken before the write, and the store settles the request in its
    // own transaction on another thread — so a record that was standing when
    // it was probed can be revoked by the time the create converges on it.
    // Reporting an install then would be the silence this whole path exists
    // to prevent, one race narrower.
    if (isSpentAnchorStatus(anchor.status)) {
      log.warn(
        `watch ${watch.name} converged on a ${anchor.status} record; it wakes nobody until it is installed again`,
      );
      return null;
    }
    log.info(`watch ${watch.name} will wake device ${deviceId} when it fires`);
    return anchor.id;
  }

  return {
    anchorFor(watchId: string) {
      const anchor = readAnchors(deps.db).get(watchId);
      // Only a live anchor can carry a firing. One still waiting on its
      // approval would refuse the firing at the write, and reporting into it
      // would spend the wake allowance on a wake nobody receives.
      if (!anchor || anchor.status !== "active") return null;
      return {
        subscriptionId: anchor.subscriptionId,
        revision: anchor.revision,
        evidence: anchor.evidence,
      };
    },

    async fire(input) {
      const service = deps.subscriptions();
      if (!service) return { fired: false };
      return service.fireWatchV2Anchor(input);
    },

    set(watchId, asker) {
      return single(watchId, () => apply(watchId, asker));
    },
    async reconcile(census) {
      if (census.kind === "unknown") {
        // Said rather than swallowed: skipping reconciliation leaves anchors
        // for watches that may genuinely be gone, and that is the safe half of
        // an unsafe pair — but it is still a thing that did not happen.
        log.warn(`anchors were not reconciled: ${census.why}`);
        return 0;
      }
      if (!deps.subscriptions()) {
        // Every repair below goes through the subscription service, so without
        // one this pass can only walk the set and report having fixed it. A
        // caller runs this once at boot; a pass that ran too early and reported
        // success is a fault nobody looks for again.
        log.warn("anchors were not reconciled: no subscription service is wired yet");
        return 0;
      }
      let retired = 0;
      // Every step below is contained to the watch it is about. Each is one or
      // two writes through the subscription service, any of which can throw,
      // and a pass that let one out would abandon every watch after it —
      // silently, and with the count it had reached discarded by its caller.
      const perWatch = async (watchId: string, step: () => Promise<number>): Promise<void> => {
        try {
          retired += await step();
        } catch (error) {
          log.warn(
            `watch ${watchId}'s wake records could not be reconciled: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      for (const anchor of readAnchors(deps.db).values()) {
        if (census.wakingWatchIds.has(anchor.watchId)) continue;
        await perWatch(anchor.watchId, async () =>
          (await retire(anchor, "its watch no longer wakes an agent")) ? 1 : 0,
        );
      }
      // The other direction of the same invariant, checked after the retiring
      // so it acts on the set that is actually left.
      //
      // `agreed` collects the watches the cardinality pass has already brought
      // into line with their definition. A `standing === 0` repair mints from
      // the delivery block, so what it leaves cannot disagree with it; a
      // `standing >= 2` repair only retires the unreachable extras and never
      // looks at the survivor, which may be as stale as any other watch's.
      const agreed = new Set<string>();
      for (const breach of watchAnchorBreaches(deps.db, census.wakingWatchIds)) {
        await perWatch(breach.watchId, () => repair(breach, agreed));
      }
      // One read for the whole pass rather than one per watch: this is a join
      // over every subscription, at boot, on the main thread. Each repair
      // re-reads inside its own turn anyway.
      const standing = readAnchors(deps.db);
      for (const watchId of census.wakingWatchIds) {
        if (agreed.has(watchId)) continue;
        await perWatch(watchId, () => realign(watchId, standing.get(watchId)));
      }
      return retired;
    },
  };

  /**
   * One watch that does not hold exactly one standing record, brought back.
   *
   * Returns how many records it retired — nothing, for the watch that had none
   * and got one. Both departures are invisible from every other surface, so a
   * log line is a fault nobody is going to read, and both repairs are decidable
   * without asking anyone: what is minted comes from the watch's own delivery
   * block, and which of a pair is kept is the order every reader already agrees
   * on.
   */
  async function repair(breach: AnchorBreach, agreed: Set<string>): Promise<number> {
    if (breach.standing === 0) {
      agreed.add(breach.watchId);
      const prior = lastAnchorOf(deps.db, breach.watchId);
      // A decision is not a fault to repair. `denied` is the operator saying
      // no and a person's `revoked` is them or its owner taking it back;
      // minting a replacement would overturn either, and a repair has
      // nobody to ask. `expired` is not a decision — a record lapsed on its
      // own while the watch went on declaring a wake — so that one is
      // repaired, which is the whole state `silent-risk` was reporting.
      //
      // A revocation this module wrote is not a decision either. Changing a
      // watch's delivery retires the old record and mints a new one, and a
      // crash between the two leaves exactly this: a live, waking watch
      // whose only record is revoked. Refusing there would make the window
      // permanent — the watch evaluates, judges, spends its budget and
      // wakes nobody, forever, with no hold and no note. Finishing the
      // change is what the operator asked for when they made it.
      if (
        prior !== null &&
        (prior.status === "denied" || (prior.status === "revoked" && !prior.machineRetired))
      ) {
        log.warn(
          `watch ${breach.watchId} declares an agent wake and its record is ${prior.status}; leaving it alone`,
        );
        return 0;
      }
      const minted = await single(breach.watchId, () =>
        // The predecessor's identity, not the definition's: the definition
        // names a harness, and resolving one picks whichever device holding
        // that name paired most recently — which on a host running two of
        // them is not reliably the agent that asked. Waking a sibling is the
        // one mistake this must be incapable of making. With no predecessor
        // there is nothing to preserve and the definition is all there is.
        apply(
          breach.watchId,
          prior === null
            ? undefined
            : {
                target: { kind: "device", deviceId: prior.deviceId, harness: "" },
                authoredBy: prior.authoredBy,
              },
        ),
      );
      if (minted === null) {
        // The same silence the device-gone branch closes, reached by every
        // other way minting can fail: no agent configured, a declaration with
        // no instruction, a record that could not be retired, a key already
        // taken, a race onto a spent record. Left running, the watch goes on
        // evaluating, judging and spending its budget while waking nobody.
        //
        // Safe to write over the branch that already held: `holdUnarmed` stops
        // only a watch that is still running, so a hold naming the specific
        // cause survives this general one.
        log.warn(
          `watch ${breach.watchId} declares an agent wake and holds no record to carry it; one could not be minted`,
        );
        await deps.hold(breach.watchId, ANCHOR_UNMINTED_NOTE);
        return 0;
      }
      log.warn(
        `watch ${breach.watchId} held no record to wake through; minted ${minted} from its delivery block`,
      );
      return 0;
    }
    // Every record past the first, by the order every reader here uses.
    // The one that stays is the one they were all already reaching; the
    // rest hold a grant no screen lists.
    //
    // Under the same per-watch turn as every other walk that reads the set
    // and then writes it. Reading the pair outside one and retiring on what
    // it said would let a concurrent install mint between the read and the
    // retire, and this pass would then retire the record that install had
    // just returned as the watch's own.
    const shed = await single(breach.watchId, async () => {
      const [, ...shadowed] = standingAnchorsOf(deps.db, breach.watchId);
      let gone = 0;
      for (const extra of shadowed) {
        if (await retire(extra, "its watch already holds a record no surface can reach past")) {
          gone += 1;
        }
      }
      return gone;
    });
    log.warn(
      `watch ${breach.watchId} held ${breach.standing} standing wake records; retired ${shed}`,
    );
    return shed;
  }

  /**
   * One watch whose record stands, checked against what its definition says.
   *
   * Cardinality is not agreement. A crash between writing a rewritten
   * definition and minting its anchor leaves exactly one standing record
   * carrying the instruction the watch used to have — no breach by count, and
   * the agent goes on being woken with words the definition no longer contains.
   */
  async function realign(watchId: string, standing: AnchorRow | undefined): Promise<number> {
    const watch = deps.definition(watchId);
    if (!standing || watch === null) return 0;
    const declared = wakeDelivery(watch.dsl);
    if (!declared) return 0;
    // Whether the evidence rule agrees is only askable of a definition this
    // build can read. `wakeEvidence` answers `condition-only` for one it
    // cannot — a node type a newer build wrote, say — so comparing against it
    // here would read every such watch as disagreeing, and re-mint it narrower
    // than the record it already holds. Deciding nothing is the answer that
    // cannot make a working watch worse.
    if (!watchDslSchema.safeParse(watch.dsl).success) return 0;
    if (
      standing.instruction === declared.instruction &&
      // The referents are half of what the instruction means. A record whose
      // words still match but whose bindings do not points the woken agent at
      // whatever the watch used to be about, and nothing else would notice.
      canonicalBindings(standing.bindings) === canonicalBindings(declared.bindings) &&
      standing.evidence === wakeEvidence(watch.dsl)
    ) {
      return 0;
    }
    log.warn(
      `watch ${watchId} wakes through a record its definition no longer describes; replacing it`,
    );
    // The standing record's own device and author, for the same reason the
    // missing-record repair preserves the predecessor's: the definition names a
    // harness, and resolving one picks whichever device holding that name
    // paired most recently. What is being repaired here is what the record
    // says, and nothing else about it may move with that.
    const replaced = await single(watchId, () =>
      apply(watchId, {
        target: { kind: "device", deviceId: standing.deviceId, harness: "" },
        authoredBy: standing.authoredBy,
      }),
    );
    if (replaced === null) {
      log.warn(`watch ${watchId} carries a stale wake record and could not be re-minted`);
      return 0;
    }
    // The stale record was retired to make room for this one, and it counts
    // like every other retirement this pass performed.
    return 1;
  }
}
