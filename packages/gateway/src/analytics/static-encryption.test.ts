// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { loadStaticEncryptionModule } from "./static-encryption.js";
import type { DuckDBConnection } from "@duckdb/node-api";

function fixture(before: unknown[][], after = before) {
  const run = vi.fn().mockResolvedValue(undefined);
  const runAndReadAll = vi
    .fn()
    .mockResolvedValueOnce({ getRows: () => before })
    .mockResolvedValueOnce({ getRows: () => after });
  return { run, conn: { run, runAndReadAll } as unknown as DuckDBConnection };
}

test("only the engine's statically linked built-in qualifies, not a local repository extension", async () => {
  for (const rows of [
    [],
    [[true, "REPOSITORY", "/invented/httpfs", true]],
    [[false, "NOT_INSTALLED", "", false]],
  ]) {
    const f = fixture(rows);
    expect(await loadStaticEncryptionModule(f.conn)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  }
});

test("loads and rechecks the built-in without INSTALL or a path", async () => {
  const f = fixture(
    [[true, "STATICALLY_LINKED", "(BUILT-IN)", false]],
    [[true, "STATICALLY_LINKED", "(BUILT-IN)", true]],
  );
  expect(await loadStaticEncryptionModule(f.conn)).toBe(true);
  expect(f.run.mock.calls).toEqual([["LOAD httpfs"]]);
});

test("inconsistent or ineffective built-in crypto refuses rather than falling back", async () => {
  const bad = fixture([[true, "STATICALLY_LINKED", "/invented/not-built-in", false]]);
  await expect(loadStaticEncryptionModule(bad.conn)).rejects.toThrow("inconsistent");
  expect(bad.run).not.toHaveBeenCalled();
  const inactive = fixture([[true, "STATICALLY_LINKED", "(BUILT-IN)", false]]);
  await expect(loadStaticEncryptionModule(inactive.conn)).rejects.toThrow("did not load");
});
