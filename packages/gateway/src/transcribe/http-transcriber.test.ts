// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  HttpTranscriber,
  MAX_CHUNK_SAMPLES,
  encodeMultipart,
  encodeWav,
  splitPcm,
} from "./http-transcriber.js";
import type { TranscriptionVocabulary } from "@omnesis/core";

interface Captured {
  url: string;
  headers: Headers;
  form: FormData;
}

/** A backend stand-in that parses each request the way a real server would. */
function backend(reply: () => Response = () => Response.json({ text: "hello there" })) {
  const requests: Captured[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const form = await new Request(String(input), {
      method: "POST",
      headers,
      body: init?.body as BodyInit,
    }).formData();
    requests.push({ url: String(input), headers, form });
    return reply();
  }) as typeof fetch;
  return { requests, fetchFn };
}

const oneSecond = async () => new Float32Array(16_000).fill(0.25);
const audio = new TextEncoder().encode("opus bytes");
const vocabulary: TranscriptionVocabulary = {
  entries: [
    { text: "Northstar", score: 0.9 },
    { text: "QX", score: 0.8 },
  ],
};

describe("HttpTranscriber", () => {
  test("posts the decoded audio as WAV to the backend's transcription endpoint", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003/",
      model: "whisper-large-v3-turbo",
      apiKey: "secret",
      fetchFn,
      decodeAudio: oneSecond,
    });

    const result = await transcriber.transcribe(audio, "audio/ogg", { language: "fr" });

    expect(result).toEqual({ text: "hello there", durationSec: 1 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("http://127.0.0.1:8003/v1/audio/transcriptions");
    expect(request!.headers.get("authorization")).toBe("Bearer secret");
    expect(request!.form.get("model")).toBe("whisper-large-v3-turbo");
    expect(request!.form.get("response_format")).toBe("json");
    expect(request!.form.get("language")).toBe("fr");
    const file = request!.form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    const wav = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(wav.byteLength).toBe(44 + 16_000 * 2);
  });

  test("honors the backend's API path prefix and leaves language detection to the server", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://localhost:9000",
      apiPathPrefix: "/openai/v1/",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await transcriber.transcribe(audio, "audio/ogg", { language: "auto" });
    expect(requests[0]!.url).toBe("http://localhost:9000/openai/v1/audio/transcriptions");
    expect(requests[0]!.form.has("language")).toBe(false);
  });

  test("sends personal vocabulary as the prompt to a loopback backend", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await transcriber.transcribe(audio, "audio/ogg", { vocabulary });
    expect(requests[0]!.form.get("prompt")).toBe("Northstar, QX");
  });

  test("keeps personal vocabulary from a backend on another machine", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://198.18.0.20:8003",
      model: "m",
      allowRemoteInference: true,
      fetchFn,
      decodeAudio: oneSecond,
    });
    await transcriber.transcribe(audio, "audio/ogg", { vocabulary });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.form.has("prompt")).toBe(false);
  });

  test("refuses a non-loopback backend unless remote inference is allowed", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://198.18.0.20:8003",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).rejects.toMatchObject({
      name: "InferenceUrlPolicyError",
    });
    expect(requests).toHaveLength(0);
  });

  test("a refused request throws without repeating what the backend echoed", async () => {
    const { fetchFn } = backend(() => new Response("you said: something private", { status: 404 }));
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "missing-model",
      fetchFn,
      decodeAudio: oneSecond,
    });
    const error = await transcriber.transcribe(audio, "audio/ogg").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 404");
    expect((error as Error).message).not.toContain("private");
  });

  test("an answer without text is an error, not an empty transcript", async () => {
    const { fetchFn } = backend(() => Response.json({ error: "busy" }));
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).rejects.toThrow(/returned no text/);
  });

  test("sends a long recording in chunks that fit an upload limit and joins their text", async () => {
    let n = 0;
    const { requests, fetchFn } = backend(() => Response.json({ text: ` part ${++n} ` }));
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: async () => new Float32Array(MAX_CHUNK_SAMPLES * 2 + 16_000).fill(0.1),
    });
    const result = await transcriber.transcribe(audio, "audio/ogg");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const file = request.form.get("file") as File;
      expect(file.size).toBeLessThan(25 * 1024 * 1024);
    }
    expect(result.text).toBe("part 1 part 2 part 3");
    expect(result.durationSec).toBe(1201);
  });

  test("audio with no samples is an empty transcript without a request", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: async () => new Float32Array(0),
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).resolves.toEqual({
      text: "",
      durationSec: 0,
    });
    expect(requests).toHaveLength(0);
  });

  test("stops waiting when the caller does", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        started();
      })) as typeof fetch;
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    const caller = new AbortController();
    const pending = transcriber.transcribe(audio, "audio/ogg", { signal: caller.signal });
    await requestStarted;
    caller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
  });
});

describe("splitPcm", () => {
  test("keeps a recording within the limit whole", () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES);
    expect(splitPcm(pcm)).toHaveLength(1);
  });

  test("splits at the quietest moment near each limit, losing no samples", () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES + 32_000).fill(0.5);
    const silenceAt = MAX_CHUNK_SAMPLES - 5 * 16_000;
    pcm.fill(0, silenceAt, silenceAt + 640);
    const chunks = splitPcm(pcm);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeGreaterThanOrEqual(silenceAt);
    expect(chunks[0]!.length).toBeLessThanOrEqual(silenceAt + 640);
    expect(chunks[0]!.length + chunks[1]!.length).toBe(pcm.length);
  });
});

describe("encodeWav", () => {
  test("writes 16-bit mono 16 kHz samples, clamping out-of-range values", () => {
    const wav = Buffer.from(encodeWav(new Float32Array([0, 1, -1, 2])));
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32768, 32767]);
  });
});

describe("encodeMultipart", () => {
  test("produces a body a standard form parser reads back", async () => {
    const { body, contentType } = encodeMultipart([["model", "whisper-1"]], {
      name: "file",
      filename: "audio.wav",
      contentType: "audio/wav",
      data: new Uint8Array([0, 13, 10, 45, 45, 255]),
    });
    const form = await new Request("http://example.com", {
      method: "POST",
      headers: { "content-type": contentType },
      body: body as BodyInit,
    }).formData();
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file") as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 13, 10, 45, 45, 255]);
  });
});
