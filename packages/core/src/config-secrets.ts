// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Secret references used by operator config.
 *
 * `omnesis.json` may carry references like
 * `config-secret:inference.backend.openai.apiKey` instead of embedding the
 * secret value. The value itself lives in a root-key-wrapped secret file when
 * an install root key exists, or in owner-only plaintext for installs that have
 * not opted into keyring-backed storage yet.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./utils.js";
import {
  readSecretTextFileSync,
  writeSecretTextFileSync,
  type SecretFileOptions,
} from "./secret-file.js";

export const CONFIG_SECRET_REF_PREFIX = "config-secret:";

const CONFIG_SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

export function makeConfigSecretRef(name: string): string {
  assertConfigSecretName(name);
  return `${CONFIG_SECRET_REF_PREFIX}${name}`;
}

export function parseConfigSecretRef(ref: string): string | null {
  if (!ref.startsWith(CONFIG_SECRET_REF_PREFIX)) return null;
  const name = ref.slice(CONFIG_SECRET_REF_PREFIX.length);
  return isConfigSecretName(name) ? name : null;
}

export function configSecretPath(refOrName: string, configDir?: string): string {
  const name = refOrName.startsWith(CONFIG_SECRET_REF_PREFIX)
    ? parseConfigSecretRef(refOrName)
    : refOrName;
  if (!name) throw new Error(`Invalid Omnesis config secret reference: ${refOrName}`);
  assertConfigSecretName(name);
  return join(
    configDir ?? DEFAULT_CONFIG_DIR,
    "config-secrets",
    `${Buffer.from(name, "utf8").toString("base64url")}.secret`,
  );
}

export function readConfigSecretRefSync(ref: string, opts: SecretFileOptions = {}): string | null {
  const name = parseConfigSecretRef(ref);
  if (!name) return null;
  return readSecretTextFileSync(configSecretPath(name, opts.configDir), {
    ...opts,
    scope: configSecretScope(name),
  });
}

export function writeConfigSecretSync(
  name: string,
  value: string,
  opts: SecretFileOptions = {},
): string {
  assertConfigSecretName(name);
  writeSecretTextFileSync(configSecretPath(name, opts.configDir), value, {
    ...opts,
    scope: configSecretScope(name),
  });
  return makeConfigSecretRef(name);
}

export function clearConfigSecretRefSync(ref: string, configDir?: string): void {
  if (!parseConfigSecretRef(ref)) return;
  rmSync(configSecretPath(ref, configDir), { force: true });
}

function configSecretScope(name: string): string {
  return `${CONFIG_SECRET_REF_PREFIX}${name}`;
}

function isConfigSecretName(name: string): boolean {
  return CONFIG_SECRET_NAME_RE.test(name);
}

function assertConfigSecretName(name: string): void {
  if (!isConfigSecretName(name)) {
    throw new Error(
      `Invalid Omnesis config secret name "${name}". Use letters, digits, dot, colon, underscore, or dash.`,
    );
  }
}
