// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { validateGithubCommitsCursor, validateGithubThreadsCursor } from "./types.js";

// The pending/snapshot arrays decide what gets materialized and what a
// reconcile sweeps — a malformed slot must reset the cursor (null ⇒ safe
// re-bootstrap) rather than be trusted.
const MALFORMED: unknown[] = [
  { pending: [42] },
  { repos: "x" },
  { snapshotRepos: {} },
  "string",
  // A version-1 cursor mid-snapshot. Its ids cannot be attributed to a
  // repository, so it is refused here and the state migration is what turns it
  // into a cursor with no snapshot in flight.
  { snapshotIds: ["acme/widgets/issues/1"], snapshotMode: true },
  // A ledger the resume would iterate and throw on. Refusing it here is what
  // turns a permanent failure — decode succeeds, the page throws, the same
  // cursor is retried forever — into one re-bootstrap.
  { snapshotRepos: ["acme/widgets"], snapshot: { ids: { "acme/widgets": 42 } } },
  { snapshotRepos: ["acme/widgets"], snapshot: { covered: "acme/widgets" } },
  // A snapshot cycle with no partition list. Every `add` it makes names a
  // repository the enumeration was not opened with, and each one throws.
  { snapshotMode: true, discoveryQueue: ["acme/widgets"] },
];

describe("validateGithubThreadsCursor", () => {
  it("returns null for malformed slots", () => {
    for (const bad of MALFORMED) {
      expect(validateGithubThreadsCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("passes a valid cursor through unchanged", () => {
    const cursor = {
      renderVersion: 1,
      repos: { "acme/widgets": { issuesWm: "2026-04-01T00:00:00Z", issuesAtWm: [7] } },
      pending: ["acme/widgets#1", "acme/widgets#D3"],
      discoveryQueue: ["acme/widgets"],
      snapshotRepos: ["acme/widgets"],
      snapshot: { ids: { "acme/widgets": ["acme/widgets/issues/1"] } },
      snapshotMode: true,
    };
    expect(validateGithubThreadsCursor(cursor)).toBe(cursor);
  });
});

describe("validateGithubCommitsCursor", () => {
  it("returns null for malformed slots", () => {
    for (const bad of MALFORMED) {
      expect(validateGithubCommitsCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("passes a valid cursor through unchanged", () => {
    const cursor = {
      renderVersion: 1,
      repos: { "acme/widgets": { wm: "2026-04-01T00:00:00Z", knownShas: ["a1b2c3d4e5f6"] } },
      pending: [`acme/widgets@${"a".repeat(40)}`],
      lastSnapshotAt: "2026-05-01T00:00:00Z",
    };
    expect(validateGithubCommitsCursor(cursor)).toBe(cursor);
  });
});
