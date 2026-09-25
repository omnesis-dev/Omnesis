// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every synthetic document comes from a declared device.
 *
 * The universe manifest carries a device roster and attributes each seed
 * source to one of its devices. The harness pairs that roster into the
 * gateway and syncs each source as its device, so what the gateway records —
 * device rows, source ownership, the documents' provenance — matches the
 * manifest exactly. This is the substrate the multi-device modes are asserted
 * on: a phone-pushed source belongs to a phone, a polled one to the collector,
 * and nothing lands under the harness's own admin identity.
 */
import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadUniverse, sourceDeviceAssignments } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getSyncState } from "./helpers.js";

const UNIVERSE = "e2e-minimal";
const PHONE_SOURCE = "apple-health:ios-synth-johnsmith";
const COLLECTOR_SOURCE = "gmail:john.smith@example.com";

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  capabilities?: { hostableSourceTypes?: string[] };
}
interface SourceRow {
  id: string;
  deviceId: string;
}

describe("device roster (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  const manifest = loadUniverse(UNIVERSE).manifest;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: UNIVERSE });
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("every roster device is paired under its name and kind", async () => {
    const { items } = await harness.gatewayJson<{ items: DeviceRow[] }>("/admin/devices");
    for (const declared of manifest.devices) {
      const row = items.find((d) => d.name === declared.name);
      expect(row, `roster device ${declared.id}`).toBeDefined();
      expect(row?.kind).toBe(declared.kind);
      const paired = harness.getDevices().find((d) => d.rosterId === declared.id);
      expect(paired?.deviceId).toBe(row?.id);
    }
  });

  test("every seed source is owned by the device the manifest attributes it to", async () => {
    const { items } = await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources");
    const assignments = sourceDeviceAssignments(manifest);
    expect(assignments.size).toBeGreaterThan(0);
    // The manifest and the synth twins' `discover()` describe the same
    // accounts: a seed source the harness never registered is a manifest
    // entry naming an account no twin produces.
    const registered = new Set(items.map((s) => s.id));
    expect([...assignments.keys()].filter((id) => !registered.has(id))).toEqual([]);
    expect([...registered].filter((id) => !assignments.has(id))).toEqual([]);
    for (const [sourceId, declared] of assignments) {
      const row = items.find((s) => s.id === sourceId);
      const paired = harness.getDevices().find((d) => d.rosterId === declared.id);
      expect(row?.deviceId, sourceId).toBe(paired?.deviceId);
    }
    // Nothing is owned by the harness's own admin identity.
    const rosterIds = new Set(harness.getDevices().map((d) => d.deviceId));
    expect(items.filter((s) => !rosterIds.has(s.deviceId)).map((s) => s.id)).toEqual([]);
  });

  test("a phone-pushed source syncs as the phone, a polled one as the collector", async () => {
    expect(harness.deviceForSource(PHONE_SOURCE).kind).toBe("ios");
    expect(harness.deviceForSource(COLLECTOR_SOURCE).kind).toBe("collector");

    await harness.triggerSyncAndWait(PHONE_SOURCE, 60_000);
    await harness.triggerSyncAndWait(COLLECTOR_SOURCE, 60_000);
    // The apple-health twin is a structured source: its samples land as
    // analytics rows, not documents, so the proof of its completed sync is its cursor.
    expect(await getSyncState(harness.gatewayUrl, harness.apiKey, PHONE_SOURCE)).not.toBeNull();
    expect(
      await getDocumentCount(harness.gatewayUrl, harness.apiKey, COLLECTOR_SOURCE),
    ).toBeGreaterThan(0);

    // The phone's engine — not the collector's — ran the sync, and the
    // source row keeps the phone as its owner.
    const phone = harness.deviceForSource(PHONE_SOURCE);
    expect(phone.engine.getStatuses().find((s) => s.sourceId === PHONE_SOURCE)?.state).toBe("idle");
    expect(
      harness
        .getEngine()
        .getStatuses()
        .some((s) => s.sourceId === PHONE_SOURCE),
    ).toBe(false);
    const { items } = await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources");
    expect(items.find((s) => s.id === PHONE_SOURCE)?.deviceId).toBe(
      harness.deviceForSource(PHONE_SOURCE).deviceId,
    );
  });
});
