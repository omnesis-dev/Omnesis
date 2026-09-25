// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Three runtimes have to agree how long a subscription-management call may take.
 *
 * Creating a subscription runs a full agentic compile behind the request, so it
 * is measured in minutes. An adapter carrying the ordinary read budget times out
 * on every create it ever makes while the gateway goes on to succeed — the agent
 * sees a feature that always fails, and the watch it now owns is invisible to
 * it. Retrying that is how one intent becomes several subscriptions, because a
 * reworded retry carries a different idempotency key by design.
 *
 * The budget is declared once, in `@omnesis/types`, for the same reason the
 * refusal codes are: that package has no dependencies and is the only one every
 * runtime can reach. Neither adapter can import it, so they restate it
 * and this holds them to it — the same enforcement, beside the same client, for
 * the same inner loop.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { MANAGEMENT_FAILURE_KINDS, SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS } from "@omnesis/types";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** This package's own restatement, read the same way and for the same reason. */
const CLIENT = join(repoRoot, "packages", "agent-integration", "src", "openclaw.ts");

/** The one adapter that ships to Hermes hosts. */
const ADAPTERS = [join(repoRoot, "packages", "agent-integration", "hermes", "adapter.py")];

function pythonSeconds(path: string, name: string): number {
  const source = readFileSync(path, "utf8");
  const match = new RegExp(`^${name} = ([0-9.]+)$`, "m").exec(source);
  if (!match) throw new Error(`${path} declares no ${name}`);
  return Number(match[1]);
}

/**
 * The outcomes the management tool's failure handlers name, as it spells them.
 *
 * Scoped to that function: `kind` is a field name the DSL uses too, and reading
 * the whole file would collect a condition's kind alongside a failure's.
 */
function failureKindsIn(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("def manage_subscriptions");
  if (start < 0) throw new Error(`${path} declares no manage_subscriptions`);
  const body = source.slice(start);
  const end = body.indexOf("\ndef ", 1);
  const scoped = end < 0 ? body : body.slice(0, end);
  return [...new Set([...scoped.matchAll(/"kind":\s*"([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

describe("the subscription-management latency contract", () => {
  it("is restated by the plugin rather than imported", () => {
    // Imported it would survive to the emitted JS as a module load, and the
    // published plugin's dependencies are deliberately free of Omnesis packages
    // — an installer would get a module-not-found on load. The repo's smoke
    // import cannot catch that: it resolves through the repo's own node_modules.
    const source = readFileSync(CLIENT, "utf8");
    expect(source, "the plugin imports an Omnesis package it cannot ship with").not.toMatch(
      /from "@omnesis\//,
    );
    const match = /const SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS = ([0-9_]+);/.exec(source);
    expect(match, "the plugin declares no management timeout").not.toBeNull();
    expect(Number(match![1]!.replaceAll("_", ""))).toBe(SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS);
  });
  it.each(ADAPTERS)("is restated by %s in seconds", (adapter) => {
    expect(pythonSeconds(adapter, "SUBSCRIPTION_MANAGEMENT_TIMEOUT_SECONDS") * 1_000).toBe(
      SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS,
    );
  });

  it.each(ADAPTERS)("keeps %s's ordinary read budget separate from it", (adapter) => {
    // The two budgets are different sizes on purpose. Collapsing them would put
    // a five-minute socket budget on every read the adapter makes, so a gateway
    // that has gone away stops looking like one that has gone away.
    const ordinary = pythonSeconds(adapter, "GATEWAY_TIMEOUT_SECONDS");
    expect(ordinary * 1_000).toBeLessThan(SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS);
  });

  it.each(ADAPTERS)("%s tells the three outcomes apart by the agreed names", (adapter) => {
    // A timeout, a refusal and an unreachable gateway call for three different
    // next moves, and an adapter that renders two of them the same leaves the
    // model to guess — which in practice means retrying, the move that turns
    // one intent into several subscriptions.
    expect(failureKindsIn(adapter)).toEqual([...MANAGEMENT_FAILURE_KINDS].sort());
  });

  it("leaves the compile deadline room to answer inside it", () => {
    // The gateway's own default deadline is asserted against this from the
    // gateway side, where the constant lives. What is checked here is the
    // property that makes the contract worth having at all: a budget that did
    // not exceed the work it waits for would time out on every successful
    // create, which is the failure this exists to prevent.
    expect(SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS).toBeGreaterThan(180_000);
  });
});
