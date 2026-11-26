// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  managedDesktopBackgroundBindingInvocation,
  managedDesktopBackgroundRebindInvocation,
  parseManagedDesktopBackgroundBinding,
  spawnOwnedChildProcess,
  type NodeCommandInvocation,
} from "@omnesis/core";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import { desktopRuntimeEpoch } from "./update-state.js";
import {
  validateDesktopBackgroundHandoff,
  type DesktopBackgroundHandoff,
} from "./background-rebind-policy.js";

interface Operations {
  query: typeof managedDesktopBackgroundBindingInvocation;
  invocation: typeof managedDesktopBackgroundRebindInvocation;
  owned: typeof spawnOwnedChildProcess;
  epoch: typeof desktopRuntimeEpoch;
  validate: typeof validateDesktopBackgroundHandoff;
}
const failed = () => new Error("The verified background application handoff could not finish");
/** A private bounded native reply; cancellation retains physical ownership until actual close. */
async function nativeCommand(
  profile: DesktopProfile,
  invocation: NodeCommandInvocation,
  signal: AbortSignal,
  ops: Operations,
): Promise<string> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  active.throwIfAborted();
  const owner = ops.owned(invocation.command, invocation.args, {
    env: desktopEnvironment(profile),
  });
  let bytes = 0,
    overflow = false,
    exit: number | null = null;
  const chunks: Buffer[] = [];
  const stop = () => {
    void owner.stop().catch(() => undefined);
  };
  const output = (chunk: Buffer | string) => {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 4096) {
      overflow = true;
      stop();
    } else chunks.push(value);
  };
  owner.child.stdout?.on("data", output);
  owner.child.stderr?.resume();
  owner.child.once("exit", (code) => {
    exit = code;
  });
  owner.child.stdin?.end();
  active.addEventListener("abort", stop, { once: true });
  try {
    if (active.aborted) stop();
    await owner.ready;
    await owner.joined;
    active.throwIfAborted();
    if (overflow || exit !== 0) throw failed();
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    active.removeEventListener("abort", stop);
    owner.child.stdout?.off("data", output);
    if (!owner.joinedConfirmed) await owner.stop();
  }
}
/** Explicit user setup/connect only. A mismatch is never itself permission to replace a helper. */
export async function prepareDesktopBackgroundHandoff(
  profile: DesktopProfile,
  signal: AbortSignal,
  dependencies: Partial<Operations> = {},
): Promise<DesktopBackgroundHandoff | null> {
  const ops: Operations = {
    query: managedDesktopBackgroundBindingInvocation,
    invocation: managedDesktopBackgroundRebindInvocation,
    owned: spawnOwnedChildProcess,
    epoch: desktopRuntimeEpoch,
    validate: validateDesktopBackgroundHandoff,
    ...dependencies,
  };
  signal.throwIfAborted();
  const query = ops.query(profile, import.meta.url);
  if (!query) return null; // Explicit unregistered source adapter only.
  const epoch = ops.epoch();
  if (!epoch) throw failed();
  const text = await nativeCommand(profile, query, signal, ops);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw failed();
  }
  const binding = parseManagedDesktopBackgroundBinding(value, profile.configDir);
  const session = await acquireDesktopRestoreSessionLease(profile, signal);
  try {
    const plan = await withDesktopInstallLease(profile, signal, () =>
      ops.validate(profile, epoch, binding, signal),
    );
    const same =
      binding.epoch === epoch &&
      binding.scope.instance === profile.instance &&
      binding.scope.secretService === profile.secretService;
    if (same && binding.origin.state === "verified") return plan;
    if (!plan) throw failed();
    // No install/runtime/EX lease crosses the native drain-and-relaunch operation.
    const invocation = ops.invocation(profile, binding, import.meta.url);
    if (!invocation) throw failed();
    const reply = await nativeCommand(profile, invocation, signal, ops);
    if (reply.length !== 0) throw failed();
    return plan;
  } finally {
    session.release();
  }
}
