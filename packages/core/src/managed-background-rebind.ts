// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename, isAbsolute, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { managedRuntimeLauncherContext, type NodeCommandInvocation } from "./node-command.js";

export interface ManagedDesktopBackgroundScope {
  format: 1;
  configDir: string;
  instance: string;
  secretService: string;
}
export interface ManagedDesktopBackgroundBinding {
  version: 1;
  scope: ManagedDesktopBackgroundScope;
  epoch: string;
  pid: number;
  birth: { seconds: string; microseconds: string };
  origin:
    | { state: "verified" | "unavailable" }
    | {
        state: "pending";
        client: { pid: number; birth: { seconds: string; microseconds: string } };
      };
}
type Profile = Omit<ManagedDesktopBackgroundScope, "format">;
const epoch = /^[a-f0-9]{64}$/u;
const failure = () => new Error("The native background application binding could not be verified");
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === keys.sort().join("\0"),
  );
}
function scope(value: unknown): value is ManagedDesktopBackgroundScope {
  return (
    exact(value, ["format", "configDir", "instance", "secretService"]) &&
    value.format === 1 &&
    typeof value.configDir === "string" &&
    isAbsolute(value.configDir) &&
    resolve(value.configDir) === value.configDir &&
    typeof value.instance === "string" &&
    /^desktop-[a-f0-9]{16}$/u.test(value.instance) &&
    typeof value.secretService === "string" &&
    /^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(value.secretService)
  );
}
function birth(value: unknown): boolean {
  return (
    exact(value, ["seconds", "microseconds"]) &&
    typeof value.seconds === "string" &&
    /^(0|[1-9]\d{0,19})$/u.test(value.seconds) &&
    typeof value.microseconds === "string" &&
    /^(0|[1-9]\d{0,5})$/u.test(value.microseconds) &&
    Number(value.microseconds) < 1_000_000
  );
}
function origin(value: unknown): boolean {
  if (exact(value, ["state"]) && (value.state === "verified" || value.state === "unavailable"))
    return true;
  return (
    exact(value, ["state", "client"]) &&
    value.state === "pending" &&
    exact(value.client, ["pid", "birth"]) &&
    Number.isSafeInteger(value.client.pid) &&
    Number(value.client.pid) > 1 &&
    Number(value.client.pid) <= 2_147_483_647 &&
    birth(value.client.birth)
  );
}
/** Parsing is not authentication: only the fixed native query supplies an authenticated binding. */
export function parseManagedDesktopBackgroundBinding(
  value: unknown,
  configDir: string,
): ManagedDesktopBackgroundBinding {
  if (
    !exact(value, ["version", "scope", "epoch", "pid", "birth", "origin"]) ||
    value.version !== 1 ||
    !scope(value.scope) ||
    value.scope.configDir !== configDir ||
    typeof value.epoch !== "string" ||
    !epoch.test(value.epoch) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 2 ||
    !exact(value.birth, ["seconds", "microseconds"]) ||
    typeof value.birth.seconds !== "string" ||
    !/^(0|[1-9]\d{0,19})$/u.test(value.birth.seconds) ||
    typeof value.birth.microseconds !== "string" ||
    !/^(0|[1-9]\d{0,5})$/u.test(value.birth.microseconds) ||
    Number(value.birth.microseconds) >= 1_000_000 ||
    !origin(value.origin)
  )
    throw failure();
  return structuredClone(value) as unknown as ManagedDesktopBackgroundBinding;
}
function invocation(
  profile: Profile,
  sourceMetaUrl: string,
  expected?: ManagedDesktopBackgroundBinding,
): NodeCommandInvocation | null {
  const context = managedRuntimeLauncherContext();
  if (!context) {
    if (process.platform === "darwin" && !new URL(sourceMetaUrl).pathname.endsWith(".ts"))
      throw failure();
    return null;
  }
  const target = { format: 1 as const, ...profile },
    currentEpoch = basename(context.root);
  if (
    !isMainThread ||
    context.data ||
    context.backgroundOwner !== undefined ||
    context.backgroundRetirement !== undefined ||
    !scope(target) ||
    !epoch.test(currentEpoch)
  )
    throw failure();
  const previous = expected
    ? parseManagedDesktopBackgroundBinding(expected, profile.configDir)
    : undefined;
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      scope: target,
      epoch: currentEpoch,
      ...(previous
        ? {
            expected: {
              scope: previous.scope,
              epoch: previous.epoch,
              pid: previous.pid,
              birth: previous.birth,
              origin: previous.origin,
            },
          }
        : {}),
    }),
  );
  if (bytes.length > 4096) throw failure();
  return {
    command: context.launcher,
    args: [previous ? "--background-rebind" : "--background-binding", bytes.toString("base64url")],
  };
}
/** DATA-free authenticated native metadata query; never starts or adopts a daemon. */
export function managedDesktopBackgroundBindingInvocation(
  profile: Profile,
  sourceMetaUrl: string,
): NodeCommandInvocation | null {
  return invocation(profile, sourceMetaUrl);
}
/** Caller validates a durable portable handoff; native independently authenticates the exact peer. */
export function managedDesktopBackgroundRebindInvocation(
  profile: Profile,
  expected: ManagedDesktopBackgroundBinding,
  sourceMetaUrl: string,
): NodeCommandInvocation | null {
  return invocation(profile, sourceMetaUrl, expected);
}
