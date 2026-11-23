// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** How many arguments a diagnostic command line shows before it stops. */
const DESCRIBED_ARGUMENTS = 12;

/** A flag name alone, or a plain lowercase word such as a subcommand or plugin id. */
const PLAIN_ARGUMENT = /^(?:--?[A-Za-z][A-Za-z0-9-]*|[a-z]+(?:[-.][a-z]+)*)$/u;

/** An absolute or explicitly relative path, or a `file:` URL. */
const PATH_ARGUMENT = /^(?:[a-z]:[\\/]|[\\/]|\.{1,2}[\\/]|file:)/iu;

/** A file name with an extension, such as a script, executable or archive. */
const FILE_NAME = /^[\w@+-][\w.@+-]*\.[a-z0-9]{1,8}$/iu;

function fileName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}

function describedArgument(argument: string): string {
  const assignment = /^(--?[a-z][a-z0-9-]*)=/iu.exec(argument);
  if (assignment) return `${assignment[1]}=…`;
  if (PLAIN_ARGUMENT.test(argument)) return argument;
  // A path shows only its file name, and only when that is a plain one:
  // a directory, a URL or an encoded value is elided like any other value.
  const name = PATH_ARGUMENT.test(argument) ? fileName(argument) : "";
  return FILE_NAME.test(name) ? name : "…";
}

/**
 * A command line that is safe to print in a diagnostic. It names the program
 * and any script by file name, keeps flag names and plain lowercase words such
 * as subcommands, and elides every other value, so a token, code or address
 * passed as an argument never reaches a log. `--name=value` keeps its name.
 */
export function describeCommandForDiagnostics(command: string, args: readonly string[]): string {
  const program = fileName(command);
  const words = [FILE_NAME.test(program) || PLAIN_ARGUMENT.test(program) ? program : "…"];
  for (const argument of args.slice(0, DESCRIBED_ARGUMENTS))
    words.push(describedArgument(argument));
  if (args.length > DESCRIBED_ARGUMENTS) words.push("…");
  return words.join(" ");
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/**
 * The error a buffered command run raises when it reaches its time limit. It
 * names the command, the limit and how long the command had run, and keeps the
 * `ETIMEDOUT` code and `killed` flag callers match on.
 */
export function commandTimeoutError(
  command: string,
  args: readonly string[],
  limitMs: number,
  elapsedMs: number,
  phase: "running" | "starting" = "running",
): Error & { code: "ETIMEDOUT"; killed: true } {
  const what = phase === "starting" ? "timed out before it started" : "timed out";
  return Object.assign(
    new Error(
      `Command ${what} after ${seconds(elapsedMs)} (limit ${seconds(limitMs)}): ${describeCommandForDiagnostics(command, args)}`,
    ),
    { code: "ETIMEDOUT" as const, killed: true as const },
  );
}
