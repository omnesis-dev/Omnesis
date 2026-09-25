// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { iconFor, makeSourceMetaCache, type CliFx, type SourceMeta } from "./terminal-fx.js";

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=";

const fxImages = (meta: CliFx["meta"]): CliFx => ({
  images: true,
  hyperlinks: false,
  meta,
});

describe("iconFor", () => {
  it("returns empty string when fx.images is false", () => {
    const fx: CliFx = { images: false, hyperlinks: false, meta: {} };
    expect(iconFor("gmail:user@gmail.com", fx)).toBe("");
  });

  it("returns whitespace placeholder when no entry exists", () => {
    expect(iconFor("unknown", fxImages({}))).toBe("  ");
  });

  it("strips data: prefix and emits raw base64 inside iTerm OSC 1337", () => {
    const out = iconFor(
      "gmail:user@gmail.com",
      fxImages({
        "gmail:user@gmail.com": { icon: `data:image/png;base64,${SAMPLE_PNG_BASE64}` },
      }),
    );
    expect(out).toContain(SAMPLE_PNG_BASE64);
    expect(out).not.toContain("data:image");
    expect(out.startsWith("\x1b]1337;File=")).toBe(true);
    expect(out.endsWith("\x07")).toBe(true);
  });

  it("falls back to source-type entry when full ID is missing", () => {
    const out = iconFor(
      "gmail:user@gmail.com",
      fxImages({
        gmail: { icon: `data:image/png;base64,${SAMPLE_PNG_BASE64}` },
      }),
    );
    expect(out).toContain(SAMPLE_PNG_BASE64);
  });

  it("accepts JPEG/GIF data URIs and strips their prefix the same way", () => {
    const jpegBase64 = "/9j/abc==";
    const out = iconFor(
      "foo:bar",
      fxImages({
        "foo:bar": { icon: `data:image/jpeg;base64,${jpegBase64}` },
      }),
    );
    expect(out).toContain(jpegBase64);
    expect(out).not.toContain("data:image");
  });

  it("returns whitespace for an unrasterized HTTP URL (avoids garbage OSC bytes)", () => {
    const out = iconFor(
      "foo:bar",
      fxImages({
        "foo:bar": { icon: "https://example.com/logo.svg" },
      }),
    );
    expect(out).toBe("  ");
  });

  it("passes legacy bare-base64 PNGs through unchanged", () => {
    const out = iconFor(
      "foo:bar",
      fxImages({
        "foo:bar": { icon: SAMPLE_PNG_BASE64 },
      }),
    );
    expect(out).toContain(SAMPLE_PNG_BASE64);
  });

  it("ignores entries without ;base64 in their data URI header", () => {
    const out = iconFor(
      "foo:bar",
      fxImages({
        "foo:bar": { icon: "data:image/svg+xml,<svg/>" },
      }),
    );
    expect(out).toBe("  ");
  });
});

describe("makeSourceMetaCache", () => {
  function makeResponse(body: SourceMeta, ok = true): Response {
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  }

  it("fetches once and serves the cached result on subsequent calls", async () => {
    const cache = makeSourceMetaCache();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return makeResponse({ gmail: { icon: "data:image/png;base64,abc" } });
    };
    const a = await cache.get(fetcher);
    const b = await cache.get(fetcher);
    expect(calls).toBe(1);
    expect(a).toBe(b); // identity — same cached object
  });

  it("clear() forces a re-fetch", async () => {
    const cache = makeSourceMetaCache();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return makeResponse({ [`call-${calls}`]: { icon: "x" } });
    };
    const first = await cache.get(fetcher);
    cache.clear();
    const second = await cache.get(fetcher);
    expect(calls).toBe(2);
    expect(first).not.toBe(second);
  });

  it("settles to {} on a non-OK response", async () => {
    const cache = makeSourceMetaCache();
    const got = await cache.get(async () => makeResponse({}, false));
    expect(got).toEqual({});
  });

  it("settles to {} when the fetcher throws", async () => {
    const cache = makeSourceMetaCache();
    const got = await cache.get(async () => {
      throw new Error("boom");
    });
    expect(got).toEqual({});
  });

  it("two cache instances are independent", async () => {
    const a = makeSourceMetaCache();
    const b = makeSourceMetaCache();
    const fetcherA = async () => makeResponse({ a: { icon: "x" } });
    const fetcherB = async () => makeResponse({ b: { icon: "y" } });
    expect(await a.get(fetcherA)).toEqual({ a: { icon: "x" } });
    expect(await b.get(fetcherB)).toEqual({ b: { icon: "y" } });
  });
});
