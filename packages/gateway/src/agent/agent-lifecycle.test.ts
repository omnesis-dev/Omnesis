// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, type AnthropicCatalogEntry, type Manifest } from "@omnesis/core";
import { AnthropicBackend, HttpAgentBackend, type ChatBackend } from "@omnesis/agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProviderId, SourceId } from "@omnesis/types";
import { InferenceRegistry } from "../inference/registry.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { MainTaskRunner } from "../scheduler/runners/main.js";
import { createBackendReprobeTask } from "../scheduler/tasks/backend-reprobe.js";
import { createDatabase, upsertDocuments } from "../db.js";
import { createIndexDatabase } from "../indexer/db.js";
import { directWriteGate } from "../write-gate.js";
import {
  AgentLifecycle,
  PRIVACY_STATE_SWEEP_INTERVAL_MS,
  decorateSpecialist,
  resolveRoleBackend,
  type AgentLifecycleDeps,
} from "./agent-lifecycle.js";
import { readConversationCleanupCandidates } from "./conversation-retention.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ResolvedSpecialist } from "./subagent-service.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ClaudeCodeService } from "../models/claude-code-service.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";

// A config assigning a cloud agent (Anthropic) with remote inference OFF —
// the corpus must not be shipped off-host, so the agent must be refused.
function cloudAgentRemoteOffConfig(model = "anthropic/claude-sonnet-4-6"): OmnesisConfig {
  return { inference: { assignments: { agent: model } } } as OmnesisConfig;
}

// A config with no agent assignment → `resolve("agent").kind === "disabled"`.
function disabledConfig(): OmnesisConfig {
  return { inference: { assignments: {} } } as OmnesisConfig;
}

// A config whose agent points at a backend that doesn't exist →
// `resolve("agent").kind === "unresolved"` (a typo / dangling reference).
function unresolvedConfig(): OmnesisConfig {
  return {
    inference: { assignments: { agent: "missing-backend/example-model" } },
  } as OmnesisConfig;
}

function httpAgentConfig(backendKey = "agent-http"): OmnesisConfig {
  return {
    inference: {
      backends: {
        [backendKey]: { type: "http", url: "http://127.0.0.1:55571" },
      },
      assignments: { agent: `${backendKey}/example-model` },
    },
  } as OmnesisConfig;
}

describe("AgentLifecycle", () => {
  let modelsDir: string;
  let configDir: string;

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), "omnesis-agentlc-models-"));
    configDir = mkdtempSync(join(tmpdir(), "omnesis-agentlc-config-"));
  });

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function makeLifecycle(
    config: OmnesisConfig = disabledConfig(),
    overrides: Partial<AgentLifecycleDeps> = {},
  ) {
    const manifest: Manifest = { version: 1, models: [] };
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => false,
    });
    // The registry is loaded before the lifecycle boots, mirroring the gateway.
    registry.loadConfig(config);

    const configStore = {
      get: () => config,
    } as unknown as AgentLifecycleDeps["configStore"];
    const attach = vi.fn();
    const wsEventHandler = {
      attachAgentService: attach,
    } as unknown as AgentLifecycleDeps["wsEventHandler"];

    // Spy on the structured logger so a test can assert the LEVEL a code path
    // logs at (an unresolved assignment must escalate to error).
    const log = createLogger("test:agent-lifecycle");
    const errorSpy = vi.spyOn(log, "error");
    const warnSpy = vi.spyOn(log, "warn");

    // The disabled / unresolved paths never build an AgentService, so the
    // port/runtime collaborators are never dereferenced — empty stubs are safe.
    const recoverInterruptedAnswerTasks = vi.fn(async () => 0);
    const expirePrivacyApprovals = vi.fn(async () => 0);
    const deps: AgentLifecycleDeps = {
      inferenceRegistry: registry,
      config,
      configStore,
      configDir,
      log,
      wsEventHandler,
      indexDb: {} as AgentLifecycleDeps["indexDb"],
      db: {
        prepare: () => ({ get: () => undefined }),
      } as unknown as AgentLifecycleDeps["db"],
      searchPipeline: {} as AgentLifecycleDeps["searchPipeline"],
      syncStatus: {} as AgentLifecycleDeps["syncStatus"],
      analyticsDb: {} as AgentLifecycleDeps["analyticsDb"],
      writeGate: {
        recoverInterruptedAnswerTasks,
        expirePrivacyApprovals,
        setSourceMeta: vi.fn(async () => {}),
      } as unknown as AgentLifecycleDeps["writeGate"],
      wsServer: {} as AgentLifecycleDeps["wsServer"],
      conversationStore: {} as AgentLifecycleDeps["conversationStore"],
      getWatchCompiler: () => ({}) as ReturnType<AgentLifecycleDeps["getWatchCompiler"]>,
      ...overrides,
    };
    return {
      lifecycle: new AgentLifecycle(deps),
      registry,
      attach,
      errorSpy,
      warnSpy,
      recoverInterruptedAnswerTasks,
      expirePrivacyApprovals,
    };
  }

  test("manual cleanup resumes a bounded corpus/index cascade with the agent disabled", async () => {
    const db = createDatabase(":memory:");
    const indexDb = createIndexDatabase(":memory:");
    const writeGate = directWriteGate(db);
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    const record = {
      id: "invented-pending",
      callerId: "device:example",
      model: "scripted",
      backend: "scripted",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      title: "Invented history",
      pinned: false,
      messages: [],
    };
    await conversationStore.save(record);
    upsertDocuments(db, [
      {
        providerId: ProviderId("system"),
        sourceId: SourceId("omnesis-chat"),
        externalId: record.id,
        title: record.title,
        content: "Invented conversation evidence",
        contentHash: "invented",
        metadata: {},
        sourceCreatedAt: record.createdAt,
        sourceUpdatedAt: record.updatedAt,
      },
    ]);
    const docId = (
      db.prepare("SELECT id FROM documents WHERE external_id=?").get(record.id) as { id: string }
    ).id;
    const insert = indexDb.prepare(
      "INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,source_created_at) VALUES(?,?,?,'Invented history','omnesis-chat','Invented history','2030-01-01T00:00:00Z')",
    );
    for (let i = 0; i < 130; i++) insert.run("invented-chunk-" + i, docId, i);
    const inspected = (
      await readConversationCleanupCandidates(
        [{ id: record.id, path: join(configDir, "conversations", record.id + ".json") }],
        Date.parse("2032-01-01T00:00:00Z"),
      )
    )[0]!;
    const candidate = {
      id: record.id,
      identity: inspected.candidate!.fileIdentity,
      bytesEstimate: inspected.bytesEstimate,
      detail: record.updatedAt,
    };
    const overrides = { db, indexDb, writeGate, conversationStore };
    const first = makeLifecycle(disabledConfig(), overrides).lifecycle;
    let recovered: AgentLifecycle | undefined;
    try {
      await first.bootAgent();
      expect(first.routeDeps.agentService).toBeUndefined();
      expect(
        await first.cleanupConversation(candidate, Date.parse("2032-01-01T00:00:00Z")),
      ).toEqual({ state: "pending" });
      expect(await conversationStore.load(record.id)).not.toBeNull();
      expect(
        (indexDb.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
      ).toBeLessThan(130);
      const remaining = indexDb.prepare("SELECT COUNT(*) AS n FROM chunks").get();
      expect(await first.pruneConversations(Date.parse("2032-01-01T00:00:00Z"), 10)).toMatchObject({
        deleted: 0,
      });
      expect(indexDb.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual(remaining);
      expect(await conversationStore.load(record.id)).not.toBeNull();
      await first.shutdown();
      recovered = makeLifecycle(disabledConfig(), overrides).lifecycle;
      expect(recovered.reserveHistoryCleanup(record.id)).toBe(true);
      await recovered.bootAgent();
      let result;
      for (let n = 0; n < 10; n++) {
        result = await recovered.cleanupConversation(candidate, Date.parse("2032-01-01T00:00:00Z"));
        if (result.state !== "pending") break;
      }
      expect(result?.state).toBe("removed");
      expect(db.prepare("SELECT id FROM documents WHERE id=?").get(docId)).toBeUndefined();
      expect(indexDb.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
      expect(await conversationStore.load(record.id)).toBeNull();
      recovered.releaseHistoryCleanup(record.id);
    } finally {
      await first.shutdown();
      await recovered?.shutdown();
      await conversationStore.close();
      indexDb.close();
      db.close();
    }
  });

  test("recovered history ownership precedes boot admission and survives a model rebuild", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify({ data: [{ id: "example-model" }] }), { status: 200 });
    };
    const db = createDatabase(":memory:");
    const indexDb = createIndexDatabase(":memory:");
    const writeGate = directWriteGate(db);
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    await conversationStore.save({
      id: "invented-owner",
      callerId: "device:example",
      model: "scripted",
      backend: "scripted",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      title: "Invented pending history",
      pinned: false,
      messages: [],
    });
    const { lifecycle, registry } = makeLifecycle(httpAgentConfig(), {
      db,
      indexDb,
      writeGate,
      conversationStore,
    });
    try {
      expect(lifecycle.reserveHistoryCleanup("invented-owner")).toBe(true);
      await registry.probeBackends();
      await lifecycle.bootAgent();
      const first = lifecycle.routeDeps.agentService!;
      expect(first).toBeDefined();
      await expect(
        first.createSession("device:example", { resumeFromId: "invented-owner" }),
      ).rejects.toMatchObject({ code: "session_busy" });
      await expect(first.setConversationPinned("invented-owner", true)).rejects.toMatchObject({
        code: "session_busy",
      });
      await lifecycle.applyAgentSwap();
      const second = lifecycle.routeDeps.agentService!;
      expect(second).not.toBe(first);
      await expect(
        second.createSession("device:example", { resumeFromId: "invented-owner" }),
      ).rejects.toMatchObject({ code: "session_busy" });
      await expect(second.setConversationPinned("invented-owner", true)).rejects.toMatchObject({
        code: "session_busy",
      });
      lifecycle.releaseHistoryCleanup("invented-owner");
      expect(await second.setConversationPinned("invented-owner", true)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await lifecycle.shutdown();
      await conversationStore.close();
      indexDb.close();
      db.close();
    }
  });

  test("a captured note has its own complete tool runtime without an interactive assignment", async () => {
    const { lifecycle, attach } = makeLifecycle();
    const backend: ChatBackend = {
      name: "scripted",
      model: "note-model",
      async *runTurn() {},
    };
    const runtime = lifecycle.buildNoteTools(() => backend, "note:example", [], []);
    try {
      const names = runtime.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "search_many",
          "fetch_many",
          "spawn_subagent",
          "join_subagents",
          "plan",
        ]),
      );
      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
      expect(attach).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose("note-agent-example");
      await lifecycle.shutdown();
    }
  });

  test.each([false, true])(
    "a model swap retains an explicitly unjoined previous service (nested:%s)",
    async (nested) => {
      const { lifecycle, attach } = makeLifecycle();
      const cause = Object.assign(new Error("invented service cleanup uncertainty"), {
        cleanupFailure: undefined,
      });
      const marker = nested ? new Error("invented disposal wrapper", { cause }) : cause;
      const previous = {
        dispose: vi.fn(async () => {
          throw marker;
        }),
        cleanupFailure: () => marker,
      };
      lifecycle.routeDeps.agentService = previous as unknown as NonNullable<
        typeof lifecycle.routeDeps.agentService
      >;
      try {
        await expect(lifecycle.applyAgentSwap()).rejects.toBe(marker);
        expect(lifecycle.routeDeps.agentService).toBe(previous);
        expect(attach).not.toHaveBeenCalled();
      } finally {
        // The refusal is injected; this fixture owns no Native child or real turn.
        lifecycle.routeDeps.agentService = undefined;
        await lifecycle.shutdown();
      }
    },
  );

  test("an ordinary joined previous-service disposal failure still allows the requested model swap", async () => {
    const { lifecycle, attach } = makeLifecycle();
    const previous = {
      dispose: vi.fn(async () => {
        throw new Error("invented joined disposal failure");
      }),
    };
    lifecycle.routeDeps.agentService = previous as unknown as NonNullable<
      typeof lifecycle.routeDeps.agentService
    >;
    try {
      await lifecycle.applyAgentSwap();
      expect(previous.dispose).toHaveBeenCalledOnce();
      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(attach).toHaveBeenCalled();
    } finally {
      lifecycle.routeDeps.agentService = undefined;
      await lifecycle.shutdown();
    }
  });

  test("boot then swap (no assignment): distinct disabled reasons, no service, stable routeDeps", async () => {
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    const { lifecycle, attach } = makeLifecycle(disabledConfig(), { conversationStore });
    const routeDepsRef = lifecycle.routeDeps;
    const conversationReaderRef = lifecycle.routeDeps.conversationReader;

    await lifecycle.bootAgent();
    const bootReason = lifecycle.routeDeps.disabledReason;
    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
    expect(lifecycle.routeDeps.agentConfig.backend).toBe("disabled");
    await expect(conversationReaderRef?.listConversationPage()).resolves.toEqual({
      conversations: [],
      nextCursor: null,
    });
    // Boot uses the verbose reason (carries the `e.g. "anthropic/…"` hint).
    expect(bootReason).toContain("e.g.");
    expect(bootReason).toContain("Agent disabled");
    // Boot only attaches when a service exists — disabled boot attaches nothing.
    expect(attach).not.toHaveBeenCalled();

    await lifecycle.applyAgentSwap();
    const swapReason = lifecycle.routeDeps.disabledReason;
    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
    // The swap reason is the terse variant — DIFFERENT text for the same
    // condition. This is the load-bearing divergence: the two switches must
    // not be unified, or this portal-facing string would change.
    expect(swapReason).toContain("Agent disabled");
    expect(swapReason).not.toContain("e.g.");
    expect(swapReason).not.toBe(bootReason);
    // Swap always re-attaches (here, the now-undefined service).
    expect(attach).toHaveBeenCalledWith(undefined);

    // routeDeps is a stable object reference, mutated in place across the swap
    // (the agent route handler holds this exact object).
    expect(lifecycle.routeDeps).toBe(routeDepsRef);
    expect(lifecycle.routeDeps.conversationReader).toBe(conversationReaderRef);
  });

  test("recovered assigned HTTP backend reactivates the boot-disabled agent in place", async () => {
    const config = httpAgentConfig();
    const originalFetch = globalThis.fetch;
    let backendUp = false;
    globalThis.fetch = async () => {
      if (!backendUp) throw new Error("Connection refused");
      return new Response(JSON.stringify({ data: [{ id: "example-model" }] }), { status: 200 });
    };
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    const { lifecycle, registry, attach } = makeLifecycle(config, { conversationStore });
    const routeDepsRef = lifecycle.routeDeps;

    try {
      await registry.probeBackends();
      await lifecycle.bootAgent();
      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(lifecycle.routeDeps.answerService).toBeUndefined();
      expect(lifecycle.routeDeps.disabledCode).toBeUndefined();
      expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);

      backendUp = true;
      const scheduler = new Scheduler({ enablePreemption: false });
      scheduler.registerRunner(new MainTaskRunner({ concurrency: 1 }));
      const reprobeLog = createLogger("test:agent-lifecycle:reprobe");
      const reprobe = createBackendReprobeTask(
        {
          registry,
          log: reprobeLog,
          now: () => 1_000_000,
          reconcileAgent: async () => {
            await lifecycle.reactivateAgentIfAvailable();
          },
        },
        scheduler,
      );
      const outcome = await reprobe.tasks[0].run(undefined, {
        shouldYield: () => false,
        elapsedMs: () => 0,
        signal: new AbortController().signal,
        log: reprobeLog,
      });
      expect((outcome as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);

      expect(lifecycle.routeDeps).toBe(routeDepsRef);
      expect(lifecycle.routeDeps.agentService).toBeDefined();
      expect(lifecycle.routeDeps.answerService).toBeDefined();
      expect(lifecycle.routeDeps.agentConfig.enabled).toBe(true);
      expect(lifecycle.routeDeps.disabledReason).toBeUndefined();
      expect(attach).toHaveBeenCalledWith(lifecycle.routeDeps.agentService);
    } finally {
      globalThis.fetch = originalFetch;
      await lifecycle.shutdown();
    }
  });

  test("reconciliation does not rebuild an agent that is already active", async () => {
    const config = httpAgentConfig();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "example-model" }] }), { status: 200 });
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    const { lifecycle, registry, attach } = makeLifecycle(config, { conversationStore });

    try {
      await registry.probeBackends();
      await lifecycle.bootAgent();
      expect(lifecycle.routeDeps.agentService).toBeDefined();

      await expect(lifecycle.reactivateAgentIfAvailable()).resolves.toBe(false);
      expect(attach).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      await lifecycle.shutdown();
    }
  });

  test("reconciliation cannot reactivate an HTTP assignment removed after recovery", async () => {
    const config = httpAgentConfig();
    const originalFetch = globalThis.fetch;
    let backendUp = false;
    globalThis.fetch = async () => {
      if (!backendUp) throw new Error("Connection refused");
      return new Response(JSON.stringify({ data: [{ id: "example-model" }] }), { status: 200 });
    };
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    const { lifecycle, registry, attach } = makeLifecycle(config, { conversationStore });

    try {
      await registry.probeBackends();
      await lifecycle.bootAgent();
      backendUp = true;
      await registry.reprobeUnavailable(1_000_000);

      config.inference!.assignments = {};
      await expect(lifecycle.reactivateAgentIfAvailable()).resolves.toBe(false);

      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(lifecycle.routeDeps.answerService).toBeUndefined();
      expect(lifecycle.routeDeps.disabledCode).toBeUndefined();
      expect(attach).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await lifecycle.shutdown();
    }
  });

  test("shutdown prevents a queued recovery from installing a new agent service", async () => {
    const config = httpAgentConfig();
    const originalFetch = globalThis.fetch;
    let backendUp = false;
    globalThis.fetch = async () => {
      if (!backendUp) throw new Error("Connection refused");
      return new Response(JSON.stringify({ data: [{ id: "example-model" }] }), { status: 200 });
    };
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    let announceRetention!: () => void;
    const retentionStarted = new Promise<void>((resolve) => {
      announceRetention = resolve;
    });
    let releaseRetention!: () => void;
    const retentionMayFinish = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    vi.spyOn(conversationStore, "listRetentionCandidates").mockImplementation(async () => {
      announceRetention();
      await retentionMayFinish;
      return { items: [], hasMore: false };
    });
    const { lifecycle, registry, attach } = makeLifecycle(config, { conversationStore });

    try {
      await registry.probeBackends();
      await lifecycle.bootAgent();
      backendUp = true;
      await registry.reprobeUnavailable(1_000_000);

      const retention = lifecycle.pruneConversations(Date.now(), 1);
      await retentionStarted;
      const recovery = lifecycle.reactivateAgentIfAvailable();
      const shutdown = lifecycle.shutdown();
      releaseRetention();

      await expect(retention).resolves.toEqual({ deleted: 0, hasMore: false });
      await expect(recovery).resolves.toBe(false);
      await shutdown;
      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(lifecycle.routeDeps.answerService).toBeUndefined();
      expect(lifecycle.routeDeps.disabledCode).toBeUndefined();
      expect(attach).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retention reclaims old conversations while the agent assignment is disabled", async () => {
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    await conversationStore.save({
      id: "old_disabled",
      callerId: "device:example",
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      pinned: false,
      messages: [],
    });
    const deleteDocumentForRetention = vi.fn(async () => null);
    const completeDocumentRetention = vi.fn(async () => {});
    const { lifecycle } = makeLifecycle(disabledConfig(), {
      conversationStore,
      writeGate: {
        recoverInterruptedAnswerTasks: vi.fn(async () => 0),
        expirePrivacyApprovals: vi.fn(async () => 0),
        deleteDocumentForRetention,
        completeDocumentRetention,
      } as unknown as AgentLifecycleDeps["writeGate"],
    });
    await lifecycle.bootAgent();
    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    await expect(
      lifecycle.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 1),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    // This fixture has no mirrored corpus document, so no main-DB write is
    // needed before unlinking the transcript.
    expect(deleteDocumentForRetention).not.toHaveBeenCalled();
    expect(completeDocumentRetention).toHaveBeenCalledOnce();
    expect(await conversationStore.load("old_disabled")).toBeNull();
    await lifecycle.shutdown();
  });

  test("an agent config swap waits for a disabled-mode retention unlink", async () => {
    const conversationStore = new FsConversationStore(join(configDir, "conversations"));
    await conversationStore.save({
      id: "old_during_swap",
      callerId: "device:example",
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      pinned: false,
      messages: [],
    });
    let announceUnlink!: () => void;
    const unlinkStarted = new Promise<void>((resolve) => {
      announceUnlink = resolve;
    });
    let releaseUnlink!: () => void;
    const unlinkMayFinish = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const realDelete = conversationStore.deleteForRetention.bind(conversationStore);
    vi.spyOn(conversationStore, "deleteForRetention").mockImplementation(async (id) => {
      announceUnlink();
      await unlinkMayFinish;
      return realDelete(id);
    });
    const { lifecycle, attach } = makeLifecycle(disabledConfig(), {
      conversationStore,
      writeGate: {
        recoverInterruptedAnswerTasks: vi.fn(async () => 0),
        expirePrivacyApprovals: vi.fn(async () => 0),
        deleteDocuments: vi.fn(async () => []),
        completeDocumentRetention: vi.fn(async () => {}),
      } as unknown as AgentLifecycleDeps["writeGate"],
    });
    await lifecycle.bootAgent();

    const prune = lifecycle.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 1);
    await unlinkStarted;
    const swap = lifecycle.applyAgentSwap();
    await Promise.resolve();
    await Promise.resolve();
    // Installing/re-attaching the swapped service would permit a resume. It
    // must remain outside the lifecycle exclusion until the unlink settles.
    expect(attach).not.toHaveBeenCalled();

    releaseUnlink();
    await expect(prune).resolves.toEqual({ deleted: 1, hasMore: false });
    await swap;
    expect(attach).toHaveBeenCalledWith(undefined);
    expect(await conversationStore.load("old_during_swap")).toBeNull();
    await lifecycle.shutdown();
  });

  test("unresolved (typo'd) agent assignment escalates the disabling log to error", async () => {
    const { lifecycle, errorSpy } = makeLifecycle(unresolvedConfig());

    await lifecycle.bootAgent();

    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.backend).toBe("unresolved");
    expect(lifecycle.routeDeps.disabledReason).toContain("Agent unresolved");
    // Fail-loud: the disabling line is an error, naming why it's unresolved.
    expect(errorSpy).toHaveBeenCalled();
    const errorMsg = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorMsg).toMatch(/unresolved/i);
    expect(errorMsg).toMatch(/missing-backend/);
  });

  test("a cloud agent is refused at boot when remote inference is off (egress bypass closed)", async () => {
    // Provide a real API key so the ONLY thing preventing construction is the
    // egress gate — otherwise a missing key would disable the agent anyway and
    // the test wouldn't prove the gate does the work.
    const prevKey = process.env.OMNESIS_ANTHROPIC_API_KEY;
    process.env.OMNESIS_ANTHROPIC_API_KEY = "sk-ant-test-key";
    try {
      const { lifecycle, attach } = makeLifecycle(cloudAgentRemoteOffConfig());

      await lifecycle.bootAgent();

      expect(lifecycle.routeDeps.agentService).toBeUndefined();
      expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
      expect(lifecycle.routeDeps.disabledReason).toMatch(/allowRemoteInference/);
      expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
      expect(lifecycle.routeDeps.agentConfig.disabledCode).toBe("remote_inference_disabled");
      expect(attach).not.toHaveBeenCalled();
    } finally {
      if (prevKey === undefined) delete process.env.OMNESIS_ANTHROPIC_API_KEY;
      else process.env.OMNESIS_ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("a cloud agent (codex) is refused at boot when remote inference is off", async () => {
    const { lifecycle, attach } = makeLifecycle(cloudAgentRemoteOffConfig("codex/gpt-5.4"));

    await lifecycle.bootAgent();

    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.disabledReason).toMatch(/allowRemoteInference/);
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
    expect(lifecycle.routeDeps.agentConfig.disabledCode).toBe("remote_inference_disabled");
    expect(attach).not.toHaveBeenCalled();
  });

  test("a cloud agent (claude-code) is refused at boot when remote inference is off", async () => {
    const { lifecycle, attach } = makeLifecycle(cloudAgentRemoteOffConfig("claude-code/sonnet"));

    await lifecycle.bootAgent();

    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
    expect(attach).not.toHaveBeenCalled();
  });

  test("a live swap to a cloud agent is refused when remote inference is off", async () => {
    const { lifecycle } = makeLifecycle(cloudAgentRemoteOffConfig());

    await lifecycle.applyAgentSwap();

    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
    expect(lifecycle.routeDeps.disabledReason).toMatch(/allowRemoteInference/);
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
    expect(lifecycle.routeDeps.agentConfig.disabledCode).toBe("remote_inference_disabled");
  });

  test("a live swap clears cloud recovery when the next assignment is disabled", async () => {
    const config = cloudAgentRemoteOffConfig("codex/gpt-5.4");
    const { lifecycle, registry } = makeLifecycle(config);
    await lifecycle.bootAgent();
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");

    config.inference!.assignments!.agent = undefined;
    registry.loadConfig(config);
    await lifecycle.applyAgentSwap();

    expect(lifecycle.routeDeps.disabledCode).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.disabledCode).toBeUndefined();
    expect(lifecycle.routeDeps.agentConfig.enabled).toBe(false);
    await lifecycle.shutdown();
  });

  test("a remote HTTP agent exposes permission recovery at boot and live swap", async () => {
    const config = httpAgentConfig();
    config.inference!.allowRemoteInference = false;
    config.inference!.backends!["agent-http"] = { type: "http", url: "https://203.0.113.10" };
    const { lifecycle, registry } = makeLifecycle(config);
    await registry.probeBackends();
    await lifecycle.bootAgent();
    expect(lifecycle.routeDeps.agentService).toBeUndefined();
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
    expect(lifecycle.routeDeps.agentConfig.disabledCode).toBe("remote_inference_disabled");
    await lifecycle.applyAgentSwap();
    expect(lifecycle.routeDeps.disabledCode).toBe("remote_inference_disabled");
    await lifecycle.shutdown();
  });

  test("resolveRoleBackend refuses a cloud sub-agent role when remote inference is off", () => {
    // The deep-research / brief fan-out builds sub-agent backends through
    // resolveRoleBackend — it must also fail closed for cloud kinds.
    const manifest: Manifest = { version: 1, models: [] };
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => true,
    });
    registry.loadConfig({
      inference: { assignments: { "background-agent": "anthropic/claude-sonnet-4-6" } },
    } as OmnesisConfig);

    const backend = resolveRoleBackend("background-agent", {
      inferenceRegistry: registry,
      configDir,
      db: {} as AgentLifecycleDeps["db"],
      maxToolIterations: undefined,
      log: createLogger("test:resolve-role-backend"),
    });

    expect(backend).toBeNull();
  });

  test("resolveRoleBackend passes an HTTP agent timeout to the background agent", () => {
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
    });
    registry.loadConfig({
      inference: {
        allowRemoteInference: true,
        backends: {
          cloud: {
            type: "http",
            url: "https://api.example.com",
            agentTimeoutMs: 345_000,
          },
        },
        assignments: { "background-agent": "cloud/reasoning-model" },
      },
    });
    const backends = (
      registry as unknown as {
        httpBackends: Map<
          string,
          {
            config: { url: string };
            status: { type: "http"; url: string; status: "ok"; models: string[] };
          }
        >;
      }
    ).httpBackends;
    const entry = backends.get("cloud");
    if (!entry) throw new Error("expected configured HTTP backend");
    entry.status = {
      type: "http",
      url: entry.config.url,
      status: "ok",
      models: ["reasoning-model"],
    };

    const backend = resolveRoleBackend("background-agent", {
      inferenceRegistry: registry,
      configDir,
      db: {} as AgentLifecycleDeps["db"],
      maxToolIterations: 1,
      log: createLogger("test:background-reasoning-backend"),
    });

    expect(backend).toBeInstanceOf(HttpAgentBackend);
    const chat = (
      backend as unknown as {
        chat: { timeoutMs: number };
      }
    ).chat;
    expect(chat.timeoutMs).toBe(345_000);
  });

  test("resolveRoleBackend constructs an independently assigned Anthropic privacy reviewer", () => {
    const previousKey = process.env.OMNESIS_ANTHROPIC_API_KEY;
    process.env.OMNESIS_ANTHROPIC_API_KEY = "sk-ant-test-key";
    try {
      const manifest: Manifest = { version: 1, models: [] };
      const registry = new InferenceRegistry({
        modelsDir,
        configDir,
        manifest: () => manifest,
        hasAnthropicApiKey: () => true,
      });
      registry.loadConfig({
        inference: {
          allowRemoteInference: true,
          assignments: { "privacy-reviewer": "anthropic/claude-sonnet-4-6" },
        },
      });

      const backend = resolveRoleBackend("privacy-reviewer", {
        inferenceRegistry: registry,
        configDir,
        db: {} as AgentLifecycleDeps["db"],
        maxToolIterations: 1,
        log: createLogger("test:privacy-reviewer-backend"),
      });

      expect(backend).toBeInstanceOf(AnthropicBackend);
    } finally {
      if (previousKey === undefined) delete process.env.OMNESIS_ANTHROPIC_API_KEY;
      else process.env.OMNESIS_ANTHROPIC_API_KEY = previousKey;
    }
  });

  test("resolveRoleBackend preserves a live Anthropic input-only ceiling", () => {
    const previousKey = process.env.OMNESIS_ANTHROPIC_API_KEY;
    process.env.OMNESIS_ANTHROPIC_API_KEY = "sk-ant-test-key";
    const entry: AnthropicCatalogEntry = {
      kind: "anthropic-api",
      id: "anthropic/claude-invented-live",
      apiModelId: "claude-invented-live",
      name: "Invented Live Model",
      roles: ["agent"],
      author: "Anthropic",
      license: "Anthropic Commercial Terms",
      description: "Invented test catalog entry.",
      contextLength: 100_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
    };
    try {
      const registry = new InferenceRegistry({
        modelsDir,
        configDir,
        manifest: () => ({ version: 1, models: [] }),
        hasAnthropicApiKey: () => true,
        getCatalogEntry: (id) => (id === entry.id ? entry : undefined),
      });
      registry.loadConfig({
        inference: {
          allowRemoteInference: true,
          assignments: { "privacy-reviewer": entry.id },
        },
      });

      const backend = resolveRoleBackend("privacy-reviewer", {
        inferenceRegistry: registry,
        configDir,
        db: {} as AgentLifecycleDeps["db"],
        maxToolIterations: 1,
        log: createLogger("test:privacy-reviewer-live-limits"),
      });

      expect(backend).toBeInstanceOf(AnthropicBackend);
      const limits = (
        backend as unknown as {
          modelLimits: {
            maxInputTokens?: number;
            contextWindowTokens?: number;
            maxOutputTokens?: number;
          };
        }
      ).modelLimits;
      expect(limits).toEqual({
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
      });
    } finally {
      if (previousKey === undefined) delete process.env.OMNESIS_ANTHROPIC_API_KEY;
      else process.env.OMNESIS_ANTHROPIC_API_KEY = previousKey;
    }
  });

  test("resolveRoleBackend constructs a Codex privacy reviewer through the shared runtime", () => {
    const manifest: Manifest = { version: 1, models: [] };
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => false,
    });
    registry.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: { "privacy-reviewer": "codex/gpt-5.4" },
        modelSettings: {
          "privacy-reviewer": {
            assignment: "codex/gpt-5.4",
            values: { reasoningEffort: "high" },
          },
        },
      },
    });
    const expected = { runTurn: vi.fn() } as unknown as ChatBackend;
    const createBackend = vi.fn(() => expected);

    const backend = resolveRoleBackend("privacy-reviewer", {
      inferenceRegistry: registry,
      configDir,
      db: {} as AgentLifecycleDeps["db"],
      maxToolIterations: 1,
      log: createLogger("test:privacy-reviewer-backend"),
      codexRuntimeService: { createBackend } as unknown as CodexRuntimeService,
    });

    expect(backend?.runTurn).toBeTypeOf("function");
    // Privacy reviews use independent inference capacity.
    expect(createBackend).toHaveBeenCalledWith({
      model: "gpt-5.4",
      reasoningEffort: "high",
      maxToolIterations: 1,
      lane: "inference",
    });
  });

  test("routes Codex roles to the correct lane (background Brain, interactive agent, and inference)", () => {
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
    });
    registry.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: {
          "background-agent": "codex/gpt-5.4",
          "entailment-verifier": "codex/gpt-5.4",
          "privacy-reviewer": "codex/gpt-5.4",
        },
      },
    });
    const createBackend = vi.fn(() => ({ runTurn: vi.fn() }) as unknown as ChatBackend);
    const ctx = {
      inferenceRegistry: registry,
      configDir,
      db: {} as AgentLifecycleDeps["db"],
      maxToolIterations: 1,
      log: createLogger("test:codex-lane"),
      codexRuntimeService: { createBackend } as unknown as CodexRuntimeService,
    };

    const laneFor = (role: Parameters<typeof resolveRoleBackend>[0]): unknown => {
      createBackend.mockClear();
      resolveRoleBackend(role, ctx);
      return (createBackend.mock.calls[0]?.[0] as { lane?: string } | undefined)?.lane;
    };

    // Background work serializes on the owner runtime; interactive work
    // spreads across the pool.
    expect(laneFor("background-agent")).toBe("background");
    expect(laneFor("privacy-reviewer")).toBe("inference");

    expect(laneFor("entailment-verifier")).toBe("inference");
  });

  test("routes Claude Code roles to the correct lane with the saved effort", () => {
    const registry = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
    });
    registry.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: {
          agent: "claude-code/opus",
          "background-agent": "claude-code/sonnet",
          "privacy-reviewer": "claude-code/haiku",
          embedder: "claude-code/sonnet",
        },
        modelSettings: {
          agent: { assignment: "claude-code/opus", values: { reasoningEffort: "high" } },
        },
      },
    });
    const createBackend = vi.fn(() => ({ runTurn: vi.fn() }) as unknown as ChatBackend);
    const ctx = {
      inferenceRegistry: registry,
      configDir,
      db: {} as AgentLifecycleDeps["db"],
      maxToolIterations: 1,
      log: createLogger("test:claude-code-lane"),
      claudeCodeService: { createBackend } as unknown as ClaudeCodeService,
    };
    const optsFor = (role: Parameters<typeof resolveRoleBackend>[0]): unknown => {
      createBackend.mockClear();
      resolveRoleBackend(role, ctx);
      return createBackend.mock.calls[0]?.[0];
    };

    expect(optsFor("agent")).toMatchObject({
      model: "opus",
      reasoningEffort: "high",
      lane: "interactive",
    });
    expect(optsFor("background-agent")).toMatchObject({ model: "sonnet", lane: "background" });
    expect(optsFor("privacy-reviewer")).toMatchObject({ model: "haiku", lane: "inference" });
    expect(optsFor("embedder")).toBeUndefined();
  });

  test("intentionally-unset agent assignment stays a normal state (no error log)", async () => {
    // Negative control: an omitted/null role is a normal state — it must NOT
    // log at error level. (It logs at info; the disabled reason is benign.)
    const { lifecycle, errorSpy } = makeLifecycle(disabledConfig());

    await lifecycle.bootAgent();

    expect(lifecycle.routeDeps.agentConfig.backend).toBe("disabled");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("recovers privacy state at boot and sweeps expirations without request traffic", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, recoverInterruptedAnswerTasks, expirePrivacyApprovals } = makeLifecycle();

      await lifecycle.bootAgent();
      expect(recoverInterruptedAnswerTasks).toHaveBeenCalledOnce();
      expect(expirePrivacyApprovals).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(PRIVACY_STATE_SWEEP_INTERVAL_MS);
      expect(expirePrivacyApprovals).toHaveBeenCalledTimes(2);
      await lifecycle.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("decorateSpecialist — the operator's standing instructions", () => {
  const MARKER = "ZZSPECIALISTRULE prefer primary sources";
  const specialist = (name: string): ResolvedSpecialist => ({
    name,
    systemPrompt: `You are the ${name} specialist.`,
    modelRole: "agent",
  });

  test("rides on a researching specialist's fixed prompt", () => {
    for (const name of ["research-planner", "history-sweep", "source-digest"]) {
      const decorated = decorateSpecialist(specialist(name), MARKER);
      expect(decorated.systemPrompt).toContain(`You are the ${name} specialist.`);
      expect(decorated.systemPrompt).toContain(MARKER);
    }
  });

  test("never reaches an adjudicating specialist", () => {
    // `citation-verifier` decides whether a quote really appears in a document.
    // A verdict the operator's own prose can lean on is not a verdict — the
    // same reason the privacy reviewer and the brief judge are kept clean.
    const verifier = specialist("citation-verifier");
    expect(decorateSpecialist(verifier, MARKER)).toBe(verifier);
  });

  test("leaves a specialist untouched when there is no file", () => {
    const planner = specialist("research-planner");
    expect(decorateSpecialist(planner, "")).toBe(planner);
    expect(decorateSpecialist(planner, "   \n ")).toBe(planner);
  });
});
