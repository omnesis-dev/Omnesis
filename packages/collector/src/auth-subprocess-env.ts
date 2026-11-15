// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KEYRING_ENV_KEYS } from "@omnesis/core";

/** Give authentication providers the host/keyring context without unrelated credentials. */
export function authSubprocessEnvironment(
  configDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    ...KEYRING_ENV_KEYS,
  ]) {
    const v = environment[key];
    if (v !== undefined) env[key] = v;
  }
  // Forward the OMNESIS_* keys the auth subprocess actually
  // consumes (config dir, gateway URL for callback delivery,
  // credentials path overrides). Subprocess `process.env` reads
  // beyond this set should fail loudly so we don't accidentally
  // open new env-deps without auditing them.
  for (const [key, value] of Object.entries(environment)) {
    if (!value) continue;
    if (!key.startsWith("OMNESIS_")) continue;
    // Withheld deliberately: the child's logger writes directly to this file
    // when it is set, which would put provider log lines into the collector's
    // log without passing the stderr redaction below. Unset, they arrive on
    // stderr and are redacted.
    if (key === "OMNESIS_LOG_FILE") continue;
    env[key] = value;
  }
  env.OMNESIS_CONFIG_DIR = configDir;
  return env;
}
