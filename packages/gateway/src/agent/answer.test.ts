// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { FsConversationStore, type ConversationStore } from "./conversation-store.js";
import { AgentService, MAX_READ_ONLY_ANSWER_CANDIDATE_CHARS } from "./service.js";
import type { AgentError } from "./service.js";
import type {
  ChatBackend,
  DocumentPort,
  SearchPort,
  ToolHandle,
  ToolPorts,
  TurnInput,
} from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";

const restrictedAnswerAuthorization = createCorpusAuthorization(
  {
    principalId: "principal-example",
    grantId: "grant-example",
    grantRevision: 1,
    credentialId: "credential-example",
    accessTokenId: "token-example",
  },
  [
    {
      capability: "answer",
      sourceMode: "allowlist",
      sourceIds: ["fictional:allowed"],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    },
  ],
  "answer",
)!;

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };
const tempDirs: string[] = [];

class RecordingBackend implements ChatBackend {
  readonly name = "recording";
  readonly model = "recording";
  readonly turns: TurnInput[] = [];

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.thinking.delta", payload: { sessionId, messageId, delta: "private" } };
    yield {
      type: "agent.text.delta",
      payload: { sessionId, messageId, delta: `Reply to ${input.userMessage}` },
    };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

class TerminalBackend implements ChatBackend {
  readonly name = "terminal";
  readonly model = "terminal";

  constructor(
    private readonly stopReason: "end_turn" | "max_tokens" | "tool_use" | "canceled" | "error",
    private readonly text = "partial",
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    if (this.text) {
      yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: this.text } };
    }
    yield {
      type: "agent.message.end",
      payload: { sessionId, messageId, stopReason: this.stopReason },
    };
  }
}

class ErrorEventBackend implements ChatBackend {
  readonly name = "error-event";
  readonly model = "error-event";

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield {
      type: "agent.error",
      payload: {
        sessionId,
        messageId,
        code: "provider_error",
        message: "raw provider detail must stay server-side",
      },
    };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "error" } };
  }
}

class HttpFailureBackend implements ChatBackend {
  readonly name = "http-failure";
  readonly model = "http-failure";

  constructor(
    private readonly code: "http_request_timeout" | "http_request_error",
    private readonly provider?: { status?: number; code?: string; param?: string },
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield {
      type: "agent.message.end",
      payload: {
        sessionId,
        messageId,
        stopReason: "error",
        failure: {
          code: this.code,
          message: "vetted HTTP failure",
          retryable: true,
          backend: this.name,
          model: this.model,
          ...(this.provider ? { provider: this.provider } : {}),
        },
      },
    };
  }
}

class ErrorBreadcrumbThenSuccessBackend implements ChatBackend {
  readonly name = "error-breadcrumb-then-success";
  readonly model = "error-breadcrumb-then-success";

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield {
      type: "agent.error",
      payload: {
        sessionId,
        messageId,
        code: "provider_error",
        message: "transient live breadcrumb",
      },
    };
    yield {
      type: "agent.text.delta",
      payload: { sessionId, messageId, delta: "Authoritative success" },
    };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

class ContextWindowBackend implements ChatBackend {
  readonly name = "context-window";
  readonly model = "context-window";

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield {
      type: "agent.text.delta",
      payload: { sessionId, messageId, delta: "Partial answer" },
    };
    yield {
      type: "agent.error",
      payload: {
        sessionId,
        messageId,
        code: "context_window_exceeded",
        message: "raw provider detail",
      },
    };
    yield {
      type: "agent.message.end",
      payload: { sessionId, messageId, stopReason: "error" },
    };
  }
}

class AbortBackend implements ChatBackend {
  readonly name = "abort";
  readonly model = "abort";
  started: Promise<void>;
  private markStarted: () => void = () => {};

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async *runTurn(_input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    this.markStarted();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
    yield undefined as never;
  }
}

class OversizedBackend implements ChatBackend {
  readonly name = "oversized";
  readonly model = "oversized";

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield {
      type: "agent.text.delta",
      payload: {
        sessionId,
        messageId,
        delta: "x".repeat(MAX_READ_ONLY_ANSWER_CANDIDATE_CHARS + 1),
      },
    };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

class TraceFloodBackend implements ChatBackend {
  readonly name = "trace-flood";
  readonly model = "trace-flood";

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    for (let index = 0; index < 40; index += 1) {
      yield {
        type: "agent.tool.start",
        payload: {
          sessionId,
          messageId,
          toolCallId: `trace-${index}`,
          tool: "search_documents",
          args: { query: `synthetic-${index}` },
        },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId,
          messageId,
          toolCallId: `trace-${index}`,
          result: { content: "x".repeat(100_000) },
          durationMs: 1,
        },
      };
    }
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "bounded" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

function makeStore(): FsConversationStore {
  const dir = mkdtempSync(join(tmpdir(), `omnesis-answer-${process.pid}-`));
  tempDirs.push(dir);
  return new FsConversationStore(join(dir, "conversations"));
}

function makeService(
  backend: ChatBackend,
  store: ConversationStore = makeStore(),
  extraPorts: Partial<ToolPorts> = {},
): AgentService {
  let n = 0;
  return new AgentService({
    backendFactory: () => backend,
    ports: { search: stubSearch, document: stubDocument, ...extraPorts },
    systemPrompt: "test",
    store,
    sessionIdGen: () => `S_answer_${++n}`,
    idleTimeoutMs: 60_000,
  });
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("AgentService.generateReadOnlyAnswerCandidate", () => {
  it("uses only the supplied scoped tools and prompt for a restricted external Answer", async () => {
    const backend = new RecordingBackend();
    const scopedSearch = {
      name: "search_many",
      description: "Scoped search",
      schema: z.object({ query: z.string() }),
      invoke: async () => ({ kind: "structured", resultType: "test", data: {} }) as const,
    } satisfies ToolHandle;
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "GLOBAL_DENIED_CATALOG_CANARY",
      externalAnswerScope: async () => ({
        tools: [scopedSearch],
        systemPrompt: "SCOPED_PROMPT_WITHOUT_DENIED_DATA",
      }),
    });

    await service.generateReadOnlyAnswerCandidate(
      "Invented restricted question",
      [],
      undefined,
      undefined,
      { corpusAuthorization: restrictedAnswerAuthorization },
    );
    expect(backend.turns[0]?.tools.map((tool) => tool.name)).toEqual(["search_many"]);
    expect(backend.turns[0]?.systemPrompt).toContain("SCOPED_PROMPT_WITHOUT_DENIED_DATA");
    expect(JSON.stringify(backend.turns[0])).not.toContain("GLOBAL_DENIED_CATALOG_CANARY");
    await service.dispose();
  });

  it.each(["0", "1"])(
    "withholds interactive memory and conversation persistence from every external Answer (experimental=%s)",
    async (experimental) => {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", experimental);
      vi.stubEnv("OMNESIS_SYNTHETIC", "0");
      const backend = new RecordingBackend();
      const ensureConversationEvidence = vi.fn(() =>
        Promise.resolve({
          documentId: "private-conversation",
          userMessages: ["I prefer morning meetings."],
        }),
      );
      const scopedSearch: ToolHandle = {
        name: "search_many",
        description: "Scoped search",
        schema: z.object({}),
        invoke: async () => ({ kind: "structured", resultType: "test", data: {} }),
      };
      const memoryTool: ToolHandle = {
        name: "annotate_person",
        description: "Save a memory",
        schema: z.object({}),
        mutates: true,
        invoke: async () => ({ kind: "structured", resultType: "test", data: {} }),
      };
      const buildMemory = vi.fn(() => [memoryTool]);
      const buildExperimental = vi.fn(() => [memoryTool]);
      const service = new AgentService({
        backendFactory: () => backend,
        ports: { search: stubSearch, document: stubDocument },
        systemPrompt: "test",
        store: makeStore(),
        ensureConversationEvidence,
        externalAnswerScope: async () => ({ tools: [scopedSearch], systemPrompt: "Scoped answer" }),
      });
      service.setInteractiveMemoryProfile({ buildOwnTools: buildMemory });
      service.setInteractiveWriteProfile({ buildOwnTools: buildExperimental });
      try {
        await service.generateReadOnlyAnswerCandidate("Remember my preference", []);
        await service.generateReadOnlyAnswerCandidate(
          "Remember my preference",
          [],
          undefined,
          undefined,
          { corpusAuthorization: restrictedAnswerAuthorization },
        );
        expect(backend.turns).toHaveLength(2);
        for (const turn of backend.turns) {
          expect(turn.tools.map((tool) => tool.name)).not.toContain("annotate_person");
          expect(turn.tools.map((tool) => tool.name)).not.toContain("conversation_memory_evidence");
          expect(turn.tools.some((tool) => tool.mutates === true)).toBe(false);
          expect(turn.systemPrompt).toContain("read-only answer API");
        }
        expect(buildMemory).not.toHaveBeenCalled();
        expect(buildExperimental).not.toHaveBeenCalled();
        expect(ensureConversationEvidence).not.toHaveBeenCalled();
      } finally {
        await service.dispose();
        vi.unstubAllEnvs();
      }
    },
  );

  it("fails closed when restricted Answer scope wiring is absent", async () => {
    const service = makeService(new RecordingBackend());
    await expect(
      service.generateReadOnlyAnswerCandidate(
        "Invented restricted question",
        [],
        undefined,
        undefined,
        { corpusAuthorization: restrictedAnswerAuthorization },
      ),
    ).rejects.toThrow("restricted Answer scope is unavailable");
    await service.dispose();
  });

  it("isolates external candidates and withholds citation-only tools", async () => {
    const store = makeStore();
    const backend = new RecordingBackend();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        search: stubSearch,
        document: stubDocument,
        record: {
          async resolve() {
            throw new Error("not invoked");
          },
        },
      },
      systemPrompt: (profile) =>
        profile === "answer"
          ? "external answer prompt without a citation surface"
          : "interactive prompt",
      store,
      sessionIdGen: () => "S_candidate",
      idleTimeoutMs: 60_000,
    });

    const result = await service.generateReadOnlyAnswerCandidate("Invented question", []);

    expect(result).toMatchObject({
      answer: "Reply to Invented question",
      trace: {
        provider: "recording",
        model: "recording",
        sessionId: "S_candidate",
        terminalStopReason: "end_turn",
      },
    });
    expect(JSON.stringify(result.trace?.messages)).not.toContain('"kind":"thinking"');
    expect(JSON.stringify(result.trace?.messages)).toContain("Reply to Invented question");
    expect(backend.turns).toHaveLength(1);
    expect(backend.turns[0]?.tools.map((tool) => tool.name)).toContain("search_many");
    expect(backend.turns[0]?.tools.map((tool) => tool.name)).toContain("fetch_many");
    expect(backend.turns[0]?.tools.map((tool) => tool.name)).not.toContain("annotate_many");
    expect(backend.turns[0]?.tools.map((tool) => tool.name)).not.toContain("cite_record");
    expect(backend.turns[0]?.systemPrompt).toContain("external answer prompt");
    await expect(store.load("S_candidate")).resolves.toBeNull();
  });

  it("resolves firing evidence internally and still hands the turn its corpus tools", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend, makeStore(), {
      document: {
        async fetch(documentId) {
          if (documentId !== "doc_fictional_signal") return null;
          return {
            ref: {
              documentId,
              sourceType: "synthetic",
              sourceId: "synthetic:fictional",
              title: "Northstar rehearsal",
              snippet: "The rehearsal moved to Thursday.",
              ts: 1,
            },
            document: {
              id: documentId,
              title: "Northstar rehearsal",
              content: "The rehearsal moved to Thursday.",
            },
          };
        },
      },
    });

    await service.generateReadOnlyAnswerCandidate(
      "Why did this fictional watch fire?",
      [],
      undefined,
      undefined,
      { evidenceDocumentIds: ["doc_fictional_signal"] },
    );

    // The evidence says which occurrence is under discussion; the tools let the
    // turn find out what surrounds it.
    //
    // Asserted as an exact match against the ordinary ask rather than as
    // "some tools", because the safety argument for this surface is precisely
    // that it is granted no capability the other one lacks. A change that
    // hands either path a mutating or network-reaching tool has to redden
    // here.
    await service.generateReadOnlyAnswerCandidate("An ordinary question.", []);
    expect(backend.turns[0]?.tools).toEqual(backend.turns[1]?.tools);
    expect(backend.turns[0]?.tools.length).toBeGreaterThan(0);
    expect(backend.turns[0]?.userMessage).toContain("doc_fictional_signal");
    expect(backend.turns[0]?.userMessage).toContain("The rehearsal moved to Thursday.");
    expect(backend.turns[0]?.userMessage).toContain("Why did this fictional watch fire?");
    await service.dispose();
  });

  it("reads the matched attachment's extracted text beside the record it arrived on", async () => {
    // The shape the whole attribution chain exists to serve: a watch on "an
    // email with a contract attached" fires for the email, whose body says
    // nothing but "see attached". Every fact the answer needs lives in the
    // attachment's extracted text — so unless the part is inlined alongside
    // its container, the turn has to go looking for something the firing
    // already established.
    const corpus: Record<string, { title: string; content: string }> = {
      doc_fictional_email: {
        title: "Contract for signature",
        content: "See attached.",
      },
      doc_fictional_email_contract: {
        title: "services-agreement.pdf",
        content: "SERVICES AGREEMENT. Term: twelve months. Notice period: sixty days.",
      },
    };
    const backend = new RecordingBackend();
    const service = makeService(backend, makeStore(), {
      document: {
        async fetch(documentId) {
          const row = corpus[documentId];
          if (!row) return null;
          return {
            ref: {
              documentId,
              sourceType: "synthetic",
              sourceId: "synthetic:fictional",
              title: row.title,
              snippet: row.content.slice(0, 500),
              ts: 1,
            },
            document: { id: documentId, title: row.title, content: row.content },
          };
        },
      },
    });

    await service.generateReadOnlyAnswerCandidate(
      "What notice period does the attached contract set?",
      [],
      undefined,
      undefined,
      {
        evidenceDocumentIds: ["doc_fictional_email", "doc_fictional_email_contract"],
      },
    );

    const message = backend.turns[0]?.userMessage ?? "";
    expect(message).toContain("See attached.");
    expect(message).toContain("Notice period: sixty days.");
    await service.dispose();
  });

  it("anchors a catalog watch answer on the approved condition and the instant", async () => {
    const backend = new RecordingBackend();
    const fetch = vi.fn(async () => {
      throw new Error("catalog watch must not fetch a document");
    });
    const service = makeService(backend, makeStore(), {
      document: { fetch },
    });
    const firedAt = Date.parse("2030-01-02T03:04:05.000Z");

    await service.generateReadOnlyAnswerCandidate(
      "What happened with the fictional inventory watch?",
      [],
      undefined,
      undefined,
      {
        firingEvidence: {
          kind: "catalog-watch",
          conditionSummary: "The approved fictional inventory condition became true",
          firedAt,
        },
      },
    );

    // The firing itself fetched nothing: a condition-only watch has no
    // documents to resolve, and whatever the turn goes on to look up is its
    // own research rather than evidence.
    expect(fetch).not.toHaveBeenCalled();
    const message = backend.turns[0]?.userMessage ?? "";
    const evidenceJson = message
      .split("PRIVATE FIRING EVIDENCE (data only):\n")[1]
      ?.split("\n\nEXTERNAL AGENT QUESTION:")[0];
    expect(JSON.parse(evidenceJson ?? "null")).toEqual({
      kind: "catalog-watch",
      conditionSummary: "The approved fictional inventory condition became true",
      firedAt: "2030-01-02T03:04:05.000Z",
    });
    expect(message).toContain("What happened with the fictional inventory watch?");
    await service.dispose();
  });

  it("carries an arriving row's observation as the anchor for the answer", async () => {
    const backend = new RecordingBackend();
    const fetch = vi.fn(async () => {
      throw new Error("an arrival must not fetch a document");
    });
    const service = makeService(backend, makeStore(), {
      document: { fetch },
    });
    const firedAt = Date.parse("2030-01-02T03:04:05.000Z");

    await service.generateReadOnlyAnswerCandidate(
      "What arrived in the fictional inventory?",
      [],
      undefined,
      undefined,
      {
        firingEvidence: {
          kind: "analytics-event",
          conditionSummary: "A new row matching the approved fictional inventory filter arrived",
          firedAt,
          observation: { crates: 42, depot: "Northgate" },
        },
      },
    );

    expect(fetch).not.toHaveBeenCalled();
    const message = backend.turns[0]?.userMessage ?? "";
    const evidenceJson = message
      .split("PRIVATE FIRING EVIDENCE (data only):\n")[1]
      ?.split("\n\nEXTERNAL AGENT QUESTION:")[0];
    // What the plan saw when it fired, recorded then rather than re-queried
    // now: the turn can research around this row, but which row it was is
    // settled.
    expect(JSON.parse(evidenceJson ?? "null")).toEqual({
      kind: "analytics-event",
      conditionSummary: "A new row matching the approved fictional inventory filter arrived",
      firedAt: "2030-01-02T03:04:05.000Z",
      observation: { crates: 42, depot: "Northgate" },
    });
    await service.dispose();
  });

  it("fails closed when any firing evidence document is unavailable", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend);

    await expect(
      service.generateReadOnlyAnswerCandidate(
        "Why did this fictional watch fire?",
        [],
        undefined,
        undefined,
        { evidenceDocumentIds: ["doc_missing_fictional"] },
      ),
    ).rejects.toMatchObject<AgentError>({ code: "firing_evidence_unavailable" });
    expect(backend.turns).toEqual([]);
    await service.dispose();
  });

  it("cancels an external candidate as soon as it exceeds the review limit", async () => {
    const service = makeService(new OversizedBackend());
    let trace: unknown;

    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question", [], undefined, (value) => {
        trace = value;
      }),
    ).rejects.toMatchObject<AgentError>({ code: "answer_too_large" });
    expect(trace).toMatchObject({ provider: "oversized", terminalStopReason: "canceled" });
    await service.dispose();
  });

  it("bounds the aggregate trusted trace for long tool trajectories", async () => {
    const service = makeService(new TraceFloodBackend());

    const result = await service.generateReadOnlyAnswerCandidate("Invented question", []);
    const serialized = JSON.stringify(result.trace);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(8 * 1024 * 1024);
    expect(serialized).toContain("trace_truncated");
    expect(result.trace.messages).toContainEqual({ type: "trace_truncated", omittedParts: 18 });
    const retainedParts = result.trace.messages.reduce(
      (count, message) => count + ("parts" in message ? message.parts.length : 0),
      0,
    );
    expect(retainedParts).toBe(64);
    await service.dispose();
  });

  it("does not add experimental mutating tools to the answer surface", async () => {
    // The candidate path builds its own tool set, so a write profile the
    // interactive surface was handed must not reach it. Asserted rather than
    // reasoned about: an external agent is the one caller whose questions
    // nobody supervises mid-stream.
    const prior = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const backend = new RecordingBackend();
      const service = makeService(backend);
      const writeTool: ToolHandle = {
        name: "write_stub",
        description: "test-only mutating tool",
        mutates: true,
        schema: z.unknown(),
        invoke: async () => ({ kind: "structured", resultType: "ok", data: {} }),
      };
      service.setInteractiveWriteProfile({ buildOwnTools: () => [writeTool] });

      await service.generateReadOnlyAnswerCandidate("Invented question");
      expect(backend.turns[0]?.tools.map((tool) => tool.name)).not.toContain("write_stub");
      await service.dispose();
    } finally {
      if (prior === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = prior;
    }
  });

  it("filters built-in write tools and overrides their ordinary prompt instructions", async () => {
    const prior = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const backend = new RecordingBackend();
      const service = makeService(backend, makeStore(), {
        triggers: {
          list: async () => [],
          get: async () => null,
          firings: async () => [],
          preview: async () => {
            throw new Error("unused");
          },
        },
        watch: {
          create: async () => {
            throw new Error("write tool must not be called");
          },
          update: async () => {
            throw new Error("write tool must not be called");
          },
        },
      });

      await service.generateReadOnlyAnswerCandidate("Invented question");
      const turn = backend.turns[0]!;
      const names = turn.tools.map((tool) => tool.name);
      expect(names).toContain("search_many");
      expect(names).toContain("fetch_many");
      expect(names).not.toContain("watch_create");
      expect(names).not.toContain("watch_update");
      await service.dispose();
    } finally {
      if (prior === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = prior;
    }
  });

  it.each(["max_tokens", "tool_use"] as const)(
    "rejects a partial %s result instead of returning its text",
    async (stopReason) => {
      // A truncated answer that reads as a complete one is the failure mode
      // this surface cannot have: the caller is an agent, and it will act on
      // whatever it is handed.
      const service = makeService(new TerminalBackend(stopReason));
      await expect(
        service.generateReadOnlyAnswerCandidate("Invented question"),
      ).rejects.toMatchObject<AgentError>({ code: "answer_incomplete" });
      await service.dispose();
    },
  );

  it("uses an authoritative successful message.end despite an earlier live error", async () => {
    const service = makeService(new ErrorBreadcrumbThenSuccessBackend());

    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question"),
    ).resolves.toMatchObject({ answer: "Authoritative success" });
    await service.dispose();
  });

  it("preserves typed context exhaustion from the authoritative message.end", async () => {
    const service = makeService(new ContextWindowBackend());

    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question"),
    ).rejects.toMatchObject<AgentError>({
      code: "context_window_exceeded",
      message: "the conversation no longer fits in the selected model's context window",
    });
    await service.dispose();
  });

  it("preserves the backend's own code for every vetted HTTP failure", async () => {
    for (const code of ["http_request_timeout", "http_request_error"] as const) {
      const service = makeService(new HttpFailureBackend(code));
      await expect(
        service.generateReadOnlyAnswerCandidate("Invented question"),
      ).rejects.toMatchObject({ code, message: "vetted HTTP failure" });
      await service.dispose();
    }
  });

  it("carries the provider's disposition alongside the code", async () => {
    const service = makeService(
      new HttpFailureBackend("http_request_error", {
        status: 404,
        code: "NOT_FOUND",
        param: "model",
      }),
    );
    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question"),
    ).rejects.toMatchObject({
      code: "http_request_error",
      provider: { status: 404, code: "NOT_FOUND", param: "model" },
    });
    await service.dispose();
  });

  it("rejects an empty successful result", async () => {
    const service = makeService(new TerminalBackend("end_turn", ""));
    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question"),
    ).rejects.toMatchObject<AgentError>({ code: "answer_empty" });
    await service.dispose();
  });

  it("keeps an unrecognized backend code but never its message", async () => {
    // The code is an identifier and is safe to name. The message is prose a
    // backend authored, and a backend that echoes the prompt would echo it
    // here, so an unvetted code keeps its identity and loses its words.
    const service = makeService(new ErrorEventBackend());
    await expect(
      service.generateReadOnlyAnswerCandidate("Invented question"),
    ).rejects.toMatchObject<AgentError>({
      code: "provider_error",
      message: "the agent failed before completing its answer",
    });
    await service.dispose();
  });

  it("cancels the agent turn when the request signal aborts", async () => {
    const backend = new AbortBackend();
    const service = makeService(backend);
    const controller = new AbortController();
    const result = service.generateReadOnlyAnswerCandidate(
      "Invented question",
      [],
      controller.signal,
    );
    await backend.started;
    controller.abort();

    await expect(result).rejects.toMatchObject<AgentError>({ code: "answer_canceled" });
    await service.dispose();
  });
});

describe("the gates a conversation's own turns wait behind", () => {
  it("cold-loads a conversation once when two callers resume it together", async () => {
    // Both resumes go through one tail per conversation id, so the second
    // waits for the first rather than loading the transcript again. Without
    // it each caller builds a prompt and starts a turn, and one conversation
    // grows two replies to two questions nobody asked twice.
    const store = makeStore();
    await store.save({
      id: "S_cold",
      callerId: "token:A",
      model: "recording",
      backend: "recording",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented question",
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Invented question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Invented answer" }] },
      ],
    });
    let promptCalls = 0;
    let releasePrompt: () => void = () => {};
    let markPromptStarted: () => void = () => {};
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const service = new AgentService({
      backendFactory: () => new RecordingBackend(),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: async () => {
        promptCalls++;
        markPromptStarted();
        await promptGate;
        return "test";
      },
      store,
      idleTimeoutMs: 60_000,
    });

    const first = service.createSession("token:A", { resumeFromId: "S_cold" });
    await promptStarted;
    const second = service.createSession("token:B", { resumeFromId: "S_cold" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(promptCalls).toBe(1);
    releasePrompt();

    await expect(first).resolves.toMatchObject({ sessionId: "S_cold" });
    await expect(second).resolves.toMatchObject({ sessionId: "S_cold" });
    expect(promptCalls).toBe(1);
    await service.dispose();
  });

  it("refuses a turn on a conversation that is being deleted", async () => {
    // The delete lock is held across an unlink that cannot be undone, so a
    // message accepted inside that window is committed into a conversation
    // that is on its way out.
    const base = makeStore();
    let releaseDelete: () => void = () => {};
    let markDeleting: () => void = () => {};
    const deleting = new Promise<void>((resolve) => {
      markDeleting = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const store: ConversationStore = {
      save: (record) => base.save(record),
      load: (id) => base.load(id),
      list: () => base.list(),
      delete: async (id) => {
        markDeleting();
        await deleteGate;
        return base.delete(id);
      },
      setPinned: (id, pinned) => base.setPinned(id, pinned),
    };
    const service = makeService(new RecordingBackend(), store);
    const created = await service.createSession("token:A", {});
    const deletion = service.deleteConversation(created.sessionId);
    await deleting;

    expect(() => service.sendMessage("token:A", created.sessionId, "overlap")).toThrowError(
      /deletion in progress/,
    );
    releaseDelete();
    await expect(deletion).resolves.toBe(true);
    await service.dispose();
  });
});
