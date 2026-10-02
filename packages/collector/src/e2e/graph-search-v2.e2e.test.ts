// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Real provider ingestion + live-tool replay; no model inference or canned search results. */
import "./synth-env.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { normalizeFile } from "@omnesis/provider-local-files/src/normalizer.js";
import { serializeToolResultForModel } from "@omnesis/agent";
import { authorizeMcpClient, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { DocRef, SearchProvenance, ToolResult } from "@omnesis/core";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const UNIVERSE = join(import.meta.dirname, "../../../../evals/universes/graph-search");
type ModelContext = NonNullable<SearchProvenance["modelContext"]>;
const QUERY = "LANTERN-482";
const LOCAL_SOURCE = "local-files:example-contracts";
interface WireEvent {
  type: string;
  payload: {
    sessionId?: string;
    messageId?: string;
    toolCallId?: string;
    args?: unknown;
    result?: ToolResult;
    [key: string]: unknown;
  };
}
interface PublicHit {
  documentId: string;
  chunkText: string;
  provenance?: SearchProvenance;
  sourceUrl?: string;
}
interface StoredDoc {
  id: string;
  external_id: string;
  source_id: string;
  extracted_content_hash: string | null;
}

describe("Agent search v2 — synthetic file journey", () => {
  let harness: SyntheticE2EHarness;
  let db: Database.Database;
  let enabled = true;
  let unrestricted: AuthorizedMcpClient;
  let restricted: AuthorizedMcpClient;
  let beforePublic: PublicHit[];
  let copies: StoredDoc[];

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      universe: "graph-search",
      gatewayMode: "synthetic",
      agentBackend: "replay",
      embedderBackend: "fake",
      extraGatewayEnv: { OMNESIS_AGENT_REPLAY_IMMEDIATE: "1" },
      // Fake embeddings permit indexing; lexical ranking pins the synthetic seed.
      // These tests measure graph contracts, not embedding quality.
      extraGatewayConfig: () => ({
        search: {
          ...(enabled ? {} : { v2: { enabled: false } }),
          params: { vectorWeight: 0 },
          diversity: { enabled: false },
          sourcePriors: { autoInverseFrequency: { enabled: false } },
        },
      }),
    });
    await harness.start();
    await harness.syncAllSources();
    await harness.stopSyncLoopsAndDrain(60_000);
    // There is no local-files synthetic twin. Exercise its source ownership and
    // document ingestion boundaries with a synthetic extracted-file payload.
    const device = harness.deviceForSource("google-drive:maya@example.com");
    const registered = await fetch(`${harness.gatewayUrl}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ type: "local-files", accountId: "example-contracts", enabled: true }],
      }),
    });
    expect(registered.ok, await registered.text()).toBe(true);
    const driveFixtures = JSON.parse(
      readFileSync(join(UNIVERSE, "sources/google-drive/files.json"), "utf8"),
    ) as Array<{ content: string }>;
    const { doc } = normalizeFile(
      {
        absolutePath: "/fictional/contracts/northstar.pdf",
        displayPath: "~/Contracts/northstar.pdf",
        dirSegments: ["Contracts"],
        mimeType: "application/pdf",
        via: "extract",
        mtime: Date.parse("2025-02-03T09:00:00Z"),
        ctime: Date.parse("2025-02-03T09:00:00Z"),
        size: 4096,
        inode: 42,
        device: 7,
      },
      driveFixtures[0]!.content,
      undefined,
      ProviderId(LOCAL_SOURCE),
      SourceId(LOCAL_SOURCE),
    );
    const ingested = await fetch(`${harness.gatewayUrl}/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: [{ ...doc, externalId: "graph-local" }] }),
    });
    expect(ingested.ok, await ingested.text()).toBe(true);
    db = new Database(harness.getDbPath(), { readonly: true });
    await waitUntil(() => {
      const rows = db
        .prepare(
          "SELECT id, external_id, source_id, extracted_content_hash FROM documents WHERE external_id = 'graph-contract-1'",
        )
        .all() as StoredDoc[];
      if (!rows[0]?.extracted_content_hash) return false;
      copies = db
        .prepare(
          "SELECT id, external_id, source_id, extracted_content_hash FROM documents WHERE extracted_content_hash = ?",
        )
        .all(rows[0].extracted_content_hash) as StoredDoc[];
      if (copies.length !== 5) return false;
      const links = db
        .prepare("SELECT COUNT(*) AS n FROM document_links WHERE link_type = 'duplicate-content'")
        .get() as { n: number };
      const urls = db
        .prepare("SELECT COUNT(*) AS n FROM document_links WHERE link_type = 'url'")
        .get() as { n: number };
      // A global edge count can be satisfied while a copy's own URL backfill
      // is still pending. Await the full fixture trail before comparing
      // separate CLI searches: every copy links to the catalogue, whose
      // twelve resolved children make it a stable traversal hub.
      const cataloguedCopies = db
        .prepare(
          `SELECT COUNT(DISTINCT link.source_doc_id) AS n FROM document_links link
           JOIN documents target ON target.id = link.target_doc_id
           WHERE link.source_doc_id IN (${copies.map(() => "?").join(",")})
             AND target.external_id = 'graph-hub' AND link.link_type = 'url'`,
        )
        .get(...copies.map((copy) => copy.id)) as { n: number };
      const catalogueChildren = db
        .prepare(
          `SELECT COUNT(DISTINCT link.target_doc_id) AS n FROM document_links link
           JOIN documents origin ON origin.id = link.source_doc_id
           JOIN documents target ON target.id = link.target_doc_id
           WHERE origin.external_id = 'graph-hub' AND target.external_id GLOB 'graph-leaf-*'
             AND link.link_type = 'url'`,
        )
        .get() as { n: number };
      const shared = db
        .prepare(
          `SELECT COUNT(*) AS n FROM document_links link
        JOIN documents origin ON origin.id = link.source_doc_id
        JOIN documents target ON target.id = link.target_doc_id
        WHERE origin.external_id = 'graph-chat' AND target.external_id = 'graph-contract-1' AND link.link_type = 'url'`,
        )
        .get() as { n: number };
      const attachment = copies.find((copy) => copy.source_id.startsWith("gmail:"));
      const attached = attachment
        ? (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM document_links link
               JOIN documents parent ON parent.id = link.target_doc_id
               WHERE link.source_doc_id = ? AND parent.external_id = 'graph-mail'
                 AND parent.source_id = ? AND link.link_type = 'contains'
                 AND json_extract(link.metadata_json, '$.role') = 'attachment'`,
              )
              .get(attachment.id, attachment.source_id) as { n: number }
          ).n
        : 0;
      return (
        links.n >= 4 &&
        urls.n >= 13 &&
        cataloguedCopies.n === 5 &&
        catalogueChildren.n === 12 &&
        shared.n > 0 &&
        attached > 0
      );
    }, "five ingested copies and complete catalogue, sharing, attachment and duplicate edges");
    const index = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
    try {
      await waitUntil(() => {
        const indexed = index.prepare("SELECT document_id FROM indexed_documents").all() as Array<{
          document_id: string;
        }>;
        return (
          copies.every((copy) => indexed.some((row) => row.document_id === copy.id)) &&
          indexed.length >= 22
        );
      }, "complete synthetic index before comparing feature modes");
    } finally {
      index.close();
    }
    await waitUntil(async () => {
      await harness.refreshSearchSnapshot();
      beforePublic = (await publicSearch(harness)).results;
      return (
        beforePublic.filter((hit) => copies.some((copy) => copy.id === hit.documentId)).length >= 4
      );
    }, "indexed file copies visible to legacy public search");
    unrestricted = await authorizeMcpClient(harness, {
      principalName: "Graph research assistant",
      grantName: "All fictional sources",
      credentialLabel: "Graph client",
      capabilities: ["direct"],
    });
    restricted = await authorizeMcpClient(harness, {
      principalName: "Scoped graph assistant",
      grantName: "Drive only",
      credentialLabel: "Scoped client",
      capabilities: ["direct"],
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: ["google-drive:maya@example.com"] },
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    for (const authorized of [unrestricted, restricted])
      if (authorized)
        await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    db?.close();
    await harness?.destroy();
  }, 30_000);

  test("default search executes search_many and fetch_many with grounded provenance and one matching snippet", async () => {
    const config = JSON.parse(
      readFileSync(join(harness.getConfigDir(), "omnesis.json"), "utf8"),
    ) as { search?: { v2?: unknown } };
    expect(config.search?.v2).toBeUndefined();
    const events = await runConversation(harness, "Inspect graph copies");
    expect(events.filter((e) => e.type === "agent.error")).toEqual([]);
    const searchStart = events.find(
      (e) => e.type === "agent.tool.start" && e.payload.toolCallId === "graph-search",
    );
    expect(searchStart?.payload.args).toEqual({ queries: [{ query: QUERY, limit: 20 }] });
    const result = toolResult(events, "graph-search");
    expect(result.kind).toBe("search.batch");
    if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
      throw new Error(
        `Live search failed: ${JSON.stringify(result)}\n${readFileSync(harness.getGatewayLogPath(), "utf8").slice(-8000)}`,
      );
    const hits = result.items[0].results;
    const matchingCopyHits = hits.filter((h) => copies.some((copy) => copy.id === h.documentId));
    expect(matchingCopyHits).toHaveLength(1);
    const hit = matchingCopyHits[0]!;
    expect(hit.provenance).toBeDefined();
    expect(hit.provenance!.copies.map((c) => c.documentId).sort()).toEqual(
      copies.map((c) => c.id).sort(),
    );
    expect(hit.provenance!.copies.some((c) => c.url?.startsWith("https://drive.google.com/"))).toBe(
      true,
    );
    expect(hit.provenance!.copies.some((c) => c.url?.startsWith("https://mail.google.com/"))).toBe(
      true,
    );
    expect(
      hit.provenance!.copies.some(
        (c) =>
          c.sourceId === LOCAL_SOURCE &&
          c.url === undefined &&
          c.path === "~/Contracts/northstar.pdf" &&
          c.deviceName === "Example-Laptop-collector",
      ),
    ).toBe(true);
    const chat = db.prepare("SELECT id FROM documents WHERE external_id = 'graph-chat'").get() as {
      id: string;
    };
    expect(hit.provenance!.paths.some((p) => p.documentIds.includes(chat.id))).toBe(true);
    expect(hit.provenance!.summary).toContain("Jamie Lopez");
    expect(hit.provenance!.summary.length).toBeLessThanOrEqual(700);
    const context = hit.provenance!.modelContext!;
    expect(context).toBeDefined();
    expect(context.facts.reduce((sum, fact) => sum + fact.length, 0)).toBeLessThanOrEqual(700);
    expect(context.limits.length).toBeLessThanOrEqual(5);
    expect(context.documents[0]).toMatchObject({ ref: "D1", documentId: hit.documentId });
    expect(new Set(context.documents.map((document) => document.documentId)).size).toBe(
      context.documents.length,
    );
    for (const document of context.documents) {
      const stored = db
        .prepare("SELECT id, source_id FROM documents WHERE id = ?")
        .get(document.documentId) as { id: string; source_id: string } | undefined;
      expect(stored).toBeDefined();
      expect(document.sourceId).toBe(stored!.source_id);
    }
    const reference = (documentId: string): string => {
      const document = context.documents.find((item) => item.documentId === documentId);
      expect(document, `missing model reference for ${documentId}`).toBeDefined();
      return `[${document!.ref}]`;
    };
    for (const sentence of [...context.facts, ...context.limits]) {
      for (const match of sentence.matchAll(/\[(D[1-9][0-9]*)\]/g)) {
        expect(context.documents.some((document) => document.ref === match[1])).toBe(true);
      }
    }
    const copyFact = context.facts.find((fact) =>
      fact.startsWith("Matching extracted text also appears in "),
    );
    expect(copyFact).toBeDefined();
    expect(copyFact).not.toContain(reference(hit.documentId));
    for (const copy of copies.filter((copy) => copy.id !== hit.documentId)) {
      expect(copyFact).toContain(reference(copy.id));
    }
    const local = copies.find((copy) => copy.source_id === LOCAL_SOURCE)!;
    expect(context.documents.find((document) => document.documentId === local.id)).toMatchObject({
      sourceId: LOCAL_SOURCE,
      deviceName: "Example-Laptop-collector",
      path: "~/Contracts/northstar.pdf",
    });
    expect(context.facts).toContain(
      `${reference(local.id)} is indexed on "Example-Laptop-collector" at "~/Contracts/northstar.pdf".`,
    );
    const drive = copies.find((copy) => copy.external_id === "graph-contract-1")!;
    expect(
      context.facts.some(
        (fact) =>
          fact.startsWith(`${reference(drive.id)} `) &&
          fact.includes(`is linked from ${reference(chat.id)}`),
      ),
    ).toBe(true);
    const attachment = copies.find((copy) => copy.source_id.startsWith("gmail:"))!;
    const parentMail = db
      .prepare("SELECT id FROM documents WHERE external_id = 'graph-mail'")
      .get() as { id: string };
    expect(
      context.facts.some((fact) =>
        fact.includes(`${reference(attachment.id)} is attached to ${reference(parentMail.id)}`),
      ),
    ).toBe(true);
    expect(
      context.facts.some((fact) =>
        fact.includes(`${reference(parentMail.id)} is attached to ${reference(attachment.id)}`),
      ),
    ).toBe(false);
    const projected = JSON.parse(serializeToolResultForModel(result)) as {
      items: Array<{ results: Array<{ documentId: string; provenance?: ModelContext }> }>;
    };
    const modelHit = projected.items[0]!.results.find(
      (item) => item.documentId === hit.documentId,
    )!;
    expect(modelHit.provenance).toEqual(context);
    expect(Object.keys(modelHit.provenance!).sort()).toEqual(["documents", "facts", "limits"]);
    expect(modelHit.provenance).not.toHaveProperty("copies");
    expect(modelHit.provenance).not.toHaveProperty("paths");
    expect(modelHit.provenance).not.toHaveProperty("summary");
    expect(hit.provenance!.copies).toHaveLength(5);
    expect(hit.provenance!.paths.length).toBeGreaterThan(0);

    const unrelated = db
      .prepare("SELECT id FROM documents WHERE external_id = 'graph-chat-unrelated'")
      .get() as { id: string };
    expect(hit.provenance!.paths.flatMap((p) => p.documentIds)).not.toContain(unrelated.id);
    expect(context.documents.map((document) => document.documentId)).not.toContain(unrelated.id);
    expect(hit.provenance!.paths.flatMap((p) => p.documentIds)).not.toContain(
      (
        db.prepare("SELECT id FROM documents WHERE external_id = 'graph-leaf-0'").get() as {
          id: string;
        }
      ).id,
    );
    expect(hit.provenance!.truncated).toBe(true);
    expect(hit.provenance!.stopReasons.length).toBeGreaterThan(0);
    const selectedId = hits[0]!.documentId;
    expect(
      events.find((e) => e.type === "agent.tool.start" && e.payload.toolCallId === "graph-fetch")
        ?.payload.args,
    ).toEqual({ documents: [{ documentId: selectedId, includeNeighbors: true }] });
    const fetched = toolResult(events, "graph-fetch");
    expect(fetched.kind).toBe("document.batch");
    if (fetched.kind !== "document.batch") throw new Error("Live fetch failed");
    expect(fetched.items[0]).toMatchObject({ kind: "document", ref: { documentId: selectedId } });
    const oldSnippets = beforePublic.filter((h) => copies.some((copy) => copy.id === h.documentId));
    expect(oldSnippets.length).toBeGreaterThan(1);
    const legacySnippetChars = oldSnippets.reduce((sum, h) => sum + h.chunkText.length, 0);
    console.info(
      `[graph-search] matching-copy snippet chars: v2=${hit.snippet!.length}, legacy=${legacySnippetChars}`,
    );
    expect(hit.snippet!.length).toBeLessThan(legacySnippetChars);
  }, 90_000);

  test("a source-filtered single hit still describes indexed copies outside the matching candidate pool", async () => {
    const events = await runConversation(harness, "Inspect graph filtered");
    const result = toolResult(events, "graph-search");
    if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
      throw new Error("Live filtered search failed");
    expect(result.items[0].results).toHaveLength(1);
    const hit = result.items[0].results[0]!;
    expect(hit.sourceId).toBe("google-drive:maya@example.com");
    expect(hit.provenance!.copies.map((c) => c.documentId).sort()).toEqual(
      copies.map((c) => c.id).sort(),
    );
    expect(hit.provenance!.copies.some((c) => c.sourceId === LOCAL_SOURCE)).toBe(true);
  }, 90_000);

  test("a journey conversation can use real provenance after one search without fetching bodies or a full trail", async () => {
    const events = await runConversation(harness, "Inspect graph journey");
    const starts = events.filter((e) => e.type === "agent.tool.start");
    expect(starts.map((e) => e.payload.tool)).toEqual(["search_many"]);
    const result = toolResult(events, "graph-search");
    if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
      throw new Error("Journey search failed");
    const summary = result.items[0].results[0]!.provenance!.summary;
    const reply = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => e.payload.delta)
      .join("");
    expect(reply).toBe(summary);
    expect(reply).toContain("Example-Laptop-collector");
    expect(reply).toContain("Jamie Lopez");
    expect(reply).not.toContain("$CAP_");
  }, 90_000);

  test("a hub search describes its endpoint without expanding its catalogue", async () => {
    const events = await runConversation(harness, "Inspect graph hub");
    const result = toolResult(events, "graph-search");
    if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
      throw new Error("Live hub search failed");
    const hit = result.items[0].results[0]!;
    expect(hit.title).toBe("Equipment catalogue index.pdf");
    expect(hit.provenance!.paths).toEqual([]);
    expect(hit.provenance!.stopReasons).toContain("hub");
    expect(hit.provenance!.truncated).toBe(true);
    const context = hit.provenance!.modelContext!;
    expect(context.documents).toHaveLength(1);
    expect(context.documents[0]).toMatchObject({ ref: "D1", documentId: hit.documentId });
    expect(context.limits).toContain(
      "Further connections of [D1] were not explored because they are highly connected.",
    );
    const descendants = db
      .prepare("SELECT id FROM documents WHERE external_id LIKE 'graph-leaf-%'")
      .all() as Array<{ id: string }>;
    expect(descendants.length).toBeGreaterThan(0);
    for (const document of descendants) {
      expect(context.documents.some((item) => item.documentId === document.id)).toBe(false);
    }
  }, 90_000);

  test("different extracted-text versions retain separate entries and blank scans never collapse", async () => {
    const events = await runConversation(harness, "Inspect graph versions");
    const result = toolResult(events, "graph-search");
    if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
      throw new Error("Live version search failed");
    const revision = db
      .prepare("SELECT id FROM documents WHERE external_id = 'graph-revision'")
      .get() as { id: string };
    expect(result.items[0].results.some((h) => h.documentId === revision.id)).toBe(true);
    const familyHit = result.items[0].results.find((hit) => hit.provenance?.copies.length === 5)!;
    expect(familyHit).toBeDefined();
    expect(familyHit.documentId).not.toBe(revision.id);
    expect(familyHit.provenance!.copies.some((copy) => copy.documentId === revision.id)).toBe(
      false,
    );
    expect(
      familyHit.provenance!.modelContext!.documents.some(
        (document) => document.documentId === revision.id,
      ),
    ).toBe(false);
    const revisionHit = result.items[0].results.find((hit) => hit.documentId === revision.id)!;
    expect(
      revisionHit.provenance?.copies.some((copy) =>
        copies.some((original) => original.id === copy.documentId),
      ) ?? false,
    ).toBe(false);

    expect(
      result.items[0].results
        .flatMap((h) => h.provenance?.copies ?? [])
        .filter((copy) => copies.some((c) => c.id === copy.documentId))
        .map((c) => c.documentId)
        .sort(),
    ).toEqual(copies.map((c) => c.id).sort());
    const blankEvents = await runConversation(harness, "Inspect graph blanks");
    const blankResult = toolResult(blankEvents, "graph-search");
    if (blankResult.kind !== "search.batch" || blankResult.items[0]?.kind !== "search.results")
      throw new Error("Live blank search failed");
    expect(
      blankResult.items[0].results.filter((h) => h.title?.startsWith("Blank scan")),
    ).toHaveLength(2);
  }, 90_000);

  test("unrestricted Direct receives the same enrichment while restricted grants reveal no graph or copy metadata", async () => {
    const all = await directSearch(unrestricted, QUERY);
    expect(all.some((h) => h.provenance?.copies.length === 5)).toBe(true);
    const scopedResult = await directSearchResult(restricted, QUERY);
    if (scopedResult.kind !== "search.batch" || scopedResult.items[0]?.kind !== "search.results")
      throw new Error("Missing restricted search results");
    const scoped = scopedResult.items[0].results;
    expect(serializeToolResultForModel(scopedResult)).toBe(JSON.stringify(scopedResult));
    expect(serializeToolResultForModel(scopedResult)).not.toContain('"modelContext"');
    expect(scoped.length).toBeGreaterThan(0);
    for (const hit of scoped) {
      expect(hit.sourceId).toBe("google-drive:maya@example.com");
      expect(hit.provenance).toBeUndefined();
      expect(hit.breadcrumb).toBeUndefined();
      expect(hit.refCount).toBeUndefined();
    }
    expect(JSON.stringify(scoped)).not.toContain(LOCAL_SOURCE);
    expect(JSON.stringify(scoped)).not.toContain("https://mail.google.com/");
  }, 60_000);

  test("CLI agent context renders live provenance and canonical JSON while normal search remains legacy", async () => {
    const json = await runCli(harness, [
      "search",
      QUERY,
      "--agent-context",
      "--limit",
      "20",
      "--json",
    ]);
    // Parse all stdout: diagnostics must never contaminate the machine payload.
    const result = JSON.parse(json.stdout) as ToolResult;
    expect(result.kind).toBe("search.results");
    if (result.kind !== "search.results") throw new Error("Missing CLI agent context");
    expect(result.candidates).toEqual(expect.any(Number));
    expect(result).not.toHaveProperty("totalCandidates");
    const grouped = result.results.find((hit) => hit.provenance?.copies.length === 5);
    expect(grouped).toBeDefined();
    expect(grouped!.provenance!.copies.map((copy) => copy.documentId).sort()).toEqual(
      copies.map((copy) => copy.id).sort(),
    );
    expect(grouped!.provenance!.paths.length).toBeGreaterThan(0);
    expect(json.stderr).not.toMatch(/falling back|unavailable/i);

    const pretty = await runCli(harness, ["search", QUERY, "--agent-context", "--limit", "20"]);
    expect(pretty.stdout).toContain(grouped!.provenance!.summary);
    expect(pretty.stdout).toContain("Example-Laptop-collector");
    expect(pretty.stdout).toContain("~/Contracts/northstar.pdf");
    for (const copy of grouped!.provenance!.copies) {
      expect(pretty.stdout).toContain(copy.documentId);
      if (copy.url) expect(pretty.stdout).toContain(copy.url);
      if (copy.appUrl) expect(pretty.stdout).toContain(copy.appUrl);
    }
    for (const path of grouped!.provenance!.paths)
      for (const documentId of path.documentIds) expect(pretty.stdout).toContain(documentId);
    const normal = await runCli(harness, ["search", QUERY, "--limit", "20", "--json"]);
    const legacy = JSON.parse(normal.stdout) as { results: PublicHit[] };
    expect(legacy.results.every((hit) => hit.provenance === undefined)).toBe(true);
    expect(
      legacy.results.filter((hit) => copies.some((copy) => copy.id === hit.documentId)).length,
    ).toBeGreaterThan(1);
    expect((await publicSearch(harness)).results.every((hit) => hit.provenance === undefined)).toBe(
      true,
    );

    // The harness collector credential includes admin. Mint an explicitly
    // scoped token so this probe proves authorization, rather than device kind.
    const readOnly = await harness.gatewayJson<{ id: string; token: string; scopes: string[] }>(
      "/admin/tokens",
      {
        method: "POST",
        body: JSON.stringify({
          deviceId: harness.deviceForSource("google-drive:maya@example.com").deviceId,
          scopes: ["read"],
          name: "Graph diagnostic read-only probe",
        }),
      },
    );
    expect(readOnly.scopes).toEqual(["read"]);
    try {
      const identity = await fetch(`${harness.gatewayUrl}/whoami`, {
        headers: { Authorization: `Bearer ${readOnly.token}` },
      });
      expect(identity.status).toBe(200);
      expect(((await identity.json()) as { scopes: string[] }).scopes).toEqual(["read"]);
      const denied = await fetch(`${harness.gatewayUrl}/admin/search/agent-context`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readOnly.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: QUERY, limit: 20 }),
      });
      expect(denied.status).toBe(403);
    } finally {
      await harness.gatewayJson(`/admin/tokens/${readOnly.id}`, { method: "DELETE" });
    }
  }, 120_000);

  test("read-only mobile search opts into bounded graph facts without changing ordinary hits", async () => {
    const readOnly = await harness.gatewayJson<{ id: string; token: string }>("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({
        deviceId: harness.deviceForSource("google-drive:maya@example.com").deviceId,
        scopes: ["read"],
        name: "Mobile graph search probe",
      }),
    });
    const headers = {
      Authorization: `Bearer ${readOnly.token}`,
      "Content-Type": "application/json",
    };
    try {
      const readiness = await fetch(`${harness.gatewayUrl}/search/readiness`, { headers });
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ graphContextAvailable: true });
      const search = async (includeGraphContext: boolean) => {
        const response = await fetch(`${harness.gatewayUrl}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: QUERY, limit: 20, verbose: true, includeGraphContext }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          results: PublicHit[];
          timing: unknown;
          stages: unknown;
        };
      };
      const ordinary = await search(false);
      const enriched = await search(true);
      // Existing apps retain the same hit IDs, snippets, source links and ranks.
      expect(enriched.results.map(({ provenance: _provenance, ...hit }) => hit)).toEqual(
        ordinary.results,
      );
      expect(enriched.timing).toBeDefined();
      expect(enriched.stages).toBeDefined();
      expect(ordinary.results.every((hit) => hit.provenance === undefined)).toBe(true);
      const graphHits = enriched.results.filter((hit) => hit.provenance);
      expect(graphHits.length).toBeGreaterThan(0);
      expect(graphHits.length).toBeLessThanOrEqual(3);
      expect(enriched.results.slice(3).every((hit) => !hit.provenance)).toBe(true);
      const hit = graphHits.find((item) => copies.some((copy) => copy.id === item.documentId));
      expect(hit).toBeDefined();
      const graph = hit!.provenance!;
      expect(graph.copies.map((copy) => copy.documentId).sort()).toEqual(
        copies.map((copy) => copy.id).sort(),
      );
      expect(
        graph.copies.some(
          (copy) =>
            copy.path === "~/Contracts/northstar.pdf" &&
            copy.deviceName === "Example-Laptop-collector",
        ),
      ).toBe(true);
      expect(graph.paths.length).toBeGreaterThan(0);
      expect(
        graph.modelContext?.documents.some((document) => document.documentId === hit!.documentId),
      ).toBe(true);
      expect(graph.paths.length).toBeLessThanOrEqual(24);
      const journeyResponse = await fetch(`${harness.gatewayUrl}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "equipment agreement source:whatsapp-messages",
          includeGraphContext: true,
        }),
      });
      expect(journeyResponse.status).toBe(200);
      const journey = (await journeyResponse.json()) as { results: PublicHit[] };
      const chat = db
        .prepare("SELECT id FROM documents WHERE external_id = 'graph-chat'")
        .get() as { id: string };
      const drive = copies.find((copy) => copy.external_id === "graph-contract-1")!;
      const hub = db.prepare("SELECT id FROM documents WHERE external_id = 'graph-hub'").get() as {
        id: string;
      };
      const chatGraph = journey.results.find((item) => item.documentId === chat.id)!.provenance!;
      expect(
        chatGraph.paths.some(
          (path) =>
            JSON.stringify(path.documentIds) === JSON.stringify([chat.id, drive.id, hub.id]),
        ),
      ).toBe(true);
      expect(chatGraph.stopReasons).toContain("hub");
      // Source-restricted Direct credentials are audience-bound to MCP, so
      // the mobile read surface rejects them before graph access.
      const token = restricted.provider.tokens()!.access_token;
      const denied = await fetch(`${harness.gatewayUrl}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: QUERY, includeGraphContext: true }),
      });
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain(LOCAL_SOURCE);
    } finally {
      await harness.gatewayJson(`/admin/tokens/${readOnly.id}`, { method: "DELETE" });
    }
  }, 60_000);

  test("public search stays legacy and disabling v2 restores separate agent copy entries after restart", async () => {
    expect(beforePublic.every((hit) => hit.provenance === undefined)).toBe(true);
    const injection = await fetch(`${harness.gatewayUrl}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: QUERY,
        limit: 20,
        agentContext: true,
        options: { agentContext: true },
      }),
    });
    if (injection.ok) {
      const body = (await injection.json()) as { results: PublicHit[] };
      expect(body.results.every((hit) => hit.provenance === undefined)).toBe(true);
    } else expect(injection.status).toBe(400);
    const enriched = await directSearch(unrestricted, QUERY);
    const copyQuery = "agreement source:google-drive before:2025-02-02";
    const enrichedCopies = await directSearchResult(unrestricted, copyQuery);
    enabled = false;
    await harness.restartGateway();
    const fallbackConfig = JSON.parse(
      readFileSync(join(harness.getConfigDir(), "omnesis.json"), "utf8"),
    ) as { search?: { v2?: { enabled?: boolean } } };
    expect(fallbackConfig.search?.v2?.enabled).toBe(false);
    const readiness = await harness.gatewayJson<{ graphContextAvailable?: boolean }>(
      "/search/readiness",
    );
    expect(readiness.graphContextAvailable).not.toBe(true);
    const mobileFallback = await harness.gatewayJson<{ results: PublicHit[] }>("/search", {
      method: "POST",
      body: JSON.stringify({ text: QUERY, limit: 20, includeGraphContext: true }),
    });
    expect(mobileFallback.results.every((hit) => !hit.provenance)).toBe(true);
    const unavailable = await fetch(`${harness.gatewayUrl}/admin/search/agent-context`, {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: QUERY, limit: 20 }),
    });
    expect(unavailable.status).toBe(404);
    const fallback = await runCli(harness, [
      "search",
      QUERY,
      "--agent-context",
      "--limit",
      "20",
      "--json",
    ]);
    const fallbackJson = JSON.parse(fallback.stdout) as { results: PublicHit[] };
    expect(fallbackJson.results.every((hit) => hit.provenance === undefined)).toBe(true);
    expect(
      fallbackJson.results.filter((hit) => copies.some((copy) => copy.id === hit.documentId))
        .length,
    ).toBeGreaterThan(1);
    expect(fallback.stderr).toMatch(/ordinary search/i);
    const fallbackPretty = await runCli(harness, [
      "search",
      QUERY,
      "--agent-context",
      "--limit",
      "20",
    ]);
    expect(fallbackPretty.stdout).toContain("Northstar");
    expect(fallbackPretty.stdout).not.toContain("Example-Laptop-collector");
    expect(fallbackPretty.stderr).toMatch(/ordinary search/i);
    const publicAfter = (await publicSearch(harness)).results;
    expect(
      publicAfter
        .filter((h) => copies.some((c) => c.id === h.documentId))
        .map((h) => h.documentId)
        .sort(),
    ).toEqual(
      beforePublic
        .filter((h) => copies.some((c) => c.id === h.documentId))
        .map((h) => h.documentId)
        .sort(),
    );
    expect(publicAfter.every((h) => h.provenance === undefined)).toBe(true);
    const legacy = await directSearch(unrestricted, QUERY);
    expect(legacy.every((hit) => hit.provenance === undefined)).toBe(true);
    expect(
      legacy.filter((h) => copies.some((copy) => copy.id === h.documentId)).length,
    ).toBeGreaterThan(1);
    expect(legacy.some((h) => h.breadcrumb?.length)).toBe(true);
    // Broad queries may spend saved snippet space on additional unique evidence.
    const enrichedBytes = Buffer.byteLength(JSON.stringify(enriched));
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
    console.info(`[graph-search] model result bytes: v2=${enrichedBytes}, legacy=${legacyBytes}`);
    const legacyCopies = await directSearchResult(unrestricted, copyQuery);
    if (
      enrichedCopies.kind !== "search.batch" ||
      enrichedCopies.items[0]?.kind !== "search.results" ||
      legacyCopies.kind !== "search.batch" ||
      legacyCopies.items[0]?.kind !== "search.results"
    )
      throw new Error("Missing focused copy-family results");
    const matchingDriveIds = copies
      .filter((copy) => copy.source_id === "google-drive:maya@example.com")
      .map((copy) => copy.id)
      .sort();
    expect(legacyCopies.items[0].results.map((hit) => hit.documentId).sort()).toEqual(
      matchingDriveIds,
    );
    expect(enrichedCopies.items[0].results).toHaveLength(1);
    const grouped = enrichedCopies.items[0].results[0]!;
    expect(matchingDriveIds).toContain(grouped.documentId);
    expect(grouped.provenance!.copies.map((copy) => copy.documentId).sort()).toEqual(
      copies.map((copy) => copy.id).sort(),
    );
    // The source/date filters constrain both retrieval lanes to three roots.
    // Compare the full live tool payload for those roots,
    // including batch envelopes and provenance for copies outside the filter.
    const enrichedCopyBytes = Buffer.byteLength(serializeToolResultForModel(enrichedCopies));
    const legacyCopyBytes = Buffer.byteLength(serializeToolResultForModel(legacyCopies));
    console.info(
      `[graph-search] focused tool payload bytes: v2=${enrichedCopyBytes}, legacy=${legacyCopyBytes}`,
    );
    expect(enrichedCopyBytes).toBeLessThan(legacyCopyBytes);
    expect(serializeToolResultForModel(legacyCopies)).toBe(JSON.stringify(legacyCopies));
    expect(serializeToolResultForModel(legacyCopies)).not.toContain('"modelContext"');
    enabled = true;
    await harness.restartGateway();
    expect(
      (await directSearch(unrestricted, QUERY)).some((hit) => hit.provenance?.copies.length === 5),
    ).toBe(true);
  }, 120_000);
});

async function publicSearch(harness: SyntheticE2EHarness): Promise<{ results: PublicHit[] }> {
  return harness.gatewayJson("/search", {
    method: "POST",
    body: JSON.stringify({ text: QUERY, limit: 20 }),
  });
}
async function directSearch(authorized: AuthorizedMcpClient, query: string): Promise<DocRef[]> {
  const result = await directSearchResult(authorized, query);
  if (result.kind !== "search.batch" || result.items[0]?.kind !== "search.results")
    throw new Error(`Unexpected direct result: ${JSON.stringify(result)}`);
  return result.items[0].results;
}
async function directSearchResult(
  authorized: AuthorizedMcpClient,
  query: string,
): Promise<ToolResult> {
  const response = await authorized.client.callTool({
    name: "search_many",
    arguments: { queries: [{ query, limit: 20 }] },
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as ToolResult;
}
function toolResult(events: WireEvent[], id: string): ToolResult {
  const result = events.find(
    (event) => event.type === "agent.tool.result" && event.payload.toolCallId === id,
  )?.payload.result;
  if (!result) throw new Error(`Missing live tool result ${id}`);
  return result;
}
async function runConversation(harness: SyntheticE2EHarness, text: string): Promise<WireEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  const stream = await fetch(`${harness.gatewayUrl}/agent/events`, {
    signal: abort.signal,
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!stream.body || !stream.ok) {
    clearTimeout(timer);
    throw new Error(
      `Agent SSE unavailable: ${stream.status} ${await stream.text()}\n${readFileSync(harness.getGatewayLogPath(), "utf8").slice(-6000)}`,
    );
  }
  const reader = stream.body.getReader();
  try {
    const session = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
      method: "POST",
      body: "{}",
    });
    const message = await harness.gatewayJson<{ messageId: string }>(
      `/agent/sessions/${session.sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    const events: WireEvent[] = [];
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("Agent stream ended without message.end");
      buffer += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5).trim()) as WireEvent;
        if (event.payload.sessionId !== session.sessionId) continue;
        events.push(event);
        if (event.type === "agent.message.end" && event.payload.messageId === message.messageId)
          return events;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    abort.abort();
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runCli(
  harness: SyntheticE2EHarness,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("npx", ["tsx", "packages/cli/src/index.ts", ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
      OMNESIS_CONFIG_DIR: harness.getConfigDir(),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NO_COLOR: "1",
      CI: "1",
    },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
