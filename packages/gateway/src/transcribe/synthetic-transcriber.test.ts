// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SyntheticTranscriber } from "./synthetic-transcriber.js";

describe("SyntheticTranscriber", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("decodes audio bytes as UTF-8 text", async () => {
    const t = new SyntheticTranscriber();
    const result = await t.transcribe(enc("hello from the voice note"), "audio/ogg");
    expect(result.text).toBe("hello from the voice note");
    expect(result.language).toBe("en");
  });

  test("trims surrounding whitespace", async () => {
    const t = new SyntheticTranscriber();
    const result = await t.transcribe(enc("  spaced out  \n"), "audio/ogg");
    expect(result.text).toBe("spaced out");
  });

  test("echoes the language hint when provided", async () => {
    const t = new SyntheticTranscriber();
    expect((await t.transcribe(enc("bonjour"), "audio/ogg", { language: "fr" })).language).toBe(
      "fr",
    );
    expect((await t.transcribe(enc("hello"), "audio/ogg")).language).toBe("en");
  });

  test("empty bytes → empty transcript", async () => {
    const t = new SyntheticTranscriber();
    const result = await t.transcribe(new Uint8Array(0), "audio/ogg");
    expect(result.text).toBe("");
  });

  test("dispose is a no-op", async () => {
    const t = new SyntheticTranscriber();
    await expect(t.dispose()).resolves.toBeUndefined();
  });
});
