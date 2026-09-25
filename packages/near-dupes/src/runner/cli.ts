#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { defineCommand, runMain } from "citty";
import { CorpusReader, DEFAULT_INCLUDE_TYPES } from "../corpus/reader.js";
import { DupeStore, defaultDupeDbPath } from "../store/repository.js";
import {
  DEFAULT_CONFIG,
  IDF_CONFIG,
  IDF_EXCL_CONFIG,
  type NearDupeConfig,
  type WeightingMode,
} from "../algo/index.js";
import { NearDupeRunner } from "./runner.js";

const HOME = process.env.HOME ?? "";
const DEFAULT_OMNESIS_DB = `${HOME}/.config/omnesis/omnesis.db`;

const run = defineCommand({
  meta: {
    name: "run",
    description: "Bootstrap near-duplicate signatures and verified pairs over the corpus.",
  },
  args: {
    omnesisDb: {
      type: "string",
      description: "Path to the live Omnesis SQLite (read-only).",
      default: DEFAULT_OMNESIS_DB,
    },
    dupesDb: {
      type: "string",
      description: "Path to the side DB for signatures + pairs.",
      default: defaultDupeDbPath(),
    },
    shingleSize: { type: "string", default: String(DEFAULT_CONFIG.shingleSize) },
    numHashes: { type: "string", default: String(DEFAULT_CONFIG.numHashes) },
    bands: { type: "string", default: String(DEFAULT_CONFIG.bands) },
    rows: { type: "string", default: String(DEFAULT_CONFIG.rows) },
    recordThreshold: {
      type: "string",
      description: "Persist verified pairs with exact Jaccard ≥ this value.",
      default: "0.5",
    },
    maxCandidates: {
      type: "string",
      description: "Hard cap on candidates verified per document.",
      default: "500",
    },
    types: {
      type: "string",
      description: "Comma-separated documentType include list.",
      default: [...DEFAULT_INCLUDE_TYPES].join(","),
    },
    minContentLength: { type: "string", default: "200" },
    maxContentLength: { type: "string", default: "2000000" },
    algoVersion: {
      type: "string",
      description: "Overrides the auto-picked version string for the given weighting.",
      default: "",
    },
    weighting: {
      type: "string",
      description: "uniform (vanilla MinHash) or idf (Ioffe ICWS weighted MinHash).",
      default: "uniform",
    },
    exclusivity: {
      type: "boolean",
      description: "Record per-pair exclusivity (df ≤ 2 / 5) counts at verification time.",
      default: false,
    },
    maxIdfWeight: { type: "string", default: "8.0" },
    stripQuotes: { type: "boolean", default: true },
    skipExisting: { type: "boolean", default: true },
  },
  async run({ args }) {
    const weighting = args.weighting as WeightingMode;
    if (weighting !== "uniform" && weighting !== "idf") {
      throw new Error(`unknown weighting: ${weighting}`);
    }
    const baseAlgo =
      weighting === "idf"
        ? args.exclusivity
          ? IDF_EXCL_CONFIG.algoVersion
          : IDF_CONFIG.algoVersion
        : DEFAULT_CONFIG.algoVersion;
    const config: NearDupeConfig = {
      algoVersion: args.algoVersion || baseAlgo,
      shingleSize: Number(args.shingleSize),
      numHashes: Number(args.numHashes),
      bands: Number(args.bands),
      rows: Number(args.rows),
      hashSeed: DEFAULT_CONFIG.hashSeed,
      stripQuotes: args.stripQuotes,
      weighting,
      maxIdfWeight: weighting === "idf" ? Number(args.maxIdfWeight) : undefined,
    };
    const includeTypes = new Set(
      args.types
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const corpus = new CorpusReader(args.omnesisDb, {
      includeTypes,
      minContentLength: Number(args.minContentLength),
      maxContentLength: Number(args.maxContentLength),
    });
    const total = corpus.countTotal();
    process.stderr.write(
      `[near-dupes] omnesis-db=${args.omnesisDb} dupes-db=${args.dupesDb}\n` +
        `[near-dupes] candidates by content length: ${total}\n` +
        `[near-dupes] algo=${config.algoVersion} k=${config.shingleSize} N=${config.numHashes} ` +
        `B=${config.bands} R=${config.rows} threshold≥${args.recordThreshold}\n` +
        `[near-dupes] include types: ${[...includeTypes].join(", ")}\n`,
    );
    const store = new DupeStore(args.dupesDb);
    const runId = randomUUID();
    const runner = new NearDupeRunner({
      config,
      store,
      corpus,
      runId,
      recordThreshold: Number(args.recordThreshold),
      maxCandidatesPerDoc: Number(args.maxCandidates),
      skipExisting: args.skipExisting,
      onProgress: (p) => {
        if (p.phase === "idf") {
          process.stderr.write(`[near-dupes][idf] ${p.processed} scanned (last: ${p.lastId})\n`);
        } else {
          process.stderr.write(
            `[near-dupes] ${p.processed} processed, ${p.skipped} skipped, ` +
              `${p.candidatesSeen} candidates, ${p.pairsRecorded} pairs (last: ${p.lastId})\n`,
          );
        }
      },
    });
    const result = runner.run();
    corpus.close();
    store.close();
    process.stderr.write(
      `[near-dupes] done run=${runId}: weighting=${config.weighting} ` +
        `${result.docsProcessed} processed, ${result.docsSkipped} skipped, ` +
        `${result.candidatesSeen} candidates total, ${result.pairsRecorded} pairs recorded` +
        (result.uniqueShingles > 0 ? `, ${result.uniqueShingles} unique shingles` : "") +
        ` in ${(result.elapsedMs / 1000).toFixed(1)}s\n`,
    );
  },
});

const main = defineCommand({
  meta: {
    name: "near-dupes-run",
    description: "Compute MinHash + LSH signatures and verified Jaccard pairs over an Omnesis DB.",
  },
  subCommands: { run },
});

void runMain(main);
