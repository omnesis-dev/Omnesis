// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source being removed has no `sources` row left to render from — the
 * gateway deletes it up front so the source stops syncing — so the list builds
 * its row from the pending-removal entry instead.
 *
 * The regression this guards is the row vanishing the moment removal is
 * accepted: the operator sees the source disappear while its documents are
 * still being deleted, and a page refresh mid-purge shows a source list that
 * disagrees with the document counts.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { buildRemovalRows, mergeRemovalRows } from "./sources.js";

const PENDING = [
  { id: "gmail:maya.reeves@example.com", type: "gmail", accountId: "maya.reeves@example.com" },
];

describe("buildRemovalRows", () => {
  test("marks the row as removing so the renderer can say so", () => {
    const [row] = buildRemovalRows(PENDING);
    expect(row.id).toBe("gmail:maya.reeves@example.com");
    expect(row.type).toBe("gmail");
    expect(row.removing).toBe(true);
  });

  test("does not present it as paused", () => {
    // `enabled: false` renders a "paused" tag, which would read as a source
    // the operator could resume — the opposite of what is happening.
    expect(buildRemovalRows(PENDING)[0].enabled).toBe(true);
  });

  test("claims no sync state or device, and leaves counts to the shared pass", () => {
    // The device and sync state are joined from a `sources` row that no longer
    // exists, so inventing them would show stale values as current. Counts are
    // the opposite case: they come from `/status`, are still real while the
    // purge drains, and the enrichment pass fills them in — so this row must
    // NOT pin them to null, or watching them fall would be impossible.
    const [row] = buildRemovalRows(PENDING);
    expect(row.syncStatus).toBeNull();
    expect(row.deviceId).toBeNull();
    expect(row.deviceName).toBeNull();
    expect(row).not.toHaveProperty("displayCount");
  });

  test("is empty when nothing is being removed", () => {
    expect(buildRemovalRows([])).toEqual([]);
    expect(buildRemovalRows(undefined)).toEqual([]);
  });
});

describe("merging removal rows into the live list", () => {
  // These call the real `mergeRemovalRows` from the view. A local
  // re-implementation would stay green through the very bug it names.
  function liveRow(id: string) {
    return new Map([[id, { id, removing: undefined }]]);
  }

  test("a live source of the same id wins over a stale tombstone", () => {
    // Re-registering a source cancels the rest of its purge, so when an id
    // appears both live and pending the tombstone is the stale half. Letting
    // it win would render an active source as being deleted.
    const byId = liveRow("gmail:maya.reeves@example.com");
    mergeRemovalRows(byId, PENDING);
    expect(byId.size).toBe(1);
    expect(byId.get("gmail:maya.reeves@example.com").removing).toBeUndefined();
  });

  test("a removal with no live source is added to the list", () => {
    const byId = liveRow("notion:jamie.lopez@example.org");
    mergeRemovalRows(byId, PENDING);
    expect(byId.size).toBe(2);
    expect(byId.get("gmail:maya.reeves@example.com").removing).toBe(true);
  });

  test("returns the same map it was handed, so it composes with the rest of the merge", () => {
    const byId = new Map();
    expect(mergeRemovalRows(byId, PENDING)).toBe(byId);
  });

  test("nothing pending leaves the list untouched", () => {
    const byId = liveRow("gmail:maya.reeves@example.com");
    mergeRemovalRows(byId, []);
    expect(byId.size).toBe(1);
  });
});
