// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  CATALOG,
  catalogForRole,
  defaultForRole,
  getCatalogEntry,
  getCatalogEntryByFilename,
} from "./catalog.js";

describe("catalog", () => {
  it("ships a recommended default for the embedder role", () => {
    // The embedder is the one role the registry auto-resolves from the
    // catalog, so it must always have a recommended entry to fall back to.
    expect(defaultForRole("embed")).toBeDefined();
  });

  it("catalogForRole sorts recommended entries first", () => {
    const embed = catalogForRole("embed");
    expect(embed.length).toBeGreaterThan(0);
    expect(embed[0].recommended).toBe(true);
  });

  it("getCatalogEntry returns the expected default embed entry", () => {
    const e = getCatalogEntry("nomic-embed-text-v1.5.Q8_0");
    expect(e?.kind).toBe("gguf");
    expect(e?.roles).toContain("embed");
  });

  it("returns undefined for unknown ids", () => {
    expect(getCatalogEntry("does-not-exist")).toBeUndefined();
  });

  it("getCatalogEntryByFilename round-trips for GGUF entries", () => {
    for (const e of CATALOG) {
      if (e.kind !== "gguf") continue;
      expect(getCatalogEntryByFilename(e.filename)?.id).toBe(e.id);
    }
  });

  it("anthropic entries don't expose filename/url fields", () => {
    const a = CATALOG.find((e) => e.kind === "anthropic-api");
    if (!a) throw new Error("expected at least one anthropic entry in catalog");
    expect("filename" in a).toBe(false);
    expect("downloadUrl" in a).toBe(false);
  });

  it("ships downloadable Whisper transcribers with a recommended default", () => {
    const transcribers = catalogForRole("transcribe");
    expect(transcribers.length).toBeGreaterThanOrEqual(3);
    expect(defaultForRole("transcribe")?.id).toBe("whisper-small");
    expect(transcribers[0].recommended).toBe(true); // recommended sorts first
  });

  it("Whisper entries are gguf-kind, transcribe-only, with pinned sha256 + ggml filenames", () => {
    for (const e of catalogForRole("transcribe")) {
      expect(e.kind).toBe("gguf");
      expect(e.roles).toEqual(["transcribe"]);
      if (e.kind !== "gguf") continue;
      expect(e.filename).toMatch(/^ggml-.*\.bin$/);
      expect(e.downloadUrl).toContain("ggerganov/whisper.cpp");
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.sizeBytes).toBeGreaterThan(0);
    }
  });
});
