// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Chooses and prepares the voice separator for recorded conversations from
 * `recordings.speakers`: `off` (the default), `local` (sherpa-onnx on this
 * machine), or `replay` (tests). In `local` mode the two pinned models are
 * downloaded into the models directory the first time; until they are on
 * disk, transcription waits for preparation. If preparation is unavailable, transcription
 * can continue without speakers while existing voice vectors remain pending.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "@omnesis/core";

import { startDownload } from "../../models/downloader.js";
import { LocalVoiceSeparator, type VoiceModelPaths } from "./local-voice-separator.js";
import { ReplayVoiceSeparator } from "./replay-voice-separator.js";
import type { VoiceSeparator } from "./voices.js";

const log = createLogger("gateway:recordings:voices");

export type SpeakerSeparationMode = "off" | "local" | "replay";

const HF = "https://huggingface.co/csukuangfj";

/** pyannote segmentation-3.0 (MIT), exported to ONNX for sherpa-onnx. */
export const SEGMENTATION_MODEL = {
  filename: "speaker-segmentation-pyannote-3.0.onnx",
  downloadUrl: `${HF}/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx`,
  sizeBytes: 5_992_913,
  sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};

/**
 * 3D-Speaker ERes2Net base (Apache-2.0), exported to ONNX for sherpa-onnx.
 * Chosen over the VoxCeleb-trained WeSpeaker and NeMo TitaNet models because
 * it tells voices apart best from the one-to-four-second turns of a
 * conversation recorded by a phone on a table.
 */
export const EMBEDDING_MODEL = {
  filename: "speaker-embedding-3dspeaker-eres2net-base.onnx",
  downloadUrl: `${HF}/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`,
  sizeBytes: 39_593_761,
  sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
};

/** Whether the sherpa-onnx native binding loads on this machine. */
export async function sherpaAvailable(): Promise<boolean> {
  const specifier = "sherpa-onnx-node";
  try {
    const mod = (await import(specifier)) as {
      OfflineSpeakerDiarization?: unknown;
      default?: { OfflineSpeakerDiarization?: unknown };
    };
    return (
      typeof (mod.OfflineSpeakerDiarization ?? mod.default?.OfflineSpeakerDiarization) ===
      "function"
    );
  } catch {
    return false;
  }
}

export interface VoiceSeparatorPolicy {
  mode: SpeakerSeparationMode;
  reviewRequired: boolean;
  /** Feature availability never masquerades as an explicit off choice. */
  enabled?: boolean;
}
export type VoiceSeparatorReadiness = "ready" | "off" | "unavailable" | "superseded";
export interface VoiceSeparatorSource {
  current(): VoiceSeparator | null;
  /** Reconcile the current choice without waiting; all old ownership is joined before new preparation. */
  refresh(): void;
  revision(): number;
  settled(): Promise<VoiceSeparatorReadiness>;
  dispose(): Promise<void>;
}
export interface VoiceSeparatorSourceOptions {
  mode?: SpeakerSeparationMode;
  policy?: () => VoiceSeparatorPolicy;
  modelsDir: string;
  /** Test seams operate only on the fixed pinned model descriptors. */
  available?: () => Promise<boolean>;
  download?: (
    model: typeof SEGMENTATION_MODEL,
    modelsDir: string,
    signal: AbortSignal,
  ) => Promise<void>;
  create?: (models: VoiceModelPaths) => VoiceSeparator | Promise<VoiceSeparator>;
}

/** Own every preparation generation, including disposal and interrupted downloads. */
export function createVoiceSeparatorSource(
  opts: VoiceSeparatorSourceOptions,
): VoiceSeparatorSource {
  let separator: VoiceSeparator | null = null;
  let disposed = false,
    revision = 0;
  let policy: VoiceSeparatorPolicy | undefined;
  let controller = new AbortController();
  let task: Promise<void> = Promise.resolve();
  let state: VoiceSeparatorReadiness = "off";
  const readPolicy = (): VoiceSeparatorPolicy => {
    try {
      const value: VoiceSeparatorPolicy = opts.policy?.() ?? {
        mode: opts.mode ?? "off",
        reviewRequired: false,
      };
      return { ...value, enabled: value.enabled !== false };
    } catch {
      return { mode: "off", reviewRequired: true };
    }
  };
  const matches = (wanted: VoiceSeparatorPolicy) => {
    const current = readPolicy();
    return (
      current.mode === wanted.mode &&
      current.reviewRequired === wanted.reviewRequired &&
      current.enabled === wanted.enabled
    );
  };
  const refresh = () => {
    if (disposed) return;
    const next = readPolicy();
    if (
      policy?.mode === next.mode &&
      policy.reviewRequired === next.reviewRequired &&
      policy.enabled === next.enabled
    )
      return;
    policy = { ...next };
    const ownRevision = ++revision;
    controller.abort();
    const ownController = new AbortController();
    controller = ownController;
    const previous = task,
      retired = separator;
    separator = null;
    state = next.reviewRequired ? "superseded" : next.mode === "off" ? "off" : "unavailable";
    const current = () =>
      !disposed && ownRevision === revision && !ownController.signal.aborted && matches(next);
    task = (async () => {
      await previous;
      await retired?.dispose();
      if (!current() || next.reviewRequired || next.mode === "off" || next.enabled === false)
        return;
      let created: VoiceSeparator | undefined;
      try {
        if (next.mode === "replay") created = new ReplayVoiceSeparator();
        else {
          if (!(await (opts.available ?? sherpaAvailable)()) || !current()) return;
          for (const model of [SEGMENTATION_MODEL, EMBEDDING_MODEL]) {
            if (!current()) return;
            if (hasModel(opts.modelsDir, model)) continue;
            await (opts.download ?? downloadModel)(model, opts.modelsDir, ownController.signal);
            if (!current()) return;
          }
          if (!current()) return;
          created = await (opts.create ?? ((models) => new LocalVoiceSeparator({ models })))({
            segmentation: join(opts.modelsDir, SEGMENTATION_MODEL.filename),
            embedding: join(opts.modelsDir, EMBEDDING_MODEL.filename),
          });
        }
        if (!current()) {
          await created.dispose();
          return;
        }
        separator = created;
        state = "ready";
      } catch {
        if (created && created !== separator) await created.dispose();
        if (current()) state = "unavailable";
        log.warn(
          "Voice model preparation did not complete; recording voice history remains pending",
        );
      }
    })();
    // Disposal errors stay owned by task/settled/dispose, never become detached rejections.
    void task.catch(() => undefined);
  };
  refresh();
  return {
    refresh,
    current: () => {
      refresh();
      return disposed || policy?.reviewRequired || policy?.enabled === false ? null : separator;
    },
    revision: () => {
      refresh();
      return revision;
    },
    settled: async () => {
      refresh();
      const ownRevision = revision;
      try {
        await task;
      } catch {
        return "unavailable";
      }
      refresh();
      return disposed || ownRevision !== revision || policy?.reviewRequired ? "superseded" : state;
    },
    dispose: async () => {
      if (disposed) {
        await task;
        return;
      }
      disposed = true;
      revision++;
      controller.abort();
      const retired = separator;
      separator = null;
      const previous = task;
      task = (async () => {
        await previous;
        await retired?.dispose();
      })();
      await task;
    },
  };
}

function hasModel(modelsDir: string, model: typeof SEGMENTATION_MODEL): boolean {
  const path = join(modelsDir, model.filename);
  return existsSync(path) && statSync(path).size === model.sizeBytes;
}

async function downloadModel(
  model: typeof SEGMENTATION_MODEL,
  modelsDir: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const handle = startDownload(model, { modelsDir, onProgress: () => {} });
  const abort = () => handle.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    await handle.done;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
