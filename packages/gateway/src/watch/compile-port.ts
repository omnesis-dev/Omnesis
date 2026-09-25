// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Compiling a request into a watch, on a live install.
 *
 * The compiler takes natural language and returns a validated watch or a
 * refusal with reasons. It was built and measured against synthetic universes,
 * where the ontology, the journal and the worked examples all sit in one
 * directory on disk. A live install has none of that shape: its ontology is
 * assembled from the running gateway, and its journal is a table.
 *
 * This is the adapter across that gap, and it is deliberately thin. One thing
 * differs from a universe compile, and it is stated where it happens: the
 * ontology is the caller's. The replay the loop reads its reach numbers off runs
 * over the live journal instead of a universe directory, through the port in
 * `live-backtest.ts`.
 *
 * The worked examples still come from the repository's own universe, because
 * they are prompt material rather than substrate — they show the compiler what
 * a good watch looks like, not what this install contains.
 */

import { randomUUID } from "node:crypto";
import { compile, examplesFor, NO_USAGE, validateWatch } from "@omnesis/watch";
import { createLogger, type AgentEvent, type Logger } from "@omnesis/core";
import { synthesizeSingleShotTurn } from "./compile-run.js";
import type {
  LoopBacktest,
  WatchDefinition,
  ChatMessage,
  ChatModel,
  Ontology,
  PersonDirectoryEntry,
  RefusalCode,
  WatchDiagnostic,
} from "@omnesis/watch";
import type {
  WatchCompileOutcome,
  WatchCompileRecorder,
  WatchCompileRecording,
} from "./compile-run.js";
import type { WatchV2Author } from "../subscriptions/watch-v2-plan.js";

const log: Logger = createLogger("gateway").child("watch-v2:compile");

/** What this needs of a completion backend: one turn, many messages, text out. */
export interface CompletionBackend {
  readonly name?: string;
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

/**
 * One request to compile, with the provenance the ledger records alongside it.
 *
 * `authoredBy` and `replaces` are not compiler inputs — the compiler writes
 * the same watch whoever asked. They are here because this is where a compile
 * is written down, and a run row that could not say who asked for it, or
 * whether it was rewriting something that already existed, would be a record
 * of a compile with no history.
 */
export interface CompilePortRequest {
  readonly request: string;
  readonly ontology: Ontology;
  readonly authoredBy: WatchV2Author;
  /** The watch this compile rewrites, when it replaces one. */
  readonly replaces?: string;
  /**
   * Whether the caller wants the document rather than a running watch.
   *
   * Changes nothing about how the compile is done — same prompt, same tools,
   * same repair loop, same deadline — and everything about what the ledger
   * says it was for. A compiler measured on a mode of its own would be a
   * measurement of that mode.
   */
  readonly compileOnly?: boolean;
  /**
   * Compile without replaying the candidate, when the caller asks.
   *
   * The replay and the revision it can trigger are one intervention, and this
   * turns off all of it — a switch that left the revision running would compare
   * two compilers rather than one compiler with and without its replay.
   *
   * It exists so the loop can be measured against itself on the same install in
   * the same session: what the replay costs in latency is only meaningful beside
   * what the same requests cost without it, and a control drawn from a different
   * day is a control for the day as much as for the loop.
   */
  readonly withoutBacktest?: boolean;
}

export type CompileOutcome =
  | {
      status: "compiled";
      document: unknown;
      /**
       * The validator's verdict on the document being handed back.
       *
       * Empty of errors by construction — the repair loop does not stop until
       * it is — so what this carries is the **warnings**: a watch bound to a
       * dated thing with no horizon, a deadline that never expires, an
       * investigation with no budget. They are the difference between a watch
       * that compiles and a watch worth installing.
       *
       * A reason rather than a code, in the sense the refusal vocabulary means:
       * a diagnostic quotes the watch the model wrote, and the model reads the
       * corpus, so one can carry a person id or a term it found there. Only a
       * surface that already sees the document itself may see these — which
       * today is the admin route and nothing else.
       */
      diagnostics: readonly WatchDiagnostic[];
      /**
       * What this candidate would have done over the history it was replayed
       * against, when it was replayed at all.
       *
       * Null when nothing replayed it — no runtime, a candidate the replay
       * cannot score, a journal too young to say anything. Null is not zero, and
       * a caller must not read it as one: a watch that reached nothing and a
       * watch nobody replayed are opposite facts, and only one of them is worth
       * acting on.
       *
       * Surfaced whether or not it moved the compile. A clean replay changes
       * nothing about the watch and is still the most useful thing an asker can
       * be told about it — "this would have fired 0 times in 12 days" is the
       * sentence that stops a watch being installed and then quietly never
       * firing.
       */
      backtest: LoopBacktest | null;
      compileRunId: string | null;
    }
  | {
      status: "refused";
      /**
       * The ledger row this refusal was written to, when the write landed.
       *
       * Carried on a refusal as much as on a success: a refusal is the case an
       * operator most needs to read the transcript of, and without the id the
       * only way to find it is to scan the runs list for the right timestamp.
       */
      compileRunId: string | null;
      /**
       * The model's own words — for this corpus's owner and the gateway log,
       * and for nobody else. The compiler reads the corpus while it works, so
       * a reason can quote what it read; {@link RefusalCode} is the channel
       * that crosses a machine boundary.
       */
      reasons: readonly string[];
      /** What about the request could not be written. Safe to hand back. */
      codes: readonly RefusalCode[];
    }
  /**
   * No model is assigned for compiling.
   *
   * Its own outcome rather than a refusal, for the reason a timeout is: an
   * agent told its condition was unsupported stops asking, and this install
   * never looked at the condition at all.
   */
  | { status: "no-model" }
  /**
   * The model did not finish in the time it was given.
   *
   * Kept apart from a refusal because they mean opposite things to whoever
   * asked. A refusal is the compiler declining, and asking the same question
   * again gets the same answer; a timeout is the install not managing to ask,
   * and the same question may well work next time. Collapsing them tells
   * someone their request was unreasonable when nothing was ever decided.
   */
  | { status: "timed-out"; compileRunId: string | null };

/**
 * The compiler's chat interface over a completion backend.
 *
 * The backend takes one prompt string; the compiler speaks in messages. They
 * are joined with their roles named, because the prompt's structure carries
 * meaning the compiler relies on — the system half is the contract and the
 * last message is the request, and a flattening that lost the boundary would
 * let a request read as an instruction to the compiler itself.
 */
function chatModel(
  backend: CompletionBackend,
  sessionId: string,
  recording: WatchCompileRecording | null,
): ChatModel {
  let turn = 0;
  return {
    name: backend.name ?? "background-agent",
    async complete(messages: readonly ChatMessage[]) {
      const prompt = messages.map((m) => `<|${m.role}|>\n${m.content}`).join("\n\n");
      const text = await backend.complete(prompt, { maxTokens: 8_000 });
      turn += 1;
      // There is no session behind this path and so no event stream, but the
      // ledger's transcript is one — so the turn is written down as the events
      // it would have produced. The first turn records the whole flattened
      // prompt, which is exactly what the backend was sent; a repair turn
      // records only its last message, because everything before it is a
      // verbatim repeat of what the transcript already shows.
      const shown = turn === 1 ? prompt : (messages[messages.length - 1]?.content ?? prompt);
      for (const event of synthesizeSingleShotTurn({
        sessionId,
        turn,
        prompt: shown,
        reply: text,
      })) {
        recording?.record(event);
      }
      // The backend reports no usage through this interface; the compiler
      // sums what it is given, so zero is the honest contribution rather than
      // an invented one.
      return { text, usage: NO_USAGE };
    },
  };
}

/**
 * Worked examples for the prompt, when this install has them.
 *
 * They live in the fixture universes, which the package deliberately does not
 * publish — so a gateway running from a checkout finds them and one running
 * from an installed package does not. A compiler with no examples still
 * compiles; it simply has less to go on. Failing the request over missing
 * prompt material would be a worse trade than compiling without it, and the
 * warning says which of the two happened.
 */
let warnedAboutExamples = false;
function workedExamples(): ReturnType<typeof examplesFor> {
  try {
    return examplesFor();
  } catch (error) {
    if (!warnedAboutExamples) {
      warnedAboutExamples = true;
      log.warn(
        `compiling without worked examples — this install has no fixture universes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return [];
  }
}

/**
 * Whether this is a deadline rather than a fault.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException, and a
 * fetch aborted by one surfaces as an `AbortError`. Matched on name because
 * that is the only stable thing about them across runtimes — neither is an
 * instance of a class this package can reference.
 */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long one model call may take while compiling.
 *
 * The caller waiting on it is often an off-host agent whose adapter has its own
 * socket budget, and that budget has to be the larger of the two — an adapter
 * that gives up first sees every successful create as a failure and retries it.
 * `SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS` is what the adapters allow;
 * `compile-port.test.ts` holds this under it.
 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 180_000;

export interface CompilePortDeps {
  /** Null when no model is assigned for this work. */
  readonly backend: () => CompletionBackend | null;
  /**
   * The people to name in the prompt, already bounded and ranked.
   *
   * Separate from the ontology on purpose. The ontology is what a watch may
   * address and the fingerprint it is validated against; this is prompt
   * material, and on an install with a directory of tens of thousands the two
   * cannot be the same list — rendering the whole of it puts the request past
   * every model's context window.
   */
  readonly people: () => readonly PersonDirectoryEntry[];
  // See #69 — measured against a real install, this deadline is reached on
  // 18% of attempts, and the requests that reach it are not the easy ones.
  /**
   * How long one model turn may take, from this install's configuration.
   *
   * The deadline belongs to the caller, not to whatever default a backend
   * shipped with: a compile is tens of thousands of prompt tokens and a
   * document back, and the completion default sized for a short expansion
   * aborts it mid-answer.
   *
   * This is the **session** path's deadline; the single-shot backend arrives
   * already bounded, because a completer's timeout is fixed when it is loaded
   * and there is no signal to hand it afterwards. Both come from one config
   * value read in one place, so which path an install runs does not change how
   * long its caller waits.
   */
  readonly timeoutMs: () => number;
  /**
   * Replay a validated candidate over this install's own history.
   *
   * Absent on a gateway with no runtime to replay against, and the candidate is
   * then returned on the strength of the validator alone. Present, the reach
   * concern and the single revision that follows it run against the substrate
   * the watch will actually live on, rather than against a universe nobody
   * runs.
   */
  readonly backtest?: (watch: WatchDefinition) => Promise<LoopBacktest | null>;
  /**
   * A model that can look things up, or `null` when this install has none.
   *
   * Preferred over `backend` wherever it resolves. A compiler holding the
   * gateway's read surface resolves the people a request names instead of
   * hunting for them in a bounded list, and finds out what a request means
   * here instead of inferring it from a digest.
   *
   * **Required**: an install with no chat runtime says so by answering `null`,
   * rather than by leaving the field out. The two paths produce the same shape
   * of result, so an unwired one is invisible from every surface downstream —
   * the compile succeeds, the watch installs, and only the quality of the
   * bounds differs. Requiring the field is what makes that unwireable.
   *
   * The deadline travels with the request for the same reason: a session built
   * without one would run a turn nobody is waiting on any more.
   */
  readonly session: (
    sessionId: string,
    opts: { timeoutMs: number; onEvent: (event: AgentEvent) => void },
  ) => { model: ChatModel; toolNames: readonly string[] } | null;
  /**
   * Where a compile is written down.
   *
   * **Required**, for the reason {@link CompilePortDeps.session} is: a compile
   * that records nothing looks, from every surface, exactly like one that was
   * recorded — the watch installs either way and only the ledger is emptier.
   * An install that genuinely cannot record says so by answering `null`, and
   * that answer is a fact somebody chose rather than a wire nobody ran.
   */
  readonly record: () => WatchCompileRecorder | null;
}

/**
 * Compile a request against this install's own ontology, or refuse.
 *
 * A request that arrives with no model assigned comes back as `no-model`
 * rather than throwing: the caller asked a reasonable question of an install
 * that cannot answer it, which is an answer — and a different one from the
 * compiler having considered the condition and declined.
 */
export function createCompilePort(
  deps: CompilePortDeps,
): (input: CompilePortRequest) => Promise<CompileOutcome> {
  return async ({ request, ontology, authoredBy, replaces, compileOnly, withoutBacktest }) => {
    // Begun before either path is chosen, so a compile is on the record from
    // the moment it starts rather than from the moment it succeeds.
    const recording =
      deps.record()?.begin({
        request,
        authoredBy,
        ...(replaces === undefined ? {} : { replaces }),
        ...(compileOnly === undefined ? {} : { compileOnly }),
        ...(withoutBacktest === undefined ? {} : { withoutBacktest }),
      }) ?? null;
    // A session that can look things up, or the single shot of text that was
    // here before it. Chosen per request rather than at construction, so an
    // install gains the tools the moment its agent runtime is wired.
    const sessionId = `watch-compile-${randomUUID()}`;
    const looking = deps.session(sessionId, {
      timeoutMs: deps.timeoutMs(),
      onEvent: (event) => recording?.record(event),
    });
    const backend = looking ? null : deps.backend();
    // Nothing is recorded for an install with no model assigned. No condition
    // was considered, no turn ran and there is no transcript — a row saying so
    // would be a run that never happened, and the log line below is where the
    // install's own missing wiring belongs.
    if (!looking && !backend) return { status: "no-model" };
    // Which of the two ran, said out loud. They differ only in the quality of
    // the watch they produce, so without this an install has no way to tell
    // whether its compiler can reach the corpus at all.
    log.info(
      looking
        ? `compiling ${sessionId} with ${looking.toolNames.length} read tool(s)`
        : `compiling ${sessionId} from a single prompt — no chat runtime to look things up with`,
    );
    const model = looking?.model ?? chatModel(backend!, sessionId, recording);
    recording?.begins(looking ? "session" : "single-shot", model.name);
    let result: Awaited<ReturnType<typeof compile>>;
    try {
      result = await compile(
        request,
        {
          ontology,
          // With tools, the directory stops being how a person is reached and
          // becomes a starting point: the user, whom every watch about "me"
          // needs, and the handful the host thought worth naming. Everyone
          // else is resolved on demand, which is what makes a request about
          // somebody outside a bounded list compilable at all.
          people: deps.people(),
          loops: [],
          examples: workedExamples(),
          ...(looking ? { retrieval: looking.toolNames } : {}),
        },
        model,
        {
          // The ontology is this install's, assembled from the gateway rather
          // than read from a universe, so the file comparison that protects the
          // compile/validate invariant is the wrong way to state it here.
          ontologyIsCallers: true,
          // What the candidate would actually have done, measured on this
          // install. Without it the compiler returns on the validator alone —
          // legal, and unmeasured against the only history that exists.
          ...(deps.backtest ? { backtest: deps.backtest } : {}),
          // One mechanism, in the compiler's own vocabulary. Withholding the
          // `backtest` dependency above instead would work only because this
          // call site always claims the ontology, which is what stops the
          // compiler falling back to a universe replay — a switch resting on
          // that would silently turn back on if the claim ever changed.
          ...(withoutBacktest === true ? { skipBacktest: true } : {}),
        },
      );
    } catch (error) {
      if (!isTimeout(error)) {
        // Settled before rethrowing: a compile that died on a backend fault is
        // the one an operator will come looking for, and an unrecorded throw
        // leaves the ledger claiming the compile never happened.
        await settle(recording, { kind: "error", message: errorText(error) });
        throw error;
      }
      log.warn(`a compile ran out of time: ${errorText(error)}`);
      return { status: "timed-out", compileRunId: await settle(recording, { kind: "timed-out" }) };
    }
    if (result.status === "compiled") {
      log.info(`compiled a watch from a request in ${result.attempts.length} attempt(s)`);
      return {
        status: "compiled",
        document: result.document,
        // Re-asked of the document rather than read off the last attempt: the
        // accepted document is not always the last one the model wrote — a
        // reach or bounds revision can supersede it — and diagnostics taken
        // from the wrong turn would describe a watch nobody is installing.
        diagnostics: validateWatch(result.document, ontology).diagnostics,
        backtest: result.report,
        compileRunId: await settle(recording, {
          kind: "compiled",
          attempts: result.attempts.length,
          // Four numbers rather than the whole report: the ledger keeps what a
          // reader needs to tell "this was measured and looked fine" from "this
          // was never measured", and the per-node detail lives in the answer and
          // in the probe an operator can re-run for themselves.
          ...(result.report
            ? {
                backtest: {
                  days: result.report.days,
                  events: result.report.events,
                  firings: result.report.firings,
                  totalReaches: result.report.totalReaches,
                },
              }
            : {}),
        }),
      };
    }
    // Two ways to come back without a watch, and they mean different things to
    // whoever asked. A **refusal** is the compiler declining to write a watch
    // it could not justify — the reasons are what turn that into a better
    // question. A **failure** is the model not producing something legal after
    // its repairs; the diagnostics name what was wrong with the last attempt,
    // and asking the same question again may well work. Collapsing them would
    // tell a caller their request was unreasonable when the model simply
    // fumbled the syntax.
    if (result.status === "refused") {
      log.info(
        `refused to compile a watch (${result.codes.join(", ")}): ${result.reasons.join("; ")}`,
      );
      return {
        status: "refused",
        reasons: result.reasons,
        codes: result.codes,
        compileRunId: await settle(recording, {
          kind: "refused",
          codes: result.codes,
          reasons: result.reasons,
          attempts: result.attempts.length,
        }),
      };
    }
    // A validator diagnostic quotes the watch the model wrote, and since the
    // compiler reads the corpus that watch can carry a person's id, an address
    // or a term it found there. So the diagnostics are a reason — logged and
    // shown to this corpus's owner — and never a code.
    const diagnostics = result.diagnostics.map((d) => d.code ?? d.message ?? "invalid");
    const reasons = [
      `the compiler could not produce a valid watch (${result.reason})`,
      ...diagnostics,
    ];
    log.warn(
      `could not compile a watch after ${result.attempts.length} attempt(s) (${result.reason}): ${diagnostics.join(", ")}`,
    );
    return {
      status: "refused",
      reasons,
      codes: ["compiler_failed"],
      // Recorded as the failure it is, not as the refusal it is answered as.
      // The caller is handed one shape because there is one thing it can do
      // about either; the ledger keeps the distinction, because "the compiler
      // declined" and "the model could not write valid syntax" send an
      // operator to two different places.
      compileRunId: await settle(recording, {
        kind: "failed",
        reason: result.reason,
        diagnostics,
        attempts: result.attempts.length,
      }),
    };
  };
}

/**
 * Write the recording down and report the run id, or null when there is none.
 *
 * Null covers both an install that is not recording and a row that failed to
 * land: a caller stores this id on a watch revision, and a durable reference
 * to a run the ledger never received is a link to nothing.
 */
async function settle(
  recording: WatchCompileRecording | null,
  outcome: WatchCompileOutcome,
): Promise<string | null> {
  if (!recording) return null;
  return (await recording.settle(outcome)) ? recording.runId : null;
}
