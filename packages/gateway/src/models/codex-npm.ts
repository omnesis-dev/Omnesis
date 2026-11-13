// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { distrustingNodeOptions } from "@omnesis/core";

const NPM_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** npm gets a private home/cache and only the host variables needed to download packages. */
export function buildNpmEnv(
  source: NodeJS.ProcessEnv,
  npmHome: string,
  npmCache: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: npmHome,
    USERPROFILE: npmHome,
    npm_config_cache: npmCache,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(npmHome, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    NODE_OPTIONS: distrustingNodeOptions(""),
  };
  for (const key of NPM_ENV_KEYS) {
    // A Windows environment is case-insensitive; do not emit duplicate aliases.
    if (
      platform === "win32" &&
      Object.keys(env).some((name) => name.toUpperCase() === key.toUpperCase())
    )
      continue;
    const value = environmentValue(source, key, platform);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (env[key] !== undefined || platform !== "win32") return env[key];
  const actual = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
  return actual === undefined ? undefined : env[actual];
}
