// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { expect, test, vi } from "vitest";
import { runManagedKeyRecoveryCommand } from "./managed-key-recovery.js";
import { secureMarkerStateKeyName } from "./secure-marker.js";
import { defaultSecretCommandRunner } from "./index.js";
import type { ChildProcess } from "node:child_process";
import type { ManagedDesktopKeyRecoveryContext } from "./node-command.js";

const context: ManagedDesktopKeyRecoveryContext = {
  version: 1,
  scope: {
    format: 1,
    configDir: "/example/library",
    instance: `desktop-${"a".repeat(16)}`,
    secretService: `dev.omnesis.desktop.${"b".repeat(64)}`,
  },
  root: { device: "1", inode: "2" },
  update: null,
  restore: null,
};
function adapter(reply: { code: number; stdout: string; stderr: string }) {
  let input = Buffer.alloc(0);
  const invocation = vi.fn(() => ({
    command: "/example/runtime-exec",
    args: ["--key-recovery", Buffer.from(JSON.stringify(context)).toString("base64url")],
  }));
  const owned = vi.fn(
    (_command: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv }) => {
      const output = new PassThrough(),
        errors = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout: output,
        stderr: errors,
        stdin: new Writable({
          write(block, _encoding, done) {
            input = Buffer.concat([input, block]);
            done();
          },
          final(done) {
            queueMicrotask(() => {
              output.end(JSON.stringify(reply));
              child.emit("exit", 0);
              closed = true;
              finish();
              done();
            });
          },
        }),
      }) as unknown as ChildProcess;
      let finish!: () => void,
        closed = false;
      const joined = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        child,
        ready: Promise.resolve(),
        joined,
        get joinedConfirmed() {
          return closed;
        },
        stop: async () => {
          closed = true;
          finish();
        },
      };
    },
  );
  return { invocation, owned, request: () => JSON.parse(input.toString("utf8")) };
}
const rootArgs = (key: string) => [
  "add-generic-password",
  "-a",
  "install-root-key-v1",
  "-s",
  context.scope.secretService,
  "-l",
  "Omnesis install-root-key-v1",
  "-w",
  key,
];

test("recovered root travels only through private stdin, not native argv or environment", async () => {
  const os = adapter({ code: 0, stdout: "", stderr: "" });
  const key = `omn_root_v1_${"a".repeat(43)}`;
  await runManagedKeyRecoveryCommand("/usr/bin/security", rootArgs(key), context, os);
  expect(os.request()).toEqual({
    version: 1,
    operation: "insert-root",
    account: "install-root-key-v1",
    value: key,
  });
  const launch = os.owned.mock.calls[0];
  expect(launch?.[0]).toBe("/example/runtime-exec");
  expect(launch?.[1][0]).toBe("--key-recovery");
  expect(JSON.stringify(launch)).not.toContain(key);
  expect(os.invocation).toHaveBeenCalledWith(context);
});

test.each(["delete", "root-overwrite", "foreign-service", "foreign-account", "different-marker"])(
  "rejects %s before spawning",
  async (variant) => {
    const os = adapter({ code: 0, stdout: "", stderr: "" });
    const args = rootArgs(`omn_root_v1_${"a".repeat(43)}`);
    if (variant === "delete") args[0] = "delete-generic-password";
    if (variant === "root-overwrite") args.splice(7, 0, "-U");
    if (variant === "foreign-service") args[4] = "unrelated-service";
    if (variant === "foreign-account") args[2] = "unrelated-account";
    if (variant === "different-marker") {
      args[2] = secureMarkerStateKeyName("secret-files", context.scope.configDir);
      args[6] = `Omnesis ${args[2]}`;
      args.splice(7, 0, "-U");
      args[9] = "different";
    }
    await expect(runManagedKeyRecoveryCommand("security", args, context, os)).rejects.toThrow();
    expect(os.owned).not.toHaveBeenCalled();
  },
);

test("native unknown/locked read is not interpreted as absence", async () => {
  const os = adapter({ code: 1, stdout: "", stderr: "untrusted diagnostic" });
  await expect(
    runManagedKeyRecoveryCommand(
      "security",
      [
        "find-generic-password",
        "-a",
        "install-root-key-v1",
        "-s",
        context.scope.secretService,
        "-w",
      ],
      context,
      os,
    ),
  ).rejects.toThrow("will not treat unreadable key material as absent");
});

test("only actual item-not-found reply preserves ordinary missing-key semantics", async () => {
  const os = adapter({ code: 44, stdout: "", stderr: "" });
  await expect(
    runManagedKeyRecoveryCommand(
      "security",
      [
        "find-generic-password",
        "-a",
        "install-root-key-v1",
        "-s",
        context.scope.secretService,
        "-w",
      ],
      context,
      os,
    ),
  ).resolves.toEqual({ code: 44, stdout: "", stderr: "" });
});

test("marker repair translates to compare-or-add rather than arbitrary overwrite authority", async () => {
  const os = adapter({ code: 0, stdout: "", stderr: "" });
  const account = secureMarkerStateKeyName("secret-files", context.scope.configDir);
  await runManagedKeyRecoveryCommand(
    "security",
    [
      "add-generic-password",
      "-a",
      account,
      "-s",
      context.scope.secretService,
      "-l",
      `Omnesis ${account}`,
      "-U",
      "-w",
      "required",
    ],
    context,
    os,
  );
  expect(os.request()).toEqual({
    version: 1,
    operation: "repair-marker",
    account,
    value: "required",
  });
});

function retainedAdapter(stopFailure = false) {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const stdin = new Writable({
    write(_block, _encoding, done) {
      done();
    },
    final() {
      /* The OS close may arrive without this callback. */
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
  }) as unknown as ChildProcess;
  let joinedConfirmed = false;
  let resolveJoin!: () => void;
  const joined = new Promise<void>((resolve) => {
    resolveJoin = resolve;
  });
  const stop = vi.fn(() =>
    stopFailure
      ? Promise.reject(
          Object.assign(new Error("private fixture sentinel"), { cleanupFailure: "fixture" }),
        )
      : joined,
  );
  return {
    child,
    stdin,
    stdout,
    stop,
    invocation: () => ({
      command: "/example/runtime-exec",
      args: ["--key-recovery", "metadata-only"],
    }),
    owned: () => ({
      child,
      ready: Promise.resolve(),
      joined,
      get joinedConfirmed() {
        return joinedConfirmed;
      },
      stop,
    }),
    join() {
      child.emit("exit", 0);
      joinedConfirmed = true;
      resolveJoin();
    },
  };
}

test.each(["timeout", "overflow", "stdin-error"])(
  "%s cannot return before physical join or hang waiting for a lost stdin callback",
  async (failure) => {
    vi.useFakeTimers();
    const os = retainedAdapter();
    let finished = false,
      error: unknown;
    const work = runManagedKeyRecoveryCommand("security", ["-h"], context, os).then(
      () => {
        finished = true;
      },
      (caught) => {
        finished = true;
        error = caught;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(45_000);
      else if (failure === "overflow") os.stdout.write(Buffer.alloc(8193, 65));
      else os.stdin.emit("error", new Error("private fixture sentinel"));
      await vi.advanceTimersByTimeAsync(0);
      expect(os.stop).toHaveBeenCalled();
      expect(finished).toBe(false);
      os.join();
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true);
      await work;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private fixture sentinel");
      expect(String(error)).not.toContain("AAAA");
    } finally {
      os.join();
      vi.useRealTimers();
    }
  },
);

test("unconfirmed cleanup propagates a sanitized ownership marker without private native output", async () => {
  vi.useFakeTimers();
  const os = retainedAdapter(true);
  let finished = false,
    error: unknown;
  const work = runManagedKeyRecoveryCommand("security", ["-h"], context, os).catch((caught) => {
    finished = true;
    error = caught;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    os.stdout.write(Buffer.alloc(8193, 65));
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await work;
    expect(error).toMatchObject({ cleanupFailure: "managed-key-recovery" });
    expect(String(error)).not.toContain("private fixture sentinel");
    expect(String(error)).not.toContain("AAAA");
  } finally {
    os.join();
    vi.useRealTimers();
  }
});

test("invalid private JSON is refused only after actual native close", async () => {
  vi.useFakeTimers();
  const os = retainedAdapter();
  let finished = false,
    error: unknown;
  const work = runManagedKeyRecoveryCommand("security", ["-h"], context, os).catch((caught) => {
    finished = true;
    error = caught;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    os.stdout.write("private fixture sentinel");
    expect(finished).toBe(false);
    os.join();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await work;
    expect(String(error)).not.toContain("private fixture sentinel");
  } finally {
    os.join();
    vi.useRealTimers();
  }
});

test("the public core facade exposes the scoped recovery runner and refuses an unregistered native controller", async () => {
  await expect(
    defaultSecretCommandRunner("security", ["-h"], { keyRecovery: context }),
  ).rejects.toThrow("original library key recovery could not be confirmed");
});
