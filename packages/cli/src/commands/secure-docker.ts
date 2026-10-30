// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What `omnesis secure` does differently inside a Docker install.
 *
 * A container has no OS keyring, so the secret store is the passphrase
 * backend, and its passphrase has to be a file the daemons can read at start:
 * one inside the config directory every container mounts, recorded in the
 * `.env` they load. When none is configured, the wizard generates it the way
 * the installer does — `<config>/keyring.pass`, 32 random bytes,
 * owner-only from creation — and records it.
 *
 * The other difference is the restart. The daemons that must start with the
 * new keyring run in containers, and the container this command runs in
 * cannot restart itself. The host launcher the installer writes tells this
 * command it will restart them (`OMNESIS_DOCKER_HOST_RESTART`); the command
 * then leaves the services in a request file beside the compose file, the
 * launcher restarts them from the host and runs `omnesis secure --verify`.
 * Without that launcher, the command names the exact host command instead.
 */

import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseDotEnv, upsertDotEnv } from "@omnesis/config";
import {
  atomicWriteFileSync,
  parseSecretStoreBackend,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  type SecretStoreBackend,
} from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "../utils.js";
import { detectDockerContext, isWithinDir, type DockerContext } from "../docker-install.js";

/** Set by the host launcher on a `secure` run whose restart it performs. */
export const DOCKER_HOST_RESTART_ENV = "OMNESIS_DOCKER_HOST_RESTART";
/** Beside the compose file: the services the launcher restarts, one per line. */
export const SECURE_RESTART_REQUEST_FILE = "secure-restart";
/** Where the installer, and this wizard, put a generated passphrase. */
export const DOCKER_PASSPHRASE_FILE = "keyring.pass";

const SECRET_STORE_ENV = "OMNESIS_SECRET_STORE";

export interface DockerSecureContext extends DockerContext {
  /** The host launcher restarts the services once this command succeeds. */
  hostRestart: boolean;
}

export function dockerSecureContext(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DockerSecureContext | null {
  const docker = detectDockerContext(configDir);
  if (!docker) return null;
  return { ...docker, hostRestart: env[DOCKER_HOST_RESTART_ENV] === "1" };
}

/**
 * The backend a Docker install secures with: the one asked for, else the one
 * configured, else the passphrase backend — `auto` would look for an OS
 * keyring no container has.
 */
export function dockerSecureBackend(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SecretStoreBackend {
  if (requested) return parseSecretStoreBackend(requested);
  const configured = env[SECRET_STORE_ENV];
  if (configured && configured !== "auto") return parseSecretStoreBackend(configured);
  return "passphrase";
}

/** How this run reaches a passphrase the daemons can read too. */
export type DockerPassphrasePlan =
  /** Configured where the daemons read it; nothing to write. */
  | { kind: "configured"; file: string | null }
  /** A file named in this command's environment, still to be recorded in `.env`. */
  | { kind: "record"; file: string }
  /** `<config>/keyring.pass` already exists; it is recorded and used. */
  | { kind: "reuse"; file: string }
  /** No passphrase anywhere: one is generated at `file` and recorded. */
  | { kind: "generate"; file: string };

function readDotEnv(dir: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(join(dir, ".env"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Decide where the passphrase comes from, refusing one the containers could
 * not see: an inline passphrase exported for this one command, or a file
 * outside the mounted config directory, would leave the daemons unable to
 * open what this command sealed.
 */
export function planDockerPassphrase(
  docker: DockerContext,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DockerPassphrasePlan {
  const recorded = readDotEnv(configDir);
  const recordedStore = recorded[SECRET_STORE_ENV] === "passphrase";
  if (env[PASSPHRASE_ENV] !== undefined) {
    if (recorded[PASSPHRASE_ENV] !== undefined && recordedStore) {
      return { kind: "configured", file: null };
    }
    throw new CliError(
      `$${PASSPHRASE_ENV} reaches this command only; the containers read their passphrase ` +
        `from a file. Unset it and run \`omnesis secure\` again to generate one in ` +
        `${docker.projectDir}, or point $${PASSPHRASE_FILE_ENV} at an owner-only file inside it.`,
      EXIT_USER_ERROR,
    );
  }
  const file = env[PASSPHRASE_FILE_ENV];
  if (file) {
    if (!isWithinDir(file, docker.projectDir)) {
      throw new CliError(
        `The keyring passphrase file ${file} is outside ${docker.projectDir}, the one directory ` +
          `the containers see. Move it inside and point $${PASSPHRASE_FILE_ENV} there.`,
        EXIT_USER_ERROR,
      );
    }
    if (!existsSync(file)) {
      throw new CliError(`The keyring passphrase file ${file} does not exist.`, EXIT_USER_ERROR);
    }
    return recordedStore && recorded[PASSPHRASE_FILE_ENV] === file
      ? { kind: "configured", file }
      : { kind: "record", file };
  }
  const generated = join(docker.projectDir, DOCKER_PASSPHRASE_FILE);
  if (existsSync(generated)) {
    if (statSync(generated).size === 0) {
      throw new CliError(
        `${generated} is empty. Remove it and run \`omnesis secure\` again to generate a passphrase there.`,
        EXIT_USER_ERROR,
      );
    }
    return { kind: "reuse", file: generated };
  }
  return { kind: "generate", file: generated };
}

/**
 * A fresh passphrase at `path`: 32 random bytes, base64url, exactly as the
 * installer writes one. Created owner-only and exclusively, so there is never
 * a readable window and never a second writer's passphrase overwritten.
 */
export function writeGeneratedPassphrase(path: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("base64url"));
  } finally {
    closeSync(fd);
  }
}

/**
 * Make the passphrase reachable by this process: write it when it is
 * generated, and point this process's secret store at it. Nothing the daemons
 * read changes yet — see `recordDockerPassphrase`.
 */
export function prepareDockerPassphrase(
  plan: DockerPassphrasePlan,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (plan.kind === "generate") writeGeneratedPassphrase(plan.file);
  env[SECRET_STORE_ENV] = "passphrase";
  if (plan.file) env[PASSPHRASE_FILE_ENV] = plan.file;
}

/**
 * Record the passphrase in the `.env` the daemons load, so they start with
 * it. A host that only collects records it beside the compose file too, as
 * the installer does. Run after the backup: until then nothing the daemons
 * read has changed.
 */
export function recordDockerPassphrase(
  plan: DockerPassphrasePlan,
  docker: DockerContext,
  configDir: string,
): boolean {
  if (plan.kind === "configured") return false;
  const updates = { [SECRET_STORE_ENV]: "passphrase", [PASSPHRASE_FILE_ENV]: plan.file };
  upsertDotEnv(configDir, updates);
  if (docker.collectorOnly) upsertDotEnv(docker.projectDir, updates);
  return true;
}

/** Record a non-passphrase backend the operator chose, so the daemons use it too. */
export function recordDockerBackend(
  backend: SecretStoreBackend,
  docker: DockerContext,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (backend === "auto" || readDotEnv(configDir)[SECRET_STORE_ENV] === backend) return false;
  upsertDotEnv(configDir, { [SECRET_STORE_ENV]: backend });
  if (docker.collectorOnly) upsertDotEnv(docker.projectDir, { [SECRET_STORE_ENV]: backend });
  env[SECRET_STORE_ENV] = backend;
  return true;
}

/** The command an operator runs on the host to restart these services. */
export function dockerRestartCommand(docker: DockerContext): string {
  return `docker compose -f ${docker.composeFile} restart ${docker.services.join(" ")}`;
}

/** Leave the services for the host launcher to restart once this command exits. */
export function writeRestartRequest(docker: DockerContext): string {
  const path = join(docker.projectDir, SECURE_RESTART_REQUEST_FILE);
  atomicWriteFileSync(path, `${docker.services.join("\n")}\n`, { mode: 0o600 });
  return path;
}
