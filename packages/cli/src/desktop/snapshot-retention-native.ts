// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { managedDesktopSnapshotGcInvocation, spawnOwnedChildProcess } from "@omnesis/core";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";

export async function runDesktopSnapshotReservation(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  action: "reserve" | "cancel" = "reserve",
): Promise<void> {
  const invocation = managedDesktopSnapshotGcInvocation(profile, operationId, action);
  const owner = spawnOwnedChildProcess(invocation.command, invocation.args, {
    env: desktopEnvironment(profile),
  });
  owner.child.stdout?.resume();
  owner.child.stderr?.resume();
  owner.child.stdin?.end();
  const cancel = () => {
    void owner.stop().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    await owner.ready;
    await owner.joined;
    signal.throwIfAborted();
    if (owner.child.exitCode !== 0) throw new Error("The runtime cleanup reservation was refused");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!owner.joinedConfirmed) await owner.stop();
  }
}
