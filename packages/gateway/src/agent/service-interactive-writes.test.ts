// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Interactive-agent substrate write access: a TOP-LEVEL chat session, under
 * experimental mode with an InteractiveWriteProfile installed, is handed the
 * Brain's own mutating tools stamped with an interactive-origin run id —
 * so facts the user provides mid-conversation are written into the substrate.
 * With the profile absent — or experimental off — the session stays read-only.
 *
 * The paired sub-agent-read-only invariant (the write handles never reach a
 * delegated child) is covered where it lives: the own-tools are appended only to
 * the per-session `tools` array (never `this.tools`, which subagents build from),
 * and `selectSubagentTools` strips every `mutates:true` handle — asserted in
 * `registry.test.ts` and `brain/runtime/runtime.test.ts`.
 *
 * Fixture data is invented — no corpus content.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type ToolHandle,
  type ToolPorts,
  type WatchPort,
  type TurnInput,
} from "@omnesis/agent";
import Database from "better-sqlite3";
import { createLogger, type AgentEvent, type CapabilityRole, type WsEvent } from "@omnesis/core";
import { resolveBrainSettings } from "../brain/config.js";
import { KnowledgeService } from "../brain/knowledge/service.js";
import { createKnowledgeTables } from "../brain/knowledge/storage.js";
import { buildKnowledgeTools } from "../brain/knowledge/tools.js";
import { directKnowledgeGate } from "../brain/knowledge/writer.js";
import { AgentService, type AgentServiceDeps, type InteractiveWriteProfile } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { LabEnabled } from "./lab-tools.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/** Captures the tool names the top-level session was handed. */
class RecordingBackend implements ChatBackend {
  readonly name = "rec";
  readonly model = "rec";
  sawTools: string[] = [];
  sawSystemPrompt = "";
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawTools = input.tools.map((t) => t.name);
    this.sawSystemPrompt = input.systemPrompt;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "ok" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** A stub write tool that records the run id it was built with. */
function makeProfile(): { profile: InteractiveWriteProfile; seenRunIds: string[] } {
  const seenRunIds: string[] = [];
  const profile: InteractiveWriteProfile = {
    buildOwnTools(runId: string): ToolHandle[] {
      seenRunIds.push(runId);
      const stub: ToolHandle = {
        name: "cognitive_write_stub",
        description: "stub",
        mutates: true,
        schema: undefined as never,
        invoke: async () => ({ kind: "structured", resultType: "noop", data: {} }),
      };
      return [stub];
    },
  };
  return { profile, seenRunIds };
}

function makeService(
  ports: Partial<ToolPorts> = {},
  knowledgeReads = true,
  labEnabled?: LabEnabled,
  overrides: Partial<Pick<AgentServiceDeps, "systemPrompt" | "sessionIdGen">> = {},
) {
  const captured: WsEvent[] = [];
  const backend = new RecordingBackend();
  const service = new AgentService({
    ...(labEnabled ? { labEnabled } : {}),
    useBrainKnowledgeMode: knowledgeReads ? "check_stale_claims" : "off",
    backendFactory: (_role: CapabilityRole) => backend,
    ports: { search: stubSearch, document: stubDocument, ...ports },
    systemPrompt: "test",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => "S_top",
    idleTimeoutMs: 60_000,
    ...overrides,
  });
  return { service, backend };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe("interactive-agent substrate write access", () => {
  let prevExperimental: string | undefined;
  beforeEach(() => {
    prevExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
  });
  afterEach(() => {
    if (prevExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = prevExperimental;
  });

  it("withholds profile wiki reads when maintained knowledge reads are disabled", async () => {
    const { service, backend } = makeService({}, false);
    service.setInteractiveWriteProfile({
      buildOwnTools: () =>
        ["knowledge_list", "knowledge_fetch", "open_loop_search", "open_loop_fetch"].map(
          (name) => ({
            name,
            description: name,
            mutates: false,
            schema: undefined as never,
            invoke: async () => ({ kind: "structured" as const, resultType: "noop", data: {} }),
          }),
        ),
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "what does the project page say?");
    await settle();
    expect(backend.sawTools).toContain("fetch_many");
    expect(backend.sawTools).toContain("search_many");
    expect(backend.sawTools).not.toContain("knowledge_list");
    expect(backend.sawTools).not.toContain("knowledge_fetch");
    expect(backend.sawTools).not.toContain("open_loop_search");
    expect(backend.sawTools).not.toContain("open_loop_fetch");
    expect(service.listTools().map((tool) => tool.name)).not.toContain("fetch_loop");
  });

  it("refreshes an existing chat after a Lab toggle without enabling the Brain", async () => {
    const flags = { brain: false, tasks: false, watches: false };
    const { service, backend } = makeService({}, true, (id) => flags[id]);
    const taskTool: ToolHandle = {
      name: "task_list",
      description: "tasks",
      schema: {} as never,
      invoke: async () => ({ kind: "structured", resultType: "tasks", data: { tasks: [] } }),
    };
    service.setTaskToolsProvider(() => [taskTool]);
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "What can you do?");
    await settle();
    expect(backend.sawTools).not.toContain("task_list");
    flags.tasks = true;
    await service.refreshLabFeatures();
    service.sendMessage("device:A", sessionId, "What are my tasks?");
    await settle();
    expect(backend.sawTools).toContain("task_list");
    expect(backend.sawTools).not.toContain("list_loops");
    flags.tasks = false;
    await service.refreshLabFeatures();
    service.sendMessage("device:A", sessionId, "What can you do now?");
    await settle();
    expect(backend.sawTools).not.toContain("task_list");
    await service.dispose();
  });

  function refreshFixture() {
    const flags = { tasks: false };
    let nextId = 0;
    let pauseNext = false;
    let release = () => {};
    const fixture = makeService({}, true, (id) => id === "tasks" && flags.tasks, {
      sessionIdGen: () => `S_refresh_${++nextId}`,
      systemPrompt: async (profile) => {
        const prompt = `${profile} tasks=${flags.tasks}`;
        if (pauseNext) {
          pauseNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return prompt;
      },
    });
    fixture.service.setTaskToolsProvider(() => [
      {
        name: "task_list",
        description: "tasks",
        schema: {} as never,
        invoke: async () => ({ kind: "structured", resultType: "tasks", data: { tasks: [] } }),
      },
    ]);
    return {
      ...fixture,
      flags,
      pause: () => {
        pauseNext = true;
      },
      release: () => release(),
    };
  }

  it("refreshes later conversations when the first is evicted during prompt loading", async () => {
    const fixture = refreshFixture();
    try {
      await fixture.service.createSession("device:A");
      const second = await fixture.service.createSession("device:B");
      fixture.flags.tasks = true;
      fixture.pause();
      const refresh = fixture.service.refreshLabFeatures();
      await settle();
      fixture.service.evictForCaller("device:A");
      fixture.release();
      await refresh;
      fixture.service.sendMessage("device:B", second.sessionId, "Show my tasks.");
      await settle();
      expect(fixture.backend.sawTools).toContain("task_list");
      expect(fixture.backend.sawSystemPrompt).toContain("tasks=true");
    } finally {
      fixture.release();
      await fixture.service.dispose();
    }
  });

  it("keeps a profile selected while a Lab refresh is awaiting its prompt", async () => {
    const fixture = refreshFixture();
    try {
      const session = await fixture.service.createSession("device:A");
      fixture.flags.tasks = true;
      fixture.pause();
      const refresh = fixture.service.refreshLabFeatures();
      await settle();
      await fixture.service.createSession("device:A", {
        resumeFromId: session.sessionId,
        profile: "voice",
      });
      fixture.release();
      await refresh;
      fixture.service.sendMessage("device:A", session.sessionId, "Show my tasks.");
      await settle();
      expect(fixture.backend.sawSystemPrompt).toContain("voice tasks=true");
      expect(fixture.backend.sawTools).toContain("task_list");
    } finally {
      fixture.release();
      await fixture.service.dispose();
    }
  });

  it("rebuilds an earlier profile request when a Lab toggle completes during its prompt load", async () => {
    const fixture = refreshFixture();
    try {
      const session = await fixture.service.createSession("device:A");
      fixture.pause();
      const resume = fixture.service.createSession("device:A", {
        resumeFromId: session.sessionId,
        profile: "voice",
      });
      await settle();
      fixture.flags.tasks = true;
      await fixture.service.refreshLabFeatures();
      fixture.release();
      await resume;
      fixture.service.sendMessage("device:A", session.sessionId, "Show my tasks.");
      await settle();
      expect(fixture.backend.sawSystemPrompt).toContain("voice tasks=true");
      expect(fixture.backend.sawTools).toContain("task_list");
    } finally {
      fixture.release();
      await fixture.service.dispose();
    }
  });

  it("appends the profile's write tools to a top-level session, stamped interactive_<sessionId>", async () => {
    const { service, backend } = makeService();
    const { profile, seenRunIds } = makeProfile();
    service.setInteractiveWriteProfile(profile);

    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "she confirmed for Tuesday");
    await settle();

    expect(backend.sawTools).toContain("cognitive_write_stub");
    // Provenance: the run id marks the interactive origin (analogue of talkback_).
    expect(seenRunIds).toContain(`interactive_${sessionId}`);
  });

  it("offers maintained-page reads but never the wiki write tools", async () => {
    const { service, backend } = makeService();
    const knowledgeTool = (name: string, mutates: boolean): ToolHandle => ({
      name,
      description: name,
      mutates,
      schema: undefined as never,
      invoke: async () => ({ kind: "structured", resultType: "noop", data: {} }),
    });
    service.setInteractiveWriteProfile({
      buildOwnTools: () => [
        knowledgeTool("knowledge_list", false),
        knowledgeTool("knowledge_save", true),
        knowledgeTool("knowledge_link", true),
      ],
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "what does the project page say?");
    await settle();
    expect(backend.sawTools).toContain("knowledge_list");
    expect(backend.sawTools).not.toContain("knowledge_save");
    expect(backend.sawTools).not.toContain("knowledge_link");
  });

  it("never offers the Brain's real wiki write tools, knowledge_edit included", async () => {
    const db = new Database(":memory:");
    try {
      createKnowledgeTables(db);
      const knowledge = new KnowledgeService({
        db,
        tasksEnabled: () => true,
        writeGate: directKnowledgeGate(db),
        getSettings: () => resolveBrainSettings(),
        clock: () => 1,
        log: createLogger("interactive-writes-test"),
      });
      const brainTools = buildKnowledgeTools(knowledge, { runId: "interactive" });
      expect(brainTools.map((tool) => tool.name)).toContain("knowledge_edit");
      const { service, backend } = makeService();
      service.setInteractiveWriteProfile({ buildOwnTools: () => brainTools });
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "fix the fee on the garden page");
      await settle();
      expect(backend.sawTools).toContain("knowledge_fetch");
      for (const tool of brainTools.filter((entry) => entry.mutates))
        expect(backend.sawTools).not.toContain(tool.name);
    } finally {
      db.close();
    }
  });

  it("stays read-only when no profile is installed", async () => {
    const { service, backend } = makeService();
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "hello");
    await settle();
    expect(backend.sawTools).not.toContain("cognitive_write_stub");
  });

  it("stays read-only when experimental is off, even with a profile", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "0";
    const { service, backend } = makeService();
    service.setInteractiveWriteProfile(makeProfile().profile);
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "hello");
    await settle();
    expect(backend.sawTools).not.toContain("cognitive_write_stub");
  });
});

describe("stable interactive memory", () => {
  it("grants memory while keeping the broader cognition profile gated", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "0";
    const { service, backend } = makeService();
    try {
      service.setInteractiveMemoryProfile(makeProfile().profile);
      service.setInteractiveWriteProfile({
        buildOwnTools: () => [
          {
            name: "open_loop_create",
            description: "stub",
            mutates: true,
            schema: undefined as never,
            invoke: async () => ({ kind: "structured", resultType: "noop", data: {} }),
          },
        ],
      });
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "Remember that I prefer morning meetings.");
      await settle();
      expect(backend.sawTools).toContain("cognitive_write_stub");
      expect(backend.sawTools).not.toContain("open_loop_create");
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });
  it("does not duplicate annotation tools when both profiles are installed", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const { service, backend } = makeService();
      service.setInteractiveMemoryProfile(makeProfile().profile);
      service.setInteractiveWriteProfile(makeProfile().profile);
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "hello");
      await settle();
      expect(backend.sawTools.filter((name) => name === "cognitive_write_stub")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });
});

describe("shared owner-directed tools", () => {
  let previousExperimental: string | undefined;
  let previousSynthetic: string | undefined;
  beforeEach(() => {
    previousExperimental = process.env.OMNESIS_EXPERIMENTAL;
    previousSynthetic = process.env.OMNESIS_SYNTHETIC;
    process.env.OMNESIS_SYNTHETIC = "0";
  });
  afterEach(() => {
    if (previousExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = previousExperimental;
    if (previousSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
    else process.env.OMNESIS_SYNTHETIC = previousSynthetic;
  });

  function profileTool(name: string, runId: string, profile: string, mutates = true): ToolHandle {
    return {
      name,
      description: name,
      mutates,
      schema: undefined as never,
      invoke: async () => ({
        kind: "structured",
        resultType: "profile.write",
        data: { runId, profile },
      }),
    };
  }

  it.each([false, true])(
    "honors the explicit knowledge-read boundary for chat and Note tools (experimental=%s)",
    async (experimental) => {
      process.env.OMNESIS_EXPERIMENTAL = experimental ? "1" : "0";
      const { service, backend } = makeService({}, false);
      service.setInteractiveMemoryProfile({
        buildOwnTools: (runId) => [profileTool("annotate_durable", runId, "memory")],
      });
      service.setInteractiveWriteProfile({
        buildOwnTools: (runId) => [profileTool("knowledge_list", runId, "cognition", false)],
      });
      const taskTools = ["task_list", "task_create", "task_update", "task_undo"].map((name) =>
        profileTool(name, "note:boundary", "tasks", name !== "task_list"),
      );
      service.setTaskToolsProvider(() => taskTools);
      const temporal = profileTool("temporal_query", "note:boundary", "read", false);
      try {
        const ownerTools = service.buildOwnerTools("note:boundary", taskTools, [temporal]);
        // A filtered task_list must never be captured by the temporal overlay.
        expect(ownerTools.find((tool) => tool.name === "temporal_query")).toBe(temporal);
        const { sessionId } = await service.createSession("device:A");
        service.sendMessage("device:A", sessionId, "Remember the display label.");
        await settle();
        for (const names of [ownerTools.map((tool) => tool.name), backend.sawTools]) {
          expect(names).toContain("annotate_durable");
          expect(names.some((name) => /^(task_|knowledge_|open_loop_)/.test(name))).toBe(false);
        }
      } finally {
        await service.dispose();
      }
    },
  );

  it.each([false, true])(
    "offers the same owner capabilities to chat and standalone notes (experimental=%s)",
    async (experimental) => {
      process.env.OMNESIS_EXPERIMENTAL = experimental ? "1" : "0";
      const { service, backend } = makeService();
      service.setInteractiveMemoryProfile({
        buildOwnTools: (runId) => [profileTool("annotate_durable", runId, "memory")],
      });
      service.setInteractiveWriteProfile({
        buildOwnTools: (runId) => [
          profileTool("annotate_durable", runId, "cognition"),
          profileTool("observation_note", runId, "cognition"),
          profileTool("knowledge_list", runId, "cognition", false),
          profileTool("knowledge_save", runId, "cognition"),
          profileTool("knowledge_edit", runId, "cognition"),
          profileTool("open_loop_create", runId, "cognition"),
          profileTool("open_loop_update", runId, "cognition"),
          profileTool("open_loop_delete", runId, "cognition"),
          profileTool("open_loop_ledger_append", runId, "cognition"),
        ],
      });
      const taskTools = [profileTool("task_update", "note:seed", "tasks")];
      service.setTaskToolsProvider(() => taskTools);
      try {
        const noteTools = service.buildOwnerTools("note:seed", taskTools);
        const names = noteTools.map((tool) => tool.name);
        const { sessionId } = await service.createSession("device:A");
        service.sendMessage("device:A", sessionId, "Remember the greenhouse project.");
        await settle();

        expect(backend.sawTools).toContain("ask_clarification");
        expect([...names].sort()).toEqual(
          backend.sawTools.filter((name) => name !== "ask_clarification").sort(),
        );
        expect(names).toContain("task_update");
        expect(names.filter((name) => name === "annotate_durable")).toHaveLength(1);
        expect(names.includes("observation_note")).toBe(experimental);
        expect(names.includes("knowledge_list")).toBe(experimental);
        for (const excluded of [
          "knowledge_save",
          "knowledge_edit",
          "open_loop_create",
          "open_loop_update",
          "open_loop_delete",
          "open_loop_ledger_append",
        ])
          expect(names).not.toContain(excluded);

        const result = await noteTools
          .find((tool) => tool.name === "annotate_durable")!
          .invoke(
            {},
            {
              sessionId: "note-agent-seed",
              messageId: "message_seed",
              caller: { kind: "operator" },
            },
          );
        expect(result).toEqual({
          kind: "structured",
          resultType: "profile.write",
          data: { runId: "note:seed", profile: experimental ? "cognition" : "memory" },
        });
        expect(service.listTools().map((tool) => tool.name)).not.toContain("annotate_durable");
        expect(service.listTools().map((tool) => tool.name)).not.toContain("task_update");
      } finally {
        await service.dispose();
      }
    },
  );

  it("keeps watch mutations gated and passes the standalone owner's identity to the watch port", async () => {
    const created = {
      action: "created" as const,
      watchId: "watch_greenhouse",
      name: "Greenhouse supplies",
      enabled: true,
      interpretation: "Notify when greenhouse supplies are ready.",
      warnings: [],
    };
    const create = vi.fn<WatchPort["create"]>(async () => created);
    const watch: WatchPort = {
      create,
      update: async () => ({ ...created, action: "updated" }),
      remove: async () => {},
      list: async () => [],
      get: async () => null,
      probe: async () => ({
        events: 0,
        from: null,
        to: null,
        nodes: [],
        firings: 0,
        judgeGated: false,
      }),
    };
    process.env.OMNESIS_EXPERIMENTAL = "0";
    const stable = makeService({ watch }).service;
    try {
      expect(stable.buildOwnerTools("note:stable", []).map((tool) => tool.name)).not.toContain(
        "watch_create",
      );
    } finally {
      await stable.dispose();
    }

    process.env.OMNESIS_EXPERIMENTAL = "1";
    const experimental = makeService({ watch }).service;
    try {
      const tools = experimental.buildOwnerTools("note:watch", []);
      const result = await tools
        .find((tool) => tool.name === "watch_create")!
        .invoke(
          { request: "Notify when greenhouse supplies are ready." },
          {
            sessionId: "note-agent-watch",
            messageId: "message_watch",
            caller: { kind: "operator" },
          },
        );
      expect(create).toHaveBeenCalledWith(
        { kind: "operator" },
        { request: "Notify when greenhouse supplies are ready." },
      );
      expect(result).toMatchObject({
        kind: "watch.upserted",
        watchId: "watch_greenhouse",
        action: "created",
      });
    } finally {
      await experimental.dispose();
    }
  });
});

describe("task creation conversation reference", () => {
  it("supplies a refusing reference resolver when conversation persistence is unavailable", async () => {
    const { service } = makeService();
    let resolve: (() => Promise<string | null>) | undefined;
    service.setTaskToolsProvider((_id, context) => {
      resolve = context.creationReference;
      return [];
    });
    try {
      await service.createSession("device:owner");
      expect(resolve).toBeTypeOf("function");
      expect(await resolve!()).toBeNull();
    } finally {
      await service.dispose();
    }
  });

  it("publishes the live owner message before resolving its reference with interactive memory disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-task-reference-"));
    const store = new FsConversationStore(dir);
    let reference: string | null | undefined;
    const ensure = vi.fn(async (id: string) => {
      const record = await store.load(id);
      expect(JSON.stringify(record?.messages)).toContain("Remind me to polish the telescope");
      return {
        documentId: "doc_current_chat",
        userMessages: ["Remind me to polish the telescope"],
        truncated: false,
      };
    });
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted",
      async *runTurn(input) {
        const ids = { sessionId: input.sessionId, messageId: input.messageId };
        yield { type: "agent.message.start", payload: { ...ids, role: "assistant" } };
        await input.tools.find((tool) => tool.name === "task_create")!.invoke({}, ids as never);
        yield { type: "agent.message.end", payload: { ...ids, stopReason: "end_turn" } };
      },
    };
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      ensureConversationEvidence: ensure,
    });
    service.setTaskToolsProvider((_id, context) => [
      {
        name: "task_create",
        description: "test",
        mutates: true,
        schema: undefined as never,
        invoke: async () => {
          reference = await context.creationReference?.();
          return { kind: "structured", resultType: "noop", data: {} };
        },
      },
    ]);
    try {
      const { sessionId } = await service.createSession("device:owner");
      service.sendMessage("device:owner", sessionId, "Remind me to polish the telescope");
      await vi.waitFor(() => expect(reference).toBe("doc_current_chat"));
      expect(ensure).toHaveBeenCalledWith(sessionId);
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
