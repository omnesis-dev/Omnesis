// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { DIRECT_HEURISTIC_SESSION_GAP_MS, directSessionKeys } from "./direct-session.js";

describe("directSessionKeys", () => {
  it("prefers an explicit conversation key over the heuristic fallback", () => {
    const keys = directSessionKeys({
      principalId: "principal_1",
      credentialId: "credential_1",
      conversationId: "conv_fictional",
    });
    expect(keys.explicitKey).toBe("conversation:conv_fictional");
    expect(keys.heuristicKey).toBe("principal_1|credential_1");
  });

  it("uses the workflow key when no conversation key is supplied", () => {
    const keys = directSessionKeys({
      principalId: "principal_1",
      credentialId: "credential_1",
      workflowId: "wf_fictional",
    });
    expect(keys.explicitKey).toBe("workflow:wf_fictional");
  });

  it("prefers conversation over workflow when both are supplied", () => {
    const keys = directSessionKeys({
      principalId: "principal_1",
      credentialId: "credential_1",
      conversationId: "conv_fictional",
      workflowId: "wf_fictional",
    });
    expect(keys.explicitKey).toBe("conversation:conv_fictional");
  });

  it("falls back to heuristic keys without caller grouping", () => {
    const keys = directSessionKeys({ principalId: "principal_1", credentialId: "credential_1" });
    expect(keys.explicitKey).toBeNull();
    expect(keys.heuristicKey).toBe("principal_1|credential_1");
  });

  it("isolates heuristic keys by credential as well as principal", () => {
    const first = directSessionKeys({ principalId: "principal_1", credentialId: "credential_1" });
    const second = directSessionKeys({ principalId: "principal_1", credentialId: "credential_2" });
    expect(first.heuristicKey).not.toBe(second.heuristicKey);
  });

  it.each(["", "   ", "has spaces", "way/too/long/" + "x".repeat(200), "semi;colon"])(
    "rejects malformed grouping key %j and falls back to heuristic",
    (bad) => {
      const keys = directSessionKeys({
        principalId: "principal_1",
        credentialId: "credential_1",
        conversationId: bad,
      });
      expect(keys.explicitKey).toBeNull();
      expect(keys.heuristicKey).toBe("principal_1|credential_1");
    },
  );

  it("exposes a one-hour idle gap for the lookup-time split", () => {
    expect(DIRECT_HEURISTIC_SESSION_GAP_MS).toBe(3_600_000);
  });
});
