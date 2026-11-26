// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  managedDesktopKeyRecoveryInvocation,
  type ManagedDesktopKeyRecoveryContext,
} from "./node-command.js";
import { spawnOwnedChildProcess } from "./owned-child-process.js";
import { secureMarkerStateKeyName } from "./secure-marker.js";
import { SecretPathUnreadableError } from "./security-files.js";
import type { SecretCommandResult } from "./secret-store.js";

const refused = () => new Error("The original library key recovery could not be confirmed");
interface RecoveryRequest {
  version: 1;
  operation: "probe" | "find" | "read" | "insert-root" | "repair-marker";
  account?: string;
  value?: string;
}
function requestFor(
  cmd: string,
  args: readonly string[],
  context: ManagedDesktopKeyRecoveryContext,
): RecoveryRequest {
  if (!["security", "/usr/bin/security"].includes(cmd)) throw refused();
  if (args.length === 1 && args[0] === "-h") return { version: 1, operation: "probe" };
  const root = "install-root-key-v1";
  const markers = ["storage-encryption", "secret-files"].map((kind) =>
    secureMarkerStateKeyName(
      kind as "storage-encryption" | "secret-files",
      context.scope.configDir,
    ),
  );
  const account = args[2];
  if (
    args[1] !== "-a" ||
    !account ||
    ![root, ...markers].includes(account) ||
    args[3] !== "-s" ||
    args[4] !== context.scope.secretService
  )
    throw refused();
  if (
    args[0] === "find-generic-password" &&
    (args.length === 5 || (args.length === 6 && args[5] === "-w"))
  )
    return { version: 1, operation: args.length === 5 ? "find" : "read", account };
  if (args[0] !== "add-generic-password" || args[5] !== "-l" || args[6] !== `Omnesis ${account}`)
    throw refused();
  if (
    account === root &&
    args.length === 9 &&
    args[7] === "-w" &&
    /^omn_root_v1_[A-Za-z0-9_-]{43}$/u.test(args[8]!)
  )
    return { version: 1, operation: "insert-root", account, value: args[8] };
  if (
    markers.includes(account) &&
    args.length === 10 &&
    args[7] === "-U" &&
    args[8] === "-w" &&
    args[9] === "required"
  )
    return { version: 1, operation: "repair-marker", account, value: "required" };
  throw refused();
}

/** The legacy key-store interface is translated into fixed native operations; secrets travel only on stdin. */
export async function runManagedKeyRecoveryCommand(
  command: string,
  args: readonly string[],
  context: ManagedDesktopKeyRecoveryContext,
  dependencies: {
    invocation?: typeof managedDesktopKeyRecoveryInvocation;
    owned?: typeof spawnOwnedChildProcess;
  } = {},
): Promise<SecretCommandResult> {
  const request = requestFor(command, args, context);
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 4096) {
    bytes.fill(0);
    throw refused();
  }
  let owner: ReturnType<typeof spawnOwnedChildProcess>;
  try {
    const invocation = (dependencies.invocation ?? managedDesktopKeyRecoveryInvocation)(context);
    owner = (dependencies.owned ?? spawnOwnedChildProcess)(invocation.command, invocation.args, {
      env: process.env,
    });
  } catch {
    bytes.fill(0);
    throw refused();
  }
  let output = Buffer.alloc(0),
    invalid = false,
    exit: number | null = null;
  const stopFailed = Promise.withResolvers<never>();
  // Ownership errors may contain provider/output details; expose only a fixed marker.
  const cleanupUnconfirmed = () =>
    Object.assign(refused(), { cleanupFailure: "managed-key-recovery" });
  void stopFailed.promise.catch(() => undefined);
  const stop = () => {
    void owner.stop().catch(() => stopFailed.reject(cleanupUnconfirmed()));
  };
  const timer = setTimeout(() => {
    invalid = true;
    stop();
  }, 45_000);
  timer.unref();
  owner.child.stderr?.resume();
  owner.child.stdout?.on("data", (block: Buffer) => {
    if (output.length + block.length > 8192) {
      invalid = true;
      stop();
    } else output = Buffer.concat([output, block]);
  });
  owner.child.once("exit", (code) => {
    exit = code;
  });
  owner.child.stdin?.on("error", () => {
    invalid = true;
    stop();
  });
  let result: SecretCommandResult | undefined;
  let failure: unknown;
  let failed = false;
  try {
    await Promise.race([owner.ready, stopFailed.promise]);
    const sent = new Promise<void>((resolve, reject) => {
      if (!owner.child.stdin) return reject(refused());
      owner.child.stdin.end(bytes, (error?: Error | null) =>
        error ? reject(refused()) : resolve(),
      );
    });
    // A dead child or failed stream need not deliver its writable callback.
    // Physical close (or an explicit uncertain-cleanup failure) must also unblock this wait.
    await Promise.race([sent, owner.joined, stopFailed.promise]);
    await Promise.race([owner.joined, stopFailed.promise]);
    if (invalid || exit !== 0) throw refused();
    let reply: unknown;
    try {
      reply = JSON.parse(output.toString("utf8"));
    } catch {
      throw refused();
    }
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw refused();
    const record = reply as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "code,stderr,stdout" ||
      !Number.isInteger(record.code) ||
      typeof record.stdout !== "string" ||
      typeof record.stderr !== "string"
    )
      throw refused();
    if (
      record.code !== 0 &&
      !(record.code === 44 && ["find", "read"].includes(request.operation))
    ) {
      if (["find", "read"].includes(request.operation))
        throw new SecretPathUnreadableError("the scoped Keychain item", refused());
      throw refused();
    }
    if ((record.code === 44 || request.operation !== "read") && record.stdout !== "")
      throw refused();
    result = { code: record.code as number, stdout: record.stdout, stderr: "" };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    bytes.fill(0);
    output.fill(0);
    clearTimeout(timer);
    if (!owner.joinedConfirmed) {
      try {
        await owner.stop();
      } catch {
        failed = true;
        failure = cleanupUnconfirmed();
      }
    }
  }
  if (failed) throw failure;
  if (!result) throw refused();
  return result;
}
