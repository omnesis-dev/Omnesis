// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Write the wire-fixture corpus to `wire-fixtures/`.
 *
 * The files are checked in because Swift and Kotlin read them at test time and
 * neither can run TypeScript to generate them. `wire-fixtures.test.ts` fails
 * when they drift, so the generator is how you make it pass rather than
 * something to remember to run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { WIRE_FIXTURES, renderWireFixture } = await import(
  join(root, "packages/core/src/wire-fixtures.ts")
);

// Every place the corpus has to exist. The native hosts receive one module
// directory each — the dispatcher rsyncs `android/` and `ios/`, not the
// repository — so a corpus that lived only at the root would never reach the
// tests that exist to read it. One definition, three generated copies, and a
// drift test over all of them.
const DESTINATIONS = [
  join(root, "wire-fixtures"),
  join(root, "android/core-transport/src/test/resources/wire-fixtures"),
  join(root, "ios/Tests/OmnesisTests/wire-fixtures"),
];

for (const dir of DESTINATIONS) {
  mkdirSync(dir, { recursive: true });
  for (const fixture of WIRE_FIXTURES) {
    writeFileSync(join(dir, `${fixture.name}.json`), renderWireFixture(fixture));
  }
}
process.stdout.write(
  `wrote ${WIRE_FIXTURES.length} wire fixtures to ${DESTINATIONS.length} destinations\n`,
);
