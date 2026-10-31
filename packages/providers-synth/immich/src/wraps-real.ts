// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wraps-real Immich twin: the REAL client, sync source and normalizer
 * over the in-memory `SimulatedImmich` instead of a server on the network.
 * The only seams are the client's `fetch` and the sign-in.
 *
 * The corpus comes from the active universe's `sources/immich/fake-corpus.json`,
 * a compact form of the simulated server's corpus. A test reaches the live
 * server through {@link getImmichWrapsRealController} to edit, trash and
 * delete assets, which the next sync reads exactly as it would Immich's.
 */

import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import { SimulatedImmich } from "@omnesis/provider-immich/testing";
import type { ImmichAsset } from "@omnesis/provider-immich";

const FIXTURE_FILE = "fake-corpus.json";

/** The base URL documents link to. A reserved name: nothing ever resolves it. */
export const SIMULATED_BASE_URL = "http://immich.example.com:2283";
/** The key the twin's context presents; the simulated server knows it. */
export const SIMULATED_API_KEY = "synthetic-immich-key";

interface FixtureUser {
  id: string;
  email: string;
  name: string;
}

interface FixtureAsset {
  id: string;
  owner: "self" | "partner";
  type: "IMAGE" | "VIDEO";
  visibility?: "timeline" | "archive" | "hidden" | "locked";
  originalFileName: string;
  takenAt: string;
  timeZone?: string;
  city?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  /** Make and model. */
  camera?: [string, string];
  description?: string;
  people?: Array<{ id: string; name: string }>;
  durationMs?: number;
  isFavorite?: boolean;
  isTrashed?: boolean;
}

/** `sources/immich/fake-corpus.json`. */
export interface ImmichFakeCorpusFixture {
  self: FixtureUser;
  partners: Array<FixtureUser & { inTimeline: boolean }>;
  albums: Array<{ id: string; albumName: string; assetIds: string[] }>;
  assets: FixtureAsset[];
}

let cachedFixture: ImmichFakeCorpusFixture | null = null;

function loadImmichFixture(): ImmichFakeCorpusFixture {
  cachedFixture ??= loadSourceFixtureJson<ImmichFakeCorpusFixture>(
    loadActiveUniverse(),
    "immich",
    FIXTURE_FILE,
  );
  return cachedFixture;
}

/** True when the active universe ships an Immich corpus. */
export function universeHasImmichCorpus(): boolean {
  try {
    loadImmichFixture();
    return true;
  } catch {
    return false;
  }
}

/** The account the universe connects: the self user's email. */
export function selfImmichAccount(): string {
  return loadImmichFixture().self.email;
}

/** A fixture asset as Immich serves it, uploaded the day after it was taken. */
function toAsset(a: FixtureAsset, fixture: ImmichFakeCorpusFixture): ImmichAsset {
  const ownerId = a.owner === "self" ? fixture.self.id : fixture.partners[0]!.id;
  const uploaded = new Date(Date.parse(a.takenAt) + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: a.id,
    ownerId,
    type: a.type,
    originalFileName: a.originalFileName,
    fileCreatedAt: a.takenAt,
    updatedAt: uploaded,
    isFavorite: a.isFavorite === true,
    isArchived: a.visibility === "archive",
    isTrashed: a.isTrashed === true,
    visibility: a.visibility ?? "timeline",
    duration: a.type === "VIDEO" ? (a.durationMs ?? null) : null,
    checksum: Buffer.from(a.id).toString("base64"),
    exifInfo: {
      dateTimeOriginal: a.takenAt,
      timeZone: a.timeZone ?? null,
      city: a.city ?? null,
      country: a.country ?? null,
      latitude: a.latitude ?? null,
      longitude: a.longitude ?? null,
      make: a.camera?.[0] ?? null,
      model: a.camera?.[1] ?? null,
      description: a.description ?? null,
    },
    people: (a.people ?? []).map((p) => ({ id: p.id, name: p.name })),
  };
}

function simulatedCorpus(fixture: ImmichFakeCorpusFixture) {
  return {
    users: [fixture.self, ...fixture.partners.map(({ inTimeline: _, ...u }) => u)],
    keys: [
      {
        key: SIMULATED_API_KEY,
        userId: fixture.self.id,
        permissions: ["asset.read", "album.read", "user.read"],
      },
    ],
    assets: fixture.assets.map((a) => toAsset(a, fixture)),
    albums: fixture.albums.map((album) => ({ ...album, ownerId: fixture.self.id })),
    partnerships: fixture.partners.map((p) => ({
      sharedBy: p.id,
      sharedWith: fixture.self.id,
      inTimeline: p.inTimeline,
    })),
  };
}

/** The test's handle on a live wraps-real source. */
export interface ImmichWrapsRealController {
  /** The simulated server: `editAsset`, `trashAsset`, `deleteAsset`, `calls`, … */
  server: SimulatedImmich;
}

const controllers = new Map<string, ImmichWrapsRealController>();
let server: SimulatedImmich | null = null;

/** The one simulated server of this process, built from the universe on first use. */
export function simulatedServer(): SimulatedImmich {
  server ??= new SimulatedImmich(simulatedCorpus(loadImmichFixture()));
  return server;
}

export function registerController(sourceId: string, controller: ImmichWrapsRealController): void {
  controllers.set(sourceId, controller);
}

export function unregisterController(sourceId: string): void {
  controllers.delete(sourceId);
}

/** The controller of a fully qualified `immich:<account>` source. */
export function getImmichWrapsRealController(
  sourceId: string,
): ImmichWrapsRealController | undefined {
  return controllers.get(sourceId);
}
