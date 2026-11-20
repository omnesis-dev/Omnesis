// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createLogger,
  readSecretJsonFile,
  toErrorMessage,
  writeSecretTextFile,
} from "@omnesis/core";

const log = createLogger("source:plaud-recordings");

const TRANSCRIPTS_DIR = "transcripts";

/** A transcript the operator's transcriber made, and the audio it was made from. */
export interface CachedTranscript {
  /** Identifies the audio: a transcript is reused only while this is unchanged. */
  audioKey: string;
  text: string;
  language?: string;
}

/**
 * Transcripts already made from a recording's audio.
 *
 * A recording is rendered again whenever its title, tags or Plaud's own
 * processing change, none of which touch its audio. Transcribing an hour of
 * audio can take hours on a CPU, so the transcript is kept beside the
 * account's sign-in and reused until the audio itself changes. Losing it
 * costs a transcription, never data.
 */
export interface TranscriptCache {
  get(id: string, audioKey: string): Promise<CachedTranscript | undefined>;
  set(id: string, value: CachedTranscript): Promise<void>;
  /** Forget every recording not in `present`. */
  prune(present: ReadonlySet<string>): Promise<void>;
}

/** A cache held for the life of the instance only: tests, and a host with no state directory. */
export function memoryTranscriptCache(): TranscriptCache {
  const stored = new Map<string, CachedTranscript>();
  return {
    get: (id, audioKey) => {
      const hit = stored.get(id);
      return Promise.resolve(hit?.audioKey === audioKey ? hit : undefined);
    },
    set: (id, value) => {
      stored.set(id, value);
      return Promise.resolve();
    },
    prune: (present) => {
      for (const id of stored.keys()) if (!present.has(id)) stored.delete(id);
      return Promise.resolve();
    },
  };
}

/**
 * The cache in the account's state directory, one file per recording,
 * encrypted with the install's root key when it has one: a transcript is the
 * operator's own conversations.
 */
export function fileTranscriptCache(stateDir: string, configDir: string): TranscriptCache {
  const dir = join(stateDir, TRANSCRIPTS_DIR);
  const fileName = (id: string) =>
    `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`;
  return {
    async get(id, audioKey) {
      try {
        const value = await readSecretJsonFile<unknown>(join(dir, fileName(id)), { configDir });
        return isCachedTranscript(value) && value.audioKey === audioKey ? value : undefined;
      } catch (err) {
        log.warn(`Could not read a cached Plaud transcript: ${toErrorMessage(err)}`);
        return undefined;
      }
    },
    async set(id, value) {
      try {
        await writeSecretTextFile(join(dir, fileName(id)), JSON.stringify(value), { configDir });
      } catch (err) {
        // The document is already rendered; only a later re-render pays for this.
        log.warn(`Could not cache a Plaud transcript: ${toErrorMessage(err)}`);
      }
    },
    async prune(present) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      const keep = new Set([...present].map(fileName));
      for (const name of names) {
        if (!keep.has(name)) await rm(join(dir, name), { force: true }).catch(() => undefined);
      }
    },
  };
}

function isCachedTranscript(v: unknown): v is CachedTranscript {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.audioKey === "string" &&
    typeof c.text === "string" &&
    (c.language === undefined || typeof c.language === "string")
  );
}
