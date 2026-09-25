// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { classifyEmbedError, embedErrorMarkerFromBody } from "./embed-failures.js";

describe("classifyEmbedError", () => {
  test("HTTP embedder token-limit overflow → overflow", () => {
    const err = new Error(
      'HTTP embedder 400: {"error":{"message":"This model\'s maximum context length is ' +
        "2048 tokens. However, you requested 0 output tokens and your prompt contains at " +
        'least 2049 input tokens"}}',
    );
    expect(classifyEmbedError(err)).toBe("overflow");
  });

  test("local llama-cpp context overflow → overflow", () => {
    const err = new Error(
      "Input is longer than the context size. Try to increase the context size or use " +
        "another model that supports longer contexts.",
    );
    expect(classifyEmbedError(err)).toBe("overflow");
  });

  test("HTTP embedder TextEncodeInput tokenizer reject → malformed", () => {
    const err = new Error(
      'HTTP embedder 400: {"error":{"message":"TextEncodeInput must be ' +
        'Union[TextInputSequence, Tuple[InputSequence, InputSequence]]","type":"BadRequestError"}}',
    );
    expect(classifyEmbedError(err)).toBe("malformed");
  });

  test("timeout → transient", () => {
    expect(classifyEmbedError(new Error("The operation was aborted due to timeout"))).toBe(
      "transient",
    );
    expect(
      classifyEmbedError(new Error("embedding timed out after 30000ms (input 5000 chars)")),
    ).toBe("transient");
  });

  test("network failure → transient", () => {
    expect(classifyEmbedError(new Error("fetch failed"))).toBe("transient");
  });

  test("server 5xx → transient", () => {
    expect(classifyEmbedError(new Error("HTTP embedder 503: service unavailable"))).toBe(
      "transient",
    );
  });

  test("unrecognised error → transient (never silently drops content)", () => {
    expect(classifyEmbedError(new Error("something unexpected"))).toBe("transient");
    expect(classifyEmbedError("plain string")).toBe("transient");
    expect(classifyEmbedError(undefined)).toBe("transient");
  });
});

describe("embedErrorMarkerFromBody", () => {
  test("returns the fixed overflow marker for a vLLM token-limit body", () => {
    const body = '{"error":{"message":"This model\'s maximum context length is 2048 tokens."}}';
    expect(embedErrorMarkerFromBody(body)).toBe("maximum context length");
  });

  test("returns the malformed marker for a tokenizer-reject body", () => {
    expect(embedErrorMarkerFromBody("TextEncodeInput must be Union[...]")).toBe("TextEncodeInput");
  });

  test("returns null for a body with no recognised marker (stays transient)", () => {
    expect(embedErrorMarkerFromBody("503 service unavailable")).toBeNull();
    expect(embedErrorMarkerFromBody("")).toBeNull();
  });

  test("returns only the fixed marker, never surrounding body content", () => {
    const marker = embedErrorMarkerFromBody("SENSITIVE-CHUNK: maximum context length exceeded");
    expect(marker).toBe("maximum context length");
    expect(marker).not.toContain("SENSITIVE");
  });
});
