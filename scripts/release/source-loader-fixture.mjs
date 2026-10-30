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

// The preload the installer writes, which a test holds byte-identical to core's.
const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const preloadStart =
  installer.indexOf("\n", installer.indexOf("npm_trust_preload() {\n  cat <<'EOF'")) + 1;
const preloadSource = installer.slice(
  installer.indexOf("\n", preloadStart) + 1,
  installer.indexOf("EOF\n}\n", preloadStart),
);

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
export function distrustingNodeOptions(current = process.env.NODE_OPTIONS) { return current ?? ""; }
export const PRELOAD_SOURCE = ${JSON.stringify(preloadSource)};
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
