// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, test, expect, vi } from "vitest";
import { HttpVlmOcr, OCR_PROMPT } from "./http-vlm-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

afterEach(() => vi.useRealTimers());

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: Array<{
      content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }>;
  };
}

function capturingFetch(text: string, ok = true, status = 200) {
  const captured: CapturedRequest[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return {
      ok,
      status,
      json: async () => ({ choices: [{ message: { content: text } }] }),
      text: async () => text,
    } as unknown as Response;
  };
  return { captured, fetchFn };
}

describe("HttpVlmOcr", () => {
  test("posts an image_url data URL + the OCR prompt to /v1/chat/completions", async () => {
    const { captured, fetchFn } = capturingFetch("Hello world");
    const ocr = new HttpVlmOcr({ url: "http://localhost:8000/", model: "dots.ocr", fetchFn });
    const result = await ocr.recognize(enc("PNGDATA"), "image/png");

    expect(result.text).toBe("Hello world");
    expect(captured[0].url).toBe("http://localhost:8000/v1/chat/completions");
    expect(captured[0].body.model).toBe("dots.ocr");
    const parts = captured[0].body.messages[0].content;
    expect(parts.find((p) => p.type === "text")?.text).toBe(OCR_PROMPT);
    const img = parts.find((p) => p.type === "image_url")?.image_url?.url ?? "";
    expect(img.startsWith("data:image/png;base64,")).toBe(true);
    expect(img).toContain(Buffer.from("PNGDATA").toString("base64"));
  });

  test("sends a bearer token when an apiKey is configured", async () => {
    const { captured, fetchFn } = capturingFetch("x");
    const ocr = new HttpVlmOcr({
      url: "http://localhost:18088",
      model: "m",
      apiKey: "secret",
      fetchFn,
    });
    await ocr.recognize(enc("i"), "image/png");
    expect(captured[0].headers["Authorization"]).toBe("Bearer secret");
  });

  test("trims the model's reply", async () => {
    const { fetchFn } = capturingFetch("  spaced text \n");
    const ocr = new HttpVlmOcr({ url: "http://localhost:18088", model: "m", fetchFn });
    expect((await ocr.recognize(enc("i"), "image/png")).text).toBe("spaced text");
  });

  test("throws on 502/503/504 (backend unavailable — transient, route surfaces it)", async () => {
    for (const status of [502, 503, 504]) {
      const { fetchFn } = capturingFetch("backend down", false, status);
      const ocr = new HttpVlmOcr({ url: "http://localhost:18088", model: "m", fetchFn });
      await expect(ocr.recognize(enc("i"), "image/png")).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
    }
  });

  test("retries rate limits and treats an exhausted 429 as transient", async () => {
    vi.useFakeTimers();
    const success = new Response(
      JSON.stringify({ choices: [{ message: { content: "recovered" } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(success);
    const ocr = new HttpVlmOcr({ url: "http://localhost:18088", model: "m", fetchFn });
    const recovered = ocr.recognize(enc("i"), "image/png");
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(recovered).resolves.toEqual({ text: "recovered" });
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const alwaysLimited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("limited", { status: 429 }));
    const exhausted = new HttpVlmOcr({
      url: "http://localhost:18088",
      model: "m",
      fetchFn: alwaysLimited,
    });
    // The rejection is observed before the timers that produce it advance, so it
    // is never momentarily unhandled.
    const terminal = expect(exhausted.recognize(enc("i"), "image/png")).rejects.toThrow(/HTTP 429/);
    await vi.waitFor(() => expect(alwaysLimited).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(alwaysLimited).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await terminal;
    expect(alwaysLimited).toHaveBeenCalledTimes(3);
  });

  test("never exposes an upstream OCR error body", async () => {
    const privateEcho = "PRIVATE-IMAGE-TEXT-marker";
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(privateEcho, { status: 429, headers: { "Retry-After": "30" } }),
      );
    const ocr = new HttpVlmOcr({
      url: "http://localhost:18088",
      model: "m",
      fetchFn: limited,
    });
    await expect(ocr.recognize(enc("i"), "image/png")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(privateEcho) }),
    );

    const badImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(privateEcho, { status: 400 }));
    const nonTransient = new HttpVlmOcr({
      url: "http://localhost:18088",
      model: "m",
      fetchFn: badImage,
    });
    await expect(nonTransient.recognize(enc("i"), "image/png")).resolves.toEqual({ text: "" });
  });

  test("a 4xx (undecodable image) returns empty text instead of throwing", async () => {
    const { fetchFn } = capturingFetch("cannot identify image file", false, 400);
    const ocr = new HttpVlmOcr({ url: "http://localhost:18088", model: "m", fetchFn });
    const result = await ocr.recognize(enc("weird"), "image/tiff");
    expect(result.text).toBe(""); // per-image dead end, not a server fault
  });

  test("a 500 the model returns (PIL can't decode) returns empty text, not a throw", async () => {
    // dots.ocr/vLLM raise an unhandled error → HTTP 500 when PIL can't decode an
    // image (SVG/HEIC/corrupt). The backend is reachable; this input is a
    // per-image dead end. Returning "" lets the sync skip the file instead of
    // the 500 being treated as transient and retried forever (the OneDrive bug).
    const { fetchFn } = capturingFetch(
      '{"object":"error","message":"cannot identify image file"}',
      false,
      500,
    );
    const ocr = new HttpVlmOcr({ url: "http://localhost:18088", model: "dots.ocr", fetchFn });
    const result = await ocr.recognize(enc("svgbytes"), "image/svg+xml");
    expect(result.text).toBe("");
  });

  test("dispose is a no-op", async () => {
    await expect(
      new HttpVlmOcr({ url: "http://localhost:18088", model: "m" }).dispose(),
    ).resolves.toBeUndefined();
  });
});
