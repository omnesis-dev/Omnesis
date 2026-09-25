// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { activeAccessTokenPredicate } from "./active-access-token.js";

/**
 * The reads of `oauth_access_tokens` that do not decide authority, and why.
 * Anything else that names the table has to carry the shared predicate.
 */
const READS_THAT_DECIDE_NOTHING: Record<string, string> = {
  "access/store-helpers.ts": "mints a token row",
  "access/store-management.ts":
    "resolves a token hash to its credential before revoking that credential",
  "access/store-cleanup.ts": "names the table for expiry cleanup",
  "access/store-preflight.ts":
    "resolves a token hash to the credential that owns it, to authenticate the client revoking it",
  "access/store-credentials.ts":
    "reads a replayed refresh's expiry by hash (the authority read in the same file carries the predicate)",
  "access/agent-device-authorization.ts":
    "reports whether a device's credential still has corpus access; its credential, grant and principal conditions are the LEFT JOINs the row is built from",
  "data/migration-152-access-grants.ts": "creates the table",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("the active access token predicate", () => {
  test("holds the token to its credential, that credential's device, its grant revision and its principal", () => {
    const predicate = activeAccessTokenPredicate();
    for (const clause of [
      "t.revoked_at IS NULL",
      "t.expires_at > @now",
      "c.status = 'active' AND c.revoked_at IS NULL",
      "d.id = c.execution_device_id AND d.revoked_at IS NULL",
      "c.expires_at IS NULL OR c.expires_at > @now",
      "g.revoked_at IS NULL",
      "g.expires_at IS NULL OR g.expires_at > @now",
      "p.revoked_at IS NULL",
      "g.revision = t.grant_revision",
    ]) {
      expect(predicate).toContain(clause);
    }
    expect(
      activeAccessTokenPredicate({ token: "a", credential: "cr", grant: "gr", principal: "pr" }),
    ).toContain("gr.revision = a.grant_revision");
  });

  test("every authority read of the token table carries it; every other read is named here", () => {
    const root = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("oauth_access_tokens")) continue;
      const relative = file.slice(root.length + 1);
      if (relative === "access/active-access-token.ts") continue;
      const usesPredicate = text.includes("activeAccessTokenPredicate(");
      const listed = relative in READS_THAT_DECIDE_NOTHING;
      // A file may do both: one authority read with the predicate beside a
      // hash lookup that decides nothing. A file doing neither is the one
      // this test exists to catch.
      if (!usesPredicate && !listed) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
    for (const listed of Object.keys(READS_THAT_DECIDE_NOTHING)) {
      expect(readFileSync(join(root, listed), "utf8")).toContain("oauth_access_tokens");
    }
  });
});
