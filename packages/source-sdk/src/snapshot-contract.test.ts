// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, test, expect } from "vitest";

/**
 * The snapshot contract, enforced rather than remembered.
 *
 * `SyncResult.presentExternalIds` (its structured twin `presentIds`, and its
 * per-partition form `presentClaims`) is a source asserting that it has
 * enumerated everything it holds. The gateway acts
 * on the assertion by deleting whatever it stores that the assertion does not
 * name. A source that skipped a store, a repository, an account or a page and
 * asserts anyway has not reported a smaller corpus — it has ordered the
 * deletion of the part it could not read.
 *
 * That rule lived in a docstring for a long time, and a docstring cannot stop
 * anyone breaking it: the contacts source discarded the reason an address book
 * failed to open and built its snapshot from the survivors, and a corpus went
 * 26 → 5 → 0 with no error anywhere.
 *
 * This test makes the omission mechanical instead. It walks every provider
 * source file for an actual snapshot emission and requires the file to be named
 * in `snapshot-emitters.json` with a sentence saying how completeness is
 * guaranteed. A source written tomorrow is caught the day it emits its first
 * snapshot, without anyone having to remember to add it here.
 *
 * What it can and cannot do is worth stating plainly, because the temptation is
 * to read a green guard as "the contract holds".
 *
 * It cannot tell a correct discipline from a wrong one. No static check can
 * decide whether a `continue` three functions away shrinks an enumeration; the
 * rows in `snapshot-emitters.json` are claims a reviewer has to check, not
 * facts this file verified.
 *
 * Nor does it see every emitter that exists. It reads TypeScript in
 * `packages/providers/**` and `packages/source-sdk/**`, and snapshots are also
 * emitted from Swift and Kotlin, by phones pushing their own documents —
 * `android/feature-call-log`, `android/feature-photos`, `ios/…/Photos` all send
 * `presentExternalIds` and are structurally invisible here. The synthetic twins
 * under `packages/providers-synth/` are outside the scan too, deliberately:
 * they are test doubles, and the E2E sweep is what holds them honest.
 *
 * So the guarantee is narrow and worth having anyway: within those two trees,
 * no snapshot emission exists that nobody has written a justification for, and
 * a new one reddens the build on the day it lands. The semantic half of the
 * enforcement lives elsewhere — `SnapshotEnumeration`, which withholds unless
 * every discovered partition was positively covered, and
 * `packages/collector/src/e2e/snapshot-absence.e2e.test.ts`, which
 * degrades every source in a synthetic universe, counts the rows that survive,
 * and proves the knob fired by requiring the same sources to lose exactly those
 * documents once they vouch for the shrunken read often enough for the
 * gateway's deadline to come due.
 */

/**
 * Every field through which a source orders deletions.
 *
 * `presentClaims` belongs here because it is the same assertion narrowed to
 * named partitions, and `presentKeys` because it is the same assertion with
 * its rows named by every column that addresses them. Leaving either out would
 * let a source adopt the newer spelling and disappear from this inventory —
 * the one thing this file exists to make impossible.
 */
const SNAPSHOT_FIELDS = new Set([
  "presentExternalIds",
  "presentIds",
  "presentKeys",
  "presentClaims",
]);

/** Trees that own real sources. Synthetic twins are covered by the E2E sweep. */
const SCANNED_ROOTS = [join("packages", "providers"), join("packages", "source-sdk")];

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate the repository root from the source-sdk package");
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}

/** True when the file contains a real snapshot emission. */
function emitsSnapshot(source: string, fileName: string): boolean {
  return assignsAnyOf(source, fileName, SNAPSHOT_FIELDS);
}

/**
 * True when the file assigns a real value to one of `fields`. Type
 * declarations, reads and explicit `: undefined` opt-outs are all left alone —
 * the point is to catch the places that make a claim, not the places that
 * mention one.
 */
function assignsAnyOf(source: string, fileName: string, fields: ReadonlySet<string>): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let found = false;

  const isUndefined = (node: ts.Node): boolean =>
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined");

  const named = (name: ts.Node): boolean =>
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) && fields.has(name.text);

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && named(node.name) && !isUndefined(node.initializer)) {
      found = true;
      return;
    }
    if (ts.isShorthandPropertyAssignment(node) && named(node.name)) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      named(node.left.name) &&
      !isUndefined(node.right)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

interface Inventory {
  emitters: Record<string, string>;
}

describe("snapshot contract", () => {
  const root = repoRoot();
  const inventory = JSON.parse(
    readFileSync(join(root, "packages/source-sdk/src/snapshot-emitters.json"), "utf8"),
  ) as Inventory;

  const files: string[] = [];
  for (const scanned of SCANNED_ROOTS) {
    const dir = join(root, scanned);
    if (existsSync(dir)) walkTsFiles(dir, files);
  }

  const emitters = files
    .filter((f) => emitsSnapshot(readFileSync(f, "utf8"), f))
    .map((f) => relative(root, f).split(sep).join("/"))
    .sort();

  const PARTITION_FIELDS = new Set(["partitionKey"]);
  const providersRoot = join(root, "packages", "providers") + sep;
  // Only a provider owns documents. The SDK's `syncResult()` forwards whatever
  // a source hands it, so it names the field without ever claiming anything.
  const claimants = files.filter(
    (f) =>
      f.startsWith(providersRoot) &&
      assignsAnyOf(readFileSync(f, "utf8"), f, new Set(["presentClaims"])),
  );
  /** Every source file in the same provider package as `file`. */
  const packageFiles = (file: string): string[] => {
    const pkg = join(root, ...relative(root, file).split(sep).slice(0, 3));
    return files.filter((f) => f.startsWith(pkg + sep));
  };

  test("the scan finds the emitters it is supposed to find", () => {
    // A guard whose scan silently matches nothing passes forever. Two known
    // emitters anchor it: one built through the SDK seam, one that is not.
    expect(emitters).toContain("packages/providers/apple/src/contacts.ts");
    expect(emitters).toContain("packages/providers/things/src/index.ts");
    expect(emitters.length).toBeGreaterThan(10);
  });

  test("every source that emits a snapshot says how it knows the read was complete", () => {
    const unregistered = emitters.filter((f) => !(f in inventory.emitters));
    expect(
      unregistered,
      "These files emit `presentExternalIds` or `presentIds`, which tells the gateway to " +
        "delete every document the snapshot does not name.\n\n" +
        "Before shipping one, make sure the enumeration cannot be reached from a read that " +
        "skipped a store, an account, a repository or a page — build it through " +
        "`SnapshotEnumeration` from @omnesis/source-sdk, which withholds unless every " +
        "discovered partition was positively covered.\n\n" +
        "Then add a row to packages/source-sdk/src/snapshot-emitters.json stating how " +
        "completeness is guaranteed. The sentence has to be true of every path that reaches " +
        "the emission, not just the happy one.",
    ).toEqual([]);
  });

  test("the inventory has no rows for files that no longer emit a snapshot", () => {
    const stale = Object.keys(inventory.emitters).filter((f) => !emitters.includes(f));
    expect(
      stale,
      "These files are listed in snapshot-emitters.json but no longer emit a snapshot. " +
        "Remove the row so the inventory keeps describing the code that exists.",
    ).toEqual([]);
  });

  test("a source that claims partitions also names them on its documents", () => {
    // A claim is matched against `documents.partition_key`. A source that
    // vouches for `books/home` while storing its documents unpartitioned has
    // claimed a partition holding nothing: the sweep finds no document to
    // judge, so the deletions the source is asking for never happen and
    // nothing says why. The two halves are written in different files, which
    // is exactly how one ships without the other.
    const missing = claimants
      .filter(
        (file) =>
          !packageFiles(file).some((f) =>
            assignsAnyOf(readFileSync(f, "utf8"), f, PARTITION_FIELDS),
          ),
      )
      .map((f) => relative(root, f).split(sep).join("/"));
    expect(
      missing,
      "These files emit `presentClaims`, but nothing in their package stamps `partitionKey` " +
        "on a document. A claim names a partition; a document belongs to one because the " +
        "source said so. Set `partitionKey` on every document the claimed partitions hold.",
    ).toEqual([]);
  });

  test("every row explains itself rather than merely existing", () => {
    const empty = Object.entries(inventory.emitters)
      .filter(([, why]) => typeof why !== "string" || why.trim().length < 40)
      .map(([file]) => file);
    expect(
      empty,
      "A row is a claim a reviewer can check, not a checkbox. Say what makes the enumeration " +
        "complete and what happens when part of the read fails.",
    ).toEqual([]);
  });
});
