// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const PUBLIC_NPM_PUBLISH_ENV = "OMNESIS_ALLOW_PUBLIC_NPM_PUBLISH";

export function normalizePublishAccess(value) {
  const access = value ?? "restricted";
  if (access !== "public" && access !== "restricted") {
    throw new Error(`Unknown --access: ${access} (expected public|restricted)`);
  }
  return access;
}

export function isNpmjsRegistry(registry) {
  if (!registry) return false;
  try {
    return new URL(registry).hostname.toLowerCase() === "registry.npmjs.org";
  } catch {
    return false;
  }
}

export function assertPublishPolicy({ registry, access, dryRun = false, env = process.env }) {
  if (dryRun || access !== "public" || !isNpmjsRegistry(registry)) return;
  if (env[PUBLIC_NPM_PUBLISH_ENV] === "1") return;
  throw new Error(
    `Public npmjs publishes are blocked by default as a safety gate. ` +
      `Set ${PUBLIC_NPM_PUBLISH_ENV}=1 to allow publishing Omnesis packages publicly to npmjs.`,
  );
}
