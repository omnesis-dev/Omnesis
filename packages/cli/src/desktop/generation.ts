// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Builtins only: profile isolation is established before loading application dependencies.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DesktopFreshInstallFailure } from "./fresh-install-errors.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopGeneration {
  version: 1;
  owner: "omnesis-desktop";
  configIdentity: string;
  generation: string;
  previous: { instance: string; secretService: string; retirementId: string };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function desktopConfigIdentity(configDir: string): string {
  return createHash("sha256").update(resolve(configDir)).digest("hex");
}
export function desktopGenerationPath(configDir: string): string {
  return join(`${configDir}.bootstrap`, "generation.json");
}
export function desktopProfileForGeneration(
  configDir: string,
  generation?: string,
): DesktopProfile {
  if (generation !== undefined && !uuid.test(generation))
    throw new Error("Invalid desktop generation");
  const identity =
    generation === undefined
      ? desktopConfigIdentity(configDir)
      : createHash("sha256")
          .update(resolve(configDir))
          .update("\0")
          .update(generation)
          .digest("hex");
  return {
    configDir: resolve(configDir),
    instance: `desktop-${identity.slice(0, 16)}`,
    secretService: `dev.omnesis.desktop.${identity}`,
  };
}
export function readDesktopGeneration(configDir: string): DesktopGeneration | null {
  const path = desktopGenerationPath(configDir),
    parent = `${configDir}.bootstrap`;
  let file: number | undefined;
  try {
    const directory = lstatSync(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid()) ||
      realpathSync(parent) !== resolve(parent)
    )
      throw new Error("The desktop generation folder must remain private and owned");
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 4096n
    )
      throw new Error("The desktop generation record is invalid");
    const body = Buffer.alloc(4097),
      bytes = readSync(file, body, 0, body.length, 0),
      after = fstatSync(file, { bigint: true }),
      published = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      published.dev !== before.dev ||
      published.ino !== before.ino ||
      realpathSync(path) !== resolve(path)
    )
      throw new Error("The desktop generation record changed");
    const value: unknown = JSON.parse(body.subarray(0, bytes).toString("utf8"));
    if (
      !object(value) ||
      Object.keys(value).sort().join() !== "configIdentity,generation,owner,previous,version" ||
      value.version !== 1 ||
      value.owner !== "omnesis-desktop" ||
      value.configIdentity !== desktopConfigIdentity(configDir) ||
      typeof value.generation !== "string" ||
      !uuid.test(value.generation) ||
      !object(value.previous) ||
      Object.keys(value.previous).sort().join() !== "instance,retirementId,secretService" ||
      typeof value.previous.instance !== "string" ||
      !/^desktop-[a-f0-9]{16}$/u.test(value.previous.instance) ||
      typeof value.previous.secretService !== "string" ||
      !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(value.previous.secretService) ||
      typeof value.previous.retirementId !== "string" ||
      !uuid.test(value.previous.retirementId)
    )
      throw new Error("The desktop generation record is invalid");
    return {
      version: 1,
      owner: "omnesis-desktop",
      configIdentity: desktopConfigIdentity(configDir),
      generation: value.generation,
      previous: {
        instance: value.previous.instance,
        secretService: value.previous.secretService,
        retirementId: value.previous.retirementId,
      },
    };
  } catch (error) {
    if (file === undefined && error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}
export function assertDesktopProfileGeneration(profile: DesktopProfile): void {
  const generation = readDesktopGeneration(profile.configDir);
  if (!generation) return;
  const current = desktopProfileForGeneration(profile.configDir, generation.generation);
  if (current.instance !== profile.instance || current.secretService !== profile.secretService)
    throw new DesktopFreshInstallFailure("FRESH_INSTALL_RECONNECT_REQUIRED");
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
