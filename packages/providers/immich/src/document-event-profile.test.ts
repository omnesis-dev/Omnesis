// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins the Immich document-event profile to what the real sync path emits:
 * the source over a simulated server, not the normalizer alone.
 */

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { ImmichClient } from "./client.js";
import { immichDocumentEventProfile } from "./document-event-profile.js";
import { ImmichAssetSource } from "./source.js";
import { SimulatedImmich } from "./testing/simulated-immich.js";
import immich, { IMMICH_SOURCE_ID } from "./index.js";
import type { DocumentInput } from "@omnesis/types";
import type { ImmichAsset } from "./types.js";

const base = (id: string, over: Partial<ImmichAsset>): ImmichAsset => ({
  id,
  ownerId: "u-self",
  type: "IMAGE",
  fileCreatedAt: "2026-05-03T09:14:22.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  visibility: "timeline",
  exifInfo: { city: "Example City", country: "Exampleland" },
  people: [{ id: "p1", name: "Sarah Mendez" }],
  ...over,
});

async function syncDocs(): Promise<DocumentInput[]> {
  const server = new SimulatedImmich({
    users: [
      { id: "u-self", email: "maya.reeves@example.com", name: "Maya Reeves" },
      { id: "u-partner", email: "jamie.lopez@example.com", name: "Jamie Lopez" },
    ],
    keys: [{ key: "k", userId: "u-self", permissions: ["all"] }],
    assets: [
      base("0a000000-0000-4000-8000-000000000001", { isFavorite: true }),
      base("0a000000-0000-4000-8000-000000000002", {
        type: "VIDEO",
        duration: 4000,
        exifInfo: {
          city: "Example City",
          state: "Example State",
          country: "Exampleland",
          timeZone: "Europe/Lisbon",
          make: "Apple",
          model: "iPhone 15",
        },
      }),
      base("0a000000-0000-4000-8000-000000000003", { ownerId: "u-partner" }),
    ],
    albums: [
      {
        id: "al1",
        albumName: "Harbour Weekend",
        ownerId: "u-self",
        assetIds: ["0a000000-0000-4000-8000-000000000001"],
      },
    ],
    partnerships: [{ sharedBy: "u-partner", sharedWith: "u-self", inTimeline: true }],
  });
  const source = new ImmichAssetSource(
    new ImmichClient("http://immich.example.com", "k", { fetchImpl: server.fetch }),
    ProviderId("immich:maya.reeves@example.com"),
    SourceId("immich:maya.reeves@example.com"),
    "maya.reeves@example.com",
  );
  return (await source.sync(null)).documents;
}

describe("Immich document-event profile", () => {
  it("satisfies the source-boundary contract and is wired into the descriptor", () => {
    expect(() => validateDocumentEventProfile(immichDocumentEventProfile, "immich")).not.toThrow();
    const entry = immich.sources.find((s) => s.id === IMMICH_SOURCE_ID);
    expect(entry?.documentEventProfile).toBe(immichDocumentEventProfile);
  });

  it("emits exactly the declared document types and person roles", async () => {
    const docs = await syncDocs();
    const types = [...new Set(docs.map((d) => d.metadata.documentType))].sort();
    expect(types).toEqual([...(immichDocumentEventProfile.documentTypes ?? [])].sort());
    const roles = [
      ...new Set(docs.flatMap((d) => (d.metadata.people ?? []).map((p) => p.role))),
    ].sort();
    expect(roles).toEqual([...(immichDocumentEventProfile.personRoles ?? [])].sort());
  });

  it("populates every declared metadata field with its declared type", async () => {
    const docs = await syncDocs();
    for (const field of immichDocumentEventProfile.metadataFields ?? []) {
      const key = field.path.replace(/^extra\./, "");
      const values = docs.map((d) => (d.metadata.extra ?? {})[key]).filter((v) => v !== undefined);
      expect(values.length, field.path).toBeGreaterThan(0);
      for (const value of values) {
        if (field.type === "string-array") {
          expect(
            Array.isArray(value) && value.every((v) => typeof v === "string"),
            field.path,
          ).toBe(true);
        } else {
          expect(typeof value, field.path).toBe(field.type);
        }
      }
    }
    expect(
      docs.some((d) => (d.metadata.extra?.albums as string[]).includes("Harbour Weekend")),
    ).toBe(true);
  });
});
