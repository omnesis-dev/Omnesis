// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Locating a watch universe on disk.
 *
 * A universe is a self-contained fixture directory holding the ontology
 * snapshot the validator checks against, the example watches, and the
 * invalid-DSL goldens. It is the only substrate this package has: there is no
 * live gateway to fall back on, by construction.
 *
 * Paths resolve relative to the package root so they work identically under tsx
 * (where this file is `src/universe/paths.ts`) and compiled (`dist/universe/…`)
 * — both sit one level below the package root.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ontology } from "../ontology/snapshot.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The universe shipped with the package. */
export const POC_UNIVERSE = "poc";

/** A universe name is a single directory name, never a path. */
const UNIVERSE_NAME = /^[a-z][a-z0-9-]*$/;

export function universeDir(universe: string = POC_UNIVERSE): string {
  if (!UNIVERSE_NAME.test(universe)) {
    throw new Error(
      `'${universe}' is not a universe name. A universe is a directory under universes/, so the name is lowercase letters, digits and hyphens — never a path.`,
    );
  }
  return join(PACKAGE_ROOT, "universes", universe);
}

export function ontologyPath(universe: string = POC_UNIVERSE): string {
  return join(universeDir(universe), "ontology.json");
}

/** Read and validate a universe's ontology snapshot. */
export function loadOntology(universe: string = POC_UNIVERSE): Ontology {
  const path = ontologyPath(universe);
  return Ontology.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function journalPath(universe: string = POC_UNIVERSE): string {
  return join(universeDir(universe), "journal.jsonl");
}

export function analyticsDir(universe: string = POC_UNIVERSE): string {
  return join(universeDir(universe), "analytics");
}
