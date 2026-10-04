// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST_EXTENSION_ID } from "@omnesis/extension/scripts/test-manifest";
import { chromium } from "playwright";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { pair, type FetchLike } from "@omnesis/extension";
import stravaProvider from "@omnesis/provider-strava";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { loginPortal } from "./mcp-oauth-helper.js";
import { startDecisionServer, type DecisionServer } from "./brain-bench/decision-server.js";
import {
  startOpenAiServer,
  safeParse,
  userPromptOf,
  type OpenAiServerHandle,
} from "./brain-bench/openai-server.js";

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    body: init.method === "GET" ? undefined : init.body,
  });
  return {
    status: response.status,
    headers: { get: (name) => response.headers.get(name) },
    text: () => response.text(),
  };
};

interface Event {
  type: string;
  payload: Record<string, unknown>;
}
declare const chrome: {
  storage: { local: { set(values: Record<string, unknown>): Promise<void> } };
};

const link = "https://example.org/workshop-guide";
const sourceId = "strava-activities:7000000";

describe("Browser Find agentic destinations through scripted production backends", () => {
  let harness: SyntheticE2EHarness;
  let decision: DecisionServer;
  let puppet: OpenAiServerHandle;
  let readToken: string;
  let browserCredential: Awaited<ReturnType<typeof pair>>;
  let evidenceId = "";
  const tools: string[] = [];
  beforeAll(async () => {
    decision = await startDecisionServer({
      policy: (request) => ({
        route: { type: "choice", choice: "agentic", confidence: 1 },
        reason: {
          type: "choice",
          choice: String((request.state as { query: string }).query).includes("longest")
            ? "calculation"
            : "destination",
        },
      }),
    });
    puppet = await startOpenAiServer({
      modelId: "browser-find-scripted",
      respond: (messages) => {
        const query = userPromptOf(messages);
        const called = messages
          .flatMap((message) => message.tool_calls ?? [])
          .map((call) => call.function.name);
        const emit = (name: string, args: Record<string, unknown>) => {
          tools.push(name);
          return { kind: "tool" as const, name, args };
        };
        if (called.includes("present_browser_results"))
          return { kind: "text", text: "Found the requested destination from its evidence." };
        if (query.includes("longest")) {
          if (!called.includes("run_sql"))
            return emit("run_sql", {
              sql: "SELECT * FROM strava_activities WHERE sport_type = 'Run' ORDER BY distance_m DESC LIMIT 1",
            });
          const last = messages.filter((message) => message.role === "tool").at(-1);
          const result = safeParse(last?.content) as {
            columns: string[];
            rows: unknown[][];
            rowIdentities: unknown[];
          };
          const row = result.rows[0]!;
          return emit("present_browser_results", {
            results: [
              {
                destinationUrl: row[result.columns.indexOf("strava_url")],
                title: row[result.columns.indexOf("name")],
                evidence: { record: result.rowIdentities[0] },
              },
            ],
          });
        }
        if (!called.includes("fetch_many"))
          return emit("fetch_many", { documents: [{ documentId: evidenceId }] });
        return emit("present_browser_results", {
          results: [
            {
              destinationUrl: link,
              title: "Workshop guide",
              evidence: { documentIds: [evidenceId] },
            },
          ],
        });
      },
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      extraGatewayEnv: { OMNESIS_TYPESAFE_API_KEY: "scripted_find_key_0123456789" },
      extraInference: {
        allowRemoteInference: true,
        typesafeUrl: decision.endpoint,
        backends: { "find-puppet": { type: "http", url: puppet.url } },
        assignments: {
          agent: `find-puppet/${puppet.modelId}`,
          decision: `typesafe/${decision.modelId}`,
        },
      },
    });
    await harness.start();
    await harness.pushDocument({
      externalId: "find-message",
      title: "Workshop invitation",
      content: `Maya shared the workshop guide yesterday: ${link}`,
      metadata: { sourceUrl: "https://example.org/message-thread" },
    });
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      evidenceId = db
        .prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id = 'find-message'")
        .get()!.id;
    } finally {
      db.close();
    }
    const schema = stravaProvider.sources
      .find((source) => source.id === "strava-activities")!
      .analyticsSchemas!.find((schema) => schema.tableName === "strava_activities")!;
    for (const [id, distance, name] of [
      [9000001, 5000, "Orchard circuit"],
      [9000002, 12000, "Observatory ridge"],
    ] as const) {
      const defaults = Object.fromEntries(
        schema.columns.map((column) => [
          column.name,
          column.nullable
            ? null
            : column.type.includes("INT") || column.type === "DOUBLE"
              ? 0
              : column.type === "BOOLEAN"
                ? false
                : column.type.startsWith("TIMESTAMP")
                  ? "2026-01-04T10:00:00Z"
                  : "",
        ]),
      );
      await harness.pushDocument({
        sourceId,
        providerId: "strava:7000000",
        externalId: String(id),
        title: name,
        content: `${name} is an invented running activity.`,
        metadata: { sourceUrl: `https://www.strava.com/activities/${id}` },
      });
      await harness.pushAnalyticsRow(
        "strava_activities",
        {
          ...defaults,
          id,
          athlete_id: 7000000,
          name,
          sport_type: "Run",
          distance_m: distance,
          start_time: "2026-01-04T10:00:00Z",
          strava_url: `https://www.strava.com/activities/${id}`,
        },
        { schema, sourceId },
      );
    }
    const device = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "browser", name: "Research browser" }),
    });
    const browser = await pair(
      harness.gatewayUrl,
      device.pairingCode,
      nodeFetch,
      "Research browser",
    );
    browserCredential = browser;
    const id = randomUUID();
    expect(
      (
        await fetch(`${harness.gatewayUrl}/browser/find/authorization`, {
          method: "POST",
          headers: { Authorization: `Bearer ${browser.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        })
      ).status,
    ).toBe(201);
    const portal = await loginPortal({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey });
    expect(
      (
        await fetch(`${harness.gatewayUrl}/admin/browser-find/authorizations/${id}/approve`, {
          method: "POST",
          headers: { Cookie: portal.cookie, "X-Omnesis-CSRF": portal.csrfToken },
        })
      ).status,
    ).toBe(200);
    const polled = await fetch(`${harness.gatewayUrl}/browser/find/authorization/${id}`, {
      headers: { Authorization: `Bearer ${browser.token}` },
    });
    readToken = ((await polled.json()) as { credential: { token: string } }).credential.token;
  }, 180_000);
  afterAll(async () => {
    await harness?.destroy();
    await puppet?.close();
    await decision?.close();
  }, 30_000);
  async function search(text: string): Promise<Event[]> {
    const response = await fetch(`${harness.gatewayUrl}/browser/find/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, timeZone: "UTC" }),
    });
    expect(response.status).toBe(200);
    return (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Event);
  }
  test("extracts the requested embedded link rather than returning its message", async () => {
    const events = await search("the link Maya shared yesterday");
    expect(events.filter((event) => event.type === "find.error")).toEqual([]);
    expect(events).toContainEqual({
      type: "find.decision",
      payload: expect.objectContaining({
        mode: "agentic",
        status: "decided",
        model: decision.modelId,
      }),
    });
    const results = events
      .filter((event) => event.type === "find.results")
      .flatMap(
        (event) =>
          event.payload.results as Array<{
            sourceUrl: string;
            evidence: Array<{ documentId: string }>;
          }>,
      );
    expect(results).toEqual([
      expect.objectContaining({
        sourceUrl: link,
        evidence: [expect.objectContaining({ documentId: evidenceId })],
      }),
    ]);
    expect(events.at(-1)).toEqual({ type: "find.complete", payload: { mode: "agentic" } });
    expect(tools).toContain("fetch_many");
    expect(tools).toContain("present_browser_results");
  }, 120_000);
  test("computes the longest run through real read-only SQL and resolves its source-bound document", async () => {
    const events = await search("my longest Strava run");
    expect(events.filter((event) => event.type === "find.error")).toEqual([]);
    const results = events
      .filter((event) => event.type === "find.results")
      .flatMap((event) => event.payload.results as Array<{ title: string; sourceUrl: string }>);
    expect(results).toEqual([
      expect.objectContaining({
        title: "Observatory ridge",
        sourceUrl: "https://www.strava.com/activities/9000002",
      }),
    ]);
    expect(tools).toContain("run_sql");
    const conversations = join(harness.getConfigDir(), "conversations");
    expect(
      existsSync(conversations)
        ? readdirSync(conversations).filter((name) => name.endsWith(".json"))
        : [],
    ).toEqual([]);
  }, 120_000);
  test.skipIf(!existsSync(chromium.executablePath()))(
    "renders real agent research and grounded results in the built Chrome panel",
    async () => {
      const require = createRequire(import.meta.url);
      const extensionRoot = dirname(
        dirname(require.resolve("@omnesis/extension/scripts/test-manifest")),
      );
      const dist = await mkdtemp(join(tmpdir(), "omnesis-find-agent-dist-"));
      const profile = await mkdtemp(join(tmpdir(), "omnesis-find-agent-profile-"));
      execFileSync(process.execPath, [join(extensionRoot, "scripts", "build.mjs")], {
        cwd: extensionRoot,
        env: {
          ...process.env,
          OMNESIS_EXTENSION_TEST_BUILD: "1",
          OMNESIS_EXTENSION_DIST_DIR: dist,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
          `--disable-extensions-except=${dist}`,
          `--load-extension=${dist}`,
          "--ignore-certificate-errors",
        ],
      });
      try {
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
        await worker.evaluate(
          async ({ gatewayUrl, browser, readToken }) => {
            const identity = `${gatewayUrl}\0${browser.device.id}`;
            await chrome.storage.local.set({
              "omnesis.pairing.v1": JSON.stringify({
                gatewayUrl,
                deviceId: browser.device.id,
                scopes: browser.scopes,
                pairedAt: Date.now(),
              }),
              "omnesis.token.v1": browser.token,
              "omnesis.find.token.v1": { pairing: identity, token: readToken },
              "omnesis.find.state.v1": {
                pairing: identity,
                supported: true,
                canonicalizers: [],
                sourceLabels: {},
                sourceAttributions: {},
                query: "",
                resultsQuery: "",
                results: [],
                limit: 25,
                hasMore: false,
                complete: true,
              },
              "omnesis.panel.view.v1": "find",
            });
          },
          { gatewayUrl: harness.gatewayUrl, browser: browserCredential, readToken },
        );
        const panel = await context.newPage();
        await panel.setViewportSize({ width: 380, height: 820 });
        await panel.goto(`chrome-extension://${TEST_EXTENSION_ID}/notes.html`);
        await expect
          .poll(() => panel.locator("#find-query").isEnabled(), { timeout: 30_000 })
          .toBe(true);
        await panel.locator("#find-query").fill("the link Maya shared yesterday");
        await panel.locator("#find-query").press("Enter");
        await expect
          .poll(() => panel.locator(".find-result-open").count(), { timeout: 120_000 })
          .toBe(1);
        expect(await panel.locator("#find-decision").textContent()).toContain("Agent");
        await expect
          .poll(() => panel.locator("#find-agent").textContent(), { timeout: 30_000 })
          .toContain("Found the requested destination");
        expect(await panel.locator("#find-results").textContent()).toContain("Workshop guide");
        await panel.screenshot({ path: "/tmp/omnesis-extension-find-agent-results.png" });
      } finally {
        await context.close();
        await rm(dist, { recursive: true, force: true });
        await rm(profile, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
