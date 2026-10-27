// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { loadTranscriberFromResolved } from "./loader.js";
import { HttpTranscriber } from "./http-transcriber.js";
import type { ResolvedAssignment } from "@omnesis/core";

const http: ResolvedAssignment = {
  role: "transcriber",
  kind: "http",
  backendKey: "gpu",
  url: "http://127.0.0.1:8080",
  apiPathPrefix: "/openai/v1",
  model: "whisper-large-v3-turbo",
  allowRemoteInference: false,
  available: true,
};

describe("loadTranscriberFromResolved", () => {
  test("an http assignment builds a transcriber for that backend, with its key", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const capability = await loadTranscriberFromResolved(http, {
      getBackendApiKey: (key) => (key === "gpu" ? "backend-key" : undefined),
      decodeAudio: async () => new Float32Array(16_000),
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return Response.json({ text: "ok" });
      }) as typeof fetch,
    });
    expect(capability).toBeInstanceOf(HttpTranscriber);
    expect(capability!.modelId).toBe("whisper-large-v3-turbo");
    await capability!.transcribe(new Uint8Array([1]), "audio/ogg");
    expect(seen).toEqual([
      { url: "http://127.0.0.1:8080/openai/v1/audio/transcriptions", auth: "Bearer backend-key" },
    ]);
  });

  test("an http assignment without a model loads nothing", async () => {
    await expect(loadTranscriberFromResolved({ ...http, model: "" })).resolves.toBeNull();
  });

  test("an http assignment the registry marked unavailable loads nothing", async () => {
    // The registry's reason may be a down backend or a transcription probe
    // that found the backend cannot transcribe (a chat-only server); either
    // way a transcriber built for it would fail every voice note.
    const fetchFn = vi.fn();
    await expect(
      loadTranscriberFromResolved(
        {
          ...http,
          available: false,
          reason:
            'Backend "gpu" cannot transcribe with whisper-large-v3-turbo: no transcription endpoint',
        },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("chat-agent backends offer no transcriber", async () => {
    const assignments: ResolvedAssignment[] = [
      {
        role: "transcriber",
        kind: "anthropic",
        catalogId: "anthropic/x",
        apiModelId: "x",
        allowRemoteInference: true,
        available: true,
      },
      {
        role: "transcriber",
        kind: "codex",
        model: "m",
        allowRemoteInference: true,
        available: true,
      },
      {
        role: "transcriber",
        kind: "claude-code",
        model: "m",
        allowRemoteInference: true,
        available: true,
      },
    ];
    for (const assignment of assignments) {
      await expect(loadTranscriberFromResolved(assignment)).resolves.toBeNull();
    }
  });
});
