// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Forward-looking consent-expiry persistence (#927). A source reports its
// consent deadline on each successful page via `setSyncState`'s
// `consentExpiresAt` argument; the gateway persists it on `sync_state` so it
// survives a gateway restart (the warning is re-derived from the row, not from
// transient in-memory state). The undefined-vs-null distinction is load-bearing:
//   - `undefined` → leave the stored deadline unchanged (a source with no known
//     deadline calls `setSyncState` every page and must not clobber a deadline a
//     sibling phase reported earlier in the same sync),
//   - an explicit string → set it,
//   - explicit `null` → clear it (re-consent that no longer expires).

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { setSyncState, getSyncState } from "./SyncStateRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
const SRC = "plaid:item-abc";

beforeEach(() => {
  dbPath = `/tmp/omnesis-syncstate-consent-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("setSyncState — consent_expires_at persistence (#927)", () => {
  test("an explicit deadline is persisted and read back", () => {
    const deadline = "2026-09-01T00:00:00.000Z";
    setSyncState(db, SRC, { phase: "incremental" }, undefined, deadline);
    expect(getSyncState(db, SRC)?.consent_expires_at).toBe(deadline);
  });

  test("the deadline survives a fresh DB handle (restart) — it lives on the row", () => {
    const deadline = "2026-09-01T00:00:00.000Z";
    setSyncState(db, SRC, { phase: "incremental" }, undefined, deadline);
    db.close();
    // Re-open the same file as a brand-new process would after a restart.
    const reopened = createDatabase(dbPath);
    try {
      expect(getSyncState(reopened, SRC)?.consent_expires_at).toBe(deadline);
    } finally {
      reopened.close();
    }
    // Re-open for the afterEach close()/unlink to operate on a live handle.
    db = createDatabase(dbPath);
  });

  test("undefined leaves a previously-stored deadline unchanged", () => {
    const deadline = "2026-09-01T00:00:00.000Z";
    setSyncState(db, SRC, { phase: "snapshot-balances" }, undefined, deadline);
    // A later phase in the same pass reports no deadline (undefined) — must keep.
    setSyncState(db, SRC, { phase: "transactions" }, undefined, undefined);
    expect(getSyncState(db, SRC)?.consent_expires_at).toBe(deadline);
  });

  test("explicit null clears a previously-stored deadline (re-consent no longer expires)", () => {
    setSyncState(db, SRC, { phase: "incremental" }, undefined, "2026-09-01T00:00:00.000Z");
    setSyncState(db, SRC, { phase: "incremental" }, undefined, null);
    expect(getSyncState(db, SRC)?.consent_expires_at).toBeNull();
  });

  test("a later deadline overrides an earlier one (consent window moved out)", () => {
    setSyncState(db, SRC, { phase: "incremental" }, undefined, "2026-07-01T00:00:00.000Z");
    setSyncState(db, SRC, { phase: "incremental" }, undefined, "2026-12-01T00:00:00.000Z");
    expect(getSyncState(db, SRC)?.consent_expires_at).toBe("2026-12-01T00:00:00.000Z");
  });

  test("a source that never reports a deadline stores NULL (no spurious value)", () => {
    setSyncState(db, SRC, { phase: "incremental" });
    expect(getSyncState(db, SRC)?.consent_expires_at).toBeNull();
  });
});
