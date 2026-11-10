// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local Whisper transcriber backed by whisper.cpp (the `smart-whisper` native
 * binding). The native model runs in an ISOLATED subprocess (`whisper-worker.ts`),
 * not in the gateway process: whisper.cpp has segfaulted mid-transcription, and
 * a native segfault is process-wide — a Node worker_thread shares the process
 * and would crash the whole gateway with it (taking down OCR, search, sync,
 * everything). Only a separate OS process isolates the crash.
 *
 * This class is the supervisor running in the gateway:
 *   - spawns the worker lazily on the first transcribe and keeps it for
 *     subsequent calls (model load is ~50s — never spawn-per-call);
 *   - on a worker `exit`/`error` (a segfault is a signal/non-zero exit) it
 *     rejects the in-flight call, marks the worker dead, and respawns on the
 *     next call — so a single bad clip can't take the gateway down, and the
 *     caller (TranscribeService) sees the rejection translated to null;
 *   - sends a long recording ten minutes at a time (`chunks.ts`), and applies
 *     each request's own timeout (a hung whisper.cpp) that kills + respawns;
 *   - honors idle offload by forwarding `offloadSeconds` to the worker, where
 *     smart-whisper unloads the model weights after idle while the (cheap) JS
 *     process stays warm — so the next clip skips the ~50s model reload;
 *   - `dispose()` closes admission, cancels decoding and joins every owned worker.
 *
 * Audio never leaves the machine: it's decoded to 16 kHz mono f32 PCM in-process
 * (ffmpeg-static via audio-decode.ts) and only the PCM is shipped to the worker.
 *
 * `smart-whisper` and `ffmpeg-static` are OPTIONAL dependencies — heavy, native,
 * and only needed when local transcription is actually used. The worker imports
 * smart-whisper through a non-literal specifier; the loader (`loader.ts`) probes
 * for it and reports the transcriber unavailable when it's missing. The
 * subprocess spawner and the audio decoder are injectable so unit tests run
 * without either a real child process or the native deps.
 */

import { createLogger, ownedProcessCleanupReceipt } from "@omnesis/core";
import { PCM_SAMPLE_RATE, decodeToPcm16kMono, type AudioDecoder } from "./audio-decode.js";
import {
  encodeFrame,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";
import { adaptTranscriptionVocabulary } from "./vocabulary-adapter.js";
import { transcribeInChunks, type ChunkTranscript } from "./chunks.js";
import type { TranscribeCapability, TranscriptionResult } from "@omnesis/core";

const log = createLogger("gateway:transcribe:whisper");

const SMART_WHISPER_SPECIFIER = "smart-whisper";

/** Idle seconds before smart-whisper offloads the model from memory. */
const DEFAULT_OFFLOAD_SECONDS = 300;

export { defaultWhisperSpawner } from "./whisper-worker-process.js";
export type {
  WhisperWorkerProcess,
  SpawnWhisperWorkerArgs,
  WhisperWorkerSpawner,
} from "./whisper-worker-process.js";
import {
  defaultWhisperSpawner,
  type WhisperWorkerProcess,
  type WhisperWorkerSpawner,
} from "./whisper-worker-process.js";

export type WhisperModuleLoader = () => Promise<{ Whisper: unknown }>;

/** Default loader: import the optional `smart-whisper` native module. */
export const defaultWhisperLoader: WhisperModuleLoader = () =>
  import(SMART_WHISPER_SPECIFIER) as Promise<{ Whisper: unknown }>;

/**
 * Why a local Whisper model cannot run when `whisperDepsAvailable` is false.
 * `smart-whisper` is an optional dependency that compiles whisper.cpp when
 * Omnesis is installed and is left out where that build fails: on a host
 * without a C/C++ toolchain, and on Linux with GCC 14 or later, whose compiler
 * rejects the whisper.cpp source it bundles (#891). Installing again does not
 * help there, so the message points at a transcription server instead.
 */
export const LOCAL_WHISPER_UNAVAILABLE =
  "Local Whisper models cannot run on this gateway: their whisper.cpp engine could not be built on this machine when Omnesis was installed. Assign the transcriber to a transcription server instead.";

/** Whether the local-transcription native module is installed and loads. */
export async function whisperDepsAvailable(
  loader: WhisperModuleLoader = defaultWhisperLoader,
): Promise<boolean> {
  try {
    const mod = await loader();
    return typeof (mod as { Whisper?: unknown })?.Whisper === "function";
  } catch (error) {
    if (ownedProcessCleanupReceipt(error)) throw error;
    return false;
  }
}

export interface WhisperTranscriberOptions {
  /** Path to the whisper.cpp GGML `.bin` model file. */
  modelPath: string;
  /** Catalog id, surfaced as `modelId`. */
  modelId: string;
  /** Display name. */
  name?: string;
  /** Use the GPU. Defaults to Metal on macOS, CPU elsewhere. */
  gpu?: boolean;
  /** Idle seconds before the model offloads (passed to the worker). */
  offloadSeconds?: number;
  /**
   * Explicit per-request timeout override (ms). When unset (the default), the
   * timeout is derived per request from the chunk's duration (see `chunks.ts`
   * and `deadline.ts`). Tests set it for deterministic, fast timeouts.
   */
  requestTimeoutMs?: number;
  /** Injectable for tests; defaults to spawning the real worker subprocess. */
  spawnWorker?: WhisperWorkerSpawner;
  /** Injectable for tests; defaults to ffmpeg-static decoding. */
  decodeAudio?: AudioDecoder;
}

interface PendingRequest {
  worker: WhisperWorkerProcess;
  resolve: (r: ChunkTranscript) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WhisperTranscriber implements TranscribeCapability {
  readonly vocabularyRuntime = "smart-whisper" as const;
  readonly name: string;
  readonly modelId: string;
  private readonly modelPath: string;
  private readonly gpu: boolean;
  private readonly offloadSeconds: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly spawnWorker: WhisperWorkerSpawner;
  private readonly decodeAudio: AudioDecoder;
  private worker: WhisperWorkerProcess | null = null;
  private startingWorker: WhisperWorkerProcess | null = null;
  private starting: Promise<WhisperWorkerProcess> | null = null;
  private readonly owners = new Set<WhisperWorkerProcess>();
  private readonly retiring = new Map<WhisperWorkerProcess, Promise<void>>();
  private readonly startupRejects = new Map<WhisperWorkerProcess, (error: unknown) => void>();
  private readonly accepted = new Set<Promise<TranscriptionResult>>();
  private readonly shutdown = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;
  private terminalFailure: unknown;
  private readonly pendingCleanup = Object.assign(new Error("Whisper work remains owned"), {
    cleanupFailure: undefined,
    cleanupPending: true as const,
  });
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(opts: WhisperTranscriberOptions) {
    this.modelPath = opts.modelPath;
    this.modelId = opts.modelId;
    this.name = opts.name ?? opts.modelId;
    this.gpu = opts.gpu ?? process.platform === "darwin";
    this.offloadSeconds = opts.offloadSeconds ?? DEFAULT_OFFLOAD_SECONDS;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.spawnWorker = opts.spawnWorker ?? defaultWhisperSpawner;
    this.decodeAudio =
      opts.decodeAudio ??
      ((bytes, _mime, options) => decodeToPcm16kMono(bytes, { signal: options?.signal }));
  }

  cleanupFailure(): unknown {
    return (
      this.terminalFailure ??
      (this.owners.size || this.starting || this.accepted.size ? this.pendingCleanup : undefined)
    );
  }

  private assertOpen(): void {
    if (this.terminalFailure) throw this.terminalFailure;
    if (this.closed) throw new Error("Whisper transcriber disposed");
  }

  private retainFailure(error: unknown): void {
    const receipt = ownedProcessCleanupReceipt(error);
    if (receipt)
      this.terminalFailure ??= Object.assign(
        new Error("Whisper cleanup is unconfirmed", { cause: error }),
        { cleanupFailure: receipt.failure },
      );
  }

  /** Replacements wait for physical closure, including a worker still loading its model. */
  private async ensureWorker(signal: AbortSignal): Promise<WhisperWorkerProcess> {
    this.assertOpen();
    signal.throwIfAborted();
    if (this.retiring.size) await Promise.all(this.retiring.values());
    this.assertOpen();
    signal.throwIfAborted();
    if (this.starting) return this.starting;
    if (this.worker) return this.worker;
    const starting = new Promise<WhisperWorkerProcess>((resolve, reject) => {
      const proc = this.spawnWorker({
        modelPath: this.modelPath,
        gpu: this.gpu,
        offloadSeconds: this.offloadSeconds,
      });
      this.startingWorker = proc;
      this.owners.add(proc);
      this.startupRejects.set(proc, reject);
      proc.onMessage((msg) => {
        if (this.closed || this.retiring.has(proc) || !this.owners.has(proc)) return;
        if (msg.type === "ready") {
          this.worker = proc;
          this.startupRejects.delete(proc);
          log.info(`Whisper worker ready for ${this.modelId} (gpu=${this.gpu})`);
          resolve(proc);
        } else this.onWorkerMessage(proc, msg);
      });
      proc.onExit((info) => {
        const cause =
          info.error ??
          new Error(
            `Whisper worker died: ${info.signal ? `signal ${info.signal}` : `code ${info.code}`}`,
          );
        const reason = this.startupRejects.has(proc)
          ? new Error(`Whisper worker failed to start: ${cause.message}`, { cause })
          : cause;
        this.retainFailure(reason);
        if (this.owners.has(proc)) void this.retire(proc, reason).catch(() => {});
      });
      void proc.joined.catch((error: unknown) => {
        this.retainFailure(error);
        if (this.owners.has(proc)) void this.retire(proc, error).catch(() => {});
      });
    });
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private onWorkerMessage(proc: WhisperWorkerProcess, msg: WhisperWorkerMessage): void {
    if (msg.type === "ready") return;
    const pending = this.pending.get(msg.id);
    if (!pending || pending.worker !== proc) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.type === "result")
      pending.resolve({
        text: msg.text,
        ...(msg.language ? { language: msg.language } : {}),
        ...(msg.segments ? { segments: msg.segments } : {}),
      });
    else pending.reject(new Error(msg.error));
  }

  /** Kill requests do not prove closure; retain every owner and its pending calls until joined. */
  private retire(proc: WhisperWorkerProcess, reason: unknown): Promise<void> {
    this.retainFailure(reason);
    const existing = this.retiring.get(proc);
    if (existing) return existing;
    if (this.worker === proc) this.worker = null;
    for (const pending of this.pending.values())
      if (pending.worker === proc) clearTimeout(pending.timer);
    const stopping = (async () => {
      // Publish the retained retirement before kill can synchronously report an exit.
      await Promise.resolve();
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => proc.kill()),
        proc.joined,
      ]);
      const errors = outcomes.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      let failure: unknown = errors.length
        ? new AggregateError(errors, "Whisper worker stop failed", {
            cause: errors.find((error) => ownedProcessCleanupReceipt(error)),
          })
        : undefined;
      const joined = outcomes[1]!;
      if (joined.status === "rejected" || !proc.joinedConfirmed) {
        const receipt = ownedProcessCleanupReceipt(failure);
        const cleanupFailure = receipt
          ? receipt.failure
          : joined.status === "rejected"
            ? (joined.reason as unknown)
            : failure;
        failure = Object.assign(
          new Error("Whisper worker closure is unconfirmed", { cause: failure }),
          { cleanupFailure },
        );
      }
      this.retainFailure(failure);
      failure ??= this.terminalFailure;
      this.startupRejects.get(proc)?.(failure ?? reason);
      this.startupRejects.delete(proc);
      for (const [id, pending] of this.pending)
        if (pending.worker === proc) {
          this.pending.delete(id);
          pending.reject(failure ?? reason);
        }
      if (this.startingWorker === proc) this.startingWorker = null;
      if (proc.joinedConfirmed && !ownedProcessCleanupReceipt(failure)) {
        this.owners.delete(proc);
        this.retiring.delete(proc);
      }
      if (failure) throw failure;
    })();
    this.retiring.set(proc, stopping);
    void stopping.catch(() => {});
    return stopping;
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: Parameters<TranscribeCapability["transcribe"]>[2],
  ): Promise<TranscriptionResult> {
    this.assertOpen();
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, this.shutdown.signal])
      : this.shutdown.signal;
    const work = this.performTranscription(audio, mimeType, opts, signal);
    this.accepted.add(work);
    try {
      return await work;
    } catch (error) {
      this.retainFailure(error);
      throw error;
    } finally {
      this.accepted.delete(work);
    }
  }

  private async performTranscription(
    audio: Uint8Array,
    mimeType: string,
    opts: Parameters<TranscribeCapability["transcribe"]>[2],
    signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    signal.throwIfAborted();
    const pcm = await this.decodeAudio(audio, mimeType, { signal });
    this.assertOpen();
    signal.throwIfAborted();
    const vocabularyHint = opts?.vocabulary
      ? adaptTranscriptionVocabulary(opts.vocabulary, {
          runtime: this.vocabularyRuntime,
          maxPromptTokens: opts.maxPromptTokens,
        })
      : undefined;
    const { text, language, segments } = await transcribeInChunks(
      pcm,
      { minTimeoutMs: opts?.minTimeoutMs },
      (chunk, ms) =>
        this.request(
          chunk,
          opts?.language ?? "auto",
          vocabularyHint,
          this.requestTimeoutMs ?? ms,
          signal,
        ),
    );
    return {
      text,
      language,
      durationSec: pcm.length / PCM_SAMPLE_RATE,
      ...(segments ? { segments } : {}),
    };
  }

  /** A chunk's deadline covers cold model loading as well as inference. */
  private async request(
    pcm: Float32Array,
    language: string,
    vocabularyHint: WhisperRequestHeader["vocabularyHint"],
    timeoutMs: number,
    caller: AbortSignal,
  ): Promise<ChunkTranscript> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller, deadline.signal]);
    const timer = setTimeout(
      () => deadline.abort(new Error(`Whisper transcription timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    let worker: WhisperWorkerProcess | undefined;
    const onAbort = () => {
      const owner = worker ?? this.startingWorker ?? this.worker;
      if (owner) void this.retire(owner, signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      worker = await this.ensureWorker(signal);
      signal.throwIfAborted();
      this.assertOpen();
      const id = this.nextId++;
      return await new Promise<ChunkTranscript>((resolve, reject) => {
        this.pending.set(id, { worker: worker!, resolve, reject, timer });
        try {
          worker!.write(
            encodeFrame(
              {
                type: "request",
                id,
                pcmBytes: pcm.byteLength,
                language,
                ...(vocabularyHint ? { vocabularyHint } : {}),
              } satisfies WhisperRequestHeader,
              pcm,
            ),
          );
        } catch (error) {
          void this.retire(worker!, error).catch(() => {});
        }
      });
    } catch (error) {
      const owner = worker ?? this.startingWorker ?? this.worker;
      if (signal.aborted && owner) await this.retire(owner, signal.reason);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const reason = new Error("Whisper transcriber disposed");
    this.shutdown.abort(reason);
    const stops = [...this.owners].map((proc) => this.retire(proc, reason));
    this.closing = (async () => {
      const stopped = await Promise.allSettled(stops);
      await this.starting?.catch(() => {});
      await Promise.allSettled(this.accepted);
      const remaining = await Promise.allSettled(this.retiring.values());
      if (this.terminalFailure) throw this.terminalFailure;
      const failures = [...stopped, ...remaining].flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Whisper disposal failed");
    })();
    void this.closing.catch(() => {});
    return this.closing;
  }
}
