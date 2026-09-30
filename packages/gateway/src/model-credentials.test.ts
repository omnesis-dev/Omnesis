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
  resolveTypeSafeApiKey,
  hasTypeSafeApiKey,
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

describe("TypeSafe credentials", () => {
  // TypeSafe serves only the experimental decision role, so it is listed only
  // while experimental mode is visible; pin the mode instead of inheriting it.
  beforeEach(() => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    vi.stubEnv("OMNESIS_SYNTHETIC", "0");
  });

  test("is hidden while experimental mode is off", () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect(listModelCredentialEntries(dir).some((e) => e.fileKey === "typesafe")).toBe(false);
  });

  test("lists TypeSafe beside Anthropic", () => {
    const entry = listModelCredentialEntries(dir).find((e) => e.fileKey === "typesafe");
    expect(entry).toMatchObject({
      providerName: "TypeSafe",
      configured: false,
      environment: false,
    });
    expect(getModelProviderSpec("typesafe")?.fileKey).toBe("typesafe");
  });

  test("reports a key supplied by the environment separately from the file", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_env_0123456789abcdef");
    const entry = listModelCredentialEntries(dir).find((e) => e.fileKey === "typesafe");
    expect(entry).toMatchObject({ configured: false, environment: true });
  });

  test("resolves the Omnesis env var, then the standard one, then the file", () => {
    expect(resolveTypeSafeApiKey(dir)).toBeNull();
    expect(hasTypeSafeApiKey(dir)).toBe(false);
    writeFileSync(
      join(dir, "typesafe-credentials.json"),
      JSON.stringify({ apiKey: " apikey_file_0123456789 " }),
    );
    expect(resolveTypeSafeApiKey(dir)).toBe("apikey_file_0123456789");
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_std_0123456789");
    expect(resolveTypeSafeApiKey(dir)).toBe("apikey_std_0123456789");
    vi.stubEnv("OMNESIS_TYPESAFE_API_KEY", "apikey_omnesis_0123456789");
    expect(resolveTypeSafeApiKey(dir)).toBe("apikey_omnesis_0123456789");
    expect(hasTypeSafeApiKey(dir)).toBe(true);
  });
});
