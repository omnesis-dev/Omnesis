// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Same corpus layout as the study tools' existing HOME override. */
export function defaultCorpusDbPath(): string {
  return join(process.env.HOME || homedir(), ".config", "omnesis", "omnesis.db");
}
export function defaultComparisonOutputPath(): string {
  return join(tmpdir(), "near-dupes-study", "comparison.md");
}
