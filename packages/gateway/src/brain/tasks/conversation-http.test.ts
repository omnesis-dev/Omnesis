// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /tasks/:id/conversation` ("Chat about this"): a new, empty
 * conversation about a task, carrying the task's card snapshot in its origin,
 * listed and resumed like any other conversation.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, ProviderId, SourceId, type Scope } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { AgentService } from "../../agent/service.js";
import { FsConversationStore } from "../../agent/conversation-store.js";
import { createMutableClock } from "../virtual-clock.js";
import { createOpenLoop } from "../storage/open-loops.js";
import type { ChatBackend, DocumentPort, SearchPort } from "@omnesis/agent";
import type { StatusCache } from "../../http/services/StatusCache.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T12:00:00");

let db: Database.Database;
let dbPath: string;
let convDir: string;
let statusCache: StatusCache;
let admin: string;
const clock = createMutableClock(NOW);

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };
const silentBackend: ChatBackend = {
  name: "scripted",
  model: "scripted-model",
  // eslint-disable-next-line require-yield
  async *runTurn() {
    return;
  },
};

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function boot(withAgent = true) {
  let n = 0;
  const agentService = withAgent
    ? new AgentService({
        backendFactory: () => silentBackend,
        ports: { search: stubSearch, document: stubDocument },
        systemPrompt: "default chat prompt",
        sessionIdGen: () => `s_${++n}`,
        idleTimeoutMs: 60_000,
        store: new FsConversationStore(convDir),
      })
    : undefined;
  const app = createServer(db, dbPath, {
    briefsClock: clock,
    ...(agentService ? { agentService } : {}),
    onStatusCache: (cache) => {
      statusCache = cache;
    },
  });
  const call = async (method: string, path: string, body?: unknown, token = admin) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return { call };
}

function seedDocument(externalId: string, title: string): string {
  upsertDocuments(db, [
    {
      providerId: ProviderId("fictional"),
      sourceId: SourceId("mail:inbox"),
      externalId,
      title,
      content: `${title} body`,
      contentHash: `h-${externalId}`,
      sourceCreatedAt: "2026-03-09T09:00:00.000Z",
      sourceUpdatedAt: "2026-03-09T09:00:00.000Z",
      metadata: {},
    },
  ]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

beforeEach(() => {
  clock.set(NOW);
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  convDir = mkdtempSync(join(tmpdir(), "omnesis-task-conversation-"));
  admin = mintToken([SCOPE_ADMIN]);
});

afterEach(() => {
  statusCache?.stop();
  db.close();
  rmSync(convDir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

describe("POST /tasks/:id/conversation", () => {
  test("opens a new, empty conversation carrying the task's snapshot", async () => {
    const { call } = boot();
    const lease = seedDocument("e1", "Lease renewal terms");
    const id = "loop_lease";
    createOpenLoop(
      db,
      {
        id,
        createdByRun: "run_1",
        origin: "user",
        title: "Renew the studio lease",
        confidence: 1,
        importance: 0.5,
        deadline: { type: "by", date: "2026-03-20" },
        docs: [lease, "doc_gone"],
      },
      NOW,
    );

    const res = await call("POST", `/tasks/${id}/conversation`, {});
    expect(res.status).toBe(200);
    const conversation = res.json.conversation;
    expect(conversation).toMatchObject({
      title: "Renew the studio lease",
      messageCount: 0,
      pinned: false,
      origin: {
        kind: "task",
        taskId: id,
        runId: id,
        task: {
          title: "Renew the studio lease",
          state: "open",
          due: "2026-03-20",
          sourceCount: 1,
        },
        seedMessageCount: 0,
      },
    });

    // Listed like any conversation, with the anchor only.
    const listed = await call("GET", "/agent/conversations");
    const row = listed.json.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(row).toMatchObject({ title: "Renew the studio lease", messageCount: 0 });
    expect(row.origin).toEqual({ kind: "task", taskId: id, runId: id });

    // Resumed like any conversation, with the full origin for the card.
    const resumed = await call("POST", "/agent/sessions", { resumeFromId: conversation.id });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({
      sessionId: conversation.id,
      title: "Renew the studio lease",
      messages: [],
      origin: conversation.origin,
    });

    // Every call opens a new conversation.
    const again = await call("POST", `/tasks/${id}/conversation`, {});
    expect(again.json.conversation.id).not.toBe(conversation.id);
  });

  test("accepts a request without a body", async () => {
    const { call } = boot();
    const id = (await call("POST", "/tasks", { title: "Book the piano tuner" })).json.task.id;
    expect((await call("POST", `/tasks/${id}/conversation`)).status).toBe(200);
  });

  test("answers 404 for a task that does not exist", async () => {
    const { call } = boot();
    const res = await call("POST", "/tasks/loop_missing/conversation", {});
    expect(res.status).toBe(404);
    expect(res.json.error).toBeTruthy();
  });

  test("answers 503 when no agent is available", async () => {
    const { call } = boot(false);
    const id = (await call("POST", "/tasks", { title: "Book the piano tuner" })).json.task.id;
    expect((await call("POST", `/tasks/${id}/conversation`, {})).status).toBe(503);
  });

  test("requires the admin scope", async () => {
    const { call } = boot();
    const id = (await call("POST", "/tasks", { title: "Book the piano tuner" })).json.task.id;
    const reader = mintToken([SCOPE_READ]);
    expect((await call("POST", `/tasks/${id}/conversation`, {}, reader)).status).toBe(403);
  });
});
