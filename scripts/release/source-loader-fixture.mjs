// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Each fake release carries the actual pure renderer that target would export. */
export function seedSourceLauncher(root) {
  const update = join(root, "packages/cli/src/update");
  mkdirSync(update, { recursive: true });
  for (const name of ["source-launcher.ts", "node-gyp-headers.ts"])
    copyFileSync(
      new URL(`../../packages/cli/src/update/${name}`, import.meta.url),
      join(update, name),
    );
  const manifest = join(root, "packages/cli/package.json");
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), type: "module" }) + "\n",
  );
}

const realLoader = pathToFileURL(
  realpathSync(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;
/** Record only CLI commands; pure target-renderer imports use the real TS loader. */
export const sourceLoaderFixture = `mkdir -p node_modules/tsx/dist node_modules/@omnesis/core
cat > node_modules/@omnesis/core/package.json <<'OMNESIS_TEST_CORE'
{"name":"@omnesis/core","type":"module","exports":"./index.mjs"}
OMNESIS_TEST_CORE
cat > node_modules/@omnesis/core/index.mjs <<'OMNESIS_TEST_CORE'
export function atomicWriteFileSync() { throw new Error("pure renderer unexpectedly wrote a file"); }
OMNESIS_TEST_CORE
cat > node_modules/tsx/dist/loader.mjs <<'OMNESIS_TEST_LOADER'
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv[1]?.endsWith("/packages/cli/src/index.ts")) {
  const recorder = fileURLToPath(new URL("../../.bin/tsx", import.meta.url));
  const result = spawnSync("sh", [recorder, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
await import(${JSON.stringify(realLoader)});
OMNESIS_TEST_LOADER
`;
