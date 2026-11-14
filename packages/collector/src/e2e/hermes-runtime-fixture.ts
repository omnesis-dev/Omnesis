// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Exercise the deployed Windows asset closure, retaining Python-only Unix probes. */
export function hermesProbeAdapter(
  home: string,
  repositoryRoot: string,
  prepareHermesRuntimeAssets: (source: { packageRoot: string; entry: string }) => {
    files: { file: string; content: Buffer }[];
    cleanup(): void;
  },
): string {
  const packageRoot = join(repositoryRoot, "packages", "agent-integration");
  if (process.platform !== "win32") return join(packageRoot, "hermes", "adapter.py");
  const runtime = prepareHermesRuntimeAssets({
    packageRoot,
    entry: join(packageRoot, "src", "index.ts"),
  });
  const destination = join(home, "plugins", "omnesis-integration");
  try {
    for (const { file, content } of runtime.files) {
      const target = join(destination, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content);
    }
  } finally {
    runtime.cleanup();
  }
  return join(destination, "adapter.py");
}
