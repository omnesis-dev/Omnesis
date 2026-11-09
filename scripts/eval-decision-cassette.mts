#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ask a candidate decision model every question recorded in a decision
 * cassette and report how often it agrees with the recorded answers — the way
 * to judge whether a local or self-hosted model is good enough for the
 * decision role before assigning it.
 *
 * Usage:
 *   scripts/eval-decision-cassette.mts --cassette <file.jsonl | dir> <backend> [--limit N]
 *
 * Backends (the same adapters the gateway uses):
 *   --http <base url> --model <id> [--api-key-env VAR] [--allow-remote]
 *       an OpenAI-compatible server that returns logprobs (llama-server, vLLM)
 *   --local <path/to/model.gguf>
 *       a local GGUF chat model, run in this process
 *   --typesafe <url> --model <id> [--api-key-env VAR] [--allow-remote]
 *       a TypeSafe-compatible endpoint
 *
 * Cassettes hold the requests a gateway recorded (`record-decision-cassette.mjs`)
 * or a universe's committed `decision-cassettes/`. Requests carry the content
 * that was judged, so only point a remote backend at a cassette whose content
 * may leave this machine.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  parseDecisionCassette,
  type DecisionAnswer,
  type DecisionCapability,
  type DecisionCassetteEntry,
} from "../packages/core/src/index.js";
import { HttpChatDecision } from "../packages/gateway/src/inference/decision/http-chat-decision.js";
import { LlamaCppDecision } from "../packages/gateway/src/inference/decision/llama-cpp-decision.js";
import { TypeSafeDecision } from "../packages/gateway/src/inference/decision/typesafe-client.js";
import { compareAnswer, formatAgreement, summarizeAgreement } from "./lib/decision-agreement.mjs";

interface Args {
  cassette?: string;
  http?: string;
  local?: string;
  typesafe?: string;
  model?: string;
  apiKeyEnv?: string;
  allowRemote: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--cassette") out.cassette = next();
    else if (arg === "--http") out.http = next();
    else if (arg === "--local") out.local = next();
    else if (arg === "--typesafe") out.typesafe = next();
    else if (arg === "--model") out.model = next();
    else if (arg === "--api-key-env") out.apiKeyEnv = next();
    else if (arg === "--allow-remote") out.allowRemote = true;
    else if (arg === "--limit") out.limit = Number(next());
    else throw new Error(`Unknown argument ${arg}`);
  }
  return out;
}

function loadCassette(path: string): DecisionCassetteEntry[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => join(path, f))
    : [path];
  return files.flatMap((f) => [...parseDecisionCassette(readFileSync(f, "utf8"), f).values()]);
}

function buildCandidate(args: Args): DecisionCapability {
  const apiKey = args.apiKeyEnv ? process.env[args.apiKeyEnv] : undefined;
  const backends = [args.http, args.local, args.typesafe].filter(Boolean);
  if (backends.length !== 1) throw new Error("Name exactly one of --http, --local, --typesafe");
  if (args.local) return new LlamaCppDecision(args.local);
  if (!args.model) throw new Error("--model is required for --http and --typesafe");
  if (args.http) {
    return new HttpChatDecision({
      backendKey: "eval",
      baseUrl: args.http,
      model: args.model,
      allowRemoteInference: args.allowRemote,
      ...(apiKey ? { apiKey } : {}),
    });
  }
  return new TypeSafeDecision({
    url: args.typesafe!,
    model: args.model,
    allowRemoteInference: args.allowRemote,
    ...(apiKey ? { apiKey } : {}),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cassette) throw new Error("--cassette is required");
  const entries = loadCassette(args.cassette).slice(0, args.limit ?? Infinity);
  const candidate = buildCandidate(args);
  const rows: ReturnType<typeof compareAnswer>[] = [];
  const failures = new Map<string, number>();
  const started = Date.now();
  try {
    for (const [i, entry] of entries.entries()) {
      let answers: Readonly<Record<string, DecisionAnswer>> | null = null;
      try {
        answers = (await candidate.decide(entry.request)).answers;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.set(message, (failures.get(message) ?? 0) + 1);
      }
      for (const [id, recorded] of Object.entries(entry.response.answers)) {
        rows.push(compareAnswer(recorded, answers?.[id] ?? null));
      }
      process.stderr.write(`\r${i + 1}/${entries.length} decisions`);
    }
  } finally {
    await candidate.dispose();
  }
  process.stderr.write("\n");
  const recordedModels = [...new Set(entries.map((e) => e.response.model))].join(", ");
  console.log(`candidate ${candidate.modelId} vs recorded ${recordedModels || "—"}`);
  console.log(`${entries.length} decisions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(formatAgreement(summarizeAgreement(rows)));
  for (const [message, count] of failures) console.log(`unanswered ×${count}: ${message}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
