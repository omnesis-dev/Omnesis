// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stripVTControlCharacters } from "node:util";
import { spawn } from "@lydell/node-pty";

/** A real terminal on every host, with literal argv and joined native cleanup. */
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
