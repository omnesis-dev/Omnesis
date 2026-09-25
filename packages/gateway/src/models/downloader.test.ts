// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startDownload, DownloadError, type DownloadProgress } from "./downloader.js";
import type { GgufCatalogEntry } from "@omnesis/core";

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-dl-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

const FILENAME = "test-embed-model.gguf";

/** Build a GGUF catalog entry pinned to a given size and (optional) sha. */
function entryFor(fullBytes: Buffer, sha256?: string): GgufCatalogEntry {
  return {
    kind: "gguf",
    id: "test-embed-model",
    name: "Test Embed Model",
    roles: ["embed"],
    author: "Stellar Sound",
    license: "Apache-2.0",
    description: "Fictional embedder used only in tests.",
    filename: FILENAME,
    downloadUrl: "https://models.example.com/test-embed-model.gguf",
    sizeBytes: fullBytes.byteLength,
    ...(sha256 ? { sha256 } : {}),
  };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A no-op progress sink that satisfies the required callback. */
const noProgress = (_p: DownloadProgress): void => {};

describe("startDownload — supply-chain integrity", () => {
  it("resumes from a .partial and the final sha covers the whole file", async () => {
    // Full payload the catalog describes. The first chunk is already on
    // disk in a `.partial`; the server must serve only the remainder.
    const fullBytes = Buffer.from(
      "GGUF-HEADER:maya-reeves-embedder-weights-payload-block-0123456789abcdef",
      "utf8",
    );
    const prefixLen = 20;
    const prefix = fullBytes.subarray(0, prefixLen);
    const remainder = fullBytes.subarray(prefixLen);

    // Seed a smaller-than-catalog partial so the resume branch fires.
    writeFileSync(join(dir, `${FILENAME}.partial`), prefix);

    const entry = entryFor(fullBytes, sha256Hex(fullBytes));

    let sawRangeHeader: string | null = null;
    let respondedStatus = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sawRangeHeader = headers.get("range");
      respondedStatus = 206;
      // 206 Partial Content carrying only the bytes past the resume point.
      return new Response(new Uint8Array(remainder), {
        status: 206,
        headers: { "content-length": String(remainder.byteLength) },
      });
    }) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    const info = await handle.done;

    // Resume must have requested only the missing tail.
    expect(sawRangeHeader).toBe(`bytes=${prefixLen}-`);
    expect(respondedStatus).toBe(206);

    // The decisive correctness claim: the digest covers prefix + remainder,
    // i.e. the whole file — not just the freshly-fetched tail.
    expect(info.sha256).toBe(sha256Hex(fullBytes));
    expect(info.sha256).not.toBe(sha256Hex(remainder));
    expect(info.sizeBytes).toBe(fullBytes.byteLength);
    expect(info.downloadedFrom).toBe(entry.downloadUrl);

    // Atomic rename produced the final file with the full bytes; partial gone.
    const finalPath = join(dir, FILENAME);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath).equals(fullBytes)).toBe(true);
    expect(existsSync(join(dir, `${FILENAME}.partial`))).toBe(false);
  });

  it("rejects with code=sha_mismatch and deletes the partial when the pinned hash differs", async () => {
    const served = Buffer.from("tampered-weights-not-what-the-catalog-pinned", "utf8");
    // Pin a sha that does NOT match the served bytes.
    const wrongSha = sha256Hex(Buffer.from("the-legitimate-original-weights", "utf8"));
    const entry = entryFor(served, wrongSha);

    globalThis.fetch = (async () =>
      new Response(new Uint8Array(served), {
        status: 200,
        headers: { "content-length": String(served.byteLength) },
      })) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });

    await expect(handle.done).rejects.toMatchObject({
      name: "DownloadError",
      code: "sha_mismatch",
    });

    // The supply-chain guarantee: a hash mismatch leaves nothing behind —
    // neither the rejected payload as a final file nor a resumable partial
    // that would let a retry "append" onto tampered bytes.
    expect(existsSync(join(dir, `${FILENAME}.partial`))).toBe(false);
    expect(existsSync(join(dir, FILENAME))).toBe(false);
  });

  it("rejects with code=aborted and cleans up the partial when aborted mid-stream", async () => {
    const fullBytes = Buffer.from("first-chunk-then-we-abort-before-the-rest-arrives", "utf8");
    const entry = entryFor(fullBytes); // no pinned sha; we never reach the hash check

    // A body that emits one chunk, then blocks until the download's own
    // AbortSignal fires — at which point it errors the stream. This makes
    // the abort path deterministic without any wall-clock timing.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(fullBytes.subarray(0, 8)));
          const onAbort = () => controller.error(new Error("aborted by signal"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    // Abort after the handle is live; the stream errors in response.
    handle.abort();

    await expect(handle.done).rejects.toMatchObject({
      name: "DownloadError",
      code: "aborted",
    });

    // No straggler partial — the manager relies on this for a clean retry.
    expect(existsSync(join(dir, `${FILENAME}.partial`))).toBe(false);
    expect(existsSync(join(dir, FILENAME))).toBe(false);
  });

  it("rejects with code=http_status on a non-ok, non-206 response", async () => {
    const entry = entryFor(Buffer.from("unused", "utf8"));
    globalThis.fetch = (async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      })) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });

    const err = (await handle.done.catch((e) => e)) as DownloadError;
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe("http_status");
    expect(existsSync(join(dir, FILENAME))).toBe(false);
  });

  it("accepts a fresh 200 download whose bytes match the pinned sha", async () => {
    const fullBytes = Buffer.from("clean-first-time-download-of-the-embedder-weights", "utf8");
    const entry = entryFor(fullBytes, sha256Hex(fullBytes));

    let sawRangeHeader: string | null = "unset";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawRangeHeader = new Headers(init?.headers).get("range");
      return new Response(new Uint8Array(fullBytes), {
        status: 200,
        headers: { "content-length": String(fullBytes.byteLength) },
      });
    }) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    const info = await handle.done;

    // No partial on disk → no Range header → a plain full GET.
    expect(sawRangeHeader).toBeNull();
    expect(info.sha256).toBe(sha256Hex(fullBytes));
    expect(readFileSync(join(dir, FILENAME)).equals(fullBytes)).toBe(true);
    expect(existsSync(join(dir, `${FILENAME}.partial`))).toBe(false);
  });
});
