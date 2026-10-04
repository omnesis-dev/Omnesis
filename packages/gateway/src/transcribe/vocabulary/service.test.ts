// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { omnesisConfigSchema } from "@omnesis/config";
import { resolveVocabularySettings } from "./config.js";
import { TranscriptionVocabularyService } from "./service.js";
import type { TranscriptionVocabulary } from "@omnesis/core";

const vocabulary: TranscriptionVocabulary = { entries: [{ text: "Umbriolet", score: 3 }] };

function fixture(initialConfig: unknown) {
  let config = omnesisConfigSchema.parse(initialConfig);
  const read = vi.fn(() => Promise.resolve(vocabulary));
  const service = new TranscriptionVocabularyService({
    getSettings: () => resolveVocabularySettings(config),
    ioGate: { getTranscriptionVocabulary: read },
  });
  return {
    service,
    read,
    setConfig: (value: unknown) => {
      config = omnesisConfigSchema.parse(value);
    },
  };
}

describe("transcription vocabulary service opt-in", () => {
  test.each([
    {},
    { inference: {} },
    { inference: { transcriptionVocabulary: {} } },
    { inference: { transcriptionVocabulary: { enabled: false } } },
  ])("returns no dictionary and performs no IO without opt-in: %j", async (config) => {
    const { service, read } = fixture(config);
    expect(service.enabled()).toBe(false);
    expect(await service.getDictionary({ purpose: "dictation" })).toEqual({ entries: [] });
    expect(await service.getSnapshot({ purpose: "agent" })).toEqual({
      enabled: false,
      entries: [],
      refreshAfterSeconds: 1800,
      expiresAfterSeconds: 86400,
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("live opt-in reads vocabulary and removing it stops reads again", async () => {
    const { service, read, setConfig } = fixture({});
    setConfig({ inference: { transcriptionVocabulary: { enabled: true } } });
    expect(await service.getDictionary({ purpose: "dictation" })).toEqual(vocabulary);
    expect(read).toHaveBeenCalledTimes(1);
    setConfig({ inference: { transcriptionVocabulary: {} } });
    expect(await service.getDictionary({ purpose: "dictation" })).toEqual({ entries: [] });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("disabling during an awaited read discards its vocabulary", async () => {
    const { service, read, setConfig } = fixture({
      inference: { transcriptionVocabulary: { enabled: true } },
    });
    read.mockImplementation(() => {
      setConfig({ inference: { transcriptionVocabulary: { enabled: false } } });
      return Promise.resolve(vocabulary);
    });
    expect(await service.getDictionary({ purpose: "dictation" })).toEqual({ entries: [] });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("mobile snapshots cap ranked phrases and publish refresh and expiry bounds", async () => {
    const { service, read } = fixture({
      inference: { transcriptionVocabulary: { enabled: true } },
    });
    const entries = Array.from({ length: 128 }, (_, index) => ({
      text: `Vocabulary ${index}`,
      score: 128 - index,
    }));
    read.mockResolvedValue({ entries });
    expect(await service.getSnapshot({ purpose: "agent", speaker: { isSelf: true } })).toEqual({
      enabled: true,
      entries: entries.slice(0, 100),
      refreshAfterSeconds: 1800,
      expiresAfterSeconds: 86400,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("mobile snapshots discard a read when vocabulary is disabled while awaiting it", async () => {
    const { service, read, setConfig } = fixture({
      inference: { transcriptionVocabulary: { enabled: true } },
    });
    read.mockImplementation(() => {
      setConfig({});
      return Promise.resolve(vocabulary);
    });
    expect(await service.getSnapshot({ purpose: "dictation" })).toMatchObject({
      enabled: false,
      entries: [],
    });
  });
});
