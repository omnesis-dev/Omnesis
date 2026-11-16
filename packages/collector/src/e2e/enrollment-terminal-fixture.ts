// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnOwnedChildProcess } from "@omnesis/core";
import { spawn } from "@lydell/node-pty";

/** Real terminals and literal argv; Windows joins its kernel-owned descendants. */
export function runEnrollmentTerminal(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): {
  proc: { readonly exitCode: number | null };
  stdout(): string;
  stderr(): string;
  exit: Promise<number>;
  closed(): boolean;
  kill(): Promise<void>;
} {
  if (process.platform === "win32") return runWindowsTerminal(command, args, options);
  const terminal = spawn(command, [...args], {
    cwd: options.cwd,
    env: Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    name: "xterm-256color",
    cols: 1024,
    rows: 40,
  });
  let output = "";
  let code: number | null = null;
  let closed = false;
  terminal.onData((bytes) => {
    output += bytes;
  });
  const exit = new Promise<number>((resolve) =>
    terminal.onExit((event) => {
      code = event.exitCode;
      closed = true;
      resolve(code);
    }),
  );
  return {
    proc: {
      get exitCode() {
        return code;
      },
    },
    stdout: () => stripVTControlCharacters(output),
    stderr: () => stripVTControlCharacters(output),
    exit,
    closed: () => closed,
    async kill() {
      if (!closed) terminal.kill();
      await exit;
    },
  };
}

/** A terminal exit is not physical closure of its detached descendants. */
function runWindowsTerminal(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ReturnType<typeof runEnrollmentTerminal> {
  const wrapper = fileURLToPath(new URL("./enrollment-terminal-wrapper.mjs", import.meta.url));
  const owner = spawnOwnedChildProcess(process.execPath, [wrapper, command, ...args], {
    ...options,
    stopSignal: "SIGKILL",
  });
  let output = "";
  let code: number | null = null;
  let closed = false;
  owner.child.stdout!.setEncoding("utf8").on("data", (bytes: string) => {
    output += bytes.toString();
  });
  owner.child.stderr!.setEncoding("utf8").on("data", (bytes: string) => {
    output += bytes.toString();
  });
  const rawClose = new Promise<number | null>((resolve) => owner.child.once("close", resolve));
  const exit = (async () => {
    const [result, joined, ready] = await Promise.allSettled([rawClose, owner.joined, owner.ready]);
    if (result.status === "fulfilled") code = result.value;
    closed = owner.joinedConfirmed;
    const failures = [result, joined, ready].flatMap((value) =>
      value.status === "rejected" ? [value.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Enrollment terminal did not close cleanly");
    return code ?? 1;
  })();
  void exit.catch(() => {});
  return {
    proc: {
      get exitCode() {
        return code;
      },
    },
    stdout: () => stripVTControlCharacters(output),
    stderr: () => stripVTControlCharacters(output),
    exit,
    closed: () => closed,
    async kill() {
      await owner.stop();
      await exit;
    },
  };
}
