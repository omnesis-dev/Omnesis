// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Replay backend of the decision capability: answers from recorded decision
 * cassettes (see `@omnesis/core`'s `decision-cassette`), with no network.
 *
 * The fixture is a `.jsonl` cassette or a directory of them (every `.jsonl`
 * inside is loaded). A request whose fingerprint is not in the cassettes
 * throws — like any unavailable backend — so the caller fails open and the
 * miss is visible in the audit record instead of being answered with a guess.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decisionFingerprint,
  parseDecisionCassette,
  type DecisionCapability,
  type DecisionCassetteEntry,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";

export class ReplayDecision implements DecisionCapability {
  readonly modelId = "replay";
  private readonly entries: Map<string, DecisionCassetteEntry>;

  constructor(entries: Map<string, DecisionCassetteEntry>) {
    this.entries = entries;
  }

  static fromPath(fixture: string): ReplayDecision {
    const files = statSync(fixture).isDirectory()
      ? readdirSync(fixture)
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map((name) => join(fixture, name))
      : [fixture];
    const entries = new Map<string, DecisionCassetteEntry>();
    for (const file of files) {
      for (const [fp, entry] of parseDecisionCassette(readFileSync(file, "utf8"), file)) {
        entries.set(fp, entry);
      }
    }
    return new ReplayDecision(entries);
  }

  get size(): number {
    return this.entries.size;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const fp = decisionFingerprint(request);
    const entry = this.entries.get(fp);
    if (!entry) throw new Error(`No recorded decision for ${fp}`);
    // Attributed to replay, naming the model that originally answered, so the
    // ledger never claims a live model made a decision nothing was asked for.
    return {
      model: `replay:${entry.response.model}`,
      answers: entry.response.answers,
      ...(entry.response.inputTokens === undefined
        ? {}
        : { inputTokens: entry.response.inputTokens }),
    };
  }

  dispose(): void {}
}
