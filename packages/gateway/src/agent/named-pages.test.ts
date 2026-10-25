// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import { namedPagesNote } from "../brain/knowledge/page-directory.js";
import { KNOWLEDGE_PROVIDER_ID } from "../brain/knowledge/source-meta.js";
import { saveKnowledgeNode } from "../brain/knowledge/storage.js";
import { createGatewayDocumentPort } from "./ports.js";
import { AgentService } from "./service.js";
import type { AgentEvent, ToolResult } from "@omnesis/core";
import type { ChatBackend, SearchPort, TurnInput } from "@omnesis/agent";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "named-pages-"));
  db = createDatabase(join(directory, "test.db"));
  insert("evidence", "notes", "test", "The observatory opens Saturday.", "evidence");
  const node = saveKnowledgeNode(
    db,
    {
      id: "observatory",
      kind: "wiki",
      title: "prism observatory",
      markdown:
        '<claim id="opening" refs="source:evidence">The observatory opens Saturday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    100,
  ).node;
  const projection = buildKnowledgeDocumentInput(node);
  insert(
    "projection-observatory",
    projection.sourceId,
    KNOWLEDGE_PROVIDER_ID,
    projection.content,
    "observatory",
    projection.metadata,
  );
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function insert(
  id: string,
  source: string,
  provider: string,
  text: string,
  externalId: string,
  metadata = {},
) {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, '2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(id, provider, source, externalId, id, text, "v1", JSON.stringify(metadata));
}

// A puppet of the conversation agent: it opens whatever page its turn is told
// to open, and answers without tools when it is told nothing.
it("hands a turn the ref of the page its message names, and keeps the transcript clean", async () => {
  const messages: string[] = [];
  const reads: ToolResult[] = [];
  let resolveTurn!: () => void;
  let turnComplete = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  const backend: ChatBackend = {
    name: "puppet",
    model: "puppet",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      messages.push(input.userMessage);
      const ref = /"ref":"(wiki:[^"]+)"/.exec(input.userMessage)?.[1];
      if (ref) {
        const fetchMany = input.tools.find((tool) => tool.name === "fetch_many")!;
        reads.push(await fetchMany.invoke({ documents: [{ documentId: ref }] }, input));
      }
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    },
  };
  const search: SearchPort = {
    search: async (q) => ({ query: q.query, durationMs: 1, results: [] }),
  };
  const service = new AgentService({
    backendFactory: () => backend,
    ports: { search, document: createGatewayDocumentPort(db) },
    systemPrompt: "test",
    namedPagesNote: (message) => namedPagesNote(db, message),
    broadcastEvent: (event) => {
      if (event.type === "agent.message.end") resolveTurn();
    },
    sessionIdGen: () => "S_named",
  });
  try {
    const { sessionId } = await service.createSession("token:test", {});
    service.sendMessage("token:test", sessionId, "What's the latest on the Prism observatory?");
    await turnComplete;
    turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    service.sendMessage("token:test", sessionId, "thanks!");
    await turnComplete;

    expect(messages[0]).toContain('"ref":"wiki:observatory"');
    expect(messages[1]).toBe("thanks!");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      kind: "document.batch",
      items: [{ kind: "document", ref: { documentId: "projection-observatory" } }],
    });
    const transcript = await service.listConversationMessages(sessionId, { limit: 10 });
    expect(JSON.stringify(transcript?.messages)).toContain("the Prism observatory?");
    expect(JSON.stringify(transcript?.messages)).not.toContain("wiki:observatory");
  } finally {
    await service.dispose();
  }
});
