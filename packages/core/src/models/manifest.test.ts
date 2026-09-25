// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadManifest,
  saveManifest,
  upsertManifestEntry,
  removeManifestEntry,
  findManifestEntry,
  findManifestEntryByFilename,
} from "./manifest.js";
import type { Manifest, ManifestEntry } from "./types.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-manifest-"));
  path = join(dir, "manifest.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample: ManifestEntry = {
  id: "x",
  filename: "x.gguf",
  sizeBytes: 1234,
  sha256: "deadbeef",
  downloadedAt: "2026-01-01T00:00:00.000Z",
};

describe("manifest", () => {
  it("returns the empty manifest when the file doesn't exist", () => {
    const { manifest, warning } = loadManifest(path);
    expect(manifest.version).toBe(1);
    expect(manifest.models).toEqual([]);
    expect(warning).toBeUndefined();
  });

  it("writes and reads back round-trip", () => {
    const m: Manifest = { version: 1, models: [sample] };
    saveManifest(path, m);
    const { manifest } = loadManifest(path);
    expect(manifest.models).toHaveLength(1);
    expect(manifest.models[0].id).toBe("x");
  });

  it("returns the empty manifest with a warning on malformed JSON", () => {
    writeFileSync(path, "{not json");
    const { manifest, warning } = loadManifest(path);
    expect(manifest.models).toEqual([]);
    expect(warning).toMatch(/not valid JSON/);
  });

  it("returns the empty manifest with a warning on unexpected shape", () => {
    writeFileSync(path, JSON.stringify({ version: 99, models: "nope" }));
    const { manifest, warning } = loadManifest(path);
    expect(manifest.models).toEqual([]);
    expect(warning).toMatch(/unexpected shape/);
  });

  it("upsertManifestEntry replaces by id and is non-mutating", () => {
    const original: Manifest = { version: 1, models: [sample] };
    const updated = upsertManifestEntry(original, { ...sample, sizeBytes: 5678 });
    expect(updated.models).toHaveLength(1);
    expect(updated.models[0].sizeBytes).toBe(5678);
    expect(original.models[0].sizeBytes).toBe(1234);
  });

  it("removeManifestEntry drops by id", () => {
    const out = removeManifestEntry({ version: 1, models: [sample] }, "x");
    expect(out.models).toEqual([]);
  });

  it("findManifestEntry / findManifestEntryByFilename look up correctly", () => {
    const m: Manifest = { version: 1, models: [sample] };
    expect(findManifestEntry(m, "x")?.filename).toBe("x.gguf");
    expect(findManifestEntryByFilename(m, "x.gguf")?.id).toBe("x");
    expect(findManifestEntry(m, "missing")).toBeUndefined();
  });

  it("saveManifest writes through atomic rename, leaving no scratch file", () => {
    saveManifest(path, { version: 1, models: [sample] });
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, models: [sample] });
    // The atomic writer stages the payload under a name private to that
    // write, so match on the `.tmp` suffix all of them share.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
