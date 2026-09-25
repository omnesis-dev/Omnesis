// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `/admin/watch/*` — the operator's window onto the shadow runtime.
 *
 * The whole surface is gated: a middleware runs first on every route and 404s
 * when experimental mode is off, before the scope guard and before body
 * validation, so a gateway with the feature off is indistinguishable from one
 * that never had it. No 401 for a missing token, no 400 for a malformed body —
 * the routes simply are not there. Same shape the dev-annotations channel uses.
 *
 * Everything here is read-mostly and operator-only. A watch is *added* as data
 * (a DSL file the operator wrote or a compiler produced), validated against the
 * live ontology before it is stored. The other writes are the small number of
 * decisions an operator makes about a watch already running: hold it, let it go
 * again, re-stamp it, and say whether what it finds is worth interrupting them
 * for. There is nothing to acknowledge, approve or retry — a firing is a row,
 * and a notification about it is sent once or not at all.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertNever, createLogger, experimentalEnabled } from "@omnesis/core";
import {
  CURRENT_NOTIFY_KIND,
  isNotifyDeliveryKind,
  Ontology,
  type WatchDefinition,
  RecordingOntology,
  validateWatch,
  documentLineage,
  SINK_LINEAGE_KEY,
  watchDslSchema,
  type WatchDelivery,
  type WatchFailure,
  type WatchLiveState,
  type WatchStateSnapshot,
} from "@omnesis/watch";
import { probeArm, semanticArms, type ProbeDeps } from "../../watch/probe-run.js";
import {
  MAX_PREFLIGHT_EVENTS,
  MAX_REPLAY_DAYS,
  type PreflightOutcome,
} from "../../watch/preflight.js";
import { wakesAnAgent } from "../../watch/anchors.js";
import { watchV2FiringKey } from "../../subscriptions/watch-v2-plan.js";
import {
  driftCodesOf,
  ANCHOR_UNMINTED_NOTE,
  HELD_BY_OPERATOR,
  holdUnarmed,
  isUnarmedNote,
  stoppedCause,
  surfaceReasonOf,
} from "../../watch/health.js";
import { watchVerdict, type WatchVerdict } from "../../watch/verdict.js";
import {
  buildOntologySnapshot,
  type OntologyCoverage,
  type OntologyDeps,
} from "../../watch/ontology.js";
import { DEFAULT_RETAINED } from "../../watch/traces.js";
import {
  arrivalCandidates,
  keyComponentCandidates,
  stateResponse,
} from "../../watch/state-response.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import { scope } from "../scope.js";
import { withFingerprint } from "../../watch/definitions.js";
import type { CompilesInFlight } from "../../watch/in-flight-requests.js";
import type { WatchV2Author } from "../../subscriptions/watch-v2-plan.js";
import type { WakeTarget } from "../../watch/anchors.js";
import type {
  AuthorWatchRequest,
  AuthorWatchResult,
  PreviewWatchRequest,
  PreviewWatchResult,
} from "../../watch/authoring.js";
import type { WatchLayerHealth } from "../../watch/health.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, RouteApp } from "./types.js";
import type { WatchDefinitionStore, StoredWatch } from "../../watch/definitions.js";
import type {
  EvaluationLatency,
  SkipPlan,
  WatchFireByHandResult,
  WatchStateResult,
} from "../../watch/engine-host.js";
import type { TraceRow, WatchTraceStore } from "../../watch/traces.js";
import type { WatchJournalStore } from "../../watch/store.js";
import type { JudgeBudgetPosition, JudgeTally } from "../../watch/judge.js";
import type { WriteLease } from "../../watch/write-lease.js";
import type { WatchDisclosure, WatchDisclosureSummary } from "../../watch/disclosure.js";
import type { WatchOutboxStats } from "../../analytics/watch-outbox-store.js";

const log = createLogger("gateway:http").child("routes:watch-v2");

/**
 * Retry the arming of a watch that has just been resumed from an unarmed hold,
 * and hold it again if it still cannot be armed. Reports whether it was.
 *
 * Shared by the two paths that resume watches, because resuming one clears the
 * note — the only record of why it stopped. A path that resumed without this
 * would report the watch active and leave it evaluating into nothing, having
 * erased the evidence. Written once so the bulk path cannot become the way
 * around the single one.
 */
async function rearmAfterResume(
  deps: WatchV2RoutesDeps,
  id: string,
  name: string,
  dsl: unknown,
): Promise<boolean> {
  const minted = await deps.setWakeAnchor(id, { authoredBy: "operator" }).catch(() => null);
  // A watch that wakes nobody has nothing to arm, so a null mint is the
  // ordinary answer rather than a failure.
  if (minted !== null || !wakesAnAgent(dsl)) return false;
  await deps.writes.run(() =>
    Promise.resolve(holdUnarmed(deps.definitions, id, ANCHOR_UNMINTED_NOTE)),
  );
  log.warn(`watch ${name} could not be armed on resume; it is held again`);
  return true;
}

/**
 * What one firing's woken workflow did, as the subscriptions hold it.
 *
 * The other end of the wake chain. A firing says the condition became true and
 * a delivery says the wake was handed over; neither says whether the work the
 * instruction asked for happened, and an agent that woke, read the instruction
 * and did nothing looks exactly like one that completed it.
 *
 * `outcome` is null until a run reports, and a run may report more than once —
 * a workflow that ended waiting on something re-enters and says so again — so
 * what is here is the latest account rather than a final one.
 */
export interface WatchWorkflowOutcome {
  readonly subscriptionId: string;
  /** The firing key the subscriptions hold this under. */
  readonly firingId: string;
  readonly deliveryStatus: string;
  /** When the woken agent took delivery, or null if it never did. */
  readonly acceptedAt: number | null;
  /** The run the harness gave it on its own side, when it named one. */
  readonly localRunId: string | null;
  readonly outcome: {
    readonly status: string;
    readonly report: string | null;
    readonly reportedAt: number;
  } | null;
}

export interface WatchV2RoutesDeps {
  readonly definitions: WatchDefinitionStore;
  /**
   * Whether the gateway is still willing to start a compile, and what is
   * already running.
   *
   * Read rather than owned: the same object the authoring layer coalesces on,
   * so "open" here and "will actually run" there cannot disagree.
   */
  readonly compiles: CompilesInFlight;
  readonly traces: WatchTraceStore;
  readonly journal: WatchJournalStore;
  readonly ontology: OntologyDeps;
  /** How much of the substrate the DSL can address, from the running engine. */
  readonly ontologyCoverage: () => OntologyCoverage | null;
  /** Whether the layer is evaluating, and what stopped whatever is not. */
  readonly health: () => WatchLayerHealth;
  readonly analyticsOutbox?: () => Promise<WatchOutboxStats | null>;
  /**
   * Turn a request into a watch, or refuse with reasons.
   *
   * Absent when no model is assigned for it, which is a configuration state
   * rather than an error — the rest of the surface still works, and a caller
   * asking to compile is told plainly that this install cannot.
   */
  readonly author: (input: AuthorWatchRequest) => Promise<AuthorWatchResult>;
  /**
   * The same compile, handing the document back instead of installing it.
   *
   * A separate dependency rather than a flag on `author`, because the whole
   * value of it is that it cannot write — and a flag would leave that as a
   * claim about a branch rather than a fact about what is in scope.
   */
  readonly preview: (input: PreviewWatchRequest) => Promise<PreviewWatchResult>;
  /**
   * Remove the watch behind a revoked record, when an integration asked for it.
   *
   * A no-op for anything else, so the revoke path can call it without first
   * having to know what kind of record it just revoked.
   */
  readonly retireAuthoredWatch: (subscriptionId: string, revision: number) => Promise<void>;
  /** The corpus and scorer a recall probe runs against. */
  readonly probe: ProbeDeps;
  /** What every watch has caught and when, in one read — see the list route. */
  readonly firingSummary: () => Promise<
    Map<string, { count: number; lastFiredAtMs: number | null }>
  >;
  /**
   * The watches that do not hold exactly one standing wake record, of those
   * asked about. A watch absent from the answer holds its one.
   */
  readonly anchorBreaches: (
    watchIds: readonly string[],
  ) => readonly { watchId: string; standing: number }[];
  /**
   * Try a candidate over the tail of the journal, without storing it.
   *
   * Absent on an install with no running engine — the whole route surface is
   * mounted only when there is one, so this is belt and braces rather than a
   * state a request can reach.
   */
  readonly preflight?: (
    watch: WatchDefinition,
    opts: { events?: number; days?: number },
  ) => Promise<PreflightOutcome>;
  /**
   * Fire a watch by hand, so where its firings go can be proved on demand.
   *
   * Required, like every other engine verb here: this whole dependency object
   * is assembled in one place and only when the engine is running, so an
   * optional member would buy a branch nothing can reach and a capability that
   * could be left unwired without anything noticing.
   */
  readonly fireByHand: (
    watchId: string,
    input: { payload?: Record<string, unknown>; documentIds?: string[] },
  ) => Promise<WatchFireByHandResult>;
  /**
   * Firings the runtime has recorded for a watch, by definition id — the most
   * recent `limit` of them, oldest first, or all of them when unbounded.
   */
  readonly firings: (
    watchId: string,
    limit?: number,
  ) => {
    seq: number;
    nodeId: string;
    keyHash: string;
    firedAt: string;
    noticedAt: string | null;
    payload: unknown;
    documentIds: string[];
    /** True when an operator fired the watch by hand rather than the runtime. */
    forced: boolean;
  }[];
  /**
   * Titles for the documents a firing was reached through.
   *
   * Resolved here rather than left to the client, which would otherwise fetch
   * each one to render a name — and would render a firing's evidence as a list
   * of opaque ids until it had. Ids the corpus no longer holds are simply
   * absent from the result: a document can be deleted after the firing that
   * cited it, and a ledger that refused to render because of one is worse than
   * one that shows what it still has.
   */
  readonly evidenceDocuments: (
    documentIds: readonly string[],
  ) => { id: string; title: string; sourceId: string }[];
  /** What delivering each firing did, keyed by the firing's own identity. */
  readonly deliveries: (watchId: string) => {
    seq: number;
    nodeId: string;
    keyHash: string;
    kind: string;
    attempted: number | null;
    delivered: number;
    error: string | null;
    /** Why the firing arrived as less than it should have, when it did. */
    degraded: string | null;
    at: string;
  }[];
  /** How many firings, without reading their payloads. */
  readonly firingCount: (watchId: string) => number;
  /**
   * What the workflow woken by each of these firings did, keyed by the firing
   * key the subscriptions hold it under.
   *
   * Optional because the whole watch surface mounts on installs whose
   * subscriptions are not wired, and because a firing that woke nobody has no
   * entry — both read as "nothing was reported", which is what they are.
   *
   * Asked once per page rather than once per row: the answer is one query over
   * a set of keys, and a per-row read would walk the subscription store as many
   * times as the ledger is long.
   */
  readonly workflowOutcomes?: (
    firingKeys: readonly string[],
  ) => ReadonlyMap<string, WatchWorkflowOutcome>;
  /**
   * What the judge was asked about this watch, and what it answered.
   *
   * Newest first. The verdict class alone cannot explain a judge that is
   * deciding wrongly — a proposition asking about the wrong field declines
   * everything, correctly — so this is the read that turns a hypothesis about
   * the wording into a look at it.
   */
  readonly judgeExchanges: (
    watchId: string,
    limit: number,
  ) => {
    nodeId: string;
    key: string;
    subject: string;
    verdict: string;
    prompt: string;
    reply: string;
    ms: number;
    at: string;
  }[];
  /**
   * Everything the runtime is holding for one watch, cut at one moment.
   *
   * Asynchronous because it is read inside the engine's own write turn: the
   * cells, their timers, the parked queue and the cursor all commit together,
   * and a read that did not take a turn could land in the middle of an event
   * and describe a state that is about to be rolled back.
   */
  readonly state: (watchId: string, parkedLimit: number) => Promise<WatchStateResult>;
  /**
   * What every watch is holding, counted, in one turn.
   *
   * A list-shaped read rather than {@link state} per row: that one describes a
   * watch cell by cell, and calling it once per row would read the whole
   * runtime to render a summary line.
   */
  readonly liveState: () => Promise<{ held: Map<string, WatchLiveState>; journalHead: number }>;
  /**
   * Display names for whichever of these ids name a person.
   *
   * An instance key is whatever the DSL extracted — a person id, a thread id, a
   * day stamp — and nothing on it says which is which. So every string
   * component is offered here and whatever comes back is a name; the rest read
   * as themselves.
   */
  readonly people: (ids: readonly string[]) => ReadonlyMap<string, string>;
  readonly judgeSpend: () => JudgeTally;
  readonly judgeReadiness: () => { loadable: boolean; reason: string | null };
  /** Where one watch stands against today's judge allowance. */
  readonly judgeBudget: (watchId: string) => JudgeBudgetPosition;
  readonly latency: () => EvaluationLatency;
  /** Nominations waiting on judge budget. */
  readonly pending: (watchId: string) => number;
  /** Erase the runtime state a removed watch leaves behind. */
  readonly forget: (watchId: string) => void;
  /**
   * Who each watch discloses to, for every watch that discloses to anybody.
   *
   * One read for the whole list rather than one per row: the anchors are a
   * single query and the list is polled. Watches absent from the map wake
   * nobody, which is most of them.
   */
  readonly disclosureSummaries: () => ReadonlyMap<string, WatchDisclosureSummary>;
  /**
   * Everything one watch's page says about the disclosure it carries — the
   * integration woken, what was approved, whether the approval still stands.
   * Null when it wakes nobody.
   */
  readonly disclosure: (watchId: string) => WatchDisclosure | null;
  /**
   * Bring a watch's wake anchor into line with its delivery block: mint one
   * when it wakes an agent, retire it when it stops. Called in the same request
   * that changed the block, so an anchor never outlives the reason it exists.
   */
  readonly setWakeAnchor: (
    watchId: string,
    asker?: { target?: WakeTarget; authoredBy?: WatchV2Author; idempotencyKey?: string },
  ) => Promise<string | null>;
  /** Let a held watch run again. */
  readonly reactivate: (watchId: string) => void;
  /** Why the runtime stopped a watch, or null if it did not. */
  readonly failure: (watchId: string) => WatchFailure | null;
  /** Today's notification allowance and how much of it has been spent. */
  readonly deliveryToday: () => {
    dailyCap: number;
    perWatchDailyCap: number;
    attempted: number;
    /** How many of today's arrived as less than they should have. */
    degraded: number;
  };
  /** How many notifications one watch has attempted today. */
  readonly attemptedToday: (watchId: string) => number;
  /** What it would take to move a watch past what it is stuck on, or null. */
  readonly skipPlan: (watchId: string) => SkipPlan | null;
  /** Carry that out, synchronously, inside the caller's write turn. */
  readonly applySkip: (watchId: string, plan: SkipPlan) => void;
  /**
   * Whose turn it is to write the journal.
   *
   * Every write from a handler here goes through it. Two scheduler tasks write
   * the same file from the main runner, and one of them holds a transaction
   * open across awaits — so a write that did not take a turn would either join
   * that transaction and be rolled back with it, or block the request thread
   * inside SQLite's busy handler.
   */
  readonly writes: WriteLease;
  /** Overridable so a test can drive the gate without an env var. */
  readonly enabled?: () => boolean;
}

/** The note a watch an operator held carries, so a resume can recognise it. */

/**
 * How many records one read may return.
 *
 * Derived from the retention bound rather than repeated: a response ceiling
 * below what the store keeps would cap reads at a number the operator raised
 * retention past, with nothing to say why.
 */
const MAX_TRACE_LIMIT = DEFAULT_RETAINED;

/**
 * What a caller may send.
 *
 * Hand-parsing these was not merely a convention breach. `fromSeq` reached the
 * definition store unchecked, and a JSON string — which any client that
 * stringifies form input produces — bound TEXT into an INTEGER column, came
 * back as a string, and made `stored.fromSeq > 0` false. The watch then woke on
 * the entire corpus, which is the one failure the whole `fromSeq` design exists
 * to prevent.
 */
const addWatchBody = z
  .object({
    dsl: z.unknown(),
    fromSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * `null` is the way to say "nowhere", which is also the default.
 *
 * The old spelling of the notify kind is still accepted and normalised on the
 * way in. An operator has an alias or a note with it in, and the CLI is not
 * the only caller of this route — accepting it here rather than only there is
 * what makes that true for both.
 */
/**
 * The referents an instruction names, as a caller supplies them.
 *
 * Opaque on this side of the boundary too: the gateway carries a key and a
 * value to the woken agent and reads neither. Held to the DSL's own limits,
 * because that is where these end up.
 */
const wakeBindingsBody = z
  .record(z.string().min(1).max(64), z.string().min(1).max(512))
  .refine((value) => Object.keys(value).length <= 32, {
    message: "a wake carries at most 32 bindings",
  });

const setDeliveryBody = z
  .object({
    kind: z.union([
      z.literal("omnesis-notify"),
      z.literal("ios-push").transform(() => "omnesis-notify" as const),
      z.literal("agent-wake"),
      z.null(),
    ]),
    /** Required for `agent-wake`: which agent, and what to tell it. */
    integration: z.string().min(1).max(64).optional(),
    instruction: z.string().min(1).max(8_000).optional(),
    /**
     * The referents the instruction names, when it names any.
     *
     * Bounded here as well as in the DSL rather than left to the validation
     * that follows: this route rewrites a stored definition, and a body the
     * DSL will refuse should be refused before the document is assembled from
     * it rather than as a diagnostic code naming a node.
     */
    bindings: wakeBindingsBody.optional(),
  })
  .strict();

const setStatusBody = z
  .object({
    status: z.enum(["active", "paused"]),
    /**
     * Move past the event a node failure stopped the watch on.
     *
     * Off by default, because skipping an event is the runtime declining to
     * decide about it and that has to be asked for. On, it is the difference
     * between a watch that can be recovered and one whose only escape is being
     * deleted and re-added — which discards its cursor and every firing it has.
     */
    skip: z.boolean().optional(),
  })
  .strict();

/**
 * A `?limit`, clamped to something SQLite will bind.
 *
 * `LIMIT ?` takes an integer: a finite non-integer like `1.5` is inside every
 * range check and still throws a datatype mismatch at the driver, so clamping
 * without coercing turns a query parameter into a 500. A negative binds as "no
 * limit", which is a way to ask for every retained record of every watch.
 */
const readLimit = z.coerce.number().int().min(1).max(MAX_TRACE_LIMIT).catch(200);

/** How many firings the cross-watch ledger returns when nobody says. */
const DEFAULT_CROSS_WATCH_FIRINGS = 200;

/**
 * The ceiling on one page of it.
 *
 * Lower than the per-watch trace's, because a row here carries its evidence,
 * its delivery outcome and its workflow report, and the page is assembled by
 * reading every watch's ledger rather than one.
 */
const MAX_CROSS_WATCH_FIRINGS = 500;

/** A day, which is the window an audit of "what happened" asks about. */
const CROSS_WATCH_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const crossWatchLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_CROSS_WATCH_FIRINGS)
  .catch(DEFAULT_CROSS_WATCH_FIRINGS);

/**
 * A `?since`, as an epoch-millisecond instant.
 *
 * Absent — including a value that is not one — falls back to the default
 * window rather than to the beginning of the ledger: a mistyped parameter that
 * silently read every firing on the install is the expensive way to be wrong.
 */
const crossWatchSince = z.coerce.number().int().nonnegative().optional().catch(undefined);

export function mountWatchV2Routes(app: RouteApp, deps: WatchV2RoutesDeps): void {
  const enabled = deps.enabled ?? experimentalEnabled;

  // First on every route, before auth and before validation: with the feature
  // off these paths do not exist. Read per request rather than captured, so
  // turning the feature off takes effect immediately. Turning it *on* still
  // needs a restart — with the gate off at boot the runtime is never built, so
  // there are no routes to mount.
  const gate: MiddlewareHandler<AppEnv> = async (_c, next) => {
    if (!enabled()) throw new NotFoundError("Not found");
    await next();
  };

  app.use("/admin/watch/*", gate);

  /** Anchored, and matching the bare prefix as well as anything under it. */
  const LEGACY_PREFIX = /^\/admin\/watch-v2(?=\/|$)/;

  // The surface moved from `/admin/watch-v2/*` when the engine stopped being
  // the second of two. A phone already in someone's pocket still asks for the
  // old path, and this API's compatibility promise is additive-within-minor —
  // so the old prefix is rewritten onto the new one rather than 404'd, and the
  // first caller to use it says so once. Remove on the major bump, once no
  // build in the field speaks it.
  let legacyPathWarned = false;
  app.use("/admin/watch-v2/*", async (c) => {
    // Rewrite the path the router MATCHED, not the one in the raw URL. Hono
    // matches on a percent-decoded path; `new URL(...).pathname` is not
    // decoded, so `/admin/watch%2dv2/x` routes here and then rewrites to
    // itself. Re-dispatching an unchanged URL re-enters this middleware — and
    // the target is the top-level app, so every iteration re-runs the whole
    // global chain, unauthenticated, until the stack gives out.
    const rewritten = c.req.path.replace(LEGACY_PREFIX, "/admin/watch");
    if (rewritten === c.req.path) {
      // Fail closed rather than dispatch. A path that matched the legacy
      // pattern but does not start with it is not a request this can answer.
      throw new NotFoundError("Not found");
    }
    // No dot-segment guard here, deliberately: a path containing `..` — encoded
    // or not — is resolved while the URL is parsed, before anything routes, so
    // `/admin/watch-v2/%2e%2e/x` arrives as `/admin/x` and never matches this
    // prefix at all. A check here would be unreachable, and an unreachable
    // check that reads like a security control is worse than none.
    const url = new URL(c.req.url);
    url.pathname = rewritten;
    if (!legacyPathWarned) {
      legacyPathWarned = true;
      log.warn(
        "a client is calling /admin/watch-v2/* — the surface is /admin/watch/* now; update it",
      );
    }
    return app.fetch(new Request(url, c.req.raw), c.env);
  });

  /**
   * What this install declares, and the fingerprint of it.
   *
   * A watch has to carry the fingerprint it was validated against, so whoever
   * writes one — a person by hand, or a compiler — needs to be able to ask what
   * it currently is. Without this the only way to find out is to submit an
   * invalid watch and read the refusal, which is a diagnostic, not an API.
   */
  app.get("/admin/watch/ontology", scope.admin(), async (c) => {
    const snapshot = await buildOntologySnapshot(deps.ontology);
    return c.json({
      fingerprint: snapshot.fingerprint,
      sources: snapshot.sources,
      analyticsTables: snapshot.analyticsTables,
      people: snapshot.people.length,
    });
  });

  /** Every watch the runtime knows, with what it has done and what it holds. */
  app.get("/admin/watch/watches", scope.admin(), async (c) => {
    // Grouped counts for the whole list rather than one snapshot per watch,
    // which would read the entire runtime to render a summary line. Taken in
    // write-lease turns rather than outside one, so a number here cannot
    // disagree with the page a row opens.
    const live = await deps.liveState();
    // Who asked for each watch and who it wakes, for the whole list at once.
    // Both are row indicators rather than sections: a watch is a watch however
    // it was asked for, and splitting the list by that was the seam that made
    // one watch look like two different objects.
    const disclosures = deps.disclosureSummaries();
    const stored = deps.definitions.list();
    const firings = await deps.firingSummary();
    const verdicts = verdictsFor(deps, stored, live.held, firings);
    const watches = stored.map((watch) => ({
      id: watch.id,
      name: watch.name,
      status: watch.status,
      addedAt: watch.addedAt,
      fromSeq: watch.fromSeq,
      note: watch.note,
      // The one line of the DSL a person reads: what the watch is for, in the
      // words of whoever wrote it. The rest of the definition is omitted — it
      // is the largest field by far and this list is polled — but a name alone
      // does not tell a reader what a watch was written to catch.
      request: requestOf(watch.dsl),
      // The compile this watch came out of — an id, so a reader can open the
      // transcript of what the compiler saw before deciding what the watch
      // means. Null for a watch added from a hand-written DSL document.
      compileRunId: watch.compileRunId,
      // Counted rather than listed: a listing that decoded every payload of
      // every watch to report a number would read the whole firing history on
      // each poll of a page that shows none of it.
      firings: firings.get(watch.id)?.count ?? 0,
      /**
       * What the runtime is holding for it right now — the difference between
       * a watch waiting for something to arrive and one already tracking
       * things. Zero for a watch holding nothing, which is a real answer and
       * usually the correct state rather than a fault.
       *
       * `cursorSeq` is how far this watch has been evaluated, against the
       * `journalHead` below: a watch behind the head has work queued it has not
       * done, which from every other field on this row looks exactly like
       * idleness.
       */
      live: liveRow(live.held.get(watch.id)),
      /**
       * Where a firing goes — a notification to the operator's own devices, an
       * agent it wakes, or nowhere at all. The row shows it because two watches
       * with the same name and the same status can still differ in the one way
       * that matters when something fires.
       */
      delivery: deliveryKindOf(watch.dsl),
      /**
       * Whose request this is. Absent for a watch that wakes nobody — there was
       * no approval to record, so the only possible answer is the operator, and
       * saying so on every row would make the distinction invisible on the ones
       * where it is real.
       */
      disclosure: disclosures.get(watch.id) ?? null,
      /**
       * Whether it is any good, which no other field on this row answers.
       *
       * Every one of them describes a watch that is silent because nothing
       * happened exactly as it describes one that is silent because its arm
       * admits nothing, or because the judge refuses everything, or because it
       * wakes an agent through a record that is gone. This says which, with the
       * numbers it decided from.
       */
      verdict: verdicts.get(watch.id) ?? null,
    }));
    return c.json({ watches, journalHead: live.journalHead });
  });

  /**
   * One watch, with the spec it is actually running.
   *
   * The listing omits the DSL on purpose — it is the largest field by far and
   * the list is polled. But the stored definition is the *authority* on what a
   * watch does: it is stored verbatim at add time and never reinterpreted, so a
   * local file is only a copy that may have drifted, and once a compiler writes
   * watches there is no local file at all. Without this the only way to read
   * what an install is running is to open its database.
   */
  app.get("/admin/watch/watches/:id", scope.admin(), async (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    const live = await deps.liveState();
    const verdicts = verdictsFor(deps, [watch], live.held, await deps.firingSummary());
    // What this watch is allowed to say and to whom, from the record that
    // authorised it. It hangs off the watch rather than living on a page of its
    // own: the runtime object and the privacy object are one thing, and giving
    // them separate pages meant neither could be reached from the other.
    // Carried on the watch rather than beside it, so the listing's rows and
    // this one are the same shape and every reader can ask a watch what it
    // discloses without knowing which read produced it.
    return c.json({
      watch: {
        ...watch,
        disclosure: deps.disclosure(watch.id),
        // The same derivation the listing runs, so the row and the page it
        // opens cannot come to describe one watch two ways.
        verdict: verdicts.get(watch.id) ?? null,
      },
    });
  });

  /**
   * Store a watch.
   *
   * Validated against the live ontology first, and refused with its diagnostics
   * if it does not hold — the diagnostics are the compiler's feedback loop and
   * they are just as useful to a person writing a DSL by hand.
   */
  app.post("/admin/watch/watches", scope.admin(), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const body = addWatchBody.safeParse(raw);
    if (!body.success) throw new BadRequestError(body.error.issues[0]?.message ?? "invalid body");
    if (body.data.dsl === undefined) throw new BadRequestError("a `dsl` is required");

    // Adding a watch is not a way to start notifying someone.
    //
    // Delivery is off by default and turning it on is a separate, deliberate
    // act — but a definition is a document, and documents arrive from places
    // that are not an operator typing. A compiler is handed the DSL schema, and
    // a model shown a field named `delivery` will fill it in for a request that
    // merely sounds urgent. Refusing here means the only way a watch acquires
    // the ability to interrupt someone is somebody asking for it by name.
    if (deliveryKindOf(body.data.dsl) !== null) {
      throw new BadRequestError(
        "a watch is added without delivery; turn it on afterwards with `watch deliver <name>`",
      );
    }

    const snapshot = await buildOntologySnapshot(deps.ontology);
    const result = validateWatch(body.data.dsl, Ontology.parse(snapshot));
    if (!result.valid) {
      return c.json(
        {
          error: "watch does not validate against this install's ontology",
          fingerprint: snapshot.fingerprint,
          diagnostics: result.diagnostics,
        },
        400,
      );
    }

    const parsed = watchDslSchema.parse(body.data.dsl);
    // The head, unless the caller asked for the past. A watch added today is a
    // claim about what happens next; one that woke on the whole corpus would be
    // answering a question nobody asked.
    const fromSeq = body.data.fromSeq ?? deps.journal.head();
    const stored = {
      id: randomUUID(),
      name: parsed.watch.name,
      status: "active" as const,
      dsl: body.data.dsl,
      addedAt: new Date().toISOString(),
      fromSeq,
      note: null,
      // Nothing was compiled: the caller handed over a DSL document. There is
      // no reasoning to link to, and inventing a run would put an empty
      // transcript behind a link that promises one.
      compileRunId: null,
      // Nor is there an asker's key: this is an operator handing over a
      // document, which is one act rather than a request that can be retried.
      requestKey: null,
      // Recorded by the first evaluation that passes, not here: the surface a
      // watch is measured against is the one it was last known to run against.
      referenceDigest: null,
    };
    // Through the lease, like every other write to this file. A definition
    // store sharing the runtime's connection would otherwise join whatever
    // transaction the engine has open and be rolled back with it — after this
    // handler had answered 201.
    await deps.writes.run(() => Promise.resolve(deps.definitions.put(stored)));
    log.info(`watch ${stored.name} added, watching from seq ${fromSeq}`);
    return c.json({ watch: stored }, 201);
  });

  /**
   * Refuse to start a compile the gateway will not be here to finish.
   *
   * A compile runs for minutes and a deploy takes seconds, so a restart landing
   * mid-compile is ordinary rather than exceptional. Accepting one anyway ends
   * as a dropped connection, and a dropped connection is what an agent reads as
   * a broken feature — it then retries with a rewording, which carries a
   * different idempotency key by design, and one intent becomes several
   * watches. Saying "restarting, ask again" costs nothing and is true.
   */
  function refuseWhileRestarting(routeDeps: WatchV2RoutesDeps): void {
    if (!routeDeps.compiles.open) {
      throw new ServiceUnavailableError(
        "This gateway is restarting and did not start compiling. Ask again in a moment.",
      );
    }

    /**
     * Turn a sentence into a watch, and wire what it should do when it fires.
     *
     * The path an agent takes. Everything a watch needs is here in one request
     * because the caller has one thing to say — "when X happens, do Y" — and
     * splitting it across compile, install and arm would leave a watch that
     * matches and tells nobody if the second call never came.
     *
     * `request` is the condition, in the caller's own words, and the compiler
     * turns it into a validated watch or refuses with reasons. `instruction` is
     * what the woken agent is told to do, and it is carried verbatim: the watch
     * decides *when*, deterministically, and the instruction decides *what*, in
     * prose. Whom to wake is the **authenticated** caller, never a value from
     * the body.
     */
  }

  app.post("/admin/watch/compile", scope.admin(), async (c) => {
    refuseWhileRestarting(deps);
    const body = compileBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      // The parser's own complaint, not a fixed sentence: a body naming
      // `compileOnly: false` or an integration name the DSL refuses is well
      // formed in every way the fixed sentence describes, and telling its
      // sender that `request` was expected sends them to look at a field they
      // supplied correctly.
      throw new BadRequestError(
        body.error.issues[0]?.message ??
          "expected `request`, and `instruction` when waking an agent",
      );
    }
    const asked = {
      request: body.data.request,
      ...(body.data.instruction === undefined
        ? {}
        : {
            delivery: {
              kind: "agent-wake" as const,
              wake: { kind: "harness" as const, name: body.data.integrationName },
              instruction: body.data.instruction,
              // The preview and the install take the same document, so what a
              // caller sees before arming is the wake that will be armed —
              // referents included.
              ...(body.data.bindings === undefined ? {} : { bindings: body.data.bindings }),
            },
          }),
      // The operator wrote the delivery block, so the record self-approves:
      // naming the agent and the instruction *is* the decision an approval
      // would ask them to make again.
      authoredBy: "operator" as const,
    };
    if (body.data.compileOnly === true) {
      const preview = await deps.preview({
        ...asked,
        ...(body.data.withoutBacktest === true ? { withoutBacktest: true } : {}),
      });
      if (preview.status === "no-compiler") {
        throw new ServiceUnavailableError(
          "This gateway has no model assigned for compiling watches.",
        );
      }
      if (preview.status === "timed-out") {
        throw new ServiceUnavailableError(
          "The model did not finish compiling this watch in time. Try again.",
        );
      }
      if (preview.status === "refused") {
        // The same 422 the installing path answers, for the same reason: a
        // refusal is an answer. Two shapes for one outcome would make a
        // measurement of refusals a measurement of which flag was set.
        return c.json({ compiled: false, codes: preview.codes, reasons: preview.reasons }, 422);
      }
      if (preview.status !== "compiled") return assertNever(preview);
      // 200 rather than 201: nothing was created. The document is what an
      // install would have written down, and `installed` says plainly that it
      // did not — a caller reading `compiled: true` alone would have no way to
      // tell this answer from the one above it.
      return c.json({
        compiled: true,
        installed: false,
        dsl: preview.document,
        interpretation: preview.interpretation,
        diagnostics: preview.diagnostics,
        // What it would have done over the window the replay covered, which
        // the summary states beside every count. An asker deciding whether to
        // run this needs it whether or not it moved the compile: a watch that
        // would never have fired is the one worth not installing, and nothing
        // else in this answer can say so. Null on a request that asked to skip
        // the replay, and on an install with no history to replay against.
        backtest: preview.backtest,
        compileRunId: preview.compileRunId,
      });
    }
    const result = await deps.author(asked);
    if (result.status === "no-compiler") {
      throw new ServiceUnavailableError(
        "This gateway has no model assigned for compiling watches.",
      );
    }
    if (result.status === "timed-out") {
      throw new ServiceUnavailableError(
        "The model did not finish compiling this watch in time. Try again.",
      );
    }
    if (result.status === "refused") {
      // A refusal is an answer, not a failure: the compiler declined to write
      // a watch it could not justify, and the reasons are what the caller
      // needs to ask a better question.
      //
      // The model's own words go out here, unlike on the integration route.
      // This is the admin surface: whoever holds this token owns the corpus the
      // compiler read, so a reason that mentions what it found is telling them
      // about their own data, and it is the sentence that makes the refusal
      // useful. The codes ride along so both surfaces speak one vocabulary.
      return c.json({ compiled: false, codes: result.codes, reasons: result.reasons }, 422);
    }
    if (result.status === "unarmed") {
      // The watch exists and is held, so nothing is evaluating into a wake
      // nobody receives — but it is not a create that worked, and answering
      // 201 would tell the operator a watch is running that is not.
      throw new ServiceUnavailableError(
        `Watch ${result.watch.name} was written and installed, and the record that wakes the agent could not be created. It is held; resume it to try again.`,
      );
    }
    if (result.status === "conflict") {
      // A collision rather than a fault: the request names a watch the key it
      // carries does not belong to, or another request carrying that key
      // installed one first. Answering 500 would tell the caller to retry
      // something that cannot settle differently until they change it.
      throw new ConflictError(result.because);
    }
    if (result.status !== "installed") return assertNever(result);
    return c.json({ compiled: true, watch: result.watch }, 201);
  });

  /**
   * Remove a watch, and everything the runtime holds for it.
   *
   * The state goes with the definition. Leaving it would let a watch added
   * afterwards inherit a cursor, a record of documents already looked at, and
   * firings belonging to something the operator deleted.
   */
  app.delete("/admin/watch/watches/:id", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const watch = deps.definitions.get(id);
    if (!watch) throw new NotFoundError("no such watch");
    // One turn for all three, so a removal cannot be observed half-done — and
    // so `forget`, which writes the runtime's own state tables from an HTTP
    // handler, cannot land inside an evaluation's open transaction.
    const removed = await deps.writes.run(() => {
      const gone = deps.definitions.remove(id);
      if (gone) {
        deps.forget(id);
        deps.traces.forget(id);
      }
      return Promise.resolve(gone);
    });
    // Removing a watch retires its anchor with it. The anchor's firing history
    // survives — revoked rather than deleted — because what a watch said still
    // happened, and the egress ledger points at those firings.
    if (!removed) throw new NotFoundError("no such watch");
    // The watch is gone from the store, so this reads "wakes nobody" and
    // retires whatever it held.
    await deps.setWakeAnchor(id);
    return c.json({ removed: true });
  });

  /**
   * Re-stamp every watch against the ontology as it is now.
   *
   * The drift alarm is deliberately blunt: a watch records the fingerprint it
   * validated against, and any move pauses it. That is right when the move
   * means a watch's question no longer parses — and wrong in the ordinary case,
   * where the install simply learned to describe more of itself and every watch
   * still means exactly what it meant. Without a bulk path, the only way back
   * from a legitimate drift is to delete each watch and add it again, which
   * restarts it at the head and discards the history that made it worth
   * keeping.
   *
   * Re-stamping is not a way to make a stale watch pass. Each definition is
   * re-validated against the new ontology first, and only what still holds is
   * given the new fingerprint; anything that no longer validates keeps its old
   * one, stays paused, and comes back in the response with its diagnostics. A
   * bulk operation that quietly blessed a watch whose source had disappeared
   * would be worse than no bulk operation at all — the fingerprint would say
   * "checked against this world" about a world it had never been checked
   * against.
   *
   * Retired watches are left alone: they are finished, not held.
   */
  app.post("/admin/watch/restamp", scope.admin(), async (c) => {
    const snapshot = await buildOntologySnapshot(deps.ontology);
    const ontology = Ontology.parse(snapshot);
    const watches = deps.definitions.list();

    const restamped: { id: string; name: string; resumed: boolean }[] = [];
    // `wasActive` because a refusal means something different for a running
    // watch: it keeps running until the next evaluation pauses it, so the reader
    // is looking at one about to stop rather than one already held.
    const refused: {
      id: string;
      name: string;
      wasActive: boolean;
      diagnostics: readonly unknown[];
    }[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];

    for (const watch of watches) {
      if (watch.status === "retired") {
        skipped.push({ id: watch.id, name: watch.name, reason: "retired" });
        continue;
      }
      // One unreadable definition must not take the whole pass down. The store
      // deliberately tolerates a row this build cannot decode rather than
      // failing the subsystem, and a bulk operation over those rows has to be
      // at least as tolerant: a throw here would abandon the loop with some
      // watches re-stamped, some not, and nothing said about which.
      try {
        // Validate the watch as it *would be* after re-stamping, not as it is.
        // The fingerprint is itself one of the things `validateWatch` checks,
        // so validating the stored document would fail every time on the very
        // mismatch this exists to resolve — and every watch would come back
        // refused, for the one reason that is not a reason to refuse.
        const candidate = withFingerprint(watch.dsl, snapshot.fingerprint);
        // Through a recorder, so the approval sticks. Re-stamping is the
        // operator saying "yes, I have looked at this surface"; without
        // recording what they looked at, the runtime would still be holding
        // the surface from before the change and would pause the watch again
        // at the next unrelated drift, for a move the operator had approved.
        const reading = new RecordingOntology(ontology);
        const result = validateWatch(candidate, reading);
        if (!result.valid) {
          refused.push({
            id: watch.id,
            name: watch.name,
            wasActive: watch.status === "active",
            diagnostics: result.diagnostics,
          });
          continue;
        }
        const resumed = await deps.writes.run(() => {
          // Re-read inside the lease turn. The list was taken before the loop
          // began and the loop yields the lease once per watch — long enough
          // for the engine to retire one that fired, or for it to be removed.
          // Acting on the stale row would resurrect a `once_ever` watch that
          // had already said its piece, which is the one thing the
          // single-watch resume refuses outright.
          const now = deps.definitions.get(watch.id);
          if (!now || now.status === "retired") return Promise.resolve(null);
          deps.definitions.restamp(watch.id, snapshot.fingerprint);
          deps.definitions.recordReferenceDigest(watch.id, reading.digest());
          const wasHeld = now.status !== "active";
          // Read before the note is cleared: it is the only record of why this
          // watch was stopped, and resuming erases it.
          const wasUnarmed = isUnarmedNote(now.note);
          if (wasHeld) {
            // Both halves, for the same reason the resume path does it: a
            // definition marked active while the engine still holds its
            // runtime flag down is a watch that looks like it is running and
            // is not.
            deps.reactivate(watch.id);
            deps.definitions.setStatus(watch.id, "active", null);
          }
          return Promise.resolve({ wasHeld, wasUnarmed });
        });
        if (resumed === null) {
          skipped.push({ id: watch.id, name: watch.name, reason: "changed while re-stamping" });
          continue;
        }
        // A watch held because its wake record could not be minted has just
        // been resumed and its note cleared, and re-stamping did nothing about
        // the arming — the fingerprint was never why it was stopped. Without
        // this it goes back to active with no record, evaluating into nothing,
        // and the only evidence of why has been erased. The single-watch
        // resume closes exactly this; a bulk one must not be the way around it.
        const stillUnarmed =
          resumed.wasUnarmed && (await rearmAfterResume(deps, watch.id, watch.name, watch.dsl));
        restamped.push({
          id: watch.id,
          name: watch.name,
          // What it actually is now, not what this pass tried to do. A watch
          // held again is not one the operator can treat as running.
          resumed: resumed.wasHeld && !stillUnarmed,
        });
      } catch (error) {
        refused.push({
          id: watch.id,
          name: watch.name,
          wasActive: watch.status === "active",
          diagnostics: [{ code: "UNREADABLE", message: (error as Error).message }],
        });
      }
    }

    log.info(
      `restamp to ${snapshot.fingerprint}: ${restamped.length} re-stamped ` +
        `(${restamped.filter((w) => w.resumed).length} resumed), ${refused.length} refused, ` +
        `${skipped.length} skipped`,
    );
    return c.json({ fingerprint: snapshot.fingerprint, restamped, refused, skipped });
  });

  /**
   * Hold a watch, or let it run again.
   *
   * The runtime pauses a watch on its own — one of its nodes threw, or its
   * ontology moved — and without this there is no way back: the status is set
   * by something the operator cannot reach, and the only recovery is to delete
   * the watch and add it again, which starts it at the head and loses its
   * history.
   *
   * A resume re-validates first. Without that, a watch whose ontology moved
   * comes back active, is re-validated by the very next evaluation, and is
   * paused again a few seconds later — so the operator sees a resume that
   * worked and a watch that is stopped, and has to guess which is true. The
   * refusal below names the diagnostics instead. A drifted *fingerprint* is
   * the common case and wants `watch restamp`, not this.
   *
   * Nothing about a resume touches the watch's history: the cursor, its live
   * instances and its firings are exactly where they were. `skip` is the one
   * thing that moves the cursor, by one event, on purpose and in the trace.
   */
  app.patch("/admin/watch/watches/:id", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const watch = deps.definitions.get(id);
    if (!watch) throw new NotFoundError("no such watch");

    const body = setStatusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      throw new BadRequestError(
        "expected `status` of 'active' or 'paused', with an optional boolean `skip`",
      );
    }
    const status = body.data.status;
    const skip = body.data.skip ?? false;

    if (status === "paused" && skip) {
      throw new BadRequestError("`skip` only applies to a resume");
    }

    // A retired watch is finished, not held: `once_ever` got its answer, or the
    // horizon passed. Re-activating it would let a watch that has already said
    // its piece say it again about whatever arrived since.
    if (status === "active" && watch.status === "retired") {
      throw new BadRequestError(
        `watch ${watch.name} is retired (${watch.note ?? "finished"}); add it again to ask the question afresh`,
      );
    }

    // Decided before anything is written, so a refusal leaves the watch exactly
    // as it was and the whole resume lands in one turn or not at all.
    let plan: SkipPlan | null = null;
    if (status === "active") {
      const ontology = Ontology.parse(await buildOntologySnapshot(deps.ontology));
      const check = validateWatch(watch.dsl, ontology);
      if (!check.valid) {
        const codes = check.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => d.code)
          .join(", ");
        throw new BadRequestError(
          `watch ${watch.name} does not validate against this install (${codes}); ` +
            `the next evaluation would pause it again`,
        );
      }
      if (skip) {
        plan = deps.skipPlan(id);
        if (plan === null) {
          throw new BadRequestError(
            `watch ${watch.name} has nothing a skip can move it past; resume it without \`skip\``,
          );
        }
      }
    }

    await deps.writes.run(() => {
      if (status === "active") {
        // One turn for all of it. A skip applied in its own turn could land
        // while the status change that follows it fails, leaving the watch
        // stopped and the ledger claiming an operator moved it on.
        if (plan) deps.applySkip(id, plan);
        // Both halves, or a watch the engine deactivated comes back with its
        // definition active and its runtime flag still down — visibly running
        // and silently doing nothing.
        deps.reactivate(id);
        deps.definitions.setStatus(id, "active", null);
      } else {
        deps.definitions.setStatus(id, "paused", HELD_BY_OPERATOR);
      }
      return Promise.resolve();
    });
    // A watch held because its wake record could not be minted is resumed to
    // try again — the note says so — and the arming is what has to be retried.
    if (status === "active" && isUnarmedNote(watch.note)) {
      await rearmAfterResume(deps, id, watch.name, watch.dsl);
    }
    log.info(
      `watch ${watch.name} ${status === "active" ? "resumed" : "held"} by an operator` +
        (plan === null ? "" : ` (skipped ${plan.what} ${plan.seq})`),
    );
    // Read back rather than assembled: a hand-built response can report a note
    // the store does not hold, and the next list would disagree with it.
    return c.json({
      watch: deps.definitions.get(id),
      skipped: plan === null ? null : { what: plan.what, seq: plan.seq },
    });
  });

  /**
   * Turn delivery on or off for an installed watch.
   *
   * Its own route rather than a field on the status PATCH, because they are
   * different decisions: holding a watch is about whether it should be running
   * at all, and this is about whether what it says is worth interrupting
   * someone for. An operator does one of them far more often than the other.
   *
   * The rewritten definition is validated before it is stored, so a build that
   * does not understand the delivery kind refuses rather than persisting
   * something the runtime will pause on next tick.
   */
  app.put("/admin/watch/watches/:id/delivery", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const watch = deps.definitions.get(id);
    if (!watch) throw new NotFoundError("no such watch");

    const body = setDeliveryBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      throw new BadRequestError(
        "expected `kind` of 'omnesis-notify' or 'agent-wake', or null to deliver nowhere",
      );
    }
    if (body.data.kind === "agent-wake" && (!body.data.integration || !body.data.instruction)) {
      throw new BadRequestError(
        "waking an agent needs `integration` (which one) and `instruction` (what to tell it)",
      );
    }
    // Refused rather than dropped. Only an instruction has referents, and a
    // caller who sent some believes the delivery carries them — accepting the
    // request and storing a block without them is the silent half-honoured
    // write this surface must not perform.
    if (body.data.kind !== "agent-wake" && body.data.bindings !== undefined) {
      throw new BadRequestError("`bindings` belong to an `agent-wake`; nothing else carries them");
    }
    const delivery =
      body.data.kind === null
        ? null
        : body.data.kind === "agent-wake"
          ? {
              kind: "agent-wake" as const,
              integration: body.data.integration ?? "",
              instruction: body.data.instruction ?? "",
              // An empty map is left out rather than written: the definition
              // an operator reads back should say the instruction stands on
              // its own, not carry a field that names nothing.
              ...(body.data.bindings === undefined || Object.keys(body.data.bindings).length === 0
                ? {}
                : { bindings: body.data.bindings }),
            }
          : { kind: "omnesis-notify" as const };

    const ontology = Ontology.parse(await buildOntologySnapshot(deps.ontology));
    const proposed = withDelivery(watch.dsl, delivery);
    // Recorded for the same reason the re-stamp route records: this rewrites
    // the stored document, and a surface digest describing the document that
    // was there before would be answering a later drift about a watch that no
    // longer exists.
    const reading = new RecordingOntology(ontology);
    const check = validateWatch(proposed, reading);
    if (!check.valid) {
      throw new BadRequestError(
        `watch ${watch.name} would not validate with that delivery (` +
          check.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => d.code)
            .join(", ") +
          ")",
      );
    }

    const applied = await deps.writes.run(() => {
      // One turn for both, so no window exists in which the document is the
      // new one and the recorded surface is the old one's.
      const wrote = deps.definitions.setDelivery(id, delivery);
      if (wrote) deps.definitions.recordReferenceDigest(id, reading.digest());
      return Promise.resolve(wrote);
    });
    if (!applied) throw new NotFoundError("no such watch");
    // The anchor's lifetime is the delivery block's, in the same request that
    // changed it. An anchor whose watch no longer wakes anything is a record
    // nobody authored and nobody can explain, and the only way to be sure one
    // never exists is to retire it here rather than sweep for it later.
    // Set from the operator's own surface, so it self-approves for the same
    // reason a compiled one does. Whom it wakes and with what instruction come
    // from the definition just written, not from this request's copy of them:
    // two operators changing one watch's delivery at once would otherwise be
    // able to leave the record carrying the other request's words.
    await deps.setWakeAnchor(id, { authoredBy: "operator" });
    log.info(
      `watch ${watch.name} will now deliver ${delivery === null ? "nowhere" : delivery.kind}`,
    );
    // Read back rather than assembled, and 404 if it went in the meantime — a
    // response describing a watch that no longer exists is worse than a miss.
    const after = deps.definitions.get(id);
    if (!after) throw new NotFoundError("no such watch");
    return c.json({ watch: after });
  });

  /** What a watch has said. */
  /**
   * What the judge was asked, and what it said back.
   *
   * Admin-scoped rather than read-scoped, and deliberately: a prompt quotes
   * the document it is about, so this is the most corpus-bearing thing the
   * watch surface serves.
   */
  app.get("/admin/watch/watches/:id/judge-exchanges", scope.admin(), (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    // Bounded low by default: an exchange is a prompt and a reply rather than
    // a line, and the question this answers is about the recent ones.
    const limit = readLimit.parse(c.req.query("limit") ?? 20);
    return c.json({
      watch: { id: watch.id, name: watch.name },
      exchanges: deps.judgeExchanges(watch.id, limit),
    });
  });

  app.get("/admin/watch/watches/:id/firings", scope.admin(), (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    // Bounded like the trace, and for the same reason: every firing carries a
    // decoded payload, and a watch that has run for a week has a great many.
    const limit = readLimit.parse(c.req.query("limit") ?? 200);
    // Each firing carries what delivering it did, so "it fired but I was never
    // told" is answerable from one read rather than a log the operator does
    // not have. Absent for a watch that delivers nowhere, which is most.
    const outcomes = new Map(
      deps.deliveries(watch.id).map((d) => [`${d.seq}:${d.nodeId}:${d.keyHash}`, d]),
    );
    // Bounded at the store: the ledger of a watch that has run for a year is
    // decoded a payload at a time, and this route keeps a page of it.
    const page = deps.firings(watch.id, limit);
    // One lookup for the page rather than one per firing: a watch on a joining
    // condition cites the same document from several firings, and a ledger
    // that asked separately each time would read the corpus once per row.
    const titles = new Map(
      deps
        .evidenceDocuments([...new Set(page.flatMap((firing) => firing.documentIds))])
        .map((document) => [document.id, document]),
    );
    const firings = page.map(({ nodeId, keyHash, documentIds, ...firing }) => {
      // `forced` rides along in `...firing`: a firing an operator asked for
      // must never read as something the watch caught.
      const outcome = outcomes.get(`${firing.seq}:${nodeId}:${keyHash}`);
      return {
        ...firing,
        // What the runtime read to decide, in the order it collected them.
        // Empty for a firing with nothing behind it — a clock reaching a
        // boundary, a row arriving, a deadline passing — and for one recorded
        // before the journal kept them.
        documents: documentIds.flatMap((id) => {
          const document = titles.get(id);
          return document ? [document] : [];
        }),
        ...(outcome === undefined
          ? {}
          : {
              delivery: {
                // Normalised, like the report's. The journal column records
                // whatever the DSL said at firing time, so a watch's history
                // can hold both spellings of the notify kind — but a reader
                // comparing two admin surfaces must not be shown two names for
                // one channel.
                kind: isNotifyDeliveryKind(outcome.kind) ? CURRENT_NOTIFY_KIND : outcome.kind,
                delivered: outcome.delivered,
                ...(outcome.attempted === null ? {} : { attempted: outcome.attempted }),
                ...(outcome.error === null ? {} : { error: outcome.error }),
                // Present only when something was lost. A delivered banner
                // that reads `delivered: 1` and nothing else is the good one;
                // this is what distinguishes it from the plain fallback.
                ...(outcome.degraded === null ? {} : { degraded: outcome.degraded }),
                at: outcome.at,
              },
            }),
      };
    });
    return c.json({ watch: watch.name, firings });
  });

  /**
   * Every watch's recent firings in one read, newest first.
   *
   * The per-watch ledger answers "what did this watch do"; this answers "what
   * did the install do", which is the question an audit of the wake chain
   * starts from — and one that cannot be asked of the per-watch route without
   * knowing in advance which watch to ask about, which is exactly what an audit
   * does not know.
   *
   * Each row carries the whole chain for that firing: what the runtime saw,
   * what delivering it did, and — when the subscriptions can say — what the
   * woken workflow reported back. A firing that fired, delivered and did
   * nothing is otherwise indistinguishable from one that fired, delivered and
   * completed, and the difference is the only thing worth auditing.
   */
  app.get("/admin/watch/firings", scope.admin(), (c) => {
    const limit = crossWatchLimit.parse(c.req.query("limit") ?? DEFAULT_CROSS_WATCH_FIRINGS);
    // A window rather than the whole ledger. Every firing carries a decoded
    // payload and its evidence, and an install with a hundred watches has a
    // great many of both; a day is the span an audit of "what happened" asks
    // about, and a caller who wants more says so.
    const since =
      crossWatchSince.parse(c.req.query("since")) ?? Date.now() - CROSS_WATCH_DEFAULT_WINDOW_MS;
    const collected: {
      watchId: string;
      watchName: string;
      nodeId: string;
      keyHash: string;
      at: number;
      firing: ReturnType<WatchV2RoutesDeps["firings"]>[number];
      delivery: ReturnType<WatchV2RoutesDeps["deliveries"]>[number] | undefined;
    }[] = [];
    for (const watch of deps.definitions.list()) {
      // Bounded per watch as well as overall: the page can only hold `limit`
      // rows, so no watch can contribute more than that however long it has
      // been running.
      const page = deps.firings(watch.id, limit).filter((firing) => {
        const at = Date.parse(firing.firedAt);
        // A timestamp this cannot read is kept rather than dropped. It is a
        // firing that happened, and an audit that silently omits the rows it
        // could not sort is the wrong half of a window.
        return !Number.isFinite(at) || at >= since;
      });
      // Read after the window has been applied, and only for a watch that
      // contributed to it. A watch's delivery ledger is returned whole, so
      // reading one per watch regardless would make a quiet install's page
      // cost the same as a busy one's.
      if (page.length === 0) continue;
      const outcomes = new Map(
        deps.deliveries(watch.id).map((d) => [`${d.seq}:${d.nodeId}:${d.keyHash}`, d]),
      );
      for (const firing of page) {
        const at = Date.parse(firing.firedAt);
        collected.push({
          watchId: watch.id,
          watchName: watch.name,
          nodeId: firing.nodeId,
          keyHash: firing.keyHash,
          at: Number.isFinite(at) ? at : 0,
          firing,
          delivery: outcomes.get(`${firing.seq}:${firing.nodeId}:${firing.keyHash}`),
        });
      }
    }
    // Newest first across every watch, and `seq` breaks a tie: two firings can
    // share a millisecond, and an unstable order would make two reads of one
    // unchanged install disagree about what happened.
    collected.sort((a, b) => b.at - a.at || b.firing.seq - a.firing.seq);
    const page = collected.slice(0, limit);
    const titles = new Map(
      deps
        .evidenceDocuments([...new Set(page.flatMap((row) => row.firing.documentIds))])
        .map((document) => [document.id, document]),
    );
    // One lookup for the page. Absent on an install whose subscriptions are not
    // wired, and empty for firings that woke nobody — in both cases the row
    // simply carries no `workflow`, which reads as "nothing was reported"
    // rather than as a report of nothing.
    const workflows =
      deps.workflowOutcomes?.(
        page.map((row) =>
          watchV2FiringKey({
            watchId: row.watchId,
            seq: row.firing.seq,
            nodeId: row.nodeId,
            keyHash: row.keyHash,
          }),
        ),
      ) ?? null;
    const firings = page.map((row) => {
      const { nodeId, keyHash, documentIds, ...firing } = row.firing;
      const workflow = workflows?.get(
        watchV2FiringKey({ watchId: row.watchId, seq: firing.seq, nodeId, keyHash }),
      );
      return {
        watchId: row.watchId,
        watchName: row.watchName,
        ...firing,
        documents: documentIds.flatMap((id) => {
          const document = titles.get(id);
          return document ? [document] : [];
        }),
        ...(row.delivery === undefined
          ? {}
          : {
              delivery: {
                // Normalised like the per-watch route's, so a reader comparing
                // the two surfaces is not shown two names for one channel.
                kind: isNotifyDeliveryKind(row.delivery.kind)
                  ? CURRENT_NOTIFY_KIND
                  : row.delivery.kind,
                delivered: row.delivery.delivered,
                ...(row.delivery.attempted === null ? {} : { attempted: row.delivery.attempted }),
                ...(row.delivery.error === null ? {} : { error: row.delivery.error }),
                ...(row.delivery.degraded === null ? {} : { degraded: row.delivery.degraded }),
                at: row.delivery.at,
              },
            }),
        ...(workflow === undefined
          ? {}
          : {
              workflow: {
                subscriptionId: workflow.subscriptionId,
                firingId: workflow.firingId,
                deliveryStatus: workflow.deliveryStatus,
                acceptedAt: workflow.acceptedAt,
                localRunId: workflow.localRunId,
                // Absent rather than null. A run that has not said what it did
                // is not a run that reported doing nothing, and those are the
                // two states this whole read exists to tell apart.
                ...(workflow.outcome === null ? {} : { outcome: workflow.outcome }),
              },
            }),
      };
    });
    return c.json({ firings });
  });

  /**
   * What it is holding right now.
   *
   * The trace says what happened; this says what is still true. A stateful node
   * keeps a cell per key from the arm that created it until the fire, cancel or
   * deadline that ends it, and between those two moments the only account of a
   * watch's behaviour is what those cells contain: which arms have arrived,
   * what a wait is counting down to, which timers will go off unprompted.
   *
   * One consistent read, taken inside the engine's own write turn, and
   * refresh-on-demand rather than streamed — so everything in one response
   * describes the same moment, stated in `asOf`.
   */
  app.get("/admin/watch/watches/:id/state", scope.admin(), async (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    // Bounds the parked queue and the trace scan behind it. A watch whose judge
    // has been over budget for a week has a long queue, and the classes are
    // read off the trace, which is retained to the same order of magnitude.
    const limit = readLimit.parse(c.req.query("limit") ?? 200);
    const result = await deps.state(watch.id, limit);
    // The definition was there a line ago, so this is the runtime disagreeing
    // rather than a caller naming a watch that does not exist.
    if (result.outcome === "no-watch") throw new NotFoundError("no such watch");
    if (result.outcome === "unreadable") {
      throw new BadRequestError(`this build cannot read that watch: ${result.why}`);
    }
    return c.json(
      stateResponse({
        watch: { id: watch.id, name: watch.name },
        snapshot: result.snapshot,
        journalHead: result.journalHead,
        atMs: result.atMs,
        names: deps.people(keyComponentCandidates(result.snapshot)),
        // What a half-satisfied join or sequence arrived on: the moment, from
        // the journal, and the document, from the corpus. A cell knows the
        // sequence and the document id and can render neither on its own.
        arrivals: resolveArrivals(deps, result.snapshot),
        // Only to classify a parked nomination, so a watch with none reads no
        // trace at all — which is most of them, on every refresh.
        traces: result.snapshot.parked.length === 0 ? [] : deps.traces.recent(watch.id, limit),
        judge: deps.judgeBudget(watch.id),
      }),
    );
  });

  /** Why it said it — or why it did not. */
  app.get("/admin/watch/watches/:id/trace", scope.admin(), (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    return c.json({
      watch: watch.name,
      records: deps.traces.recent(watch.id, readLimit.parse(c.req.query("limit") ?? 200)),
      // Whether there is an exchange to read behind these records. A judge
      // decision leaves no transition of its own — it surfaces as the node
      // firing or holding — so the trace cannot be read to find out, and a
      // reader who is not told simply does not know the exchanges exist.
      judgeExchanges: deps.judgeExchanges(watch.id, 1).length > 0,
    });
  });

  /**
   * The shadow period in one response.
   *
   * Written to be read after a week rather than during one: per-watch counts,
   * what the judge spent and put off, and where the journal has reached. A
   * review that has to be assembled from four endpoints is a review nobody
   * does.
   */
  /**
   * What a watch's recall arm would have nominated, over documents already
   * held.
   *
   * A watch watches the future, so a threshold that is a little too high is
   * invisible: the watch is silent, and silence is what a correct watch over a
   * quiet month looks like too. This asks the question against the past, where
   * there is an answer today.
   *
   * Counts and scores only — never the documents. A probe that returned them
   * would be a search endpoint wearing a diagnostic's clothes.
   */
  app.post("/admin/watch/watches/:id/probe", scope.admin(), async (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    const body = probeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new BadRequestError("windowDays and limit must be positive numbers");
    // A probe that cannot score would report every document at zero and call
    // the threshold far too high — a confident wrong answer, which is worse
    // than no answer for a diagnostic.
    if (!deps.probe.canScore()) {
      throw new ServiceUnavailableError(
        "This gateway cannot score a recall arm: assign an embedder model and try again.",
      );
    }
    const arms = semanticArms(watch.dsl);
    const results = [];
    for (const arm of arms) {
      results.push(
        await probeArm(deps.probe, arm, {
          windowDays: body.data.windowDays,
          limit: body.data.limit,
        }),
      );
    }
    return c.json({ watch: { id: watch.id, name: watch.name }, arms: results });
  });

  /**
   * Would this watch catch anything at all?
   *
   * Un-keyed on purpose: the question is asked before the watch is stored, and
   * a probe that required storing it first would answer about a watch that is
   * already running. Nothing is written — no cursor, no instance, no firing —
   * and no model is asked, so it spends nothing.
   *
   * The samples and diagnostics quote the runtime's own words about documents
   * in this corpus. That is the same class of data as a trace, and this route
   * is admin-only for the same reason.
   */
  app.post("/admin/watch/preflight", scope.admin(), async (c) => {
    const body = preflightBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new BadRequestError(body.error.issues[0]?.message ?? "invalid body");
    if (deliveryKindOf(body.data.dsl) !== null) {
      throw new BadRequestError(
        "a candidate is tried without delivery; turn it on after installing it with `watch deliver`",
      );
    }
    const parsed = watchDslSchema.safeParse(body.data.dsl);
    if (!parsed.success) {
      throw new BadRequestError(`that is not a watch: ${parsed.error.issues[0]?.message ?? ""}`);
    }
    if (!deps.preflight) {
      throw new ServiceUnavailableError("This gateway has no running watch engine to probe with.");
    }
    const result = await deps.preflight(parsed.data.watch, {
      ...(body.data.events === undefined ? {} : { events: body.data.events }),
      ...(body.data.days === undefined ? {} : { days: body.data.days }),
    });
    if (result.outcome === "refused") {
      const refusal = result.refusal;
      if (refusal.reason === "cannot-score") {
        throw new ServiceUnavailableError(
          "This gateway cannot score a recall arm: assign an embedder model and try again.",
        );
      }
      if (refusal.reason === "empty-journal") {
        throw new ServiceUnavailableError(
          "The watch journal is empty, so there is nothing to try this against yet.",
        );
      }
      if (refusal.reason === "no-runtime") {
        throw new ServiceUnavailableError("This gateway has no running watch engine to try with.");
      }
      if (refusal.reason === "empty-window") {
        // Deliberately not the empty-journal sentence. The journal has plenty;
        // this window has none, and the operator's next move is to widen the
        // span or find out why nothing has arrived — not to wonder where their
        // journal went.
        throw new ServiceUnavailableError(
          `Nothing was observed in that window. The journal reaches sequence ${refusal.head}, ` +
            `and the window opened after ${refusal.afterSeq} — ask for more days, or check that ` +
            `documents are still arriving.`,
        );
      }
      return c.json({ valid: false, diagnostics: refusal.diagnostics }, 400);
    }
    return c.json(result.report);
  });

  /**
   * Fire a watch by hand.
   *
   * A watch's condition is the half you can read; where its firings go only
   * runs when the world produces the condition, which for a watch worth having
   * is rare and unschedulable. This runs that half on demand — the caps, the
   * transport, the anchor, the agent that opens a conversation about it — over
   * a firing the operator asked for.
   *
   * It evaluates nothing and spends no judge budget, and the firing is marked
   * as forced in both ledgers so it can never be counted as something the
   * watch caught.
   */
  app.post("/admin/watch/watches/:id/fire", scope.admin(), async (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    const body = fireBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      throw new BadRequestError(body.error.issues[0]?.message ?? "invalid body");
    }
    const result = await deps.fireByHand(watch.id, {
      ...(body.data.payload === undefined ? {} : { payload: body.data.payload }),
      ...(body.data.documentIds === undefined ? {} : { documentIds: body.data.documentIds }),
    });
    if (result.outcome === "no-watch") throw new NotFoundError("no such watch");
    if (result.outcome === "unreadable") {
      throw new BadRequestError(`this build cannot read that watch: ${result.why}`);
    }
    if (result.outcome === "not-active") {
      throw new BadRequestError(
        `watch ${watch.name} is ${result.status}, so the runtime is not running it; resume it first with \`watch resume ${watch.name}\``,
      );
    }
    // Refused rather than recorded. A firing forced into a watch that delivers
    // nowhere would be a row, a trace and a reported success with nothing
    // having gone anywhere — which reads as the delivery path being broken.
    if (result.outcome === "delivers-nowhere") {
      throw new BadRequestError(
        `watch ${watch.name} delivers nowhere, so there is no path to prove; turn delivery on first with \`watch deliver ${watch.name}\``,
      );
    }
    return c.json({
      watch: { id: watch.id, name: watch.name },
      seq: result.seq,
      delivered: result.delivered,
      suppressed: result.suppressed,
      // Why nothing arrived, when nothing did. Finding out that the transport
      // is not wired is what this route is for, so the reason comes back with
      // the answer rather than being left on a row to go and look up.
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  });

  app.get("/admin/watch/report", scope.admin(), async (c) => {
    const judge = deps.judgeSpend();
    const stored = deps.definitions.list();
    const live = await deps.liveState();
    const verdicts = verdictsFor(deps, stored, live.held, await deps.firingSummary());
    const watches = stored.map((watch) => {
      return {
        id: watch.id,
        name: watch.name,
        status: watch.status,
        note: watch.note,
        judgeRequired: deps.definitions.requiresJudge(watch),
        firings: deps.firingCount(watch.id),
        traceRecords: deps.traces.count(watch.id),
        judge: judge.byWatch[watch.id] ?? { calls: 0, deferrals: 0 },
        // Nominations the budget could not afford and has not yet come back to.
        // A shadow period reading zero firings on a semantic watch needs to know
        // whether the judge declined or never got the chance.
        pendingNominations: deps.pending(watch.id),
        // What stopped it, as the runtime recorded it rather than as a note
        // someone has to read English out of. Null on a watch nothing stopped.
        failure: deps.failure(watch.id),
        // Where this watch's firings go, and how much of its own allowance it
        // has spent. A watch delivering nowhere reads as the shadow default.
        delivery: deliveryKindOf(watch.dsl),
        // Attempted, not delivered: a push that reached the transport has spent
        // the allowance whatever the device did with it, and the two numbers
        // differ on any install whose device tokens have gone stale.
        attemptedToday: deps.attemptedToday(watch.id),
        // The one line that says whether any of the numbers above amount to a
        // watch worth having. Everything else here reports what it did; a watch
        // that did nothing reads identically whether that was correct or not.
        verdict: verdicts.get(watch.id) ?? null,
      };
    });
    return c.json({
      journalHead: deps.journal.head(),
      journalEvents: deps.journal.count(),
      judge: {
        ...deps.judgeReadiness(),
        calls: judge.calls,
        deferrals: judge.deferrals,
        errors: judge.errors,
      },
      // Whether the layer is doing anything, and what stopped the parts that
      // are not. This replaced a lone `failed` count that only ever saw node
      // failures: an install whose every watch had been paused by an ontology
      // move read `0 failed` for as long as it stayed that way, which is the
      // one thing a report about silence must never be able to say.
      health: deps.health(),
      // What is compiling right now, and whether more would be accepted. Read
      // before a restart: a stop taken while a compile runs waits for it, so
      // this is the difference between a deploy that takes seconds and one that
      // takes minutes — and `accepting: false` on a gateway nobody is stopping
      // is a stop that wedged.
      compiles: { running: deps.compiles.size, accepting: deps.compiles.open },
      // What the day's allowance is and what is left of it. A cap being hit is
      // worth knowing before someone decides their watches have gone quiet.
      delivery: deps.deliveryToday(),
      evaluation: deps.latency(),
      analyticsOutbox: deps.analyticsOutbox ? await deps.analyticsOutbox() : null,
      // How much of the substrate a watch can actually be written against. A
      // fraction below one means part of the install is invisible to the DSL,
      // which is a thing to read in a report rather than infer from its absence.
      ontology: deps.ontologyCoverage(),
      watches,
    });
  });

  /**
   * What each event made this watch do, node by node.
   *
   * `watch trace` prints the runtime's records in the order they were written
   * and leaves the joining to whoever reads them: which of those lines belong
   * to the firing in the ledger, which node held and in whose words, which
   * record was a deadline elapsing rather than something arriving. This does
   * that join once and answers with one entry per journal event — the path that
   * event took through the graph, and every node's verdict on the way.
   *
   * The journal event is the unit because it is the only join the stores
   * support. A firing is identified by `(seq, node, key-hash)`, where the hash
   * is an opaque digest of the key; a trace record carries the key *rendered
   * for a reader* and no hash at all, and neither can be turned into the other.
   * So a firing is attached to the event it happened on, and an event that
   * fired more than once — a broadcast arm re-judging every live cell at one
   * tick — carries all of them.
   *
   * Newest first, ordered by *when they happened* rather than by sequence
   * number: a deadline is journaled with a timer sequence counting down from
   * -1, so ordering on `seq` would file every expiry before every arrival.
   */
  app.get("/admin/watch/watches/:id/history", scope.admin(), (c) => {
    const watch = deps.definitions.get(c.req.param("id"));
    if (!watch) throw new NotFoundError("no such watch");
    const limit = readLimit.parse(c.req.query("limit") ?? 50);
    // Events nothing took up are held back by default and reachable by asking.
    // Held back rather than dropped: on a watch declining everything, they are
    // the whole story, and a surface that could not show them at all would be
    // hiding the evidence for its own summary.
    const includeUntouched = c.req.query("untouched") === "include";

    // The whole retained trace, whatever the caller asked for — `limit` bounds
    // the events answered with, not the records read. Reading a page of the
    // trace instead would make a firing whose records merely fall beyond the
    // page indistinguishable from one whose records have been pruned, and
    // telling those two apart is this route's one obligation.
    //
    // The count decides the read rather than this file's own ceiling, because
    // retention is an operator tunable that can sit above it. The store prunes
    // itself to that retention on every write, so what it holds is always what
    // there is to read.
    const retained = deps.traces.count(watch.id);
    const paths = traceEventPaths(deps.traces.recent(watch.id, Math.max(retained, 1)));
    // Which output fields carry a document, read off the definition rather than
    // guessed from a field's name at render time. A value the analysis cannot
    // prove is a document is not marked: a chip for a document that does not
    // exist is worse than the string it replaced.
    const parsedDsl = watchDslSchema.safeParse(watch.dsl);
    const lineage = parsedDsl.success ? documentLineage(parsedDsl.data.watch) : new Map();

    const outcomes = new Map(
      deps.deliveries(watch.id).map((d) => [`${d.seq}:${d.nodeId}:${d.keyHash}`, d]),
    );
    // Read on the same ceiling as the trace rather than on `limit`, which
    // bounds events. One tick can produce many firings — a broadcast arm
    // re-judges every live cell — so a ledger window the size of the event page
    // would leave an event on that page holding firings this never fetched, and
    // it would render as one that fired and said nothing.
    //
    // The ceiling is the retained row count, not this file's constant: a firing
    // always leaves at least one trace row, so any firing the trace can still
    // explain is inside that many of the newest firings. An install whose
    // configured retention sits above the constant would otherwise reach
    // exactly the state above, and read out a firing as a consideration.
    const ledger = new Map<number, ReturnType<WatchV2RoutesDeps["firings"]>>();
    for (const firing of deps.firings(watch.id, Math.max(retained, 1))) {
      const sameEvent = ledger.get(firing.seq);
      if (sameEvent) sameEvent.push(firing);
      else ledger.set(firing.seq, [firing]);
    }

    // Newest first, by when the runtime last worked on the event.
    //
    // Never by `seq`: a deadline coming due and a firing an operator forced
    // both take a sequence counting down from -1, so ordering on it would file
    // every one of them behind every arrival.
    //
    // By `at`, but `at` alone is not enough. The host records one trace per
    // evaluation pass and stamps every record in it with a single instant,
    // while a pass covers a batch of journal events plus whatever deadlines
    // came due inside it — so `at` ties across a whole batch. The trace's own
    // row order *is* the processing order and the store returns it oldest
    // first, so the position an event last appears in that stream breaks the
    // tie the way the runtime worked.
    //
    // Position cannot lead, because an event can be worked on twice: a
    // nomination the judge's budget parked is re-judged on a later pass and
    // settles — and fires — under its *original* sequence, so its earliest
    // rows sit far back in the stream while what just happened to it is the
    // newest thing on the page. Ordering on first appearance would file that
    // firing last, and on a busy watch slice it off the page entirely.
    const order = new Map([...paths.keys()].map((seq, index) => [seq, index]));
    const everything: { seq: number; at: string; path: EventPath | null }[] = [...paths]
      .map(([seq, path]) => ({ seq, at: path.at, path }))
      .sort((a, b) =>
        a.at === b.at ? order.get(b.seq)! - order.get(a.seq)! : a.at < b.at ? 1 : -1,
      );

    // Events no node took up, held back from the page unless they are asked
    // for. A watch whose recall arm is narrow declines most of what its filter
    // lets through, and one row apiece for those buries every event that
    // actually decided something — on a real install, a hundred rows of "a
    // document arrived and nothing wanted it" under which the one arming event
    // is invisible.
    //
    // This has to happen here rather than in the client: `limit` bounds the
    // page server-side, so a client filtering afterwards would still be handed
    // a page made entirely of them.
    //
    // They are counted, not discarded — a watch declining everything it looks
    // at is exactly what a recall arm that is too narrow looks like, and the
    // count is the only place that says so.
    const untouched = everything.filter((event) => tookNothingUp(event.path));
    const events = includeUntouched ? everything : everything.filter((e) => !tookNothingUp(e.path));
    // Firings the trace can no longer explain, newest-first among themselves
    // and after everything it can. Kept and marked rather than dropped: the
    // ledger holds a firing for as long as the watch exists while the trace is
    // bounded, so the older half of a busy watch's history has no path left to
    // draw — and an empty path would read as a firing that touched nothing.
    // They sort last because pruning takes the oldest rows, so a firing the
    // trace has forgotten is older than every event it still remembers.
    const forgotten = [...ledger]
      .filter(([seq]) => !paths.has(seq))
      .map(([seq, firings]) => ({
        seq,
        at: firings[0]!.noticedAt ?? firings[0]!.firedAt,
        path: null,
      }));
    forgotten.sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
    const page = [...events, ...forgotten].slice(0, limit);

    /**
     * Document ids a firing's payload carries, according to the lineage.
     *
     * Read from the sink's marked fields only — the payload is the sink's
     * output, so a field of some other node's name in it would be a coincidence
     * of naming, which is the guess this exists to avoid.
     */
    const payloadDocumentIds = (payload: unknown): string[] => {
      const marked = lineage.get(SINK_LINEAGE_KEY);
      if (!marked || typeof payload !== "object" || payload === null) return [];
      return [...marked].flatMap((field) => {
        const value = (payload as Record<string, unknown>)[field];
        return typeof value === "string" && value.length > 0 ? [value] : [];
      });
    };

    // One lookup for the page rather than one per firing: a watch on a joining
    // condition cites the same document from several firings. Payload values
    // the lineage marks as documents are resolved in the same read, so a
    // surface rendering them as chips needs no second round trip.
    const titles = new Map(
      deps
        .evidenceDocuments([
          ...new Set(
            page.flatMap(({ seq }) =>
              (ledger.get(seq) ?? []).flatMap((firing) => [
                ...firing.documentIds,
                ...payloadDocumentIds(firing.payload),
              ]),
            ),
          ),
        ])
        .map((document) => [document.id, document]),
    );

    return c.json({
      watch: watch.name,
      // How much of the trace is still held, so a reader can see the edge that
      // makes `traceRetained` false for themselves. Not the configured
      // retention: the store prunes to it on every write, so what is held is
      // the only number this route can state without guessing.
      trace: { records: retained },
      /**
       * Which output fields of which nodes carry a document id, and the titles
       * of the documents this page's payloads name.
       *
       * Static, from the definition: a surface reading a payload has a string
       * and no way to know what kind of thing it is, and the alternative to
       * this is guessing from the field's name — which renders a person id as a
       * document that does not exist, with nothing saying it guessed.
       */
      lineage: Object.fromEntries([...lineage].map(([node, fields]) => [node, [...fields]])),
      documents: Object.fromEntries(titles),
      /**
       * Events the trace explains, and how many of them nothing took up.
       *
       * Both counted over the retained trace, which is all this route can see.
       * The pair is the reading: `untouched` against `events` is the share of
       * what reached this watch that its recall arm declined, and a watch
       * declining nearly everything while never firing is an arm too narrow to
       * catch what it was written for — which nothing else on the page says.
       */
      events: {
        total: everything.length,
        untouched: untouched.length,
        showing: includeUntouched ? "all" : "engaged",
      },
      /**
       * How many records of each class this watch has ever produced.
       *
       * The declines are kept as a bounded sample, so the rows say how many the
       * store holds and this says how many there were. Reporting the sample as
       * the history would tell an operator a watch declined five things when it
       * declined four thousand — and the four thousand is the diagnostic: an
       * arm too narrow to catch what it was written for looks exactly like
       * that, and nothing else on the page says so.
       */
      classes: deps.traces.classCounts(watch.id),
      paths: page.map(({ seq, at, path }) => {
        const firings = ledger.get(seq) ?? [];
        const nodes = path?.nodes ?? [];
        // A firing an operator asked for must never read as something the
        // watch caught, on this surface as on the ledger.
        const forced =
          firings.some((firing) => firing.forced) ||
          nodes.some((node) => node.steps.some((step) => step.transition === "forced"));
        return {
          seq,
          at,
          // A negative sequence was taken from the runtime's own counter rather
          // than the journal. A deadline coming due is one; so is a firing an
          // operator forced, which is why `forced` decides first — a forced
          // firing wearing "deadline" would be an account of something that
          // never happened.
          timer: seq < 0 && !forced,
          traceRetained: path !== null,
          outcome: eventOutcome(nodes, firings.length > 0),
          forced,
          keys: [...new Set(nodes.map((node) => node.key))],
          nodes,
          firings: firings.map((firing) => {
            const outcome = outcomes.get(`${seq}:${firing.nodeId}:${firing.keyHash}`);
            return {
              nodeId: firing.nodeId,
              // Carried so two firings on one tick can be told apart. It joins
              // to the delivery ledger and to nothing else — the trace holds no
              // hash, which is why the path above is per event rather than per
              // firing.
              keyHash: firing.keyHash,
              firedAt: firing.firedAt,
              noticedAt: firing.noticedAt,
              forced: firing.forced,
              payload: firing.payload,
              documents: firing.documentIds.flatMap((id) => {
                const document = titles.get(id);
                return document ? [document] : [];
              }),
              ...(outcome === undefined
                ? {}
                : {
                    delivery: {
                      // Normalised exactly as the ledger normalises it: a watch
                      // stored before the rename records the old spelling, and
                      // a reader comparing two admin surfaces must not be shown
                      // two names for one channel.
                      kind: isNotifyDeliveryKind(outcome.kind) ? CURRENT_NOTIFY_KIND : outcome.kind,
                      delivered: outcome.delivered,
                      ...(outcome.attempted === null ? {} : { attempted: outcome.attempted }),
                      ...(outcome.error === null ? {} : { error: outcome.error }),
                      ...(outcome.degraded === null ? {} : { degraded: outcome.degraded }),
                      at: outcome.at,
                    },
                  }),
            };
          }),
        };
      }),
    });
  });
}

/** A document a firing or an arrived arm was reached through. */
type WatchEvidenceDocument = { id: string; title: string; sourceId: string };

/**
 * The moments and documents behind a snapshot's arrived arms.
 *
 * One journal read per distinct sequence rather than a scan: a half-satisfied
 * cell has at most as many arms as its node declares, and several cells of one
 * node were commonly armed by the same event.
 *
 * An event the journal has pruned is skipped rather than guessed at. `read`
 * returns the first event *after* the sequence given, so the one that comes
 * back is only this arm's if its sequence matches — otherwise the arm's own
 * event is gone and a later one would date it wrongly.
 */
function resolveArrivals(
  deps: WatchV2RoutesDeps,
  snapshot: WatchStateSnapshot,
): { instants: ReadonlyMap<number, string>; documents: Map<string, WatchEvidenceDocument> } {
  const { seqs, documentIds } = arrivalCandidates(snapshot);
  const instants = new Map<number, string>();
  for (const seq of seqs) {
    const [event] = deps.journal.read(seq - 1, 1);
    if (event?.seq === seq) instants.set(seq, event.occurredAt);
  }
  return {
    instants,
    documents: new Map(deps.evidenceDocuments(documentIds).map((doc) => [doc.id, doc])),
  };
}

/**
 * Whether this event reached the watch and no node took it up.
 *
 * The runtime records a declined nomination as `ignored` on the node that
 * declined it — a document no recall arm wanted, which on a watch with a narrow
 * arm is most of what its filter lets through. A document that fails the
 * *filter* never reaches a node at all and leaves no record, so it is already
 * absent; this is the next gate out.
 *
 * `ignored` also covers a colliding arm dropped while a cell was already live,
 * which is a real decision and must stay on the page. It is told apart without
 * reading detail strings or node types: for an arm to collide at all, the
 * source feeding it fired on this same event — so that path carries a `fired`
 * and is not all-ignored. Only an event nothing took up is ignored throughout.
 */
function tookNothingUp(path: EventPath | null): boolean {
  if (path === null || path.nodes.length === 0) return false;
  return path.nodes.every((node) => node.steps.every((step) => step.transition === "ignored"));
}

/**
 * What to say about each of these watches, and why.
 *
 * One derivation for the listing and for the one-watch page: two copies would
 * be two answers about one watch on two screens, and the row and the page it
 * opens are the two places a reader compares.
 *
 * Grouped rather than per watch. Every read below covers the whole set for the
 * price of one, which is what lets a listing of a hundred carry a verdict at
 * all — the alternative reads the runtime once per row to draw a summary line.
 */
function verdictsFor(
  deps: WatchV2RoutesDeps,
  stored: readonly StoredWatch[],
  held: Map<string, WatchLiveState>,
  firings: Map<string, { count: number; lastFiredAtMs: number | null }>,
): Map<string, WatchVerdict> {
  const classes = deps.traces.classCountsAll();
  const judgements = deps.traces.judgementsAll();
  const waking = stored.filter((watch) => wakesAnAgent(watch.dsl));
  const breaches = new Map(
    deps
      .anchorBreaches(waking.map((watch) => watch.id))
      .map((breach) => [breach.watchId, breach.standing]),
  );
  const wakes = new Set(waking.map((watch) => watch.id));
  const now = Date.now();
  return new Map(
    stored.map((watch) => [
      watch.id,
      watchVerdict({
        // Read first by the verdict, and the reason every rule below it is
        // about a watch that is actually being evaluated.
        status: watch.status,
        // And, when it is not, what stopped it. Four of the five sites that
        // write `paused` are faults the machine detected; one is the operator
        // holding the watch. Only the note and the failure record tell them
        // apart, and a broken watch that reads like a deliberately paused one
        // is the one thing on this listing nobody would act on.
        // The failure record is read only for a watch that is not running:
        // `stoppedCause` ignores it for an active one, and a listing of a
        // hundred mostly-active watches would otherwise pay a primary-key
        // lookup each, on a route the portal polls.
        stoppedCause:
          watch.status === "active" ? null : stoppedCause(watch, deps.failure(watch.id) !== null),
        // Read off the note, which is where the codes survive: the validation
        // that produced them ran in a pass nobody was watching.
        driftCodes: driftCodesOf(watch.note),
        heldSurface: surfaceReasonOf(watch.note),
        addedAtMs: Date.parse(watch.addedAt),
        now,
        wakesAnAgent: wakes.has(watch.id),
        // Absent from the breaches is the healthy answer: the query reports
        // only the watches that do not hold exactly one.
        anchorStanding: wakes.has(watch.id) ? (breaches.get(watch.id) ?? 1) : null,
        firings: firings.get(watch.id)?.count ?? 0,
        lastFiredAtMs: firings.get(watch.id)?.lastFiredAtMs ?? null,
        declined: classes.get(watch.id)?.ignored ?? 0,
        judgeMatched: judgements.get(watch.id)?.matched ?? 0,
        judgeDeclined: judgements.get(watch.id)?.declined ?? 0,
        holding: holdingOf(held.get(watch.id)),
        evaluatedThroughSeq: held.get(watch.id)?.cursorSeq ?? null,
      }),
    ]),
  );
}

/**
 * Whether the runtime is holding something for this watch.
 *
 * A holding cell or an armed timer, either one: a watch waiting on a clock
 * holds no cell at all, and reading only cells would report it as idle when it
 * is the thing it was written to be.
 *
 * The holding count rather than the population: a cell is kept for reasons
 * other than waiting — a spent cooldown stamp, a drained persistence window, a
 * SQL node's resting level — and each node type says which of its own count
 * (`holding.ts`). Reading the population instead would describe a watch
 * remembering a firing from months ago as one waiting for the rest of it.
 */
function holdingOf(held: WatchLiveState | undefined): boolean {
  if (!held) return false;
  return held.holdingKeys > 0 || held.timers > 0;
}

/**
 * One watch's live state for a list row.
 *
 * A watch the aggregate never mentioned is holding nothing, which is a real
 * answer and usually the correct state — so it reads as zeros rather than as an
 * absent field a client would have to decide how to render.
 */
function liveRow(held: WatchLiveState | undefined): {
  keys: number;
  cells: number;
  holdingKeys: number;
  holdingCells: number;
  timers: number;
  nextDueAt: string | null;
  cursorSeq: number | null;
} {
  return {
    keys: held?.keys ?? 0,
    cells: held?.cells ?? 0,
    // What the watch is actually waiting on, which is the number a mark may
    // call "tracking". Never above `keys`: the population includes the cells a
    // node keeps for its own bookkeeping after they stop holding anything.
    holdingKeys: held?.holdingKeys ?? 0,
    holdingCells: held?.holdingCells ?? 0,
    timers: held?.timers ?? 0,
    nextDueAt:
      held?.nextDueAtMs === undefined || held.nextDueAtMs === null
        ? null
        : new Date(held.nextDueAtMs).toISOString(),
    // Null, never zero. "Absent means nothing" is right for the counts and
    // wrong for a position: a watch is added at the journal head and its cursor
    // is seeded on the first pass that evaluates it, so an absent row means
    // "has not started" — and sequence zero would accuse it of a backlog of the
    // entire journal it was never going to read.
    cursorSeq: held?.cursorSeq ?? null,
  };
}

/** What a stored watch says it is for, without re-parsing the whole DSL. */
function requestOf(dsl: unknown): string | null {
  const query = (dsl as { watch?: { nl_query?: unknown } } | null)?.watch?.nl_query;
  return typeof query === "string" && query.length > 0 ? query : null;
}

/** Where a stored watch says its firings go, without re-parsing the whole DSL. */
/**
 * How far back a probe looks and how many documents it may score.
 *
 * Both are the caller's, because the right window is a property of the source
 * — a watch over a feed that started last month cannot be judged on a year —
 * and because scoring is a cosine per chunk and an unbounded probe is a long
 * synchronous walk on a gateway that is also serving requests.
 */
/**
 * One sentence for the condition, one for the reaction.
 *
 * `instruction` is optional because a watch that only records is a legitimate
 * thing to ask for; supplying it is what turns the watch into something that
 * wakes an agent.
 */
const compileBody = z
  .object({
    request: z.string().min(1).max(4_000),
    instruction: z.string().min(1).max(8_000).optional(),
    /**
     * The referents the instruction names, when it names any.
     *
     * Carried with the instruction rather than resolved here: what a key means
     * is the instruction's business, and a caller that had to name a thing the
     * gateway understands could only ever point at things the gateway already
     * knows about.
     */
    bindings: wakeBindingsBody.optional(),
    /**
     * Which harness to wake. Checked against the connected devices, not trusted.
     *
     * Held to the DSL's own rule for an integration name, because that is where
     * this value ends up: without it a name the DSL refuses is a full model call
     * followed by a parse failure with nothing saying which field was wrong.
     */
    integrationName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "an integration name is lowercase kebab-case")
      .default("openclaw"),
    /**
     * Compile and answer with the document, installing and arming nothing.
     *
     * `true` only — a body saying `false` says the same thing as a body that
     * left it out, and admitting both would leave the surface with two
     * spellings of the default.
     */
    compileOnly: z
      .literal(true, "compileOnly may only be `true`; leave it out to install")
      .optional(),
    /**
     * Compile without replaying the candidate first.
     *
     * The replay and the revision it can trigger are one intervention and this
     * withholds all of it, so the same requests can be compiled with and
     * without the loop on one install in one sitting — what the replay costs is
     * only meaningful beside what it costs to go without, and a control drawn
     * from a different day is a control for the day as much as for the loop.
     *
     * `true` only, and refused unless `compileOnly` is set: a watch about to be
     * armed is the one case where the replay is worth its minutes whatever the
     * caller thinks, and a switch reachable from the install path would end up
     * being used to install something faster.
     */
    withoutBacktest: z
      .literal(true, "withoutBacktest may only be `true`; leave it out to replay")
      .optional(),
  })
  .strict()
  .refine((body) => body.withoutBacktest !== true || body.compileOnly === true, {
    message: "withoutBacktest is for measuring a compile; it needs compileOnly",
    path: ["withoutBacktest"],
  })
  // Referents without an instruction have nothing to be referents of, and the
  // watch this request would install wakes nobody. Refused rather than
  // dropped: a caller who sent them believes the wake carries them.
  .refine((body) => body.bindings === undefined || body.instruction !== undefined, {
    message: "bindings name what an instruction points at; send `instruction` as well",
    path: ["bindings"],
  });

const probeBody = z
  .object({
    windowDays: z.number().int().positive().max(3650).default(90),
    limit: z.number().int().positive().max(20_000).default(2_000),
  })
  .strict();

/**
 * A candidate to try before storing it.
 *
 * `dsl` rather than an id, because the question is asked before there is a
 * watch to name — and a candidate carrying a delivery block is refused for the
 * same reason `POST /admin/watch/watches` refuses one: trying a watch out is
 * not a way to acquire the ability to interrupt somebody.
 */
const preflightBody = z
  .object({
    dsl: z.unknown(),
    /**
     * How much recent traffic to replay. The cheap diagnostic: what does this
     * candidate do with what just arrived.
     */
    events: z
      .number()
      .int()
      .positive("`events` must be a positive whole number")
      .max(MAX_PREFLIGHT_EVENTS, `\`events\` may not exceed ${MAX_PREFLIGHT_EVENTS}`)
      .optional(),
    /**
     * How far back to replay instead, in days.
     *
     * The other question entirely — "would this have fired over the last few
     * months" — and the one a reach number needs, because the conditions worth
     * watching for happen on that scale rather than on the scale of an
     * afternoon's traffic. Costs proportionally more, and the replay hands the
     * event loop back as it goes so the rest of the gateway keeps serving.
     */
    days: z
      .number()
      .int()
      .positive("`days` must be a positive whole number")
      .max(MAX_REPLAY_DAYS, `\`days\` may not exceed ${MAX_REPLAY_DAYS}`)
      .optional(),
  })
  .strict()
  .refine((body) => body.events === undefined || body.days === undefined, {
    message: "ask for `events` or `days`, not both — they answer different questions",
  });

/**
 * What a forced firing carries.
 *
 * Both optional, and both inert by default: nothing reads a firing's payload
 * except `watch firings`, and the documents matter only to a watch that wakes
 * an agent — where they are what the agent may be answered from, still bounded
 * by what its anchor was approved to offer.
 */
const fireBody = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    documentIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();

/**
 * The delivery kind of a stored watch, read off the raw document.
 *
 * Raw because the stored DSL is served verbatim and this feeds two wire
 * surfaces plus the add-time rejection — so it must answer for a watch whose
 * document this build has not parsed. It normalises the old spelling of the
 * notify kind for the same reason the schema does: a watch stored before the
 * rename delivers exactly where it always did, and a report that named the
 * old kind would be describing a channel no current reader has heard of.
 */
function deliveryKindOf(dsl: unknown): string | null {
  const delivery = (dsl as { watch?: { delivery?: { kind?: unknown } } } | null)?.watch?.delivery;
  if (typeof delivery?.kind !== "string") return null;
  return isNotifyDeliveryKind(delivery.kind) ? CURRENT_NOTIFY_KIND : delivery.kind;
}

/**
 * The same watch, delivering somewhere else.
 *
 * A copy, so the stored definition is only rewritten once the copy has been
 * validated and a refusal leaves the original exactly as it was.
 */
function withDelivery(dsl: unknown, delivery: WatchDelivery | null): unknown {
  const copy = JSON.parse(JSON.stringify(dsl)) as { watch?: Record<string, unknown> } | null;
  if (!copy?.watch) return copy;
  if (delivery === null) delete copy.watch["delivery"];
  else copy.watch["delivery"] = delivery;
  return copy;
}

/** One transition a node recorded, stripped of what the event already says. */
interface PathStep {
  readonly transition: string;
  readonly detail: string | null;
  readonly failure: string | null;
}

/** What one node did during one event, under one key. */
interface PathNode {
  readonly nodeId: string;
  readonly key: string;
  readonly steps: PathStep[];
  /**
   * The transition the event ended on for this node, with the two fields a
   * reader needs beside it: the judge's own sentence on a `held` it decided,
   * and the class on one it could not. Repeated from the last step rather than
   * left to be indexed out of it, so a node renders from its own fields.
   */
  verdict: string;
  detail: string | null;
  failure: string | null;
}

interface EventPath {
  /** The latest moment any of this event's records was written. */
  at: string;
  readonly nodes: PathNode[];
  readonly cells: Map<string, PathNode>;
}

/**
 * The trace, grouped into the path each journal event took.
 *
 * A node appears once per key it was evaluated under. A broadcast arm re-judges
 * every live cell at one tick, and folding those onto the node would report a
 * single verdict for a moment that produced several — which is the exact thing
 * a keyed watch is misread by.
 */
function traceEventPaths(records: readonly TraceRow[]): Map<number, EventPath> {
  const paths = new Map<number, EventPath>();
  for (const record of records) {
    let path = paths.get(record.seq);
    if (!path) {
      path = { at: record.at, nodes: [], cells: new Map() };
      paths.set(record.seq, path);
    }
    if (record.at > path.at) path.at = record.at;
    // NUL separates the two halves because neither a node id nor a key can
    // contain one, so no pair of distinct records can collide on the joined
    // string. Written as an escape: a literal control byte would make git and
    // grep treat this whole file as binary.
    const cell = `${record.nodeId}\u0000${record.key}`;
    let node = path.cells.get(cell);
    if (!node) {
      node = {
        nodeId: record.nodeId,
        key: record.key,
        steps: [],
        verdict: record.transition,
        detail: record.detail,
        failure: record.failure,
      };
      path.cells.set(cell, node);
      path.nodes.push(node);
    }
    node.steps.push({
      transition: record.transition,
      detail: record.detail,
      failure: record.failure,
    });
    // Last writer wins: an `armed` followed by a `held` is a hold, and it is
    // the hold a reader asking why nothing happened has come for.
    node.verdict = record.transition;
    node.detail = record.detail;
    node.failure = record.failure;
  }
  return paths;
}

/**
 * How one event ended, in a word.
 *
 * The ledger decides whether it fired, not the trace. A `fired` transition
 * means *a node* passed its signal on, and most of them are mid-graph: a source
 * firing into a cooldown that swallows it is a node that fired and a watch that
 * said nothing. Only a row in the firings ledger is the watch having spoken.
 *
 * `failed` is reported only for an event that did not also fire. A failure is
 * the thing an operator has to act on — it is what pauses the watch — but an
 * event that produced a firing anyway is read for the firing first.
 */
function eventOutcome(
  nodes: readonly PathNode[],
  inLedger: boolean,
): "fired" | "failed" | "considered" {
  if (inLedger) return "fired";
  return nodes.some((node) => node.steps.some((step) => step.transition === "failed"))
    ? "failed"
    : "considered";
}
