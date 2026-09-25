// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Argument parsing for `npm run briefs:scorecard` — kept pure and apart
 * from the CLI entry so it unit-tests without pulling the harness in.
 */

// eslint-disable-next-line no-restricted-imports -- evals tooling reaches into the collector e2e kit; evals/briefs is not a workspace package, so there is no package-name path to it
import { FROZEN_ARC_SEED } from "../../../packages/collector/src/e2e/briefs-arcs.js";

export interface ScorecardArgs {
  backend: "scripted" | "deepseek";
  /** Scripted-lane behavior table (instrument validation). */
  script: "perfect" | "saboteur";
  seed: number;
  /** Iteration label embedded in the report + ledger row. */
  iter: string;
  /** Output path for scorecard.json, relative to the repo root. */
  out: string;
  /** Deepseek-lane model id override (defaults to the price sheet's model). */
  model: string | null;
}

const USAGE =
  "usage: briefs:scorecard [--backend scripted|deepseek] [--script perfect|saboteur] " +
  "[--seed <n>] [--iter <label>] [--out <path>] [--model <id>]";

export function parseScorecardArgs(argv: readonly string[]): ScorecardArgs {
  const args: ScorecardArgs = {
    backend: "scripted",
    script: "perfect",
    seed: FROZEN_ARC_SEED,
    iter: "-",
    out: "evals/briefs/scorecard.json",
    model: null,
  };
  let scriptGiven = false;
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} requires a value (${USAGE})`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    switch (flag) {
      case "--backend": {
        const value = take(i, flag);
        if (value !== "scripted" && value !== "deepseek") {
          throw new Error(`--backend must be scripted or deepseek, got "${value}"`);
        }
        args.backend = value;
        break;
      }
      case "--script": {
        const value = take(i, flag);
        if (value !== "perfect" && value !== "saboteur") {
          throw new Error(`--script must be perfect or saboteur, got "${value}"`);
        }
        args.script = value;
        scriptGiven = true;
        break;
      }
      case "--seed": {
        const value = Number.parseInt(take(i, flag), 10);
        if (!Number.isFinite(value)) throw new Error(`--seed must be an integer`);
        args.seed = value;
        break;
      }
      case "--iter":
        args.iter = take(i, flag);
        break;
      case "--out":
        args.out = take(i, flag);
        break;
      case "--model":
        args.model = take(i, flag);
        break;
      default:
        throw new Error(`unknown argument: ${flag} (${USAGE})`);
    }
  }
  if (args.backend === "deepseek" && scriptGiven) {
    throw new Error("--script is a scripted-lane switch (instrument validation only)");
  }
  return args;
}
