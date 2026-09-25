// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  _iconNormalizerCacheSize,
  _requestPinnedIconForTest,
  _resetIconNormalizerCache,
  _shutdownIconRasterizeWorker,
  normalizeIcon,
} from "./icon-normalizer.js";
import { SOURCE_ICON_MAX_BYTES } from "./icon-limits.js";
import type { AddressInfo } from "node:net";

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=";
const SAMPLE_PNG_DATA_URI = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#FF0000"/></svg>`;
const SAMPLE_SVG_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(SAMPLE_SVG).toString("base64")}`;
const publicLookup = async () => [{ address: "203.0.113.10", family: 4 as const }];
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 as const }];

afterEach(() => {
  _resetIconNormalizerCache();
});

afterAll(async () => {
  // Tear down the lazily-spawned rasterize worker so vitest exits cleanly.
  await _shutdownIconRasterizeWorker();
});

describe("normalizeIcon", () => {
  it("returns null for empty/null input", async () => {
    expect(await normalizeIcon(null)).toBeNull();
    expect(await normalizeIcon(undefined)).toBeNull();
    expect(await normalizeIcon("")).toBeNull();
    expect(await normalizeIcon("   ")).toBeNull();
  });

  it("passes PNG data URIs through unchanged", async () => {
    const out = await normalizeIcon(SAMPLE_PNG_DATA_URI);
    expect(out).toBe(SAMPLE_PNG_DATA_URI);
  });

  it("passes JPEG/GIF/WebP data URIs through unchanged", async () => {
    const jpeg = "data:image/jpeg;base64,/9j/abc";
    const gif = "data:image/gif;base64,R0lGOD";
    const webp = "data:image/webp;base64,UklGR";
    expect(await normalizeIcon(jpeg)).toBe(jpeg);
    expect(await normalizeIcon(gif)).toBe(gif);
    expect(await normalizeIcon(webp)).toBe(webp);
  });

  it("rasterizes base64 SVG data URIs to PNG data URIs", async () => {
    const out = await normalizeIcon(SAMPLE_SVG_DATA_URI);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^data:image\/png;base64,/);
    const base64 = out!.slice("data:image/png;base64,".length);
    const bytes = Buffer.from(base64, "base64");
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  it("rasterizes inline-utf8 SVG data URIs", async () => {
    const inline = `data:image/svg+xml,${encodeURIComponent(SAMPLE_SVG)}`;
    const out = await normalizeIcon(inline);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^data:image\/png;base64,/);
  });

  it("wraps legacy bare-base64 PNGs with the canonical data URI prefix", async () => {
    const out = await normalizeIcon(SAMPLE_PNG_BASE64);
    expect(out).toBe(SAMPLE_PNG_DATA_URI);
  });

  it("rejects opaque non-PNG bare strings", async () => {
    expect(await normalizeIcon("not a real icon")).toBeNull();
  });

  it("rejects oversized raster, SVG, and legacy-base64 inputs", async () => {
    const oversizedPayload = "A".repeat(Math.ceil(((SOURCE_ICON_MAX_BYTES + 1) * 4) / 3));
    expect(await normalizeIcon(`data:image/png;base64,${oversizedPayload}`)).toBeNull();
    expect(await normalizeIcon(`data:image/svg+xml;base64,${oversizedPayload}`)).toBeNull();
    expect(await normalizeIcon(`${SAMPLE_PNG_BASE64}${oversizedPayload}`)).toBeNull();
  });

  it("fetches HTTP URLs and converts SVG responses to PNG data URIs", async () => {
    const fetcher = (async () => {
      return new Response(SAMPLE_SVG, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    }) as unknown as typeof fetch;
    const out = await normalizeIcon("https://example.com/logo.svg", fetcher, publicLookup);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^data:image\/png;base64,/);
  });

  it("fetches HTTP URLs and re-encodes PNG responses as PNG data URIs", async () => {
    const pngBytes = Buffer.from(SAMPLE_PNG_BASE64, "base64");
    let requestInit: RequestInit | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      requestInit = init;
      if (new Headers(init?.headers).get("user-agent") !== "omnesis-gateway/icon-normalizer") {
        return new Response("", { status: 403 });
      }
      return new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const out = await normalizeIcon("https://example.com/logo.png", fetcher, publicLookup);
    expect(out).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
    expect(new Headers(requestInit?.headers).get("user-agent")).toBe(
      "omnesis-gateway/icon-normalizer",
    );
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the pinned native transport with the icon User-Agent and no connection reuse", async () => {
    let seenUserAgent: string | undefined;
    let seenHost: string | undefined;
    let seenConnection: string | undefined;
    const server = createServer((req, res) => {
      seenUserAgent = req.headers["user-agent"];
      seenHost = req.headers.host;
      seenConnection = req.headers.connection;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(SAMPLE_PNG_BASE64, "base64"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await _requestPinnedIconForTest(
        `http://unresolvable.example:${port}/icon.png`,
        "127.0.0.1",
        4,
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from(SAMPLE_PNG_BASE64, "base64"),
      );
      expect(seenUserAgent).toBe("omnesis-gateway/icon-normalizer");
      expect(seenHost).toBe(`unresolvable.example:${port}`);
      expect(seenConnection).toBe("close");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("treats Content-Type-less responses with leading '<' as SVG", async () => {
    const fetcher = (async () => {
      return new Response(SAMPLE_SVG, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;
    const out = await normalizeIcon("https://example.com/logo", fetcher, publicLookup);
    expect(out).toMatch(/^data:image\/png;base64,/);
  });

  it("returns null for HTTP errors", async () => {
    const fetcher = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await normalizeIcon("https://nope.example/x.svg", fetcher, publicLookup)).toBeNull();
  });

  it("rejects direct and DNS-resolved non-public destinations before fetching", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(Buffer.from(SAMPLE_PNG_BASE64, "base64"), {
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    expect(await normalizeIcon("http://127.0.0.1/icon.png", fetcher, publicLookup)).toBeNull();
    expect(
      await normalizeIcon("https://internal.example/icon.png", fetcher, privateLookup),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("revalidates redirect destinations before fetching them", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/icon.png" },
      });
    }) as unknown as typeof fetch;

    expect(await normalizeIcon("https://example.com/icon.png", fetcher, publicLookup)).toBeNull();
    expect(calls).toBe(1);
  });

  it("cancels redirect bodies and detects the final response format", async () => {
    let redirectCanceled = false;
    let calls = 0;
    const pngBytes = Buffer.from(SAMPLE_PNG_BASE64, "base64");
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel: () => {
              redirectCanceled = true;
            },
          }),
          { status: 302, headers: { location: "/logo.png" } },
        );
      }
      return new Response(pngBytes, {
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const out = await normalizeIcon("https://example.com/logo.svg", fetcher, publicLookup);
    expect(out).toBe(SAMPLE_PNG_DATA_URI);
    expect(redirectCanceled).toBe(true);
    expect(calls).toBe(2);
  });

  it("rejects declared and streamed bodies larger than the icon limit", async () => {
    const declaredOversize = (async () =>
      new Response("small", {
        headers: { "content-length": "1048577", "content-type": "image/png" },
      })) as unknown as typeof fetch;
    expect(
      await normalizeIcon("https://example.com/declared.png", declaredOversize, publicLookup),
    ).toBeNull();

    const streamedOversize = (async () =>
      new Response(new Uint8Array(1_048_577), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    expect(
      await normalizeIcon("https://example.com/streamed.png", streamedOversize, publicLookup),
    ).toBeNull();
  });

  it("memoizes successful URL fetches per process", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(SAMPLE_SVG, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    }) as unknown as typeof fetch;
    const url = "https://example.com/cache-me.svg";
    await normalizeIcon(url, fetcher, publicLookup);
    await normalizeIcon(url, fetcher, publicLookup);
    expect(calls).toBe(1);
  });

  it("evicts oldest URL entries when the LRU cap is exceeded", async () => {
    // Fill the memo past its 256-entry cap with successful URL fetches and
    // assert the cache stays bounded. Use a PNG-returning fetcher so we
    // exercise the cache layer without the 30-50ms-per-call SVG rasterize
    // overhead — the LRU policy is shape-agnostic, the test just needs
    // to drive the memo size past the cap.
    let calls = 0;
    const pngBytes = Buffer.from(SAMPLE_PNG_BASE64, "base64");
    const fetcher = (async () => {
      calls += 1;
      return new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    // Drive the memo just past 256 — assert it stops growing.
    for (let i = 0; i < 260; i += 1) {
      await normalizeIcon(`https://example.com/icon-${i}.png`, fetcher, publicLookup);
    }
    expect(calls).toBe(260);
    expect(_iconNormalizerCacheSize()).toBeLessThanOrEqual(256);
    // The earliest URL should have been evicted; a re-fetch hits the
    // network again rather than returning the stale cached promise.
    const before = calls;
    await normalizeIcon("https://example.com/icon-0.png", fetcher, publicLookup);
    expect(calls).toBe(before + 1);
  });

  it("does NOT memoize failures (allows retry on next push)", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const url = "https://example.com/will-retry.svg";
    expect(await normalizeIcon(url, fetcher, publicLookup)).toBeNull();
    expect(await normalizeIcon(url, fetcher, publicLookup)).toBeNull();
    expect(calls).toBe(2);
  });
});
