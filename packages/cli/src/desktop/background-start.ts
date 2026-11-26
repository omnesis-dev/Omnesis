// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  managedDesktopBackgroundStartInvocation,
  resolveSubprocessEntry,
  spawnOwnedChildProcess,
} from "@omnesis/core";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import {
  desktopRestoreActivationArguments,
  type DesktopRestoreActivation,
} from "./restore-start-arguments.js";

/** Native managed failure is terminal; only the explicit source adapter may detach Node. */
export async function startDesktopBackgroundDaemon(
  profile: DesktopProfile,
  activation?: DesktopRestoreActivation,
  signal?: AbortSignal,
  dependencies: {
    invocation?: typeof managedDesktopBackgroundStartInvocation;
    owned?: typeof spawnOwnedChildProcess;
    sourceSpawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const invocation = (dependencies.invocation ?? managedDesktopBackgroundStartInvocation)(
    profile,
    activation,
    import.meta.url,
  );
  const env = desktopEnvironment(profile);
  if (invocation) {
    const owner = (dependencies.owned ?? spawnOwnedChildProcess)(
      invocation.command,
      invocation.args,
      { env },
    );
    const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    const stop = () => {
      void owner.stop().catch(() => undefined);
    };
    let exit: number | null = null;
    owner.child.once("exit", (code) => {
      exit = code;
    });
    owner.child.stdout?.resume();
    owner.child.stderr?.resume();
    owner.child.stdin?.end();
    active.addEventListener("abort", stop, { once: true });
    try {
      if (active.aborted) stop();
      await owner.ready;
      await owner.joined;
      active.throwIfAborted();
      if (exit !== 0) throw new Error("The native background app could not confirm owned startup");
    } finally {
      active.removeEventListener("abort", stop);
      if (!owner.joinedConfirmed) await owner.stop();
    }
    return;
  }
  const entry = resolveSubprocessEntry("../index.ts", import.meta.url);
  const child = (dependencies.sourceSpawn ?? spawn)(
    entry.command,
    [...entry.args, "desktop", "daemon", ...desktopRestoreActivationArguments(activation)],
    { env, detached: true, stdio: "ignore" },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
