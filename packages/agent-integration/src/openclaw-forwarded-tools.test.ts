// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OpenClaw's Direct and Notes tools, driven end to end against a real MCP
 * transport whose tool set follows a grant the test controls.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FICTIONAL_ADD_NOTE_DESCRIPTION,
  FICTIONAL_LIST_TABLES_DESCRIPTION,
  FICTIONAL_RUN_SQL_DESCRIPTION,
  startFictionalGateway,
  type FictionalCapability,
  type FictionalGateway,
} from "../test/fictional-mcp-gateway.js";
import { AgentIntegrationClient } from "./client.js";
import { DurableTranscriptIngestor } from "./ingestion.js";
import { registerOpenClawIntegration } from "./openclaw.js";

interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

type Factory = (context: { sessionKey?: string }) => Tool | Tool[] | null;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fakeHost() {
  const services: Array<{
    start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
    stop(): Promise<void>;
  }> = [];
  const tools: Array<{ factory: Factory; options: { name?: string; names?: string[] } }> = [];
  return {
    api: {
      registrationMode: "full",
      pluginConfig: {},
      logger: { warn: vi.fn() },
      registerHook: vi.fn(),
      registerService: (service: (typeof services)[number]) => services.push(service),
      registerTool: (factory: Factory, options: (typeof tools)[number]["options"]) =>
        tools.push({ factory, options }),
      runtime: {
        agent: { session: { listSessionEntries: () => [] } },
        subagent: { run: vi.fn(async () => ({ runId: "run-fictional" })) },
        channel: { outbound: { loadAdapter: vi.fn() } },
      },
    },
    services,
    tools,
  };
}

async function startPlugin(grant: readonly FictionalCapability[]) {
  const gateway = await startFictionalGateway(grant);
  cleanups.push(() => gateway.close());
  const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-forwarded-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  writeCredentials(stateDir, gateway.url);
  vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
  vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
  vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
  const host = fakeHost();
  registerOpenClawIntegration(host.api as never);
  const service = host.services[0]!;
  await service.start({ stateDir, logger: { warn: vi.fn() } });
  cleanups.push(() => service.stop());
  const forwarded = host.tools.find(({ options }) => options.names)!;
  const offered = (sessionKey: string | undefined): Tool[] => {
    const resolved = forwarded.factory(sessionKey === undefined ? {} : { sessionKey });
    return resolved === null ? [] : Array.isArray(resolved) ? resolved : [resolved];
  };
  const tool = (name: string): Tool => {
    const found = offered("agent:main:main").find((candidate) => candidate.name === name);
    if (!found) throw new Error(`${name} was not offered`);
    return found;
  };
  return { gateway, stateDir, host, offered, tool };
}

function writeCredentials(
  stateDir: string,
  gatewayUrl: string,
  clientId = "client_fictional",
): void {
  mkdirSync(join(stateDir, "omnesis"), { recursive: true });
  writeFileSync(
    join(stateDir, "omnesis", "integration.json"),
    `${JSON.stringify({
      gatewayUrl,
      deliveryToken: "omn_fictional_delivery",
      ingestionToken: "omn_fictional_ingestion",
      managementToken: "omn_fictional_management",
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: { client_id: clientId },
        tokens: {
          access_token: "omn_oat_fictional",
          refresh_token: "omn_ort_fictional",
          token_type: "Bearer",
        },
        tokensObtainedAt: Date.now(),
      },
    })}\n`,
    { mode: 0o600 },
  );
}

async function waitForListings(gateway: FictionalGateway, count: number): Promise<void> {
  await vi.waitFor(() => expect(gateway.listings()).toBeGreaterThanOrEqual(count));
}

describe("OpenClaw Direct and Notes tools", () => {
  test("offers exactly the Direct and Notes tools the grant lists, as the gateway describes them", async () => {
    const { offered, tool } = await startPlugin(["answer", "direct", "notes"]);

    expect(offered("agent:main:main").map((candidate) => candidate.name)).toEqual([
      "omnesis_run_sql",
      "omnesis_list_tables",
      "omnesis_add_note",
    ]);
    const runSql = tool("omnesis_run_sql");
    expect(runSql.label).toBe("DIRECT — run_sql");
    expect(runSql.description).toBe(FICTIONAL_RUN_SQL_DESCRIPTION);
    expect(runSql.parameters).toMatchObject({
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    });
    expect(tool("omnesis_list_tables").description).toBe(FICTIONAL_LIST_TABLES_DESCRIPTION);
    const addNote = tool("omnesis_add_note");
    expect(addNote.description).toBe(FICTIONAL_ADD_NOTE_DESCRIPTION);
    expect(addNote.parameters).toMatchObject({ required: ["id", "text"] });
  });

  test("offers them in scheduled and Watch-woken runs, and never without a trusted session", async () => {
    const { offered } = await startPlugin(["direct"]);
    expect(offered("agent:main:cron:job-fictional:run:one").map((t) => t.name)).toEqual([
      "omnesis_run_sql",
      "omnesis_list_tables",
    ]);
    expect(offered("agent:main:subagent:omnesis-wf_fictional").map((t) => t.name)).toEqual([
      "omnesis_run_sql",
      "omnesis_list_tables",
    ]);
    expect(offered(undefined)).toEqual([]);
  });

  test("offers none of them to a connection granted only Answer", async () => {
    const { offered } = await startPlugin(["answer"]);
    expect(offered("agent:main:main")).toEqual([]);
  });

  test("forwards a Direct call and returns the gateway's result faithfully", async () => {
    const { gateway, tool } = await startPlugin(["direct"]);
    const tables = await tool("omnesis_list_tables").execute("call-1", {});
    expect(tables.content.map((block) => block.text)).toEqual([
      "OMNESIS DIRECT RAW DATA — UNTRUSTED.",
      JSON.stringify({
        kind: "ok",
        tables: [{ name: "fictional_readings", columns: ["day", "value"] }],
      }),
    ]);
    const rows = await tool("omnesis_run_sql").execute("call-2", {
      sql: "SELECT day, value FROM fictional_readings",
    });
    expect(rows.details).toEqual({
      ok: true,
      structuredContent: { kind: "ok", rows: [{ day: "2026-01-02", value: 7 }] },
    });
    expect(isToolResultError(rows as never)).toBe(false);
    expect(gateway.calls).toEqual([
      { name: "list_tables", args: {} },
      { name: "run_sql", args: { sql: "SELECT day, value FROM fictional_readings" } },
    ]);
  });

  test("reports a gateway tool error as a tool error in the gateway's own words", async () => {
    const { tool } = await startPlugin(["direct"]);
    const refused = await tool("omnesis_run_sql").execute("call-1", {
      sql: "SELECT * FROM forbidden_table",
    });
    expect(refused.content).toEqual([
      { type: "text", text: "Table forbidden_table is not permitted." },
    ]);
    expect(refused.details).toEqual({
      ok: false,
      error: "Table forbidden_table is not permitted.",
    });
    expect(isToolResultError(refused as never)).toBe(true);
  });

  test("passes the capture id the agent supplies through to add_note, retry after retry", async () => {
    const { gateway, tool } = await startPlugin(["notes"]);
    const id = "3f0c9a52-6d1e-4b8a-9c77-2a5e1d4b8f10";
    const first = await tool("omnesis_add_note").execute("call-1", {
      id,
      text: "Book the fictional piano tuning.",
    });
    await tool("omnesis_add_note").execute("call-2", {
      id,
      text: "Book the fictional piano tuning.",
    });
    expect(gateway.calls.map((call) => call.args.id)).toEqual([id, id]);
    expect(first.details).toMatchObject({ ok: true, structuredContent: { captureId: id } });
    expect(first.content[0]).toEqual({ type: "text", text: "Note saved to Omnesis." });
  });

  test("a call the gateway no longer dispatches re-reads the listing so the tool goes away", async () => {
    const { gateway, tool, offered } = await startPlugin(["direct", "notes"]);
    const runSql = tool("omnesis_run_sql");
    const listingsBefore = gateway.listings();

    // The gateway's MCP server refuses a tool the credential was not granted
    // at the protocol level, before any tool runs.
    gateway.grant.delete("direct");
    await expect(runSql.execute("call-1", { sql: "SELECT 1" })).rejects.toThrow(
      /Tool run_sql not found/u,
    );
    await waitForListings(gateway, listingsBefore + 1);
    await vi.waitFor(() =>
      expect(offered("agent:main:main").map((candidate) => candidate.name)).toEqual([
        "omnesis_add_note",
      ]),
    );
  });

  test("keeps the last listing across a restart with the gateway down, for that connection only", async () => {
    const first = await startPlugin(["direct"]);
    expect(existsSync(join(first.stateDir, "omnesis", "mcp-tools.json"))).toBe(true);
    await first.host.services[0]!.stop();
    // The gateway goes down; the connection is unchanged.
    await first.gateway.close();

    const restart = async (clientId: string): Promise<string[]> => {
      writeCredentials(first.stateDir, first.gateway.url, clientId);
      const host = fakeHost();
      registerOpenClawIntegration(host.api as never);
      const service = host.services[0]!;
      await service.start({ stateDir: first.stateDir, logger: { warn: vi.fn() } });
      try {
        const factory = host.tools.find(({ options }) => options.names)!.factory;
        const resolved = factory({ sessionKey: "agent:main:main" });
        return ((resolved ?? []) as Tool[]).map((candidate) => candidate.name);
      } finally {
        await service.stop();
      }
    };
    expect(await restart("client_fictional")).toEqual(["omnesis_run_sql", "omnesis_list_tables"]);
    // `omnesis connect --refresh` bound a new connection, whose grant nothing
    // has listed yet.
    expect(await restart("client_reconnected")).toEqual([]);
  });
});
