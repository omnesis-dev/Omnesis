// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

/**
 * The flag with which `openclaw plugins install` accepts a plugin's declared
 * capabilities. OpenClaw releases that gate installs on capability consent
 * refuse the Omnesis integration without it; earlier releases do not know
 * the flag and reject it as an unknown option.
 */
export const OPENCLAW_ACCEPT_CAPABILITIES_FLAG = "--accept-capabilities";

const ACCEPT_CAPABILITIES_OPTION = new RegExp(
  `(?:^|\\s)${OPENCLAW_ACCEPT_CAPABILITIES_FLAG}(?=[\\s,=]|$)`,
  "mu",
);

/** How long the help run may take; it normally answers in well under a second. */
const HELP_TIMEOUT_MS = 15_000;

/**
 * Whether the `openclaw` on this machine takes `--accept-capabilities` on
 * `plugins install`, read from that command's own help. Asking the binary
 * about the option itself holds for every release line, pre-releases and
 * vendor builds included, where a version comparison would not.
 *
 * `unknown` means the help run could not start, failed or timed out. The
 * caller then installs without the flag: a release that cannot describe the
 * command is treated as one that predates it, and a gated release refuses
 * the install with its own consent diagnostic.
 */
export function openClawCapabilityConsentSupport(
  environment: NodeJS.ProcessEnv,
  run: typeof spawnSync = spawnSync,
): "supported" | "unsupported" | "unknown" {
  const result = run("openclaw", ["plugins", "install", "--help"], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HELP_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return "unknown";
  // A forced color setting colors option names even when writing to a pipe.
  const help = stripVTControlCharacters(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return ACCEPT_CAPABILITIES_OPTION.test(help) ? "supported" : "unsupported";
}
