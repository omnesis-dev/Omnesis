// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { observeLiveProvider } from "./model-health.js";
import { callError, RealtimeAdmissionError } from "./call-error.js";
import type { LiveProvider, LiveProviderCallbacks } from "./live-provider.js";

function fixture() {
  let callbacks!: LiveProviderCallbacks;
  const result = {
    id: "fixture",
    sdp: "v=0",
    send: vi.fn(),
    close: vi.fn(async () => ({ usageConfirmed: true, seconds: 2 })),
  };
  const provider: LiveProvider = {
    create: vi.fn(async (_input, hooks) => {
      callbacks = hooks;
      return result;
    }),
  };
  const success = vi.fn();
  const failure = vi.fn();
  let authorized = true;
  const observed = observeLiveProvider(
    provider,
    () => ({ success, failure }),
    () => authorized,
  );
  return {
    observed,
    provider,
    success,
    failure,
    result,
    callbacks: () => callbacks,
    revoke: () => {
      authorized = false;
    },
  };
}
const hooks: LiveProviderCallbacks = { onEvent: vi.fn(), onFailure: vi.fn() };

describe("Live voice model health", () => {
  it("records provider admission failures without changing the thrown error", async () => {
    const f = fixture();
    const error = new RealtimeAdmissionError(callError("quota_exhausted"));
    vi.mocked(f.provider.create).mockRejectedValue(error);
    await expect(f.observed.create({ sdp: "v=0", instructions: "" }, hooks)).rejects.toBe(error);
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.success).not.toHaveBeenCalled();
  });

  it("counts a failure after admission once and keeps it through cleanup", async () => {
    const f = fixture();
    const session = await f.observed.create({ sdp: "v=0", instructions: "" }, hooks);
    f.callbacks().onEvent({ type: "session.output_transcript.delta", delta: "Hello" });
    f.callbacks().onFailure(callError("quota_exhausted"));
    f.callbacks().onFailure(callError("connection_error"));
    await session.close();
    expect(f.failure).toHaveBeenCalledOnce();
    expect(f.success).not.toHaveBeenCalled();
  });

  it("clears health after a session serves output and closes successfully", async () => {
    const f = fixture();
    const session = await f.observed.create({ sdp: "v=0", instructions: "" }, hooks);
    expect(f.success).not.toHaveBeenCalled();
    f.callbacks().onEvent({ type: "session.output_transcript.delta", delta: "Hello" });
    await session.close();
    await session.close();
    expect(f.success).toHaveBeenCalledOnce();
    expect(f.result.close).toHaveBeenCalledOnce();
  });

  it("keeps output as recovery evidence when a normal hangup aborts setup", async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.observed.create(
      { sdp: "v=0", instructions: "", signal: controller.signal },
      hooks,
    );
    f.callbacks().onEvent({ type: "session.output_transcript.delta", delta: "Hello" });
    controller.abort();
    await session.close();
    expect(f.success).toHaveBeenCalledOnce();
    expect(f.failure).not.toHaveBeenCalled();
  });

  it("does not turn cancellation, revoked authority, or an unused session into evidence", async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.observed.create(
      { sdp: "v=0", instructions: "", signal: controller.signal },
      hooks,
    );
    controller.abort();
    f.callbacks().onFailure(callError("timeout"));
    await session.close();
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.success).not.toHaveBeenCalled();
    const g = fixture();
    await g.observed.create({ sdp: "v=0", instructions: "" }, hooks);
    g.revoke();
    g.callbacks().onFailure(callError("connection_error"));
    expect(g.failure).not.toHaveBeenCalled();
  });
});
