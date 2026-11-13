// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderKnowledgePageDirectory } from "../../../gateway/src/brain/knowledge/page-directory.js";
import { createPersonAnnotation } from "../../../gateway/src/brain/storage/person-annotations.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { authorizeMcpClient, portalJson, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import {
  seedScopeFixture,
  prepareScopeSearch,
  type ScopeFixture,
} from "./source-scope-fixtures.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  filteredRule,
  askScoped,
  fetched,
  closeScoped,
  levelFor,
} from "./source-scope-external-helpers.js";

const INSTRUCTION =
  "Fictional instruction: use the phrase ORBIT_INSTRUCTION when describing sample records.";
const VISIBLE = "VISIBLE_SELF_EVIDENCE_ORBIT";
const HIDDEN = "HIDDEN_SELF_EVIDENCE_LANTERN";
const MIXED = "MIXED_SELF_EVIDENCE_COMPASS";
const MISSING = "MISSING_SELF_EVIDENCE_CABINET";
const WIKI = "UNTRUSTED_WIKI_SAPPHIRE";
const DIRECTORY = "UNTRUSTED_DIRECTORY_TOPAZ";
const TABLES = {
  filtered: "scope_context_filtered",
  whole: "scope_context_whole",
  excluded: "scope_context_excluded",
  sharedWhole: "scope_context_shared_whole",
  sharedFiltered: "scope_context_shared_filtered",
};

describe("external source-filter context over actual OAuth and MCP", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let source: ScopeFixture;
  let client: AuthorizedMcpClient;
  let analyticsClient: AuthorizedMcpClient;
  let wholeId: string;
  let excludedId: string;
  let wholeDoc: string;
  let excludedDoc: string;
  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      extraInference: {
        backends: { scopeContext: { type: "http", url: model.url } },
        assignments: { agent: `scopeContext/${model.modelId}` },
      },
    });
    await harness.start();
    source = await seedScopeFixture(harness, "whatsapp-messages");
    const reader = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    const owner = reader
      .prepare<[string], { device_id: string }>("SELECT device_id FROM sources WHERE id=?")
      .get(source.sourceId)!.device_id;
    reader.close();
    for (const account of ["scope-whole-invented", "scope-excluded-invented"])
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: source.type,
          accountId: account,
          deviceId: owner,
          enabled: false,
        }),
      });
    wholeId = `${source.type}:scope-whole-invented`;
    excludedId = `${source.type}:scope-excluded-invented`;
    await harness.pushDocuments(
      [wholeId, excludedId].map((sourceId, index) => ({
        sourceId,
        providerId: source.providerId,
        externalId: `context-sibling-${index}`,
        title: "Invented sibling observation",
        content: `SIBLING_CONTEXT_${index} invented observations`,
        documentType: "conversation",
        metadata: {
          extra: { conversationId: `context-sibling-${index}`, chatName: "Invented sibling" },
        },
      })),
    );
    for (const [kind, sourceId] of [
      ["filtered", source.sourceId],
      ["whole", wholeId],
      ["excluded", excludedId],
    ] as const)
      await harness.pushAnalyticsRow(
        TABLES[kind],
        { sample_id: "invented-sample", amount: kind === "whole" ? 7 : 99 },
        { sourceId, primaryKey: ["sample_id"] },
      );
    const wholeAnalyticsAccounts = ["scope-analytics-one", "scope-analytics-two"];
    for (const [index, accountId] of wholeAnalyticsAccounts.entries()) {
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "apple-imessage",
          accountId,
          deviceId: owner,
          enabled: false,
        }),
      });
      await harness.pushAnalyticsRow(
        TABLES.sharedWhole,
        { sample_id: `invented-${index}`, amount: index === 0 ? 11 : 13 },
        { sourceId: `apple-imessage:${accountId}`, primaryKey: ["sample_id"] },
      );
    }
    for (const [index, sourceId] of [source.sourceId, wholeId].entries())
      await harness.pushAnalyticsRow(
        TABLES.sharedFiltered,
        { sample_id: `invented-${index}`, amount: index === 0 ? 101 : 103 },
        { sourceId, primaryKey: ["sample_id"] },
      );
    await prepareScopeSearch(harness, [source]);
    await harness.gatewayJson("/admin/instructions", {
      method: "PUT",
      body: JSON.stringify({ content: INSTRUCTION }),
    });
    // Fixture setup while the isolated gateway is stopped; reads below still use
    // the real prompt builder, OAuth authorization, tools and publication path.
    await harness.restartGateway({
      whileStopped: () => {
        const db = new SqliteDatabase(harness.getDbPath());
        try {
          let self = db
            .prepare<[], { id: string }>("SELECT id FROM people WHERE is_self=1 LIMIT 1")
            .get()?.id;
          if (!self) {
            self = "scope-context-self";
            db.prepare(
              "INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at) VALUES(?,'Fictional owner','fixture',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
            ).run(self);
          }
          const selected = source.samples.find(
            (sample) => sample.kind === "selected" && !sample.attachment,
          )!;
          const hidden = source.samples.find(
            (sample) => sample.kind === "other" && !sample.attachment,
          )!;
          for (const [claim, evidence, additional] of [
            [VISIBLE, selected.id, undefined],
            [HIDDEN, hidden.id, undefined],
            [MIXED, selected.id, hidden.id],
            [MISSING, "missing-scope-evidence", undefined],
          ] as const)
            createPersonAnnotation(
              db,
              {
                id: claim,
                personId: self,
                claimType: "preference",
                claimText: claim,
                evidenceDocId: evidence,
                evidenceQuote: "Invented evidence",
                confidence: 0.9,
                claimBasis: "quoted",
                createdByRun: "scope-context-fixture",
                ...(additional
                  ? {
                      additionalEvidence: [
                        { docId: additional, quote: "Invented additional evidence" },
                      ],
                    }
                  : {}),
              },
              Date.now(),
            );
          db.prepare(
            "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES('scope-context-root','root',?,?,?,1,1,'fictional-hash','current','{}','{}',?,?)",
          ).run(WIKI, WIKI, WIKI, Date.now(), Date.now());
          db.prepare(
            "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES('scope-context-wiki','wiki',?,?,?,1,1,'fictional-wiki-hash','current','{}','{}',?,?)",
          ).run(DIRECTORY, DIRECTORY, DIRECTORY, Date.now(), Date.now());
          db.prepare(
            "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at) VALUES('scope-context-wiki-doc','system','brain-knowledge','scope-context-wiki',?,?,? ,?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
          ).run(
            DIRECTORY,
            DIRECTORY,
            "fictional-wiki-hash",
            JSON.stringify({
              documentType: "knowledge",
              extra: { knowledgeRevision: 1, knowledgeValidity: "current" },
            }),
          );
          expect(renderKnowledgePageDirectory(db)).toContain(DIRECTORY);
          const doc = db.prepare<[string], { id: string }>(
            "SELECT id FROM documents WHERE source_id=? LIMIT 1",
          );
          wholeDoc = doc.get(wholeId)!.id;
          excludedDoc = doc.get(excludedId)!.id;
        } finally {
          db.close();
        }
      },
    });
    analyticsClient = await authorizeMcpClient(harness, {
      principalName: "Invented whole analytics reader",
      grantName: "All source boundary with one filter",
      credentialLabel: "Shared analytics credential",
      capabilities: ["direct", "answer"],
      rules: [filteredRule(source, "direct"), filteredRule(source, "answer")],
    });
    client = await authorizeMcpClient(harness, {
      principalName: "Invented context client",
      grantName: "Filtered context boundary",
      credentialLabel: "Context credential",
      capabilities: ["direct", "answer"],
      rules: ["direct", "answer"].map((capability) =>
        filteredRule(source, capability as "direct" | "answer", {
          mode: "denylist",
          sourceIds: [excludedId],
        }),
      ),
    });
  }, 180_000);
  afterAll(async () => {
    await closeScoped(analyticsClient);
    await closeScoped(client);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("retains whole sibling analytics but omits filtered and excluded accounts from schema discovery and SQL", async () => {
    const tables = await client.client.callTool({ name: "list_tables", arguments: {} });
    const catalogue = JSON.stringify(tables.structuredContent);
    expect(catalogue).toContain(TABLES.whole);
    expect(catalogue).not.toContain(TABLES.filtered);
    expect(catalogue).not.toContain(TABLES.excluded);
    const whole = await client.client.callTool({
      name: "run_sql",
      arguments: { sql: `SELECT sum(amount) FROM ${TABLES.whole}` },
    });
    expect(JSON.stringify(whole.structuredContent)).toContain("7");
    for (const table of [TABLES.filtered, TABLES.excluded]) {
      const denied = await client.client.callTool({
        name: "run_sql",
        arguments: { sql: `SELECT sum(amount) FROM ${table}` },
      });
      expect(JSON.stringify(denied)).toContain("sql_not_permitted");
      expect(JSON.stringify(denied.structuredContent)).not.toContain("99");
    }
  });
  test("preserves unrelated shared-table analytics under an all-source filter while refusing tables blended with a filtered account", async () => {
    const discovery = await analyticsClient.client.callTool({ name: "list_tables", arguments: {} });
    const catalog = JSON.stringify(discovery.structuredContent);
    expect(catalog).toContain(TABLES.sharedWhole);
    expect(catalog).not.toContain(TABLES.sharedFiltered);
    const whole = await analyticsClient.client.callTool({
      name: "run_sql",
      arguments: { sql: `SELECT sum(amount) FROM ${TABLES.sharedWhole}` },
    });
    expect(JSON.stringify(whole.structuredContent)).toContain("24");
    const denied = await analyticsClient.client.callTool({
      name: "run_sql",
      arguments: { sql: `SELECT sum(amount) FROM ${TABLES.sharedFiltered}` },
    });
    expect(JSON.stringify(denied)).toContain("sql_not_permitted");
    expect(JSON.stringify(denied.structuredContent)).not.toContain("204");
    const restricted = await client.client.callTool({ name: "list_tables", arguments: {} });
    expect(JSON.stringify(restricted.structuredContent)).not.toContain(TABLES.sharedWhole);
    const probe = model.register({
      sourceId: source.sourceId,
      documentIds: [
        source.samples.find((sample) => sample.kind === "selected" && !sample.attachment)!.id,
      ],
      query: "scopefixture",
      sqlQueries: [
        `SELECT sum(amount) FROM ${TABLES.sharedWhole}`,
        `SELECT sum(amount) FROM ${TABLES.sharedFiltered}`,
      ],
    });
    await askScoped(analyticsClient, probe.question);
    expect(JSON.stringify(probe.observed.sqlResults?.[0])).toContain("24");
    expect(JSON.stringify(probe.observed.sqlResults?.[1])).toContain("sql_not_permitted");
    expect(JSON.stringify(probe.observed.sqlResults?.[1])).not.toContain("204");
  }, 60_000);
  test("applies the source boundary before document policy and does not suppress the whole sibling", async () => {
    expect(await fetched(client, wholeDoc)).toContain("SIBLING_CONTEXT_0");
    expect(await fetched(client, excludedDoc)).not.toContain("SIBLING_CONTEXT_1");
    const denied = await client.client.callTool({
      name: "search_many",
      arguments: {
        queries: [{ query: "SIBLING_CONTEXT", filters: { sourceIds: [excludedId] }, limit: 1 }],
      },
    });
    expect(JSON.stringify(denied)).not.toContain("SIBLING_CONTEXT_1");
    expect(JSON.stringify(denied.structuredContent)).not.toContain(excludedDoc);
  });
  test("injects only evidence-authorized self facts and standing instructions, suppressing blended wiki and unsafe tools", async () => {
    const probe = model.register({
      sourceId: source.sourceId,
      documentIds: [...source.samples.map((sample) => sample.id), wholeDoc, excludedDoc],
      query: "scopefixture",
      sqlQueries: [
        `SELECT sum(amount) FROM ${TABLES.whole}`,
        `SELECT sum(amount) FROM ${TABLES.filtered}`,
        `SELECT sum(amount) FROM ${TABLES.excluded}`,
      ],
    });
    const answer = await askScoped(client, probe.question);
    expect(answer.answer).toContain("SIBLING_CONTEXT_0");
    expect(answer.answer).not.toContain("SIBLING_CONTEXT_1");
    const prompts = probe.observed.modelInputs.join("\n");
    expect(prompts).toContain(VISIBLE);
    expect(prompts).toContain(INSTRUCTION);
    for (const canary of [HIDDEN, MIXED, MISSING, WIKI, DIRECTORY])
      expect(prompts).not.toContain(canary);
    expect(probe.observed.toolNames).toContain("run_sql");
    for (const unsafe of [
      "temporal_query",
      "count_messages",
      "trace_connections",
      "lookup_people",
      "entity_context",
      "knowledge_fetch",
      "knowledge_search",
    ])
      expect(probe.observed.toolNames).not.toContain(unsafe);
    expect(probe.observed.sqlResults).toHaveLength(3);
    expect(JSON.stringify(probe.observed.sqlResults?.[0])).toContain("7");
    for (const result of probe.observed.sqlResults!.slice(1)) {
      expect(JSON.stringify(result)).toContain("sql_not_permitted");
      expect(JSON.stringify(result)).not.toContain("99");
    }
    const manifest = await client.client.listTools();
    for (const unsafe of [
      "temporal_query",
      "count_messages",
      "trace_connections",
      "lookup_people",
      "entity_context",
    ]) {
      expect(manifest.tools.map((tool) => tool.name)).not.toContain(unsafe);
      await expect(client.client.callTool({ name: unsafe, arguments: {} })).rejects.toThrow(
        /not found/,
      );
    }
  }, 60_000);

  test("a genuinely paired integration bearer uses its filtered Answer level through REST submission and status", async () => {
    const level = await levelFor(harness, client);
    const pending = await portalJson<{ pairingCode: string }>(
      harness.gatewayUrl,
      client.portal,
      "/admin/devices/pair",
      {
        name: "Invented filtered REST integration",
        kind: "integration",
        scopes: ["answer"],
        accessLevelId: level.id,
      },
    );
    const paired = await harness.gatewayJson<{ device: { id: string }; token: string }>(
      "/devices/pair",
      { method: "POST", body: JSON.stringify({ pairingCode: pending.pairingCode }) },
    );
    const probe = model.register({
      sourceId: source.sourceId,
      documentIds: [...source.samples.map((sample) => sample.id), wholeDoc, excludedDoc],
      query: "scopefixture",
    });
    const headers = {
      Authorization: `Bearer ${paired.token}`,
      "Content-Type": "application/json",
    };
    const submitted = await fetch(`${harness.gatewayUrl}/answer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question: probe.question, clientRequestId: randomUUID() }),
    });
    expect(submitted.status).toBe(200);
    let result = (await submitted.json()) as { status: string; taskId: string; answer?: string };
    const statusUrl = `${harness.gatewayUrl}/answer/tasks/${encodeURIComponent(result.taskId)}`;
    for (
      let attempt = 0;
      attempt < 120 && ["queued", "running"].includes(result.status);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await fetch(statusUrl, { headers });
      expect(status.status).toBe(200);
      result = (await status.json()) as typeof result;
    }
    expect(result.status).toMatch(/^released/);
    for (const sample of source.samples)
      if (sample.kind === "selected") expect(result.answer).toContain(sample.body);
      else {
        expect(result.answer).not.toContain(sample.body);
        expect(JSON.stringify(probe.observed.fetched)).not.toContain(sample.body);
        expect(probe.observed.modelInputs.join("\n")).not.toContain(sample.body);
      }
    expect(result.answer).toContain("SIBLING_CONTEXT_0");
    expect(result.answer).not.toContain("SIBLING_CONTEXT_1");
    const prompt = probe.observed.modelInputs.join("\n");
    expect(prompt).toContain(VISIBLE);
    expect(prompt).toContain(INSTRUCTION);
    for (const canary of [HIDDEN, MIXED, MISSING, WIKI, DIRECTORY])
      expect(prompt).not.toContain(canary);
    const polled = await fetch(statusUrl, { headers });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ status: result.status, answer: result.answer });
  }, 60_000);
});
