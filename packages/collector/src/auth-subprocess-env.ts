// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KEYRING_ENV_KEYS, windowsEnvironmentValue } from "@omnesis/core";

const WINDOWS_HOST_PATHS = ["LOCALAPPDATA", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP"];

/** Give authentication providers the host/keyring context without unrelated credentials. */
export function authSubprocessEnvironment(
  configDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
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
    const v = platform === "win32" ? windowsEnvironmentValue(key, environment) : environment[key];
    if (v !== undefined) env[key] = v;
  }
  if (platform === "win32") {
    // Native secret-file helpers resolve their trusted cache and host tools
    // from these locations. Forward paths, without inheriting other exports.
    for (const key of WINDOWS_HOST_PATHS) {
      const value = windowsEnvironmentValue(key, environment);
      if (value !== undefined) env[key] = value;
    }
  }
  // Forward the OMNESIS_* keys the auth subprocess actually
  // consumes (config dir, gateway URL for callback delivery,
  // credentials path overrides). Subprocess `process.env` reads
  // beyond this set should fail loudly so we don't accidentally
  // open new env-deps without auditing them.
  for (const original of Object.keys(environment).sort()) {
    const value = environment[original];
    if (!value) continue;
    const key = platform === "win32" ? original.toUpperCase() : original;
    if (!key.startsWith("OMNESIS_")) continue;
    // Withheld deliberately: the child's logger writes directly to this file
    // when it is set, which would put provider log lines into the collector's
    // log without passing the stderr redaction below. Unset, they arrive on
    // stderr and are redacted.
    if (key === "OMNESIS_LOG_FILE") continue;
    if (Object.hasOwn(env, key)) continue;
    env[key] = value;
  }
  env.OMNESIS_CONFIG_DIR = configDir;
  return env;
}
