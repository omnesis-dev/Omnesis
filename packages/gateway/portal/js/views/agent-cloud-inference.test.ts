// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { cloudInferenceRecovery, enableCloudInferenceForAgent } from "./agent-cloud-inference.js";
import { reducer, initialState } from "./agent-reducer.js";

const user = { id: "user-1", role: "user", parts: [{ kind: "text", text: "Summarize my notes" }] };
const blocked = { id: "assistant-1", role: "assistant", failure: { code: "remote_inference_disabled" } };

describe("cloud inference recovery", () => {
  it("offers recovery before sending when config reports a permission block", () => {
    expect(cloudInferenceRecovery({ turns: [], agentConfig: { disabledCode: "remote_inference_disabled" } })).toEqual({ key: "configuration", message: null });
  });
  it("offers the latest blocked message for explicit retry, preserving research mode", () => {
    expect(cloudInferenceRecovery({ turns: [{ ...user, deepResearch: true }, blocked], deepResearch: false })).toEqual({ key: "assistant-1", message: "Summarize my notes", deepResearch: true });
  });
  it.each([false, true])("retains failed research options after stamping with eventFirst=%s", (eventFirst) => {
    let state = { ...initialState(), sessionId: "session-1" };
    state = reducer(state, { kind: "user-send", text: "Research my notes", optimisticId: "pending-1", deepResearch: true });
    const stamp = { kind: "stamp-user-message", optimisticId: "pending-1", userMessageId: "user-1" };
    const echo = { kind: "agent.user.message", payload: { userMessageId: "user-1", text: "Research my notes" } };
    for (const action of eventFirst ? [echo, stamp] : [stamp, echo]) state = reducer(state, action);
    state = reducer(state, { kind: "agent.error", payload: { sessionId: "session-1", code: "remote_inference_disabled", message: "Cloud inference disabled" } });
    expect(state.deepResearch).toBe(false);
    expect(state.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(cloudInferenceRecovery(state)).toMatchObject({ message: "Research my notes", deepResearch: true });
  });

  it("does not offer retry for an old failure or generic backend failure", () => {
    expect(cloudInferenceRecovery({ turns: [user, blocked, { ...user, id: "user-2" }] })).toBeNull();
    expect(cloudInferenceRecovery({ turns: [user, { ...blocked, failure: { code: "send_failed" } }] })).toBeNull();
  });
  it("waits for readiness after saving consent and never sends a message", async () => {
    const patch = vi.fn().mockResolvedValue({ ok: true });
    const getConfig = vi.fn().mockResolvedValueOnce({ enabled: false, disabledCode: "remote_inference_disabled" }).mockResolvedValueOnce({ enabled: true });
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(enableCloudInferenceForAgent({ patch, getConfig, delay })).resolves.toEqual({ enabled: true });
    expect(patch).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true } });
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  });
  it("reports a rejected write without polling readiness", async () => {
    const getConfig = vi.fn();
    await expect(enableCloudInferenceForAgent({ patch: async () => ({ ok: false, body: { error: "Permission denied" } }), getConfig })).rejects.toThrow("Permission denied");
    expect(getConfig).not.toHaveBeenCalled();
  });
  it("preserves other setup failures after consent is enabled", async () => {
    await expect(enableCloudInferenceForAgent({ patch: async () => ({ ok: true }), getConfig: async () => ({ enabled: false, disabledCode: "credentials_missing", disabledReason: "Sign in first" }), delay: async () => {} })).rejects.toThrow("Sign in first");
  });
  it("bounds readiness polling and leaves consent enabled on timeout", async () => {
    const patch = vi.fn().mockResolvedValue({ ok: true });
    const getConfig = vi.fn().mockResolvedValue({ enabled: false });
    await expect(enableCloudInferenceForAgent({ patch, getConfig, delay: async () => {} })).rejects.toThrow("not ready yet");
    expect(getConfig).toHaveBeenCalledTimes(30);
    expect(patch).toHaveBeenCalledOnce();
  });
  it("ignores a readiness result when the user has left the recovery surface", async () => {
    let current = true;
    const result = await enableCloudInferenceForAgent({ patch: async () => ({ ok: true }), getConfig: async () => { current = false; return { enabled: true }; }, isCurrent: () => current });
    expect(result).toBeNull();
  });
});
