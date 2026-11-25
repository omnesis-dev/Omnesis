// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DuckDBConnection } from "@duckdb/node-api";

/** A signed desktop library links crypto in; no extension file or network is needed. */
export async function loadStaticEncryptionModule(conn: DuckDBConnection): Promise<boolean> {
  const sql =
    "SELECT installed, install_mode, install_path, loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'";
  const rows = (await conn.runAndReadAll(sql)).getRows();
  const row = rows[0];
  if (rows.length !== 1 || row?.[1] !== "STATICALLY_LINKED") return false;
  if (row[0] !== true || row[2] !== "(BUILT-IN)")
    throw new Error("The built-in analytics crypto module has inconsistent metadata");
  if (row[3] !== true) await conn.run("LOAD httpfs");
  const loaded = (await conn.runAndReadAll(sql)).getRows();
  if (
    loaded.length !== 1 ||
    loaded[0]?.[0] !== true ||
    loaded[0]?.[1] !== "STATICALLY_LINKED" ||
    loaded[0]?.[2] !== "(BUILT-IN)" ||
    loaded[0]?.[3] !== true
  )
    throw new Error("The built-in analytics crypto module did not load");
  return true;
}
