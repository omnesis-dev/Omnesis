// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The root command that installs, or moves, the dedicated-account gateway.
 *
 * A dedicated gateway runs from a release that root fetched and owns
 * (`scripts/hardened-gateway.sh`), never from this account's files. This
 * account's part is therefore to print the one command an operator runs with
 * sudo. Rendering and flag checks are pure; beside them sit the probes the
 * command needs: which release this CLI came from, whether that commit is on
 * the repository, and whether the repository answers without a credential.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import {
  HARDENED_ADMIN_COMMAND,
  HARDENED_ADMIN_PATH,
  HARDENED_BOOTSTRAP_URL,
  HARDENED_PASSPHRASE_PATH,
  HARDENED_REPO_URL,
} from "@omnesis/core";

/** What the root command installs: a release version, or a tag, branch or commit. */
export type BootstrapTarget = { kind: "version"; version: string } | { kind: "ref"; ref: string };

/** How the dedicated gateway's keys are sealed. */
export type BootstrapKeyring =
  | { kind: "passphrase" }
  | { kind: "none" }
  | { kind: "file"; path: string };

export interface BootstrapCommandInput {
  target: BootstrapTarget;
  /** The port the gateway listens on; the default is left unsaid. */
  port: number;
  keyring: BootstrapKeyring;
  /** The repository refused an anonymous read, so the command carries a token. */
  needsCredential: boolean;
  /** An admin command is already installed: the gateway is moved, not installed. */
  installed: boolean;
}

export const DEFAULT_HARDENED_PORT = 7600;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The target for a release version. The admin command's `--version` takes a
 * stable X.Y.Z; any other version is named by its release tag.
 */
export function versionTarget(version: string): BootstrapTarget {
  return STABLE_VERSION.test(version)
    ? { kind: "version", version }
    : { kind: "ref", ref: `v${version}` };
}

/**
 * Reads a GitHub token from this account's own git credential helper when the
 * command is pasted. The token reaches root in the environment of the sudo
 * process (`--preserve-env`), which only root and this account can read,
 * rather than on a command line that every account can list and that sudo
 * logs. The subshell keeps it out of the shell the operator returns to. A token
 * that does not work only makes root's fetch fail, because root fetches from a
 * fixed address.
 */
export const CREDENTIAL_EXPORT = `export OMNESIS_GIT_TOKEN="$(printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')"`;

/** Quote one word for a POSIX shell, leaving plain words as they are. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function targetFlags(target: BootstrapTarget): string[] {
  return target.kind === "version" ? ["--version", target.version] : ["--ref", target.ref];
}

/** The single command, as the operator pastes it. */
/**
 * Whether the caller asked for a gateway without encryption at rest.
 *
 * `--no-keyring` is declared as a flag named "no-keyring", but citty reads
 * any `--no-x` as a negation of `x`, so a command line produces
 * `keyring: false` and never `args["no-keyring"]`. Accept both: the first
 * is what an operator types, the second what a programmatic caller passes.
 */
export function noKeyringRequested(args: Record<string, unknown>): boolean {
  return args["no-keyring"] === true || args.keyring === false;
}

export function hardenedBootstrapCommand(input: BootstrapCommandInput): string {
  const sudo = input.needsCredential ? "sudo --preserve-env=OMNESIS_GIT_TOKEN" : "sudo";
  let command: string;
  if (input.installed) {
    command = [sudo, HARDENED_ADMIN_COMMAND, "update", ...targetFlags(input.target).map(shellQuote)]
      .filter(Boolean)
      .join(" ");
  } else {
    const args = ["install", ...targetFlags(input.target)];
    if (input.port !== DEFAULT_HARDENED_PORT) args.push("--port", String(input.port));
    if (input.keyring.kind === "none") args.push("--no-keyring");
    if (input.keyring.kind === "file") args.push("--keyring-passphrase-file", input.keyring.path);
    command = `curl -fsSL ${HARDENED_BOOTSTRAP_URL} | ${sudo} sh -s -- ${args.map(shellQuote).join(" ")}`;
  }
  return input.needsCredential ? `(${CREDENTIAL_EXPORT}; ${command})` : command;
}

/** The port and keyring a normal account's `service install gateway --hardened` asks for. */
export interface BootstrapFlags {
  port: number;
  keyring: BootstrapKeyring;
}

/**
 * Read the flags of `service install gateway --hardened` run as a normal
 * account, which prints the root command rather than writing a unit. Flags that
 * describe a unit are refused, since root's install writes its own; so are a
 * port and a keyring choice for a gateway already installed, since moving it
 * keeps the ones it was installed with.
 */
export function hardenedBootstrapFlags(
  args: Record<string, unknown>,
  extraEnv: Record<string, string>,
  installed: boolean,
): BootstrapFlags {
  for (const flag of ["exec", "secret-store", "keyring-passphrase-credential"] as const) {
    if (typeof args[flag] === "string" && args[flag] !== "") {
      throw new CliError(
        `--${flag} only applies when root writes the unit itself. Run this command without it: the install command it prints writes the unit.`,
        EXIT_USER_ERROR,
      );
    }
  }
  const { OMNESIS_GATEWAY_PORT: portValue, ...otherEnv } = extraEnv;
  const unsupported = Object.keys(otherEnv);
  if (unsupported.length > 0) {
    throw new CliError(
      `The dedicated gateway's install takes only OMNESIS_GATEWAY_PORT through --env (got ${unsupported.join(", ")}).`,
      EXIT_USER_ERROR,
    );
  }
  const port = portValue === undefined ? DEFAULT_HARDENED_PORT : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      `Invalid OMNESIS_GATEWAY_PORT '${portValue}' (expected 1-65535).`,
      EXIT_USER_ERROR,
    );
  }
  const passphraseFile =
    typeof args["keyring-passphrase-file"] === "string" && args["keyring-passphrase-file"] !== ""
      ? args["keyring-passphrase-file"]
      : undefined;
  if (noKeyringRequested(args) && passphraseFile) {
    throw new CliError(
      "--no-keyring and --keyring-passphrase-file contradict each other; pass one.",
      EXIT_USER_ERROR,
    );
  }
  if (passphraseFile && !isAbsolute(passphraseFile)) {
    throw new CliError(
      `--keyring-passphrase-file must be an absolute path: root copies the passphrase from it into ${HARDENED_PASSPHRASE_PATH}.`,
      EXIT_USER_ERROR,
    );
  }
  const keyring: BootstrapKeyring = noKeyringRequested(args)
    ? { kind: "none" }
    : passphraseFile
      ? { kind: "file", path: passphraseFile }
      : { kind: "passphrase" };
  if (installed && (portValue !== undefined || keyring.kind !== "passphrase")) {
    throw new CliError(
      `A dedicated gateway is installed here, and moving it to another release keeps the port and keyring it was installed with. Leave out the port and keyring flags, or remove it first with: sudo ${HARDENED_ADMIN_COMMAND} uninstall`,
      EXIT_USER_ERROR,
    );
  }
  return { port, keyring };
}

export interface GitProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitProbe {
  (args: readonly string[], cwd: string, env?: Record<string, string>): GitProbeResult;
}

const defaultGitProbe: GitProbe = (args, cwd, env = {}) => {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** The checkout this CLI runs from, when it runs from one. */
export function cliCheckoutRoot(): string | null {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return existsSync(`${root}.git`) ? root : null;
}

/**
 * The ref root should install to match this CLI. A checkout sitting exactly on
 * this version's release tag, or no checkout at all (a package install), names
 * the version; any other checkout names its commit, which root then fetches
 * from the repository itself.
 */
export function resolveBootstrapTarget(
  version: string,
  checkoutRoot: string | null = cliCheckoutRoot(),
  git: GitProbe = defaultGitProbe,
): BootstrapTarget {
  if (!checkoutRoot) return versionTarget(version);
  const tag = git(["describe", "--exact-match", "--tags", "HEAD"], checkoutRoot);
  if (tag.code === 0 && tag.stdout.trim() === `v${version}`) return versionTarget(version);
  const head = git(["rev-parse", "HEAD"], checkoutRoot);
  const commit = head.stdout.trim();
  return head.code === 0 && /^[0-9a-f]{40}$/.test(commit)
    ? { kind: "ref", ref: commit }
    : versionTarget(version);
}

/**
 * Whether a commit is on a branch this checkout last saw on its remote. Root
 * fetches from the repository, never from this checkout, so a commit that was
 * never pushed cannot be installed.
 */
export function commitOnRemote(
  commit: string,
  checkoutRoot: string | null = cliCheckoutRoot(),
  git: GitProbe = defaultGitProbe,
): boolean {
  if (!checkoutRoot) return false;
  const res = git(["branch", "-r", "--contains", commit], checkoutRoot);
  return res.code === 0 && res.stdout.trim() !== "";
}

/** Git's own wording when a read needs a credential it was not given. */
const AUTH_REFUSAL =
  /authentication failed|could not read username|terminal prompts disabled|repository not found|returned error: 40[13]/i;

/**
 * Whether the repository refuses a read without a credential. The probe reads
 * it the way root will: over HTTPS, ignoring this account's git configuration
 * (credential helpers, and address rewrites to SSH that would answer with this
 * account's key). Only a refusal counts; an unreachable network does not, since
 * a token would not help root reach it either.
 */
export function repositoryNeedsCredential(
  git: GitProbe = defaultGitProbe,
  repoUrl: string = HARDENED_REPO_URL,
): boolean {
  const res = git(["ls-remote", "--exit-code", repoUrl, "HEAD"], "/", {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  return res.code !== 0 && AUTH_REFUSAL.test(res.stderr);
}

/**
 * The release `omnesis update` should move the dedicated gateway to: the
 * update's target version, or, for an edge update with no version, the commit
 * this checkout now sits on.
 */
export function updateTarget(
  targetVersion: string | null,
  cliVersion: string,
  checkoutRoot: string | null = cliCheckoutRoot(),
  git: GitProbe = defaultGitProbe,
): BootstrapTarget {
  return targetVersion
    ? versionTarget(targetVersion)
    : resolveBootstrapTarget(cliVersion, checkoutRoot, git);
}

/**
 * The root command `omnesis update` names for the dedicated gateway on this
 * host: the admin command's update where it is installed, and otherwise the
 * install, which also moves a dedicated gateway whose unit runs code from a
 * login account (it reads that unit's port and passphrase).
 */
export function hardenedGatewayUpdateCommand(
  target: BootstrapTarget,
  adminInstalled: boolean,
  needsCredential: boolean,
): string {
  return hardenedBootstrapCommand({
    target,
    port: DEFAULT_HARDENED_PORT,
    keyring: { kind: "passphrase" },
    needsCredential,
    installed: adminInstalled,
  });
}

/** Whether this host already has the root-owned admin command. */
export function hardenedAdminInstalled(exists: (path: string) => boolean = existsSync): boolean {
  return exists(HARDENED_ADMIN_PATH);
}
