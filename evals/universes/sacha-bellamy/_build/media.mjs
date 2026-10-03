// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Render real local media under a universe's assets/; no network or model inference. */
export function generateMedia(outDir, assets) {
  const helper = fileURLToPath(new URL("./media.py", import.meta.url));
  const result = spawnSync(
    process.env.OMNESIS_SYNTH_PYTHON ?? "python3",
    [helper, join(outDir, "assets")],
    {
      input: JSON.stringify(assets),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Synthetic media generation failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}
