// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Four runtimes have to agree about why a watch request was refused.
 *
 * The gateway mints the codes, this package's HTTP client classifies them, two
 * Hermes adapters render them for an agent, and `integrations/README.md`
 * promises the set to whoever is writing one. The set is declared once, in
 * `@omnesis/types`, because that package has no dependencies and is therefore
 * the only one all four can reach.
 *
 * None of them can import it. Two are Python, one is prose, and the HTTP client
 * ships as a plugin whose published dependency footprint is deliberately free
 * of Omnesis packages — `stage-packages.test.mjs` pins that, because a Hermes
 * user installing the plugin should not thereby install the product. So they
 * all restate the set, and this holds them to it.
 *
 * This file sits beside the client rather than beside the declaration so the
 * narrow inner loop catches drift: an edit to `http.ts` followed by
 * `vitest run packages/agent-integration` is the loop an author actually runs,
 * and a guard two packages away is one they would not see fail.
 *
 * The **sentences** are deliberately not compared. Each consumer writes for its
 * own reader, and a refusal's free text never crosses the boundary in either
 * direction. It is the key set that must not drift: a code the gateway sends
 * and an adapter does not know degrades to an unexplained 422, and an agent
 * that cannot tell "decided" from "try again" retries a settled decision
 * forever.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { REFUSAL_CODES } from "@omnesis/types";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The one adapter that ships to Hermes hosts. */
const ADAPTERS = [join(repoRoot, "packages", "agent-integration", "hermes", "adapter.py")];

/** This package's own restatement, read the same way and for the same reason. */
const CLIENT = join(repoRoot, "packages", "agent-integration", "src", "http.ts");

function clientCodes(): string[] {
  const source = readFileSync(CLIENT, "utf8");
  return keysIn(
    source,
    "const SUBSCRIPTION_UNSUPPORTED_MESSAGES = {",
    "\n} as const;",
    /^ {2}([a-z0-9_]+):/gm,
    CLIENT,
  );
}

/** The keys of the adapter's refusal dict, read from the source. */
function adapterCodes(path: string): string[] {
  // `\n}\n` rather than `\n}`: the latter is "the first line below that starts
  // with a brace", which is only this dict's own close while it sits at column
  // zero. Move it inside a class and the scan runs on for ten kilobytes,
  // sweeping up any four-space-indented quoted key it meets on the way.
  return keysIn(
    readFileSync(path, "utf8"),
    "_SUBSCRIPTION_UNSUPPORTED_MESSAGES = {",
    "\n}\n",
    /^ {4}"([a-z0-9_]+)":/gm,
    path,
  );
}

/**
 * The keys of one declaration, read from source because its consumer cannot
 * import the declaration.
 *
 * Every failure here is loud. A renamed or unterminated declaration fails on
 * the anchors; a declaration that grew past what one could plausibly be fails
 * on the span, which is the failure that would otherwise be silent — a scan
 * that escapes its own closing brace keeps matching, and reports keys that
 * belong to something else entirely.
 */
function keysIn(
  source: string,
  opens: string,
  closes: string,
  key: RegExp,
  what: string,
): string[] {
  const start = source.indexOf(opens);
  expect(start, `${what} does not declare ${opens}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(closes, start);
  expect(end, `${what} leaves ${opens} unterminated`).toBeGreaterThan(start);
  const span = source.slice(start, end);
  expect(
    span.length,
    `the scan of ${opens} in ${what} ran past its own close and is reading someone else's keys`,
  ).toBeLessThan(2_000);
  return [...span.matchAll(key)].map((m) => m[1]!);
}

/** The public promise, which is prose and cannot be typed at all. */
const README = join(repoRoot, "integrations", "README.md");

function readmeCodes(): string[] {
  const source = readFileSync(README, "utf8");
  const start = source.indexOf("of a closed set of codes (");
  expect(start, "the integrations README no longer states the closed set").toBeGreaterThanOrEqual(
    0,
  );
  const end = source.indexOf(")", start);
  expect(end, "the README's list of codes is unterminated").toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!);
}

describe("the refusal vocabulary", () => {
  it.each(ADAPTERS)("is the same set in %s as the gateway mints", (path) => {
    expect([...adapterCodes(path)].sort()).toEqual([...REFUSAL_CODES].sort());
  });

  it("is the same set in this package HTTP client", () => {
    expect([...clientCodes()].sort()).toEqual([...REFUSAL_CODES].sort());
  });

  it("is the same set the integrations README promises", () => {
    // The one an integration author actually reads. It listed three of four,
    // omitting the only code that means "retry" — so a retry policy written
    // from it would never retry the one transient case.
    expect([...readmeCodes()].sort()).toEqual([...REFUSAL_CODES].sort());
  });
});
