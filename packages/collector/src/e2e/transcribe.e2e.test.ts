// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Speech-to-text E2E — the collector↔gateway transcription round-trip against
 * a real spawned gateway.
 *
 * This is the contract a source (e.g. WhatsApp) relies on to turn a voice note
 * into searchable text: the collector's `GatewayClient.transcribe` POSTs the
 * audio bytes to the gateway's `/inference/transcribe`, which runs the assigned
 * transcriber and returns the transcript. We boot the gateway with
 * `transcriberBackend: "replay"` — the deterministic synthetic transcriber that
 * decodes the bytes as UTF-8 — so the whole path (real HTTP, auth scope,
 * InferenceRegistry resolution, TranscribeService, capability) is exercised
 * without a Whisper model or any native dependency.
 *
 * The WhatsApp-specific inline injection + transcript persistence is covered by
 * the provider unit tests; this proves the gateway-side service end-to-end.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { SyntheticE2EHarness } from "./synth-harness.js";

describe("speech-to-text round-trip (E2E)", () => {
  let harness: SyntheticE2EHarness;
  let client: HttpGatewayClient;
  const enc = (s: string) => new TextEncoder().encode(s);

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", transcriberBackend: "replay" });
    await harness.start();
    client = new HttpGatewayClient(harness.gatewayUrl, harness.apiKey);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("transcribes audio bytes through the gateway", async () => {
    const result = await client.transcribe(
      enc("could you send the contract by friday"),
      "audio/ogg; codecs=opus",
    );
    expect(result).not.toBeNull();
    expect(result?.text).toBe("could you send the contract by friday");
    expect(result?.language).toBe("en");
  });

  test("round-trips a multi-line transcript verbatim", async () => {
    const text = "first line of the note\nsecond line\nthird line with a name like Maya Reeves";
    const result = await client.transcribe(enc(text), "audio/ogg");
    expect(result?.text).toBe(text);
  });

  test("forwards a language hint as a query parameter", async () => {
    const result = await client.transcribe(enc("bonjour"), "audio/ogg", { language: "fr" });
    expect(result?.text).toBe("bonjour");
    expect(result?.language).toBe("fr");
  });
});
