// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { cloudProviderLabel, inferenceAssignmentPatch, isLoopbackInferenceUrl, remoteAssignmentConsent } from "./cloud-inference.js";

const overview = { inference: { allowRemoteInference: false, backends: {
  local: { url: "http://127.0.0.1:8000" }, remote: { url: "https://api.example.com" },
} } };

describe("cloud inference permission", () => {
  it("requires consent for Codex, Claude Code, Anthropic, and remote HTTP selections", () => {
    expect(remoteAssignmentConsent(overview, "codex", "example-model")).toEqual({ modelName: "example-model", providerLabel: "OpenAI" });
    expect(remoteAssignmentConsent(overview, "claude-code", "sonnet")).toEqual({ modelName: "sonnet", providerLabel: "Anthropic" });
    expect(remoteAssignmentConsent(overview, "anthropic", "example-model").providerLabel).toBe("Anthropic");
    expect(remoteAssignmentConsent(overview, "typesafe", "example-model")).toEqual({ modelName: "example-model", providerLabel: "TypeSafe" });
    expect(remoteAssignmentConsent(overview, "remote", "example-model").providerLabel).toBe("https://api.example.com");
    expect(remoteAssignmentConsent(overview, "missing", "example-model")).not.toBeNull();
  });

  it("does not request consent for loopback inference or an already allowed remote backend", () => {
    expect(remoteAssignmentConsent(overview, "local", "example-model")).toBeNull();
    expect(remoteAssignmentConsent({ inference: { ...overview.inference, allowRemoteInference: true } }, "codex", "example-model")).toBeNull();
    for (const url of ["http://localhost", "http://server.localhost", "http://127.12.0.1", "http://[::1]"]) expect(isLoopbackInferenceUrl(url)).toBe(true);
    for (const url of ["https://api.example.com", "not a URL", "http://127.example.com"]) expect(isLoopbackInferenceUrl(url)).toBe(false);
  });

  it("decides by a not-yet-saved endpoint's URL and names its provider", () => {
    expect(remoteAssignmentConsent(overview, "cloudflare", "clef", { url: "https://api.example.com/run", providerLabel: "Edgeworks AI" }))
      .toEqual({ modelName: "clef", providerLabel: "Edgeworks AI" });
    expect(remoteAssignmentConsent(overview, "lab", "kev", { url: "http://127.0.0.1:11435/v1/systemone", providerLabel: "Ollaya" })).toBeNull();
    expect(remoteAssignmentConsent(overview, "lab", "kev", { url: "https://decide.example.org/v1" }).providerLabel).toBe("https://decide.example.org/v1");
    expect(remoteAssignmentConsent({ inference: { ...overview.inference, allowRemoteInference: true } }, "lab", "kev", { url: "https://decide.example.org" })).toBeNull();
  });

  it("reads a saved decision backend's URL", () => {
    const withDecision = { inference: { ...overview.inference, decisionBackends: {
      ollaya: { url: "http://127.0.0.1:11435/v1/systemone" }, hosted: { url: "https://decide.example.org/v1" },
    } } };
    expect(remoteAssignmentConsent(withDecision, "ollaya", "kev")).toBeNull();
    expect(remoteAssignmentConsent(withDecision, "hosted", "kev")).toEqual({ modelName: "kev", providerLabel: "https://decide.example.org/v1" });
  });

  it("names the company behind each built-in cloud provider", () => {
    expect(cloudProviderLabel("codex", "Codex")).toBe("OpenAI");
    expect(cloudProviderLabel("claude-code", "Claude Code")).toBe("Anthropic");
    expect(cloudProviderLabel("groq", "Groq")).toBe("Groq");
  });

  it("saves consent and the requested assignment in one patch", () => {
    expect(inferenceAssignmentPatch("agent", "codex/example-model", true)).toEqual({ inference: { allowRemoteInference: true, assignments: { agent: "codex/example-model" } } });
    expect(inferenceAssignmentPatch("agent", "claude-code/opus", true)).toEqual({ inference: { allowRemoteInference: true, assignments: { agent: "claude-code/opus" } } });
    expect(inferenceAssignmentPatch("agent", "local/example-model")).toEqual({ inference: { assignments: { agent: "local/example-model" } } });
  });
});
