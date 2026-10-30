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
import { createServer, type Server } from "node:http";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AddressInfo } from "node:net";

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

/**
 * The same round-trip with an HTTP transcriber: the gateway decodes the audio
 * and posts it to an OpenAI-compatible `/v1/audio/transcriptions` server, the
 * shape a GPU whisper server or vLLM serves. A fake server on loopback records
 * what it received and answers with a fixed transcript.
 */
describe("speech-to-text through an HTTP transcription backend (E2E)", () => {
  let harness: SyntheticE2EHarness;
  let client: HttpGatewayClient;
  let server: Server;
  const received: Array<{ path: string; model: FormDataEntryValue | null; file: File | null }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      // The gateway also probes `GET /v1/models`; like whisper-server, this
      // fake has no model list, which still leaves the backend reachable.
      if (req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void new Request("http://fake", {
          method: "POST",
          headers: { "content-type": req.headers["content-type"] ?? "" },
          body: Buffer.concat(chunks),
        })
          .formData()
          .then((form) => {
            received.push({
              path: req.url ?? "",
              model: form.get("model"),
              file: form.get("file") as File | null,
            });
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ text: " the recording, transcribed on the server " }));
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      extraInference: {
        backends: { "fake-stt": { type: "http", url: `http://127.0.0.1:${port}` } },
        assignments: { transcriber: "fake-stt/whisper-test" },
      },
    });
    await harness.start();
    client = new HttpGatewayClient(harness.gatewayUrl, harness.apiKey);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
    server.closeAllConnections();
    server.close();
  });

  test("verifies the backend at boot, then decodes the audio and returns the server's transcript", async () => {
    const result = await client.transcribe(wavOfSilence(2), "audio/wav");
    expect(result?.text).toBe("the recording, transcribed on the server");
    expect(result?.durationSec).toBeCloseTo(2, 1);
    // The gateway asked the backend to transcribe one second of audio when
    // it booted, to confirm the assignment can run; the recording followed.
    expect(received).toHaveLength(2);
    const [probe, recording] = received;
    expect(probe!.path).toBe("/v1/audio/transcriptions");
    expect(probe!.model).toBe("whisper-test");
    expect(probe!.file?.name).toBe("probe.wav");
    expect(probe!.file?.size).toBe(44 + 1 * 16_000 * 2);
    expect(recording!.path).toBe("/v1/audio/transcriptions");
    expect(recording!.model).toBe("whisper-test");
    expect(recording!.file?.type).toBe("audio/wav");
    expect(recording!.file?.size).toBe(44 + 2 * 16_000 * 2);
  });
});

/** A 16 kHz mono 16-bit WAV of `seconds` of silence, for a decoder to read. */
function wavOfSilence(seconds: number): Uint8Array {
  const dataBytes = seconds * 16_000 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf);
}
