// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  CAPABILITY_ROLES,
  siblingRolesForRecentModels,
  type AssignmentValue,
  type CapabilityRole,
  type GgufCatalogEntry,
  type ResolvedAssignment,
} from "@omnesis/core";
import { CAPABILITY_TO_CATALOG } from "./routes.js";
import { REFERENCE_TO_CATALOG_ROLE, computeRecentModels } from "./recent-models.js";

const GGUF_ENTRY: GgufCatalogEntry = {
  kind: "gguf",
  id: "northstar-chat-1b.Q4_K_M",
  name: "Northstar Chat",
  roles: ["agent"],
  author: "Northstar",
  license: "Apache-2.0",
  description: "Fictional chat model for tests.",
  filename: "northstar-chat-1b.Q4_K_M.gguf",
  downloadUrl: "https://example.com/northstar-chat-1b.Q4_K_M.gguf",
  sizeBytes: 1,
};

function resolveValue(
  role: CapabilityRole,
  value: AssignmentValue | undefined,
): ResolvedAssignment {
  if (value === "openai/gpt-4o") {
    return {
      role,
      kind: "http",
      backendKey: "openai",
      url: "https://api.openai.com",
      model: "gpt-4o",
      allowRemoteInference: true,
      available: true,
    };
  }
  if (value === "codex/gpt-5.4") {
    return { role, kind: "codex", model: "gpt-5.4", allowRemoteInference: true, available: true };
  }
  if (value === "local/northstar-chat-1b.Q4_K_M") {
    return {
      role,
      kind: "local",
      catalogId: "northstar-chat-1b.Q4_K_M",
      catalogEntry: GGUF_ENTRY,
      modelPath: "/models/northstar-chat-1b.Q4_K_M.gguf",
      available: true,
    };
  }
  if (value === "local/retired-chat.Q4_K_M") {
    return {
      role,
      kind: "local",
      catalogId: "retired-chat.Q4_K_M",
      catalogEntry: { ...GGUF_ENTRY, id: "retired-chat.Q4_K_M", name: "Retired Chat" },
      modelPath: "/models/retired-chat.Q4_K_M.gguf",
      available: false,
    };
  }
  if (value === "anthropic/northstar-agent-1") {
    return {
      role,
      kind: "anthropic",
      catalogId: "northstar-agent-1",
      catalogEntry: {
        kind: "anthropic-api",
        id: "northstar-agent-1",
        name: "Northstar Agent",
        roles: ["agent"],
        author: "Northstar",
        license: "Apache-2.0",
        description: "Fictional agent model for tests.",
        apiModelId: "northstar-agent-1",
      },
      apiModelId: "northstar-agent-1",
      allowRemoteInference: true,
      available: true,
    };
  }
  if (value === "local/northstar-transcribe-1") {
    return {
      role,
      kind: "local",
      catalogId: "northstar-transcribe-1",
      catalogEntry: {
        ...GGUF_ENTRY,
        id: "northstar-transcribe-1",
        name: "Northstar Transcribe",
        roles: ["transcribe"],
      },
      modelPath: "/models/northstar-transcribe-1.gguf",
      available: true,
    };
  }
  if (value === "gone/backend-model") {
    return { role, kind: "unresolved", reason: "Unknown backend" };
  }
  return { role, kind: "disabled" };
}

describe("computeRecentModels", () => {
  test("orders the reference role first and projects displays", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: { "privacy-reviewer": "codex/gpt-5.4" },
      history: { agent: ["openai/gpt-4o"] },
      resolveValue,
    });
    expect(result).toEqual({
      capability: "agent",
      entries: [
        {
          assignment: "openai/gpt-4o",
          providerId: "openai",
          providerLabel: "OpenAI",
          modelName: "gpt-4o",
          apply: { type: "assign", value: "openai/gpt-4o" },
        },
        {
          assignment: "codex/gpt-5.4",
          providerId: "codex",
          providerLabel: "Codex",
          modelName: "gpt-5.4",
          apply: { type: "assign", value: "codex/gpt-5.4" },
        },
      ],
    });
  });

  test("hides the currently assigned model", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: { agent: "openai/gpt-4o", "privacy-reviewer": "codex/gpt-5.4" },
      history: { agent: ["openai/gpt-4o", "local/northstar-chat-1b.Q4_K_M"] },
      resolveValue,
    });
    expect(result.entries.map((e) => e.assignment)).toEqual([
      "local/northstar-chat-1b.Q4_K_M",
      "codex/gpt-5.4",
    ]);
  });

  test("emits an activate apply for catalog models serving the reference role", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: {},
      history: { agent: ["local/northstar-chat-1b.Q4_K_M"] },
      resolveValue,
    });
    expect(result.entries).toEqual([
      {
        assignment: "local/northstar-chat-1b.Q4_K_M",
        providerId: "local",
        providerLabel: "Local",
        modelName: "Northstar Chat",
        apply: { type: "activate", catalogId: "northstar-chat-1b.Q4_K_M", catalogRole: "agent" },
      },
    ]);
  });

  test("drops unresolvable history instead of offering a dead button", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: {},
      history: { agent: ["openai/gpt-4o", "gone/backend-model"] },
      resolveValue,
    });
    expect(result.entries.map((e) => e.assignment)).toEqual(["openai/gpt-4o"]);
  });

  test("skips a catalog model that does not serve the reference role", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: {},
      history: { agent: ["local/northstar-transcribe-1"] },
      resolveValue,
    });
    expect(result.entries).toEqual([]);
  });

  test("skips an activate candidate that is no longer usable", () => {
    // A remembered GGUF whose file is gone would 400 on activate — never
    // offer its "Use" button.
    const result = computeRecentModels({
      reference: "agent",
      current: {},
      history: { agent: ["local/retired-chat.Q4_K_M"] },
      resolveValue,
    });
    expect(result.entries).toEqual([]);
  });

  test("emits an activate apply for Anthropic API models too", () => {
    const result = computeRecentModels({
      reference: "agent",
      current: {},
      history: { agent: ["anthropic/northstar-agent-1"] },
      resolveValue,
    });
    expect(result.entries).toEqual([
      {
        assignment: "anthropic/northstar-agent-1",
        providerId: "anthropic",
        providerLabel: "Anthropic",
        modelName: "Northstar Agent",
        apply: { type: "activate", catalogId: "northstar-agent-1", catalogRole: "agent" },
      },
    ]);
  });

  test("falls back to assign for roles without a catalog mapping", () => {
    // OCR's native runtimes have no catalog role — a raw assignment is the
    // only path that works, since activate rejects capability=ocr.
    const ocrLocal = (
      role: CapabilityRole,
      _value: AssignmentValue | undefined,
    ): ResolvedAssignment => ({
      role,
      kind: "local",
      catalogId: "northstar-ocr-1",
      catalogEntry: undefined,
      modelPath: "/models/northstar-ocr-1.gguf",
      available: true,
    });
    const result = computeRecentModels({
      reference: "ocr",
      current: {},
      history: { ocr: ["local/northstar-ocr-1"] },
      resolveValue: ocrLocal,
    });
    expect(result.entries).toEqual([
      {
        assignment: "local/northstar-ocr-1",
        providerId: "local",
        providerLabel: "Local",
        modelName: "northstar-ocr-1",
        apply: { type: "assign", value: "local/northstar-ocr-1" },
      },
    ]);
  });

  test("reference catalog roles agree with the activate endpoint's map", () => {
    // REFERENCE_TO_CATALOG_ROLE, CAPABILITY_TO_CATALOG (routes.ts), and the
    // sibling groups (core) are three hand-synced maps: every reference with
    // a non-empty group and a catalog mapping must agree with the endpoint
    // that serves the activate apply, or entries would 400.
    for (const role of CAPABILITY_ROLES) {
      if (siblingRolesForRecentModels(role).length === 0) continue;
      const catalogRole = REFERENCE_TO_CATALOG_ROLE[role];
      if (catalogRole === undefined) continue;
      expect(CAPABILITY_TO_CATALOG[role]).toBe(catalogRole);
    }
  });

  test("returns no entries for the entailment verifier", () => {
    const result = computeRecentModels({
      reference: "entailment-verifier",
      current: { "entailment-verifier": "openai/gpt-4o" },
      history: {},
      resolveValue,
    });
    expect(result.entries).toEqual([]);
  });
});
