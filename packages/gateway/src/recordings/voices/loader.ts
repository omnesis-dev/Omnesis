// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Chooses and prepares the voice separator for recorded conversations from
 * `recordings.speakers`: `off` (the default), `local` (sherpa-onnx on this
 * machine), or `replay` (tests). In `local` mode the two pinned models are
 * downloaded into the models directory the first time; until they are on
 * disk, recordings are transcribed without speakers.
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

/** WeSpeaker ResNet34-LM trained on VoxCeleb, exported to ONNX for sherpa-onnx. */
export const EMBEDDING_MODEL = {
  filename: "speaker-embedding-wespeaker-resnet34-lm.onnx",
  downloadUrl: `${HF}/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/wespeaker_en_voxceleb_resnet34_LM.onnx`,
  sizeBytes: 26_530_550,
  sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
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

export interface VoiceSeparatorSource {
  /** The separator, or null while it is off or not ready yet. */
  current(): VoiceSeparator | null;
  dispose(): Promise<void>;
}

export interface VoiceSeparatorSourceOptions {
  mode: SpeakerSeparationMode;
  modelsDir: string;
  /** Test seams. */
  available?: () => Promise<boolean>;
  download?: (model: typeof SEGMENTATION_MODEL, modelsDir: string) => Promise<void>;
  create?: (models: VoiceModelPaths) => VoiceSeparator;
}

/** Prepare the configured separator in the background; `current()` is null until it is ready. */
export function createVoiceSeparatorSource(
  opts: VoiceSeparatorSourceOptions,
): VoiceSeparatorSource {
  let separator: VoiceSeparator | null = opts.mode === "replay" ? new ReplayVoiceSeparator() : null;
  let disposed = false;

  if (opts.mode === "local") {
    const available = opts.available ?? sherpaAvailable;
    const download = opts.download ?? downloadModel;
    const create = opts.create ?? ((models) => new LocalVoiceSeparator({ models }));
    void (async () => {
      if (!(await available())) {
        log.warn(
          "Telling speakers apart needs the sherpa-onnx-node package; recordings are transcribed without speakers",
        );
        return;
      }
      for (const model of [SEGMENTATION_MODEL, EMBEDDING_MODEL]) {
        if (hasModel(opts.modelsDir, model)) continue;
        log.info(`Downloading voice model ${model.filename}`);
        await download(model, opts.modelsDir);
      }
      if (disposed) return;
      separator = create({
        segmentation: join(opts.modelsDir, SEGMENTATION_MODEL.filename),
        embedding: join(opts.modelsDir, EMBEDDING_MODEL.filename),
      });
      log.info("Recordings will tell speakers apart");
    })().catch((err: unknown) => {
      log.warn(
        `Voice models unavailable; recordings are transcribed without speakers: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  return {
    current: () => separator,
    dispose: async () => {
      disposed = true;
      const s = separator;
      separator = null;
      await s?.dispose();
    },
  };
}

function hasModel(modelsDir: string, model: typeof SEGMENTATION_MODEL): boolean {
  const path = join(modelsDir, model.filename);
  return existsSync(path) && statSync(path).size === model.sizeBytes;
}

async function downloadModel(model: typeof SEGMENTATION_MODEL, modelsDir: string): Promise<void> {
  await startDownload(model, { modelsDir, onProgress: () => {} }).done;
}
