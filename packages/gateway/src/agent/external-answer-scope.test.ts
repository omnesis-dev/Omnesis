// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.js";
import { AnalyticsDb } from "../analytics-db.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import {
  createExternalAnswerTools,
  resolveExternalAnswerContext,
} from "./external-answer-scope.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { SearchResponse } from "../search/types.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type Database from "better-sqlite3";

describe("external Answer context", () => {
  let directory: string;
  let db: Database.Database;
  let analytics: AnalyticsDb;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "omnesis-answer-scopes-"));
    db = createDatabase(join(directory, "corpus.db"));
    analytics = new AnalyticsDb(join(directory, "analytics.db"));
    await analytics.open();
    db.exec(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES ('00000000-0000-4000-8000-000000000001','Synthetic collector','collector',1)",
    );
    for (const account of ["filtered", "whole", "excluded"]) {
      db.prepare(
        `INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at)
        VALUES (?, 'fictional',?,'00000000-0000-4000-8000-000000000001',1,1)`,
      ).run(`fictional:${account}`, account);
      const schema = {
        tableName: `scope_${account}`,
        displayName: `Fictional ${account}`,
        description: "Invented numeric samples.",
        columns: [
          { name: "sample_id", type: "VARCHAR", description: "Sample identifier" },
          { name: "amount", type: "DOUBLE", description: "Sample amount" },
        ],
        primaryKey: ["sample_id"],
        record: { titleColumns: ["sample_id"], keyColumns: ["sample_id"] },
        semanticTimeColumn: null,
      } satisfies AnalyticsTableSchema;
      await analytics.ensureTable(schema, `fictional:${account}`);
      await analytics.insertRecords(
        schema.tableName,
        [{ sample_id: "sample", amount: account === "whole" ? 7 : 99 }],
        schema.primaryKey,
      );
    }
  });
  afterEach(async () => {
    await analytics.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function authorization(filtered: boolean) {
    return createCorpusAuthorization(
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
          sourceMode: "denylist",
          sourceIds: ["fictional:excluded"],
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
          ...(filtered
            ? {
                filterRevision: 1,
                scopePolicies: [
                  {
                    sourceId: "fictional:filtered",
                    audience: { accessLevel: "level", capability: "answer" as const },
                    rules: [
                      {
                        action: "hide" as const,
                        match: [
                          {
                            capability: "membership" as const,
                            field: "extra.chatId",
                            id: "private",
                          },
                        ],
                      },
                    ],
                    otherwise: "share" as const,
                  },
                ],
              }
            : {}),
        },
      ],
      "answer",
    )!;
  }
  function tools(filtered: boolean) {
    return createExternalAnswerTools({
      db,
      analyticsDb: analytics,
      searchPipeline: {} as SearchPipeline,
      authorization: authorization(filtered),
      knowledgeReads: true,
      allowVerifiedAnswers: false,
    });
  }

  it("retains analytics only for whole permitted accounts, including a sibling of the filtered source type", async () => {
    const context = await resolveExternalAnswerContext(db, analytics, authorization(true));
    expect(context.catalog.map((entry) => entry.tableName)).toEqual(["scope_whole"]);
    expect(context.selfMemory).toBe("");
    expect((await resolveExternalAnswerContext(db, analytics)).catalog).toHaveLength(3);
  });

  it("preserves source-only restricted Answer context and tool inventory", async () => {
    expect(
      (await resolveExternalAnswerContext(db, analytics, authorization(false))).catalog,
    ).toEqual([]);
    expect(
      tools(false)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["annotate_many", "fetch_many", "lookup_document_by_url", "search_many"]);
  });

  it("records trusted search, body and URL reads before returning tool results", async () => {
    const url = "https://example.org/scope-visible";
    db.prepare(
      `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_url,
      source_created_at,source_updated_at,ingested_at,updated_at) VALUES ('whole-doc','fictional','fictional:whole','whole-doc','Fictional document',
      'Fictional scope evidence.','hash',?,?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run(JSON.stringify({ documentType: "file", sourceUrl: url }), url);
    const response = {
      query: { original: "sample" },
      timing: { totalMs: 0 },
      results: [
        {
          documentId: "whole-doc",
          sourceId: "fictional:whole",
          documentType: "file",
          title: "Fictional document",
          sourceCreatedAt: "2026-01-01",
          chunkText: "Fictional scope evidence.",
          score: 1,
        },
      ],
    } satisfies SearchResponse;
    const search = { search: vi.fn().mockResolvedValue(response) } satisfies Pick<
      SearchPipeline,
      "search"
    >;
    const scopeReads = { recordDocuments: vi.fn(), markComplete: vi.fn() };
    const handles = createExternalAnswerTools({
      db,
      analyticsDb: analytics,
      searchPipeline: search as unknown as SearchPipeline,
      authorization: authorization(true),
      knowledgeReads: true,
      allowVerifiedAnswers: false,
      scopeReads,
    });
    const ctx = { sessionId: "session", messageId: "message" };
    const calls = [
      { name: "search_many", args: { queries: [{ query: "sample" }] } },
      { name: "fetch_many", args: { documents: [{ documentId: "whole-doc" }] } },
      { name: "lookup_document_by_url", args: { url } },
    ];
    for (const call of calls) {
      await handles.find((tool) => tool.name === call.name)!.invoke(call.args, ctx);
      expect(scopeReads.recordDocuments).toHaveBeenLastCalledWith(["whole-doc"]);
    }
    expect(scopeReads.recordDocuments).toHaveBeenCalledTimes(3);
    // Building the tools is what closes the run's read set: every tool reads
    // through the observer it was built with.
    expect(scopeReads.markComplete).toHaveBeenCalledTimes(1);
  });

  it("enforces the same table boundary in the filtered Answer SQL tool", async () => {
    const handles = tools(true);
    expect(handles.map((tool) => tool.name).sort()).toEqual([
      "annotate_many",
      "fetch_many",
      "lookup_document_by_url",
      "run_sql",
      "search_many",
    ]);
    const sql = handles.find((tool) => tool.name === "run_sql")!;
    const context = { sessionId: "session", messageId: "message" };
    expect(await sql.invoke({ sql: "SELECT sum(amount) FROM scope_whole" }, context)).toMatchObject(
      { kind: "sql.rows", rows: [[7]] },
    );
    for (const table of ["scope_filtered", "scope_excluded"]) {
      const result = await sql.invoke({ sql: `SELECT sum(amount) FROM ${table}` }, context);
      expect(result).toMatchObject({ kind: "error", code: "sql_not_permitted" });
      expect(JSON.stringify(result)).not.toContain("99");
    }
  });
});
