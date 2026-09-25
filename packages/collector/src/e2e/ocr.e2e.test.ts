// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OCR E2E — the collector↔gateway recognition round-trip against a real spawned
 * gateway.
 *
 * This is the contract the shared attachment extractor relies on to turn an
 * image / scanned PDF into searchable text: the collector's `GatewayClient.ocr`
 * POSTs the image bytes to the gateway's `/inference/ocr`, which runs the
 * assigned OCR backend and returns the recognized text. We boot the gateway with
 * `ocrBackend: "replay"` — the deterministic synthetic backend that decodes the
 * bytes as UTF-8 — so the whole path (real HTTP, auth scope, InferenceRegistry
 * resolution, OcrService, capability) is exercised without an OCR model or any
 * native dependency.
 *
 * The shared-extractor seam (image branch + scanned-PDF fallback) is covered by
 * the collector unit tests; this proves the gateway-side service end-to-end.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { SyntheticE2EHarness } from "./synth-harness.js";

describe("OCR round-trip (E2E)", () => {
  let harness: SyntheticE2EHarness;
  let client: HttpGatewayClient;
  const enc = (s: string) => new TextEncoder().encode(s);

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", ocrBackend: "replay" });
    await harness.start();
    client = new HttpGatewayClient(harness.gatewayUrl, harness.apiKey);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("recognizes image bytes through the gateway", async () => {
    const result = await client.ocr(enc("INVOICE #42\nTotal: $128.00"), "image/png");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("INVOICE #42\nTotal: $128.00");
  });

  test("round-trips multi-line recognized text verbatim", async () => {
    const text = "Receipt\nStudio Northstar\nTotal: $42.00\nThanks, Maya Reeves";
    const result = await client.ocr(enc(text), "image/jpeg");
    expect(result?.text).toBe(text);
  });

  test("forwards a language hint as a query parameter", async () => {
    const result = await client.ocr(enc("bonjour le monde"), "image/png", { language: "fr" });
    expect(result?.text).toBe("bonjour le monde");
    expect(result?.language).toBe("fr");
  });
});
