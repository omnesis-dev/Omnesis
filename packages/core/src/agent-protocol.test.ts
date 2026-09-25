// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  agentCitationEvent,
  agentErrorEvent,
  agentTerminalFailureSchema,
  formatProviderFailureDetail,
  sanitizeProviderFailureField,
  agentMessageEndEvent,
  agentMessageSendRequest,
  agentMessageSendResponse,
  agentMessageStartEvent,
  agentSessionCancelRequest,
  agentSessionCreateRequest,
  agentSessionCreateResponse,
  agentTextDeltaEvent,
  agentThinkingDeltaEvent,
  agentToolResultEvent,
  agentToolStartEvent,
  agentCitationsUpdateEvent,
  type AgentEvent,
  toolResultSchema,
  docRefSchema,
  trailEventSchema,
  eventTrailSchema,
  KNOWN_AGENT_ERROR_CODES,
  isSelfQuoteAuthor,
} from "./agent-protocol.js";
import {
  wsCommandSchemas,
  wsEventSchemas,
  isKnownCommandType,
  isKnownEventType,
  parseEventPayload,
  parseRequestPayload,
} from "./ws-messages.js";

describe("agent-protocol", () => {
  it("publishes stable context-window terminal codes", () => {
    expect(KNOWN_AGENT_ERROR_CODES).toContain("context_window_exceeded");
    expect(KNOWN_AGENT_ERROR_CODES).toContain("output_truncated");
  });

  it("registers every agent command in the typed WS registry", () => {
    expect(isKnownCommandType("agent.session.create")).toBe(true);
    expect(isKnownCommandType("agent.message.send")).toBe(true);
    expect(isKnownCommandType("agent.session.cancel")).toBe(true);
    expect(wsCommandSchemas["agent.session.create"]).toBeDefined();
    expect(wsCommandSchemas["agent.message.send"]).toBeDefined();
    expect(wsCommandSchemas["agent.session.cancel"]).toBeDefined();
  });

  it("registers every agent event in the typed WS registry", () => {
    const eventTypes: AgentEvent["type"][] = [
      "agent.message.start",
      "agent.text.delta",
      "agent.thinking.delta",
      "agent.tool.start",
      "agent.tool.result",
      "agent.citation",
      "agent.citations.update",
      "agent.message.end",
      "agent.error",
    ];
    for (const t of eventTypes) {
      expect(isKnownEventType(t)).toBe(true);
      expect(wsEventSchemas[t]).toBeDefined();
    }
  });

  it("parses an empty session.create request via parseRequestPayload", () => {
    const r = parseRequestPayload("agent.session.create", {});
    expect(r.ok).toBe(true);
  });

  it("parses an authoritative terminal failure with explicit context provenance", () => {
    expect(
      agentMessageEndEvent.parse({
        sessionId: "s",
        messageId: "m",
        stopReason: "error",
        usage: { inputTokens: 8_100, outputTokens: 12 },
        context: {
          inputTokens: 8_100,
          peakInputTokens: 8_100,
          maxInputTokens: 8_160,
          contextWindowTokens: 8_192,
          reservedOutputTokens: 128,
          safetyMarginTokens: 32,
          measurement: "provider_count",
          limitSource: "provider",
          requestIteration: 2,
        },
        failure: {
          code: "context_window_exceeded",
          message:
            "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
          retryable: false,
          backend: "anthropic",
          model: "example-model",
        },
      }).failure?.code,
    ).toBe("context_window_exceeded");
  });

  it("validates an input-only context ceiling as a positive integer", () => {
    expect(
      agentMessageEndEvent.parse({
        sessionId: "s",
        messageId: "m",
        stopReason: "error",
        context: {
          inputTokens: 8_193,
          maxInputTokens: 8_192,
          measurement: "provider_count",
          limitSource: "provider",
          requestIteration: 1,
        },
      }).context?.maxInputTokens,
    ).toBe(8_192);
    expect(
      agentMessageEndEvent.safeParse({
        sessionId: "s",
        messageId: "m",
        stopReason: "error",
        context: {
          maxInputTokens: 0,
          measurement: "unknown",
          limitSource: "configured",
          requestIteration: 1,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps terminal failure and context fields additive for older payloads", () => {
    const parsed = agentSessionCreateResponse.parse({
      sessionId: "s",
      model: "example-model",
      backend: "http",
      messageCount: 0,
      title: "",
      messages: [],
    });
    expect(parsed.terminalFailure).toBeUndefined();
  });

  it("parses durable context exhaustion outside the conversation transcript", () => {
    const parsed = agentSessionCreateResponse.parse({
      sessionId: "s",
      model: "example-model",
      backend: "http",
      messageCount: 1,
      title: "Long conversation",
      messages: [{ role: "user", parts: [{ kind: "text", text: "Continue" }] }],
      terminalFailure: {
        code: "context_window_exceeded",
        message:
          "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
        retryable: false,
        backend: "http",
        model: "example-model",
        failedAt: "2026-07-29T12:00:00.000Z",
        context: {
          inputTokens: 8_100,
          contextWindowTokens: 8_192,
          measurement: "provider_reported",
          limitSource: "configured",
          requestIteration: 3,
        },
      },
    });
    expect(parsed.terminalFailure?.code).toBe("context_window_exceeded");
    expect(parsed.messages).toHaveLength(1);
  });

  it("parses a durable partial-answer marker outside model-visible history", () => {
    const parsed = agentSessionCreateResponse.parse({
      sessionId: "s",
      model: "example-model",
      backend: "http",
      messageCount: 2,
      title: "Long answer",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Explain the constraints." }] },
        { role: "assistant", parts: [{ kind: "text", text: "The first constraint is" }] },
      ],
      lastTurnFailure: {
        code: "output_truncated",
        message: "The model reached its output limit before completing this response.",
        retryable: false,
        backend: "http",
        model: "example-model",
      },
    });
    expect(parsed.lastTurnFailure?.code).toBe("output_truncated");
    expect(parsed.messages).toHaveLength(2);
  });

  it("parses message.send request", () => {
    const r = parseRequestPayload("agent.message.send", {
      sessionId: "s_1",
      text: "find emails from Quentin",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects empty message text", () => {
    const r = parseRequestPayload("agent.message.send", { sessionId: "s_1", text: "" });
    expect(r.ok).toBe(false);
  });

  it("round-trips a search.results tool-result", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_1",
      result: {
        kind: "search.results" as const,
        query: "Paris apartment",
        durationMs: 142,
        candidates: 8,
        results: [
          {
            documentId: "doc_a",
            sourceType: "gmail",
            sourceId: "gmail:me@example.com",
            documentType: "email",
            title: "Re: apartment in 11th",
            snippet: "I think we should…",
            ts: 1_700_000_000_000,
          },
        ],
      },
      durationMs: 142,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.result.kind).toBe("search.results");
  });

  it("round-trips an event_trail.built tool-result", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_2",
      result: {
        kind: "event_trail.built" as const,
        seeds: ["doc_z"],
        events: [
          {
            eventId: "doc_z",
            at: "2026-03-12T09:14:00Z",
            kind: "seed",
            doc: { documentId: "doc_z", title: "Lease", sourceId: "gmail:me" },
            attachments: [],
            people: [],
            related: [],
          },
        ],
        truncated: false,
        stats: { visited: 1, elapsedMs: 12, maxDepthReached: 0 },
      },
      durationMs: 12,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
  });

  it("round-trips a person.results tool-result with multiple candidates", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_lp",
      result: {
        kind: "person.results" as const,
        query: "maria smith",
        durationMs: 24,
        results: [
          {
            canonicalId: "p_maria_smith_work",
            displayName: "Maria Smith",
            aliases: ["maria.smith@acme.com", "+15550133"],
            emailCount: 12,
            chatCount: 3,
            lastInteraction: 1_726_345_600_000,
            interactionScore: 0.82,
          },
          {
            canonicalId: "p_maria_smith_personal",
            displayName: "Maria Smith",
            aliases: ["maria@smith.family"],
            emailCount: 4,
            lastInteraction: 1_710_000_000_000,
            interactionScore: 0.21,
          },
        ],
      },
      durationMs: 24,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    if (r.value.result.kind !== "person.results") {
      throw new Error("expected person.results");
    }
    expect(r.value.result.results).toHaveLength(2);
    expect(r.value.result.results[0]?.canonicalId).toBe("p_maria_smith_work");
  });

  it("accepts a person.results tool-result with zero candidates (empty success)", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_lp_empty",
      result: {
        kind: "person.results" as const,
        query: "nobody by that name",
        durationMs: 7,
        results: [],
      },
      durationMs: 7,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
  });

  it("round-trips a document.byUrl tool-result with a ref", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_url",
      result: {
        kind: "document.byUrl" as const,
        url: "https://drive.google.com/file/d/abc/view",
        durationMs: 8,
        ref: {
          documentId: "doc_a",
          sourceType: "google-drive",
          sourceId: "google-drive:self",
          documentType: "file",
          title: "Vendor evaluation matrix",
          snippet: "Vendor,Throughput,SOC2…",
          ts: 1_757_237_400_000,
          url: "https://drive.google.com/file/d/abc/view",
        },
      },
      durationMs: 8,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    if (r.value.result.kind !== "document.byUrl") {
      throw new Error("expected document.byUrl");
    }
    expect(r.value.result.url).toBe("https://drive.google.com/file/d/abc/view");
    expect(r.value.result.ref?.documentId).toBe("doc_a");
  });

  it("accepts a document.byUrl tool-result with no ref (URL not in corpus)", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_url_miss",
      result: {
        kind: "document.byUrl" as const,
        url: "https://example.com/not-in-corpus",
        durationMs: 4,
      },
      durationMs: 4,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    if (r.value.result.kind !== "document.byUrl") {
      throw new Error("expected document.byUrl");
    }
    expect(r.value.result.ref).toBeUndefined();
  });

  it("rejects a tool-result with an unknown kind", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_x",
      result: { kind: "telepathy", payload: "wat" },
      durationMs: 1,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(false);
  });

  it("parses text.delta, citation, citations.update, error", () => {
    const cases: Array<[keyof typeof wsEventSchemas, unknown]> = [
      ["agent.message.start", { sessionId: "s", messageId: "m", role: "assistant" }],
      ["agent.text.delta", { sessionId: "s", messageId: "m", delta: "Hello" }],
      ["agent.thinking.delta", { sessionId: "s", messageId: "m", delta: "let's see" }],
      [
        "agent.tool.start",
        {
          sessionId: "s",
          messageId: "m",
          toolCallId: "tc",
          tool: "search_documents",
          args: { query: "x" },
          intent: "find foo",
        },
      ],
      [
        "agent.citation",
        {
          sessionId: "s",
          messageId: "m",
          toolCallId: "tc_cite",
          documentId: "doc",
          ref: { documentId: "doc", sourceType: "gmail", sourceId: "gmail:me" },
          quote: "the exact words",
        },
      ],
      [
        "agent.citations.update",
        {
          sessionId: "s",
          added: [{ documentId: "doc", sourceType: "gmail", sourceId: "gmail:me" }],
          removed: [],
        },
      ],
      [
        "agent.message.end",
        {
          sessionId: "s",
          messageId: "m",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 42 },
        },
      ],
      ["agent.error", { sessionId: "s", code: "rate_limited", message: "too fast" }],
    ];
    for (const [type, payload] of cases) {
      const r = parseEventPayload(type, payload);
      expect(r.ok, `failed to parse ${type}: ${r.ok ? "" : r.error}`).toBe(true);
    }
  });

  it("compile-time AgentEvent union covers every registered event type", () => {
    // If a new event type is added without updating the AgentEvent union in
    // agent-protocol.ts, this test still passes — but the union's
    // exhaustiveness check below would fail to compile. The runtime side
    // simply asserts the union's stringly types match the registry.
    const unionTypes: AgentEvent["type"][] = [
      "agent.message.start",
      "agent.text.delta",
      "agent.thinking.delta",
      "agent.tool.start",
      "agent.tool.result",
      "agent.citation",
      "agent.citations.update",
      "agent.message.end",
      "agent.error",
    ];
    for (const t of unionTypes) expect(t in wsEventSchemas).toBe(true);
  });

  it("schemas reject unknown extra fields on a docRef (strict-ish)", () => {
    // We don't enforce strict() on docRef so extra fields pass — this test
    // documents that fact so a future agent doesn't tighten the schema
    // without noticing the wire impact.
    const r = docRefSchema.safeParse({
      documentId: "d",
      sourceType: "x",
      sourceId: "x:1",
      somethingNew: "ignored-but-not-rejected",
    });
    expect(r.success).toBe(true);
  });

  it("accepts the adjacency fields (refCount + breadcrumb) on a docRef", () => {
    const r = docRefSchema.safeParse({
      documentId: "d",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Vendor email",
      refCount: 6,
      breadcrumb: [
        {
          documentId: "att-1",
          title: "Q4-Vendor-Assessment.pdf",
          edge: "contains",
          appUrl: "googledrive://file/att-1",
        },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues));
    expect(r.data.refCount).toBe(6);
    expect(r.data.breadcrumb?.[0]?.edge).toBe("contains");
  });

  it("rejects a negative refCount (connectedness is a non-negative count)", () => {
    const r = docRefSchema.safeParse({
      documentId: "d",
      sourceType: "x",
      sourceId: "x:1",
      refCount: -1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a breadcrumb missing the documentId that makes it citable", () => {
    const r = docRefSchema.safeParse({
      documentId: "d",
      sourceType: "x",
      sourceId: "x:1",
      breadcrumb: [{ title: "orphan", edge: "url" }],
    });
    expect(r.success).toBe(false);
  });

  it("round-trips a search.results tool-result carrying refCount + breadcrumb", () => {
    const evt = {
      sessionId: "s_1",
      messageId: "m_1",
      toolCallId: "tc_adj",
      result: {
        kind: "search.results" as const,
        query: "vendor assessment",
        durationMs: 12,
        results: [
          {
            documentId: "doc_a",
            sourceType: "gmail",
            sourceId: "gmail:me",
            title: "Q4 Vendor Assessment",
            refCount: 4,
            breadcrumb: [{ documentId: "att_1", title: "deck.pdf", edge: "contains" }],
          },
        ],
      },
      durationMs: 12,
    };
    const r = parseEventPayload("agent.tool.result", evt);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
  });

  it("accepts an empty session.create payload (no fields required)", () => {
    const r = agentSessionCreateRequest.safeParse({});
    expect(r.success).toBe(true);
  });

  it("session.create response carries messageCount, title, busy, and prior messages", () => {
    const r = agentSessionCreateResponse.safeParse({
      sessionId: "s_1",
      model: "claude-haiku-4-5",
      backend: "anthropic",
      messageCount: 2,
      title: "trip planning",
      busy: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            { kind: "thinking", text: "let me think" },
            { kind: "text", text: "Hello!" },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.busy).toBe(true);
  });

  it("session.create response defaults busy to false when the field is omitted", () => {
    // Backward compatibility: an older gateway that doesn't ship `busy` parses
    // cleanly and the client treats the session as idle.
    const r = agentSessionCreateResponse.safeParse({
      sessionId: "s_1",
      model: "claude-haiku-4-5",
      backend: "anthropic",
      messageCount: 0,
      title: "",
      messages: [],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.busy).toBe(false);
  });

  it("still decodes a tool result recorded by an authoring tool that has since been retired", () => {
    // `toolResultSchema` decodes stored transcripts, so a retired tool's result
    // kind has to outlive the tool: drop it from the union and every
    // conversation containing one stops parsing on reopen.
    const stored = toolResultSchema.safeParse({
      kind: "trigger.toggled",
      triggerId: "trg_9f1c",
      name: "Parcel delays",
      enabled: false,
    });
    expect(stored.success).toBe(true);
  });

  it("decodes an authoritative failure on a joined sub-agent result", () => {
    const stored = toolResultSchema.parse({
      kind: "subagent.joined",
      results: [
        {
          subagentId: "S.sub.1",
          specialist: "history-sweep",
          status: "failed",
          summary: "Partial evidence collected before the worker reached its output limit.",
          citations: [],
          failure: {
            code: "output_truncated",
            message: "The model reached its output limit.",
            retryable: false,
            backend: "http",
            model: "fictional-model",
          },
        },
      ],
    });

    expect(stored).toMatchObject({
      kind: "subagent.joined",
      results: [{ status: "failed", failure: { code: "output_truncated" } }],
    });
  });

  it("KNOWN_AGENT_ERROR_CODES catalogs session_cap_exceeded and listener_cap_exceeded", () => {
    expect(KNOWN_AGENT_ERROR_CODES).toContain("session_cap_exceeded");
    expect(KNOWN_AGENT_ERROR_CODES).toContain("listener_cap_exceeded");
  });

  // ─── trailEvent / eventTrail schemas ────────────────────────────────

  it("trailEventSchema accepts a leaf event with no attachments / people / related", () => {
    const result = trailEventSchema.safeParse({
      eventId: "doc-1",
      at: "2026-03-12T09:14:00Z",
      kind: "document",
      doc: {
        documentId: "doc-1",
        title: "Lease",
        sourceId: "gmail:user@example.com",
      },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(true);
  });

  it("trailEventSchema accepts a nested attachment inside attachments[]", () => {
    const result = trailEventSchema.safeParse({
      eventId: "email-1",
      at: "2026-03-12T09:14:00Z",
      kind: "seed",
      doc: { documentId: "email-1", title: "Lease", sourceId: "gmail:x@y.com" },
      attachments: [
        {
          eventId: "pdf-1",
          at: "2026-03-12T09:14:00Z",
          kind: "document",
          doc: { documentId: "pdf-1", title: "lease.pdf", sourceId: "gmail:x@y.com" },
          attachments: [],
          people: [],
          related: [],
        },
      ],
      people: [{ personId: "p1", name: "Alice", role: "sender", isSelf: false }],
      related: [],
    });
    expect(result.success).toBe(true);
  });

  it("trailEventSchema rejects an event missing required keys", () => {
    const result = trailEventSchema.safeParse({
      eventId: "doc-1",
      at: null,
      // kind missing
      doc: { documentId: "doc-1", title: "x", sourceId: "src:x" },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(false);
  });

  it("trailEventSchema rejects an unknown event kind", () => {
    const result = trailEventSchema.safeParse({
      eventId: "d",
      at: null,
      kind: "made-up",
      doc: { documentId: "d", title: "t", sourceId: "s" },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(false);
  });

  it("trailEventSchema accepts a document event carrying a deduped record (#757)", () => {
    const result = trailEventSchema.safeParse({
      eventId: "doc-1",
      at: "2026-05-01T08:30:00Z",
      kind: "document",
      doc: { documentId: "doc-1", title: "Morning ride", sourceId: "demo:acct1" },
      record: {
        recordKey: "row:demo_activities:act-1",
        table: "demo_activities",
        tableDisplayName: "Demo Activities",
        title: "Morning ride",
        keyFields: [{ label: "Distance", value: "12.5" }],
        semanticTime: "2026-05-01T08:30:00Z",
        sourceId: "demo:acct1",
        sourceType: "demo",
        boundDocumentId: "doc-1",
        snapshot: { id: "act-1", name: "Morning ride" },
      },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(true);
  });

  it("trailEventSchema accepts a record-only event with no doc (#757)", () => {
    const result = trailEventSchema.safeParse({
      eventId: "row:demo_txn:tx-1",
      at: "2026-05-02T12:00:00Z",
      kind: "record",
      record: {
        recordKey: "row:demo_txn:tx-1",
        table: "demo_txn",
        tableDisplayName: "Demo Transactions",
        title: "Coffee",
        keyFields: [],
        semanticTime: "2026-05-02T12:00:00Z",
        sourceId: "demo:acct1",
        sourceType: "demo",
        boundDocumentId: null,
        snapshot: { id: "tx-1" },
      },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(true);
  });

  it("trailEventSchema rejects an event with neither doc nor record (#757)", () => {
    const result = trailEventSchema.safeParse({
      eventId: "x",
      at: null,
      kind: "record",
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(false);
  });

  it("trailEventSchema rejects a related entry with an invalid direction", () => {
    const result = trailEventSchema.safeParse({
      eventId: "d",
      at: null,
      kind: "document",
      doc: { documentId: "d", title: "t", sourceId: "s" },
      attachments: [],
      people: [],
      related: [
        {
          documentId: "x",
          title: "y",
          sourceId: "z",
          linkType: "contains",
          direction: "sideways",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("trailEventSchema rejects an event without an eventId", () => {
    const result = trailEventSchema.safeParse({
      // eventId missing
      at: null,
      kind: "document",
      doc: { documentId: "d", title: "t", sourceId: "s" },
      attachments: [],
      people: [],
      related: [],
    });
    expect(result.success).toBe(false);
  });

  it("eventTrailSchema accepts a complete trail with seeds + stats", () => {
    const result = eventTrailSchema.safeParse({
      seeds: ["doc-1"],
      events: [
        {
          eventId: "doc-1",
          at: null,
          kind: "seed",
          doc: { documentId: "doc-1", title: "x", sourceId: "src:x" },
          attachments: [],
          people: [],
          related: [],
        },
      ],
      truncated: false,
      stats: { visited: 1, elapsedMs: 12, maxDepthReached: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("eventTrailSchema rejects negative stats", () => {
    const result = eventTrailSchema.safeParse({
      seeds: ["d"],
      events: [],
      truncated: false,
      stats: { visited: -1, elapsedMs: 0, maxDepthReached: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// Type-only smoke — fails to compile if the AgentEvent discriminated union
// loses cases vs the schemas.
function _exhaustivenessCheck(e: AgentEvent): string {
  switch (e.type) {
    case "agent.message.start":
      return e.payload.role;
    case "agent.text.delta":
      return e.payload.delta;
    case "agent.thinking.delta":
      return e.payload.delta;
    case "agent.tool.start":
      return e.payload.tool;
    case "agent.tool.result":
      return e.payload.result.kind;
    case "agent.citation":
      return e.payload.documentId;
    case "agent.citations.update":
      return String(e.payload.added.length);
    case "agent.message.end":
      return e.payload.stopReason;
    case "agent.error":
      return e.payload.code;
  }
}
// Reference the function so unused-export lint stays quiet.
void _exhaustivenessCheck;

// Reference unused imports so eslint/tsc doesn't grumble.
void agentSessionCreateRequest;
void agentSessionCancelRequest;
void agentMessageSendRequest;
void agentMessageSendResponse;
void agentMessageStartEvent;
void agentTextDeltaEvent;
void agentThinkingDeltaEvent;
void agentToolStartEvent;
void agentToolResultEvent;
void agentCitationEvent;
void agentCitationsUpdateEvent;
void agentMessageEndEvent;
void agentErrorEvent;
void toolResultSchema;

describe("isSelfQuoteAuthor", () => {
  it('resolves the agent "You" convention, case- and whitespace-insensitively', () => {
    for (const a of ["You", "you", " YOU ", "me", "Myself", "I", "self"]) {
      expect(isSelfQuoteAuthor(a)).toBe(true);
    }
  });

  it("is false for a real person name or an empty / absent author", () => {
    for (const a of ["Alice", "Maya Reeves", "you all", "", "   "]) {
      expect(isSelfQuoteAuthor(a)).toBe(false);
    }
    expect(isSelfQuoteAuthor(undefined)).toBe(false);
    expect(isSelfQuoteAuthor(null)).toBe(false);
  });

  it("accepts quoteIsSelf on the citation event and annotate result schemas", () => {
    const parsed = agentCitationEvent.parse({
      sessionId: "s",
      messageId: "m",
      toolCallId: "t",
      documentId: "d",
      ref: { documentId: "d", sourceType: "gmail", sourceId: "gmail:self" },
      quote: "I'll follow up",
      quoteAuthor: "You",
      quoteIsSelf: true,
    });
    expect(parsed.quoteIsSelf).toBe(true);
  });
});

describe("provider failure detail", () => {
  it("renders the canonical operator line every client mirrors", () => {
    // The portal, iOS and Android each format the wire's structured `provider`
    // for their own surface. This is the reference those three follow, so the
    // same failure reads identically wherever an operator meets it: status,
    // then the provider's code (or its type when it reported no code), then the
    // blamed field, then the correlation id.
    expect(
      formatProviderFailureDetail({
        status: 404,
        type: "invalid_request_error",
        code: "NOT_FOUND",
        param: "model",
        requestId: "chatcmpl-0001",
      }),
    ).toBe("HTTP 404 · NOT_FOUND · param=model · request chatcmpl-0001");
    expect(formatProviderFailureDetail({ status: 429 })).toBe("HTTP 429");
    expect(formatProviderFailureDetail({ status: 400, type: "invalid_request_error" })).toBe(
      "HTTP 400 · invalid_request_error",
    );
    expect(formatProviderFailureDetail(undefined)).toBeUndefined();
    expect(formatProviderFailureDetail({})).toBeUndefined();
  });

  it("keeps identifiers and refuses prose", () => {
    expect(sanitizeProviderFailureField("invalid_request_error")).toBe("invalid_request_error");
    expect(sanitizeProviderFailureField("accounts/vendor/models/some-model")).toBe(
      "accounts/vendor/models/some-model",
    );
    // Punctuation outside the identifier set is substituted; whitespace and
    // excess length mean the value is prose, and prose from a model server can
    // be the submitted prompt coming back.
    expect(sanitizeProviderFailureField("bad,code")).toBe("bad_code");
    expect(sanitizeProviderFailureField("a sentence about the request")).toBeUndefined();
    expect(sanitizeProviderFailureField("x".repeat(65))).toBeUndefined();
    expect(sanitizeProviderFailureField("  ")).toBeUndefined();
    expect(sanitizeProviderFailureField(undefined)).toBeUndefined();
  });

  it("accepts a terminal failure with or without provider metadata", () => {
    const base = {
      code: "http_api_error",
      message: "The model provider has no such endpoint or model (HTTP 404).",
      retryable: true,
      backend: "http",
      model: "some-model",
    };
    expect(agentTerminalFailureSchema.parse(base).provider).toBeUndefined();
    expect(
      agentTerminalFailureSchema.parse({ ...base, provider: { status: 404 } }).provider,
    ).toEqual({ status: 404 });
  });
});
