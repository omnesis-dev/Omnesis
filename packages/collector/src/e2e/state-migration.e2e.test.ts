// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * An installed cursor, carried forward by a real gateway.
 *
 * The unit tests either side of this seam are thorough and neither of them
 * crosses it: a provider's own suite drives the decorator over a value it
 * hands itself, and the SDK's suite drives the resolver over a value with no
 * source attached. Between them sits the part an upgrade actually exercises —
 * a value that was written to `sync_state` by an older build, read back
 * through the gateway, resolved, migrated, and written back enveloped.
 *
 * So this plants the old value where an upgrade would find it, via the same
 * route a collector uses to store one, and then runs a real sync against a
 * real gateway and looks at what is in the row afterwards.
 *
 * The source is the Things double, which declares its own state — deliberately
 * not the real source's, because a real decoder refuses the cursor a double
 * writes. Its migration is a field rename, `index` to `offset`, which is the
 * commonest migration there is and the one where a wrong decoder is silent:
 * accepting both spellings marks the old shape as current and resumes from a
 * field that is not there, which looks exactly like a source with nothing new.
 */
describe("state migration — an installed cursor through a real gateway", () => {
  let harness: SyntheticE2EHarness;
  const SOURCE = "things:local";

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  /**
   * Write a cursor the way a collector does, so the row is the one an upgrade
   * meets — and read it back, because a plant that silently landed somewhere
   * else turns every assertion after it into a statement about the wrong row.
   */
  /**
   * Write the row on disk, which is where an upgrade actually finds one.
   *
   * The HTTP route is the wrong instrument here twice over: it fences cursor
   * writes on the write epoch, and it resolves *which* row to write from the
   * caller's identity — so a plant posted by the test lands somewhere the
   * collector does not read, reports success, and leaves every assertion after
   * it describing a row nobody wrote. An installed cursor is a row in
   * `sync_state`; this puts one there.
   */
  function plantCursor(cursor: Record<string, unknown>): void {
    const db = new Database(harness.getDbPath());
    try {
      const encoded = JSON.stringify(cursor);
      // Every row for this source, so the plant cannot miss the one the
      // collector reads because the two disagree about device scoping. Before
      // the first sync there is no row at all — which is also the state a
      // freshly upgraded install is in — so insert one.
      const changed = db
        .prepare("UPDATE sync_state SET cursor = ? WHERE source_id = ?")
        .run(encoded, SOURCE).changes;
      if (changed === 0) {
        db.prepare("INSERT INTO sync_state (source_id, device_id, cursor) VALUES (?, '', ?)").run(
          SOURCE,
          encoded,
        );
      }
    } finally {
      db.close();
    }
  }

  async function storedCursor(): Promise<Record<string, unknown> | null> {
    const state = await harness.getSyncState(SOURCE);
    return (state?.cursor ?? null) as Record<string, unknown> | null;
  }

  /** How many documents the source currently has stored, read from the gateway's own db. */
  function documentCount(): number {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
        .get(SOURCE);
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  }

  test("a pre-envelope cursor is migrated, not mistaken for a first run", async () => {
    // What the older build left behind: the position under its own spelling,
    // unwrapped, because envelopes did not exist when it was written.
    plantCursor({ index: 2 });

    await harness.triggerSyncAndWait(SOURCE, 60000);

    const after = await storedCursor();
    // The row now holds an envelope stamped with the current version, and the
    // position survived the rename rather than restarting at nothing.
    expect(after).toMatchObject({ e: 1, v: 2, s: SOURCE });
    expect((after as { state?: { offset?: number } }).state?.offset).toBeGreaterThanOrEqual(2);
  });

  test("the run after a migration resumes from the envelope instead of migrating again", async () => {
    const before = await storedCursor();
    expect(before).toMatchObject({ e: 1, v: 2 });

    await harness.triggerSyncAndWait(SOURCE, 60000);

    const after = await storedCursor();
    // Still an envelope at the same version: a second migration would mean the
    // decoder rejects what the source itself just wrote, which is the failure
    // that quietly demotes a source to its oldest generation on every page.
    expect(after).toMatchObject({ e: 1, v: 2, s: SOURCE });
  });

  test("an envelope stamped for another source is refused, and the row is left alone", async () => {
    // Cursors are per source. One belonging to another source is not a value
    // to resume from and not one to discard either — refusing leaves it for
    // whoever can read it.
    const planted = { e: 1, v: 2, s: "things:someone-else", state: { offset: 1 } };
    plantCursor(planted);

    await harness.triggerSyncAndWait(SOURCE, 60000).catch(() => undefined);

    expect(await storedCursor()).toEqual(planted);
  });

  test("an envelope from a newer build is refused rather than discarded", async () => {
    // A downgrade meets state it cannot read. Starting over would re-walk the
    // upstream; worse, it would overwrite a bookmark the newer build can still
    // use if the operator rolls forward again.
    const planted = { e: 1, v: 99, s: SOURCE, state: { offset: 1 } };
    plantCursor(planted);

    await harness.triggerSyncAndWait(SOURCE, 60000).catch(() => undefined);

    expect(await storedCursor()).toEqual(planted);
  });

  test("an unreadable cursor starts the source over, and the corpus comes back", async () => {
    // This source's upstream is re-readable in full, so its declaration says
    // to start over. The proof that this is recovery and not loss is the
    // corpus afterwards.
    plantCursor({ offset: "not a number" });

    await harness.triggerSyncAndWait(SOURCE, 60000);

    const after = await storedCursor();
    expect(after).toMatchObject({ e: 1, v: 2, s: SOURCE });
    expect(documentCount()).toBeGreaterThan(0);
  });
});
