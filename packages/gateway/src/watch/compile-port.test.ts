// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Compiling a request on a live install.
 *
 * The compiler was built against synthetic universes, where the ontology and
 * the journal are files in one directory. This adapter is what lets it run
 * against an install that has neither, and the things worth pinning are the
 * ones a caller acts on: that a request reaches the model with its structure
 * intact, and that the three ways of coming back without a watch stay
 * distinguishable.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it, vi } from "vitest";

import { Ontology, validateWatch } from "@omnesis/watch";

import { SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS } from "@omnesis/types";

import {
  createCompilePort,
  DEFAULT_COMPILE_TIMEOUT_MS,
  type CompletionBackend,
} from "./compile-port.js";
import type { ChatMessage, ChatModel } from "@omnesis/watch";

/**
 * A small install, in the shape the gateway assembles one.
 *
 * Deliberately not a fixture universe: those are unpublished, and the point
 * here is the *install* path — an ontology built from queries rather than read
 * from a directory. What the compiler does with a large one is its own suite's
 * business; what matters here is that a request survives the crossing.
 */
const ontology = Ontology.parse({
  fingerprint: "an-install-fingerprint",
  sources: [
    {
      sourceId: "mailbox:someone@example.com",
      providerId: "mailbox",
      profile: { documentTypes: ["email"], personRoles: ["sender"], metadataFields: [] },
      semanticallyIndexed: true,
    },
  ],
  analyticsTables: [],
  people: [],
});

describe("compiling against an install rather than a universe", () => {
  it("answers rather than throws when no model is assigned", async () => {
    // A caller asked a reasonable question of an install that cannot answer
    // it. That is an answer, and a refusal carries the reason back; a throw
    // would surface as a 500 on a correctly-configured request.
    const port = createCompilePort({
      backend: () => null,
      people: () => [],
      timeoutMs: () => 60_000,
      record: () => null,
      session: () => null,
    });

    const result = await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships",
      ontology,
    });

    // Not a refusal: nothing about the condition was decided, and an agent told
    // its condition was unsupported stops asking.
    expect(result).toEqual({ status: "no-model" });
  });

  it("resolves the backend per request, so a model assigned later is picked up", async () => {
    // The assignment can change while the gateway runs. A backend captured at
    // construction would leave an install compiling with a model the operator
    // had already replaced — or refusing forever after assigning one.
    const resolve = vi.fn<() => CompletionBackend | null>().mockReturnValue(null);
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: resolve,
      people: () => [],
      session: () => null,
    });

    await port({ authoredBy: "operator", request: "one", ontology });
    await port({ authoredBy: "operator", request: "two", ontology });

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("puts the bounded directory in front of the model, not the ontology's copy", async () => {
    // The two are the same list in a universe and very different lists on an
    // install: rendering the ontology's copy of this operator's directory put
    // one request at roughly 780,000 tokens, and the model answered with a
    // bare 400. What the port hands the compiler has to be the bounded one.
    let sawPrompt = "";
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: () => ({
        complete: (prompt: string) => {
          sawPrompt = prompt;
          return Promise.resolve('```json\n{"decision":"refuse","reasons":["not today"]}\n```');
        },
      }),
      people: () => [
        {
          id: "8f14e45f-ceea-467a-9575-1e0b4f5a3c11",
          canonicalName: "Maya Reeves",
          aliases: [],
          isSelf: false,
          mergedInto: null,
        },
      ],
      session: () => null,
    });

    const result = await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships",
      ontology,
    });

    expect(result.status).toBe("refused");
    expect(sawPrompt).toContain("8f14e45f-ceea-467a-9575-1e0b4f5a3c11");
    expect(sawPrompt).toContain("Maya Reeves");
  });
});

/**
 * A model that records what it was asked and refuses, so a test can read the
 * prompt without depending on what a real compiler would decide about it.
 */
function refusingModel(seen: { prompt: string }): ChatModel {
  return {
    name: "a-session-model",
    complete: (messages: readonly ChatMessage[]) => {
      seen.prompt = messages.map((m) => m.content).join("\n");
      return Promise.resolve({
        text: '```json\n{"decision":"refuse","reasons":["not today"]}\n```',
        usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
      });
    },
  };
}

describe("which model a compile runs on", () => {
  it("uses the session when the install has one, not the single prompt", async () => {
    // The two produce the same shape of result and the same 201, so nothing
    // downstream can tell them apart — a compile that silently took the
    // single-shot path would install a watch bound from a digest while every
    // surface reported a compiler that had read the corpus.
    const seen = { prompt: "" };
    const single = vi.fn<() => CompletionBackend | null>().mockReturnValue(null);
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: single,
      people: () => [],
      session: () => ({ model: refusingModel(seen), toolNames: ["search_many"] }),
    });

    const result = await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships",
      ontology,
    });

    expect(result.status).toBe("refused");
    expect(seen.prompt).not.toBe("");
    expect(single).not.toHaveBeenCalled();
  });

  it("hands the session this install's deadline", async () => {
    // The deadline belongs to whoever asked, not to a default the backend
    // shipped with. A session built without one runs a turn nobody is waiting
    // on any more — the bug the single-shot path had, on the preferred path.
    const seen = { prompt: "" };
    const built = vi.fn().mockReturnValue({ model: refusingModel(seen), toolNames: [] });
    const port = createCompilePort({
      timeoutMs: () => 45_000,
      record: () => null,
      backend: () => null,
      people: () => [],
      session: built,
    });

    await port({ authoredBy: "operator", request: "tell me when a parcel ships", ontology });

    expect(built.mock.calls[0]?.[1]?.timeoutMs).toBe(45_000);
  });

  it("reports a session that ran out of time as a timeout, not a refusal", async () => {
    // The session signals its deadline by the error's name, which is what
    // `isTimeout` reads. Mapped wrongly this is a 500 on a request that simply
    // needed longer, or an agent told its condition cannot be expressed.
    const timedOut = new Error("a compile turn exceeded 45000ms");
    timedOut.name = "TimeoutError";
    const port = createCompilePort({
      timeoutMs: () => 45_000,
      record: () => null,
      backend: () => null,
      people: () => [],
      session: () => ({
        model: { name: "stalling", complete: () => Promise.reject(timedOut) },
        toolNames: [],
      }),
    });

    expect(
      await port({ authoredBy: "operator", request: "tell me when a parcel ships", ontology }),
    ).toEqual({
      status: "timed-out",
      compileRunId: null,
    });
  });

  it("tells the model which tools it may call", async () => {
    // A compiler told it can look things up, holding a set it was never told
    // about, either does not look or invents a name. The names are the half of
    // the capability that lives in the prompt.
    const seen = { prompt: "" };
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: () => null,
      people: () => [],
      session: () => ({
        model: refusingModel(seen),
        toolNames: ["lookup_people", "search_many"],
      }),
    });

    await port({
      authoredBy: "operator",
      request: "tell me when Maya emails about the lease",
      ontology,
    });

    expect(seen.prompt).toContain("lookup_people, search_many");
  });

  it("falls back to the single prompt on an install with no chat runtime", async () => {
    // `session` answering null is how an install says it cannot run an agent
    // turn. Refusing the request instead would stop a gateway compiling at all
    // over a capability it never needed.
    let asked = "";
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: () => ({
        complete: (prompt: string) => {
          asked = prompt;
          return Promise.resolve('```json\n{"decision":"refuse","reasons":["not today"]}\n```');
        },
      }),
      people: () => [],
      session: () => null,
    });

    const result = await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships",
      ontology,
    });

    expect(result.status).toBe("refused");
    // A model that answered in prose has still refused; the general code is
    // what the caller is told, and its own words stay for the log.
    if (result.status === "refused") expect(result.codes).toEqual(["unsupported_condition"]);
    expect(asked).toContain("tell me when a parcel ships");
    // No retrieval section: promising tools that are not attached would have
    // the model plan around calls it cannot make.
    expect(asked).not.toContain("You may call:");
  });
});

describe("a compile that ran out of time", () => {
  /** What `AbortSignal.timeout` rejects with, by name. */
  function abortedBy(name: string): Error {
    const error = new Error("The operation was aborted due to timeout");
    error.name = name;
    return error;
  }

  it.each(["TimeoutError", "AbortError"])("is not reported as a refusal (%s)", async (name) => {
    // They mean opposite things to whoever asked. A refusal is the compiler
    // declining, and asking again gets the same answer; a timeout is the
    // install failing to ask, and the same question may well work next time.
    // This surfaced as a bare 500 on a live compile, which says neither.
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: () => ({ complete: () => Promise.reject(abortedBy(name)) }),
      people: () => [],
      session: () => null,
    });

    expect(
      await port({ authoredBy: "operator", request: "tell me when a parcel ships", ontology }),
    ).toEqual({
      status: "timed-out",
      compileRunId: null,
    });
  });

  it("still lets a real fault through", async () => {
    // Swallowing everything would turn a bug in the compiler into "try again",
    // and it would be tried again forever.
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: () => ({
        complete: () => Promise.reject(new TypeError("cannot read x of undefined")),
      }),
      people: () => [],
      session: () => null,
    });

    await expect(
      port({ authoredBy: "operator", request: "tell me when a parcel ships", ontology }),
    ).rejects.toThrow(TypeError);
  });
});

describe("compiling without installing", () => {
  /**
   * A watch the fixture ontology accepts, written the way the model answers.
   *
   * `expires_at` is deliberately absent on a request naming a dated thing, so
   * the validator has a warning to report — the whole point of handing the
   * diagnostics back is that a document can compile and still be worth
   * looking at twice.
   */
  const WATCH = {
    watch: {
      name: "a-parcel-ships",
      nl_query: "the courier says a parcel has left the depot",
      firing_policy: "stays_active",
      ontology_fingerprint: "an-install-fingerprint",
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "mailbox:someone@example.com", event: ["created"] },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };

  function answering(): CompletionBackend {
    return {
      complete: () =>
        Promise.resolve(
          "```json\n" + JSON.stringify({ decision: "compile", watch: WATCH.watch }) + "\n```",
        ),
    };
  }

  it("hands back the validator's verdict on the document it produced", async () => {
    // The DSL alone does not show a warning, and a warning is the difference
    // between a watch that compiles and a watch worth installing.
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () => null,
      backend: answering,
      people: () => [],
      session: () => null,
    });

    const result = await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships before the 14th of March",
      ontology,
    });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    // Not merely present: it is the verdict on *this* document, so the codes
    // are the ones this watch actually earns.
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      validateWatch(result.document, ontology).diagnostics.map((d) => d.code),
    );
    expect(result.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("replays what it compiled, and does not when told to compile without it", async () => {
    // The switch the latency measurement turns. Whether the replay *ran* is the
    // only thing that makes the two arms comparable — withholding its report
    // while still paying for it would measure the same compile twice.
    //
    // Both halves in one test, on a request that really does compile: a request
    // the model refuses never reaches a candidate, so a replay would not run
    // for either arm and the assertion would hold for the wrong reason.
    const replayed: string[] = [];
    const portFor = (withoutBacktest: boolean) =>
      createCompilePort({
        timeoutMs: () => 60_000,
        record: () => null,
        backend: answering,
        people: () => [],
        session: () => null,
        backtest: async (watch) => {
          replayed.push(watch.name);
          return null;
        },
      })({
        authoredBy: "operator",
        request: "tell me when a parcel ships before the 14th of March",
        ontology,
        compileOnly: true,
        ...(withoutBacktest ? { withoutBacktest: true } : {}),
      });

    const on = await portFor(false);
    expect(on.status, "the request under test did not compile").toBe("compiled");
    expect(replayed, "a wired replay was never asked about the candidate").toHaveLength(1);

    const off = await portFor(true);
    expect(off.status, "withholding the replay cost the compilation").toBe("compiled");
    expect(replayed, "the replay ran on a compile that asked to skip it").toHaveLength(1);
  });

  it("tells the recorder a preview is a preview, so the ledger can say so", async () => {
    // A run that installed nothing reads exactly like one whose install failed
    // after it, and the runs list is where an operator tells them apart.
    const begun: { compileOnly?: boolean }[] = [];
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () =>
        ({
          begin: (input: { compileOnly?: boolean }) => {
            begun.push(input);
            return {
              runId: "run_a_preview",
              begins: () => undefined,
              record: () => undefined,
              settle: () => Promise.resolve(true),
            };
          },
        }) as unknown as ReturnType<Parameters<typeof createCompilePort>[0]["record"]>,
      backend: answering,
      people: () => [],
      session: () => null,
    });

    await port({
      authoredBy: "operator",
      request: "tell me when a parcel ships",
      ontology,
      compileOnly: true,
    });

    expect(begun[0]?.compileOnly).toBe(true);
  });

  it("tells the recorder which arm a compile was, so its duration can be attributed", async () => {
    // The run row is the only place a compile's duration lives, so it is the
    // only place the replay's cost can be attributed from. The arm cannot be
    // read off a missing backtest: a compile has none when the install has no
    // runtime, when the replay declined the candidate, when the journal was
    // empty, and on every refusal — inferring from an absence would put all of
    // those in the control group.
    const begun: { withoutBacktest?: boolean }[] = [];
    const recorder = () =>
      ({
        begin: (input: { withoutBacktest?: boolean }) => {
          begun.push(input);
          return {
            runId: "run_a_preview",
            begins: () => undefined,
            record: () => undefined,
            settle: () => Promise.resolve(true),
          };
        },
      }) as unknown as ReturnType<Parameters<typeof createCompilePort>[0]["record"]>;
    const portFor = (withoutBacktest: boolean) =>
      createCompilePort({
        timeoutMs: () => 60_000,
        record: recorder,
        backend: answering,
        people: () => [],
        session: () => null,
      })({
        authoredBy: "operator",
        request: "tell me when a parcel ships",
        ontology,
        compileOnly: true,
        ...(withoutBacktest ? { withoutBacktest: true } : {}),
      });

    await portFor(true);
    expect(begun[0]?.withoutBacktest, "the ledger cannot say this run skipped its replay").toBe(
      true,
    );
    // The other half, so the field marks an arm rather than marking every run.
    await portFor(false);
    expect(begun[1], "a replaying run was recorded as one that skipped").not.toHaveProperty(
      "withoutBacktest",
    );
  });

  it("does not mark an ordinary compile as a preview", async () => {
    const begun: { compileOnly?: boolean }[] = [];
    const port = createCompilePort({
      timeoutMs: () => 60_000,
      record: () =>
        ({
          begin: (input: { compileOnly?: boolean }) => {
            begun.push(input);
            return {
              runId: "run_an_install",
              begins: () => undefined,
              record: () => undefined,
              settle: () => Promise.resolve(true),
            };
          },
        }) as unknown as ReturnType<Parameters<typeof createCompilePort>[0]["record"]>,
      backend: answering,
      people: () => [],
      session: () => null,
    });

    await port({ authoredBy: "operator", request: "tell me when a parcel ships", ontology });

    expect(begun[0]?.compileOnly).toBeUndefined();
  });
});

describe("the compile deadline against what an adapter will wait", () => {
  it("finishes inside the budget the integration adapters allow", () => {
    // The two numbers live in different packages and are read by different
    // runtimes, so nothing but this stops them crossing. An adapter that gives
    // up before the gateway answers reports every successful create as a
    // failure, and an agent told that retries — with a reworded request, which
    // carries a different idempotency key by design, so the guard that would
    // have caught the duplicate never fires.
    expect(DEFAULT_COMPILE_TIMEOUT_MS).toBeLessThan(SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS);
  });
});
