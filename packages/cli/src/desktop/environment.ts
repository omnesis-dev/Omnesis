// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const inheritedCredentialKeys = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
]);

export interface DesktopProfile {
  configDir: string;
  instance: string;
  secretService: string;
}

/** The native application never adopts the ordinary CLI's mutable state. */
export function desktopProfile(home: string = homedir()): DesktopProfile {
  const configDir = resolve(home, "Library", "Application Support", "Omnesis Desktop");
  const identity = createHash("sha256").update(configDir).digest("hex");
  return {
    configDir,
    instance: `desktop-${identity.slice(0, 16)}`,
    secretService: `dev.omnesis.desktop.${identity}`,
  };
}

/** Guarded env-node/npm shims precede the raw Node binary in complete packaged runtimes. */
export function desktopExecutableDirectories(nodePath: string = process.execPath): string[] {
  const runtime = dirname(nodePath);
  const bin = join(runtime, "bin");
  return existsSync(join(runtime, "runtime-exec")) && existsSync(join(bin, "node"))
    ? [bin, runtime]
    : [runtime];
}

/** Curated child environments cannot inherit a headless install's credentials or paths. */
export function desktopEnvironment(
  profile: DesktopProfile,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) => !key.startsWith("OMNESIS_") && !inheritedCredentialKeys.has(key),
    ),
  );
  return {
    ...env,
    PATH: [
      ...new Set(
        [...desktopExecutableDirectories(), ...(parent.PATH ?? "").split(delimiter)].filter(
          Boolean,
        ),
      ),
    ].join(delimiter),
    OMNESIS_CONFIG_DIR: profile.configDir,
    OMNESIS_SECRET_STORE: "macos-keychain",
    OMNESIS_SECRET_SERVICE: profile.secretService,
    OMNESIS_SERVICE_INSTANCE: profile.instance,
    OMNESIS_BIND: "127.0.0.1",
    OMNESIS_REQUIRE_ENCRYPTED_STORAGE: "1",
    // The gateway port is selected and persisted by the owned runtime. An extra
    // listener must not accidentally claim the headless installation's port.
    OMNESIS_LOCAL_MCP_PORT: "0",
  };
}

export function initializeDesktopEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): DesktopProfile {
  const profile = desktopProfile(home);
  const isolated = desktopEnvironment(profile, env);
  for (const key of Object.keys(env)) {
    if (key.startsWith("OMNESIS_") || inheritedCredentialKeys.has(key)) delete env[key];
  }
  Object.assign(env, isolated);
  return profile;
}
