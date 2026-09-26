// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The three issuers behind material Omnesis owns, driven from the gateway
 * process: its own self-signed pair through `openssl`, the Tailscale tier
 * through `tailscale cert`, and the mkcert tier through `mkcert`. Each mints
 * into a scratch directory and hands the PEM text back; the caller decides
 * whether it may be served.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertNever,
  mkcertCliCandidates,
  TAILSCALE_STATUS_TIMEOUT_MS,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
  type TailscaleCliCandidate,
  type TlsOwnership,
} from "@omnesis/core";
import { generateSelfSigned } from "../tls.js";
import type { TlsMinter, TlsPem } from "./service.js";

const execFileAsync = promisify(execFile);

export interface HostMinterDeps {
  /** Run an issuer binary. Injected so tests never need `tailscale` or `mkcert`. */
  run?: (
    file: string,
    args: string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<string | void>;
  tailscaleCandidates?: TailscaleCliCandidate[];
  mkcertCandidates?: string[];
  /** How long each `tailscale status --json` may take. */
  tailscaleStatusTimeoutMs?: number;
  selfSigned?: () => TlsPem;
}

async function runBinary(
  file: string,
  args: string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const result = await execFileAsync(file, args, { signal, encoding: "utf8", env });
    return result.stdout;
  } catch (err) {
    const detail = err as NodeJS.ErrnoException & { stderr?: string };
    if (detail.code === "ENOENT") {
      throw new Error(`\`${file}\` is not installed or not on the gateway's PATH`, { cause: err });
    }
    if (signal.aborted && (signal.reason as Error | undefined)?.name === "TimeoutError") {
      throw new Error(`\`${file} ${args[0] ?? ""}\` did not answer in time`, { cause: err });
    }
    const stderr = detail.stderr?.trim();
    throw new Error(`\`${file} ${args[0] ?? ""}\` failed${stderr ? `: ${stderr}` : ""}`, {
      cause: err,
    });
  }
}

/** Issue through a binary that writes a cert and key file to paths it is given. */
async function mintWithBinary(
  file: string,
  argsFor: (certPath: string, keyPath: string) => string[],
  run: NonNullable<HostMinterDeps["run"]>,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<TlsPem> {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-tls-renew-"));
  try {
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    await run(file, argsFor(certPath, keyPath), signal, env);
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface TailscaleCliFailure {
  file: string;
  error: unknown;
}

function isMissingBinary(err: unknown): boolean {
  const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
  return code(err) === "ENOENT" || code((err as Error | undefined)?.cause) === "ENOENT";
}

function backendState(status: string | void): string {
  try {
    const state = (JSON.parse(status ?? "") as { BackendState?: unknown }).BackendState;
    return typeof state === "string" ? state : "";
  } catch {
    return "";
  }
}

/**
 * Why no candidate could renew. A CLI that ran and said no (logged out,
 * stopped, failed) is the operator's actual problem; the candidates that are
 * simply absent are named only when no CLI ran at all, and then all together.
 */
function tailscaleUnavailable(failures: TailscaleCliFailure[]): Error {
  const ran = failures.filter((failure) => !isMissingBinary(failure.error));
  if (ran.length > 0) {
    const messages = ran.map(({ error }) =>
      error instanceof Error ? error.message : String(error),
    );
    return new Error(messages.join("; "), { cause: ran[0]!.error });
  }
  const tried = failures.map(({ file }) => `\`${file}\``).join(", ");
  return new Error(
    `no Tailscale CLI the gateway can run: tried ${tried || "none"} (the gateway's PATH is ${process.env.PATH ?? "unset"})`,
  );
}

/**
 * Re-issue through the first mkcert the gateway can run: the one on its PATH,
 * else Homebrew's, which a launchd PATH does not reach on Apple Silicon.
 */
async function mintWithMkcert(
  candidates: readonly string[],
  names: readonly string[],
  run: NonNullable<HostMinterDeps["run"]>,
  signal: AbortSignal,
): Promise<TlsPem> {
  for (const file of candidates) {
    try {
      return await mintWithBinary(
        file,
        (certPath, keyPath) => ["-cert-file", certPath, "-key-file", keyPath, "--", ...names],
        run,
        signal,
      );
    } catch (err) {
      if (!isMissingBinary(err)) throw err;
    }
  }
  const tried = candidates.map((file) => `\`${file}\``).join(", ");
  throw new Error(
    `no mkcert the gateway can run: tried ${tried || "none"} (the gateway's PATH is ${process.env.PATH ?? "unset"})`,
  );
}

export function createHostMinter(deps: HostMinterDeps = {}): TlsMinter {
  const run = deps.run ?? runBinary;
  const selfSigned = deps.selfSigned ?? generateSelfSigned;
  const statusTimeoutMs = deps.tailscaleStatusTimeoutMs ?? TAILSCALE_STATUS_TIMEOUT_MS;
  return {
    async mint(ownership: Exclude<TlsOwnership, "external">, names, signal): Promise<TlsPem> {
      // Names come off a certificate on disk and land in an issuer's argv;
      // one shaped like a flag is not a name.
      const flagShaped = names.find((name) => name.startsWith("-"));
      if (flagShaped) {
        throw new Error(`the current certificate carries an unusable name: ${flagShaped}`);
      }
      switch (ownership) {
        case "self-signed":
          return selfSigned();
        case "tailscale": {
          // A Tailscale certificate covers exactly one MagicDNS name.
          const dnsName = names.find((name) => name.includes(".") && !/^[\d.:]+$/u.test(name));
          if (!dnsName) throw new Error("the current certificate carries no DNS name to renew");
          let selected: TailscaleCliCandidate | undefined;
          const failures: TailscaleCliFailure[] = [];
          for (const candidate of deps.tailscaleCandidates ?? tailscaleCliCandidates()) {
            try {
              // A hung candidate must not spend the whole renewal's time.
              const status = await run(
                candidate.file,
                ["status", "--json"],
                AbortSignal.any([signal, AbortSignal.timeout(statusTimeoutMs)]),
                tailscaleCliEnv(candidate),
              );
              if (!status || !tailscaleIsRunningStatus(status)) {
                const state = backendState(status);
                failures.push({
                  file: candidate.file,
                  error: new Error(
                    `\`${candidate.file}\` reports Tailscale is not connected${state ? ` (${state})` : ""}`,
                  ),
                });
                continue;
              }
              selected = candidate;
              break;
            } catch (err) {
              failures.push({ file: candidate.file, error: err });
            }
          }
          if (!selected) throw tailscaleUnavailable(failures);
          return mintWithBinary(
            selected.file,
            (certPath, keyPath) => [
              "cert",
              "--cert-file",
              certPath,
              "--key-file",
              keyPath,
              "--",
              dnsName,
            ],
            run,
            signal,
            tailscaleCliEnv(selected),
          );
        }
        case "mkcert":
          if (names.length === 0)
            throw new Error("the current certificate carries no names to renew");
          return mintWithMkcert(deps.mkcertCandidates ?? mkcertCliCandidates(), names, run, signal);
        default:
          return assertNever(ownership);
      }
    },
  };
}
