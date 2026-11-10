#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ask TypeSafe Jev the email worth question for every invented email in
 * `scripts/lib/invented-worth-mail.mts` and write its replies as the decision cassette
 * `evals/decision/jev-worth.jsonl`, the reference `scripts/eval-decision-cassette.mts`
 * compares a candidate decision model against. Re-record after changing the
 * worth rubric or the mail generator.
 *
 * Usage:
 *   TYPESAFE_API_KEY=… npx tsx scripts/record-jev-worth-cassette.mts [count] [out.jsonl]
 *
 * The key is read from the environment only. The emails are invented, so
 * sending them to TypeSafe sends nothing of anyone's.
 */
import { writeFileSync } from "node:fs";
import { formatDecisionCassetteEntry } from "../packages/core/src/index.js";
import { TypeSafeDecision } from "../packages/gateway/src/inference/decision/typesafe-client.js";
import { TYPESAFE_DEFAULT_URL } from "../packages/gateway/src/inference/registry.js";
import { EMAIL_WORTH_QUESTIONS } from "../packages/gateway/src/worth/rubric.js";
import { inventedMail } from "./lib/invented-worth-mail.mjs";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
const count = Number(process.argv[2] ?? 312);
const out =
  process.argv[3] ?? new URL("../evals/decision/jev-worth.jsonl", import.meta.url).pathname;

const jev = new TypeSafeDecision({
  url: TYPESAFE_DEFAULT_URL,
  model: "jev-1.13.0",
  apiKey,
  allowRemoteInference: true,
});
const mail = inventedMail(count);
const lines: string[] = new Array(mail.length);
let next = 0;
let done = 0;
let failed = 0;
async function worker() {
  while (next < mail.length) {
    const i = next++;
    const request = { state: mail[i]!, questions: EMAIL_WORTH_QUESTIONS };
    try {
      const result = await jev.decide(request);
      lines[i] = formatDecisionCassetteEntry(request, result);
    } catch (err) {
      failed++;
      process.stderr.write(`\n#${i}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    done++;
    process.stderr.write(`\r${done}/${mail.length}`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
const kept = lines.filter(Boolean);
writeFileSync(out, `${kept.join("\n")}\n`);
console.log(`\nwrote ${kept.length} decisions (${failed} failed) to ${out}`);
