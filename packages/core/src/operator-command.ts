// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The command an operator types to reach this install's CLI, for the hints
 * that name one.
 *
 * Almost always `omnesis`. A native collector installed beside a Docker
 * install is the exception: `omnesis` there is the Docker install's launcher,
 * and this collector answers to its own front door, `omnesis-collector`, which
 * says so in `OMNESIS_CLI_COMMAND` for the CLI it starts and the daemon its
 * service runs. A hint about this host — restart this collector, arm its
 * keyring — names that command; a hint about the gateway host keeps `omnesis`.
 */
export const CLI_COMMAND_ENV = "OMNESIS_CLI_COMMAND";

/** This install's command: `OMNESIS_CLI_COMMAND` when it is a plain command name, else `omnesis`. */
export function operatorCommand(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[CLI_COMMAND_ENV]?.trim();
  return named && /^omnesis(?:-[a-z0-9]+)*$/u.test(named) ? named : "omnesis";
}
