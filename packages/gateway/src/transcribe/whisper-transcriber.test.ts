// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import {
  WhisperTranscriber,
  whisperDepsAvailable,
  computeWhisperTimeoutMs,
  type WhisperWorkerProcess,
  type WhisperWorkerSpawner,
} from "./whisper-transcriber.js";
import {
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";

/**
 * A scriptable in-memory worker that satisfies `WhisperWorkerProcess` without a
 * real subprocess. It decodes the framed requests the supervisor writes and
 * lets a test drive the responses (ready, result, error, death, silence).
 */
class FakeWorker implements WhisperWorkerProcess {
  killed = false;
  readonly requests: WhisperRequestHeader[] = [];
  private messageHandler: ((msg: WhisperWorkerMessage) => void) | null = null;
  private exitHandler:
    | ((info: { code: number | null; signal: string | null; error?: Error }) => void)
    | null = null;
  private readonly decoder = new FrameDecoder((header) => {
    this.requests.push(header as WhisperRequestHeader);
    this.onRequest?.(header as WhisperRequestHeader);
  });

  /** Optional hook fired for each decoded request frame. */
  onRequest?: (header: WhisperRequestHeader) => void;

  write(frame: Buffer): void {
    if (this.killed) return;
    this.decoder.push(frame);
  }
  kill(): void {
    this.killed = true;
    // A real process emits `exit` after a kill; mirror that for the supervisor.
    this.emitExit({ code: null, signal: "SIGKILL" });
  }
  onMessage(handler: (msg: WhisperWorkerMessage) => void): void {
    this.messageHandler = handler;
  }
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void {
    this.exitHandler = handler;
  }

  // ── test-side drivers ──
  emit(msg: WhisperWorkerMessage): void {
    this.messageHandler?.(msg);
  }
  emitReady(): void {
    this.emit({ type: "ready" });
  }
  emitExit(info: { code: number | null; signal: string | null; error?: Error }): void {
    this.exitHandler?.(info);
  }
}

/** Build a transcriber wired to a sequence of fake workers (one per spawn). */
function withWorkers(...workers: FakeWorker[]): {
  transcriber: WhisperTranscriber;
  spawned: FakeWorker[];
} {
  const spawned: FakeWorker[] = [];
  let i = 0;
  const spawnWorker: WhisperWorkerSpawner = () => {
    const w = workers[i++] ?? new FakeWorker();
    spawned.push(w);
    return w;
  };
  const transcriber = new WhisperTranscriber({
    modelPath: "/m.bin",
    modelId: "whisper-tiny",
    spawnWorker,
    decodeAudio: async () => new Float32Array(16_000), // 1s of silence
    requestTimeoutMs: 50,
  });
  return { transcriber, spawned };
}

describe("WhisperTranscriber (subprocess supervisor)", () => {
  test("happy path: a worker result resolves to {text, language, durationSec}", async () => {
    const w = new FakeWorker();
    w.onRequest = (req) =>
      w.emit({ type: "result", id: req.id, text: "Hello world.", language: "en", durationSec: 1 });
    const { transcriber } = withWorkers(w);
    setTimeout(() => w.emitReady(), 0);

    const result = await transcriber.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg");
    expect(result.text).toBe("Hello world.");
    expect(result.language).toBe("en");
    expect(result.durationSec).toBeCloseTo(1);
    expect(w.requests[0]?.language).toBe("auto");
    await transcriber.dispose();
  });

  test("passes a language hint through to the worker, defaults to auto", async () => {
    const w = new FakeWorker();
    w.onRequest = (req) => w.emit({ type: "result", id: req.id, text: "ok" });
    const { transcriber } = withWorkers(w);
    setTimeout(() => w.emitReady(), 0);

    await transcriber.transcribe(new Uint8Array([1]), "audio/ogg", { language: "fr" });
    expect(w.requests[0]?.language).toBe("fr");
    await transcriber.transcribe(new Uint8Array([1]), "audio/ogg");
    expect(w.requests[1]?.language).toBe("auto");
    await transcriber.dispose();
  });

  test("reuses one worker across multiple transcriptions (model load is expensive)", async () => {
    const w = new FakeWorker();
    w.onRequest = (req) => w.emit({ type: "result", id: req.id, text: "hi" });
    const { transcriber, spawned } = withWorkers(w);
    setTimeout(() => w.emitReady(), 0);

    await transcriber.transcribe(new Uint8Array([1]), "audio/ogg");
    await transcriber.transcribe(new Uint8Array([2]), "audio/ogg");
    expect(spawned).toHaveLength(1);
    await transcriber.dispose();
  });

  test("a worker that crashes (segfault = signal exit) rejects the in-flight call and does not propagate a process-killing error", async () => {
    const crashy = new FakeWorker();
    // Simulate a native segfault: the request arrives, then the worker dies by
    // signal with nothing written back.
    crashy.onRequest = () => crashy.emitExit({ code: null, signal: "SIGSEGV" });
    const healthy = new FakeWorker();
    healthy.onRequest = (req) => healthy.emit({ type: "result", id: req.id, text: "recovered" });

    const { transcriber, spawned } = withWorkers(crashy, healthy);
    setTimeout(() => crashy.emitReady(), 0);

    await expect(transcriber.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
      /worker died.*SIGSEGV/i,
    );

    // The supervisor must respawn on the next call — the model reloads and the
    // gateway keeps serving.
    setTimeout(() => healthy.emitReady(), 0);
    const result = await transcriber.transcribe(new Uint8Array([2]), "audio/ogg");
    expect(result.text).toBe("recovered");
    expect(spawned).toHaveLength(2);
    await transcriber.dispose();
  });

  test("a worker that emits a spawn `error` before ready rejects, then respawns next call", async () => {
    const broken = new FakeWorker();
    const healthy = new FakeWorker();
    healthy.onRequest = (req) => healthy.emit({ type: "result", id: req.id, text: "ok" });
    const { transcriber, spawned } = withWorkers(broken, healthy);
    // The worker fails to start (e.g. native dep missing) — error before ready.
    setTimeout(() => broken.emitExit({ code: null, signal: null, error: new Error("ENOENT") }), 0);

    await expect(transcriber.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
      /failed to start/i,
    );

    setTimeout(() => healthy.emitReady(), 0);
    const result = await transcriber.transcribe(new Uint8Array([2]), "audio/ogg");
    expect(result.text).toBe("ok");
    expect(spawned).toHaveLength(2);
    await transcriber.dispose();
  });

  test("a hung worker hits the request timeout → kill + reject, then respawns next call", async () => {
    const hung = new FakeWorker();
    // Never responds to the request → the timeout fires.
    hung.onRequest = () => {};
    const healthy = new FakeWorker();
    healthy.onRequest = (req) => healthy.emit({ type: "result", id: req.id, text: "ok" });
    const { transcriber, spawned } = withWorkers(hung, healthy);
    setTimeout(() => hung.emitReady(), 0);

    await expect(transcriber.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
      /timed out/i,
    );
    expect(hung.killed).toBe(true);

    setTimeout(() => healthy.emitReady(), 0);
    const result = await transcriber.transcribe(new Uint8Array([2]), "audio/ogg");
    expect(result.text).toBe("ok");
    expect(spawned).toHaveLength(2);
    await transcriber.dispose();
  });

  test("a per-request worker error rejects only that call, keeping the worker alive", async () => {
    const w = new FakeWorker();
    let n = 0;
    w.onRequest = (req) => {
      if (n++ === 0) w.emit({ type: "error", id: req.id, error: "decode failed" });
      else w.emit({ type: "result", id: req.id, text: "second" });
    };
    const { transcriber, spawned } = withWorkers(w);
    setTimeout(() => w.emitReady(), 0);

    await expect(transcriber.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(
      /decode failed/i,
    );
    // Same worker still serves the next call (a per-clip error is not a crash).
    const result = await transcriber.transcribe(new Uint8Array([2]), "audio/ogg");
    expect(result.text).toBe("second");
    expect(spawned).toHaveLength(1);
    await transcriber.dispose();
  });

  test("dispose kills the worker", async () => {
    const w = new FakeWorker();
    w.onRequest = (req) => w.emit({ type: "result", id: req.id, text: "hi" });
    const { transcriber } = withWorkers(w);
    setTimeout(() => w.emitReady(), 0);

    await transcriber.transcribe(new Uint8Array([1]), "audio/ogg");
    await transcriber.dispose();
    expect(w.killed).toBe(true);
  });

  test("dispose before any transcription does not spawn or throw", async () => {
    const spawn = vi.fn();
    const transcriber = new WhisperTranscriber({
      modelPath: "/m.bin",
      modelId: "whisper-tiny",
      spawnWorker: spawn as unknown as WhisperWorkerSpawner,
      decodeAudio: async () => new Float32Array(0),
    });
    await expect(transcriber.dispose()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("whisperDepsAvailable", () => {
  test("true when the module exposes a Whisper constructor", async () => {
    expect(await whisperDepsAvailable(async () => ({ Whisper: class {} as never }))).toBe(true);
  });

  test("false when the module import fails", async () => {
    expect(
      await whisperDepsAvailable(async () => {
        throw new Error("Cannot find module 'smart-whisper'");
      }),
    ).toBe(false);
  });
});

describe("computeWhisperTimeoutMs", () => {
  test("floors tiny / zero / negative clips at the minimum", () => {
    expect(computeWhisperTimeoutMs(0)).toBe(120_000);
    expect(computeWhisperTimeoutMs(1)).toBe(120_000); // 90_000 + 3_000 < 120_000 floor
    expect(computeWhisperTimeoutMs(-5)).toBe(120_000);
  });

  test("scales above the floor with clip duration", () => {
    // A 112s note (the kind that died at a flat 120s): 90_000 + 112*3_000 = 426_000.
    expect(computeWhisperTimeoutMs(112)).toBe(426_000);
    expect(computeWhisperTimeoutMs(300)).toBe(990_000);
  });

  test("ceils absurd durations at the hang-catcher maximum", () => {
    expect(computeWhisperTimeoutMs(100_000)).toBe(1_800_000);
  });
});

describe("WhisperTranscriber duration-scaled timeout", () => {
  test("a long clip survives past the old flat 120s budget, then times out at its scaled budget", async () => {
    vi.useFakeTimers();
    try {
      const hung = new FakeWorker();
      hung.onRequest = () => {}; // never responds → only the timeout can settle it
      const transcriber = new WhisperTranscriber({
        modelPath: "/m.bin",
        modelId: "whisper-tiny",
        spawnWorker: () => hung,
        decodeAudio: async () => new Float32Array(16_000 * 200), // 200s → 690_000ms budget
        // no requestTimeoutMs override → duration-scaled
      });
      setTimeout(() => hung.emitReady(), 0);
      const p = transcriber.transcribe(new Uint8Array([1]), "audio/ogg");
      let settled = "pending";
      void p.then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );

      await vi.advanceTimersByTimeAsync(0); // decode + ensureWorker(ready) → request timer armed
      await vi.advanceTimersByTimeAsync(120_000); // the OLD flat budget
      expect(settled).toBe("pending"); // would have been killed here before the fix
      expect(hung.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(600_000); // cross the 690_000ms scaled budget
      expect(settled).toBe("rejected");
      expect(hung.killed).toBe(true);
      await transcriber.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
