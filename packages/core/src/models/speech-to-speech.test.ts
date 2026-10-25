// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { speechToSpeechAssignment, SPEECH_TO_SPEECH_MODEL } from "./speech-to-speech.js";

describe("explicit speech assignment policy", () => {
  const backends = { cloud: { type: "http" as const, url: "https://api.openai.com/v1" } };
  it("requires an explicit supported model and accepts arbitrary backend names", () => {
    expect(speechToSpeechAssignment(`cloud/${SPEECH_TO_SPEECH_MODEL}`, backends)).toEqual({
      backendKey: "cloud",
      model: "gpt-live-1",
    });
    for (const value of [
      undefined,
      null,
      "cloud",
      "cloud/gpt-4.1",
      "cloud/gpt-realtime-2.1",
      "missing/gpt-live-1",
      "replay",
    ])
      expect(speechToSpeechAssignment(value, backends)).toBeUndefined();
  });
  it.each([
    "http://api.openai.com",
    "https://api.openai.com.example.org",
    "https://example.org",
    "https://api.openai.com:8443",
    "not-a-url",
  ])("rejects unsupported service origin %s", (url) => {
    expect(
      speechToSpeechAssignment("cloud/gpt-live-1", { cloud: { type: "http", url } }),
    ).toBeUndefined();
  });
  it("rejects credentials embedded in an otherwise supported service URL", () => {
    const url = new URL("https://api.openai.com");
    url.username = "fixture-user";
    url.password = "fixture-password";
    expect(
      speechToSpeechAssignment("cloud/gpt-live-1", { cloud: { type: "http", url: url.href } }),
    ).toBeUndefined();
  });
});
