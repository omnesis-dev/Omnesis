// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as nativePaths from "node:path";

/** Lexical containment after the caller has resolved filesystem identities. */
export function pathIsInside(
  child: string,
  parent: string,
  paths: Pick<typeof nativePaths, "relative" | "isAbsolute" | "sep"> = nativePaths,
): boolean {
  const rel = paths.relative(parent, child);
  return (
    rel === "" || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${paths.sep}`))
  );
}
