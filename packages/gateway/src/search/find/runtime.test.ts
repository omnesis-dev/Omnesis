// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  selectSubagentTools,
  zodToJsonSchema,
  type ChatBackend,
  type DocumentPort,
  type RecordPort,
  type TurnInput,
  type ToolHandle,
} from "@omnesis/agent";
import { AgentService } from "../../agent/service.js";
import {
  browserResultsSchema,
  BrowserFindEvidence,
  createBrowserResultsTool,
} from "./results-tool.js";
import { buildBrowserFindRuntime } from "./runtime.js";
import { BROWSER_FIND_RATE_LIMIT_PATIENCE, BROWSER_FIND_TIMEOUT_MS } from "./types.js";
import type { AgentEvent } from "@omnesis/core";

const document: DocumentPort = {
  fetch: async (id) =>
    id === "doc-1"
      ? {
          ref: {
            documentId: id,
            sourceId: "demo:one",
            sourceType: "demo",
            title: "Example activity",
            url: "https://example.org/activity/1",
          },
          document: {
            id,
            content:
              "Compare the route at https://example.org/routes/2. Read [route](https://example.org/wiki/Route_(example)). A long weekend run.",
            sourceCreatedAt: "2026-01-01",
          },
        }
      : null,
};
const context = { sessionId: "find-session", messageId: "find-message" };
const reference = {
  table: "demo_activities",
  recordKey: "demo_activities:1",
  primaryKeyColumns: [{ name: "id", value: "1" }],
};

function fixture() {
  const evidence = new BrowserFindEvidence();
  const onResults = vi.fn();
  const resolve = vi.fn<RecordPort["resolve"]>(async () => ({
    table: reference.table,
    recordKey: reference.recordKey,
    primaryKeyColumns: reference.primaryKeyColumns,
    title: "Example activity",
    keyFields: [],
    semanticTime: "2026-01-01",
    snapshot: {},
    sourceId: "demo:one",
    sourceType: "demo",
    tableDisplayName: "Activities",
    boundDocumentId: "doc-1",
  }));
  const tool = createBrowserResultsTool({
    evidence,
    ports: { document, record: { resolve } },
    onResults,
  });
  return { evidence, onResults, resolve, tool };
}

function result(destinationUrl = "https://example.org/activity/1") {
  return {
    destinationUrl,
    title: "Example activity",
    snippet: "A long weekend run.",
    evidence: { documentIds: ["doc-1"] },
  };
}

describe("grounded browser result presentation", () => {
  it("exposes both evidence shapes to model schemas and requires exactly one receipt shape", () => {
    const schema = zodToJsonSchema(browserResultsSchema) as {
      properties: {
        results: {
          items: {
            required: string[];
            properties: {
              evidence: {
                properties: Record<
                  string,
                  { required?: string[]; properties?: Record<string, unknown> }
                >;
              };
            };
          };
        };
      };
    };
    const item = schema.properties.results.items;
    expect(item.required).toEqual(expect.arrayContaining(["destinationUrl", "title", "evidence"]));
    expect(item.properties.evidence.properties).toHaveProperty("documentIds");
    expect(item.properties.evidence.properties.record!.required).toEqual([
      "table",
      "recordKey",
      "primaryKeyColumns",
    ]);
    expect(item.properties.evidence.properties.record!.properties).toHaveProperty(
      "primaryKeyColumns",
    );
    expect(
      browserResultsSchema.safeParse({ results: [{ ...result(), evidence: {} }] }).success,
    ).toBe(false);
    expect(
      browserResultsSchema.safeParse({
        results: [{ ...result(), evidence: { documentIds: ["doc-1"], record: reference } }],
      }).success,
    ).toBe(false);
  });

  it("requires retrieved evidence, accepts embedded URLs, and rejects invented snippets atomically", async () => {
    const f = fixture();
    expect(await f.tool.invoke({ results: [result()] }, context)).toMatchObject({
      kind: "error",
      code: "unretrieved_evidence",
    });
    f.evidence.observe({
      kind: "search.results",
      query: "route",
      durationMs: 0,
      results: [{ documentId: "doc-1", sourceId: "demo:one", sourceType: "demo" }],
    });
    expect(
      await f.tool.invoke({ results: [result("https://example.org/routes/2")] }, context),
    ).toMatchObject({ kind: "structured" });
    expect(f.onResults.mock.calls[0]![0][0]).toMatchObject({
      sourceUrl: "https://example.org/routes/2",
      documentId: "doc-1",
      chunkText: "A long weekend run.",
    });
    f.onResults.mockClear();
    expect(
      await f.tool.invoke(
        { results: [result(), { ...result(), snippet: "Invented distance" }] },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "ungrounded_snippet" });
    expect(f.onResults).not.toHaveBeenCalled();
  });

  it("replaces invented title claims with the source title and preserves verbatim title spans", async () => {
    const f = fixture();
    f.evidence.observe({
      kind: "search.results",
      query: "route",
      durationMs: 0,
      results: [{ documentId: "doc-1", sourceId: "demo:one", sourceType: "demo" }],
    });
    expect(
      await f.tool.invoke(
        { results: [{ ...result(), title: "World record marathon winner" }] },
        context,
      ),
    ).toMatchObject({ kind: "structured" });
    expect(f.onResults.mock.lastCall![0][0]).toMatchObject({
      title: "Example activity",
      chunkText: "A long weekend run.",
    });
    expect(
      await f.tool.invoke({ results: [{ ...result(), title: "A long weekend run." }] }, context),
    ).toMatchObject({ kind: "structured" });
    expect(f.onResults.mock.lastCall![0][0]).toMatchObject({ title: "A long weekend run." });
  });

  it("rejects fabricated projected SQL URLs and resolves the real bound document", async () => {
    const f = fixture();
    f.evidence.observe({
      kind: "sql.rows",
      sql: "SELECT id, 'https://example.org/invented' AS url FROM demo_activities",
      columns: ["id", "url"],
      rows: [["1", "https://example.org/invented"]],
      rowCount: 1,
      durationMs: 0,
      rowIdentities: [reference],
    });
    const item = { ...result(), evidence: { record: reference } };
    expect(
      await f.tool.invoke(
        { results: [{ ...item, destinationUrl: "https://example.org/invented" }] },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "ungrounded_destination" });
    expect(await f.tool.invoke({ results: [item] }, context)).toMatchObject({ kind: "structured" });
    expect(f.resolve).toHaveBeenCalledWith({
      reference,
      snapshot: { id: "1", url: "https://example.org/invented" },
      includeBrowserUrls: true,
    });
    expect(f.onResults).toHaveBeenCalledTimes(1);
  });

  it("presents authoritative stored row URLs without any bound browser document", async () => {
    const f = fixture();
    f.evidence.observe({
      kind: "sql.rows",
      sql: "SELECT id FROM demo_activities",
      columns: ["id"],
      rows: [["1"]],
      rowCount: 1,
      durationMs: 0,
      rowIdentities: [reference],
    });
    f.resolve.mockImplementation(async () => ({
      table: reference.table,
      recordKey: reference.recordKey,
      primaryKeyColumns: reference.primaryKeyColumns,
      title: "Stored activity",
      keyFields: [],
      semanticTime: "2026-01-01",
      snapshot: { name: "Stored activity" },
      sourceId: "demo:one",
      sourceType: "demo",
      tableDisplayName: "Activities",
      boundDocumentId: null,
      browserUrls: ["https://example.org/activity/1"],
    }));
    expect(
      await f.tool.invoke(
        {
          results: [
            {
              destinationUrl: "https://example.org/invented",
              title: "Stored activity",
              evidence: { record: reference },
            },
          ],
        },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "ungrounded_destination" });
    expect(
      await f.tool.invoke(
        {
          results: [
            {
              destinationUrl: "https://example.org/activity/1",
              title: "Invented winner",
              evidence: { record: reference },
            },
          ],
        },
        context,
      ),
    ).toMatchObject({ kind: "structured" });
    expect(f.onResults).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Stored activity",
        sourceUrl: "https://example.org/activity/1",
        sourceId: "demo:one",
      }),
    ]);
    expect(f.onResults.mock.calls[0]![0][0]).not.toHaveProperty("documentId");
  });

  it("supports explicit no matches and refuses unsafe schemes and canceled emissions", async () => {
    const f = fixture();
    expect(await f.tool.invoke({ results: [] }, context)).toMatchObject({ kind: "structured" });
    expect(f.onResults).toHaveBeenCalledWith([]);
    expect(
      await f.tool.invoke({ results: [result("javascript:alert(1)")] }, context),
    ).toMatchObject({ kind: "error", code: "ungrounded_destination" });
    f.onResults.mockClear();
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.tool.invoke({ results: [] }, { ...context, abortSignal: controller.signal }),
    ).toMatchObject({ kind: "error", code: "canceled" });
    expect(f.onResults).not.toHaveBeenCalled();
  });
});

describe("browser result evidence boundaries", () => {
  it("emits cumulative deduplicated snapshots and rejects a batch over the result cap", async () => {
    const f = fixture();
    f.evidence.documentIds.add("doc-1");
    await f.tool.invoke({ results: [result()] }, context);
    await f.tool.invoke({ results: [result("https://example.org/routes/2")] }, context);
    await f.tool.invoke({ results: [result()] }, context);
    expect(f.onResults.mock.lastCall?.[0]).toHaveLength(2);
    const limited = createBrowserResultsTool({
      evidence: f.evidence,
      ports: { document },
      limit: 1,
      onResults: f.onResults,
    });
    f.onResults.mockClear();
    expect(
      await limited.invoke(
        { results: [result(), result("https://example.org/routes/2")] },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "too_many_results" });
    expect(f.onResults).not.toHaveBeenCalled();
  });

  it("allows thirty grounded destinations across batches but atomically rejects the thirty-first", async () => {
    const evidence = new BrowserFindEvidence();
    evidence.documentIds.add("doc-many");
    const urls = Array.from(
      { length: 31 },
      (_, index) => `https://example.org/destinations/${index + 1}`,
    );
    const onResults = vi.fn();
    const tool = createBrowserResultsTool({
      evidence,
      limit: 200,
      onResults,
      ports: {
        document: {
          fetch: async () => ({
            ref: {
              documentId: "doc-many",
              title: "Destination directory",
              sourceId: "demo:one",
              sourceType: "demo",
            },
            document: { id: "doc-many", content: urls.join("\n") },
          }),
        },
      },
    });
    const items = urls.map((destinationUrl) => ({
      destinationUrl,
      title: "Destination directory",
      evidence: { documentIds: ["doc-many"] },
    }));
    expect(await tool.invoke({ results: items.slice(0, 21) }, context)).toMatchObject({
      kind: "structured",
    });
    expect(await tool.invoke({ results: items.slice(21, 30) }, context)).toMatchObject({
      kind: "structured",
    });
    expect(onResults.mock.lastCall?.[0]).toHaveLength(30);
    expect(await tool.invoke({ results: items.slice(30) }, context)).toMatchObject({
      kind: "error",
      code: "too_many_results",
    });
    expect(onResults).toHaveBeenCalledTimes(2);
    expect(browserResultsSchema.safeParse({ results: items }).success).toBe(false);
  });

  it("retains balanced URL parentheses and sends only the original SQL reference to the port", async () => {
    const f = fixture();
    f.evidence.documentIds.add("doc-1");
    expect(
      await f.tool.invoke(
        { results: [result("https://example.org/wiki/Route_(example)")] },
        context,
      ),
    ).toMatchObject({ kind: "structured" });
    f.evidence.observe({
      kind: "sql.rows",
      sql: "SELECT * FROM demo_activities",
      columns: ["id"],
      rows: [["1"]],
      rowCount: 1,
      durationMs: 0,
      rowIdentities: [reference],
    });
    const tampered = {
      ...reference,
      primaryKeyColumns: [{ ...reference.primaryKeyColumns[0]!, castType: "untrusted cast" }],
    };
    expect(
      await f.tool.invoke({ results: [{ ...result(), evidence: { record: tampered } }] }, context),
    ).toMatchObject({ kind: "structured" });
    expect(f.resolve).toHaveBeenLastCalledWith({
      reference,
      snapshot: { id: "1" },
      includeBrowserUrls: true,
    });
  });

  it("bounds retained evidence without authorizing dropped identities", async () => {
    const f = fixture();
    f.evidence.observe({
      kind: "search.results",
      query: "examples",
      durationMs: 0,
      results: Array.from({ length: 5001 }, (_, index) => ({
        documentId: `doc-${index}`,
        sourceId: "demo:one",
        sourceType: "demo",
      })),
    });
    expect(f.evidence.documentIds.size).toBe(5000);
    expect(f.evidence.budgetExhausted).toBe(true);
    expect(
      await f.tool.invoke(
        { results: [{ ...result(), evidence: { documentIds: ["doc-5000"] } }] },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "unretrieved_evidence" });
    expect(f.onResults).not.toHaveBeenCalled();
  });
});

class PuppetBackend implements ChatBackend {
  readonly name = "puppet";
  readonly model = "puppet";
  tools: string[] = [];
  systemPrompt = "";
  constructor(
    private readonly present = true,
    private readonly fail = false,
  ) {}
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.tools = input.tools.map((tool) => tool.name);
    this.systemPrompt = input.systemPrompt;
    const payload = { sessionId: input.sessionId, messageId: input.messageId };
    yield { type: "agent.message.start", payload: { ...payload, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { ...payload, delta: "Checking the route." } };
    await input.tools
      .find((tool) => tool.name === "fetch_many")!
      .invoke({ documents: [{ documentId: "doc-1" }] }, context);
    yield {
      type: "agent.message.end",
      payload: { ...payload, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2 } },
    };
    yield { type: "agent.text.delta", payload: { ...payload, delta: "Found the route." } };
    if (this.fail) throw new Error("Fictional backend failure");
    if (this.present)
      await input.tools
        .find((tool) => tool.name === "present_browser_results")!
        .invoke({ results: [result()] }, context);
    yield {
      type: "agent.message.end",
      payload: { ...payload, stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1 } },
    };
  }
}

class FinalizationBackend implements ChatBackend {
  readonly name = "puppet";
  readonly model = "puppet";
  readonly inputs: TurnInput[] = [];
  readonly disposals: number[] = [];
  async dispose(): Promise<void> {
    this.disposals.push(this.inputs.length);
  }
  constructor(private readonly succeeds = true) {}
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    const payload = { sessionId: input.sessionId, messageId: input.messageId };
    yield { type: "agent.message.start", payload: { ...payload, role: "assistant" } };
    if (this.inputs.length === 1) {
      await input.tools
        .find((tool) => tool.name === "fetch_many")!
        .invoke({ documents: [{ documentId: "doc-1" }] }, context);
      yield {
        type: "agent.text.delta",
        payload: { ...payload, delta: "Here is the source link: https://example.org/activity/1" },
      };
    } else if (this.succeeds) {
      await input.tools
        .find((tool) => tool.name === "present_browser_results")!
        .invoke({ results: [result()] }, context);
    } else {
      yield { type: "agent.text.delta", payload: { ...payload, delta: "Only prose" } };
    }
    yield {
      type: "agent.message.end",
      payload: { ...payload, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } },
    };
  }
}

describe("ephemeral read-only browser search", () => {
  it("retains builtin retrieval handles with the read-only default and excludes explicit writes", async () => {
    const retrieval: ToolHandle[] = [];
    const service = new AgentService({
      backendFactory: () => new PuppetBackend(),
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
    });
    const session = await service.buildReadOnlySearchSession({
      systemPromptSuffix: "One read-only search",
      tools: [],
      wrapRetrievalTool: (tool) => {
        retrieval.push(tool);
        return tool;
      },
    });
    const fetch = retrieval.find((tool) => tool.name === "fetch_many");
    expect(fetch).toBeDefined();
    expect(fetch!.mutates).toBeUndefined();
    expect(selectSubagentTools([{ ...fetch!, mutates: true }], ["fetch_many"])).toEqual([]);
    expect(retrieval.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_many", "fetch_many"]),
    );
    await session.dispose();
    await service.dispose();
  });

  it("supplies the standalone no-reply policy for a greeting and accepts explicit empty results", async () => {
    const inputs: TurnInput[] = [];
    const backend: ChatBackend = {
      name: "puppet",
      model: "puppet",
      async *runTurn(input): AsyncIterable<AgentEvent> {
        inputs.push(input);
        const payload = { sessionId: input.sessionId, messageId: input.messageId };
        yield { type: "agent.message.start", payload: { ...payload, role: "assistant" } };
        yield {
          type: "agent.text.delta",
          payload: { ...payload, delta: "There is no search target in this greeting." },
        };
        await input.tools
          .find((tool) => tool.name === "present_browser_results")!
          .invoke({ results: [] }, context);
        yield { type: "agent.message.end", payload: { ...payload, stopReason: "end_turn" } };
      },
    };
    const search = vi.fn(async () => ({ query: "", durationMs: 0, results: [] }));
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { document, search: { search } },
      systemPrompt: "Corpus prompt",
    });
    const onResults = vi.fn();
    const result = await buildBrowserFindRuntime({
      query: "hi",
      agent: service,
      signal: new AbortController().signal,
      onEvent: () => {},
      onResults,
    });
    expect(result).toEqual({ presented: true });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.systemPrompt).toContain("exactly one user message and one final response");
    expect(inputs[0]!.systemPrompt).toContain("The user cannot reply");
    expect(inputs[0]!.systemPrompt).toContain("Never ask a question");
    expect(inputs[0]!.systemPrompt).toContain('For a greeting such as "hi"');
    expect(inputs[0]!.systemPrompt).toContain("call present_browser_results with an empty array");
    expect(onResults).toHaveBeenCalledExactlyOnceWith([]);
    expect(search).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("streams one grounded turn, hot-resolves the agent, excludes writes and conversation side effects", async () => {
    const backend = new PuppetBackend();
    const factory = vi.fn(() => backend);
    const broadcast = vi.fn();
    const prompt = vi.fn(() => "Current corpus prompt");
    const recordSpend = vi.fn();
    const service = new AgentService({
      backendFactory: factory,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: prompt,
      broadcastEvent: broadcast,
      recordSpend,
    });
    const onResults = vi.fn();
    const events: AgentEvent[] = [];
    expect(
      await buildBrowserFindRuntime({
        query: "Find my route",
        limit: 30,
        agent: service,
        timeZone: "Europe/Paris",
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
        onResults,
      }),
    ).toEqual({ presented: true });
    expect(backend.systemPrompt).toContain("Present up to 30 relevant, grounded destinations");
    expect(backend.systemPrompt).toContain("return fewer when the evidence supports fewer");
    expect(factory).toHaveBeenLastCalledWith("agent");
    expect(prompt).toHaveBeenCalledWith("answer", { timeZone: "Europe/Paris" });
    expect(backend.tools).toEqual(
      expect.arrayContaining(["search_many", "fetch_many", "present_browser_results"]),
    );
    expect(
      backend.tools.some((name) =>
        /annotate|cite_record|plan|spawn|watch_|memory|create/.test(name),
      ),
    ).toBe(false);
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "agent.text.delta")).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
    expect(service.sessionCount()).toBe(0);
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 15, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
      completed: true,
    });
    await service.dispose();
  });

  it("repairs a prose-only research ending with a private presentation-only phase", async () => {
    const backend = new FinalizationBackend();
    const broadcast = vi.fn(),
      recordSpend = vi.fn(),
      onResults = vi.fn();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
      broadcastEvent: broadcast,
      recordSpend,
    });
    const events: AgentEvent[] = [];
    expect(
      await buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
        onResults,
      }),
    ).toEqual({ presented: true });
    expect(backend.inputs).toHaveLength(2);
    expect(backend.disposals).toEqual([1, 2]);
    expect(backend.inputs[1]!.tools.map((tool) => tool.name)).toEqual(["present_browser_results"]);
    expect(
      backend.inputs[1]!.history.some(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.kind === "text" && part.text === "Find route"),
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "agent.user.message")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "agent.text.delta")
        .map((event) => event.payload.delta),
    ).toContain("Here is the source link: https://example.org/activity/1");
    expect(onResults.mock.lastCall![0][0].sourceUrl).toBe("https://example.org/activity/1");
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 20, outputTokens: 4 },
      completed: true,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(await service.listConversations()).toHaveLength(0);
    await service.dispose();
  });

  it("bounds finalization retries and fails explicitly when every response remains prose-only", async () => {
    const backend = new FinalizationBackend(false),
      onResults = vi.fn(),
      recordSpend = vi.fn();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
      recordSpend,
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: new AbortController().signal,
        onEvent: () => {},
        onResults,
      }),
    ).rejects.toThrow("could not present supported search results");
    expect(backend.inputs).toHaveLength(3);
    expect(onResults).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 30, outputTokens: 6 },
      completed: false,
    });
    await service.dispose();
  });

  it("waits out a provider rate limit on the research and every finalization turn", async () => {
    const backend = new FinalizationBackend(false);
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: new AbortController().signal,
        onEvent: () => {},
        onResults: () => {},
      }),
    ).rejects.toThrow("could not present supported search results");
    expect(backend.inputs).toHaveLength(3);
    for (const input of backend.inputs)
      expect(input.rateLimitPatience).toEqual(BROWSER_FIND_RATE_LIMIT_PATIENCE);
    // One request's wait must leave the search time to finish before its deadline.
    expect(BROWSER_FIND_RATE_LIMIT_PATIENCE.maxTotalDelayMs).toBeLessThan(BROWSER_FIND_TIMEOUT_MS);
    await service.dispose();
  });

  it("keeps the interactive rate-limit default for a read-only session that names no patience", async () => {
    const backend = new FinalizationBackend();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
    });
    const session = await service.buildReadOnlySearchSession({
      systemPromptSuffix: "One read-only search",
      tools: [],
    });
    await session.send("Find route").completion;
    expect(backend.inputs[0]?.rateLimitPatience).toBeUndefined();
    await session.dispose();
    await service.dispose();
  });

  it("rechecks caller authority before a finalization model pass", async () => {
    const backend = new FinalizationBackend(),
      recordSpend = vi.fn(),
      onResults = vi.fn();
    let calls = 0;
    const beforeModelCall = vi.fn(() => {
      if (++calls > 1) throw new Error("Fictional authority revoked");
    });
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
      recordSpend,
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: new AbortController().signal,
        beforeModelCall,
        onEvent: () => {},
        onResults,
      }),
    ).rejects.toThrow("Fictional authority revoked");
    expect(beforeModelCall).toHaveBeenCalledTimes(2);
    expect(backend.inputs).toHaveLength(1);
    expect(onResults).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 10, outputTokens: 2 },
      completed: false,
    });
    await service.dispose();
  });

  it("does not run a finalization request after cancellation", async () => {
    const backend = new FinalizationBackend(),
      controller = new AbortController();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "agent.message.end") controller.abort();
        },
        onResults: () => {},
      }),
    ).rejects.toThrow();
    expect(backend.inputs).toHaveLength(1);
    await service.dispose();
  });

  it("records consumed tool-round tokens once when the backend fails", async () => {
    const recordSpend = vi.fn();
    const service = new AgentService({
      backendFactory: () => new PuppetBackend(true, true),
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
      recordSpend,
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: new AbortController().signal,
        onEvent: () => {},
        onResults: () => {},
      }),
    ).rejects.toThrow("Fictional backend failure");
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 10, outputTokens: 2 },
      completed: false,
    });
    await service.dispose();
  });

  it("records cancellation spend without emitting late results", async () => {
    const recordSpend = vi.fn();
    const onResults = vi.fn();
    const controller = new AbortController();
    const service = new AgentService({
      backendFactory: () => new PuppetBackend(),
      ports: {
        document,
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      },
      systemPrompt: "Corpus prompt",
      recordSpend,
    });
    await expect(
      buildBrowserFindRuntime({
        query: "Find route",
        agent: service,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "agent.text.delta" && event.payload.delta === "Found the route.")
            controller.abort();
        },
        onResults,
      }),
    ).rejects.toThrow("Search did not finish");
    expect(onResults).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      mechanism: "browser-find",
      modelId: "puppet",
      usage: { inputTokens: 10, outputTokens: 2 },
      completed: false,
    });
    await service.dispose();
  });
});
