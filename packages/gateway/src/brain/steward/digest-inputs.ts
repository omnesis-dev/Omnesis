// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listBriefs } from "../storage/briefs.js";
import { readDueSoonDeltaPrime } from "./delta-prime.js";
import { renderDigestHorizonLines, type DigestHorizon } from "./digest-horizon.js";
import type { ResolvedBrainSettings } from "../config.js";
import type Database from "better-sqlite3";

/** Display cap for recent briefs in the digest prompt. */
const DIGEST_RECENT_BRIEFS_MAX = 12;

/** The actual editorial input packet; empty storage is not an all-clear finding. */
export function readDigestInputs(
  db: Database.Database,
  now: number,
  cfg: ResolvedBrainSettings,
  horizon: DigestHorizon,
) {
  const horizonLines = renderDigestHorizonLines(horizon);
  const overnightLines = listBriefs(db, { limit: 50 })
    .filter((b) => b.createdAt >= now - 24 * 3_600_000)
    .slice(0, DIGEST_RECENT_BRIEFS_MAX)
    .map((b) => `- [${b.state}] ${b.title}`);
  const prime = readDueSoonDeltaPrime(db, { now, cfg });
  return {
    horizonLines,
    overnightLines,
    deltaPrime: prime.text,
    hasInputs: horizonLines.length > 0 || overnightLines.length > 0 || prime.hasInputs,
  };
}
