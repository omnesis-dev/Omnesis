// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { inferenceAssignmentPatch, isLoopbackInferenceUrl, remoteAssignmentConsent } from "./cloud-inference.js";

const overview = { inference: { allowRemoteInference: false, backends: {
  local: { url: "http://127.0.0.1:8000" }, remote: { url: "https://api.example.com" },
} } };

describe("cloud inference permission", () => {
  it("requires consent for Codex, Anthropic, and remote HTTP selections", () => {
    expect(remoteAssignmentConsent(overview, "codex", "example-model")).toEqual({ modelName: "example-model", providerLabel: "OpenAI" });
    expect(remoteAssignmentConsent(overview, "anthropic", "example-model").providerLabel).toBe("Anthropic");
    expect(remoteAssignmentConsent(overview, "remote", "example-model").providerLabel).toBe("https://api.example.com");
    expect(remoteAssignmentConsent(overview, "missing", "example-model")).not.toBeNull();
  });

  it("does not request consent for loopback inference or an already allowed remote backend", () => {
    expect(remoteAssignmentConsent(overview, "local", "example-model")).toBeNull();
    expect(remoteAssignmentConsent({ inference: { ...overview.inference, allowRemoteInference: true } }, "codex", "example-model")).toBeNull();
    for (const url of ["http://localhost", "http://server.localhost", "http://127.12.0.1", "http://[::1]"]) expect(isLoopbackInferenceUrl(url)).toBe(true);
    for (const url of ["https://api.example.com", "not a URL", "http://127.example.com"]) expect(isLoopbackInferenceUrl(url)).toBe(false);
  });

  it("saves consent and the requested assignment in one patch", () => {
    expect(inferenceAssignmentPatch("agent", "codex/example-model", true)).toEqual({ inference: { allowRemoteInference: true, assignments: { agent: "codex/example-model" } } });
    expect(inferenceAssignmentPatch("agent", "local/example-model")).toEqual({ inference: { assignments: { agent: "local/example-model" } } });
  });
});
