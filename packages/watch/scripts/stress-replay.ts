#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Provoke the native crash that killed a sweep, or fail to and say so.
 *
 *   npx tsx packages/watch/scripts/stress-replay.ts [--rounds 200] [--workers 6]
 *
 * A long evaluation run died with `free(): corrupted unsorted chunks` — a glibc
 * heap error, which is a fact about native memory rather than about JavaScript.
 * Nothing in this package allocates natively except the analytics database, and
 * a replay opens one, queries it and closes it. A sweep of three hundred and
 * fifty attempts does that several thousand times, six at a time.
 *
 * So this does the same thing, harder and with nothing else running: repeated
 * open/query/close cycles across concurrent workers. If the crash is in that
 * cycle it should surface here, where the process is doing nothing else and the
 * failure cannot be attributed to a model provider or a scorer.
 *
 * The exit code is the result. Zero means the cycle survived the round count —
 * which is evidence and not proof, and the run prints how much it did so the
 * strength of that evidence is legible rather than implied.
 */

import { watchNames } from "../src/backtest/golden.js";
import { loadWatch } from "../src/runtime/run.js";
import { behaviourOf } from "../src/eval/score.js";

interface Args {
  readonly rounds: number;
  readonly workers: number;
}

function parse(argv: readonly string[]): Args {
  const args = { rounds: 200, workers: 6 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = Number(argv[i + 1]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${argv[i]} needs a whole number above zero`);
    }
    if (argv[i] === "--rounds") args.rounds = value;
    else if (argv[i] === "--workers") args.workers = value;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  return args;
}

async function main(): Promise<void> {
  const { rounds, workers } = parse(process.argv.slice(2));
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const corpus = watchNames();

  out(`${workers} workers × ${rounds} rounds — full replays over ${corpus.length} watches`);
  const started = process.hrtime.bigint();
  let done = 0;

  const worker = async (index: number): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      // A whole replay, not an open and a close: the crash landed in a run that
      // was replaying watches over the full journal, and the queries a replay
      // issues are where the native library does its work.
      const name = corpus[(index * rounds + round) % corpus.length]!;
      await behaviourOf(loadWatch(name), { reference: name });
      done += 1;
      if (done % 25 === 0) {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        out(`  ${done}/${rounds * workers} replays (${(done / seconds).toFixed(1)}/s)`);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)));

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  out(`survived ${rounds * workers} replays in ${seconds.toFixed(1)}s`);
}

await main();
