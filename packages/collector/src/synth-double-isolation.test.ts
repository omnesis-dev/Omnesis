// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A synthetic double must not inherit its real twin's live paths.
 *
 * Every double is built by spreading the real definition and overriding the
 * parts that would reach a live service. That is the right shape — it keeps
 * the double honest about the descriptor the product sees — and it has one
 * failure mode: a field added to the real definition is inherited by all of
 * them silently, and the override list is something someone has to remember to
 * extend.
 *
 * It has happened twice. `authenticate` reached sixteen doubles when the typed
 * auth path landed. `contract.state` reached six when state declarations did,
 * and that one would have parked a source mid-run, because a real source's
 * decoder rejects the cursor its double actually drives.
 *
 * The invariant is inheritance, not absence. A double may perfectly well
 * *have* an `authenticate` — several present a fake pairing screen — so what
 * is checked is that the value is not the real twin's own. Identity is the
 * whole test: a spread copies the reference, and an override replaces it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { providerPackageNames } from "./source-descriptors.js";

interface Entry {
  id?: string;
  authenticate?: unknown;
  authFlow?: unknown;
  credentials?: unknown;
  cleanupCredentials?: unknown;
  contract?: { state?: unknown };
  config?: unknown;
  sources?: Entry[];
}

/** The fields whose real implementation must never survive into a double. */
const LIVE_PATHS = [
  ["authenticate", (e: Entry) => e.authenticate],
  ["authFlow", (e: Entry) => e.authFlow],
  ["credentials", (e: Entry) => e.credentials],
  ["cleanupCredentials", (e: Entry) => e.cleanupCredentials],
  ["contract.state", (e: Entry) => e.contract?.state],
  // A real config schema can carry a `check` hook or `mustExist`, and those
  // ask about this machine's filesystem. A double reads fixtures, so
  // inheriting one means the source refuses to instantiate anywhere the real
  // application is not installed — which is every synthetic host.
  ["config", (e: Entry) => e.config],
] as const;

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const synthPackages = providerPackageNames(manifest, true);

/** Pair each entry with the real one it doubles, by id where there are several. */
function pairEntries(synth: Entry, real: Entry): Array<[Entry, Entry]> {
  const pairs: Array<[Entry, Entry]> = [[synth, real]];
  for (const synthSource of synth.sources ?? []) {
    const realSource = (real.sources ?? []).find((s) => s.id === synthSource.id);
    if (realSource) pairs.push([synthSource, realSource]);
  }
  return pairs;
}

describe("synthetic doubles inherit no live path from their real twin", () => {
  test("the double set is not empty, or this suite proves nothing", () => {
    // A filter that silently matched nothing would make every case below pass.
    expect(synthPackages.length).toBeGreaterThan(10);
  });

  test.each(synthPackages)("%s", async (pkgName) => {
    const realName = pkgName.replace(/-synth$/, "");
    const synthMod = (await import(pkgName)) as { default: Entry };

    // Some doubles have no real twin at all: a phone-pushed source ships only
    // its synthetic side, because the real one lives on the device. There is
    // nothing for those to inherit, so they pass — but the miss is confirmed
    // to be a missing package rather than any import failure, or a real twin
    // that had simply broken would read as a clean bill of health.
    let realMod: { default: Entry };
    try {
      realMod = (await import(realName)) as { default: Entry };
    } catch (error) {
      expect(
        (error as { code?: string }).code,
        `${pkgName}: expected either a real twin or a missing package, got ${String(error)}`,
      ).toBe("ERR_MODULE_NOT_FOUND");
      return;
    }

    for (const [synth, real] of pairEntries(synthMod.default, realMod.default)) {
      const where = `${pkgName}${synth.id ? ` (${synth.id})` : ""}`;
      for (const [field, read] of LIVE_PATHS) {
        const realValue = read(real);
        if (realValue === undefined) continue; // nothing to inherit
        expect(
          read(synth),
          `${where} inherited the real \`${field}\`. A spread copies the real ` +
            `implementation, so override it in the double. \`contract.state\` means the real ` +
            `decoder refuses the cursor this double writes; \`config\` means a path check ` +
            `about this machine's filesystem stops the double instantiating at all.`,
        ).not.toBe(realValue);
      }
    }
  });
});
