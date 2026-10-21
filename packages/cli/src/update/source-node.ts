// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { satisfies, valid, validRange } from "semver";
import { z } from "zod";
import { CliError, EXIT_USER_ERROR } from "../utils.js";
import type { CommandRunner } from "../commands/update.js";

const sourceManifestSchema = z.object({
  engines: z.object({ node: z.string().trim().min(1) }),
});

/** Check source-build tooling separately from the published runtime's Node floor. */
export function assertSourceNodeVersion(manifest: unknown, version: string): void {
  const parsed = sourceManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new CliError(
      "The target source manifest has invalid Node requirements. Refusing to update.",
      EXIT_USER_ERROR,
    );
  }
  const range = parsed.data.engines.node;
  if (!validRange(range)) {
    throw new CliError(
      "The target source manifest has invalid Node requirements. Refusing to update.",
      EXIT_USER_ERROR,
    );
  }
  if (!valid(version) || !satisfies(version, range)) {
    throw new CliError(
      `This source update requires Node ${range}; npm would run with Node ${version}. ` +
        "Upgrade Node, ensure node and npm select that version on PATH, then rerun omnesis update. " +
        "The checkout and services have not been changed.",
      EXIT_USER_ERROR,
    );
  }
}

/** Read the immutable target and the Node executable npm will find on PATH. */
export async function assertSourceTargetNode(
  run: CommandRunner,
  rootDir: string,
  commit: string,
): Promise<void> {
  const manifest = await run(
    { command: "git", args: ["show", "--no-textconv", `${commit}:package.json`], cwd: rootDir },
    "capture",
  );
  let parsed: unknown;
  try {
    if (manifest.code !== 0) throw new Error("unreadable manifest");
    parsed = JSON.parse(manifest.stdout);
  } catch {
    throw new CliError(
      "Could not read the target source manifest's Node requirements. Refusing to update.",
      EXIT_USER_ERROR,
    );
  }
  const node = await run(
    { command: "node", args: ["-p", "process.versions.node"], cwd: rootDir },
    "capture",
  );
  if (node.code !== 0) {
    throw new CliError(
      "Could not determine the Node version on PATH. Upgrade Node and rerun omnesis update.",
      EXIT_USER_ERROR,
    );
  }
  assertSourceNodeVersion(parsed, node.stdout.trim());
}
