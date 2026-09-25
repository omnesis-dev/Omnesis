// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A sentence becomes a running watch.
 *
 * Two people ask for this and they ask for the same thing. The operator types a
 * condition into the admin surface; an agent asks in prose over its own API
 * because a person told it to. Both mean "when X happens, do Y", and both need
 * the identical four steps — compile the condition, install the definition,
 * decide where the journal starts, and wire what happens when it fires.
 *
 * They differ in exactly two ways, and both are stated as arguments rather than
 * left to the caller to remember: **whom the watch wakes**, and **whether
 * anyone has agreed to it yet**. An operator writing a delivery block has
 * already made that decision, so the record self-approves. An agent asking for
 * a watch has not — a person has to say yes, and until they do the watch
 * evaluates and wakes nobody.
 *
 * Compiling and installing are two stores that cannot share a transaction, so
 * ordering is the guard: the definition is stored first and the anchor second.
 * The other order would leave an approved record pointing at a watch that does
 * not exist. In between is a watch that evaluates and wakes nobody, and it is
 * closed from both ends — a failure to mint holds the watch with the reason
 * written on it, and `reconcile` mints the missing record from the delivery
 * block at the next start for the crash that reaches neither.
 */

import { randomUUID } from "node:crypto";

import { createLogger, type Logger } from "@omnesis/core";
import {
  watchDslSchema,
  type LoopBacktest,
  type Ontology,
  type RefusalCode,
  type WatchDelivery,
  type WatchDiagnostic,
} from "@omnesis/watch";
import { ANCHOR_UNMINTED_NOTE, holdUnarmed, isUnarmedNote } from "./health.js";
import { wakesAnAgent, type WakeBindings, type WakeTarget } from "./anchors.js";
import type { InFlightRequests } from "./in-flight-requests.js";
import type { StoredWatch, WatchDefinitionStore } from "./definitions.js";
import type { WatchJournalStore } from "./store.js";
import type { WatchV2Author } from "../subscriptions/watch-v2-plan.js";
import type { WriteLease } from "./write-lease.js";

const log: Logger = createLogger("gateway").child("watch-v2:authoring");

/**
 * Turning a request into a watch, or declining with reasons.
 *
 * `compileRunId` is the ledger row the compile was written to — the handle an
 * operator follows to the transcript of what the compiler saw and answered.
 * Null when this install is not recording, or when the row failed to land: a
 * watch must never carry a durable reference to a run the ledger never
 * received.
 */
export type CompileRequest = (input: {
  request: string;
  ontology: Ontology;
  authoredBy: WatchV2Author;
  replaces?: string;
  /** Whether the caller wants the document rather than a running watch. */
  compileOnly?: boolean;
  /** Whether to compile without replaying the candidate first. */
  withoutBacktest?: boolean;
}) => Promise<
  | {
      status: "compiled";
      document: unknown;
      /** The validator's verdict on the document. Warnings, in practice. */
      diagnostics: readonly WatchDiagnostic[];
      /** What it would have done, where a replay could say. Null is not zero. */
      backtest: LoopBacktest | null;
      compileRunId: string | null;
    }
  | {
      status: "refused";
      reasons: readonly string[];
      codes: readonly RefusalCode[];
      compileRunId: string | null;
    }
  | { status: "timed-out"; compileRunId: string | null }
  | { status: "no-model" }
>;

/**
 * The same document, carrying the delivery its asker wanted.
 *
 * A copy rather than a mutation, so the caller keeps holding what it passed in
 * and one step's output is never another step's surprise.
 */
function withDelivery(document: unknown, delivery: WatchDelivery): unknown {
  const copy = JSON.parse(JSON.stringify(document)) as { watch?: Record<string, unknown> } | null;
  if (copy?.watch) copy.watch["delivery"] = delivery;
  return copy;
}

/**
 * The same document with any delivery block the *model* wrote taken out.
 *
 * The DSL has a `delivery` field and the compiler is handed the DSL's schema,
 * so a model shown that field will fill it in for a request that merely sounds
 * urgent — and since the compiler reads the corpus, a document it retrieved can
 * ask it to. The hand-add route refuses such a document outright; this path
 * cannot, because the block would be the model's mistake rather than the
 * caller's, and failing the compile would let a document in the corpus deny
 * service. So it is dropped, and the drop is logged: the ability to interrupt
 * a person or wake an agent exists only because somebody asked for it by name,
 * and {@link withDelivery} is the only way it is ever granted.
 */
function withoutModelDelivery(document: unknown, authoredBy: WatchV2Author): unknown {
  const copy = JSON.parse(JSON.stringify(document)) as { watch?: Record<string, unknown> } | null;
  if (copy?.watch && copy.watch["delivery"] !== undefined) {
    delete copy.watch["delivery"];
    log.warn(
      `the compiler wrote a delivery block into a watch requested by the ${authoredBy}; dropped it — nobody asked for one`,
    );
  }
  return copy;
}

/**
 * The document that would be installed: what the compiler wrote, with the
 * model's own delivery block removed and the asker's put in its place.
 *
 * One function because the preview and the install must not be able to differ.
 * A preview that showed a document nobody would have installed would be worse
 * than no preview at all — it would be a measurement of a watch that does not
 * exist.
 */
function documentFor(compiled: unknown, input: PreviewWatchRequest): unknown {
  // The compiler writes the condition; who hears about it is the asker's, and
  // it has to be written into the definition rather than only into the anchor.
  // The runtime asks the *watch* whether it delivers — `deliver()` returns
  // early on a definition with none — so a watch whose delivery lived only in
  // the record would fire, write its row, and wake nobody. The anchor sweep
  // reads the same block, and would retire the record at the next start for
  // belonging to a watch that wakes no one.
  const stripped = withoutModelDelivery(compiled, input.authoredBy);
  if (input.delivery === undefined) return stripped;
  return withDelivery(
    stripped,
    input.delivery.kind === "omnesis-notify"
      ? {
          kind: "omnesis-notify",
          ...(input.delivery.title === undefined ? {} : { title: input.delivery.title }),
          ...(input.delivery.body === undefined ? {} : { body: input.delivery.body }),
        }
      : {
          kind: "agent-wake",
          integration: harnessName(input.delivery.wake),
          instruction: input.delivery.instruction,
          // Written into the definition beside the instruction they belong to,
          // because the definition is what the anchor is read from: referents
          // that lived only in the request would be lost the first time the
          // record was re-minted from the block.
          ...(input.delivery.bindings === undefined ||
          Object.keys(input.delivery.bindings).length === 0
            ? {}
            : { bindings: input.delivery.bindings }),
        },
  );
}

/**
 * The harness a wake target names.
 *
 * The DSL names harnesses rather than devices on purpose: a device id changes
 * when a harness re-pairs, and a watch written against one would stop waking
 * anybody the day that happened. The anchor is still minted against the
 * resolved device, so a wake travels that agent's own connection.
 */
function harnessName(target: WakeTarget): string {
  return target.kind === "harness" ? target.name : target.harness;
}

export interface AuthorWatchDeps {
  readonly definitions: WatchDefinitionStore;
  /**
   * The runs already going, so a request that arrives twice compiles once.
   *
   * Shared across every caller of this module, which is what makes it work at
   * all: two arrivals of one request reach here through the same route handler
   * and have to find each other's run.
   */
  readonly inFlight: InFlightRequests;
  /** Erase the runtime state a removed watch leaves behind. */
  readonly forget: (watchId: string) => void;
  readonly journal: WatchJournalStore;
  readonly ontology: () => Promise<Ontology>;
  /** Absent when no model is assigned for compiling. */
  readonly compile?: CompileRequest;
  /** Whose turn it is to write the definitions file. */
  readonly writes: WriteLease;
  /**
   * Bring the watch's wake anchor into line with what its definition now says.
   *
   * Takes the id rather than the delivery: the definition is the authority on
   * whom a watch wakes, and it is already written by the time this is called.
   * What is passed alongside is only what the definition cannot say — the
   * device an agent named for itself, who asked, and the caller's own key.
   */
  readonly setWakeAnchor: (
    watchId: string,
    asker?: { target?: WakeTarget; authoredBy?: WatchV2Author; idempotencyKey?: string },
  ) => Promise<string | null>;
}

/**
 * What a watch does when it fires, as the asker described it.
 *
 * A union rather than a set of optional fields, because the two kinds differ
 * in everything that follows: an agent wake needs a device to travel over, a
 * record to be approved against and an instruction to carry, and a push to the
 * operator's own phones needs none of those — it crosses no egress boundary
 * and there is nobody to ask.
 *
 * Absent altogether is the third case and the default: a firing is a row and a
 * trace, and nothing interrupts anyone.
 */
export type AuthorWatchDelivery =
  | {
      readonly kind: "agent-wake";
      readonly wake: WakeTarget;
      /**
       * What the woken agent is told to do, carried verbatim: the watch
       * decides *when*, deterministically, and this decides *what*, in prose.
       */
      readonly instruction: string;
      /**
       * The referents the instruction names, carried verbatim like the words
       * that name them. Nothing here reads a key or a value; see
       * {@link WakeBindings}.
       */
      readonly bindings?: WakeBindings;
      /** The asker's own key, when they have one. See {@link WakeDelivery}. */
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "omnesis-notify";
      /** What the banner says, when the asker chose words for it. */
      readonly title?: string;
      readonly body?: string;
    };

export interface AuthorWatchRequest {
  /** The condition, in the asker's own words. */
  readonly request: string;
  readonly delivery?: AuthorWatchDelivery;
  readonly authoredBy: WatchV2Author;
  /**
   * The watch this one replaces, when the asker is rewriting rather than
   * adding.
   *
   * A rewrite keeps the identity so whoever is holding the id keeps holding a
   * live one, and starts from the journal head so the new condition watches
   * what happens next rather than replaying what already did — the same
   * argument that makes a fresh watch start there.
   *
   * The runtime's memory of the old watch is cleared first. A `once_ever`
   * watch that has already fired would otherwise pass its firing state to its
   * replacement, and the replacement would never fire — the exact silence this
   * layer exists to prevent. Clearing before storing means a crash in between
   * costs at most one repeated notification from the definition still in
   * place, which is the failure worth having.
   */
  readonly replaces?: string;
  /**
   * The asker's own name for this request, when they have one.
   *
   * What makes the whole call idempotent rather than only its last step. A
   * caller that compiled, installed, and then failed to arm retries with the
   * same key — and there is no record downstream to deduplicate against,
   * because the record is exactly what failed to appear. Given the key, this
   * finds the watch it already made and finishes the job instead of compiling
   * a second copy that evaluates beside the first forever.
   *
   * **Scoped to the asker by the caller.** The key is a name the *client*
   * chose, so two integrations can pick the same one; a key looked up across
   * every watch on the install would hand the second one the first's watch —
   * retiring its anchor, minting a replacement on the second's device, and
   * carrying the first's instruction to it. Whoever supplies this namespaces
   * it, the way the subscription store scopes its own idempotency by owner.
   */
  readonly requestKey?: string;
}

export type AuthorWatchResult =
  | {
      readonly status: "installed";
      readonly watch: StoredWatch;
      /**
       * The subscription the watch wakes through, when it wakes anyone. Null
       * for a watch that only records, and for one whose named harness no
       * device holds — the watch is installed either way, and the difference
       * is whether anything will hear it fire.
       */
      readonly anchorSubscriptionId: string | null;
    }
  | {
      readonly status: "refused";
      /** The ledger row carrying what the compiler saw before it declined. */
      readonly compileRunId: string | null;
      /**
       * The compiler's own words about why.
       *
       * For this corpus's owner and the gateway log only: the compiler reads
       * the corpus, so a reason can quote what it read. A caller on the far
       * side of the privacy boundary is handed {@link RefusalCode} instead.
       */
      readonly reasons: readonly string[];
      /** What about the *request* could not be written. Safe to disclose. */
      readonly codes: readonly RefusalCode[];
    }
  /**
   * The watch is installed and held, because its wake record could not be
   * created.
   *
   * Its own outcome rather than an error: the definition exists and carries the
   * asker's request, so a retry of the same request must find it rather than
   * compile a second copy — and an operator opening the list has to see why it
   * is not running. Reactivating it re-runs the arming.
   */
  | { readonly status: "unarmed"; readonly watch: StoredWatch }
  /**
   * The request cannot be honoured as asked, and no retry of it will help.
   *
   * One request reaches this: a caller's key already names a watch, and the
   * same call asks to rewrite a *different* one. Honouring the key would
   * silently arm the watch the key names and skip the rewrite entirely;
   * honouring the rewrite would move somebody else's key onto it. Only the
   * caller can say which watch they meant.
   *
   * Unreachable from any caller today — no surface passes both a key and a
   * `replaces` — and here because the alternative to a guard is that whichever
   * surface grows that combination does the wrong half of it, silently, and
   * nothing in the request or the answer would say so.
   */
  | { readonly status: "conflict"; readonly because: string }
  /** The model did not finish in time. Asking again may well work. */
  | { readonly status: "timed-out" }
  | { readonly status: "no-compiler" };

/**
 * Whether this is the request-key index refusing a second watch for one
 * request, rather than any other write failing.
 *
 * Read off the driver's own code and the constraint's name: any other
 * constraint on this table is a defect rather than a collision, and reporting
 * one as a conflict would tell a caller to retry something that cannot work.
 */
function isRequestKeyCollision(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("SQLITE_CONSTRAINT")) return false;
  return String((error as Error).message ?? "").includes("request_key");
}

/**
 * Why a watch was held at install. Read by an operator, so it says what to do.
 *
 * Declared beside the classification that parses it, and re-exported here for
 * the writers: a reworded note at a writer would leave every held watch
 * quietly reclassified, with every test still green.
 */
export { ANCHOR_UNMINTED_NOTE };

/**
 * What a preview needs, which is nothing that writes.
 *
 * Spelled as a projection of the install's dependencies rather than as a fresh
 * interface, so the two cannot drift about which compile or which ontology
 * they mean — and so "a preview writes nothing" is a fact about this type
 * rather than a promise in a comment. The stores, the write lease and the
 * anchor minter are simply not in scope.
 */
export type PreviewWatchDeps = Pick<AuthorWatchDeps, "compile" | "ontology" | "inFlight">;

/** The half of a request a preview can honour: everything before the install. */
export type PreviewWatchRequest = Pick<
  AuthorWatchRequest,
  "request" | "delivery" | "authoredBy" | "replaces"
> & {
  /**
   * Compile without replaying the candidate first.
   *
   * Only here, never on the install path. A watch about to be armed is the one
   * case where the replay is worth its minutes unconditionally, and a switch
   * offered there would eventually be used to install something faster.
   */
  readonly withoutBacktest?: boolean;
};

export type PreviewWatchResult =
  | {
      readonly status: "compiled";
      /** The DSL exactly as an install would have stored it. */
      readonly document: unknown;
      /**
       * The compiler's own restatement of the request, in prose.
       *
       * The part a person can actually check. The DSL says what the watch
       * does; this says what the compiler thought it was being asked, and a
       * compilation that is wrong is usually wrong here first. Null for a
       * document written without one — the field is optional in the DSL.
       */
      readonly interpretation: string | null;
      /**
       * What the validator says about it. Warnings, in practice.
       *
       * The same class as `reasons` on a refusal, and answerable to the same
       * rule: a diagnostic quotes the watch the model wrote, and the model
       * reads the corpus, so one can carry a person id or a term it found
       * there. Only a surface that already sees the document may see these.
       */
      readonly diagnostics: readonly WatchDiagnostic[];
      /**
       * What this candidate would have done over the history it was replayed
       * against — per-node reach, firings, and the window those are counts of.
       *
       * Null when nothing replayed it, which is not the same as zero: a watch
       * that reached nothing and a watch nobody replayed are opposite facts.
       * Carried whether or not the replay changed the compile, because "this
       * would have fired 0 times in 12 days" is the sentence an asker most needs
       * before agreeing to run something.
       */
      readonly backtest: LoopBacktest | null;
      readonly compileRunId: string | null;
    }
  | {
      readonly status: "refused";
      readonly compileRunId: string | null;
      /** The compiler's own words. This corpus's owner only — see below. */
      readonly reasons: readonly string[];
      /** What about the request could not be written. Safe to disclose. */
      readonly codes: readonly RefusalCode[];
    }
  | { readonly status: "timed-out" }
  | { readonly status: "no-compiler" };

/**
 * Compile a request and hand back the watch, having written nothing.
 *
 * Two people want this and they want the same thing. An operator wants to see
 * what a sentence becomes before agreeing to run it. A measurement of the
 * compiler wants an answer per request and none of the watches —
 * `POST /admin/watch/compile` installs and arms in one request by design, so
 * grading it that way would write a watch, a wake record and a subscription row
 * per question, to answer a question that needs none of them.
 *
 * The compile itself is untouched — same prompt, same tools, same repair loop,
 * same deadline, the model's own delivery block stripped exactly as it would
 * be, the asker's put in its place. A compiler measured through a path of its
 * own would be a measurement of that path.
 */
export async function previewWatch(
  deps: PreviewWatchDeps,
  input: PreviewWatchRequest,
): Promise<PreviewWatchResult> {
  const compile = deps.compile;
  if (!compile) return { status: "no-compiler" };
  // Tracked like any other compile, and never shared: a preview installs
  // nothing, so it has no idempotency key to be recognised by — but it costs
  // the same minutes, and a stop that did not know about it would tear the
  // gateway down mid-answer.
  const ontology = await deps.ontology();
  const result = await deps.inFlight.run(null, null, () =>
    compile({
      request: input.request,
      ontology,
      authoredBy: input.authoredBy,
      compileOnly: true,
      ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
      ...(input.withoutBacktest === true ? { withoutBacktest: true } : {}),
    }),
  );
  if (result.status === "timed-out") return { status: "timed-out" };
  if (result.status === "no-model") return { status: "no-compiler" };
  if (result.status !== "compiled") {
    return {
      status: "refused",
      reasons: result.reasons,
      codes: result.codes,
      compileRunId: result.compileRunId,
    };
  }
  const document = documentFor(result.document, input);
  // Parsed for the same reason the install path parses: a document the DSL
  // would refuse is reported as one rather than handed over as a preview of
  // something that could never run.
  const parsed = watchDslSchema.parse(document);
  return {
    status: "compiled",
    document,
    interpretation: parsed.watch.nl_query ?? null,
    diagnostics: result.diagnostics,
    backtest: result.backtest,
    compileRunId: result.compileRunId,
  };
}

/**
 * Compile a request, install it, and arm it — in one go.
 *
 * One call because the asker has one thing to say. Splitting it across compile,
 * install and arm would leave a watch that matches and tells nobody whenever
 * the second call never came, and that watch is indistinguishable from one
 * whose condition simply never happened.
 */
export async function authorWatch(
  deps: AuthorWatchDeps,
  input: AuthorWatchRequest,
): Promise<AuthorWatchResult> {
  // Every compile goes through here, whether or not anything can share it: a
  // stop has to know what is running, and a count that saw only the shareable
  // ones would report zero while the operator's own compile ran.
  //
  // A request that named itself is also shared. The key alone settles a retry
  // that comes after the first finished, because by then there is a record to
  // find; it does nothing for one arriving during, and with compiles at minutes
  // and clients that retry on a timeout, during is the ordinary case — observed
  // live as one intent and five compiles. What is fingerprinted alongside the
  // key is everything that could change the answer, because a key naming a
  // different request is a different request — it is compiled on its own rather
  // than handed this one's result, and then converges on whatever that key
  // already names, which is the store's rule about keys rather than this one.
  return deps.inFlight.run(
    input.requestKey ?? null,
    {
      request: input.request,
      authoredBy: input.authoredBy,
      replaces: input.replaces ?? null,
      delivery: input.delivery ?? null,
    },
    () => authorOneWatch(deps, input),
  );
}

async function authorOneWatch(
  deps: AuthorWatchDeps,
  input: AuthorWatchRequest,
): Promise<AuthorWatchResult> {
  const compile = deps.compile;
  if (!compile) return { status: "no-compiler" };

  // A retry of a request that already installed something. Compiling again
  // would cost a model call and produce a second watch beside the first, and
  // arming is idempotent — it converges on the record this watch already has,
  // or mints the one that never appeared — so the retry finishes the job.
  const already =
    input.requestKey === undefined ? null : deps.definitions.findByRequestKey(input.requestKey);
  if (already) {
    // A key that names one watch and a rewrite that names another are two
    // different requests wearing one label. Answering either silently does the
    // wrong half: arming the key's watch skips the rewrite, and rewriting moves
    // the key onto a watch it was never issued for. The caller has to pick.
    if (input.replaces !== undefined && input.replaces !== already.id) {
      log.warn(
        `a request key already installed watch ${already.id} and this request asks to rewrite ${input.replaces}`,
      );
      return {
        status: "conflict",
        because: "this request key already belongs to a different watch",
      };
    }
    log.info(`watch ${already.name} was already installed for this request; arming it again`);
    return armInstalled(deps, already, input);
  }

  const result = await compile({
    request: input.request,
    ontology: await deps.ontology(),
    authoredBy: input.authoredBy,
    ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
  });
  if (result.status === "timed-out") return { status: "timed-out" };
  if (result.status === "no-model") return { status: "no-compiler" };
  if (result.status !== "compiled") {
    return {
      status: "refused",
      reasons: result.reasons,
      codes: result.codes,
      compileRunId: result.compileRunId,
    };
  }

  const document = documentFor(result.document, input);

  // Parsed after the block is written, so a delivery the DSL would refuse is a
  // refusal rather than a watch stored in a shape the runtime cannot read.
  const parsed = watchDslSchema.parse(document);
  const fromSeq = deps.journal.head();
  const stored: StoredWatch = {
    id: input.replaces ?? randomUUID(),
    name: parsed.watch.name,
    status: "active",
    dsl: document,
    addedAt: new Date().toISOString(),
    fromSeq,
    note: null,
    referenceDigest: null,
    compileRunId: result.compileRunId,
    requestKey: input.requestKey ?? null,
  };
  // Before the write, and it has to be: a rewrite reuses the watch's id, so
  // forgetting after would drop the runtime state of the watch just stored
  // rather than of the one it replaced.
  if (input.replaces !== undefined) deps.forget(input.replaces);
  try {
    await deps.writes.run(() => Promise.resolve(deps.definitions.put(stored)));
  } catch (error) {
    // Two creates carrying one key, racing: both read no existing watch above,
    // both compiled, and the second reaches the unique index the first has just
    // filled. That is the index doing its job — one watch per request — and it
    // is also the case the key exists for, so the loser converges on the
    // winner's watch rather than being refused. Sequentially this same request
    // would have found that row in the lookup above and armed it; arriving a
    // moment sooner must not change the answer.
    const winner =
      isRequestKeyCollision(error) && input.requestKey !== undefined
        ? deps.definitions.findByRequestKey(input.requestKey)
        : null;
    if (winner) {
      log.info(
        `two requests carrying one key raced; arming watch ${winner.name}, which the first installed`,
      );
      return armInstalled(deps, winner, input);
    }
    throw error;
  }

  log.info(
    `watch ${stored.name} ${input.replaces === undefined ? "compiled" : "recompiled"} from a request by the ${input.authoredBy}, watching from seq ${fromSeq}`,
  );
  return armInstalled(deps, stored, input);
}

/**
 * The last step, on its own: bring the stored watch's wake record into line.
 *
 * Separate because it is also the whole of a retry. Install-and-arm may not end
 * half-done — the definition is stored and active by the time this runs, so a
 * failure here leaves a watch that evaluates, spends judge budget and wakes
 * nobody, permanently, since nothing revisits a watch that never fired. So a
 * failure holds the watch with the reason written where an operator reads it,
 * rather than raising past a watch that is quietly running.
 *
 * Called for every watch, not only one that wakes an agent: a rewrite that
 * turns a wake into a push has a record to *retire*, and skipping the call for
 * want of a delivery block is how that record outlives the reason it existed.
 */
async function armInstalled(
  deps: AuthorWatchDeps,
  stored: StoredWatch,
  input: AuthorWatchRequest,
): Promise<AuthorWatchResult> {
  const wakes = wakesAnAgent(stored.dsl);
  let anchorSubscriptionId: string | null;
  try {
    anchorSubscriptionId = await deps.setWakeAnchor(stored.id, {
      ...(input.delivery?.kind === "agent-wake" ? { target: input.delivery.wake } : {}),
      authoredBy: input.authoredBy,
      ...(input.delivery?.kind === "agent-wake" && input.delivery.idempotencyKey !== undefined
        ? { idempotencyKey: input.delivery.idempotencyKey }
        : {}),
    });
  } catch (error) {
    return hold(deps, stored, error instanceof Error ? error.message : String(error));
  }
  // A watch that wakes an agent and came back with nothing is the same
  // half-done install as one that threw: it evaluates, spends judge budget and
  // reaches nobody. The path that answers null rather than throwing is the
  // ordinary one — no device holds the named harness, every key slot is spent,
  // the create converged on a record that is over — so leaving it out would
  // hold the rare failure and let the common one through.
  if (wakes && anchorSubscriptionId === null) {
    return hold(deps, stored, "no record could be minted for its wake");
  }
  // A retry arrives holding the row it was found by, which is the held one. The
  // job is finished now, so the hold has to be lifted here — nothing else
  // revisits it, and an anchor exists, so reconcile is satisfied and would
  // leave a watch nothing evaluates behind a record that is working.
  if (stored.status === "paused" && isUnarmedNote(stored.note)) {
    await deps.writes.run(() =>
      Promise.resolve(deps.definitions.setStatus(stored.id, "active", null)),
    );
    log.info(`watch ${stored.name} was armed on a retry; it is running again`);
    return {
      status: "installed",
      watch: { ...stored, status: "active", note: null },
      anchorSubscriptionId,
    };
  }
  return { status: "installed", watch: stored, anchorSubscriptionId };
}

/**
 * Stop the watch, and write the reason where an operator reads it.
 *
 * The note here is the general one, because all this path knows is that
 * nothing came back. Arming may already have written a note naming the actual
 * cause, and {@link holdUnarmed} is what keeps this from replacing it — which
 * is why the result is read back rather than assembled.
 */
async function hold(
  deps: AuthorWatchDeps,
  stored: StoredWatch,
  why: string,
): Promise<AuthorWatchResult> {
  const held = await deps.writes.run(() =>
    Promise.resolve(holdUnarmed(deps.definitions, stored.id, ANCHOR_UNMINTED_NOTE)),
  );
  log.warn(`watch ${stored.name} was held: its wake record could not be created (${why})`);
  return {
    status: "unarmed",
    watch: {
      ...stored,
      status: held?.status ?? "paused",
      note: held?.note ?? ANCHOR_UNMINTED_NOTE,
    },
  };
}

/**
 * Remove the watch a revoked record was the front of.
 *
 * Only for a watch an **integration** asked for, where the record is the thing
 * it manages and the watch is how that record is implemented. An operator's
 * watch owns its anchor the other way round — the watch is the thing they
 * wrote, and retiring its record is something the delivery block does — so
 * removing the watch here would delete work nobody asked to lose.
 *
 * Without this the definition keeps evaluating after the record is gone: it
 * wakes nobody, because a revoked anchor refuses a firing, but it goes on
 * spending judge budget on a watch its owner believes they deleted.
 */
export async function retireAuthoredWatch(
  deps: Pick<AuthorWatchDeps, "definitions" | "forget" | "writes">,
  watchId: string,
): Promise<void> {
  await deps.writes.run(() => Promise.resolve(deps.definitions.remove(watchId)));
  deps.forget(watchId);
  log.info(`removed watch ${watchId}: the record an integration asked for was revoked`);
}
