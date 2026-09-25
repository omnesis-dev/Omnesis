// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  loadActiveUniverse,
  loadSourceFixtureJson,
  sha256Hex,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

export interface LocationVisitEntry {
  id: string;
  placeName: string;
  subLocality?: string;
  locality?: string;
  administrativeArea?: string;
  country?: string;
  latitude: number;
  longitude: number;
  horizontalAccuracyM: number;
  arrivalTime: string;
  departureTime: string;
}

let cached: LocationVisitEntry[] | null = null;

export function loadLocationVisits(): LocationVisitEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<LocationVisitEntry[]>(
    loadActiveUniverse(),
    "core-location-visits",
    "visits.json",
  );
  return cached;
}

export function resetLocationVisitFixtureCache(): void {
  cached = null;
}

export function mapLocationVisitRecord(
  entry: LocationVisitEntry,
  accountId = "local",
): Record<string, unknown> {
  const durationSeconds = Math.round(
    (Date.parse(entry.departureTime) - Date.parse(entry.arrivalTime)) / 1_000,
  );
  return {
    id: entry.id,
    account_id: accountId,
    place_name: entry.placeName,
    sub_locality: entry.subLocality ?? null,
    locality: entry.locality ?? null,
    administrative_area: entry.administrativeArea ?? null,
    country: entry.country ?? null,
    latitude: entry.latitude,
    longitude: entry.longitude,
    horizontal_accuracy_m: entry.horizontalAccuracyM,
    arrival_time: entry.arrivalTime,
    departure_time: entry.departureTime,
    duration_seconds: durationSeconds,
  };
}

export function mapLocationVisitDocument(
  entry: LocationVisitEntry,
  context: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const durationSeconds = Math.round(
    (Date.parse(entry.departureTime) - Date.parse(entry.arrivalTime)) / 1_000,
  );
  const durationMinutes = Math.round(durationSeconds / 60);
  const day = entry.arrivalTime.slice(0, 10);
  const area = [entry.locality, entry.administrativeArea, entry.country]
    .filter((part): part is string => Boolean(part && part !== entry.placeName))
    .join(", ");
  const content = [
    `Visited ${entry.placeName} on ${day}.`,
    `${entry.arrivalTime} → ${entry.departureTime} (${durationMinutes} minutes).`,
    area ? `Area: ${area}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    sourceId: context.sourceId,
    providerId: context.providerId,
    externalId: entry.id,
    title: `Visited ${entry.placeName} — ${day}`,
    content,
    contentHash: sha256Hex(content),
    metadata: {
      documentType: "visit",
      tags: ["location", "visit"],
      extra: {
        arrival: entry.arrivalTime,
        departure: entry.departureTime,
        durationSeconds,
        placeName: entry.placeName,
        ...(entry.subLocality ? { subLocality: entry.subLocality } : {}),
        ...(entry.locality ? { locality: entry.locality } : {}),
        ...(entry.administrativeArea ? { administrativeArea: entry.administrativeArea } : {}),
        ...(entry.country ? { country: entry.country } : {}),
      },
    },
    sourceCreatedAt: entry.arrivalTime,
    sourceUpdatedAt: entry.departureTime,
  };
}
