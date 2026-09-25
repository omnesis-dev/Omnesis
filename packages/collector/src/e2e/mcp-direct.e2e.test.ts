// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  authorizeMcpClient,
  revokeAccess,
  updateAccessGrant,
  type AuthorizedMcpClient,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const STABLE_DIRECT_TOOL_NAMES = [
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "lookup_people",
  "trace_connections",
  "run_sql",
] as const;

const DIRECT_TOOL_NAMES = [
  ...STABLE_DIRECT_TOOL_NAMES,
  "temporal_query",
  "entity_context",
  "search_loops",
  "list_loops",
  "fetch_loop",
] as const;

describe("Direct MCP OAuth — synthetic-corpus gateway", () => {
  let harness: SyntheticE2EHarness;
  let knownDocumentId: string;
  let allowedSourceId: string;
  let deniedDocumentId: string;
  let deniedSourceId: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
    });
    await harness.start();
    await harness.syncAllSources();
    await harness.refreshSearchSnapshot();
    const known = await harness.gatewayJson<{ results: Array<{ id: string }> }>(
      "/documents/search?q=Globex&limit=1",
    );
    if (!known.results[0]) throw new Error("Synthetic Direct fixture document was not indexed");
    knownDocumentId = known.results[0].id;
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const allowed = db
        .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
        .get(knownDocumentId);
      if (!allowed) throw new Error("Synthetic Direct fixture source was not indexed");
      allowedSourceId = allowed.source_id;
      const denied = db
        .prepare<[string], { id: string; source_id: string }>(
          `SELECT id, source_id FROM documents
           WHERE source_id <> ? AND (title LIKE '%Globex%' OR content LIKE '%Globex%')
           ORDER BY source_id, id LIMIT 1`,
        )
        .get(allowedSourceId);
      if (!denied)
        throw new Error("Synthetic Direct fixture needs Globex documents in two sources");
      deniedDocumentId = denied.id;
      deniedSourceId = denied.source_id;
    } finally {
      db.close();
    }
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("retires the exact legacy stdio bearer without touching another CLI credential", async () => {
    const legacyPairing = await harness.gatewayJson<{ pairingCode: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Fictional retired MCP bridge",
          kind: "cli",
          scopes: ["read"],
        }),
      },
    );
    const legacy = await harness.gatewayJson<{ token: string }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({ pairingCode: legacyPairing.pairingCode }),
    });
    const operationalPairing = await harness.gatewayJson<{ pairingCode: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Fictional operational CLI",
          kind: "cli",
          scopes: ["admin", "read"],
        }),
      },
    );
    const operational = await harness.gatewayJson<{ token: string }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({ pairingCode: operationalPairing.pairingCode }),
    });
    const withBearer = (token: string, method = "GET") =>
      fetch(`${harness.gatewayUrl}${method === "POST" ? "/legacy-mcp/revoke" : "/whoami"}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

    expect((await withBearer(legacy.token)).status).toBe(200);
    const retired = await withBearer(legacy.token, "POST");
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({ revoked: true });
    expect((await withBearer(legacy.token)).status).toBe(401);

    expect((await withBearer(operational.token, "POST")).status).toBe(401);
    expect((await withBearer(operational.token)).status).toBe(200);
  }, 30_000);

  test("authorizes with DCR and PKCE, invokes Direct tools, and enforces credential revocation", async () => {
    const authorized = await oauthClient({
      principalName: "Direct retrieval assistant",
      grantName: "Direct corpus access",
      credentialLabel: "Fictional desktop client",
      capabilities: ["direct"],
    });
    try {
      expect(authorized.provider.authorizationUrl).toMatchObject({
        pathname: "/oauth/authorize",
      });
      expect(authorized.provider.authorizationUrl?.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorized.provider.savedClientInformation?.client_id).toMatch(/^omn_oc_/);
      expect(authorized.provider.savedTokens).toMatchObject({
        access_token: expect.stringMatching(/^omn_oat_/),
        refresh_token: expect.stringMatching(/^omn_ort_/),
        scope: "omnesis:access offline_access",
      });
      expect(authorized.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const instructions = authorized.client.getInstructions();
      expect(instructions).toContain("bypasses Omnesis privacy review");
      expect(instructions).toContain("`apple_calendar_events`");
      expect(instructions).not.toContain("john.smith@example.com");

      const listed = await authorized.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(STABLE_DIRECT_TOOL_NAMES);
      const schemas = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
      expect(schemas.get("fetch_many")?.required).toContain("documents");
      expect(schemas.get("lookup_document_by_url")?.required).toContain("url");
      expect(schemas.get("lookup_people")?.required).toContain("query");
      expect(schemas.get("trace_connections")?.required).toContain("seedIds");
      expect(schemas.get("run_sql")?.required).toContain("sql");

      const searched = await authorized.client.callTool({
        name: "search_many",
        arguments: { queries: [{ query: "Globex integration kickoff", limit: 3 }] },
      });
      expect(searched.isError).not.toBe(true);
      const searchResult = searched.structuredContent as {
        kind: string;
        items: Array<{ kind: string; results?: Array<{ documentId: string }> }>;
      };
      expect(searchResult.kind).toBe("search.batch");
      expect(searchResult.items[0]?.kind).not.toBe("error");

      const fetched = await authorized.client.callTool({
        name: "fetch_many",
        arguments: { documents: [{ documentId: knownDocumentId }] },
      });
      expect(fetched.isError).not.toBe(true);
      expect(fetched.structuredContent).toMatchObject({ kind: "document.batch" });

      const rawCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
        {
          name: "lookup_document_by_url",
          arguments: { url: "https://example.com/fictional-missing-document" },
        },
        { name: "lookup_people", arguments: { query: "Fictional No Match", limit: 1 } },
        {
          name: "trace_connections",
          arguments: { seedIds: [knownDocumentId], depth: 1, fanoutCap: 2 },
        },
      ];
      for (const call of rawCalls) {
        const result = await authorized.client.callTool(call);
        expect(result.isError, `${call.name} should accept its real schema`).not.toBe(true);
      }

      const sql = await authorized.client.callTool({
        name: "run_sql",
        arguments: { sql: "SELECT 1 AS value", maxRows: 10 },
      });
      expect(sql.isError).not.toBe(true);
      expect(sql.structuredContent).toMatchObject({
        kind: "sql.rows",
        columns: ["value"],
        rows: [[1]],
      });

      const operational = await authorized.client.callTool({
        name: "run_sql",
        arguments: { sql: "SELECT * FROM tokens", maxRows: 10 },
      });
      expect(operational.isError).toBe(true);
      expect(operational.structuredContent).toEqual({
        kind: "error",
        code: "sql_failed",
        message: "The read-only SQL query failed.",
      });
      expect(JSON.stringify(operational)).not.toContain("Catalog Error");

      const abort = new AbortController();
      const cancelled = authorized.client.callTool(
        {
          name: "run_sql",
          arguments: {
            sql: "SELECT sum(a.i * b.i) FROM range(0, 1000000) a(i), range(0, 1000000) b(i)",
            maxRows: 1,
          },
        },
        { signal: abort.signal },
      );
      setTimeout(() => abort.abort(), 150);
      await expect(cancelled).rejects.toBeDefined();

      // The client observes its abort before DuckDB necessarily finishes
      // interrupting the query. The durable audit is written only after the
      // execution lease has settled, so wait for it before testing parallel
      // reuse of the two-slot Direct boundary.
      const settledCancellationAudit = await waitForAuditOutcomes(
        harness.getDbPath(),
        authorized.credentialId,
        ["cancelled"],
      );
      expect(settledCancellationAudit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "direct",
            tool: "run_sql",
            outcome: "cancelled",
          }),
        ]),
      );

      const afterCancellation = await Promise.all(
        [2, 3].map((value) =>
          authorized.client.callTool({
            name: "run_sql",
            arguments: { sql: `SELECT ${value} AS value`, maxRows: 1 },
          }),
        ),
      );
      expect(afterCancellation).toEqual([
        expect.objectContaining({
          structuredContent: expect.objectContaining({
            kind: "sql.rows",
            columns: ["value"],
            rows: [[2]],
          }),
        }),
        expect.objectContaining({
          structuredContent: expect.objectContaining({
            kind: "sql.rows",
            columns: ["value"],
            rows: [[3]],
          }),
        }),
      ]);

      const audit = await waitForAuditOutcomes(harness.getDbPath(), authorized.credentialId, [
        "cancelled",
        "refused",
      ]);
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "direct",
            tool: "search_many",
            outcome: "ok",
            sourceMode: "all",
          }),
          expect.objectContaining({
            capability: "direct",
            tool: "run_sql",
            outcome: "refused",
          }),
          expect.objectContaining({
            capability: "direct",
            tool: "run_sql",
            outcome: "cancelled",
          }),
        ]),
      );

      await revokeAccess(harness.gatewayUrl, authorized.portal, {
        kind: "credential",
        id: authorized.credentialId,
      });
      await expect(
        authorized.client.listTools(undefined, { cacheMode: "refresh" }),
      ).rejects.toBeDefined();
      expect(authorized.provider.savedTokens).toBeUndefined();
    } finally {
      await closeAuthorized(authorized);
    }
  }, 90_000);

  test("exposes the experimental Direct extensions only in experimental mode", async () => {
    let authorized: AuthorizedMcpClient | undefined;
    try {
      await harness.restartGateway({ gatewayMode: "experimental" });
      authorized = await oauthClient({
        principalName: "Experimental retrieval assistant",
        grantName: "Experimental retrieval access",
        credentialLabel: "Fictional experimental desktop",
        capabilities: ["direct"],
      });

      const listed = await authorized.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(DIRECT_TOOL_NAMES);
      const schemas = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
      expect(schemas.get("entity_context")?.required).toEqual(
        expect.arrayContaining(["kind", "id"]),
      );
      expect(schemas.get("search_loops")?.required).toContain("query");
      expect(schemas.get("fetch_loop")?.required).toContain("loopId");

      const experimentalCalls: Array<{
        name: string;
        arguments: Record<string, unknown>;
      }> = [
        {
          name: "temporal_query",
          arguments: { from: "2025-01-01", to: "2025-01-02", limit: 1 },
        },
        {
          name: "entity_context",
          arguments: { kind: "document", id: knownDocumentId, depth: 1 },
        },
        { name: "search_loops", arguments: { query: "fictional no match", limit: 1 } },
        { name: "list_loops", arguments: { limit: 1 } },
        { name: "fetch_loop", arguments: { loopId: "loop_fictional_missing" } },
      ];
      for (const call of experimentalCalls) {
        const result = await authorized.client.callTool(call);
        expect(result.isError, `${call.name} should accept its real schema`).not.toBe(true);
      }
    } finally {
      try {
        if (authorized) await closeAuthorized(authorized);
      } finally {
        await harness.restartGateway({ gatewayMode: "stable" });
      }
    }
  }, 120_000);

  test("enforces stable source rules and refreshes the same OAuth client onto a live grant edit", async () => {
    const authorized = await oauthClient({
      principalName: "Scoped research assistant",
      grantName: "Scoped source access",
      credentialLabel: "Fictional scoped desktop",
      capabilities: ["direct"],
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: [allowedSourceId] },
        },
      ],
    });
    const clientId = authorized.provider.savedClientInformation?.client_id;
    const firstAccessToken = authorized.provider.savedTokens?.access_token;
    try {
      expect(clientId).toMatch(/^omn_oc_/);
      expect(authorized.provider.authorizationRedirects).toBe(1);
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "search_many",
        "fetch_many",
        "lookup_document_by_url",
        "run_sql",
      ]);
      expect(authorized.client.getInstructions()).toContain(
        "restricted to selected source instances",
      );
      expect(authorized.client.getInstructions()).toContain("sql_not_permitted");

      const allowedFetch = await fetchDocument(authorized, knownDocumentId);
      expect(allowedFetch.items[0]).toMatchObject({ kind: "document" });
      const deniedFetch = await fetchDocument(authorized, deniedDocumentId);
      expect(deniedFetch.items[0]).toMatchObject({ kind: "error" });
      const deniedSearch = await searchSource(authorized, deniedSourceId);
      expect(deniedSearch.items[0]).toMatchObject({ kind: "search.results", results: [] });
      expect(JSON.stringify(deniedSearch)).not.toContain(deniedDocumentId);

      expect(storedDirectRule(harness.getDbPath(), authorized.grantId)).toEqual({
        sourceMode: "allowlist",
        sourceIds: [allowedSourceId],
      });
      const nextRevision = await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        authorized.grantRevision,
        [
          {
            capability: "direct",
            sources: { mode: "denylist", sourceIds: [allowedSourceId] },
          },
        ],
      );
      expect(nextRevision).toBe(authorized.grantRevision + 1);

      expect(
        (await authorized.client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["search_many", "fetch_many", "lookup_document_by_url", "run_sql"]);
      expect(authorized.provider.savedTokens?.access_token).not.toBe(firstAccessToken);
      expect(authorized.provider.savedClientInformation?.client_id).toBe(clientId);
      expect(authorized.provider.authorizationRedirects).toBe(1);

      const nowDeniedFetch = await fetchDocument(authorized, knownDocumentId);
      expect(nowDeniedFetch.items[0]).toMatchObject({ kind: "error" });
      const nowAllowedFetch = await fetchDocument(authorized, deniedDocumentId);
      expect(nowAllowedFetch.items[0]).toMatchObject({ kind: "document" });
      const nowDeniedSearch = await searchSource(authorized, allowedSourceId);
      expect(nowDeniedSearch.items[0]).toMatchObject({ kind: "search.results", results: [] });
      expect(JSON.stringify(nowDeniedSearch)).not.toContain(knownDocumentId);

      expect(storedDirectRule(harness.getDbPath(), authorized.grantId)).toEqual({
        sourceMode: "denylist",
        sourceIds: [allowedSourceId],
      });
      const audits = await waitForCredentialAudits(harness.getDbPath(), authorized.credentialId, 6);
      const revisionOneTokenId = accessTokenId(harness.getDbPath(), authorized.credentialId, 1);
      const revisionTwoTokenId = accessTokenId(harness.getDbPath(), authorized.credentialId, 2);
      expect(
        audits.map(({ detail, ...row }) => ({
          ...row,
          detail: withoutRequestId(detail),
        })),
      ).toEqual([
        invocationAudit(authorized, 1, revisionOneTokenId, "fetch_many", "allowlist"),
        invocationAudit(authorized, 1, revisionOneTokenId, "fetch_many", "allowlist"),
        invocationAudit(authorized, 1, revisionOneTokenId, "search_many", "allowlist"),
        invocationAudit(authorized, 2, revisionTwoTokenId, "fetch_many", "denylist"),
        invocationAudit(authorized, 2, revisionTwoTokenId, "fetch_many", "denylist"),
        invocationAudit(authorized, 2, revisionTwoTokenId, "search_many", "denylist"),
      ]);
      expect(grantUpdateAudit(harness.getDbPath(), authorized.grantId)).toMatchObject({
        eventType: "grant-updated",
        principalId: authorized.principalId,
        grantId: authorized.grantId,
        grantRevision: nextRevision,
        credentialId: null,
        oauthClientId: null,
        detail: {
          rules: [
            {
              capability: "direct",
              sourceMode: "denylist",
              sourceIds: [allowedSourceId],
              releaseMode: null,
              policyFamilyId: null,
            },
          ],
        },
      });
    } finally {
      await closeAuthorized(authorized);
    }
  }, 90_000);

  test("scopes run_sql to the grant's permitted sources", async () => {
    // Both sides of the gate derive from one live catalog table, so
    // neither side can pass vacuously no matter how many analytics
    // sources the universe syncs: the allowlist grant names the table's
    // own source, the denylist grant excludes exactly it. (The stable
    // default universe's catalog is non-empty — the first test's
    // `apple_calendar_events` assertion pins that.)
    let allowed: AuthorizedMcpClient | undefined;
    let denied: AuthorizedMcpClient | undefined;
    try {
      const runSql = (client: AuthorizedMcpClient["client"], sql: string) =>
        client.callTool({ name: "run_sql", arguments: { sql, maxRows: 5 } });
      // The operator catalog names each table's owning source. (The
      // registry table itself is invisible to run_sql by design — it
      // lives outside the attached analytics store.)
      const catalog = (await harness.gatewayJson("/analytics/catalog")) as {
        tables: Array<{ tableName: string; sourceId: string }>;
      };
      const entries = [...catalog.tables].sort((a, b) => a.tableName.localeCompare(b.tableName));
      // The instructions renderer only advertises safe identifiers, so
      // mirror assertions below use a table it can name.
      const named = entries.filter(({ tableName }) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName));
      expect(named.length).toBeGreaterThan(0);
      const { tableName: table, sourceId: source } = named[0]!;
      const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
      const tableSql = `SELECT * FROM ${quote(table)} LIMIT 1`;

      allowed = await oauthClient({
        principalName: "Scoped SQL assistant",
        grantName: "Scoped SQL access",
        credentialLabel: "Fictional scoped SQL desktop",
        capabilities: ["direct"],
        rules: [
          {
            capability: "direct",
            sources: { mode: "allowlist", sourceIds: [source] },
          },
        ],
      });
      denied = await oauthClient({
        principalName: "Denied SQL assistant",
        grantName: "Denied SQL access",
        credentialLabel: "Fictional denied SQL desktop",
        capabilities: ["direct"],
        rules: [
          {
            capability: "direct",
            sources: { mode: "denylist", sourceIds: [source] },
          },
        ],
      });
      for (const client of [allowed, denied]) {
        expect((await client.client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "search_many",
          "fetch_many",
          "lookup_document_by_url",
          "run_sql",
        ]);
      }
      const allowedInstructions = allowed.client.getInstructions();
      expect(allowedInstructions).toContain("sql_not_permitted");
      expect(allowedInstructions).toContain(`\`${table}\``);
      expect(denied.client.getInstructions()).not.toContain(`\`${table}\``);

      // A table-less query carries no source surface and runs under both grants.
      for (const client of [allowed, denied]) {
        const bare = await runSql(client.client, "SELECT 1 AS value");
        expect(bare.isError).not.toBe(true);
        expect(bare.structuredContent).toMatchObject({ kind: "sql.rows", rows: [[1]] });
      }

      // The same real table succeeds under the grant naming its source …
      const rows = await runSql(allowed.client, tableSql);
      expect(rows.isError, table).not.toBe(true);
      expect(rows.structuredContent).toMatchObject({ kind: "sql.rows" });

      // … and is refused under the grant excluding it, naming the table.
      const refused = await runSql(denied.client, tableSql);
      expect(refused.isError, table).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        kind: "error",
        code: "sql_not_permitted",
      });
      expect(JSON.stringify(refused.structuredContent)).toContain(table);

      // Schema introspection is refused naming the schema, not failed opaquely.
      const snooped = await runSql(denied.client, "SELECT * FROM information_schema.tables");
      expect(snooped.isError).toBe(true);
      expect(snooped.structuredContent).toEqual({
        kind: "error",
        code: "sql_not_permitted",
        message: expect.stringContaining("information_schema.tables"),
      });

      // A bare SHOW would dump every table name with no FROM to gate.
      const shown = await runSql(denied.client, "SELECT * FROM (SHOW TABLES) AS s");
      expect(shown.isError).toBe(true);
      expect(shown.structuredContent).toMatchObject({
        kind: "error",
        code: "sql_not_permitted",
      });

      // Table functions are refused live too, naming the function through
      // the MCP sanitizer.
      const generated = await runSql(denied.client, "SELECT * FROM range(3) AS r(n)");
      expect(generated.isError).toBe(true);
      expect(generated.structuredContent).toEqual({
        kind: "error",
        code: "sql_not_permitted",
        message: expect.stringContaining("range"),
      });
    } finally {
      if (allowed) await closeAuthorized(allowed);
      if (denied) await closeAuthorized(denied);
    }
  }, 150_000);

  test("a denylist never serves a gateway-authored document, which no rule can name", async () => {
    // An agent transcript and an open-loop mirror are written by the gateway
    // itself under source ids with no `sources` row, so no rule can list them.
    // They are seeded the way the gateway writes them, in the shared WAL.
    const seeded = seedGatewayAuthoredDocuments(harness.getDbPath());
    const authorized = await oauthClient({
      principalName: "Denylist research assistant",
      grantName: "Denylist source access",
      credentialLabel: "Fictional denylist desktop",
      capabilities: ["direct"],
      rules: [
        {
          capability: "direct",
          sources: { mode: "denylist", sourceIds: [deniedSourceId] },
        },
      ],
    });
    try {
      const allowedFetch = await fetchDocument(authorized, knownDocumentId);
      expect(allowedFetch.items[0]).toMatchObject({ kind: "document" });
      for (const document of seeded) {
        const fetched = await fetchDocument(authorized, document.id);
        expect(fetched.items[0]).toMatchObject({ kind: "error" });
        expect(JSON.stringify(fetched)).not.toContain(document.canary);
        const lookedUp = await authorized.client.callTool({
          name: "lookup_document_by_url",
          arguments: { url: document.url },
        });
        expect(lookedUp.isError).not.toBe(true);
        const payload = JSON.stringify(lookedUp.structuredContent);
        expect(payload).not.toContain(document.id);
        expect(payload).not.toContain(document.canary);
      }
    } finally {
      await closeAuthorized(authorized);
    }
  }, 90_000);

  test("fences an in-flight Direct result when its grant revision changes", async () => {
    const authorized = await oauthClient({
      principalName: "Revision-fenced Direct assistant",
      grantName: "Revision-fenced Direct access",
      credentialLabel: "Direct revision-race fixture client",
      capabilities: ["direct"],
    });
    try {
      const invocation = authorized.client.callTool({
        name: "run_sql",
        arguments: {
          sql: "SELECT sum(a.i * b.i) AS total FROM range(0, 50000) a(i), range(0, 50000) b(i)",
          maxRows: 1,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        authorized.grantRevision,
        [
          {
            capability: "direct",
            sources: { mode: "allowlist", sourceIds: [allowedSourceId] },
          },
        ],
      );

      const result = await invocation;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sql.rows");
    } finally {
      await closeAuthorized(authorized);
    }
  }, 90_000);

  test("expands one Answer grant to both capabilities without reauthorization, contracts it, and enforces revocation", async () => {
    const authorized = await oauthClient({
      principalName: "Combined research assistant",
      grantName: "Direct and privacy-reviewed access",
      credentialLabel: "Fictional combined client",
      capabilities: ["answer"],
    });
    try {
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
      const answerOnlyToken = authorized.provider.savedTokens?.access_token;
      const expandedRevision = await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        authorized.grantRevision,
        [
          { capability: "direct", sources: { mode: "all", sourceIds: [] } },
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
      );
      expect(
        (await authorized.client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["ask_omnesis", "get_answer_status", ...STABLE_DIRECT_TOOL_NAMES]);
      expect(authorized.provider.savedTokens?.access_token).not.toBe(answerOnlyToken);
      expect(authorized.provider.authorizationRedirects).toBe(1);
      expect(
        (
          await authorized.client.callTool({
            name: "run_sql",
            arguments: { sql: "SELECT 7 AS value", maxRows: 1 },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (
          await authorized.client.callTool({
            name: "ask_omnesis",
            arguments: {
              question: "What is the fictional project status?",
              requestId: "combined-capability-e2e",
            },
          })
        ).isError,
      ).not.toBe(true);

      const combinedAccessToken = authorized.provider.savedTokens?.access_token;
      await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        expandedRevision,
        [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
      );
      expect(
        (await authorized.client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["ask_omnesis", "get_answer_status"]);
      expect(authorized.provider.savedTokens?.access_token).not.toBe(combinedAccessToken);
      expect(authorized.provider.authorizationRedirects).toBe(1);

      await revokeAccess(harness.gatewayUrl, authorized.portal, {
        kind: "grant",
        id: authorized.grantId,
      });
      await expect(
        authorized.client.listTools(undefined, { cacheMode: "refresh" }),
      ).rejects.toBeDefined();
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  function oauthClient(
    input: Parameters<typeof authorizeMcpClient>[1],
  ): Promise<AuthorizedMcpClient> {
    return authorizeMcpClient({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey }, input);
  }
});

/**
 * One agent transcript and one open-loop mirror, inserted as the gateway's
 * own writers insert them: provider `system`, a source id with no `sources`
 * row, and a source URL the lookup tool can resolve.
 */
function seedGatewayAuthoredDocuments(
  dbPath: string,
): Array<{ id: string; url: string; canary: string }> {
  const seeds = [
    {
      id: `e2e-transcript-${Date.now()}`,
      sourceId: "omnesis-chat",
      url: "https://example.org/omnesis/transcript",
      canary: "TRANSCRIPT_CANARY_SYNTHESIS",
    },
    {
      id: `e2e-loop-${Date.now()}`,
      sourceId: "open-loops",
      url: "https://example.org/omnesis/loop",
      canary: "LOOP_MIRROR_CANARY",
    },
  ];
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash, metadata,
          source_url, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'system', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const seed of seeds) {
      insert.run(
        seed.id,
        seed.sourceId,
        seed.id,
        "Gateway-authored fixture",
        `Body carrying ${seed.canary}.`,
        `hash-${seed.id}`,
        seed.url,
        now,
        now,
        now,
        now,
      );
    }
  } finally {
    db.close();
  }
  return seeds.map(({ id, url, canary }) => ({ id, url, canary }));
}

async function closeAuthorized(authorized: AuthorizedMcpClient): Promise<void> {
  const outcomes = await Promise.allSettled([
    authorized.client.close(),
    authorized.transport.close(),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
}

async function waitForAuditOutcomes(
  dbPath: string,
  credentialId: string,
  outcomes: string[],
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const db = new Database(dbPath, { readonly: true });
    let details: Array<Record<string, unknown>>;
    try {
      details = db
        .prepare<[string], { detail: string }>(
          `SELECT detail FROM access_audit_events
           WHERE event_type = 'mcp-tool-invoked' AND credential_id = ?
           ORDER BY occurred_at, id`,
        )
        .all(credentialId)
        .map((row) => JSON.parse(row.detail) as Record<string, unknown>);
    } finally {
      db.close();
    }
    if (outcomes.every((outcome) => details.some((detail) => detail.outcome === outcome))) {
      return details;
    }
    if (Date.now() >= deadline) return details;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fetchDocument(
  authorized: AuthorizedMcpClient,
  documentId: string,
): Promise<{ items: Array<{ kind: string }> }> {
  const response = await authorized.client.callTool({
    name: "fetch_many",
    arguments: { documents: [{ documentId }] },
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as { items: Array<{ kind: string }> };
}

async function searchSource(
  authorized: AuthorizedMcpClient,
  sourceId: string,
): Promise<{ items: Array<{ kind: string; results?: unknown[] }> }> {
  const response = await authorized.client.callTool({
    name: "search_many",
    arguments: {
      queries: [{ query: "Globex", filters: { sourceIds: [sourceId] }, limit: 10 }],
    },
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as {
    items: Array<{ kind: string; results?: unknown[] }>;
  };
}

function storedDirectRule(
  dbPath: string,
  grantId: string,
): { sourceMode: string; sourceIds: string[] } | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare<[string], { source_mode: string; source_ids: string }>(
        `SELECT source_mode, source_ids FROM access_grant_capabilities
         WHERE grant_id = ? AND capability = 'direct'`,
      )
      .get(grantId);
    return row
      ? { sourceMode: row.source_mode, sourceIds: JSON.parse(row.source_ids) as string[] }
      : undefined;
  } finally {
    db.close();
  }
}

interface InvocationAudit {
  eventType: string;
  principalId: string | null;
  grantId: string | null;
  grantRevision: number | null;
  credentialId: string | null;
  oauthClientId: string | null;
  actorTokenId: string | null;
  detail: Record<string, unknown>;
}

async function waitForCredentialAudits(
  dbPath: string,
  credentialId: string,
  expectedCount: number,
): Promise<InvocationAudit[]> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const db = new Database(dbPath, { readonly: true });
    let rows: InvocationAudit[];
    try {
      rows = db
        .prepare<
          [string],
          {
            event_type: string;
            principal_id: string | null;
            grant_id: string | null;
            grant_revision: number | null;
            credential_id: string | null;
            oauth_client_id: string | null;
            actor_token_id: string | null;
            detail: string;
          }
        >(
          `SELECT event_type, principal_id, grant_id, grant_revision,
                  credential_id, oauth_client_id, actor_token_id, detail
           FROM access_audit_events
           WHERE event_type = 'mcp-tool-invoked' AND credential_id = ?
           ORDER BY occurred_at, id`,
        )
        .all(credentialId)
        .map((row) => ({
          eventType: row.event_type,
          principalId: row.principal_id,
          grantId: row.grant_id,
          grantRevision: row.grant_revision,
          credentialId: row.credential_id,
          oauthClientId: row.oauth_client_id,
          actorTokenId: row.actor_token_id,
          detail: JSON.parse(row.detail) as Record<string, unknown>,
        }));
    } finally {
      db.close();
    }
    if (rows.length >= expectedCount || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function withoutRequestId(detail: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = detail;
  return rest;
}

function invocationAudit(
  authorized: AuthorizedMcpClient,
  grantRevision: number,
  actorTokenId: string,
  tool: string,
  sourceMode: "allowlist" | "denylist",
): InvocationAudit {
  return {
    eventType: "mcp-tool-invoked",
    principalId: authorized.principalId,
    grantId: authorized.grantId,
    grantRevision,
    credentialId: authorized.credentialId,
    oauthClientId: authorized.provider.savedClientInformation?.client_id ?? null,
    actorTokenId,
    detail: { capability: "direct", tool, outcome: "ok", sourceMode },
  };
}

function accessTokenId(dbPath: string, credentialId: string, grantRevision: number): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare<[string, number], { id: string }>(
        `SELECT id FROM oauth_access_tokens
          WHERE credential_id = ? AND grant_revision = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(credentialId, grantRevision);
    if (!row) throw new Error(`Missing OAuth access token for grant revision ${grantRevision}.`);
    return row.id;
  } finally {
    db.close();
  }
}

function grantUpdateAudit(dbPath: string, grantId: string): InvocationAudit | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare<
        [string],
        {
          event_type: string;
          principal_id: string | null;
          grant_id: string | null;
          grant_revision: number | null;
          credential_id: string | null;
          oauth_client_id: string | null;
          actor_token_id: string | null;
          detail: string;
        }
      >(
        `SELECT event_type, principal_id, grant_id, grant_revision,
                credential_id, oauth_client_id, actor_token_id, detail
         FROM access_audit_events WHERE event_type = 'grant-updated' AND grant_id = ?`,
      )
      .get(grantId);
    return row
      ? {
          eventType: row.event_type,
          principalId: row.principal_id,
          grantId: row.grant_id,
          grantRevision: row.grant_revision,
          credentialId: row.credential_id,
          oauthClientId: row.oauth_client_id,
          actorTokenId: row.actor_token_id,
          detail: JSON.parse(row.detail) as Record<string, unknown>,
        }
      : undefined;
  } finally {
    db.close();
  }
}
