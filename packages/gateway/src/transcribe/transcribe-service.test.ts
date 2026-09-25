// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { TranscribeService } from "./transcribe-service.js";
import {
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";
import type { WhisperWorkerProcess, WhisperWorkerSpawner } from "./whisper-transcriber.js";
import type { ResolvedAssignment } from "@omnesis/core";

const enc = (s: string) => new TextEncoder().encode(s);

const disabled: ResolvedAssignment = { role: "transcriber", kind: "disabled" };
const replay: ResolvedAssignment = { role: "transcriber", kind: "replay" };
const localUnavailable: ResolvedAssignment = {
  role: "transcriber",
  kind: "local",
  catalogId: "whisper-small",
  modelPath: "/models/ggml-small.bin",
  available: false,
  reason: "not installed",
};

/** In-memory worker stand-in: decodes requests, lets a test drive responses. */
class FakeWorker implements WhisperWorkerProcess {
  killed = false;
  private msg: ((m: WhisperWorkerMessage) => void) | null = null;
  private exit:
    | ((i: { code: number | null; signal: string | null; error?: Error }) => void)
    | null = null;
  private readonly decoder = new FrameDecoder((h) => this.onRequest?.(h as WhisperRequestHeader));
  onRequest?: (header: WhisperRequestHeader) => void;

  write(frame: Buffer): void {
    if (!this.killed) this.decoder.push(frame);
  }
  kill(): void {
    this.killed = true;
    this.exit?.({ code: null, signal: "SIGKILL" });
  }
  onMessage(h: (m: WhisperWorkerMessage) => void): void {
    this.msg = h;
  }
  onExit(h: (i: { code: number | null; signal: string | null; error?: Error }) => void): void {
    this.exit = h;
  }
  emit(m: WhisperWorkerMessage): void {
    this.msg?.(m);
  }
  emitReady(): void {
    this.msg?.({ type: "ready" });
  }
}

describe("TranscribeService", () => {
  test("returns null when the transcriber is disabled", async () => {
    const svc = new TranscribeService({ resolveAssignment: () => disabled });
    expect(await svc.transcribe(enc("hi"), "audio/ogg")).toBeNull();
  });

  test("returns null when a local model is assigned but unavailable", async () => {
    const svc = new TranscribeService({ resolveAssignment: () => localUnavailable });
    expect(await svc.transcribe(enc("hi"), "audio/ogg")).toBeNull();
  });

  test("transcription is local-only: http and anthropic assignments resolve to no transcriber", async () => {
    const http: ResolvedAssignment = {
      role: "transcriber",
      kind: "http",
      backendKey: "vllm",
      model: "whisper-1",
      url: "http://localhost:8000",
      allowRemoteInference: false,
      available: true,
    };
    expect(
      await new TranscribeService({ resolveAssignment: () => http }).transcribe(
        enc("hi"),
        "audio/ogg",
      ),
    ).toBeNull();

    const anthropic: ResolvedAssignment = {
      role: "transcriber",
      kind: "anthropic",
      catalogId: "anthropic/x",
      apiModelId: "x",
      available: true,
    };
    expect(
      await new TranscribeService({ resolveAssignment: () => anthropic }).transcribe(
        enc("hi"),
        "audio/ogg",
      ),
    ).toBeNull();
  });

  test("transcribes through the synthetic (replay) capability", async () => {
    const svc = new TranscribeService({ resolveAssignment: () => replay });
    const result = await svc.transcribe(enc("a voice note"), "audio/ogg");
    expect(result?.text).toBe("a voice note");
  });

  test("a worker crash is swallowed into a null transcription — the gateway is not killed", async () => {
    // The whole point of the subprocess seam: a native segfault becomes a null
    // result the caller treats as "unavailable, retry later", never a throw that
    // would surface as a 5xx (and certainly never an in-process crash).
    const local: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-small",
      modelPath: "/a.bin",
      available: true,
    };
    const worker = new FakeWorker();
    // Simulate a native segfault: the worker dies (signal exit) on the request.
    worker.onRequest = () => worker.kill();
    const svc = new TranscribeService({
      resolveAssignment: () => local,
      deps: {
        loadModule: async () => ({ Whisper: class {} as never }),
        spawnWorker: (() => {
          setTimeout(() => worker.emitReady(), 0);
          return worker;
        }) as WhisperWorkerSpawner,
        decodeAudio: async (b) => new Float32Array(b.length),
      },
    });
    // Crash maps to null, NOT a thrown error.
    expect(await svc.transcribe(enc("boom"), "audio/ogg")).toBeNull();
  });

  test("recovers after a crash: the next transcription spawns a fresh worker and succeeds", async () => {
    const local: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-small",
      modelPath: "/a.bin",
      available: true,
    };
    const crashy = new FakeWorker();
    crashy.onRequest = () => crashy.kill();
    const healthy = new FakeWorker();
    healthy.onRequest = (req) => healthy.emit({ type: "result", id: req.id, text: "recovered" });
    const workers = [crashy, healthy];
    let i = 0;
    const svc = new TranscribeService({
      resolveAssignment: () => local,
      deps: {
        loadModule: async () => ({ Whisper: class {} as never }),
        spawnWorker: (() => {
          const w = workers[i++];
          setTimeout(() => w.emitReady(), 0);
          return w;
        }) as WhisperWorkerSpawner,
        decodeAudio: async (b) => new Float32Array(b.length),
      },
    });
    expect(await svc.transcribe(enc("boom"), "audio/ogg")).toBeNull();
    const ok = await svc.transcribe(enc("hello"), "audio/ogg");
    expect(ok?.text).toBe("recovered");
  });

  test("self-heals when the assignment changes: kills the old worker before loading the new", async () => {
    let resolved: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-small",
      modelPath: "/a.bin",
      available: true,
    };
    const spawnedPaths: string[] = [];
    const workersByPath = new Map<string, FakeWorker>();
    const svc = new TranscribeService({
      resolveAssignment: () => resolved,
      deps: {
        loadModule: async () => ({ Whisper: class {} as never }),
        spawnWorker: ((args: { modelPath: string }) => {
          spawnedPaths.push(args.modelPath);
          const w = new FakeWorker();
          w.onRequest = (req) => w.emit({ type: "result", id: req.id, text: "ok" });
          workersByPath.set(args.modelPath, w);
          setTimeout(() => w.emitReady(), 0);
          return w;
        }) as WhisperWorkerSpawner,
        decodeAudio: async (b) => new Float32Array(b.length),
      },
    });
    await svc.transcribe(enc("one"), "audio/ogg");
    expect(spawnedPaths).toEqual(["/a.bin"]);
    expect(workersByPath.get("/a.bin")?.killed).toBe(false);

    // Switch models — the service disposes (kills) the old worker, then loads new.
    resolved = { ...resolved, catalogId: "whisper-medium", modelPath: "/b.bin" };
    await svc.transcribe(enc("two"), "audio/ogg");
    expect(spawnedPaths).toEqual(["/a.bin", "/b.bin"]);
    expect(workersByPath.get("/a.bin")?.killed).toBe(true);
  });

  test("never kills a worker while a transcription is still running on it (hot-swap safety)", async () => {
    let resolved: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-small",
      modelPath: "/a.bin",
      available: true,
    };
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((r) => (signalStarted = r));
    const byPath = new Map<string, FakeWorker>();
    let call = 0;
    const svc = new TranscribeService({
      resolveAssignment: () => resolved,
      deps: {
        loadModule: async () => ({ Whisper: class {} as never }),
        spawnWorker: ((args: { modelPath: string }) => {
          const w = new FakeWorker();
          const origKill = w.kill.bind(w);
          w.kill = () => {
            events.push(`kill:${args.modelPath}`);
            origKill();
          };
          w.onRequest = (req) => {
            const first = call++ === 0;
            if (first) {
              signalStarted();
              void firstGate.then(() => {
                events.push(`done:${args.modelPath}`);
                w.emit({ type: "result", id: req.id, text: "x" });
              });
            } else {
              events.push(`done:${args.modelPath}`);
              w.emit({ type: "result", id: req.id, text: "x" });
            }
          };
          byPath.set(args.modelPath, w);
          setTimeout(() => w.emitReady(), 0);
          return w;
        }) as WhisperWorkerSpawner,
        decodeAudio: async (b) => new Float32Array(b.length),
      },
    });

    const p1 = svc.transcribe(new Uint8Array(1), "audio/ogg");
    await firstStarted; // transcription A is mid-flight on /a.bin

    // Operator swaps the model while A is still running.
    resolved = { ...resolved, catalogId: "whisper-medium", modelPath: "/b.bin" };
    const p2 = svc.transcribe(new Uint8Array(2), "audio/ogg");
    await Promise.resolve();
    // /a.bin's worker must NOT be killed while A is still decoding on it.
    expect(events).not.toContain("kill:/a.bin");

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(events).toContain("kill:/a.bin");
    expect(events.indexOf("kill:/a.bin")).toBeGreaterThan(events.indexOf("done:/a.bin"));
  });

  test("serializes concurrent transcriptions (one at a time)", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const resolved: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-small",
      modelPath: "/m.bin",
      available: true,
    };
    const w = new FakeWorker();
    w.onRequest = (req) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        order.push(`done:${req.id}`);
        active--;
        w.emit({ type: "result", id: req.id, text: "x" });
      }, 15);
    };
    const svc = new TranscribeService({
      resolveAssignment: () => resolved,
      deps: {
        loadModule: async () => ({ Whisper: class {} as never }),
        spawnWorker: (() => {
          setTimeout(() => w.emitReady(), 0);
          return w;
        }) as WhisperWorkerSpawner,
        decodeAudio: async (bytes) => new Float32Array(bytes.length),
      },
    });
    await Promise.all([
      svc.transcribe(new Uint8Array(1), "audio/ogg"),
      svc.transcribe(new Uint8Array(2), "audio/ogg"),
      svc.transcribe(new Uint8Array(3), "audio/ogg"),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(3);
  });

  test("dispose tears down the loaded capability", async () => {
    const svc = new TranscribeService({ resolveAssignment: () => replay });
    await svc.transcribe(enc("hi"), "audio/ogg");
    await expect(svc.dispose()).resolves.toBeUndefined();
  });
});
