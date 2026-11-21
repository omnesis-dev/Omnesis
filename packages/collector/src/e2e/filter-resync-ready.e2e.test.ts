// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How a filterable field becomes usable on an account whose records predate
 * it, as the filter editor reports it, through real collectors and a
 * spawned gateway.
 *
 * The `folder-filters` universe runs the real Codex and local-files sources
 * over invented files. Both declare a folder field from version 2. Each host
 * is moved between builds with `setSourceVersion`, the one thing a real
 * upgrade changes about what it sends. Asserted:
 *
 *  - an account read at version 1 reads `collector-behind`, naming the host;
 *    updated to version 2, an ordinary sync clears that but the field reads
 *    `needs-resync`, with the source's resync cost, and no record changes;
 *  - a resync in place makes the field `ready`, every record now at version
 *    2 under the id it had;
 *  - an account kept by two computers, one stream each, names only the one
 *    still on the old build; resyncing one computer's stream raises its
 *    records alone, and the field stays `needs-resync`, with the other's
 *    records counted too old, until the other has been resynced too.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  editorField,
  fieldCounts,
  identities,
  readRecords,
  markerKey,
  resyncAndWatch,
  resyncCost,
  versionsOf,
  type RecordSet,
} from "./filter-e2e-reads.js";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";

const CODEX = "codex:codex-maya";
const FILES = "local-files:files-maya";
const PROJECT_FOLDER = "extra.projectFolder";
const FOLDER = "extra.folder";

describe("a filter field becomes ready through a resync in place", () => {
  let harness: SyntheticE2EHarness;
  let laptop: HarnessDevice;
  let desktop: HarnessDevice;

  const sessions = (): RecordSet => readRecords(harness, [CODEX], markerKey(/PROMPT_([A-Z_]+)/));
  const files = (): RecordSet => readRecords(harness, [FILES], markerKey(/BODY_([A-Z_]+)/));
  const versionSet = (records: RecordSet, device?: HarnessDevice): Set<number> =>
    new Set(
      [...versionsOf(harness, records)]
        .filter(([key]) => !device || key.endsWith(`@${device.rosterId}`))
        .map(([, version]) => version),
    );

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "folder-filters",
    });
    await harness.start();
    [laptop, desktop] = harness.devicesForSource(FILES) as [HarnessDevice, HarnessDevice];
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 30_000);

  test("an account read at version 1 needs its host updated, then a resync, then is ready", async () => {
    harness.setSourceVersion(CODEX, 1);
    await harness.triggerSyncAndWait(CODEX, 90_000);
    const before = sessions();
    expect(before.size).toBe(7);
    expect(versionSet(before)).toEqual(new Set([1]));

    expect((await editorField(harness, CODEX, PROJECT_FOLDER)).state).toEqual({
      status: "collector-behind",
      devices: [{ id: laptop.deviceId, name: laptop.name }],
      text: `Update Omnesis on ${laptop.name} to use these filters.`,
    });
    expect(await fieldCounts(harness, CODEX, PROJECT_FOLDER)).toMatchObject({ tooOld: 7 });

    // The host is updated: its ordinary sync finds no session changed.
    harness.setSourceVersion(CODEX, 2);
    await harness.triggerSyncAndWait(CODEX, 90_000);
    expect(versionSet(sessions())).toEqual(new Set([1]));
    const cost = resyncCost(harness, "codex");
    expect(cost).toMatch(/Codex session files are read again/);
    const { state } = await editorField(harness, CODEX, PROJECT_FOLDER);
    expect(state).toMatchObject({ status: "needs-resync", cost });
    expect((state as { text: string }).text).toMatch(
      /^Project folder filters need .+ to be resynced\. /,
    );
    expect((state as { text: string }).text.endsWith(cost!)).toBe(true);

    const states = await resyncAndWatch(harness, CODEX, PROJECT_FOLDER);
    console.info(`${CODEX} resync: ${JSON.stringify(states)}`);
    expect(states[0]?.status).toBe("needs-resync");
    expect(states.at(-1)).toEqual({ status: "ready" });
    for (const state of states)
      expect(["needs-resync", "resyncing", "ready"]).toContain(state.status);

    const after = sessions();
    expect(versionSet(after)).toEqual(new Set([2]));
    expect(identities(after)).toEqual(identities(before));
    expect(await fieldCounts(harness, CODEX, PROJECT_FOLDER)).toMatchObject({
      tooOld: 0,
      tooOldText: null,
    });
  }, 300_000);

  test("an account two computers keep apart is ready only once each computer's stream is resynced", async () => {
    harness.setSourceVersion(FILES, 1);
    await harness.triggerSyncAndWait(FILES, 90_000);
    const before = files();
    expect(before.size).toBe(12);
    expect(versionSet(before)).toEqual(new Set([1]));
    const behind = async () => {
      const { state } = await editorField(harness, FILES, FOLDER);
      return state.status === "collector-behind" ? state.devices.map((device) => device.id) : state;
    };
    expect(await behind()).toEqual([laptop.deviceId, desktop.deviceId]);

    // One computer is updated: only the other is named.
    harness.setSourceVersion(FILES, 2, laptop);
    await harness.triggerSyncAndWait(FILES, 90_000, laptop);
    expect(await behind()).toEqual([desktop.deviceId]);
    harness.setSourceVersion(FILES, 2, desktop);
    await harness.triggerSyncAndWait(FILES, 90_000, desktop);
    expect((await editorField(harness, FILES, FOLDER)).state.status).toBe("needs-resync");

    // The laptop's stream is resynced; the desktop's records stay as they were.
    const first = await resyncAndWatch(harness, FILES, FOLDER, { device: laptop });
    console.info(`${FILES} resync of the laptop's stream: ${JSON.stringify(first)}`);
    expect(first.map((state) => state.status)).toEqual(["needs-resync"]);
    expect(versionSet(files(), laptop)).toEqual(new Set([2]));
    expect(versionSet(files(), desktop)).toEqual(new Set([1]));
    expect(identities(files())).toEqual(identities(before));
    expect(await fieldCounts(harness, FILES, FOLDER)).toMatchObject({
      tooOld: 6,
      tooOldText:
        "6 older items could not be resynced and stay hidden from agents using this filter.",
    });

    const second = await resyncAndWatch(harness, FILES, FOLDER, { device: desktop });
    console.info(`${FILES} resync of the desktop's stream: ${JSON.stringify(second)}`);
    expect(second[0]?.status).toBe("needs-resync");
    expect(second.at(-1)).toEqual({ status: "ready" });
    expect(versionSet(files())).toEqual(new Set([2]));
    expect(identities(files())).toEqual(identities(before));
    expect(await fieldCounts(harness, FILES, FOLDER)).toMatchObject({ tooOld: 0 });
  }, 300_000);
});
