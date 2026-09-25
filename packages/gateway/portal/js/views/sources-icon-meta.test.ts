// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { sourceMetaRefresh } from "./sources.js";

type Row = { id: string; internal?: boolean; syncStatus?: { lastSyncAt?: string } | null };

const resolvesAll = () => true;
const synced = (id: string): Row => ({ id, syncStatus: { lastSyncAt: "2026-01-05T10:00:00Z" } });
const unsynced = (id: string): Row => ({ id, syncStatus: null });

describe("sources icon meta refresh", () => {
  test("a source seen synced for the first time re-fetches once", () => {
    // Its own icon (a bank's logo under an aggregator) is recorded on its
    // first sync, after adding the source refreshed the cache; until a re-fetch the
    // row kept its source type's icon.
    const first = sourceMetaRefresh([unsynced("bank-accounts:acme")], null, resolvesAll);
    expect(first.refresh).toBe(false);

    const second = sourceMetaRefresh([synced("bank-accounts:acme")], first.covered, resolvesAll);
    expect(second.refresh).toBe(true);

    const third = sourceMetaRefresh([synced("bank-accounts:acme")], second.covered, resolvesAll);
    expect(third.refresh).toBe(false);
  });

  test("sources already synced when the page loaded do not re-fetch", () => {
    const first = sourceMetaRefresh([synced("notes:local")], null, resolvesAll);
    expect(first.refresh).toBe(false);
  });

  test("a row the cache cannot resolve re-fetches; an internal one never does", () => {
    const none = () => false;
    expect(sourceMetaRefresh([unsynced("notes:local")], new Set(), none).refresh).toBe(true);
    expect(
      sourceMetaRefresh([{ id: "omnesis-notes", internal: true, syncStatus: null }], new Set(), none)
        .refresh,
    ).toBe(false);
  });
});
