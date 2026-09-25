// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { OcrService } from "./ocr-service.js";
import type { ResolvedAssignment } from "@omnesis/core";

const enc = (s: string) => new TextEncoder().encode(s);

// Real PNG magic bytes + payload, so the OCR service's content guard (which
// only forwards a decodable raster to an http/local image-loader backend)
// admits these fixtures. The backend mocks ignore the payload.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (s = "") => new Uint8Array([...PNG_SIG, ...new TextEncoder().encode(s), 0, 0, 0, 0]);

const disabled: ResolvedAssignment = { role: "ocr", kind: "disabled" };
const replay: ResolvedAssignment = { role: "ocr", kind: "replay" };
const localUnavailable: ResolvedAssignment = {
  role: "ocr",
  kind: "local",
  catalogId: "apple-vision",
  modelPath: "",
  available: false,
  reason: "not on macOS",
  nativeRuntime: "apple-vision",
};

function http(model = "dots.ocr", available = true): ResolvedAssignment {
  return {
    role: "ocr",
    kind: "http",
    backendKey: "vllm",
    model,
    url: "http://localhost:8000",
    allowRemoteInference: false,
    available,
  };
}

/** A fake OpenAI-compatible response carrying `text` as the message content. */
function chatResponse(text: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
    text: async () => "",
  } as unknown as Response;
}

describe("OcrService", () => {
  test("returns null when OCR is disabled", async () => {
    const svc = new OcrService({ resolveAssignment: () => disabled });
    expect(await svc.recognize(enc("x"), "image/png")).toBeNull();
  });

  test("returns null when a local backend is assigned but unavailable", async () => {
    const svc = new OcrService({ resolveAssignment: () => localUnavailable });
    expect(await svc.recognize(enc("x"), "image/png")).toBeNull();
  });

  test("returns null for a local assignment that isn't a built-in runtime", async () => {
    const svc = new OcrService({
      resolveAssignment: () => ({
        role: "ocr",
        kind: "local",
        catalogId: "some-gguf",
        modelPath: "/m.gguf",
        available: true,
      }),
    });
    expect(await svc.recognize(enc("x"), "image/png")).toBeNull();
  });

  test("OCR is not wired to Anthropic", async () => {
    const svc = new OcrService({
      resolveAssignment: () => ({
        role: "ocr",
        kind: "anthropic",
        catalogId: "anthropic/x",
        apiModelId: "x",
        available: true,
      }),
    });
    expect(await svc.recognize(enc("x"), "image/png")).toBeNull();
  });

  test("recognizes through the synthetic (replay) capability", async () => {
    const svc = new OcrService({ resolveAssignment: () => replay });
    expect((await svc.recognize(enc("a receipt"), "image/png"))?.text).toBe("a receipt");
  });

  test("recognizes through an HTTP vision backend", async () => {
    const svc = new OcrService({
      resolveAssignment: () => http(),
      deps: { fetchFn: async () => chatResponse("INVOICE #42") },
    });
    expect((await svc.recognize(png("img"), "image/png"))?.text).toBe("INVOICE #42");
  });

  test("self-heals when the assignment changes (reloads the backend)", async () => {
    const models: string[] = [];
    let resolved: ResolvedAssignment = http("model-a");
    const svc = new OcrService({
      resolveAssignment: () => resolved,
      deps: {
        fetchFn: async (_url, init) => {
          const body = JSON.parse(String((init as RequestInit).body)) as { model: string };
          models.push(body.model);
          return chatResponse("ok");
        },
      },
    });
    await svc.recognize(png("a"), "image/png");
    resolved = http("model-b");
    await svc.recognize(png("b"), "image/png");
    expect(models).toEqual(["model-a", "model-b"]);
  });

  test("HTTP backend runs concurrent recognitions in parallel (vLLM batches)", async () => {
    let active = 0;
    let maxActive = 0;
    const svc = new OcrService({
      resolveAssignment: () => http(),
      deps: {
        fetchFn: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
          return chatResponse("x");
        },
      },
    });
    await Promise.all([
      svc.recognize(png("1"), "image/png"),
      svc.recognize(png("2"), "image/png"),
      svc.recognize(png("3"), "image/png"),
    ]);
    // Three separate attachments OCR concurrently — the default HTTP limit (12)
    // is well above 3, so all three are in flight at once.
    expect(maxActive).toBe(3);
  });

  test("native subprocess backend serializes recognitions (one at a time)", async () => {
    // A local/native runtime (here Tesseract via an injected module) is
    // serialized: a backend swap mustn't dispose a subprocess mid-use, and we
    // never run two heavy native jobs at once.
    let active = 0;
    let maxActive = 0;
    const fakeTesseract = {
      recognize: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return "text";
      },
    };
    const tesseract: ResolvedAssignment = {
      role: "ocr",
      kind: "local",
      catalogId: "tesseract",
      modelPath: "",
      available: true,
      nativeRuntime: "tesseract",
    };
    const svc = new OcrService({
      resolveAssignment: () => tesseract,
      deps: { loadTesseract: async () => fakeTesseract },
    });
    await Promise.all([
      svc.recognize(png("1"), "image/png"),
      svc.recognize(png("2"), "image/png"),
      svc.recognize(png("3"), "image/png"),
    ]);
    expect(maxActive).toBe(1);
  });

  test("rasterizes a PDF to pages and joins per-page OCR text", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { rasterizePdf: async () => [enc("page one"), enc("page two")] },
    });
    const result = await svc.recognize(enc("%PDF-fake"), "application/pdf");
    expect(result?.text).toBe("page one\n\npage two");
    expect(result?.pages).toBe(2);
    // pageTexts is page-aligned so a caller can interleave with native text.
    expect(result?.pageTexts).toEqual(["page one", "page two"]);
  });

  test("OCRs only the requested PDF pages and returns page-aligned pageTexts", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { rasterizePdf: async () => [enc("page A"), enc("page B"), enc("page C")] },
    });
    // The caller has native text for pages 1 and 3; only page 2 is image-only.
    const result = await svc.recognize(enc("%PDF-fake"), "application/pdf", { pages: [2] });
    expect(result?.pages).toBe(3);
    expect(result?.pageTexts).toEqual(["", "page B", ""]); // only page 2 OCR'd
    expect(result?.text).toBe("page B"); // joined OCR'd pages only
  });

  test("a page-subset request with no recognized text still returns (non-null) page-aligned slots", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { rasterizePdf: async () => [enc(""), enc("")] },
    });
    const result = await svc.recognize(enc("%PDF-fake"), "application/pdf", { pages: [1] });
    expect(result).not.toBeNull(); // page-subset OCR doesn't collapse to null
    expect(result?.pageTexts).toEqual(["", ""]);
  });

  test("whole-PDF OCR with no recognized text returns a non-null empty result", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { rasterizePdf: async () => [enc(""), enc("")] },
    });
    const result = await svc.recognize(enc("%PDF-fake"), "application/pdf");
    expect(result).toMatchObject({ text: "", pages: 2, pageTexts: ["", ""] });
  });

  test("returns null when a PDF can't be rasterized", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { rasterizePdf: async () => null },
    });
    expect(await svc.recognize(enc("%PDF-fake"), "application/pdf")).toBeNull();
  });

  test("transcodes a HEIC image to PNG before handing it to the backend", async () => {
    let transcodeCalled = false;
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: {
        transcodeHeic: async () => {
          transcodeCalled = true;
          return enc("PNG BYTES FROM HEIC"); // replay decodes these as the OCR text
        },
      },
    });
    const result = await svc.recognize(enc("heic-bytes"), "image/heic");
    expect(transcodeCalled).toBe(true);
    // The capability saw the transcoded PNG bytes, not the original HEIC.
    expect(result?.text).toBe("PNG BYTES FROM HEIC");
  });

  test("falls back to the original bytes when HEIC transcoding is unavailable", async () => {
    const svc = new OcrService({
      resolveAssignment: () => replay,
      deps: { transcodeHeic: async () => null }, // no heif-convert
    });
    const result = await svc.recognize(enc("original heic text"), "image/heic");
    expect(result?.text).toBe("original heic text"); // passed through unchanged
  });

  test("skips an undecodable image (SVG) without ever hitting the backend", async () => {
    // The real bug: an SVG (or any non-raster) labelled image/* makes the vLLM
    // image loader crash and reset the connection — a transient "fetch failed"
    // the collector retries forever. The content guard skips it up front so the
    // file is recorded without OCR and the sync moves on.
    let fetchCalled = false;
    const svc = new OcrService({
      resolveAssignment: () => http(),
      deps: {
        fetchFn: async () => {
          fetchCalled = true;
          return chatResponse("should not happen");
        },
      },
    });
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="..."><text>hi</text></svg>',
    );
    expect(await svc.recognize(svg, "image/svg+xml")).toBeNull();
    expect(await svc.recognize(svg, "image/png")).toBeNull(); // lying MIME, still skipped
    expect(fetchCalled).toBe(false);
  });

  test("HTTP backend fans PDF pages out concurrently (continuous batching)", async () => {
    let active = 0;
    let maxActive = 0;
    let markAllStarted!: () => void;
    const allFiveStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    let releasePages!: () => void;
    const pagesMayFinish = new Promise<void>((resolve) => {
      releasePages = resolve;
    });
    const svc = new OcrService({
      resolveAssignment: () => http(),
      deps: {
        rasterizePdf: async () => Array.from({ length: 5 }, (_, i) => enc(`p${i}`)),
        fetchFn: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          if (active === 5) markAllStarted();
          await pagesMayFinish;
          active--;
          return chatResponse("page");
        },
      },
    });
    const recognition = svc.recognize(enc("%PDF-fake"), "application/pdf");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reachedFullFanOut: boolean;
    try {
      reachedFullFanOut = await Promise.race([
        allFiveStarted.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      releasePages();
    }
    await recognition;
    // 5 pages, HTTP default (12) ≥ 5 → all run in one parallel round.
    expect(reachedFullFanOut).toBe(true);
    expect(maxActive).toBe(5);
  });

  test("pageConcurrency override clamps PDF fan-out (even for an HTTP backend)", async () => {
    let active = 0;
    let maxActive = 0;
    const svc = new OcrService({
      resolveAssignment: () => http(),
      deps: {
        getPageConcurrency: () => 2,
        rasterizePdf: async () => Array.from({ length: 6 }, (_, i) => enc(`p${i}`)),
        fetchFn: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
          return chatResponse("page");
        },
      },
    });
    await svc.recognize(enc("%PDF-fake"), "application/pdf");
    expect(maxActive).toBe(2); // operator override caps in-flight pages at 2
  });

  test("dispose tears down the loaded capability", async () => {
    const svc = new OcrService({ resolveAssignment: () => replay });
    await svc.recognize(enc("x"), "image/png");
    await expect(svc.dispose()).resolves.toBeUndefined();
  });
});
