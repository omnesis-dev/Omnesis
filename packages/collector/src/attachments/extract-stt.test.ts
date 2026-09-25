// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The speech-to-text seam inside the shared attachment extractor: when an
 * `AudioTranscribeFn` is wired, audio attachments on document sources (email)
 * are transcribed into a child doc; with no `transcribe` fn the extractor never
 * touches audio. Conversation sources never route audio here.
 */

import { describe, test, expect, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { createAttachmentExtractor } from "./extract.js";
import type { AudioTranscribeFn } from "@omnesis/core";

const enc = (s: string) => new TextEncoder().encode(s);

describe("createAttachmentExtractor — STT", () => {
  test("routes audio attachments to STT and returns the transcript", async () => {
    const transcribe: AudioTranscribeFn = vi.fn(async () => ({
      text: "Meeting moved to Thursday at noon",
    }));
    const extract = createAttachmentExtractor({ transcribe });
    const result = await extract(enc("OGGBYTES"), "audio/ogg");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Meeting moved to Thursday at noon");
    expect(result!.extra?.transcribed).toBe(true);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  test("handles an audio MIME type with parameters", async () => {
    const transcribe: AudioTranscribeFn = vi.fn(async () => ({ text: "hi" }));
    const extract = createAttachmentExtractor({ transcribe });
    expect(await extract(enc("a"), "audio/mp4; codecs=mp4a")).not.toBeNull();
  });

  test("returns null when STT finds no speech in the audio", async () => {
    const transcribe: AudioTranscribeFn = async () => ({ text: "   " });
    const extract = createAttachmentExtractor({ transcribe });
    expect(await extract(enc("silence"), "audio/wav")).toBeNull();
  });

  test("returns null when STT is unavailable for the audio", async () => {
    const transcribe: AudioTranscribeFn = async () => null;
    const extract = createAttachmentExtractor({ transcribe });
    expect(await extract(enc("clip"), "audio/mpeg")).toBeNull();
  });

  test("does not transcribe audio when no transcribe fn is wired", async () => {
    const extract = createAttachmentExtractor();
    expect(await extract(enc("clip"), "audio/ogg")).toBeNull();
  });

  test("a transient STT failure still rejects so the source cursor can retry", async () => {
    const transcribe: AudioTranscribeFn = vi.fn(async () => {
      throw new SyncError("transient", "transcriber unavailable");
    });
    const extract = createAttachmentExtractor({ transcribe });
    await expect(extract(enc("clip"), "audio/ogg")).rejects.toThrow(/transcriber unavailable/);
  });

  test("an audio fn does not interfere with text extraction", async () => {
    const transcribe: AudioTranscribeFn = vi.fn(async () => ({ text: "spoken" }));
    const extract = createAttachmentExtractor({ transcribe });
    const result = await extract(enc("plain text body"), "text/plain");
    expect(result!.text).toContain("plain text body");
    expect(transcribe).not.toHaveBeenCalled();
  });
});
