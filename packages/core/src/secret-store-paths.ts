// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { basename, join } from "node:path";

export const DEFAULT_SECRET_STORE_SERVICE = "dev.omnesis";
function digest(kind: string, identity: string): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, identity]))
    .digest("hex");
}
function legacyComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[<>:"/\\|?*\x00-\x1f]/u.test(value) &&
    !/[ .]$/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  );
}

export interface SecretEntryPaths {
  path: string;
  legacy?: { path: string; exactBasename: string; exactParentBasename: string };
}

export function fileSecretDirectory(
  configDir: string,
  service: string,
  platform = process.platform,
): string {
  const component =
    platform === "win32" && service !== DEFAULT_SECRET_STORE_SERVICE
      ? `service-sha256-${digest("secret-service", service)}`
      : service;
  return join(configDir, "keyring", component);
}

function entryPaths(
  directory: string,
  legacyDirectory: string,
  legacyParent: string,
  name: string,
  extension: string,
  platform: NodeJS.Platform,
): SecretEntryPaths {
  const legacy = `${Buffer.from(name, "utf8").toString("base64url")}${extension}`;
  if (platform !== "win32") return { path: join(directory, legacy) };
  // An interior dot keeps canonical files outside the legacy base64url stem alphabet.
  return {
    path: join(directory, `key.sha256-${digest("secret-entry", name)}${extension}`),
    ...(name.isWellFormed() &&
    legacyParent.isWellFormed() &&
    legacyComponent(legacyParent) &&
    legacyComponent(legacy)
      ? {
          legacy: {
            path: join(legacyDirectory, legacy),
            exactBasename: legacy,
            exactParentBasename: legacyParent,
          },
        }
      : {}),
  };
}

export function fileSecretEntryPaths(
  configDir: string,
  service: string,
  name: string,
  platform = process.platform,
): SecretEntryPaths {
  return entryPaths(
    fileSecretDirectory(configDir, service, platform),
    join(configDir, "keyring", service),
    service,
    name,
    ".secret",
    platform,
  );
}
export function passphraseSecretEntryPaths(
  configDir: string,
  name: string,
  platform = process.platform,
): SecretEntryPaths {
  const directory = join(configDir, "keyring", "passphrase");
  return entryPaths(directory, directory, "passphrase", name, ".json", platform);
}

/** Named private entries in a fixed directory share the same portable identity contract. */
export function namedSecretEntryPaths(
  directory: string,
  name: string,
  extension: string,
  platform = process.platform,
): SecretEntryPaths {
  return entryPaths(directory, directory, basename(directory), name, extension, platform);
}
