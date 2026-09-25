// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The operator's own watches, as their agent sees them.
 *
 * The agent hands over a condition in natural language; this port compiles it
 * against the live ontology, installs it, and wires it to push a notification
 * to the operator's own phones. That reaction is the only one this surface
 * expresses, and it is what makes the whole thing approval-free: the request
 * came from the user in conversation and the notification goes back to the
 * user, so nothing crosses a boundary anyone has to agree to.
 *
 * **What a caller may see depends on who is asking.** The operator reads every
 * watch on their own install — including one that wakes an off-host
 * integration, because "is the watch I asked for working?" is a question about
 * their own gateway — but may rewrite only a watch a rewrite cannot misdirect.
 * A watch installed with no delivery, or one that wakes an integration, is
 * therefore readable and not rewritable: repointing the first would attach a
 * notification nobody asked for, and repointing the second would aim another
 * integration's delivery somewhere its owner never agreed to. An integration
 * reaching this surface sees only the watches it asked to be woken by, so no
 * integration can enumerate another's.
 *
 * **The name is the compiler's.** It writes one from the request, in the
 * lowercase-kebab form every other surface displays, so the name the agent
 * says in a conversation is the name in the portal, the CLI and the push. A
 * second, prettier label held only here would be the one the user learns and
 * the one nothing else knows.
 *
 * `update` recompiles from scratch — a watch's condition is replaced, never
 * merged — and keeps the watch's identity, so an id the agent mentioned
 * earlier in the conversation still resolves afterwards.
 */

import { assertNever } from "@omnesis/core";
import { watchDslSchema, type WatchDefinition } from "@omnesis/watch";
import {
  WatchPortError,
  type ToolCaller,
  type WatchPort,
  type WatchPortDetail,
  type WatchPortEntry,
  type WatchPortProbe,
  type WatchPortResult,
} from "@omnesis/agent";

import { authorWatch, retireAuthoredWatch, type AuthorWatchDeps } from "../watch/authoring.js";
import type { PreflightOutcome } from "../watch/preflight.js";
import type { StoredWatch } from "../watch/definitions.js";

const APNS_UNCONFIGURED_WARNING =
  "This gateway has no push delivery configured, so the watch will match but no notification will arrive until it is set up.";

/** How much of a watch's history one `watch_get` carries. */
const FIRINGS_SHOWN = 20;

/** What one watch has said, as the runtime keeps it. */
export interface WatchFiringRecord {
  readonly firedAt: string;
  readonly payload: unknown;
}

export interface CreateGatewayWatchPortOpts {
  /**
   * Getter form on purpose: the watch runtime is assembled after the agent
   * service during gateway boot, and an install with no runtime has none at
   * all. Tools call this only at invocation time, well after the whole graph
   * is wired.
   */
  getAuthoring: () => AuthorWatchDeps | null;
  /** What each watch has said, newest first. */
  firings: (watchId: string, limit?: number) => ReadonlyArray<WatchFiringRecord>;
  /**
   * How many times a watch has caught something.
   *
   * Counted rather than derived from {@link firings}, which is bounded — and
   * counted over organic firings only, because a firing the operator forced by
   * hand is not something the watch found, and this is the number the model
   * relays when they ask whether it is working.
   */
  firingCount: (watchId: string) => number;
  /**
   * Whether `gateway.apns` is currently configured. Read fresh per call so a
   * hot-reloaded config flips it without a restart. Defaults to `true`.
   */
  isApnsConfigured?: () => boolean;
  /**
   * Try a candidate over the tail of the journal. Getter-free because it is
   * pure of the runtime's own state — it builds a throwaway engine — but
   * optional because an install with no watch runtime has nothing to try
   * against.
   */
  preflight?: (watch: WatchDefinition, opts: { events?: number }) => Promise<PreflightOutcome>;
}

/**
 * What a watch does when it fires, as far as this surface is concerned.
 *
 * Read from the stored definition rather than from a column beside it, because
 * the definition is what the runtime obeys — a watch whose record said one
 * thing and whose DSL said another would be described here as the thing it is
 * not.
 */
type Visibility = "manageable" | "read-only" | "hidden";

/**
 * What one caller may do with one watch.
 *
 * Reading and managing are separate questions, and collapsing them is what made
 * the operator's own agent answer that a watch they had just commissioned did
 * not exist. Rewriting a watch that wakes an integration would aim that
 * integration's delivery somewhere its owner never agreed to, so no surface but
 * the approving one may do it — but describing one costs nothing, stores
 * nothing and asks no model, and refusing that protected nobody: it is the
 * operator's own gateway, and the watch is running in it.
 *
 * So the operator reads everything and manages only what a rewrite cannot
 * misdirect, while an integration sees its own watches and cannot learn that
 * another integration's exist.
 */
function visibilityFor(watch: StoredWatch, caller: ToolCaller): Visibility {
  const parsed = watchDslSchema.safeParse(watch.dsl);
  // A definition this build cannot read is nothing the agent can act on, and
  // describing it from the row's name alone would offer a rewrite that would
  // then fail. The admin surface still shows it.
  if (!parsed.success) return "hidden";
  const delivery = parsed.data.watch.delivery;
  if (caller.kind === "integration") {
    // Only what this integration itself asked to be woken by. Everything else —
    // the operator's own notifications, another integration's watches, a watch
    // that notifies nobody — is not merely unmanageable but unknowable, because
    // an enumerable inventory is itself a disclosure.
    //
    // Read-only rather than manageable even for its own: authoring through this
    // port stamps a watch as the operator's and points it at their devices, so
    // a rewrite here would answer a request the integration never made. It
    // manages its watches through the surface that approved them.
    return delivery?.kind === "agent-wake" && delivery.integration === caller.slug
      ? "read-only"
      : "hidden";
  }
  if (delivery === undefined) return "read-only";
  return delivery.kind === "omnesis-notify" ? "manageable" : "read-only";
}

/**
 * The condition as the compiler stated it for a model to rule on.
 *
 * The nearest thing a compiled watch has to a reading of the request: the plan
 * itself is unreadable prose to whoever asked, and a proposition is the one
 * part of it written to be decided in plain language.
 *
 * Two places carry one. A recall-driven source declares its judge inline —
 * nomination is never firing, so the DSL requires it there — and a deliberate
 * `llm` node carries its own. Both are read, in node order, because a watch
 * that has either is better described by it than by its name; a purely
 * structural watch has neither and falls back.
 */
function propositionOf(definition: WatchDefinition): string | undefined {
  for (const node of definition.nodes) {
    if ("judge" in node && node.judge) return node.judge.proposition;
    if (node.type === "llm") return node.proposition;
  }
  return undefined;
}

function readDefinition(watch: StoredWatch): WatchDefinition | null {
  const parsed = watchDslSchema.safeParse(watch.dsl);
  return parsed.success ? parsed.data.watch : null;
}

export function createGatewayWatchPort(opts: CreateGatewayWatchPortOpts): WatchPort {
  /**
   * Refuse a fresh authoring from anyone but the operator.
   *
   * Authoring through this port stamps the watch as the operator's and wires it
   * to their own devices, so a create from an integration would put words in
   * their mouth and a notification on their phone. `update` and `remove` need
   * no such guard — they name a watch, and no watch is ever manageable by an
   * integration here — but a create names none, so the caller is the only thing
   * there is to check.
   *
   * The write tools are unreachable off-host today (the sub-agent selector
   * drops everything declaring `mutates`), which makes this a guard against
   * that stopping being true rather than against a caller that exists.
   */
  function operatorOnly(caller: ToolCaller): void {
    if (caller.kind === "operator") return;
    throw new WatchPortError({
      reason: "not_manageable",
      watchId: "",
      message: "only the operator's own surface can author a watch here",
    });
  }

  function authoring(): AuthorWatchDeps {
    const deps = opts.getAuthoring();
    if (!deps) {
      throw new WatchPortError({
        reason: "compiler_unavailable",
        message: "this gateway has no watch runtime, so it cannot author watches",
      });
    }
    return deps;
  }

  /** A watch this surface owns, or a rejection naming why it does not. */
  function manageable(caller: ToolCaller, watchId: string): StoredWatch {
    const watch = authoring().definitions.get(watchId);
    if (!watch || visibilityFor(watch, caller) === "hidden") {
      throw new WatchPortError({ reason: "not_found", watchId });
    }
    if (visibilityFor(watch, caller) === "read-only") {
      throw new WatchPortError({
        reason: "not_manageable",
        watchId,
        message: refusalFor(watch),
      });
    }
    return watch;
  }

  /**
   * Why this watch cannot be rewritten here, in terms of the watch itself.
   *
   * Two different watches are read-only for two opposite reasons, and one
   * sentence for both told the operator the wrong thing about whichever it was
   * not: a watch that wakes an integration does notify someone, and saying it
   * "records its firings without notifying anyone" is a plain falsehood about
   * the loudest thing it does.
   */
  function refusalFor(watch: StoredWatch): string {
    const parsed = watchDslSchema.safeParse(watch.dsl);
    const delivery = parsed.success ? parsed.data.watch.delivery : undefined;
    if (delivery?.kind === "agent-wake") {
      return `${watch.name} wakes ${delivery.integration} when it fires; rewriting it here would repoint a delivery that integration asked for`;
    }
    return `${watch.name} records its firings without notifying anyone; rewriting it here would attach a notification nobody asked for`;
  }

  function toEntry(
    caller: ToolCaller,
    watch: StoredWatch,
    definition: WatchDefinition | null,
  ): WatchPortEntry {
    // Oldest first, as the store hands them over — so the most recent is the
    // last one, not the first. Reading it the other way answers "when did this
    // watch first fire" to a question that asked when it last did.
    // One row for the instant, a COUNT for the number. Reading the count off a
    // bounded page would make every watch report having fired once — and a
    // watch that has fired fifty times would read the same as one that has
    // fired at all, on the number the model relays when the operator asks
    // whether it is working.
    const firings = opts.firings(watch.id, 1);
    const last = firings[firings.length - 1];
    return {
      watchId: watch.id,
      name: watch.name,
      ...(definition?.nl_query === undefined ? {} : { request: definition.nl_query }),
      enabled: watch.status === "active",
      ...(watch.note === null ? {} : { note: watch.note }),
      manageable: visibilityFor(watch, caller) === "manageable",
      firedCount: opts.firingCount(watch.id),
      ...(last === undefined ? {} : { lastFiredAt: last.firedAt }),
    };
  }

  async function author(
    action: "created" | "updated",
    input: { request: string; notify?: { title?: string; body?: string } },
    replaces?: string,
  ): Promise<WatchPortResult> {
    const deps = authoring();
    const result = await authorWatch(deps, {
      request: input.request,
      authoredBy: "operator",
      delivery: {
        kind: "omnesis-notify",
        ...(input.notify?.title === undefined ? {} : { title: input.notify.title }),
        ...(input.notify?.body === undefined ? {} : { body: input.notify.body }),
      },
      ...(replaces === undefined ? {} : { replaces }),
    });

    switch (result.status) {
      case "no-compiler":
        throw new WatchPortError({
          reason: "compiler_unavailable",
          message: "no model is assigned for compiling watches on this gateway",
        });
      case "refused":
        // The compiler's own words, unlike the integration route, which is
        // handed the closed vocabulary instead. This port belongs to the
        // interactive agent — the operator's own, reading the operator's own
        // corpus through the same model on every other turn — so a reason that
        // mentions what the compiler found crosses nothing it has not crossed
        // already, and it is what makes the refusal actionable in the reply.
        //
        // See #1813 — that argument holds for the interactive agent and is
        // what the issue is about: the write tools are unreachable off-host
        // (`selectSubagentTools` drops everything declaring `mutates`), so a
        // refusal message quoting the corpus is only ever read by the operator
        // whose corpus it is. If a create or update path ever becomes reachable
        // from the answer profile, this message becomes an unscoped disclosure
        // and has to be narrowed to `code` the way the integration route is.
        //
        // The code is the compiler's too, rather than a fixed
        // `unsupported_condition`: the tool's description tells the model that
        // one means the condition cannot be expressed and it should stop
        // rephrasing, which is the wrong instruction for a compile that simply
        // failed and is worth another attempt.
        throw new WatchPortError({
          reason: "uncompilable",
          code: result.codes[0] ?? "unsupported_condition",
          message: result.reasons.join("; "),
        });
      case "timed-out":
        throw new WatchPortError({
          reason: "timed_out",
          message: "the compiler ran out of time; the same request may work on another attempt",
        });
      case "unarmed":
        // The watch exists and is held. Reported as a failure, because the
        // agent asked to be woken and nothing will wake it — and named as the
        // arming rather than the condition, so the model retries the request
        // instead of rewriting a condition that compiled perfectly well.
        throw new WatchPortError({
          reason: "unarmed",
          watchId: result.watch.id,
          message:
            "the watch was written and installed, and the record that wakes you could not be created; it is held until one is. Asking again with the same request finishes the job.",
        });
      case "conflict":
        // Neither the condition nor the model is the problem, and neither
        // rephrasing nor waiting helps: the request names a watch the key it
        // carries does not belong to, or another request carrying that key got
        // there first. Only the caller can say which watch it meant.
        throw new WatchPortError({ reason: "conflict", message: result.because });
      case "installed": {
        const definition = readDefinition(result.watch);
        const warnings: string[] = [];
        if (!(opts.isApnsConfigured?.() ?? true)) warnings.push(APNS_UNCONFIGURED_WARNING);
        return {
          action,
          watchId: result.watch.id,
          name: result.watch.name,
          enabled: result.watch.status === "active",
          interpretation:
            (definition ? propositionOf(definition) : undefined) ??
            definition?.nl_query ??
            input.request,
          warnings,
        };
      }
      default:
        return assertNever(result);
    }
  }

  return {
    create: (caller, input) => {
      operatorOnly(caller);
      return author("created", input);
    },

    // Async so a rejection is a rejected promise rather than a synchronous
    // throw: the guard below runs before any await, and a caller attaching
    // `.catch` to a method declared to return one would otherwise miss it.
    async update(caller, input) {
      // Read before compiling: a caller holding a stale id should learn that
      // now rather than after a model call that costs a minute.
      manageable(caller, input.watchId);
      return author("updated", input, input.watchId);
    },

    async remove(caller: ToolCaller, watchId: string): Promise<void> {
      const watch = manageable(caller, watchId);
      await retireAuthoredWatch(authoring(), watch.id);
    },

    list(caller: ToolCaller): Promise<ReadonlyArray<WatchPortEntry>> {
      const watches = opts
        .getAuthoring()
        ?.definitions.list()
        .filter((watch) => visibilityFor(watch, caller) !== "hidden");
      return Promise.resolve(
        (watches ?? []).map((watch) => toEntry(caller, watch, readDefinition(watch))),
      );
    },

    /**
     * Try a watch against the recent past, so this surface can check its own
     * work before saying a watch is set up.
     *
     * Only a watch this surface may manage. A `hidden` one is not the
     * operator's to inspect from here, and reporting on it would leak the
     * existence of a record an agent did not author.
     */
    async probe(caller: ToolCaller, watchId: string): Promise<WatchPortProbe> {
      const watch = opts.getAuthoring()?.definitions.get(watchId);
      if (!watch || visibilityFor(watch, caller) === "hidden") {
        throw new WatchPortError({ reason: "not_found", watchId });
      }
      const definition = readDefinition(watch);
      if (!definition) {
        throw new WatchPortError({
          reason: "not_manageable",
          watchId,
          message: "this build cannot read that watch's definition",
        });
      }
      const run = opts.preflight;
      if (!run) {
        throw new WatchPortError({
          reason: "compiler_unavailable",
          message: "this gateway has no running watch engine to try a watch against",
        });
      }
      const result = await run(definition, {});
      if (result.outcome === "refused") {
        throw new WatchPortError({
          reason: "compiler_unavailable",
          message:
            result.refusal.reason === "cannot-score"
              ? "this gateway cannot score a recall arm: no embedder model is assigned"
              : result.refusal.reason === "empty-journal"
                ? "the watch journal is empty, so there is nothing to try this against yet"
                : result.refusal.reason === "no-runtime"
                  ? "this gateway has no running watch engine to try a watch against"
                  : result.refusal.reason === "empty-window"
                    ? "nothing was observed in that window, though the journal is not empty"
                    : `that watch no longer validates: ${result.refusal.diagnostics.join(", ")}`,
        });
      }
      const report = result.report;
      return {
        events: report.window.events,
        from: report.window.from,
        to: report.window.to,
        firings: report.firings,
        judgeGated: report.judgeGated,
        nodes: report.nodes.map((node): WatchPortProbe["nodes"][number] => ({
          nodeId: node.nodeId,
          evaluated: node.evaluated,
          matched: node.matched,
          wouldAsk: node.wouldAsk,
          diagnostics: node.diagnostics,
          samples: node.samples.map((sample) => ({
            seq: sample.seq,
            transition: sample.transition,
            ...(sample.detail === undefined ? {} : { detail: sample.detail }),
          })),
        })),
      };
    },

    // See #1813 — the answer profile holds this tool, so a watch's compiler-
    // authored interpretation is reachable from a path that serves off-host
    // agents (reviewed and ledgered, but not deliberately scoped). The same
    // question applies to the refusal messages on the create/update path
    // above, for the opposite reason: those are unreachable off-host today,
    // and only because the write tools declare `mutates`.
    get(caller: ToolCaller, watchId: string): Promise<WatchPortDetail | null> {
      const watch = opts.getAuthoring()?.definitions.get(watchId);
      if (!watch || visibilityFor(watch, caller) === "hidden") return Promise.resolve(null);
      const definition = readDefinition(watch);
      const proposition = definition ? propositionOf(definition) : undefined;
      return Promise.resolve({
        ...toEntry(caller, watch, definition),
        ...(proposition === undefined ? {} : { interpretation: proposition }),
        createdAt: watch.addedAt,
        // The most recent, newest first. Taken from the end because the store
        // orders oldest first: a watch that has fired for months would
        // otherwise show the agent what it said when it was new, and nothing
        // since.
        firings: [...opts.firings(watch.id, FIRINGS_SHOWN)]
          .reverse()
          .map((firing) => ({ firedAt: firing.firedAt, payload: firing.payload })),
      });
    },
  };
}
