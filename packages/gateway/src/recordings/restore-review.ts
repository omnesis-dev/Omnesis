// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import type { OmnesisConfig } from "@omnesis/config";
import type Database from "better-sqlite3";
import type { ConfigStore } from "../config-store.js";

export interface RecordingRestoreReview {
  reviewRequired: boolean;
  hasPendingChunks: boolean;
  keepAudioDays: number;
  transcriberAssignment: string | null;
  speakers: "off" | "local" | "replay";
  version: string;
}
export class RecordingReviewChanged extends Error {
  constructor() {
    super("Recording choices changed. Review the current choices before resuming.");
  }
}

/** Metadata only: inspecting choices never loads a model or reads recording contents. */
export function recordingRestoreReview(
  config: OmnesisConfig,
  hasPendingChunks: boolean,
): RecordingRestoreReview {
  const selected = config.inference?.assignments?.transcriber;
  const choices = {
    hasPendingChunks,
    reviewRequired: config.inference?.recordings?.restoreReviewRequired === true,
    keepAudioDays: config.inference?.recordings?.keepAudioDays ?? 0,
    // InferenceRegistry defaults only the embedder; unassigned transcription is disabled.
    transcriberAssignment: selected ?? null,
    speakers: config.inference?.recordings?.speakers ?? ("off" as const),
  };
  // Bind the complete config, including backend endpoint changes, without disclosing it.
  return {
    ...choices,
    version: createHash("sha256").update(JSON.stringify({ config, choices })).digest("hex"),
  };
}
export async function resumeRecordingRestoreReview(
  store: ConfigStore,
  version: string,
  hasPendingChunks: () => boolean,
): Promise<void> {
  const result = await store.update((current) => {
    const reviewed = recordingRestoreReview(current, hasPendingChunks());
    if (reviewed.version !== version) throw new RecordingReviewChanged();
    if (reviewed.hasPendingChunks && reviewed.transcriberAssignment === null)
      throw new RecordingTranscriberRequired();
    return {
      ...current,
      inference: {
        ...current.inference,
        recordings: { ...current.inference?.recordings, restoreReviewRequired: false },
      },
    };
  });
  if (!result.ok) throw new Error("Recording review could not be saved.");
}

export class RecordingTranscriberRequired extends Error {
  constructor() {
    super("Choose a transcription model before resuming recordings with pending audio.");
  }
}
/** Uses idx_recording_chunks_due's status prefix; returns one bit without reading media. */
export function hasPendingRecordingChunks(db: Database.Database): boolean {
  return (
    db.prepare("SELECT 1 FROM recording_chunks WHERE status='pending' LIMIT 1").get() !== undefined
  );
}
