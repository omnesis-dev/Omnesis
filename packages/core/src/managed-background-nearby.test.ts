// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { managedDesktopNearbySnapshotSchema } from "./managed-background-nearby.js";

const candidate = { address: "192.168.1.7", port: 443, remainingMs: 1000 };
const snapshot = {
  format: 1,
  generation: randomUUID(),
  sequence: 1,
  state: "ready",
  candidates: [candidate],
};

test("denied or unavailable never hides candidate routes in an otherwise valid snapshot", () => {
  for (const state of ["denied", "unavailable"]) {
    expect(managedDesktopNearbySnapshotSchema.safeParse({ ...snapshot, state }).success).toBe(
      false,
    );
    expect(
      managedDesktopNearbySnapshotSchema.safeParse({ ...snapshot, state, candidates: [] }).success,
    ).toBe(true);
  }
});

test("native snapshot rejects expired TTL, unsafe sequence and unknown fields", () => {
  for (const value of [
    { ...snapshot, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, candidates: [{ ...candidate, remainingMs: 0 }] },
    { ...snapshot, candidates: [{ ...candidate, remainingMs: 30_001 }] },
    { ...snapshot, token: "invented-test-token" },
    { ...snapshot, candidates: [{ ...candidate, serviceName: "invented-service" }] },
  ])
    expect(managedDesktopNearbySnapshotSchema.safeParse(value).success).toBe(false);
  expect(managedDesktopNearbySnapshotSchema.parse(snapshot)).toEqual(snapshot);
});
