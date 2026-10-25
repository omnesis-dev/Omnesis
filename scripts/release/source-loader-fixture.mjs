// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/** Preserve the recording CLI seam behind the production Node preload front door. */
export const sourceLoaderFixture = `mkdir -p node_modules/tsx/dist
cat > node_modules/tsx/dist/loader.mjs <<'OMNESIS_TEST_LOADER'
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const recorder = fileURLToPath(new URL("../../.bin/tsx", import.meta.url));
const result = spawnSync("sh", [recorder, ...process.argv.slice(1)], { stdio: "inherit" });
process.exit(result.status ?? 1);
OMNESIS_TEST_LOADER
`;
