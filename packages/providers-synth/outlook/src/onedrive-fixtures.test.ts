// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { DeltaExpiredError } from "@omnesis/provider-outlook";
import { resolvePerson } from "@omnesis/providers-synth-common";
import {
  loadOneDriveItems,
  resetOneDriveFixtureCache,
  syntheticOneDriveGraph,
  type OneDriveItemEntry,
} from "./onedrive-fixtures.js";
import type { DriveDeltaResponse } from "@omnesis/provider-outlook";

/**
 * Direct, gateway-free coverage of the synthetic OneDrive Graph backend. The
 * full sync path through a real gateway is proved by
 * `packages/collector/src/e2e/onedrive.e2e.test.ts`; this asserts the fake
 * transport's contract (delta pages, deletion tombstones, forced 410, content
 * bump) in isolation so the E2E's preconditions are pinned without booting a
 * gateway.
 */

const DELETE = "OMNESIS_ONEDRIVE_SYNTH_DELETE";
const EXPIRE = "OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA";
const REWALK = "OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE";

let items: OneDriveItemEntry[];

beforeAll(() => {
  // The fixtures load from the active universe; e2e-minimal carries the
  // onedrive corpus this twin was authored against.
  process.env.OMNESIS_SYNTH_UNIVERSE = "e2e-minimal";
  resetOneDriveFixtureCache();
  items = loadOneDriveItems();
});

afterEach(() => {
  delete process.env[DELETE];
  delete process.env[EXPIRE];
  delete process.env[REWALK];
});

describe("syntheticOneDriveGraph", () => {
  test("the fixture corpus loads with the expected files", () => {
    expect(items.map((i) => i.externalId).sort()).toEqual([
      "onedrive-file-001",
      "onedrive-file-002",
      "onedrive-file-003",
    ]);
  });

  test("the bootstrap root returns every file plus a deltaLink", async () => {
    const graph = syntheticOneDriveGraph(items);
    const page = await graph.get<DriveDeltaResponse>("/me/drive/root/delta?$top=100");
    expect(page.value.map((i) => i.id).sort()).toEqual([
      "onedrive-file-001",
      "onedrive-file-002",
      "onedrive-file-003",
    ]);
    expect(page["@odata.deltaLink"]).toBeDefined();
    // driveItem shape: file facet + parentReference path the source strips.
    const first = page.value[0];
    expect(first.file?.mimeType).toBe("text/markdown");
    expect(first.parentReference?.path).toContain("/drive/root:");
  });

  test("a shared file carries a sharedBy identity with a resolved email", async () => {
    const graph = syntheticOneDriveGraph(items);
    const page = await graph.get<DriveDeltaResponse>("/me/drive/root/delta?$top=100");
    const shared = page.value.find((i) => i.id === "onedrive-file-003");
    // The shared email resolves from the cast (the `sharedBy: "p_jane"` ref in
    // the fixture), not a literal — so the assertion tracks the active
    // universe's cast rather than restating a raw address here.
    const expectedEmail = resolvePerson("p_jane").emails[0];
    expect(shared?.shared?.sharedBy?.user?.email).toBe(expectedEmail);
  });

  test("an incremental tick (deltaLink) is empty by default", async () => {
    const graph = syntheticOneDriveGraph(items);
    const page = await graph.get<DriveDeltaResponse>(
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=synth-onedrive-delta",
    );
    expect(page.value).toHaveLength(0);
    expect(page["@odata.deltaLink"]).toBeDefined();
  });

  test("the DELETE switch tombstones the file on the next incremental tick", async () => {
    process.env[DELETE] = "onedrive-file-002";
    const graph = syntheticOneDriveGraph(items);
    const page = await graph.get<DriveDeltaResponse>(
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=synth-onedrive-delta",
    );
    expect(page.value).toHaveLength(1);
    expect(page.value[0].id).toBe("onedrive-file-002");
    expect(page.value[0].deleted).toBeDefined();
  });

  test("the EXPIRE switch throws a 410 on the deltaLink fetch", async () => {
    process.env[EXPIRE] = "1";
    const graph = syntheticOneDriveGraph(items);
    await expect(
      graph.get<DriveDeltaResponse>(
        "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=synth-onedrive-delta",
      ),
    ).rejects.toBeInstanceOf(DeltaExpiredError);
    // The fresh re-enumeration (no token) still succeeds — the re-walk's path.
    const fresh = await graph.get<DriveDeltaResponse>("/me/drive/root/delta?$top=100");
    expect(fresh.value.length).toBeGreaterThan(0);
  });

  test("the re-walk enumeration honors DELETE (file absent) and bumps one file", async () => {
    process.env[DELETE] = "onedrive-file-002";
    process.env[REWALK] = "onedrive-file-001";
    const graph = syntheticOneDriveGraph(items);
    const fresh = await graph.get<DriveDeltaResponse>("/me/drive/root/delta?$top=100");
    // The deleted file is gone from the fresh enumeration.
    expect(fresh.value.map((i) => i.id).sort()).toEqual(["onedrive-file-001", "onedrive-file-003"]);
    // The bumped file's eTag changed so the source's fingerprint detects it.
    const bumped = fresh.value.find((i) => i.id === "onedrive-file-001");
    expect(bumped?.eTag).toContain("-v2");
    // Its content bytes carry the bump too.
    const bytes = await graph.getBytes("/me/drive/items/onedrive-file-001/content");
    expect(new TextDecoder().decode(bytes)).toContain("-v2");
  });

  test("getBytes returns the file's content bytes, empty for an unknown id", async () => {
    const graph = syntheticOneDriveGraph(items);
    const bytes = await graph.getBytes("/me/drive/items/onedrive-file-002/content");
    expect(new TextDecoder().decode(bytes)).toContain("Marathon Training Plan");
    expect((await graph.getBytes("/me/drive/items/nope/content")).length).toBe(0);
  });
});
