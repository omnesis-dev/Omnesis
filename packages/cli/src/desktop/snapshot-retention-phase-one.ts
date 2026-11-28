// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { managedDesktopSnapshotGcInvocation } from "@omnesis/core";
import { z } from "zod";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { runDesktopSnapshotReservation } from "./snapshot-retention-native.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { DesktopInteractionBroker } from "./protocol.js";
import { desktopRuntimeEpoch } from "./update-state.js";
import {
  prepareDesktopSnapshotCleanupLocked,
  resumeDesktopSnapshotCleanupLocked,
  stageDesktopSnapshotCleanupLocked,
} from "./snapshot-retention-prepare.js";
import {
  desktopSnapshotGcRequestSchema,
  desktopSnapshotCleanupBinding,
} from "./snapshot-retention-request.js";

interface PhaseOneOperations {
  ready(profile: DesktopProfile, signal: AbortSignal): Promise<void>;
  epoch(): string | null;
  invocation: typeof managedDesktopSnapshotGcInvocation;
  reserve(profile: DesktopProfile, operationId: string, signal: AbortSignal): Promise<void>;
  execve: NonNullable<NodeJS.Process["execve"]>;
}
export async function assertDesktopSnapshotCleanupReady(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<void> {
  const { DesktopCoordinator } = await import("./coordinator.js");
  const coordinator = new DesktopCoordinator(profile);
  const interactions = new DesktopInteractionBroker(() =>
    Promise.reject(new Error("Cleanup cannot request enrollment")),
  );
  try {
    const state = await coordinator.handle(
      { version: 1, id: randomUUID(), command: "status" },
      { signal, interactions },
    );
    if (
      !state ||
      typeof state !== "object" ||
      !("phase" in state) ||
      state.phase !== "ready" ||
      !("encrypted" in state) ||
      state.encrypted !== true
    )
      throw new Error("Recovery cleanup requires the current protected library to be ready");
  } finally {
    interactions.close();
    await coordinator.close();
  }
}
/** Production host has no executable override. Explicit source tests substitute only the OS transition. */
export async function runDesktopSnapshotGcPhaseOne(
  operationId: string,
  raw: unknown,
  signal: AbortSignal,
  overrides: Partial<PhaseOneOperations> = {},
): Promise<never> {
  signal.throwIfAborted();
  z.string().uuid().parse(operationId);
  const request = desktopSnapshotGcRequestSchema.parse(raw);
  const nativeExecve = overrides.execve ?? process.execve;
  if (!nativeExecve)
    throw new Error("Recovery cleanup requires a supported native process transition");
  const operations: PhaseOneOperations = {
    ready: assertDesktopSnapshotCleanupReady,
    epoch: desktopRuntimeEpoch,
    invocation: managedDesktopSnapshotGcInvocation,
    reserve: runDesktopSnapshotReservation,
    execve: nativeExecve,
    ...overrides,
  };
  const currentEpoch = operations.epoch();
  if (!currentEpoch || !/^[a-f0-9]{64}$/u.test(currentEpoch))
    throw new Error("Recovery cleanup requires the installed application runtime");
  await assertDesktopProcessAuthority(request.profile);
  await operations.ready(request.profile, signal);
  return withDesktopInstallLease(request.profile, signal, async () => {
    let prepared: Awaited<ReturnType<typeof prepareDesktopSnapshotCleanupLocked>>;
    if (request.retry) {
      if (
        request.snapshotId !== undefined ||
        request.expectedBinding !== undefined ||
        request.incompleteStaging !== undefined
      )
        throw new Error("A recovery cleanup retry cannot select another snapshot");
      prepared = await resumeDesktopSnapshotCleanupLocked(
        request.profile,
        operationId,
        currentEpoch,
        signal,
      );
    } else {
      if (!request.snapshotId || !request.expectedBinding)
        throw new Error("Review and confirm the recovery cleanup first");
      prepared = await prepareDesktopSnapshotCleanupLocked(
        request.profile,
        {
          snapshotId: request.snapshotId,
          currentEpoch,
          incompleteStaging: request.incompleteStaging,
        },
        signal,
      );
      if (desktopSnapshotCleanupBinding(request.profile, prepared) !== request.expectedBinding)
        throw new Error("The recovery cleanup changed after confirmation");
      prepared.receipt.operationId = operationId;
    }
    signal.throwIfAborted();
    const invocation = operations.invocation(request.profile, operationId);
    if (!request.retry) await stageDesktopSnapshotCleanupLocked(request.profile, prepared, signal);
    await operations.reserve(request.profile, operationId, signal);
    signal.throwIfAborted();
    // The install owner is this PID, not the controlling bridge. execve preserves
    // its birth identity but drops FD>2; native must reacquire all kernel authority.
    return operations.execve(
      invocation.command,
      [invocation.command, ...invocation.args],
      desktopEnvironment(request.profile),
    );
  });
}
