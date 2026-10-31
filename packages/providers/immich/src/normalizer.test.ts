// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  assetToDocument,
  isIndexableAsset,
  personLid,
  type ImmichNormalizeContext,
} from "./normalizer.js";
import immich, { IMMICH_SOURCE_ID } from "./index.js";
import type { ImmichAsset } from "./types.js";

const ID = "4c1f8e2a-6b3d-4e5f-9a7b-1c2d3e4f5a6b";
const ctx: ImmichNormalizeContext = {
  providerId: ProviderId("immich:maya.reeves@example.com"),
  sourceId: SourceId("immich:maya.reeves@example.com"),
  baseUrl: "http://immich.example.com:2283",
  userId: "u-self",
  albums: {
    names: { a1: "Harbour Weekend", a2: "Favourites 2026" },
    byAsset: { [ID]: ["a2", "a1"] },
  },
};

function photo(over: Partial<ImmichAsset> = {}): ImmichAsset {
  return {
    id: ID,
    ownerId: "u-self",
    type: "IMAGE",
    originalFileName: "IMG_0042.HEIC",
    fileCreatedAt: "2026-05-03T09:14:22.000Z",
    localDateTime: "2026-05-03T10:14:22.000Z",
    updatedAt: "2026-10-02T08:00:01.512Z",
    isFavorite: true,
    isArchived: false,
    visibility: "timeline",
    duration: null,
    checksum: "q8VbX0==",
    exifInfo: {
      dateTimeOriginal: "2026-05-03T09:14:22.000Z",
      timeZone: "Europe/Lisbon",
      city: "Example City",
      state: "Example State",
      country: "Exampleland",
      latitude: 38.7,
      longitude: -9.1,
      make: "Apple",
      model: "iPhone 15",
      lensModel: "Main Camera",
      description: "Picnic by the river\nwith everyone",
    },
    people: [
      { id: "p1", name: "Sarah Mendez" },
      { id: "p2", name: "" },
      { id: "p3", name: "David Lin", isHidden: true },
      { id: "p1", name: "Sarah Mendez" },
    ],
    ...over,
  };
}

describe("assetToDocument", () => {
  it("renders the searchable text first, then when, where, who, albums and camera", () => {
    const doc = assetToDocument(photo(), ctx);
    expect(doc.title).toBe("Picnic by the river");
    expect(doc.content).toBe(
      [
        "Picnic by the river",
        "with everyone",
        "",
        "**Photo** taken Sunday, 3 May 2026 at 10:14 (Europe/Lisbon, UTC+01:00)",
        "**Where:** Example City, Example State, Exampleland",
        "**People:** Sarah Mendez",
        "**Albums:** Favourites 2026, Harbour Weekend",
        "**Camera:** Apple iPhone 15 · Main Camera",
        "**Marked:** favorite",
        "**File:** IMG_0042.HEIC",
      ].join("\n"),
    );
  });

  it("carries identity, links, times and metadata", () => {
    const doc = assetToDocument(photo(), ctx);
    expect(doc.externalId).toBe(ID);
    expect(doc.sourceCreatedAt).toBe("2026-05-03T09:14:22.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-10-02T08:00:01.512Z");
    expect(doc.contentHash).toMatch(/^[0-9a-f]+$/);
    expect(doc.metadata.documentType).toBe("photo");
    expect(doc.metadata.sourceUrl).toBe(`http://immich.example.com:2283/photos/${ID}`);
    expect(doc.metadata.extra).toEqual({
      takenAt: "2026-05-03T09:14:22.000Z",
      timeZone: "Europe/Lisbon",
      city: "Example City",
      state: "Example State",
      country: "Exampleland",
      latitude: 38.7,
      longitude: -9.1,
      albums: ["Favourites 2026", "Harbour Weekend"],
      people: ["Sarah Mendez"],
      isFavorite: true,
      isArchived: false,
      cameraMake: "Apple",
      cameraModel: "iPhone 15",
      lensModel: "Main Camera",
      originalFileName: "IMG_0042.HEIC",
      checksum: "q8VbX0==",
      ownerId: "u-self",
    });
  });

  it("names the self owner and each named, visible face once, namespaced by user", () => {
    const doc = assetToDocument(photo(), ctx);
    expect(doc.metadata.people).toEqual([
      { role: "owner", isSelf: true },
      {
        role: "participant",
        name: "Sarah Mendez",
        identifiers: [{ kind: "lid", value: "immich:u-self/p1" }],
      },
    ]);
    expect(personLid("u-other", "p1")).not.toBe(personLid("u-self", "p1"));
  });

  it("titles an undescribed asset by kind, place and date, and renders a video's length", () => {
    const doc = assetToDocument(
      photo({
        type: "VIDEO",
        duration: 3_725_000,
        exifInfo: { ...photo().exifInfo, description: null },
        people: [],
      }),
      ctx,
    );
    expect(doc.title).toBe("Video · Example City · 3 May 2026");
    expect(doc.metadata.documentType).toBe("video");
    expect(doc.content).toContain("**Duration:** 1:02:05");
    expect(doc.metadata.extra?.durationMs).toBe(3_725_000);
  });

  it("falls back to the wall-clock local time when the zone is unknown or an offset", () => {
    const doc = assetToDocument(
      photo({ exifInfo: { dateTimeOriginal: "2026-05-03T09:14:22.000Z", timeZone: "UTC+1" } }),
      ctx,
    );
    expect(doc.content).toContain("**Photo** taken Sunday, 3 May 2026 at 10:14");
    expect(doc.content).not.toContain("UTC+1");
    expect(doc.metadata.extra?.timeZone).toBeUndefined();
  });

  it("uses the file date without EXIF and leaves out an absent place", () => {
    const doc = assetToDocument(
      photo({ exifInfo: undefined, people: [], localDateTime: undefined }),
      ctx,
    );
    expect(doc.sourceCreatedAt).toBe("2026-05-03T09:14:22.000Z");
    expect(doc.content).toContain("(UTC)");
    expect(doc.content).not.toContain("**Where:**");
    expect(doc.title).toBe("Photo · 3 May 2026");
    expect(doc.metadata.extra).not.toHaveProperty("latitude");
  });

  it("indexes timeline and archived images and videos, never hidden or locked ones", () => {
    expect(isIndexableAsset(photo())).toBe(true);
    expect(isIndexableAsset(photo({ visibility: "archive" }))).toBe(true);
    expect(isIndexableAsset(photo({ visibility: "hidden", type: "VIDEO" }))).toBe(false);
    expect(isIndexableAsset(photo({ visibility: "locked" }))).toBe(false);
    expect(isIndexableAsset(photo({ type: "AUDIO" }))).toBe(false);
  });
});

describe("Immich descriptor", () => {
  const entry = immich.sources.find((s) => s.id === IMMICH_SOURCE_ID)!;

  it("resolves an emitted sourceUrl back to its external id through the url patterns", () => {
    const doc = assetToDocument(photo(), ctx);
    const urls = [
      doc.metadata.sourceUrl!,
      `https://photos.example.org/immich/photos/${ID}`,
      `http://immich.example.com:2283/albums/0a1b2c3d-1111-4222-8333-444455556666/photos/${ID}`,
    ];
    for (const url of urls) {
      const matched = entry
        .urlPatterns!.map((p) => new RegExp(p.regex).exec(url)?.[1])
        .find(Boolean);
      expect(matched?.toLowerCase()).toBe(doc.externalId.toLowerCase());
    }
    expect(
      new RegExp(entry.urlPatterns![0]!.regex).exec("https://example.com/photos/sunset"),
    ).toBeNull();
    expect(entry.urlPatterns![0]!.regex.length).toBeLessThanOrEqual(300);
  });

  it("declares a complete icon, a unit noun and an experimental gate", () => {
    expect(entry.icon).toMatchObject({
      sfSymbol: expect.any(String),
      color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
      bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/i),
      imageDataUri: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    });
    expect(entry.unitName).toBe("photos");
    expect(immich.experimental).toBe(true);
  });
});
