// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * TypeScript mirror of the iOS-hosted `VisitSchema.table`. The production
 * source registers this schema over the device channel; the synthetic source
 * owns the equivalent descriptor so the gateway can exercise the same
 * projection contract without an iPhone.
 */
export const LOCATION_VISITS_SCHEMA: AnalyticsTableSchema = {
  tableName: "location_visits",
  displayName: "Location Visits",
  description:
    "Places you spent time — a named place with an arrival and departure — derived on-device from Core Location visit monitoring.",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "Deterministic id derived from account and arrival",
    },
    { name: "account_id", type: "VARCHAR", description: "Per-device identifier" },
    { name: "place_name", type: "VARCHAR", description: "Most-specific place name" },
    {
      name: "sub_locality",
      type: "VARCHAR",
      description: "Neighbourhood or district",
      nullable: true,
    },
    { name: "locality", type: "VARCHAR", description: "City or town", nullable: true },
    {
      name: "administrative_area",
      type: "VARCHAR",
      description: "State or region",
      nullable: true,
    },
    { name: "country", type: "VARCHAR", description: "Country", nullable: true },
    { name: "latitude", type: "DOUBLE", description: "Visit centre latitude" },
    { name: "longitude", type: "DOUBLE", description: "Visit centre longitude" },
    {
      name: "horizontal_accuracy_m",
      type: "DOUBLE",
      description: "Radius estimate in metres",
    },
    { name: "arrival_time", type: "TIMESTAMPTZ", description: "When the dwell began (UTC)" },
    { name: "departure_time", type: "TIMESTAMPTZ", description: "When the dwell ended (UTC)" },
    { name: "duration_seconds", type: "INTEGER", description: "Dwell duration" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "arrival_time",
  record: {
    titleColumns: ["place_name"],
    keyColumns: ["place_name", "arrival_time", "departure_time", "duration_seconds"],
  },
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "visit",
    start: "$semanticTime",
    end: "departure_time",
    label: "place_name",
    kind: "visit",
    modality: "observed",
    status: "completed",
  },
  exampleQueries: [
    "SELECT place_name, arrival_time, departure_time FROM location_visits ORDER BY arrival_time DESC",
    "SELECT place_name, COUNT(*) AS visits, SUM(duration_seconds)/3600.0 AS hours FROM location_visits GROUP BY place_name ORDER BY hours DESC",
  ],
};
