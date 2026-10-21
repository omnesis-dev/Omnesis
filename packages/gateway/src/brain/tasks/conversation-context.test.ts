// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The system-prompt section of a conversation about a task: the task as it
 * stands now, its history and its linked documents, within a size cap, and a
 * deleted task described from the conversation's snapshot.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { TaskService } from "./service.js";
import { TaskQueryService } from "./views.js";
import {
  renderTaskConversationContext,
  taskConversationSnapshot,
  TASK_CONTEXT_MAX_CHARS,
} from "./conversation-context.js";
import type { TaskConversationOrigin } from "../../agent/conversation-store.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const ORIGIN = { surface: "tasks", runId: "user:tasks" } as const;

let db: Database.Database;
let path: string;
let tasks: TaskService;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  tasks = new TaskService(db, directWriteGate(db), () => NOW);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function seedDocument(externalId: string, title: string, content: string): string {
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, name, kind, paired_at)
     VALUES ('dev_1', 'a-collector', 'collector', 0)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES ('mail:inbox', 'fictional-mail', 'inbox', 'dev_1', '{}', 1, 0, 0)`,
  ).run();
  upsertDocuments(db, [
    {
      providerId: ProviderId("fictional"),
      sourceId: SourceId("mail:inbox"),
      externalId,
      title,
      content,
      contentHash: `h-${externalId}`,
      sourceCreatedAt: "2026-03-08T09:00:00.000Z",
      sourceUpdatedAt: "2026-03-08T09:00:00.000Z",
      metadata: {},
    },
  ]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

function seedTask(docs: string[] = []): TaskConversationOrigin {
  createOpenLoop(
    db,
    {
      id: "loop_lease",
      createdByRun: "run_1",
      origin: "user",
      title: "Renew the studio lease",
      description: "The landlord wants the signed renewal before the end of the month.",
      confidence: 1,
      importance: 0.5,
      deadline: { type: "by", date: "2026-03-20" },
      docs,
    },
    NOW,
  );
  return {
    kind: "task",
    taskId: "loop_lease",
    runId: "loop_lease",
    task: {
      title: "Renew the studio lease",
      state: "open",
      due: "2026-03-20",
      sourceCount: docs.length,
    },
    seedMessageCount: 0,
  };
}

describe("renderTaskConversationContext", () => {
  test("carries the task's title, state, due date, notes, history and sources", async () => {
    const lease = seedDocument(
      "e1",
      "Lease renewal terms",
      "Hello, attached are the renewal terms for unit 4. Please sign by the 20th. https://example.com/lease",
    );
    const origin = seedTask([lease]);
    await tasks.apply({ ...ORIGIN, kind: "migrate", id: "loop_lease", to: "2026-03-12" });
    await tasks.apply({
      ...ORIGIN,
      kind: "complete",
      id: "loop_lease",
      note: "Signed at the office",
    });

    const section = renderTaskConversationContext(db, origin);
    expect(section).toContain("## The task this conversation is about");
    expect(section).toContain('Task loop_lease: "Renew the studio lease"');
    expect(section).toContain("State: done");
    expect(section).toContain("planned for 2026-03-12");
    expect(section).toContain("due 2026-03-20");
    expect(section).toContain("Description: The landlord wants the signed renewal");
    expect(section).toContain("Completion note: Signed at the office");
    expect(section).toContain("### History, newest first");
    expect(section).toMatch(/- 2026-03-10 completed/);
    expect(section).toMatch(/- 2026-03-10 migrated/);
    expect(section).toContain("### Linked documents");
    expect(section).toContain(
      `- [${lease}] "Lease renewal terms" (fictional-mail, 2026-03-08): Hello, attached are the renewal terms`,
    );
  });

  test("reads the task as it stands when called, not as it was", async () => {
    const origin = seedTask();
    expect(renderTaskConversationContext(db, origin)).toContain("State: open");
    await tasks.apply({
      ...ORIGIN,
      kind: "edit",
      id: "loop_lease",
      fields: { title: "Renew the lease for unit 4" },
    });
    const section = renderTaskConversationContext(db, origin);
    expect(section).toContain('"Renew the lease for unit 4"');
    expect(section).not.toContain('Task loop_lease: "Renew the studio lease"');
  });

  test("leaves out documents that are gone", () => {
    const origin = seedTask(["doc_gone"]);
    const section = renderTaskConversationContext(db, origin);
    expect(section).not.toContain("doc_gone");
    expect(section).not.toContain("### Linked documents");
  });

  test("stays within the cap and says how much it left out", () => {
    const docs = Array.from({ length: 60 }, (_, i) =>
      seedDocument(`e${i}`, `Quote ${i} for the move`, "x ".repeat(400)),
    );
    const origin = seedTask(docs);
    const section = renderTaskConversationContext(db, origin, 2_000);
    expect(section.length).toBeLessThanOrEqual(2_000);
    expect(section).toContain('Task loop_lease: "Renew the studio lease"');
    expect(section).toMatch(/\(\d+ more documents not shown\)/);
    expect(renderTaskConversationContext(db, origin).length).toBeLessThanOrEqual(
      TASK_CONTEXT_MAX_CHARS,
    );
  });

  test("describes a deleted task from the conversation's snapshot", async () => {
    const origin = seedTask();
    await tasks.apply({ ...ORIGIN, kind: "delete", id: "loop_lease" });
    const section = renderTaskConversationContext(db, origin);
    expect(section).toContain("## The task this conversation is about");
    expect(section).toContain("loop_lease, which has since been deleted");
    expect(section).toContain('"Renew the studio lease" (state: open, due 2026-03-20');
  });
});

describe("taskConversationSnapshot", () => {
  test("counts only the linked documents that can be opened", () => {
    const lease = seedDocument("e1", "Lease renewal terms", "terms");
    seedTask([lease, "doc_gone"]);
    const queries = new TaskQueryService(db);
    const item = queries.get("loop_lease")!;
    expect(taskConversationSnapshot(item, queries.documents([item]))).toEqual({
      title: "Renew the studio lease",
      state: "open",
      due: "2026-03-20",
      sourceCount: 1,
    });
  });
});
