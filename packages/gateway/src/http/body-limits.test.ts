// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_INGEST_BODY_LIMIT_BYTES,
  DOCUMENTS_BODY_LIMIT_BYTES,
  LARGEST_DOCUMENT_BYTES,
  ingestBodyLimit,
} from "./body-limits.js";

describe("ingestBodyLimit", () => {
  const app = new Hono();
  app.post("/ingest", ingestBodyLimit(64), async (c) =>
    c.json({ ok: true, size: (await c.req.text()).length }),
  );

  it("passes a body under the ceiling through untouched", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "20" },
      body: JSON.stringify({ documents: [1] }),
    });
    expect(res.status).toBe(200);
  });

  it("refuses an oversized body with a JSON 413 before the handler runs", async () => {
    const body = "x".repeat(65);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": String(body.length) },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "Request body too large (max 0.0 MiB)",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("refuses a chunked body with no Content-Length once it grows past the ceiling", async () => {
    // The hostile-client shape: no declared length, so the middleware must
    // count bytes as they stream in rather than trust a header.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("y".repeat(40)));
        controller.enqueue(new TextEncoder().encode("y".repeat(40)));
        controller.close();
      },
    });
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      // @ts-expect-error -- undici requires duplex for a streaming request body.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  it("keeps the ingest ceilings above the largest legitimate request", () => {
    // Several documents at the single-document cap must fit in one request
    // with JSON overhead to spare; the client also splits batches by size.
    expect(DOCUMENTS_BODY_LIMIT_BYTES).toBeGreaterThan(2 * LARGEST_DOCUMENT_BYTES);
    expect(ANALYTICS_INGEST_BODY_LIMIT_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
