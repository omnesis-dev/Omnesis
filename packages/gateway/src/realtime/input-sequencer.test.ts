// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeInputSequencer } from "./input-sequencer.js";
afterEach(() => vi.useRealTimers());
describe("committed voice input order", () => {
  it("delivers reversed ASR completions in committed order without duplicate turns", () => {
    const deliver = vi.fn();
    const sequence = new RealtimeInputSequencer(deliver, vi.fn());
    sequence.commit("first");
    sequence.commit("second");
    sequence.transcribe("second", "Second spoken question");
    expect(deliver).not.toHaveBeenCalled();
    sequence.transcribe("first", "First spoken question");
    sequence.commit("first");
    sequence.transcribe("second", "Duplicate");
    expect(deliver.mock.calls).toEqual([
      ["First spoken question", "first"],
      ["Second spoken question", "second"],
    ]);
    sequence.dispose();
  });
  it("accepts ASR before commit, skips empty audio and times out missing transcription", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const fail = vi.fn();
    const sequence = new RealtimeInputSequencer(deliver, fail);
    sequence.transcribe("early", "Question");
    expect(deliver).not.toHaveBeenCalled();
    sequence.commit("early");
    sequence.commit("silent");
    sequence.transcribe("silent", "");
    sequence.commit("missing");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliver.mock.calls).toEqual([["Question", "early"]]);
    expect(fail).toHaveBeenCalledTimes(1);
    sequence.dispose();
  });
  it("bounds pending inputs and clears timers on call close", async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const sequence = new RealtimeInputSequencer(vi.fn(), fail);
    for (let i = 0; i < 4; i++) sequence.commit(`speech-${i}`);
    expect(() => sequence.commit("overflow")).toThrow("limit");
    sequence.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).not.toHaveBeenCalled();
  });
});
