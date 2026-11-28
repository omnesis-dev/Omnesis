// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolveSubprocessEntry } from "@omnesis/core";
import { z } from "zod";
import { desktopEnvironment } from "./environment.js";
import { runOwnedDesktopFrame } from "./owned-frame.js";
import {
  desktopSnapshotGcRequestSchema,
  type DesktopSnapshotGcRequest,
} from "./snapshot-retention-request.js";
import {
  DesktopSnapshotRetentionFailure,
  desktopSnapshotRetentionFailureFromCode,
} from "./snapshot-retention-errors.js";
import type { spawnOwnedChildProcess } from "@omnesis/core";
import type { DesktopSnapshotDeletionResult } from "./snapshot-retention-delete.js";
const resultSchema = z
  .object({
    status: z.literal("removed"),
    operationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    bytes: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
const refused = () => new DesktopSnapshotRetentionFailure("RECOVERY_CLEANUP_REFUSED");
/** Starts the fixed consumer host; its own PID retains the install owner through native reclamation. */
export async function runDesktopSnapshotCleanupHost(
  operationId: string,
  raw: DesktopSnapshotGcRequest,
  signal: AbortSignal,
  dependencies: {
    invocation?: typeof resolveSubprocessEntry;
    spawn?: typeof spawnOwnedChildProcess;
  } = {},
): Promise<DesktopSnapshotDeletionResult> {
  z.string().uuid().parse(operationId);
  const request = desktopSnapshotGcRequestSchema.parse(raw);
  const result = await runOwnedDesktopFrame(
    {
      request,
      inputLimit: 64 * 1024,
      outputLimit: 16 * 1024,
      env: desktopEnvironment(request.profile),
      invocation: () => {
        const entry = (dependencies.invocation ?? resolveSubprocessEntry)(
          "./snapshot-retention-host.ts",
          import.meta.url,
          request.profile,
        );
        return { command: entry.command, args: [...entry.args, "--prepare", operationId] };
      },
      refused,
      failure: desktopSnapshotRetentionFailureFromCode,
      spawn: dependencies.spawn,
    },
    signal,
  );
  const parsed = resultSchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.operationId !== operationId ||
    (request.snapshotId && parsed.data.snapshotId !== request.snapshotId)
  )
    throw refused();
  return parsed.data;
}
