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

export function createHostMinter(deps: HostMinterDeps = {}): TlsMinter {
  const run = deps.run ?? runBinary;
  const selfSigned = deps.selfSigned ?? generateSelfSigned;
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
          let lastError: unknown;
          for (const candidate of deps.tailscaleCandidates ?? tailscaleCliCandidates()) {
            try {
              const status = await run(
                candidate.file,
                ["status", "--json"],
                signal,
                tailscaleCliEnv(candidate),
              );
              if (!status || !tailscaleIsRunningStatus(status)) {
                lastError = new Error("Tailscale is not connected");
                continue;
              }
              selected = candidate;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (!selected) throw lastError ?? new Error("Tailscale is unavailable");
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
          return mintWithBinary(
            "mkcert",
            (certPath, keyPath) => ["-cert-file", certPath, "-key-file", keyPath, "--", ...names],
            run,
            signal,
          );
        default:
          return assertNever(ownership);
      }
    },
  };
}
