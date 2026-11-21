// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What an external agent on a filtered level is given besides documents —
 * analytics, schema discovery, facts about the owner, the owner's standing
 * instructions, wiki pages and the tools that read across accounts —
 * through real OAuth, MCP and a REST integration on a spawned gateway.
 *
 * The `chat-filters` universe's WhatsApp account runs the real provider; the
 * level shares only one of its group chats. Two sibling accounts of the same
 * source are added beside it with pushed records and analytics rows: one the
 * level reads whole, one its rule excludes. Facts about the owner are stored
 * with evidence in the shared chat, in a withheld chat, in both, and in a
 * record that does not exist. Asserted:
 *   - analytics of an account with a filter, and of an excluded one, are
 *     absent from schema discovery and refused by SQL; a whole sibling's are
 *     kept, as is a table no filtered account writes to;
 *   - the source boundary applies before any filter, and a whole sibling is
 *     not suppressed by its filtered neighbour;
 *   - the Answer model is given only facts whose every piece of evidence the
 *     level can read, the standing instructions, no wiki page, and none of
 *     the tools that read across accounts;
 *   - a paired REST integration on the level is held to the same boundary.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderKnowledgePageDirectory } from "../../../gateway/src/brain/knowledge/page-directory.js";
import { createPersonAnnotation } from "../../../gateway/src/brain/storage/person-annotations.js";
import {
  authorizeMcpClient,
  portalJson,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  askFiltered,
  callDirect,
  closeConnection,
  filterPolicy,
  levelFor,
  readFilterCorpus,
  startFilterHarness,
  type FilterAccess,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";

const WHATSAPP = "whatsapp-messages:+12025550101";
/** A WhatsApp address: a person's by their number, a group's by its id. */
const personJid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const groupJid = (id: string) => `${id}@g.us`;
const CREW = groupJid("120000000000000001");
/** The four days of the account: the shared group's two, and two the level withholds. */
const DAYS: Record<string, [string, string]> = {
  [`${CREW}:2026-03-08`]: ["crew-1", "The rehearsal room is booked for Thursday evening."],
  [`${CREW}:2026-03-09`]: ["crew-2", "Doors open at six, bring the cables."],
  [`${personJid("+12025550123")}:2026-03-08`]: [
    "direct",
    "Are you still free for the trail run on Saturday?",
  ],
  [`${groupJid("120000000000000002")}:2026-03-08`]: [
    "partial",
    "The street cleaning moved to Monday morning.",
  ],
};
const SHARED = ["crew-1", "crew-2"];

const INSTRUCTION =
  "Fictional instruction: use the phrase ORBIT_INSTRUCTION when describing sample records.";
const VISIBLE = "VISIBLE_SELF_EVIDENCE_ORBIT";
const HIDDEN = "HIDDEN_SELF_EVIDENCE_LANTERN";
const MIXED = "MIXED_SELF_EVIDENCE_COMPASS";
const MISSING = "MISSING_SELF_EVIDENCE_CABINET";
const WIKI = "UNTRUSTED_WIKI_SAPPHIRE";
const DIRECTORY = "UNTRUSTED_DIRECTORY_TOPAZ";
const TABLES = {
  filtered: "filter_context_filtered",
  whole: "filter_context_whole",
  excluded: "filter_context_excluded",
  sharedWhole: "filter_context_shared_whole",
  sharedFiltered: "filter_context_shared_filtered",
};
const CROSS_ACCOUNT_TOOLS = [
  "temporal_query",
  "count_messages",
  "trace_connections",
  "lookup_people",
  "entity_context",
];

/** A rule whose filter shares only the crew group of the WhatsApp account. */
function filteredRule(
  access: FilterAccess,
  sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] } = {
    mode: "all",
    sourceIds: [],
  },
): TestGrantRule {
  const boundary = {
    sources,
    scopePolicies: [
      filterPolicy(WHATSAPP, access, "share", [
        { capability: "membership", field: "extra.chatJid", id: CREW },
      ]),
    ],
  };
  return access === "answer"
    ? { ...boundary, capability: access, release: { mode: "unreviewed" } }
    : { ...boundary, capability: access };
}

describe("an external agent's context on a filtered level, over OAuth, MCP and REST", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let corpus: FilterCorpus;
  let client: AuthorizedMcpClient;
  let analyticsClient: AuthorizedMcpClient;
  let wholeId: string;
  let excludedId: string;
  let wholeDoc: string;
  let excludedDoc: string;

  const record = (key: string) => [...corpus.records.values()].find((entry) => entry.key === key)!;
  async function fetched(target: AuthorizedMcpClient, id: string): Promise<string> {
    const response = await callDirect(target, "fetch_many", { documents: [{ documentId: id }] });
    expect(response.isError).not.toBe(true);
    return JSON.stringify(response.structuredContent);
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("chat-filters", model);
    await harness.start();
    const whatsapp = await import("@omnesis/provider-whatsapp-synth");
    const store = whatsapp.getWhatsAppWrapsRealController(WHATSAPP)!.provider.getStore();
    const deadline = Date.now() + 30_000;
    while (!store.getChat(CREW)?.rosterComplete) {
      if (Date.now() > deadline) throw new Error("WhatsApp group rosters never arrived");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await harness.triggerSyncAndWait(WHATSAPP, 60_000);
    await harness.triggerSyncAndWait(WHATSAPP, 60_000);
    corpus = readFilterCorpus(harness, WHATSAPP, {
      describe: (row) => {
        const day = DAYS[row.external_id];
        return day ? { key: day[0], body: day[1] } : null;
      },
    });

    const reader = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    const owner = reader
      .prepare<[string], { device_id: string; provider_id: string }>(
        `SELECT s.device_id, d.provider_id FROM sources s JOIN documents d ON d.source_id = s.id
          WHERE s.id = ? LIMIT 1`,
      )
      .get(WHATSAPP)!;
    reader.close();
    for (const account of ["filter-whole-invented", "filter-excluded-invented"])
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "whatsapp-messages",
          accountId: account,
          deviceId: owner.device_id,
          enabled: false,
        }),
      });
    wholeId = "whatsapp-messages:filter-whole-invented";
    excludedId = "whatsapp-messages:filter-excluded-invented";
    await harness.pushDocuments(
      [wholeId, excludedId].map((sourceId, index) => ({
        sourceId,
        providerId: owner.provider_id,
        externalId: `context-sibling-${index}`,
        title: "Invented sibling observation",
        content: `SIBLING_CONTEXT_${index} invented observations zqfilter`,
        documentType: "conversation",
        metadata: { extra: { chatName: "Invented sibling" } },
      })),
    );
    for (const [kind, sourceId] of [
      ["filtered", WHATSAPP],
      ["whole", wholeId],
      ["excluded", excludedId],
    ] as const)
      await harness.pushAnalyticsRow(
        TABLES[kind],
        { sample_id: "invented-sample", amount: kind === "whole" ? 7 : 99 },
        { sourceId, primaryKey: ["sample_id"] },
      );
    for (const [index, accountId] of ["filter-analytics-one", "filter-analytics-two"].entries()) {
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "apple-imessage",
          accountId,
          deviceId: owner.device_id,
          enabled: false,
        }),
      });
      await harness.pushAnalyticsRow(
        TABLES.sharedWhole,
        { sample_id: `invented-${index}`, amount: index === 0 ? 11 : 13 },
        { sourceId: `apple-imessage:${accountId}`, primaryKey: ["sample_id"] },
      );
    }
    for (const [index, sourceId] of [WHATSAPP, wholeId].entries())
      await harness.pushAnalyticsRow(
        TABLES.sharedFiltered,
        { sample_id: `invented-${index}`, amount: index === 0 ? 101 : 103 },
        { sourceId, primaryKey: ["sample_id"] },
      );
    await harness.gatewayJson("/admin/instructions", {
      method: "PUT",
      body: JSON.stringify({ content: INSTRUCTION }),
    });
    // Facts and wiki pages are stored while the gateway is stopped; every
    // read below goes through the real prompt builder, OAuth, tools and
    // release path.
    await harness.restartGateway({
      whileStopped: () => {
        const db = new SqliteDatabase(harness.getDbPath());
        try {
          let self = db
            .prepare<[], { id: string }>("SELECT id FROM people WHERE is_self=1 LIMIT 1")
            .get()?.id;
          if (!self) {
            self = "filter-context-self";
            db.prepare(
              "INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at) VALUES(?,'Fictional owner','fixture',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
            ).run(self);
          }
          const shared = record("crew-1").id;
          const withheld = record("direct").id;
          for (const [claim, evidence, additional] of [
            [VISIBLE, shared, undefined],
            [HIDDEN, withheld, undefined],
            [MIXED, shared, withheld],
            [MISSING, "missing-filter-evidence", undefined],
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
                createdByRun: "filter-context-fixture",
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
            "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES('filter-context-root','root',?,?,?,1,1,'fictional-hash','current','{}','{}',?,?)",
          ).run(WIKI, WIKI, WIKI, Date.now(), Date.now());
          db.prepare(
            "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES('filter-context-wiki','wiki',?,?,?,1,1,'fictional-wiki-hash','current','{}','{}',?,?)",
          ).run(DIRECTORY, DIRECTORY, DIRECTORY, Date.now(), Date.now());
          db.prepare(
            "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at) VALUES('filter-context-wiki-doc','system','brain-knowledge','filter-context-wiki',?,?,?,?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
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
      grantName: "All sources with one filter",
      credentialLabel: "Shared analytics credential",
      capabilities: ["direct", "answer"],
      rules: [filteredRule("direct"), filteredRule("answer")],
    });
    client = await authorizeMcpClient(harness, {
      principalName: "Invented context client",
      grantName: "Filtered context boundary",
      credentialLabel: "Context credential",
      capabilities: ["direct", "answer"],
      rules: (["direct", "answer"] as const).map((access) =>
        filteredRule(access, { mode: "denylist", sourceIds: [excludedId] }),
      ),
    });
  }, 300_000);

  afterAll(async () => {
    await closeConnection(analyticsClient);
    await closeConnection(client);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("analytics of a filtered or excluded account are absent from discovery and refused; a whole sibling's are kept", async () => {
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

  test("a table only whole accounts write to is kept under an all-sources level with a filter, and one a filtered account writes to is refused", async () => {
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
    const probe = model.register({
      sourceId: WHATSAPP,
      documentIds: [record("crew-1").id],
      query: corpus.query,
      sqlQueries: [
        `SELECT sum(amount) FROM ${TABLES.sharedWhole}`,
        `SELECT sum(amount) FROM ${TABLES.sharedFiltered}`,
      ],
    });
    await askFiltered(analyticsClient, probe.question);
    expect(JSON.stringify(probe.observed.sqlResults?.[0])).toContain("24");
    expect(JSON.stringify(probe.observed.sqlResults?.[1])).toContain("sql_not_permitted");
    expect(JSON.stringify(probe.observed.sqlResults?.[1])).not.toContain("204");
  }, 60_000);

  test("the source boundary applies before the filter, and a whole sibling is not suppressed", async () => {
    expect(await fetched(client, wholeDoc)).toContain("SIBLING_CONTEXT_0");
    expect(await fetched(client, excludedDoc)).not.toContain("SIBLING_CONTEXT_1");
    expect(await fetched(client, record("crew-2").id)).toContain(record("crew-2").body);
    expect(await fetched(client, record("direct").id)).not.toContain(record("direct").body);
    const denied = await callDirect(client, "search_many", {
      queries: [{ query: "SIBLING_CONTEXT", filters: { sourceIds: [excludedId] }, limit: 1 }],
    });
    expect(JSON.stringify(denied)).not.toContain("SIBLING_CONTEXT_1");
    expect(JSON.stringify(denied.structuredContent)).not.toContain(excludedDoc);
  });

  test("Answer is given only facts whose every piece of evidence it can read, the standing instructions, no wiki page and no cross-account tool", async () => {
    const probe = model.register({
      sourceId: WHATSAPP,
      documentIds: [
        ...[...corpus.records.values()].map((entry) => entry.id),
        wholeDoc,
        excludedDoc,
      ],
      query: corpus.query,
      sqlQueries: [
        `SELECT sum(amount) FROM ${TABLES.whole}`,
        `SELECT sum(amount) FROM ${TABLES.filtered}`,
        `SELECT sum(amount) FROM ${TABLES.excluded}`,
      ],
    });
    const answer = await askFiltered(client, probe.question);
    expect(answer.answer).toContain("SIBLING_CONTEXT_0");
    expect(answer.answer).not.toContain("SIBLING_CONTEXT_1");
    for (const entry of corpus.records.values())
      if (SHARED.includes(entry.key)) expect(answer.answer).toContain(entry.body);
      else expect(answer.answer).not.toContain(entry.body);
    const prompts = probe.observed.modelInputs.join("\n");
    expect(prompts).toContain(VISIBLE);
    expect(prompts).toContain(INSTRUCTION);
    for (const canary of [HIDDEN, MIXED, MISSING, WIKI, DIRECTORY])
      expect(prompts).not.toContain(canary);
    expect(probe.observed.toolNames).toContain("run_sql");
    for (const unsafe of [...CROSS_ACCOUNT_TOOLS, "knowledge_fetch", "knowledge_search"])
      expect(probe.observed.toolNames).not.toContain(unsafe);
    expect(probe.observed.sqlResults).toHaveLength(3);
    expect(JSON.stringify(probe.observed.sqlResults?.[0])).toContain("7");
    for (const result of probe.observed.sqlResults!.slice(1)) {
      expect(JSON.stringify(result)).toContain("sql_not_permitted");
      expect(JSON.stringify(result)).not.toContain("99");
    }
    const manifest = await client.client.listTools();
    for (const unsafe of CROSS_ACCOUNT_TOOLS) {
      expect(manifest.tools.map((tool) => tool.name)).not.toContain(unsafe);
      await expect(client.client.callTool({ name: unsafe, arguments: {} })).rejects.toThrow(
        /not found/,
      );
    }
  }, 60_000);

  test("a paired REST integration on the level answers within the same boundary", async () => {
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
      sourceId: WHATSAPP,
      documentIds: [
        ...[...corpus.records.values()].map((entry) => entry.id),
        wholeDoc,
        excludedDoc,
      ],
      query: corpus.query,
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
      attempt < 300 && ["queued", "running"].includes(result.status);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await fetch(statusUrl, { headers });
      expect(status.status).toBe(200);
      result = (await status.json()) as typeof result;
    }
    expect(result.status).toMatch(/^released/);
    for (const entry of corpus.records.values())
      if (SHARED.includes(entry.key)) expect(result.answer).toContain(entry.body);
      else {
        expect(result.answer).not.toContain(entry.body);
        expect(JSON.stringify(probe.observed.fetched)).not.toContain(entry.body);
        expect(probe.observed.modelInputs.join("\n")).not.toContain(entry.body);
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
