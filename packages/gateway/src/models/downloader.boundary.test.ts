// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary tests for the resumable downloader's resume-vs-restart decision.
 *
 * The decision pivots on the exact relationship between the on-disk
 * `.partial` size and the catalog's `sizeBytes`:
 *
 *   size > 0 && size <  sizeBytes  → RESUME  (Range: bytes=size-, append)
 *   size           >= sizeBytes    → RESTART (delete stale partial, full GET)
 *
 * The seam under test is the `<` comparison on the resume guard. The
 * fixtures below pin the EXACT equality boundary (size === sizeBytes) and
 * one byte on each side, so that the resume/restart branch selection — and
 * therefore the Range header, the write mode, and the resulting digest —
 * differ observably if the comparison is loosened to `<=` or tightened.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startDownload, type DownloadProgress } from "./downloader.js";
import type { GgufCatalogEntry } from "@omnesis/core";

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-dl-boundary-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

const FILENAME = "boundary-embed-model.gguf";

/** Build a GGUF catalog entry pinned to a given size and (optional) sha. */
function entryFor(sizeBytes: number, sha256?: string): GgufCatalogEntry {
  return {
    kind: "gguf",
    id: "boundary-embed-model",
    name: "Boundary Embed Model",
    roles: ["embed"],
    author: "Stellar Sound",
    license: "Apache-2.0",
    description: "Fictional embedder used only in boundary tests.",
    filename: FILENAME,
    downloadUrl: "https://models.example.com/boundary-embed-model.gguf",
    sizeBytes,
    ...(sha256 ? { sha256 } : {}),
  };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const noProgress = (_p: DownloadProgress): void => {};

/**
 * Install a fetch stub that records the Range request header and serves
 * `served` at the given status. The 200 path means "full GET" — exactly
 * what the RESTART branch produces (no Range, write-from-scratch).
 */
function stubFetchServing(served: Buffer, status = 200): { rangeHeader: () => string | null } {
  let captured: string | null = "unset";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured = new Headers(init?.headers).get("range");
    return new Response(new Uint8Array(served), {
      status,
      headers: { "content-length": String(served.byteLength) },
    });
  }) as typeof globalThis.fetch;
  return { rangeHeader: () => captured };
}

describe("startDownload — resume-vs-restart boundary (size === sizeBytes)", () => {
  it("RESTARTS from scratch when the partial size EQUALS the catalog size", async () => {
    // The legitimate, full payload the catalog describes.
    const fullBytes = Buffer.from(
      "GGUF-HEADER:jamie-lopez-embedder-weights-payload-block-0123456789",
      "utf8",
    );
    // A STALE partial with DIFFERENT bytes but EXACTLY the catalog size.
    // This is the case the `<` boundary must reject as "not resumable":
    // an equal-size partial is treated as stale and overwritten, never
    // appended to. (`<=` would instead resume, append past it, and hash
    // stale+served — a corrupt blob.)
    const stalePartial = Buffer.alloc(fullBytes.byteLength, 0x5a); // all 'Z'
    expect(stalePartial.byteLength).toBe(fullBytes.byteLength);
    writeFileSync(join(dir, `${FILENAME}.partial`), stalePartial);

    // Pin the sha to the legitimate full bytes. On the correct (`<`) code
    // the restart fetches a clean full GET whose digest matches → resolves.
    // On the mutated (`<=`) code the resume path would append served bytes
    // onto the stale partial and hash stale+served → sha_mismatch reject.
    const entry = entryFor(fullBytes.byteLength, sha256Hex(fullBytes));
    const { rangeHeader } = stubFetchServing(fullBytes, 200);

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    const info = await handle.done;

    // RESTART branch: a plain full GET — no Range header at all. The `<=`
    // mutant would have sent `bytes=<size>-` to resume past the equal-size
    // partial.
    expect(rangeHeader()).toBeNull();

    // The digest covers ONLY the freshly served full bytes — the stale
    // partial was discarded, not appended to.
    expect(info.sha256).toBe(sha256Hex(fullBytes));
    expect(info.sizeBytes).toBe(fullBytes.byteLength);

    // Final file is exactly the served bytes (length == sizeBytes, content
    // == fullBytes). Under the mutant it would be stale+served (twice the
    // size) and the sha check would have rejected before reaching here.
    const finalPath = join(dir, FILENAME);
    expect(existsSync(finalPath)).toBe(true);
    const onDisk = readFileSync(finalPath);
    expect(onDisk.byteLength).toBe(fullBytes.byteLength);
    expect(onDisk.equals(fullBytes)).toBe(true);
    expect(existsSync(join(dir, `${FILENAME}.partial`))).toBe(false);
  });

  it("RESUMES when the partial size is exactly ONE byte below the catalog size", async () => {
    // The other side of the `<` boundary: size === sizeBytes - 1 is still
    // strictly less than the catalog size, so the resume branch fires and
    // a Range header for the single missing tail byte is sent.
    const fullBytes = Buffer.from(
      "GGUF-HEADER:david-lin-embedder-weights-payload-block-abcdef987654",
      "utf8",
    );
    const prefixLen = fullBytes.byteLength - 1; // sizeBytes - 1
    const prefix = fullBytes.subarray(0, prefixLen);
    const tail = fullBytes.subarray(prefixLen); // exactly one byte
    expect(tail.byteLength).toBe(1);

    writeFileSync(join(dir, `${FILENAME}.partial`), prefix);
    const entry = entryFor(fullBytes.byteLength, sha256Hex(fullBytes));

    let sawRange: string | null = "unset";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawRange = new Headers(init?.headers).get("range");
      // 206 Partial Content carrying only the missing tail byte.
      return new Response(new Uint8Array(tail), {
        status: 206,
        headers: { "content-length": String(tail.byteLength) },
      });
    }) as typeof globalThis.fetch;

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    const info = await handle.done;

    // Resume requested exactly the tail starting at sizeBytes - 1.
    expect(sawRange).toBe(`bytes=${prefixLen}-`);
    // Digest covers prefix + tail == the whole file.
    expect(info.sha256).toBe(sha256Hex(fullBytes));
    expect(readFileSync(join(dir, FILENAME)).equals(fullBytes)).toBe(true);
  });

  it("RESTARTS when the partial size is exactly ONE byte ABOVE the catalog size", async () => {
    // size === sizeBytes + 1 is on the >= side: an over-long stale partial
    // is deleted and a fresh full GET runs. Together with the equality case
    // above this fully brackets the `<`/`>=` split.
    const fullBytes = Buffer.from(
      "GGUF-HEADER:sarah-mendez-embedder-weights-payload-block-feedface11",
      "utf8",
    );
    const overlong = Buffer.alloc(fullBytes.byteLength + 1, 0x42); // all 'B'
    writeFileSync(join(dir, `${FILENAME}.partial`), overlong);

    const entry = entryFor(fullBytes.byteLength, sha256Hex(fullBytes));
    const { rangeHeader } = stubFetchServing(fullBytes, 200);

    const handle = startDownload(entry, { modelsDir: dir, onProgress: noProgress });
    const info = await handle.done;

    expect(rangeHeader()).toBeNull();
    expect(info.sha256).toBe(sha256Hex(fullBytes));
    const onDisk = readFileSync(join(dir, FILENAME));
    expect(onDisk.byteLength).toBe(fullBytes.byteLength);
    expect(onDisk.equals(fullBytes)).toBe(true);
  });
});
