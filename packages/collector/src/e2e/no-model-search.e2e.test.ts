// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import "./synth-env.js";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authorizeMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

describe("keyword search without an embedding model", () => {
  let harness: SyntheticE2EHarness;
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
  }, 90_000);
  afterAll(async () => {
    await harness?.destroy();
  });

  test("a retained document reaches the ordinary search pipeline without inference", async () => {
    await harness.pushDocument({
      externalId: "keyword-only-fixture",
      title: "Fictional observatory maintenance",
      content: "Zephyrseal replacement is scheduled for the fictional observatory dome.",
    });
    const raw = await harness.gatewayJson<{ results: Array<{ title: string }> }>(
      "/documents/search?q=Zephyrseal",
    );
    expect(raw.results.map((item) => item.title)).toContain("Fictional observatory maintenance");
    await expect
      .poll(
        async () => {
          await harness.refreshSearchSnapshot();
          const search = await harness.gatewayJson<{ results: Array<{ title: string }> }>(
            "/search",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: "Zephyrseal", limit: 10 }),
            },
          );
          return search.results.map((item) => item.title);
        },
        { timeout: 10_000, interval: 200 },
      )
      .toContain("Fictional observatory maintenance");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/index.ts", "search", "Zephyrseal", "--json"],
      {
        env: {
          ...process.env,
          OMNESIS_GATEWAY_URL: harness.gatewayUrl,
          OMNESIS_TOKEN: harness.apiKey,
          OMNESIS_CONFIG_DIR: harness.getConfigDir(),
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        timeout: 20_000,
      },
    );
    expect(stdout).toContain("Fictional observatory maintenance");
    const authorized = await authorizeMcpClient(harness, {
      principalName: "Fictional keyword client",
      grantName: "Fictional keyword access",
      credentialLabel: "Fictional keyword credential",
      capabilities: ["direct"],
    });
    try {
      const response = await authorized.client.callTool({
        name: "search_many",
        arguments: { queries: [{ query: "Zephyrseal", limit: 10 }] },
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.structuredContent)).toContain(
        "Fictional observatory maintenance",
      );
    } finally {
      await authorized.client.close();
      await authorized.transport.close();
    }
  }, 60_000);
});

describe("lexical and semantic assignment transitions", () => {
  let harness: SyntheticE2EHarness;
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
    });
    await harness.start();
  }, 90_000);
  afterAll(async () => {
    await harness?.destroy();
  });

  function rows(): Array<{ document_id: string; content: string; embedded: number }> {
    const db = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
    try {
      return db
        .prepare(
          "SELECT document_id, content, embedding IS NOT NULL AS embedded FROM chunks WHERE source_id = 'synthetic:test@example.com'",
        )
        .all() as Array<{ document_id: string; content: string; embedded: number }>;
    } finally {
      db.close();
    }
  }
  async function assignment(value: string | null): Promise<void> {
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { assignments: { embedder: value } } }),
    });
  }
  async function waitForKeywordIndexing(): Promise<void> {
    await expect
      .poll(
        async () =>
          (
            await harness.gatewayJson<{
              indexer: { status: string; reason?: string; keywordIndexingActive?: boolean };
            }>("/search/readiness")
          ).indexer,
        { timeout: 20_000 },
      )
      .toMatchObject({
        status: "disabled",
        keywordIndexingActive: true,
        reason: expect.stringContaining("keyword indexing active"),
      });
  }
  async function waitForRows(text: string, embedded: number): Promise<void> {
    await expect
      .poll(
        () =>
          rows()
            .filter((row) => row.content.includes(text))
            .map((row) => row.embedded),
        { timeout: 20_000, interval: 100 },
      )
      .toEqual([embedded]);
  }

  test("same model returning after off-mode edits and deletion rebuilds vectors without resurrecting deleted text", async () => {
    const model = harness.getFakeEmbedder();
    if (!model) throw new Error("Missing scripted embedder fixture");
    await harness.pushDocuments([
      { externalId: "retained", content: "Amberprism original observatory" },
      { externalId: "removed", content: "Cobaltspire retired observatory" },
    ]);
    await waitForRows("Amberprism", 1);
    await waitForRows("Cobaltspire", 1);
    await assignment(null);
    await waitForKeywordIndexing();
    const afterOff = harness.getEmbedCount();
    await harness.pushDocument({
      externalId: "retained",
      content: "Silverpetal revised observatory",
    });
    await waitForRows("Silverpetal", 0);
    const removed = rows().find((row) => row.content.includes("Cobaltspire"));
    if (!removed) throw new Error("Missing deletion fixture");
    const response = await harness.gatewayFetch(`/documents/${removed.document_id}`, {
      method: "DELETE",
    });
    expect(response.ok).toBe(true);
    await expect.poll(() => rows().some((row) => row.content.includes("Cobaltspire"))).toBe(false);
    expect(harness.getEmbedCount()).toBe(afterOff);
    await assignment(`fake/${model.modelId}`);
    await waitForRows("Silverpetal", 1);
    expect(
      rows().some(
        (row) => row.content.includes("Cobaltspire") || row.content.includes("Amberprism"),
      ),
    ).toBe(false);
    expect(rows()).toHaveLength(1);
  }, 90_000);

  test("fresh lexical documents gain vectors when a model is assigned", async () => {
    const model = harness.getFakeEmbedder();
    if (!model) throw new Error("Missing scripted embedder fixture");
    await assignment(null);
    await waitForKeywordIndexing();
    await harness.pushDocument({
      externalId: "fresh-lexical",
      content: "Violetspire fictional instrument",
    });
    await waitForRows("Violetspire", 0);
    await assignment(`fake/${model.modelId}`);
    await waitForRows("Violetspire", 1);
  }, 90_000);
});

describe("first semantic assignment after lexical-only startup", () => {
  let harness: SyntheticE2EHarness;
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      extraInference: { assignments: { embedder: "local/nomic-embed-text-v1.5.Q8_0" } },
    });
    await harness.start();
  }, 90_000);
  afterAll(async () => {
    await harness?.destroy();
  });

  function snapshot(): {
    chunks: number;
    embedded: number;
    lexical: string | undefined;
    model: string | undefined;
    dim: string | undefined;
  } {
    const db = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
    try {
      const counts = db
        .prepare<[], { chunks: number; embedded: number }>(
          "SELECT count(*) AS chunks, coalesce(sum(embedding IS NOT NULL), 0) AS embedded FROM chunks WHERE source_id = 'synthetic:test@example.com'",
        )
        .get();
      if (!counts) throw new Error("Missing first-assignment counters");
      const metadata = db.prepare<[string], { value: string }>(
        "SELECT value FROM index_meta WHERE key = ?",
      );
      return {
        ...counts,
        lexical: metadata.get("lexical_writes")?.value,
        model: metadata.get("embed_model_name")?.value,
        dim: metadata.get("embed_model_dim")?.value,
      };
    } finally {
      db.close();
    }
  }

  test("a fresh keyword index gains its first model stamp and vectors without duplicate chunks", async () => {
    const model = harness.getFakeEmbedder();
    if (!model) throw new Error("Missing scripted embedder fixture");
    await harness.pushDocument({
      externalId: "first-assignment",
      title: "Fictional crystal archive",
      content: "Citrinevault contains a fictional instrument ledger.",
    });
    await expect.poll(snapshot, { timeout: 20_000, interval: 100 }).toEqual({
      chunks: 1,
      embedded: 0,
      lexical: "1",
      model: undefined,
      dim: undefined,
    });
    expect(harness.getEmbedCount()).toBe(0);
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { assignments: { embedder: `fake/${model.modelId}` } } }),
    });
    await expect.poll(snapshot, { timeout: 20_000, interval: 100 }).toEqual({
      chunks: 1,
      embedded: 1,
      lexical: undefined,
      model: model.modelId,
      dim: String(model.dim),
    });
    await harness.refreshSearchSnapshot();
    const searched = await harness.gatewayJson<{ results: Array<{ title: string }> }>("/search", {
      method: "POST",
      body: JSON.stringify({ text: "Citrinevault", limit: 10 }),
    });
    expect(searched.results.map((item) => item.title)).toContain("Fictional crystal archive");
  }, 60_000);
});
