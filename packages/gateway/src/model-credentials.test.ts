// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listModelCredentialEntries,
  getModelProviderSpec,
  readAnthropicApiKey,
  resolveAnthropicCredential,
  resolveAnthropicApiKey,
  hasAnthropicApiKey,
} from "./model-credentials.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mc-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("listModelCredentialEntries", () => {
  test("includes Anthropic with configured=false when no file present", () => {
    const entries = listModelCredentialEntries(dir);
    expect(entries.length).toBeGreaterThan(0);
    const anthropic = entries.find((e) => e.fileKey === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.configured).toBe(false);
    expect(anthropic?.providerName).toBe("Anthropic");
    // Spec is serialized (no functions); should expose at least apiKey field.
    expect(anthropic?.spec.fields.find((f) => f.name === "apiKey")?.secret).toBe(true);
  });

  test("flips Anthropic to configured=true once the file lands", () => {
    writeFileSync(join(dir, "anthropic-credentials.json"), JSON.stringify({ apiKey: "sk-ant-x" }));
    const entry = listModelCredentialEntries(dir).find((e) => e.fileKey === "anthropic");
    expect(entry?.configured).toBe(true);
  });
});

describe("getModelProviderSpec", () => {
  test("returns the spec for known fileKeys", () => {
    expect(getModelProviderSpec("anthropic")?.fileKey).toBe("anthropic");
  });
  test("returns null for unknown fileKeys", () => {
    expect(getModelProviderSpec("openai")).toBeNull();
  });
});

describe("readAnthropicApiKey / hasAnthropicApiKey", () => {
  test("returns null when the file is absent", () => {
    expect(readAnthropicApiKey(dir)).toBeNull();
    expect(hasAnthropicApiKey(dir)).toBe(false);
  });

  test("returns the apiKey field when present", () => {
    writeFileSync(
      join(dir, "anthropic-credentials.json"),
      JSON.stringify({ apiKey: "sk-ant-abc" }),
    );
    expect(readAnthropicApiKey(dir)).toBe("sk-ant-abc");
    expect(hasAnthropicApiKey(dir)).toBe(true);
  });

  test("returns null on malformed JSON rather than throwing", () => {
    writeFileSync(join(dir, "anthropic-credentials.json"), "{ not json");
    expect(readAnthropicApiKey(dir)).toBeNull();
    expect(hasAnthropicApiKey(dir)).toBe(false);
  });

  test("returns null on missing apiKey field", () => {
    writeFileSync(join(dir, "anthropic-credentials.json"), JSON.stringify({ other: "x" }));
    expect(readAnthropicApiKey(dir)).toBeNull();
    expect(hasAnthropicApiKey(dir)).toBe(false);
  });

  test("returns null on empty-string apiKey", () => {
    writeFileSync(join(dir, "anthropic-credentials.json"), JSON.stringify({ apiKey: "" }));
    expect(readAnthropicApiKey(dir)).toBeNull();
  });

  test("resolves environment keys before the credentials file", () => {
    writeFileSync(join(dir, "anthropic-credentials.json"), JSON.stringify({ apiKey: "file-key" }));
    vi.stubEnv("ANTHROPIC_API_KEY", "standard-env-key");
    vi.stubEnv("OMNESIS_ANTHROPIC_API_KEY", "omnesis-env-key");

    expect(resolveAnthropicApiKey(dir)).toBe("omnesis-env-key");
    expect(resolveAnthropicCredential(dir)?.source).toBe("environment");
    expect(hasAnthropicApiKey(dir)).toBe(true);
  });
});
