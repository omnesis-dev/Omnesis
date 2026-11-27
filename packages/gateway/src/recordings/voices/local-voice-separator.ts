// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Supervises the voice worker subprocess (`voice-worker.ts`): spawns it on
 * first use, serialises requests to it, gives a request up (killing the
 * worker) at its deadline, respawns after a crash, and stops the worker
 * after a while without work so its models leave memory.
 */

import { createLogger, resolveSubprocessEntry, spawnOwnedChildProcess } from "@omnesis/core";

import { decodeToPcm16kMono, type AudioDecoder } from "../../transcribe/audio-decode.js";
import {
  encodeFrame,
  FrameDecoder,
  type VoiceRequestHeader,
  type VoiceWorkerMessage,
} from "./voice-worker-protocol.js";
import {
  packVectors,
  SAME_SPEAKER_SIMILARITY,
  type SeparatedVoices,
  type VoiceSeparator,
} from "./voices.js";

const log = createLogger("gateway:recordings:voices");

/** Longest a request may take: a minute of audio takes a few seconds on a CPU. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** The worker is stopped after this long without a request. */
const IDLE_STOP_MS = 5 * 60_000;

export interface VoiceWorkerProcess {
  write(frame: Buffer): void;
  stop(): Promise<void>;
  readonly joined: Promise<void>;
  onMessage(handler: (msg: VoiceWorkerMessage) => void): void;
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void;
}

export type VoiceWorkerSpawner = (models: VoiceModelPaths) => VoiceWorkerProcess;

export interface VoiceModelPaths {
  segmentation: string;
  embedding: string;
}

export const defaultVoiceWorkerSpawner: VoiceWorkerSpawner = (models) => {
  const entry = resolveSubprocessEntry("./voice-worker.ts", import.meta.url);
  const owner = spawnOwnedChildProcess(
    entry.command,
    [...entry.args, models.segmentation, models.embedding],
    {
      cwd: import.meta.dirname,
      env: process.env,
      stopSignal: "SIGKILL",
    },
  );
  const proc = owner.child;
  void owner.ready.catch(() => undefined);
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    const trimmed = chunk.trimEnd();
    if (trimmed) log.debug(`worker: ${trimmed}`);
  });
  proc.stdin?.on("error", () => {});
  let handler: ((msg: VoiceWorkerMessage) => void) | null = null;
  const decoder = new FrameDecoder((header) => handler?.(header as VoiceWorkerMessage));
  proc.stdout?.on("data", (chunk: Buffer) => decoder.push(chunk));
  return {
    write: (frame) => proc.stdin?.write(frame),
    stop: () => owner.stop(),
    joined: owner.joined,
    onMessage: (h) => {
      handler = h;
    },
    onExit: (h) => {
      let failure: Error | undefined;
      proc.on("error", (error) => {
        failure = error;
      });
      proc.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
        h({ code, signal, ...(failure ? { error: failure } : {}) }),
      );
    },
  };
};

type Result = VoiceWorkerMessage & { type: "result" };

interface Pending {
  resolve: (r: Result) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalVoiceSeparatorOptions {
  models: VoiceModelPaths;
  /** Identifies the embedding model, for the owner's voice profile. */
  model: string;
  spawnWorker?: VoiceWorkerSpawner;
  decodeAudio?: AudioDecoder;
  requestTimeoutMs?: number;
  idleStopMs?: number;
}

export class LocalVoiceSeparator implements VoiceSeparator {
  readonly name = "sherpa-onnx";
  readonly model: string;
  private readonly models: VoiceModelPaths;
  private readonly spawnWorker: VoiceWorkerSpawner;
  private readonly decodeAudio: AudioDecoder;
  private readonly requestTimeoutMs: number;
  private readonly idleStopMs: number;
  private worker: VoiceWorkerProcess | null = null;
  private starting: Promise<VoiceWorkerProcess> | null = null;
  private stopping: Promise<void> | null = null;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private cancelStarting: (() => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LocalVoiceSeparatorOptions) {
    this.models = opts.models;
    this.model = opts.model;
    this.spawnWorker = opts.spawnWorker ?? defaultVoiceWorkerSpawner;
    this.decodeAudio = opts.decodeAudio ?? ((bytes) => decodeToPcm16kMono(bytes));
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.idleStopMs = opts.idleStopMs ?? IDLE_STOP_MS;
  }

  async separate(audio: Uint8Array, mimeType: string): Promise<SeparatedVoices> {
    if (this.disposed) throw new Error("voice separator disposed");
    const pcm = await this.decodeAudio(audio, mimeType);
    if (pcm.length === 0) return { windows: [], vectors: [] };
    const result = await this.request({ op: "separate" }, pcm);
    const windows = result.windows ?? [];
    const vectors = (result.vectors ?? []).map((v) => Float32Array.from(v));
    if (vectors.length !== windows.length) throw new Error("voice worker sent mismatched vectors");
    return { windows, vectors };
  }

  async group(vectors: readonly Float32Array[], durationsMs: readonly number[]): Promise<number[]> {
    if (this.disposed) throw new Error("voice separator disposed");
    const packed = packVectors(vectors);
    if (!packed) return [];
    const result = await this.request(
      {
        op: "group",
        count: vectors.length,
        threshold: SAME_SPEAKER_SIMILARITY,
        durationsMs: [...durationsMs],
      },
      packed,
    );
    const labels = result.labels ?? [];
    if (labels.length !== vectors.length) throw new Error("voice worker sent mismatched labels");
    return labels;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.clearIdle();
    this.cancelStarting?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("voice separator disposed"));
    }
    this.pending.clear();
    this.disposal = this.worker
      ? this.stopWorker(this.worker)
      : (this.stopping ?? Promise.resolve());
    return this.disposal;
  }

  private stopWorker(worker: VoiceWorkerProcess): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      await worker.stop();
      await worker.joined;
      if (this.worker === worker) this.worker = null;
    })();
    this.stopping = stopping;
    void stopping.then(
      () => {
        if (this.stopping === stopping) this.stopping = null;
      },
      () => undefined,
    );
    return stopping;
  }

  private async request(
    fields: Pick<VoiceRequestHeader, "op" | "count" | "threshold" | "durationsMs">,
    tail: ArrayBufferView,
  ): Promise<Result> {
    this.clearIdle();
    const worker = await this.ensureWorker();
    if (this.disposed) throw new Error("voice separator disposed");
    const id = this.nextId++;
    const header: VoiceRequestHeader = {
      type: "request",
      id,
      pcmBytes: tail.byteLength,
      ...fields,
    };
    try {
      return await new Promise<Result>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          // The native call cannot be interrupted: stop the worker instead.
          log.warn(
            `Voice request ${id} timed out after ${this.requestTimeoutMs}ms — killing worker`,
          );
          void this.stopWorker(worker).catch(() => undefined);
          reject(new Error(`voice ${fields.op} timed out`));
        }, this.requestTimeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        worker.write(encodeFrame(header, tail));
      });
    } finally {
      if (this.pending.size === 0) this.armIdle();
    }
  }

  private async ensureWorker(): Promise<VoiceWorkerProcess> {
    if (this.disposed) throw new Error("voice separator disposed");
    if (this.stopping) await this.stopping;
    if (this.disposed) throw new Error("voice separator disposed");
    if (this.starting) return this.starting;
    if (this.worker) return this.worker;
    this.starting = new Promise<VoiceWorkerProcess>((resolve, reject) => {
      const proc = this.spawnWorker(this.models);
      // Retain startup ownership immediately, before the ready message or any possible exit.
      this.worker = proc;
      this.cancelStarting = () => reject(new Error("voice separator disposed"));
      let ready = false;
      proc.onMessage((msg) => {
        if (this.disposed || this.stopping) return;
        if (msg.type === "ready") {
          ready = true;
          this.worker = proc;
          resolve(proc);
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "result") p.resolve(msg);
        else p.reject(new Error(msg.error));
      });
      proc.onExit((info) => {
        // Exit/error notification never substitutes for the owned physical join.
        void this.stopWorker(proc).catch(() => undefined);
        const why =
          info.error?.message ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`voice worker died: ${why}`));
        }
        this.pending.clear();
        if (!ready) reject(new Error(`voice worker failed to start: ${why}`));
      });
    });
    try {
      return await this.starting;
    } finally {
      this.starting = null;
      this.cancelStarting = undefined;
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0 || !this.worker) return;
      void this.stopWorker(this.worker).catch(() => undefined);
    }, this.idleStopMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
