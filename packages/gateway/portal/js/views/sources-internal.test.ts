// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  buildInternalRows,
  mergeInternalRows,
  showLegacyMigrationBanner,
  sourceActionMenuItems,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./sources.js";

type MenuItem = { action: string; label: string };

describe("internal source menu", () => {
  test("offers only See recent — no sync, pause, debug, resync or remove", () => {
    const items = sourceActionMenuItems({ internal: true }) as MenuItem[];
    expect(items.map((item: MenuItem) => item.label)).toEqual(["See recent"]);
    expect(items[0]?.action).toBe("recent");
  });

  test("the internal gate wins over every action-enabling flag", () => {
    const items = sourceActionMenuItems({
      internal: true,
      paused: false,
      canManualSync: true,
      canImport: true,
      importLabel: "Import full history",
      multiDevice: true,
      canJoin: true,
      canDetach: true,
      resyncPerDevice: true,
    }) as MenuItem[];
    expect(items).toEqual([{ action: "recent", label: "See recent" }]);
  });

  test("regular sources keep the full menu", () => {
    const labels = (sourceActionMenuItems() as MenuItem[]).map((item: MenuItem) => item.label);
    expect(labels).toContain("Sync");
    expect(labels).toContain("Remove");
  });
});

describe("internal source rows", () => {
  test("builds a deviceless row carrying the enrichment fields", () => {
    const rows = buildInternalRows([{ id: "omnesis-notes" }]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "omnesis-notes",
        // No descriptor or provider account exists for internal sources,
        // so the id doubles as the type/account key (as on iOS/Android).
        type: "omnesis-notes",
        accountId: "omnesis-notes",
        deviceId: null,
        deviceName: "Gateway",
        members: [],
        multiDeviceMode: "exclusive",
        enabled: true,
        removing: false,
        internal: true,
        syncStatus: null,
      }),
    ]);
  });

  test("tolerates a missing payload", () => {
    expect(buildInternalRows(undefined)).toEqual([]);
    expect(buildInternalRows(null)).toEqual([]);
  });

  test("drops entries without a usable id", () => {
    expect(buildInternalRows([{ id: "" }, null, { noId: true }])).toEqual([]);
  });

  test("never shadows a registered row of the same id", () => {
    const live = { id: "omnesis-notes", registered: true };
    const byId = new Map([[live.id, live]]);
    mergeInternalRows(byId, [{ id: "omnesis-notes" }]);
    expect(byId.get("omnesis-notes")).toBe(live);
  });

  test("adds the internal row when no registered row exists", () => {
    const byId = new Map();
    mergeInternalRows(byId, [{ id: "omnesis-notes" }]);
    expect(byId.get("omnesis-notes")).toMatchObject({ id: "omnesis-notes", internal: true });
  });
});

describe("legacy migration banner", () => {
  test("a fresh install with only the internal Notes row sees no banner", () => {
    expect(
      showLegacyMigrationBanner({ registeredCount: 0 }, [
        { id: "omnesis-notes", internal: true, removing: false },
      ]),
    ).toBe(false);
  });

  test("a live registered row still triggers it", () => {
    expect(
      showLegacyMigrationBanner({ registeredCount: 0 }, [
        { id: "gmail:a@example.com", removing: false },
        { id: "omnesis-notes", internal: true, removing: false },
      ]),
    ).toBe(true);
  });

  test("removing rows and registered gateways never trigger it", () => {
    expect(
      showLegacyMigrationBanner({ registeredCount: 0 }, [
        { id: "gmail:a@example.com", removing: true },
      ]),
    ).toBe(false);
    expect(
      showLegacyMigrationBanner({ registeredCount: 2 }, [
        { id: "gmail:a@example.com", removing: false },
      ]),
    ).toBe(false);
    expect(showLegacyMigrationBanner(null, [])).toBe(false);
  });
});
