// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG, CATALOG_ROLE_CAPABILITY, catalogForRole, MODEL_ROLES } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { buildCatalogListing, modelReadyHint, readAssignedModelId } from "./model.js";
import type { ResolvedAssignment } from "@omnesis/core";

describe("buildCatalogListing", () => {
  it("filters to the requested role and preselects the recommended entry", () => {
    const listing = buildCatalogListing("embed", undefined);
    expect(listing.role).toBe("embed");
    expect(listing.entries.length).toBe(catalogForRole("embed").length);
    expect(listing.entries.every((e) => e.roles.includes("embed"))).toBe(true);
    const preselected = listing.entries.find((e) => e.id === listing.default);
    expect(preselected?.recommended).toBe(true);
  });

  it("prefers the assigned model over the recommended one", () => {
    const other = catalogForRole("embed").find((e) => e.recommended !== true);
    expect(other).toBeDefined();
    const listing = buildCatalogListing("embed", other!.id);
    expect(listing.default).toBe(other!.id);
    expect(listing.entries.find((e) => e.id === other!.id)?.assigned).toBe(true);
  });

  it("reports an assignment the catalog does not contain, and marks no entry", () => {
    // A model served by an HTTP backend: nothing to download, nothing to mark,
    // but a caller deciding whether to install weights has to see it.
    const listing = buildCatalogListing("embed", "local-vllm/some-embedder");
    expect(listing.assignedId).toBe("local-vllm/some-embedder");
    expect(listing.entries.some((e) => e.assigned)).toBe(false);
    expect(listing.entries.find((e) => e.id === listing.default)?.recommended).toBe(true);
  });

  it("carries the assignment verbatim, and null when there is none", () => {
    expect(buildCatalogListing("embed", undefined).assignedId).toBeNull();
    expect(buildCatalogListing("embed", "bge-small-en-v1.5.Q8_0").assignedId).toBe(
      "bge-small-en-v1.5.Q8_0",
    );
    // Without a role there is no assignment slot to read.
    expect(buildCatalogListing(undefined, "bge-small-en-v1.5.Q8_0").assignedId).toBeNull();
  });

  it("lists the whole catalog with no default when no role is requested", () => {
    const listing = buildCatalogListing(undefined, undefined);
    expect(listing.role).toBeNull();
    expect(listing.default).toBeNull();
    expect(listing.entries.length).toBe(CATALOG.length);
  });

  it("carries the fields a picker needs, and a size only for downloadable weights", () => {
    const listing = buildCatalogListing("embed", undefined);
    const entry = listing.entries[0]!;
    expect(entry.name.length).toBeGreaterThan(0);
    expect(entry.license.length).toBeGreaterThan(0);
    expect(entry.description.length).toBeGreaterThan(0);
    for (const e of listing.entries) {
      if (e.kind === "gguf") expect(typeof e.sizeBytes).toBe("number");
      else expect(e.sizeBytes).toBeNull();
    }
  });

  it("serializes every field the installer's parser reads", () => {
    // scripts/install.sh turns this document into the model menu: it reads
    // `default`, `assignedId`, and each entry's id, name, size and dimension.
    const parsed = JSON.parse(JSON.stringify(buildCatalogListing("embed", undefined))) as {
      default: string;
      assignedId: string | null;
      entries: { id: string; name: string; sizeBytes: number | null; embedDim: number | null }[];
    };
    expect(parsed.entries.map((e) => e.id)).toContain(parsed.default);
    expect(parsed.assignedId).toBeNull();
    for (const entry of parsed.entries) {
      expect(entry.id).toMatch(/\S/);
      expect(entry.name).toMatch(/\S/);
      // Both are null for an entry with no weights to download, which the
      // installer's menu renders as a bare name.
      expect(entry.sizeBytes === null || typeof entry.sizeBytes === "number").toBe(true);
      expect(entry.embedDim === null || typeof entry.embedDim === "number").toBe(true);
    }
  });
});

describe("readAssignedModelId", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-model-catalog-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeConfig(body: string): void {
    writeFileSync(join(dir, "omnesis.json"), body);
  }

  it("reads the assignment for each role", () => {
    writeConfig(
      JSON.stringify({
        inference: {
          assignments: {
            embedder: "bge-small-en-v1.5.Q8_0",
            transcriber: "whisper-small",
          },
        },
      }),
    );
    expect(readAssignedModelId("embed", dir)).toBe("bge-small-en-v1.5.Q8_0");
    expect(readAssignedModelId("transcribe", dir)).toBe("whisper-small");
    expect(readAssignedModelId("agent", dir)).toBeUndefined();
    // Every catalog role maps to an assignment slot the config schema accepts.
    // The schema rejects unknown assignment keys, so this fails the day a
    // capability role is renamed without the map following.
    for (const role of MODEL_ROLES) {
      const parsed = omnesisConfigSchema.safeParse({
        inference: { assignments: { [CATALOG_ROLE_CAPABILITY[role]]: "example-model" } },
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("returns undefined when the config is absent, malformed, or shaped differently", () => {
    expect(readAssignedModelId("embed", dir)).toBeUndefined();
    writeConfig("{ not json");
    expect(readAssignedModelId("embed", dir)).toBeUndefined();
    writeConfig(JSON.stringify({ inference: { assignments: { embedder: null } } }));
    expect(readAssignedModelId("embed", dir)).toBeUndefined();
    writeConfig(JSON.stringify({ inference: "nope" }));
    expect(readAssignedModelId("embed", dir)).toBeUndefined();
    writeConfig("[]");
    expect(readAssignedModelId("embed", dir)).toBeUndefined();
  });
});

describe("modelReadyHint", () => {
  const unassigned = { kind: "unresolved" } as unknown as ResolvedAssignment;
  const none = { embedder: unassigned, agent: unassigned, transcriber: unassigned };
  const embedEntry = CATALOG.find(
    (e) => e.kind === "gguf" && e.roles.length === 1 && e.roles[0] === "embed",
  );
  const apiEntry = CATALOG.find((e) => e.kind === "anthropic-api");

  it("names the omnesis command and the role for a local model nobody uses yet", () => {
    expect(embedEntry).toBeDefined();
    const hint = modelReadyHint(embedEntry!, none);
    expect(hint).toContain(`omnesis model assign embedder local/${embedEntry!.id}`);
    expect(hint).not.toContain("cli model");
  });

  it("says the model is already assigned instead of asking to assign it", () => {
    const assigned = { kind: "local", catalogId: embedEntry!.id } as unknown as ResolvedAssignment;
    expect(modelReadyHint(embedEntry!, { ...none, embedder: assigned })).toBe(
      "Already assigned as the embedder.",
    );
  });

  it("assigns an API model by its provider id, not as a local model", () => {
    expect(apiEntry).toBeDefined();
    const hint = modelReadyHint(apiEntry!, none);
    expect(hint).toContain(` ${apiEntry!.id}`);
    expect(hint).not.toContain(`local/${apiEntry!.id}`);
  });
});
