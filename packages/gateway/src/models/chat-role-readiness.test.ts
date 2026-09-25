// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { chatRoleReadiness } from "./chat-role-readiness.js";
import type { ChatRoleReadinessDeps } from "./chat-role-readiness.js";
import type {
  CapabilityRole,
  ResolvedAnthropic,
  ResolvedAssignment,
  ResolvedCodex,
  ResolvedHttp,
} from "@omnesis/core";

const ROLE: CapabilityRole = "background-agent";

const READY: ChatRoleReadinessDeps = {
  hasReplayFixture: (fixture) => (fixture ?? "").length > 0,
};

// Typed to the concrete union members rather than `Partial<ResolvedAssignment>`
// — a partial of a discriminated union distributes, so it would accept fields
// from any variant and a cast would then hide a fixture the registry can no
// longer produce.
const anthropic = (over: Partial<ResolvedAnthropic> = {}): ResolvedAnthropic => ({
  role: ROLE,
  kind: "anthropic",
  catalogId: "anthropic/some-model",
  apiModelId: "some-model",
  allowRemoteInference: true,
  available: true,
  ...over,
});

const http = (over: Partial<ResolvedHttp> = {}): ResolvedHttp => ({
  role: ROLE,
  kind: "http",
  backendKey: "local-server",
  url: "http://localhost:9999",
  model: "some-chat-model",
  allowRemoteInference: false,
  available: true,
  ...over,
});

const codex = (over: Partial<ResolvedCodex> = {}): ResolvedCodex => ({
  role: ROLE,
  kind: "codex",
  model: "some-model",
  allowRemoteInference: true,
  available: true,
  ...over,
});

describe("chatRoleReadiness", () => {
  it("accepts each backend kind that can build a chat backend", () => {
    expect(chatRoleReadiness(anthropic(), READY).runnable).toBe(true);
    expect(chatRoleReadiness(http(), READY).runnable).toBe(true);
    expect(chatRoleReadiness(codex(), READY).runnable).toBe(true);
    expect(
      chatRoleReadiness({ role: ROLE, kind: "replay", fixture: "f.jsonl" }, READY).runnable,
    ).toBe(true);
  });

  it("carries no reason while runnable", () => {
    expect(chatRoleReadiness(anthropic(), READY).reason).toBeUndefined();
  });

  describe("a well-formed assignment that still cannot run", () => {
    // Each case is a shape the old kind-only check called ready, over a
    // backend `resolveRoleBackend` builds as null.
    it("anthropic whose key the registry could not resolve", () => {
      const v = chatRoleReadiness(
        anthropic({ available: false, reason: "Anthropic API key not configured." }),
        READY,
      );
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/Anthropic API key/i);
    });

    it("anthropic with egress disabled", () => {
      const v = chatRoleReadiness(anthropic({ allowRemoteInference: false }), READY);
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/allowRemoteInference/);
    });

    it("codex with egress disabled", () => {
      const v = chatRoleReadiness(codex({ allowRemoteInference: false }), READY);
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/allowRemoteInference/);
    });

    it("codex with no model id", () => {
      // Without this the resolver would build a backend whose every turn goes
      // to an empty model.
      const v = chatRoleReadiness(
        codex({ model: "", available: false, reason: "Codex assignment must include a model id" }),
        READY,
      );
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/model id/i);
    });

    it("codex assigned to a role it cannot serve", () => {
      // An unsupported modality remains unavailable even with a valid model id.
      const v = chatRoleReadiness(
        codex({
          available: false,
          reason: "Codex does not provide embedding vectors",
        }),
        READY,
      );
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/embedding vectors/i);
    });

    it("http whose endpoint is unavailable, surfacing the resolver's reason", () => {
      const v = chatRoleReadiness(
        http({ available: false, reason: 'Backend "local-server" is unreachable: ECONNREFUSED' }),
        READY,
      );
      expect(v.runnable).toBe(false);
      expect(v.reason).toBe('Backend "local-server" is unreachable: ECONNREFUSED');
    });

    it("http unavailable with no reason still explains itself", () => {
      const v = chatRoleReadiness(http({ available: false }), READY);
      expect(v.runnable).toBe(false);
      expect(v.reason).toContain("http://localhost:9999");
    });

    it("replay with no fixture to replay", () => {
      const v = chatRoleReadiness({ role: ROLE, kind: "replay" }, READY);
      expect(v.runnable).toBe(false);
      expect(v.reason).toMatch(/fixture/i);
    });
  });

  it("rejects the kinds that never build a chat backend", () => {
    const local = chatRoleReadiness(
      { role: ROLE, kind: "local", catalogId: "m", modelPath: "/m.gguf", available: true },
      READY,
    );
    expect(local.runnable).toBe(false);
    expect(local.reason).toMatch(/Local GGUF/i);

    const disabled = chatRoleReadiness({ role: ROLE, kind: "disabled" }, READY);
    expect(disabled.runnable).toBe(false);
    expect(disabled.reason).toMatch(/No model is assigned/i);

    const unresolved = chatRoleReadiness(
      { role: ROLE, kind: "unresolved", reason: 'Unknown backend "typo"' },
      READY,
    );
    expect(unresolved.runnable).toBe(false);
    expect(unresolved.reason).toBe('Unknown backend "typo"');
  });

  it("treats a backend kind it does not know as not runnable", () => {
    // `kind` derives from operator-edited config, so an unknown value must
    // read as unusable rather than throw out of a status poll.
    const v = chatRoleReadiness(
      { role: ROLE, kind: "future-backend" } as unknown as ResolvedAssignment,
      READY,
    );
    expect(v.runnable).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it("always explains a negative verdict", () => {
    // A surface that knows only "not ready" cannot tell the operator anything.
    const negatives: ResolvedAssignment[] = [
      { role: ROLE, kind: "disabled" },
      { role: ROLE, kind: "replay" },
      anthropic({ allowRemoteInference: false }),
      http({ available: false }),
      codex({ allowRemoteInference: false }),
    ];
    for (const resolved of negatives) {
      const v = chatRoleReadiness(resolved, READY);
      expect(v.runnable, resolved.kind).toBe(false);
      expect(v.reason, resolved.kind).toBeTruthy();
    }
  });
});
