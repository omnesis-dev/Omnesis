// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E Portal Tests — validates the web portal serving, SPA fallback,
 * auth isolation, and search flow via real gateway subprocess.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { E2EHarness } from "./harness.js";
import { mockDoc } from "./mock-source.js";
import type { MockSource } from "./mock-source.js";

describe("E2E Portal", () => {
  let harness: E2EHarness;
  let source: MockSource;
  const sourceId = "portal-notes:test";

  beforeAll(async () => {
    harness = new E2EHarness();

    source = harness.registerMockSource({
      sourceType: "portal-notes",
      providerType: "portal-provider",
      accountId: "test",
      unitName: "notes",
    });

    source.setDocuments([
      mockDoc("portal-doc-1", {
        title: "Portal Test Document Alpha",
        content: "Alpha content for portal search",
      }),
      mockDoc("portal-doc-2", {
        title: "Portal Test Document Beta",
        content: "Beta content for portal search",
      }),
      mockDoc("portal-doc-3", {
        title: "Portal Test Document Gamma",
        content: "Gamma content for portal search",
      }),
    ]);

    await harness.start();
    await harness.triggerSyncAndWait(sourceId);
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  // -----------------------------------------------------------------------
  // Static file serving
  // -----------------------------------------------------------------------

  test("GET /portal/ returns HTML with expected markers", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("importmap");
    expect(html).toContain("app.js");
  });

  test("GET /portal redirects to /portal/", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/portal/");
  });

  test("GET /portal/css/style.css returns CSS", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/css/style.css`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("css");
  });

  test("GET /portal/js/app.js returns JS module", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/js/app.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("import");
  });

  test("GET /portal/js/api.js returns JS", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/js/api.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("search");
  });

  // -----------------------------------------------------------------------
  // SPA fallback
  // -----------------------------------------------------------------------

  test("SPA fallback: /portal/doc/some-id returns index.html", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/doc/some-id`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("app.js");
  });

  test("SPA fallback: /portal/nonexistent/path returns index.html", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/nonexistent/path`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
  });

  // -----------------------------------------------------------------------
  // Auth isolation
  // -----------------------------------------------------------------------

  test("portal routes do not require auth", async () => {
    // No Authorization header — should still work
    const res = await fetch(`${harness.gatewayUrl}/portal/`);
    expect(res.status).toBe(200);
  });

  test("API routes still require auth", async () => {
    const res = await fetch(`${harness.gatewayUrl}/documents/count/gmail`);
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Search API (what portal JS calls)
  // -----------------------------------------------------------------------

  test("POST /search returns valid response", async () => {
    const res = await fetch(`${harness.gatewayUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${harness.apiKey}`,
      },
      body: JSON.stringify({ text: "portal" }),
    });

    // Search pipeline is created even without indexer, but may return 503
    // if index DB is not available. Either 200 or 503 is acceptable.
    expect([200, 503]).toContain(res.status);

    if (res.status === 200) {
      const data = (await res.json()) as { results: Array<{ title: string }> };
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
    }
  });

  test("POST /search without auth returns 401", async () => {
    const res = await fetch(`${harness.gatewayUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // SQLite query endpoint
  // -----------------------------------------------------------------------

  test("POST /sql returns valid response for SELECT", async () => {
    const res = await fetch(`${harness.gatewayUrl}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${harness.apiKey}`,
      },
      body: JSON.stringify({ sql: "SELECT COUNT(*) as cnt FROM documents" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      timing: number;
    };
    expect(data.columns).toContain("cnt");
    expect(data.rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof data.timing).toBe("number");
  });

  test("POST /sql blocks write operations at the engine layer", async () => {
    // The keyword block-list is gone; SQLite's
    // read-only handle is the gate. Engine-level rejection means
    // even bypass-shaped scripts (CTE-with-mutation, leading
    // comments, multi-statement) get refused with a SQLite error.
    const res = await fetch(`${harness.gatewayUrl}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${harness.apiKey}`,
      },
      body: JSON.stringify({ sql: "DROP TABLE documents" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/readonly|read-only|cannot.*write|syntax error/i);
  });

  test("SPA fallback: /portal/sql returns index.html", async () => {
    const res = await fetch(`${harness.gatewayUrl}/portal/sql`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("app.js");
  });
});
