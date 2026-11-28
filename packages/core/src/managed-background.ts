// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { isMainThread } from "node:worker_threads";
import { fstatSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  managedRuntimeLauncherContext,
  type ManagedDesktopDataScope,
  type NodeCommandInvocation,
} from "./node-command.js";

type Scope = Pick<ManagedDesktopDataScope, "configDir" | "instance" | "secretService">;
export interface ManagedDesktopBackgroundActivation {
  operationId: string;
  attemptId: string;
  epoch: string | null;
}
export interface ManagedDesktopBackgroundOwner {
  format: 1;
  scope: Scope & { format: 1 };
  epoch: string;
  nonce: string;
  helperPid: number;
  daemonPid: number;
  pipe: { device: string; inode: string };
}
const epochPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fail = () => new Error("The desktop background process requires its verified native owner");
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"),
  );
}
function scopeMatches(value: unknown, expected: Scope): boolean {
  return (
    object(value, ["format", "configDir", "instance", "secretService"]) &&
    value.format === 1 &&
    value.configDir === expected.configDir &&
    value.instance === expected.instance &&
    value.secretService === expected.secretService &&
    typeof value.configDir === "string" &&
    isAbsolute(value.configDir) &&
    resolve(value.configDir) === value.configDir &&
    typeof value.instance === "string" &&
    /^desktop-[a-f0-9]{16}$/u.test(value.instance) &&
    typeof value.secretService === "string" &&
    /^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(value.secretService)
  );
}

/** Compiled macOS must never treat an omitted preload as an explicit source adapter. */
export function managedDesktopBackgroundRequired(sourceMetaUrl: string): boolean {
  return (
    managedRuntimeLauncherContext() !== undefined ||
    (process.platform === "darwin" && !new URL(sourceMetaUrl).pathname.endsWith(".ts"))
  );
}

/** A fixed native client; only truly unregistered source/Linux execution may use its source adapter. */
export function managedDesktopBackgroundStartInvocation(
  scope: Scope,
  activation: ManagedDesktopBackgroundActivation | undefined,
  sourceMetaUrl: string,
): NodeCommandInvocation | null {
  const context = managedRuntimeLauncherContext();
  if (!context) {
    if (managedDesktopBackgroundRequired(sourceMetaUrl)) throw fail();
    return null;
  }
  const ownedScope = {
    format: 1 as const,
    configDir: scope.configDir,
    instance: scope.instance,
    secretService: scope.secretService,
  };
  const epoch = basename(context.root);
  if (
    !isMainThread ||
    context.data ||
    context.backgroundRetirement !== undefined ||
    !scopeMatches(ownedScope, scope) ||
    !epochPattern.test(epoch)
  )
    throw fail();
  if (
    activation &&
    (!object(activation, ["operationId", "attemptId", "epoch"]) ||
      !uuidPattern.test(activation.operationId) ||
      !uuidPattern.test(activation.attemptId) ||
      activation.epoch !== epoch)
  )
    throw fail();
  const request = { version: 1, scope: ownedScope, epoch, ...(activation ? { activation } : {}) };
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 4096) throw fail();
  return { command: context.launcher, args: ["--background-start", bytes.toString("base64url")] };
}

/** Local shape/lifetime checks are necessary but are not a native signature attestation. */
function assertBackgroundOwner(scope: Scope, retirement: boolean): ManagedDesktopBackgroundOwner {
  const context = managedRuntimeLauncherContext(),
    value = retirement ? context?.backgroundRetirement : context?.backgroundOwner;
  if (
    !isMainThread ||
    !context ||
    context.data ||
    (retirement
      ? context.backgroundOwner !== undefined
      : context.backgroundRetirement !== undefined) ||
    !object(value, ["format", "scope", "epoch", "nonce", "helperPid", "daemonPid", "pipe"]) ||
    value.format !== 1 ||
    !scopeMatches(value.scope, scope) ||
    value.epoch !== basename(context.root) ||
    typeof value.epoch !== "string" ||
    !epochPattern.test(value.epoch) ||
    typeof value.nonce !== "string" ||
    !uuidPattern.test(value.nonce) ||
    value.helperPid !== process.ppid ||
    value.daemonPid !== process.pid ||
    !Number.isSafeInteger(value.helperPid) ||
    Number(value.helperPid) < 1 ||
    !object(value.pipe, ["device", "inode"]) ||
    typeof value.pipe.device !== "string" ||
    !/^\d+$/u.test(value.pipe.device) ||
    typeof value.pipe.inode !== "string" ||
    !/^\d+$/u.test(value.pipe.inode)
  )
    throw fail();
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw fail();
  const pipe = fstatSync(0, { bigint: true });
  if (
    !pipe.isFIFO() ||
    pipe.dev.toString() !== value.pipe.device ||
    pipe.ino.toString() !== value.pipe.inode
  )
    throw fail();
  return structuredClone(value) as unknown as ManagedDesktopBackgroundOwner;
}

/** A daemon hint cannot authorize retirement, or vice versa. */
export function assertManagedDesktopBackgroundOwner(scope: Scope): ManagedDesktopBackgroundOwner {
  return assertBackgroundOwner(scope, false);
}

function verifyBackgroundOwner(scope: Scope, retirement: boolean): ManagedDesktopBackgroundOwner {
  const owner = assertBackgroundOwner(scope, retirement),
    context = managedRuntimeLauncherContext();
  if (!context) throw fail();
  const result = spawnSync(
    context.launcher,
    [
      retirement ? "--verify-background-retirement" : "--verify-background-owner",
      Buffer.from(JSON.stringify(owner)).toString("base64url"),
    ],
    { stdio: [0, "ignore", "ignore"], timeout: 10000, killSignal: "SIGKILL", windowsHide: true },
  );
  if (result.error || result.signal || result.status !== 0) throw fail();
  return assertBackgroundOwner(scope, retirement);
}

/** Re-check the actual caller/helper code chain natively; public metadata is not authority. */
export function verifyManagedDesktopBackgroundOwner(scope: Scope): ManagedDesktopBackgroundOwner {
  return verifyBackgroundOwner(scope, false);
}

/** A fixed retirement entry must prove its own signed helper parent and live lifetime pipe. */
export function verifyManagedDesktopBackgroundRetirement(
  scope: Scope,
): ManagedDesktopBackgroundOwner {
  return verifyBackgroundOwner(scope, true);
}
