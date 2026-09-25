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
 *   - applies a per-request timeout (a hung whisper.cpp) that kills + respawns;
 *   - honors idle offload by forwarding `offloadSeconds` to the worker, where
 *     smart-whisper unloads the model weights after idle while the (cheap) JS
 *     process stays warm — so the next clip skips the ~50s model reload;
 *   - `dispose()` kills the worker.
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

import { spawn } from "node:child_process";
import { createLogger, resolveSubprocessEntry } from "@omnesis/core";
import { decodeToPcm16kMono } from "./audio-decode.js";
import {
  FrameDecoder,
  encodeFrame,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";
import type { TranscribeCapability, TranscriptionResult } from "@omnesis/core";

const log = createLogger("gateway:transcribe:whisper");

const SMART_WHISPER_SPECIFIER = "smart-whisper";

/** Idle seconds before smart-whisper offloads the model from memory. */
const DEFAULT_OFFLOAD_SECONDS = 300;

/** Sample rate of the decoded PCM (see `decodeToPcm16kMono`); samples ÷ rate = seconds. */
const PCM_SAMPLE_RATE = 16_000;

/**
 * Per-request wall-clock budget, derived from the clip's actual duration rather
 * than a flat number. It is `LOAD_BUDGET + MS_PER_AUDIO_SEC × durationSec`,
 * floored for tiny clips and ceiled so a truly hung native call (the segfault
 * sibling: it doesn't crash, it just never returns) is still killed + respawned
 * rather than wedging the serialized queue.
 *
 * A flat budget was wrong in two ways: it didn't account for the ~50s cold
 * reload after idle-offload, and it didn't scale with length — so a long voice
 * note on CPU (no GPU on this class of host) blew the budget mid-inference and
 * was dropped. Deriving from duration makes it correct on a fast GPU and a slow
 * CPU alike. `MS_PER_AUDIO_SEC` is a generous multiple of whisper.cpp's CPU
 * throughput (~sub-realtime warm), so it's a true hang-catcher, not a perf gate.
 */
const WHISPER_LOAD_BUDGET_MS = 90_000;
const WHISPER_MS_PER_AUDIO_SEC = 3_000;
const WHISPER_MIN_TIMEOUT_MS = 120_000;
const WHISPER_MAX_TIMEOUT_MS = 1_800_000;

/** Compute the per-request timeout (ms) for a clip of `durationSec` seconds. */
export function computeWhisperTimeoutMs(durationSec: number): number {
  const budget =
    WHISPER_LOAD_BUDGET_MS + Math.ceil(Math.max(durationSec, 0) * WHISPER_MS_PER_AUDIO_SEC);
  return Math.min(Math.max(budget, WHISPER_MIN_TIMEOUT_MS), WHISPER_MAX_TIMEOUT_MS);
}

/** A spawned worker process — minimal surface the supervisor drives. */
export interface WhisperWorkerProcess {
  /** Write a framed request to the worker's stdin. */
  write(frame: Buffer): void;
  /** Force-kill the worker. */
  kill(): void;
  /** Register a handler for each decoded worker→parent message. */
  onMessage(handler: (msg: WhisperWorkerMessage) => void): void;
  /** Register a handler for worker death (exit code/signal or spawn error). */
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void;
}

export interface SpawnWhisperWorkerArgs {
  modelPath: string;
  gpu: boolean;
  offloadSeconds: number;
}

/** Spawn a worker process. Injectable so tests run without a real subprocess. */
export type WhisperWorkerSpawner = (args: SpawnWhisperWorkerArgs) => WhisperWorkerProcess;

export type AudioDecoder = (bytes: Uint8Array, mimeType: string) => Promise<Float32Array>;

/**
 * Default spawner: launch `whisper-worker.ts` via `resolveSubprocessEntry` so
 * it works under tsx (dev) and compiled (published), and frame its stdio.
 */
export const defaultWhisperSpawner: WhisperWorkerSpawner = (args) => {
  const entry = resolveSubprocessEntry("./whisper-worker.ts", import.meta.url);
  const proc = spawn(
    entry.command,
    [...entry.args, args.modelPath, args.gpu ? "1" : "0", String(args.offloadSeconds)],
    { stdio: ["pipe", "pipe", "pipe"], cwd: import.meta.dirname },
  );
  // Surface worker stderr (its logger) into the gateway log at debug.
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    const trimmed = chunk.trimEnd();
    if (trimmed) log.debug(`worker: ${trimmed}`);
  });
  // EPIPE on stdin when the child has already died — exit/error paths report it.
  proc.stdin?.on("error", () => {});

  let messageHandler: ((msg: WhisperWorkerMessage) => void) | null = null;
  const decoder = new FrameDecoder((header) => {
    messageHandler?.(header as WhisperWorkerMessage);
  });
  proc.stdout?.on("data", (chunk: Buffer) => decoder.push(chunk));

  return {
    write: (frame) => proc.stdin?.write(frame),
    kill: () => proc.kill("SIGKILL"),
    onMessage: (handler) => {
      messageHandler = handler;
    },
    onExit: (handler) => {
      proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        handler({ code, signal }),
      );
      proc.on("error", (error: Error) => handler({ code: null, signal: null, error }));
    },
  };
};

export type WhisperModuleLoader = () => Promise<{ Whisper: unknown }>;

/** Default loader: import the optional `smart-whisper` native module. */
export const defaultWhisperLoader: WhisperModuleLoader = () =>
  import(SMART_WHISPER_SPECIFIER) as Promise<{ Whisper: unknown }>;

/** Whether the local-transcription native deps are installed and resolvable. */
export async function whisperDepsAvailable(
  loader: WhisperModuleLoader = defaultWhisperLoader,
): Promise<boolean> {
  try {
    const mod = await loader();
    return typeof (mod as { Whisper?: unknown })?.Whisper === "function";
  } catch {
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
   * timeout is derived per request from the clip duration (see
   * `computeWhisperTimeoutMs`). Tests set it for deterministic, fast timeouts.
   */
  requestTimeoutMs?: number;
  /** Injectable for tests; defaults to spawning the real worker subprocess. */
  spawnWorker?: WhisperWorkerSpawner;
  /** Injectable for tests; defaults to ffmpeg-static decoding. */
  decodeAudio?: AudioDecoder;
}

interface PendingRequest {
  id: number;
  resolve: (r: TranscriptionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WhisperTranscriber implements TranscribeCapability {
  readonly name: string;
  readonly modelId: string;
  private readonly modelPath: string;
  private readonly gpu: boolean;
  private readonly offloadSeconds: number;
  /** Explicit timeout override; when undefined, derived per request from duration. */
  private readonly requestTimeoutMs: number | undefined;
  private readonly spawnWorker: WhisperWorkerSpawner;
  private readonly decodeAudio: AudioDecoder;

  private worker: WhisperWorkerProcess | null = null;
  /** Resolves to the running worker once its `ready` frame arrives. */
  private starting: Promise<WhisperWorkerProcess> | null = null;
  private nextId = 1;
  /** In-flight requests keyed by id, so a worker death rejects them all. */
  private readonly pending = new Map<number, PendingRequest>();

  constructor(opts: WhisperTranscriberOptions) {
    this.modelPath = opts.modelPath;
    this.modelId = opts.modelId;
    this.name = opts.name ?? opts.modelId;
    this.gpu = opts.gpu ?? process.platform === "darwin";
    this.offloadSeconds = opts.offloadSeconds ?? DEFAULT_OFFLOAD_SECONDS;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.spawnWorker = opts.spawnWorker ?? defaultWhisperSpawner;
    this.decodeAudio = opts.decodeAudio ?? ((bytes) => decodeToPcm16kMono(bytes));
  }

  /** Lazily spawn the worker and wait for its `ready`; reuse it thereafter. */
  private async ensureWorker(): Promise<WhisperWorkerProcess> {
    if (this.worker) return this.worker;
    if (this.starting) return this.starting;
    this.starting = new Promise<WhisperWorkerProcess>((resolve, reject) => {
      const proc = this.spawnWorker({
        modelPath: this.modelPath,
        gpu: this.gpu,
        offloadSeconds: this.offloadSeconds,
      });
      let ready = false;
      proc.onMessage((msg) => {
        if (msg.type === "ready") {
          ready = true;
          this.worker = proc;
          log.info(`Whisper worker ready for ${this.modelId} (gpu=${this.gpu})`);
          resolve(proc);
          return;
        }
        this.onWorkerMessage(msg);
      });
      proc.onExit((info) => {
        // A death before `ready` fails the spawn; a death after fails whatever
        // is in flight. Either way the worker is gone — drop it and respawn next.
        this.handleWorkerDeath(proc, info);
        if (!ready) {
          const why = info.error
            ? info.error.message
            : `worker exited ${info.signal ? `with signal ${info.signal}` : `code ${info.code}`}`;
          reject(new Error(`Whisper worker failed to start: ${why}`));
        }
      });
    });
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Route a result/error frame to its pending request. */
  private onWorkerMessage(msg: WhisperWorkerMessage): void {
    if (msg.type === "ready") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.type === "result") {
      pending.resolve({ text: msg.text, language: msg.language, durationSec: msg.durationSec });
    } else {
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Mark the worker dead and reject every in-flight request. The next
   * transcribe respawns it (reloading the model). A segfault lands here as a
   * signal exit; a clean idle/dispose exit also lands here with no pending work.
   */
  private handleWorkerDeath(
    proc: WhisperWorkerProcess,
    info: { code: number | null; signal: string | null; error?: Error },
  ): void {
    if (this.worker === proc) this.worker = null;
    const why = info.error
      ? info.error.message
      : info.signal
        ? `signal ${info.signal}`
        : `code ${info.code}`;
    if (this.pending.size > 0) {
      log.warn(`Whisper worker died (${why}) with ${this.pending.size} in-flight — will respawn`);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Whisper worker died: ${why}`));
    }
    this.pending.clear();
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string },
  ): Promise<TranscriptionResult> {
    const pcm = await this.decodeAudio(audio, mimeType);
    let worker: WhisperWorkerProcess;
    try {
      worker = await this.ensureWorker();
    } catch (err) {
      // Spawn/model-load failure — let it propagate as a thrown error; the
      // service translates it to null and leaves the note to retry.
      throw err instanceof Error ? err : new Error(String(err));
    }

    const id = this.nextId++;
    const header: WhisperRequestHeader = {
      type: "request",
      id,
      pcmBytes: pcm.byteLength,
      language: opts?.language ?? "auto",
    };
    // Budget = explicit override (tests) or a duration-scaled value that covers
    // a cold reload plus the inference itself — so a long clip on CPU isn't
    // killed mid-transcribe.
    const timeoutMs =
      this.requestTimeoutMs ?? computeWhisperTimeoutMs(pcm.length / PCM_SAMPLE_RATE);
    return new Promise<TranscriptionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A hung whisper.cpp call: reject this request, kill the worker (which
        // fires onExit → rejects nothing else since we already removed it), and
        // respawn on the next call.
        if (this.pending.delete(id)) {
          log.warn(`Whisper request ${id} timed out after ${timeoutMs}ms — killing worker`);
          worker.kill();
          reject(new Error(`Whisper transcription timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { id, resolve, reject, timer });
      worker.write(encodeFrame(header, pcm));
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    // Fail anything still queued and stop their timers before tearing down.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Whisper transcriber disposed"));
    }
    this.pending.clear();
    if (worker) worker.kill();
  }
}
