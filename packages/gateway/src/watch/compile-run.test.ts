// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a compile leaves in the cognition ledger.
 *
 * A compile decides what a watch *means* — which source, which threshold,
 * which person — by reading the corpus while it works. Two watches that catch
 * nothing look identical from every surface; the only thing that separates
 * "the condition never happened" from "the compiler bound this to the wrong
 * source" is the record of what it read and answered.
 *
 * So the properties here are about that record surviving every way a compile
 * can end, and about it never costing the operator their actual work: a ledger
 * write that fails must not fail a compile, and a run id must never be handed
 * onward for a row the ledger did not receive.
 *
 * Driven through the real port rather than the recorder alone, because the
 * wiring is half the claim — a recorder nothing calls records nothing.
 *
 * Fixture data is invented — no corpus content.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, type AgentEvent } from "@omnesis/core";
import { Ontology } from "@omnesis/watch";

import { FsCognitionTranscriptStore, type CognitionRunTranscript } from "../brain/transcripts.js";
import { createCompilePort, type CompilePortDeps } from "./compile-port.js";
import { WatchCompileRecorder } from "./compile-run.js";
import type { RecordSettledCognitionRunInput } from "../brain/storage/run-queue.js";
import type { ChatModel } from "@omnesis/watch";

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

const WATCH = {
  name: "a-parcel-shipped",
  nl_query: "tell me when a parcel ships",
  firing_policy: "stays_active",
  ontology_fingerprint: "an-install-fingerprint",
  nodes: [
    {
      id: "shipped",
      type: "source.document_event",
      filter: { source: "mailbox:someone@example.com", event: ["created"] },
      output_map: { doc_id: "$e.docId" },
      recall: { lexical: { terms: ["shipped"], match: "token" } },
      judge: { proposition: "the message says a parcel has shipped", output_schema: {} },
    },
  ],
  sink: { input: "shipped", output_map: { evidence: "$n.shipped.doc_id" } },
};

const COMPILED_REPLY =
  "```json\n" + JSON.stringify({ decision: "compile", watch: WATCH }) + "\n```";
const REFUSAL_REPLY =
  "```json\n" +
  JSON.stringify({
    decision: "refuse",
    reasons: ["this install has no source that could see a parcel"],
    codes: ["unsupported_condition"],
  }) +
  "\n```";

/** The write gate, reduced to the one verb and a place to look at what it got. */
function sink(behaviour: { throws?: boolean } = {}) {
  const rows: RecordSettledCognitionRunInput[] = [];
  return {
    rows,
    recordSettledCognitionRun: (input: RecordSettledCognitionRunInput) => {
      if (behaviour.throws) return Promise.reject(new Error("the writer is down"));
      rows.push(input);
      return Promise.resolve();
    },
  };
}

const dirs: string[] = [];
function transcriptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-compile-runs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storedTranscripts(dir: string): CognitionRunTranscript[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as CognitionRunTranscript);
}

/**
 * A session whose turns are scripted, and which broadcasts the events a real
 * one would — including the user message the compiler's repair loop sends.
 */
function scriptedSession(turns: Array<{ reply: string; events?: AgentEvent[] }>) {
  return (
    _sessionId: string,
    opts: { timeoutMs: number; onEvent: (event: AgentEvent) => void },
  ): { model: ChatModel; toolNames: readonly string[] } => {
    let turn = 0;
    const model: ChatModel = {
      name: "scripted-model",
      complete(messages) {
        const script = turns[turn] ?? turns[turns.length - 1]!;
        turn += 1;
        opts.onEvent({
          type: "agent.user.message",
          payload: {
            sessionId: "s",
            userMessageId: `u${turn}`,
            text: messages[messages.length - 1]?.content ?? "",
          },
        });
        for (const event of script.events ?? []) opts.onEvent(event);
        opts.onEvent({
          type: "agent.text.delta",
          payload: { sessionId: "s", messageId: `m${turn}`, delta: script.reply },
        });
        opts.onEvent({
          type: "agent.message.end",
          payload: {
            sessionId: "s",
            messageId: `m${turn}`,
            stopReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 20 },
          },
        });
        return Promise.resolve({
          text: script.reply,
          usage: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 20 },
        });
      },
    };
    return { model, toolNames: ["search_many", "lookup_people"] };
  };
}

function port(opts: {
  dir: string;
  writeGate: { recordSettledCognitionRun: (i: RecordSettledCognitionRunInput) => Promise<void> };
  session?: CompilePortDeps["session"];
  backend?: CompilePortDeps["backend"];
  backtest?: CompilePortDeps["backtest"];
}) {
  const recorder = new WatchCompileRecorder({
    writeGate: opts.writeGate,
    transcripts: new FsCognitionTranscriptStore(opts.dir),
    log: createLogger("test"),
  });
  return createCompilePort({
    backend: opts.backend ?? (() => null),
    people: () => [],
    timeoutMs: () => 60_000,
    session: opts.session ?? (() => null),
    record: () => recorder,
    ...(opts.backtest ? { backtest: opts.backtest } : {}),
  });
}

describe("a compile that produced a watch", () => {
  it("records the run and the whole event stream, tool calls and all", async () => {
    // The arguments a tool was called with and what came back are the reason
    // this exists: a watch bound to the wrong source was bound that way
    // because of something the compiler read.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: scriptedSession([
        {
          reply: COMPILED_REPLY,
          events: [
            {
              type: "agent.tool.start",
              payload: {
                sessionId: "s",
                messageId: "m1",
                toolCallId: "call-1",
                tool: "lookup_people",
                args: { query: "Maya Reeves" },
              },
            },
            {
              type: "agent.tool.result",
              payload: {
                sessionId: "s",
                messageId: "m1",
                toolCallId: "call-1",
                result: { kind: "structured", data: { matches: 1 } },
                durationMs: 9,
              },
            },
          ],
        },
      ]),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("compiled");
    expect(gate.rows).toHaveLength(1);
    const row = gate.rows[0]!;
    expect(row.kind).toBe("subscription_compile");
    expect(row.mechanism).toBe("subscription-compile");
    expect(row.modelId).toBe("scripted-model");
    expect(row.outcome).toEqual({ kind: "completed" });
    expect(row.payload).toEqual({
      request: "tell me when a parcel ships",
      authoredBy: "operator",
      path: "session",
      attempts: 1,
    });
    // The id the caller may hand onward is the row's, and only because it
    // landed.
    expect(outcome.status === "compiled" && outcome.compileRunId).toBe(row.runId);

    const [transcript] = storedTranscripts(dir);
    expect(transcript?.runId).toBe(row.runId);
    expect(transcript?.events.map((e) => e.type)).toEqual([
      "agent.user.message",
      "agent.tool.start",
      "agent.tool.result",
      "agent.text.delta",
      "agent.message.end",
    ]);
    // Verbatim. The portal's transcript viewer is the live agent reducer over
    // a stored stream: it reads the wire payloads, so anything reshaped here
    // would have to be un-reshaped there.
    expect(transcript?.events[1]?.payload).toMatchObject({
      tool: "lookup_people",
      args: { query: "Maya Reeves" },
    });
    expect(transcript?.events[2]?.payload).toMatchObject({
      result: { kind: "structured", data: { matches: 1 } },
    });
  });

  it("keeps every repair turn, in order, and sums what they all cost", async () => {
    // A compile that needed three goes at valid syntax is a different event
    // from one that got it right first time, and the diagnostics the loop fed
    // back are the whole explanation. They arrive as further user messages.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: scriptedSession([{ reply: "not JSON at all" }, { reply: COMPILED_REPLY }]),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("compiled");
    const userMessages =
      storedTranscripts(dir)[0]?.events.filter((e) => e.type === "agent.user.message") ?? [];
    expect(userMessages).toHaveLength(2);
    // The first is the request; the second is what the compiler told the model
    // was wrong with its answer.
    expect(JSON.stringify(userMessages[0]?.payload)).toContain("tell me when a parcel ships");
    expect(userMessages[1]).toBeDefined();
    expect(gate.rows[0]?.payload).toMatchObject({ attempts: 2 });
    // Both turns billed, not just the last one.
    expect(gate.rows[0]?.usage).toEqual({
      promptTokens: 200,
      completionTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("a compile that produced no watch", () => {
  it("records a refusal as a failed run carrying its codes", async () => {
    // The case an operator most needs to read: the transcript holds the words
    // the model refused in, and the row holds the closed-vocabulary codes.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: scriptedSession([{ reply: REFUSAL_REPLY }]),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "integration",
    });

    expect(outcome.status).toBe("refused");
    expect(gate.rows[0]?.outcome).toMatchObject({
      kind: "failed",
      failureCode: "refused",
    });
    expect(gate.rows[0]?.payload).toMatchObject({
      authoredBy: "integration",
      refusalCodes: ["unsupported_condition"],
    });
    expect(storedTranscripts(dir)[0]?.finalText).toContain("unsupported_condition");
  });

  it("records a validator failure as a failure, not as the refusal it is answered as", async () => {
    // The port answers both with `refused`, because there is one thing a
    // caller can do about either. The ledger keeps them apart: "the compiler
    // declined" and "the model could not write valid syntax" send an operator
    // to two different places.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: scriptedSession([{ reply: "no fenced block here" }]),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("refused");
    expect(gate.rows[0]?.outcome).toMatchObject({ kind: "failed", failureCode: "compiler_failed" });
    // Not a refusal: no codes were written, because the model never refused.
    expect(gate.rows[0]?.payload).not.toHaveProperty("refusalCodes");
  });

  it("records a deadline as a timeout, never as a refusal", async () => {
    // An agent told its condition is unsupported stops asking. A timeout
    // decided nothing about the condition, and the ledger has to say so.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: () => ({
        model: {
          name: "scripted-model",
          complete: () => {
            const stopped = new Error("a compile turn exceeded 1ms");
            stopped.name = "TimeoutError";
            return Promise.reject(stopped);
          },
        },
        toolNames: [],
      }),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("timed-out");
    expect(gate.rows[0]?.outcome).toMatchObject({ kind: "failed", failureCode: "timed_out" });
  });

  it("records nothing at all when no model is assigned", async () => {
    // No condition was considered and no turn ran. A row would be a record of
    // a compile that never happened.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({ dir, writeGate: gate });

    expect(
      await compile({ request: "tell me when a parcel ships", ontology, authoredBy: "operator" }),
    ).toEqual({ status: "no-model" });
    expect(gate.rows).toHaveLength(0);
    expect(storedTranscripts(dir)).toHaveLength(0);
  });
});

describe("an install with no chat runtime to look things up with", () => {
  it("still leaves a readable transcript", async () => {
    // The single-shot path has no session and so no event stream. Left alone
    // it records an empty transcript, which reads exactly like a compile that
    // never reached a model.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      backend: () => ({ name: "a-completer", complete: () => Promise.resolve(COMPILED_REPLY) }),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("compiled");
    expect(gate.rows[0]?.payload).toMatchObject({ path: "single-shot" });
    const [transcript] = storedTranscripts(dir);
    expect(transcript?.events.map((e) => e.type)).toEqual([
      "agent.user.message",
      "agent.message.start",
      "agent.text.delta",
      "agent.message.end",
    ]);
    // The whole flattened prompt, because that is literally what the backend
    // was sent — roles and all.
    expect(JSON.stringify(transcript?.events[0]?.payload)).toContain("<|system|>");
  });
});

describe("recording never costs the operator their work", () => {
  it("compiles even when the ledger write fails, and hands no id onward", async () => {
    // A durable reference to a run the ledger never received renders as a link
    // to nothing.
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: sink({ throws: true }),
      session: scriptedSession([{ reply: COMPILED_REPLY }]),
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("compiled");
    expect(outcome.status === "compiled" && outcome.compileRunId).toBe(null);
    // The transcript is still worth keeping: it carries what the model said,
    // and the transcript routes serve it by run id whether a row exists or not.
    expect(storedTranscripts(dir)).toHaveLength(1);
  });

  it("compiles even when the transcript write fails, and still hands the id onward", async () => {
    // The row is what the id resolves to. Losing the artifact beside it does
    // not change the answer.
    const gate = sink();
    const recorder = new WatchCompileRecorder({
      writeGate: gate,
      transcripts: {
        save: () => {
          throw new Error("the disk is full");
        },
      },
      log: createLogger("test"),
    });
    const compile = createCompilePort({
      backend: () => null,
      people: () => [],
      timeoutMs: () => 60_000,
      session: scriptedSession([{ reply: COMPILED_REPLY }]),
      record: () => recorder,
    });

    const outcome = await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
    });

    expect(outcome.status).toBe("compiled");
    expect(outcome.status === "compiled" && outcome.compileRunId).toBe(gate.rows[0]?.runId);
  });
});

describe("what the ledger is told about a rewrite", () => {
  it("names the watch a recompile replaces", async () => {
    // A compile that rewrites a watch and one that authors a new one are
    // different events with the same request text.
    const gate = sink();
    const dir = transcriptsDir();
    const compile = port({
      dir,
      writeGate: gate,
      session: scriptedSession([{ reply: COMPILED_REPLY }]),
    });

    await compile({
      request: "tell me when a parcel ships",
      ontology,
      authoredBy: "operator",
      replaces: "watch-being-rewritten",
    });

    expect(gate.rows[0]?.payload).toMatchObject({ replaces: "watch-being-rewritten" });
  });
});

describe("what the ledger is told about how a watch would have behaved", () => {
  it("keeps the replay's counts beside the compile that produced them", async () => {
    // The run is what an operator opens when an installed watch behaves
    // differently from what they expected, and the reach numbers are the half of
    // that a transcript cannot reconstruct.
    const gate = sink();
    const compile = port({
      dir: transcriptsDir(),
      writeGate: gate,
      session: scriptedSession([{ reply: COMPILED_REPLY }]),
      backtest: () =>
        Promise.resolve({
          watch: "a-parcel-shipped",
          events: 4_200,
          days: 12,
          firings: 0,
          reachByNode: { mail: 31 },
          totalReaches: 31,
        }),
    });

    await compile({ request: "tell me when a parcel ships", ontology, authoredBy: "operator" });

    expect(gate.rows[0]?.payload).toMatchObject({
      backtest: { days: 12, events: 4_200, firings: 0, totalReaches: 31 },
    });
  });

  it("writes no backtest at all when nothing replayed the candidate", async () => {
    // The discriminating case. A zeroed record would read as a watch measured
    // and found silent, which is the opposite of a watch nobody measured.
    const gate = sink();
    const compile = port({
      dir: transcriptsDir(),
      writeGate: gate,
      session: scriptedSession([{ reply: COMPILED_REPLY }]),
    });

    await compile({ request: "tell me when a parcel ships", ontology, authoredBy: "operator" });

    expect(gate.rows[0]?.payload).not.toHaveProperty("backtest");
  });
});
