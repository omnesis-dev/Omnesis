// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  ChatAudioTranscriber,
  TRANSCRIBE_INSTRUCTION,
  chatAudioRequestBody,
  transcriptFromChatCompletion,
} from "./chat-audio-transcriber.js";
import { PCM_SAMPLE_RATE } from "./audio-decode.js";
import { splitPcm } from "./chunks.js";
import { computeTranscriptionTimeoutMs } from "./deadline.js";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function backend(reply: (body: Record<string, unknown>) => Response) {
  const requests: Captured[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    return reply(body);
  }) as typeof fetch;
  return { requests, fetchFn };
}

const completion = (content: unknown) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });
const audio = new TextEncoder().encode("opus bytes");
const seconds = (n: number) => async () => new Float32Array(PCM_SAMPLE_RATE * n).fill(0.2);

describe("ChatAudioTranscriber", () => {
  test("sends the audio as a base64 WAV input_audio part with the transcription instruction", async () => {
    const { requests, fetchFn } = backend(() =>
      completion("language English<asr_text>And so, my fellow Americans."),
    );
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:11434/",
      model: "frozenlab/qwen3-asr:1.7b",
      apiKey: "secret",
      fetchFn,
      decodeAudio: seconds(1),
    });

    const result = await transcriber.transcribe(audio, "audio/ogg");

    expect(result).toEqual({
      text: "And so, my fellow Americans.",
      language: "en",
      durationSec: 1,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(request!.headers.get("authorization")).toBe("Bearer secret");
    expect(request!.body["model"]).toBe("frozenlab/qwen3-asr:1.7b");
    expect(request!.body["stream"]).toBe(false);
    const messages = request!.body["messages"] as Array<{ role: string; content: unknown[] }>;
    const [part, text] = messages[0]!.content as [
      { type: string; input_audio: { data: string; format: string } },
      { type: string; text: string },
    ];
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
    const wav = Buffer.from(part.input_audio.data, "base64");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.byteLength).toBe(44 + PCM_SAMPLE_RATE * 2);
    expect(text).toEqual({ type: "text", text: TRANSCRIBE_INSTRUCTION });
  });

  test("sends a long recording in one-minute chunks and joins the words", async () => {
    const { requests, fetchFn } = backend((body) => {
      const messages = body["messages"] as Array<{
        content: Array<{ input_audio?: { data: string } }>;
      }>;
      const bytes = Buffer.from(messages[0]!.content[0]!.input_audio!.data, "base64").byteLength;
      return completion(`chunk of ${Math.round((bytes - 44) / 2 / PCM_SAMPLE_RATE)}s`);
    });
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
      model: "qwen3-asr",
      fetchFn,
      decodeAudio: seconds(150),
    });
    const result = await transcriber.transcribe(audio, "audio/ogg");
    expect(requests).toHaveLength(3);
    expect(result.text).toMatch(/^chunk of (5[0-9]|60)s chunk of (5[0-9]|60)s chunk of \d+s$/);
    expect(result.durationSec).toBe(150);
  });

  test("gives each one-minute chunk its own deadline, and a hung one is given up at it", async () => {
    const deadlines: Array<{ ms: number; expire: () => void }> = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      deadlines.push({
        ms,
        expire: () =>
          controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      });
      return controller.signal;
    });
    onTestFinished(() => timeout.mockRestore());
    let requests = 0;
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (requests === 1) return Promise.resolve(completion("first minute"));
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }) as typeof fetch;
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
      model: "qwen3-asr",
      fetchFn,
      decodeAudio: seconds(150),
    });
    const pending = transcriber.transcribe(audio, "audio/ogg");
    await vi.waitFor(() => expect(requests).toBe(2));
    const chunks = splitPcm(new Float32Array(PCM_SAMPLE_RATE * 150), PCM_SAMPLE_RATE * 60);
    // Each minute is sized by the slow-engine rate (about 990 s), not by the
    // recording, whose 150 s would share one deadline at the ceiling.
    expect(deadlines.map((d) => d.ms)).toEqual(
      chunks
        .slice(0, 2)
        .map((chunk) => computeTranscriptionTimeoutMs(chunk.length / PCM_SAMPLE_RATE)),
    );
    deadlines[1]!.expire();
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requests).toBe(2);
  });

  test("honors a configured chunk length and the API path prefix", async () => {
    const { requests, fetchFn } = backend(() => completion("words"));
    const transcriber = new ChatAudioTranscriber({
      url: "http://localhost:9000",
      apiPathPrefix: "/openai/v1/",
      model: "m",
      maxChunkSeconds: 30,
      fetchFn,
      decodeAudio: seconds(70),
    });
    await transcriber.transcribe(audio, "audio/ogg");
    expect(requests).toHaveLength(3);
    expect(requests[0]!.url).toBe("http://localhost:9000/openai/v1/chat/completions");
  });

  test("reads content parts and refuses an answer without words", async () => {
    expect(
      transcriptFromChatCompletion({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          },
        ],
      }),
    ).toBe("ab");
    expect(transcriptFromChatCompletion({ choices: [{ message: {} }] })).toBeNull();
    expect(transcriptFromChatCompletion(null)).toBeNull();

    const { fetchFn } = backend(() => Response.json({ choices: [] }));
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
      model: "m",
      fetchFn,
      decodeAudio: seconds(1),
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).rejects.toThrow(/returned no text/);
  });

  test("a refusal names the status and never the speech", async () => {
    const { fetchFn } = backend(() => new Response("bad audio", { status: 400 }));
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
      model: "m",
      fetchFn,
      decodeAudio: seconds(1),
    });
    await expect(transcriber.transcribe(audio, "audio/ogg")).rejects.toThrow(
      "chat transcription backend m refused the audio (HTTP 400)",
    );
  });

  test("mentions personal vocabulary only to a loopback backend", async () => {
    const vocabulary = { entries: [{ text: "Northstar", score: 0.9 }] };
    const local = backend(() => completion("ok"));
    await new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
      model: "m",
      fetchFn: local.fetchFn,
      decodeAudio: seconds(1),
    }).transcribe(audio, "audio/ogg", { vocabulary });
    const localText = (
      (local.requests[0]!.body["messages"] as Array<{ content: Array<{ text?: string }> }>)[0]!
        .content[1] as { text: string }
    ).text;
    expect(localText).toContain("Northstar");

    const remote = backend(() => completion("ok"));
    await new ChatAudioTranscriber({
      url: "http://198.18.0.20:8011",
      model: "m",
      allowRemoteInference: true,
      fetchFn: remote.fetchFn,
      decodeAudio: seconds(1),
    }).transcribe(audio, "audio/ogg", { vocabulary });
    const remoteText = (
      (remote.requests[0]!.body["messages"] as Array<{ content: Array<{ text?: string }> }>)[0]!
        .content[1] as { text: string }
    ).text;
    expect(remoteText).toBe(TRANSCRIBE_INSTRUCTION);
  });

  test("an empty recording sends nothing", async () => {
    const { requests, fetchFn } = backend(() => completion("x"));
    const transcriber = new ChatAudioTranscriber({
      url: "http://127.0.0.1:8011",
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
});

describe("chatAudioRequestBody", () => {
  test("is deterministic for the same audio and model", () => {
    const pcm = new Float32Array(16).fill(0.1);
    expect(chatAudioRequestBody("m", pcm, "say it")).toEqual(
      chatAudioRequestBody("m", pcm, "say it"),
    );
    expect(chatAudioRequestBody("m", pcm, "say it")["temperature"]).toBe(0);
  });
});
