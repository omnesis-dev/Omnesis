// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { cloudProviderLabel, endpointConsent, inferenceAssignmentPatch, isLoopbackInferenceUrl, remoteAssignmentConsent } from "./cloud-inference.js";

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

  it("decides by the URLs a backend not saved yet will reach, and names its provider", () => {
    expect(endpointConsent(overview, ["https://api.example.com", "https://api.example.com/run"], { providerLabel: "Edgeworks AI", modelName: "clef" }))
      .toEqual({ modelName: "clef", providerLabel: "Edgeworks AI" });
    expect(endpointConsent(overview, ["", "http://127.0.0.1:11435/v1/systemone"], { providerLabel: "Ollaya" })).toBeNull();
    expect(endpointConsent(overview, ["http://127.0.0.1:8080", "https://decide.example.org/v1"]).providerLabel).toBe("https://decide.example.org/v1");
    expect(endpointConsent({ inference: { ...overview.inference, allowRemoteInference: true } }, ["https://decide.example.org"])).toBeNull();
  });

  it("reads where a backend's decision API runs for the Decision model, and its OpenAI-compatible URL otherwise", () => {
    const withDecision = { inference: { ...overview.inference, backends: {
      ollaya: { decision: { url: "http://127.0.0.1:11435/v1/systemone", onHost: true } },
      lab: { url: "http://127.0.0.1:8000", decision: { url: "https://decide.example.org/v1", onHost: false } },
    } } };
    expect(remoteAssignmentConsent(withDecision, "ollaya", "kev", "decision")).toBeNull();
    expect(remoteAssignmentConsent(withDecision, "lab", "kev", "decision")).toEqual({ modelName: "kev", providerLabel: "https://decide.example.org/v1" });
    expect(remoteAssignmentConsent(withDecision, "lab", "chat-model", "agent")).toBeNull();
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
