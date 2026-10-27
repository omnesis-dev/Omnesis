// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  HttpTranscriber,
  encodeMultipart,
  encodeWav,
  parseTranscriptText,
} from "./http-transcriber.js";
import { MAX_CHUNK_SAMPLES, chunkSamples, splitPcm } from "./chunks.js";
import { computeTranscriptionTimeoutMs } from "./deadline.js";
import { PCM_SAMPLE_RATE } from "./audio-decode.js";
import { TranscribeService } from "./transcribe-service.js";
import type { ResolvedAssignment, TranscriptionVocabulary } from "@omnesis/core";

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

/** Hands out each request deadline as a signal the test expires by hand. */
function heldDeadlines() {
  const deadlines: Array<{ ms: number; signal: AbortSignal; expire: () => void }> = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    deadlines.push({
      ms,
      signal: controller.signal,
      expire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    });
    return controller.signal;
  });
  onTestFinished(() => timeout.mockRestore());
  return deadlines;
}

/** Answers the first `answered` requests, then takes each one and never answers. */
function hangsAfter(answered: number) {
  const signals: AbortSignal[] = [];
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init!.signal!;
    signals.push(signal);
    if (signals.length <= answered) return Promise.resolve(Response.json({ text: "part" }));
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  }) as typeof fetch;
  return { signals, fetchFn };
}

/** 700 s of steady sound: a full first chunk and a 100 s second one. */
const sevenHundredSeconds = async () => new Float32Array(16_000 * 700).fill(0.1);
const chunkSeconds = splitPcm(new Float32Array(16_000 * 700).fill(0.1)).map(
  (chunk) => chunk.length / 16_000,
);

const oneSecond = async () => new Float32Array(16_000).fill(0.25);
const audio = new TextEncoder().encode("opus bytes");
const vocabulary: TranscriptionVocabulary = {
  entries: [
    { text: "Northstar", score: 0.9 },
    { text: "QX", score: 0.8 },
  ],
};

const httpAssignment: ResolvedAssignment = {
  role: "transcriber",
  kind: "http",
  backendKey: "whisper-gpu",
  model: "whisper-large-v3-turbo",
  url: "http://127.0.0.1:8003",
  allowRemoteInference: false,
  available: true,
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

  test("gives each chunk of a long recording its own deadline, sized from that chunk", async () => {
    const deadlines = heldDeadlines();
    const { fetchFn } = hangsAfter(Infinity);
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: sevenHundredSeconds,
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).resolves.toMatchObject({
      text: "part part",
    });
    expect(chunkSeconds).toHaveLength(2);
    expect(deadlines.map((d) => d.ms)).toEqual(
      chunkSeconds.map((sec) => computeTranscriptionTimeoutMs(sec)),
    );
    expect(deadlines[1]!.ms).toBeLessThan(deadlines[0]!.ms);
  });

  test("a hung second chunk is given up at its own deadline", async () => {
    const deadlines = heldDeadlines();
    const { signals, fetchFn } = hangsAfter(1);
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: sevenHundredSeconds,
    });
    const pending = transcriber.transcribe(audio, "audio/ogg");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]!.ms).toBe(computeTranscriptionTimeoutMs(chunkSeconds[1]!));
    deadlines[1]!.expire();
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("a caller that stops waiting during a later chunk stops the recording at once", async () => {
    heldDeadlines();
    const { signals, fetchFn } = hangsAfter(1);
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8003",
      model: "m",
      fetchFn,
      decodeAudio: sevenHundredSeconds,
    });
    const caller = new AbortController();
    const pending = transcriber.transcribe(audio, "audio/ogg", { signal: caller.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    caller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    expect(signals).toHaveLength(2);
  });

  test("a hung backend's deadline frees the transcription queue for the next clip", async () => {
    const deadlines = heldDeadlines();
    const hung = hangsAfter(0);
    let calls = 0;
    const service = new TranscribeService({
      resolveAssignment: () => httpAssignment,
      deps: {
        decodeAudio: oneSecond,
        fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
          ++calls === 1
            ? hung.fetchFn(input, init)
            : Promise.resolve(Response.json({ text: "second clip" }))) as typeof fetch,
      },
    });
    const first = service.transcribe(audio, "audio/ogg");
    const second = service.transcribe(audio, "audio/ogg");
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 10_000 });
    expect(deadlines).toHaveLength(1);
    deadlines[0]!.expire();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatchObject({ text: "second clip" });
    expect(calls).toBe(2);
  }, 20_000);
});

describe("splitPcm with a short window", () => {
  test("splits a recording at the window, even one shorter than the quiet-moment search", () => {
    const pcm = new Float32Array(PCM_SAMPLE_RATE * 12).fill(0.3);
    const chunks = splitPcm(pcm, PCM_SAMPLE_RATE * 5);
    expect(chunks).toHaveLength(3);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(pcm.length);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeLessThanOrEqual(PCM_SAMPLE_RATE * 5);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  test("chunkSamples caps at the upload limit and defaults to it", () => {
    expect(chunkSamples(undefined)).toBe(MAX_CHUNK_SAMPLES);
    expect(chunkSamples(0)).toBe(MAX_CHUNK_SAMPLES);
    expect(chunkSamples(60)).toBe(60 * PCM_SAMPLE_RATE);
    expect(chunkSamples(5_000)).toBe(MAX_CHUNK_SAMPLES);
  });

  test("an HTTP transcriber with a window sends a recording in that many pieces", async () => {
    const { requests, fetchFn } = backend();
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8011",
      model: "qwen3-asr",
      maxChunkSeconds: 60,
      fetchFn,
      decodeAudio: async () => new Float32Array(PCM_SAMPLE_RATE * 130).fill(0.2),
    });
    const result = await transcriber.transcribe(audio, "audio/ogg");
    expect(requests).toHaveLength(3);
    expect(result.text).toBe("hello there hello there hello there");
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

describe("parseTranscriptText", () => {
  test("keeps a plain transcript as it is", () => {
    expect(parseTranscriptText("  hello there \n")).toEqual({ text: "hello there" });
  });

  test("drops the language Qwen3-ASR writes ahead of the words and keeps it as a code", () => {
    // Ollama and llama-server pass the model's output through verbatim.
    expect(
      parseTranscriptText("language English<asr_text>And so, my fellow Americans, ask not."),
    ).toEqual({ text: "And so, my fellow Americans, ask not.", language: "en" });
    expect(parseTranscriptText("language German<asr_text>Hallo, wie geht's?")).toEqual({
      text: "Hallo, wie geht's?",
      language: "de",
    });
    expect(parseTranscriptText("language Klingon<asr_text>nuqneH")).toEqual({
      text: "nuqneH",
      language: "klingon",
    });
  });

  test("leaves a transcript that merely starts with the word language alone", () => {
    expect(parseTranscriptText("language is a virus")).toEqual({ text: "language is a virus" });
  });
});

describe("HttpTranscriber with a server that passes Qwen3-ASR output through", () => {
  test("returns the words and the detected language", async () => {
    const { fetchFn } = backend(() =>
      Response.json({ text: "language French<asr_text>Bonjour à tous." }),
    );
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:11434",
      model: "frozenlab/qwen3-asr:1.7b",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).resolves.toEqual({
      text: "Bonjour à tous.",
      language: "fr",
      durationSec: 1,
    });
  });

  test("prefers the language the server reports over the one in the text", async () => {
    const { fetchFn } = backend(() =>
      Response.json({ text: "language English<asr_text>Hi.", language: "en-GB" }),
    );
    const transcriber = new HttpTranscriber({
      url: "http://127.0.0.1:8080",
      model: "m",
      fetchFn,
      decodeAudio: oneSecond,
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).resolves.toMatchObject({
      text: "Hi.",
      language: "en-GB",
    });
  });
});
