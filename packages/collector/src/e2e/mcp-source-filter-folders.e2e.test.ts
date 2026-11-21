// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Folder filters on the sources that read directories — local files and the
 * coding sessions of claude-code, codex and pi — through real MCP Direct and
 * Answer connections and a spawned gateway.
 *
 * The `folder-filters` universe has two computers. Both host the claude-code
 * sessions and the local files, at the same paths; Codex and Pi run on the
 * laptop only. The real sources read files materialized on disk: every
 * record carries the directory it belongs to, and each computer publishes its
 * own list of folders. A path only means something on the machine it is on,
 * so a folder is a device and a path together. Nothing is pushed or written
 * by hand; folders are picked the way the editor's tree offers them.
 *
 * Asserted, for Direct (search, fetch by id) and Answer:
 *   - the editor of a source on two computers starts its tree at the
 *     computers; with one computer it starts at that computer's folders, and
 *     the entries still name the computer;
 *   - a folder covers everything beneath it, and `/srv/work` does not cover
 *     `/srv/workshop`;
 *   - the same path on two computers is two folders: sharing a laptop folder
 *     shares none of the desktop's records at that path;
 *   - picking a computer covers everything read on it.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  describeMarkedRow,
  expectFilterBoundary,
  filterEditor,
  filterOptions,
  openFilterContext,
  pickTreePath,
  readFilterCorpus,
  startFilterHarness,
  type FilterAccess,
  type FilterContext,
  type FilterCorpus,
  type FilterOption,
} from "./source-filter-corpus.js";
import type { HarnessDevice, SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef } from "@omnesis/types";

const SESSIONS = "claude-code:claude-maya";
const CODEX = "codex:codex-maya";
const PI = "pi:pi-maya";
const FILES = "local-files:files-maya";
const PROJECT_FOLDER = "extra.projectFolder";
const FOLDER = "extra.folder";
const ACCESSES: FilterAccess[] = ["direct", "answer"];

/**
 * The sessions of each folder. "retries" started in /srv/work/billing and
 * stepped into a subfolder, "roaming" started in a work project and moved
 * to a personal one: a session stays with the folder it started in.
 */
const SESSION_WORK = ["atlas", "guide", "billing", "retries", "roaming"];
const PI_WORK = ["atlas", "guide", "billing"];
const FILE_WORK = ["atlas", "guide", "billing"];
const FILE_REST = ["garden", "bench", "inbox"];

describe("folder filters over MCP, from directories on disk to what an agent reads", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  let laptop: HarnessDevice;
  let desktop: HarnessDevice;
  const corpora = new Map<string, FilterCorpus>();
  const failures: string[] = [];

  const corpus = (sourceId: string) => corpora.get(sourceId)!;
  const on = (device: "laptop" | "desktop", keys: readonly string[]) =>
    keys.map((key) => `${key}@${device}`);
  const allOn = (sourceId: string, device: "laptop" | "desktop") =>
    [...corpus(sourceId).records.keys()].filter((key) => key.endsWith(`@${device}`));

  /** A folder of one computer's tree, picked by its path below the computer's top folder. */
  async function pick(
    sourceId: string,
    field: string,
    device: HarnessDevice,
    names: readonly string[],
  ): Promise<FilterOption> {
    const top = await filterOptions(harness, context.portal, sourceId, {
      field,
      device: device.deviceId,
    });
    expect(top.items, `${sourceId} top folders on ${device.deviceId}`).toHaveLength(1);
    const root = top.items[0]!;
    if (names.length === 0) return root;
    let current = root;
    let parentId = (root.ref as { id: string }).id;
    for (const name of names) {
      const page = await filterOptions(harness, context.portal, sourceId, {
        field,
        parentId,
        device: device.deviceId,
      });
      const next = page.items.find((item) => item.shortLabel === name);
      if (!next)
        throw new Error(
          `${current.label} holds no ${name}: ${page.items.map((item) => item.label).join(", ")}`,
        );
      current = next;
      parentId = (next.ref as { id: string }).id;
    }
    return current;
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("folder-filters", model);
    await harness.start();
    harness.onStatusChange((change) => {
      if (change.event === "sync.error")
        failures.push(`${change.sourceId}: ${change.status.lastError ?? "unknown error"}`);
    });
    [laptop, desktop] = harness.devicesForSource(SESSIONS) as [HarnessDevice, HarnessDevice];
    expect(harness.devicesForSource(FILES)).toEqual([laptop, desktop]);
    for (const sourceId of [SESSIONS, FILES])
      for (const device of [laptop, desktop])
        await harness.triggerSyncAndWait(sourceId, 90_000, device);
    for (const sourceId of [CODEX, PI]) await harness.triggerSyncAndWait(sourceId, 90_000);

    const deviceName = new Map([
      [laptop.deviceId, "laptop"],
      [desktop.deviceId, "desktop"],
    ]);
    for (const sourceId of [SESSIONS, FILES, CODEX, PI])
      corpora.set(
        sourceId,
        readFilterCorpus(harness, sourceId, {
          describe: (row) => {
            const described = describeMarkedRow(row);
            if (!described) return null;
            const device = deviceName.get(row.stream_id ?? "");
            if (!device) throw new Error(`A ${sourceId} record was read on no known computer`);
            // Codex and Pi run on the laptop only; their keys name no computer.
            return sourceId === CODEX || sourceId === PI
              ? described
              : { ...described, key: `${described.key}@${device}` };
          },
        }),
      );
    context = await openFilterContext(harness, model);
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("every source read every session or file, on every computer that hosts it", () => {
    expect(failures).toEqual([]);
    const sessions = [...SESSION_WORK, "garden", "bench"];
    expect([...corpus(SESSIONS).records.keys()].sort()).toEqual(
      [...on("laptop", sessions), ...on("desktop", sessions)].sort(),
    );
    expect([...corpus(CODEX).records.keys()].sort()).toEqual([...sessions].sort());
    expect([...corpus(PI).records.keys()].sort()).toEqual([...PI_WORK, "garden", "bench"].sort());
    const files = [...FILE_WORK, ...FILE_REST];
    expect([...corpus(FILES).records.keys()].sort()).toEqual(
      [...on("laptop", files), ...on("desktop", files)].sort(),
    );
  });

  test("on two computers the tree starts at the computers; on one it starts at its folders, and every entry names the computer", async () => {
    const shared = await filterEditor(harness, context.portal, SESSIONS);
    expect(shared).toMatchObject({
      showDeviceLevel: true,
      devices: [
        { id: laptop.deviceId, name: "Invented laptop collector" },
        { id: desktop.deviceId, name: "Invented desktop collector" },
      ],
    });
    expect(shared.fields).toEqual([
      expect.objectContaining({
        field: PROJECT_FOLDER,
        capability: "tree",
        scope: "device",
        noun: { one: "project folder", many: "project folders" },
        state: { status: "ready" },
      }),
    ]);
    const computers = await filterOptions(harness, context.portal, SESSIONS, {
      field: PROJECT_FOLDER,
    });
    // Listed by name.
    expect(computers.items.map((item) => [item.ref, item.label, item.count])).toEqual([
      [
        { capability: "tree", field: PROJECT_FOLDER, id: "", device: desktop.deviceId },
        "Invented desktop collector",
        7,
      ],
      [
        { capability: "tree", field: PROJECT_FOLDER, id: "", device: laptop.deviceId },
        "Invented laptop collector",
        7,
      ],
    ]);
    const viaComputer = await pickTreePath(harness, context.portal, SESSIONS, PROJECT_FOLDER, [
      "Invented desktop collector",
      "/srv",
      "work",
    ]);
    expect(viaComputer).toMatchObject({
      ref: { id: "/srv/work", device: desktop.deviceId },
      label: "/srv/work",
      count: 5,
    });

    const single = await filterEditor(harness, context.portal, CODEX);
    expect(single).toMatchObject({
      showDeviceLevel: false,
      devices: [{ id: laptop.deviceId, name: "Invented laptop collector" }],
    });
    const top = await filterOptions(harness, context.portal, CODEX, { field: PROJECT_FOLDER });
    expect(top.items.map((item) => [item.ref, item.label])).toEqual([
      [{ capability: "tree", field: PROJECT_FOLDER, id: "/srv", device: laptop.deviceId }, "/srv"],
    ]);
    const children = await filterOptions(harness, context.portal, CODEX, {
      field: PROJECT_FOLDER,
      parentId: "/srv",
    });
    expect(Object.fromEntries(children.items.map((item) => [item.shortLabel, item.count]))).toEqual(
      { work: 5, personal: 1, workshop: 1 },
    );
  });

  for (const access of ACCESSES) {
    test(`claude-code ${access}: share only a laptop folder — its sessions at any depth, not /srv/workshop, nothing at that path on the desktop`, async () => {
      const work = await pick(SESSIONS, PROJECT_FOLDER, laptop, ["work"]);
      await expectFilterBoundary(
        context,
        corpus(SESSIONS),
        access,
        "share",
        [work.ref],
        [...on("laptop", SESSION_WORK)],
      );
    });

    test(`claude-code ${access}: hide a desktop folder — the rest of the desktop and the whole laptop stay`, async () => {
      const work = await pick(SESSIONS, PROJECT_FOLDER, desktop, ["work"]);
      await expectFilterBoundary(
        context,
        corpus(SESSIONS),
        access,
        "hide",
        [work.ref],
        [...on("desktop", ["garden", "bench"]), ...allOn(SESSIONS, "laptop")],
      );
    });

    test(`claude-code ${access}: share a computer — everything read on it`, async () => {
      const ref: FilterRef = {
        capability: "tree",
        field: PROJECT_FOLDER,
        id: "",
        device: desktop.deviceId,
      };
      await expectFilterBoundary(
        context,
        corpus(SESSIONS),
        access,
        "share",
        [ref],
        [...allOn(SESSIONS, "desktop")],
      );
    });

    test(`local files ${access}: share only a desktop folder; hide a laptop folder`, async () => {
      const work = await pick(FILES, FOLDER, desktop, ["work"]);
      await expectFilterBoundary(
        context,
        corpus(FILES),
        access,
        "share",
        [work.ref],
        [...on("desktop", FILE_WORK)],
      );
      const personal = await pick(FILES, FOLDER, laptop, ["personal"]);
      await expectFilterBoundary(
        context,
        corpus(FILES),
        access,
        "hide",
        [personal.ref],
        [...on("laptop", [...FILE_WORK, "bench", "inbox"]), ...allOn(FILES, "desktop")],
      );
    });

    test(`local files ${access}: the folder the source reads covers every file, the one at its top included`, async () => {
      const top = await pick(FILES, FOLDER, laptop, []);
      await expectFilterBoundary(
        context,
        corpus(FILES),
        access,
        "share",
        [top.ref],
        [...allOn(FILES, "laptop")],
      );
    });

    test(`Codex ${access}: share only /srv/work on the one computer — not /srv/workshop`, async () => {
      const work = await pickTreePath(harness, context.portal, CODEX, PROJECT_FOLDER, [
        "/srv",
        "work",
      ]);
      expect(work.ref).toEqual({
        capability: "tree",
        field: PROJECT_FOLDER,
        id: "/srv/work",
        device: laptop.deviceId,
      });
      await expectFilterBoundary(context, corpus(CODEX), access, "share", [work.ref], SESSION_WORK);
    });

    test(`Pi ${access}: hide /srv/workshop — /srv/work stays`, async () => {
      const workshop = await pickTreePath(harness, context.portal, PI, PROJECT_FOLDER, [
        "/srv",
        "workshop",
      ]);
      await expectFilterBoundary(
        context,
        corpus(PI),
        access,
        "hide",
        [workshop.ref],
        [...PI_WORK, "garden"],
      );
    });
  }
});
