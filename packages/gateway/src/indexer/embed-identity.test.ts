// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { canonicalEmbedIdentity } from "./embed-identity.js";
import { EMBEDDING_DIM } from "./db.js";
import type { ResolvedAssignment } from "@omnesis/core";

describe("canonicalEmbedIdentity", () => {
  test("local: prefers the catalog filename and its embedDim", () => {
    const resolved = {
      kind: "local",
      catalogId: "nomic-embed-text-v1.5",
      catalogEntry: { filename: "nomic-embed-text-v1.5.Q8_0.gguf" },
      modelPath: "/models/nomic-embed-text-v1.5.Q8_0.gguf",
      embedDim: 768,
      available: true,
    } as unknown as ResolvedAssignment;

    expect(canonicalEmbedIdentity(resolved)).toEqual({
      name: "nomic-embed-text-v1.5.Q8_0.gguf",
      dim: 768,
    });
  });

  test("local: falls back to the catalog id and default dim when unknown", () => {
    const resolved = {
      kind: "local",
      catalogId: "some-unknown-gguf",
      modelPath: "/models/some-unknown-gguf.gguf",
      available: true,
    } as unknown as ResolvedAssignment;

    expect(canonicalEmbedIdentity(resolved)).toEqual({
      name: "some-unknown-gguf",
      dim: EMBEDDING_DIM,
    });
  });

  test("http: uses the PROBE served model and native dim, never a backend-prefixed composite", () => {
    // resolved.model is empty (auto-discovery); the served id comes from the
    // probe. The boot path stamps exactly this, so the swap path must agree.
    const resolved = {
      kind: "http",
      backendKey: "my-vllm-box",
      url: "http://localhost:8001/v1",
      model: "",
      available: true,
    } as unknown as ResolvedAssignment;

    const id = canonicalEmbedIdentity(resolved, {
      httpServedModel: "text-embedding-demo-small",
      httpNativeDim: 1024,
    });
    expect(id).toEqual({ name: "text-embedding-demo-small", dim: 1024 });
    // The backend key never leaks into the identity — that divergence (a
    // `<backend>/<model>` stamp vs a bare served id) is exactly #698 B1.
    expect(id.name).not.toContain("my-vllm-box");
    expect(id.name).not.toContain("/");
  });

  test("http: the swap path and the boot path produce the IDENTICAL identity (the #698 B1/B2 guarantee)", () => {
    const resolved = {
      kind: "http",
      backendKey: "cloud-embed",
      url: "https://embed.example.com/v1",
      model: "",
      available: true,
    } as unknown as ResolvedAssignment;

    // Both call sites feed the same probe result, so the result is identical.
    const probe = { httpServedModel: "demo-embed-v2", httpNativeDim: 384 };
    const fromBootPath = canonicalEmbedIdentity(resolved, probe);
    const fromSwapPath = canonicalEmbedIdentity(resolved, probe);
    expect(fromSwapPath).toEqual(fromBootPath);
  });

  test("http: an explicitly configured model id is used when no probe override is given", () => {
    const resolved = {
      kind: "http",
      backendKey: "cloud-embed",
      url: "https://embed.example.com/v1",
      model: "demo-embed-configured",
      available: true,
    } as unknown as ResolvedAssignment;

    expect(canonicalEmbedIdentity(resolved, { httpNativeDim: 512 })).toEqual({
      name: "demo-embed-configured",
      dim: 512,
    });
  });

  test("http: throws when no served model can be determined", () => {
    const resolved = {
      kind: "http",
      backendKey: "cloud-embed",
      url: "https://embed.example.com/v1",
      model: "",
      available: true,
    } as unknown as ResolvedAssignment;

    expect(() => canonicalEmbedIdentity(resolved, { httpNativeDim: 512 })).toThrow(/served model/i);
  });

  test("http: throws when the native dim is missing", () => {
    const resolved = {
      kind: "http",
      backendKey: "cloud-embed",
      url: "https://embed.example.com/v1",
      model: "demo-embed",
      available: true,
    } as unknown as ResolvedAssignment;

    expect(() => canonicalEmbedIdentity(resolved, {})).toThrow(/httpNativeDim/);
  });

  test("rejects unsupported embedder kinds", () => {
    expect(() =>
      canonicalEmbedIdentity({ kind: "disabled" } as unknown as ResolvedAssignment),
    ).toThrow(/unsupported embedder kind/i);
  });
});
