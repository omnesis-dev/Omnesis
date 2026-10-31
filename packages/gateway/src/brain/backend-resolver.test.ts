// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import type { CapabilityRole, ResolvedAssignment } from "@omnesis/core";
import { loadBrainCompletionProvider } from "./backend-resolver.js";

const readiness = { hasReplayFixture: () => false };
const assigned: ResolvedAssignment = {
  role: "background-agent",
  kind: "http",
  backendKey: "scripted",
  url: "http://127.0.0.1:1",
  model: "fictional-brain-model",
  available: true,
  allowRemoteInference: false,
};
afterEach(() => vi.unstubAllEnvs());

test("a retained Brain assignment buys no automatic completion in stable or synthetic mode", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_SYNTHETIC", "1");
  const getBackendApiKey = vi.fn();
  expect(
    loadBrainCompletionProvider({ resolve: () => assigned }, readiness, {
      configDir: ".",
      getBackendApiKey,
    }),
  ).toBeNull();
  expect(getBackendApiKey).not.toHaveBeenCalled();
});

test("live Brain activation, model removal and reactivation govern optional completions", () => {
  let current: ResolvedAssignment = assigned;
  const registry = { resolve: vi.fn((_role: CapabilityRole) => current) };
  const deps = { configDir: ".", getBackendApiKey: vi.fn() };
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const first = loadBrainCompletionProvider(registry, readiness, deps);
  expect(first).not.toBeNull();
  first?.dispose();
  current = { role: "background-agent", kind: "disabled" };
  expect(loadBrainCompletionProvider(registry, readiness, deps)).toBeNull();
  current = assigned;
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  expect(loadBrainCompletionProvider(registry, readiness, deps)).toBeNull();
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const second = loadBrainCompletionProvider(registry, readiness, deps);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  second?.dispose();
  expect(registry.resolve.mock.calls.every(([role]) => role === "background-agent")).toBe(true);
});

test("unrunnable Brain models cannot fall back to the owner Agent", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const registry = {
    resolve: vi.fn((): ResolvedAssignment => ({ ...assigned, available: false })),
  };
  expect(loadBrainCompletionProvider(registry, readiness, { configDir: "." })).toBeNull();
  expect(registry.resolve).toHaveBeenCalledWith("background-agent");
});
