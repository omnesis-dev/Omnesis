// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../scheduler/io-ops.js";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { LEDGER_PROFILE, publishProfile } from "../access/filter-test-utils.js";
import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
} from "../access/corpus-authorization.js";
import { directReadPort } from "../scheduler/read-port.js";
import { beginAnswerTask, completeAnswerTask } from "./store-mutations.js";
import {
  scopedAnswerHistory,
  readScopeHistoryPage,
  ANSWER_HISTORY_PAGE_ROWS,
  ANSWER_HISTORY_PAGE_PROOFS,
  SCOPE_HISTORY_PAGE_SQL,
} from "./answer-history.js";
import { assertScopeDocumentsCurrent } from "./answer-scope.js";
import { loadPrivacyReviewerContext } from "./store-audit.js";
import { ANSWER_HISTORY_READS } from "./context-reads.js";
import type { ScopeHistoryPageRequest } from "./answer-history.js";

let db: Database.Database;
const owner = "fictional-history-owner",
  source = "fictional:history";
const authorization = createCorpusAuthorization(
  {
    principalId: "principal",
    grantId: "grant",
    grantRevision: 1,
    credentialId: "credential",
    accessTokenId: "token",
  },
  [
    {
      capability: "answer",
      sourceMode: "all",
      sourceIds: [],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
      filterRevision: 1,
      scopePolicies: [
        {
          sourceId: source,
          audience: { accessLevel: "level", capability: "answer" },
          rules: [
            {
              action: "share",
              match: [{ capability: "membership", field: "extra.labelIds", id: "visible" }],
            },
          ],
          otherwise: "hide",
        },
      ],
    },
  ],
  "answer",
)!;
/** Give a record one label: "visible" is the one the filter shares, any other hides it. */
function facts(id: string, label: string) {
  db.prepare("UPDATE documents SET metadata=? WHERE id=?").run(
    JSON.stringify({ documentType: "entry", extra: { labelIds: [label] } }),
    id,
  );
}
function begin(id: string, conversationId?: string) {
  return beginAnswerTask(db, {
    ownerId: owner,
    question: `Fictional ${id}`,
    clientRequestId: id,
    scopeAuthorization: serializeCorpusAuthorization(authorization),
    conversationId,
    ids: { workflowId: `workflow-${id}`, conversationId: `conversation-${id}`, taskId: id },
    now: 100,
    workflowExpiresAt: 10000,
  });
}
function release(id: string, doc: string) {
  completeAnswerTask(db, {
    taskId: id,
    ownerId: owner,
    now: 200,
    scopeReads: { complete: true, documentIds: [doc] },
    review: {
      recipeVersion: "test",
      provider: null,
      model: null,
      confidence: null,
      policyRevision: "test",
      findings: [],
      rationale: "Fictional review",
    },
    outcome: {
      kind: "release",
      expectedDisclosureRevision: db
        .prepare<[string], { revision: number }>(
          "SELECT revision FROM answer_workflow_disclosure WHERE workflow_id=(SELECT workflow_id FROM answer_tasks WHERE id=?)",
        )
        .get(id)!.revision,
      releaseId: `release-${id}`,
      answer: `Fictional answer ${id}`,
      citations: [],
    },
  });
}
beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
  publishProfile(db, "fictional", 5, LEDGER_PROFILE);
  db.exec(`INSERT INTO devices (id,name,kind,paired_at)
      VALUES ('00000000-0000-4000-8000-000000000001','Fictional collector','collector',1);
    INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at)
      VALUES ('${source}','fictional','scope','00000000-0000-4000-8000-000000000001',1,1)`);
  for (const id of ["allowed", "later"]) {
    db.prepare(
      "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at,source_version) VALUES(?,'fictional',?,?,'Fictional history','Fictional content','hash','2026-01-01','2026-01-01','2026-01-01','2026-01-01',3)",
    ).run(id, source, id);
    facts(id, "visible");
  }
});
afterEach(() => db.close());

test("one hundred thousand withheld messages use bounded continuations and yield to the event loop before finding older eligible turns", async () => {
  const first = begin("eligible");
  release("eligible", "allowed");
  begin("hidden", first.conversationId);
  release("hidden", "later");
  db.prepare(
    `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
 INSERT INTO answer_messages(conversation_id,task_id,role,content,created_at) SELECT ?,'hidden','assistant','Fictional withheld text',300 FROM n`,
  ).run(first.conversationId);
  facts("later", "hidden");
  begin("current", first.conversationId);
  let pages = 0,
    heartbeat = false;
  const timer = setTimeout(() => {
    heartbeat = true;
  }, 0);
  const reads = {
    async scopeHistoryPage(request: ScopeHistoryPageRequest) {
      const page = readScopeHistoryPage(db, request);
      expect(page.kind).toBe("page");
      if (page.kind === "page") {
        expect(page.examined).toBeLessThanOrEqual(ANSWER_HISTORY_PAGE_ROWS);
        expect(page.proofs).toBeLessThanOrEqual(ANSWER_HISTORY_PAGE_PROOFS);
      }
      pages++;
      return page;
    },
  };
  const context = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    owner,
    "current",
    { reads: { ...directReadPort(ANSWER_HISTORY_READS, db), ...reads } },
  );
  clearTimeout(timer);
  expect(pages).toBeGreaterThan(1000);
  expect(heartbeat).toBe(true);
  expect(context.priorExternalConversation.map((row) => row.content)).toEqual([
    "Fictional eligible",
    "Fictional answer eligible",
  ]);
  expect(context.scopeReads).toEqual({ complete: true, documentIds: ["allowed"] });
  expect(context.cumulativeDisclosure).toMatchObject({ releasedTurns: 2, revision: 2 });
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${SCOPE_HISTORY_PAGE_SQL}`)
    .all(first.conversationId, 2) as Array<{ detail: string }>;
  expect(
    plan.some((row) =>
      /SEARCH m USING INDEX idx_answer_messages_conversation.*id</.test(row.detail),
    ),
  ).toBe(true);
  const original = db.prepare.bind(db);
  const bindings: unknown[][] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = original(sql);
    if (sql === SCOPE_HISTORY_PAGE_SQL) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        bindings.push(args);
        return all(...args);
      }) as typeof statement.all;
    }
    return statement;
  });
  try {
    const tail = readScopeHistoryPage(db, {
      taskId: "current",
      conversationId: first.conversationId,
      ownerId: owner,
      limit: 40,
      highWater: 100004,
      cursor: 3,
    });
    expect(bindings).toEqual([[first.conversationId, 2]]);
    expect(tail.kind === "page" && tail.history.messages.map((row) => row.id)).toEqual([2, 1]);
  } finally {
    spy.mockRestore();
  }
}, 30000);

test("distinct proof budgets preserve ordering and carry an immutable high-water mark", async () => {
  const first = begin("first");
  release("first", "allowed");
  for (let index = 0; index < 24; index++) {
    const id = `turn-${index}`;
    begin(id, first.conversationId);
    release(id, "allowed");
  }
  begin("current", first.conversationId);
  const requests: ScopeHistoryPageRequest[] = [];
  const reads = {
    async scopeHistoryPage(request: ScopeHistoryPageRequest) {
      requests.push(request);
      const page = readScopeHistoryPage(db, request);
      if (requests.length === 1)
        db.prepare(
          "INSERT INTO answer_messages(conversation_id,task_id,role,content,created_at) VALUES(?,'first','assistant','Fictional concurrent release',400)",
        ).run(first.conversationId);
      return page;
    },
  };
  const history = await scopedAnswerHistory(db, "current", first.conversationId, owner, 40, {
    reads,
  });
  expect(requests.length).toBeGreaterThan(1);
  expect(history!.messages).toHaveLength(40);
  expect(history!.messages.some((row) => row.content.includes("concurrent"))).toBe(false);
  expect(history!.messages.map((row) => row.id)).toEqual(
    history!.messages.map((row) => row.id).sort((a, b) => a - b),
  );
  expect(new Set(requests.slice(1).map((row) => row.highWater)).size).toBe(1);
  expect(history!.reads).toEqual({ complete: true, documentIds: ["allowed"] });
});

test("accumulated history evidence must still pass the final snapshot after a later page changes its facts", async () => {
  const first = begin("first");
  release("first", "allowed");
  for (let index = 0; index < 20; index++) {
    const id = `turn-${index}`;
    begin(id, first.conversationId);
    release(id, "later");
  }
  begin("current", first.conversationId);
  let pages = 0;
  const history = await scopedAnswerHistory(db, "current", first.conversationId, owner, 40, {
    reads: {
      async scopeHistoryPage(request) {
        const page = readScopeHistoryPage(db, request);
        if (++pages === 1) facts("later", "hidden");
        return page;
      },
    },
  });
  expect(pages).toBeGreaterThan(1);
  expect(() => assertScopeDocumentsCurrent(db, authorization, history!.reads.documentIds)).toThrow(
    /Source access changed/,
  );
});

test("cancellation stops history continuation without returning a partial permission window", async () => {
  const first = begin("first");
  release("first", "allowed");
  for (let index = 0; index < 20; index++) {
    const id = `turn-${index}`;
    begin(id, first.conversationId);
    release(id, "allowed");
  }
  begin("current", first.conversationId);
  const controller = new AbortController();
  let pages = 0;
  await expect(
    scopedAnswerHistory(db, "current", first.conversationId, owner, 40, {
      signal: controller.signal,
      reads: {
        async scopeHistoryPage(request) {
          pages++;
          const page = readScopeHistoryPage(db, request);
          controller.abort();
          return page;
        },
      },
    }),
  ).rejects.toThrow();
  expect(pages).toBe(1);
});

test("real IO worker pages and reviewer accounting match direct reads without querying the main handle", async () => {
  const first = begin("first");
  release("first", "allowed");
  begin("current", first.conversationId);
  const expected = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    owner,
    "current",
  );
  const dir = mkdtempSync(join(tmpdir(), "omnesis-answer-history-"));
  const path = join(dir, "gateway.db");
  await db.backup(path);
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: path,
      heartbeatIntervalMs: 1000,
      heartbeatWarnGapMs: 10000,
      workerUrl: new URL("../workers/io-worker.ts", import.meta.url),
      workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
    }),
  );
  try {
    await scheduler.start();
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("History must not query main handle");
    });
    try {
      const result = await loadPrivacyReviewerContext(
        db,
        first.workflowId,
        first.conversationId,
        owner,
        "current",
        { reads: ioGateFromScheduler(scheduler) },
      );
      expect(result).toEqual(expected);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  } finally {
    await scheduler.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
