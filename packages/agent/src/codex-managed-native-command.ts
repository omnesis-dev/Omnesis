// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MANAGED_CODEX_QUALIFIED_VERSION } from "./codex-managed-policy-version.js";
import type { CodexRuntimeCommandInfo } from "./codex-app-server-backend.js";

const refused = () =>
  new Error(
    "This desktop requires the pinned native Codex executable. Reinstall its managed runtime or use an API-key backend.",
  );
const targets: Record<string, { package: string; triple: string }> = {
  "darwin-arm64": { package: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { package: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-arm64": { package: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
  "linux-x64": { package: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
};

/** npm's JS launcher execves another image and drops authority FDs. Launch the verified native asset directly. */
export async function resolveManagedCodexNativeCommand(
  info: CodexRuntimeCommandInfo,
): Promise<CodexRuntimeCommandInfo> {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw refused();
  let command: string;
  try {
    command = await realpath(info.command);
  } catch {
    throw refused();
  }
  let root = dirname(command);
  for (let level = 0; level < 7; level++) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    } catch {
      value = undefined;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const pkg = value as Record<string, unknown>;
      if (pkg.name === "@openai/codex" && pkg.version === MANAGED_CODEX_QUALIFIED_VERSION) {
        if (command === join(root, "vendor", target.triple, "bin", "codex"))
          return nativeInfo(info, command);
        const bin = pkg.bin;
        const relative =
          typeof bin === "string"
            ? bin
            : bin && typeof bin === "object" && "codex" in bin
              ? bin.codex
              : undefined;
        if (typeof relative !== "string" || resolve(root, relative) !== command) throw refused();
        let nativeRoot: string;
        try {
          const manifest = createRequire(join(root, "package.json")).resolve(
            `${target.package}/package.json`,
          );
          const platform: unknown = JSON.parse(await readFile(manifest, "utf8"));
          if (
            !platform ||
            typeof platform !== "object" ||
            !("name" in platform) ||
            platform.name !== "@openai/codex" ||
            !("version" in platform) ||
            platform.version !==
              `${MANAGED_CODEX_QUALIFIED_VERSION}-${process.platform}-${process.arch}`
          )
            throw refused();
          nativeRoot = dirname(manifest);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND"))
            throw refused();
          nativeRoot = root;
        }
        return nativeInfo(info, join(nativeRoot, "vendor", target.triple, "bin", "codex"));
      }
      if (
        pkg.name === "@openai/codex" &&
        pkg.version === `${MANAGED_CODEX_QUALIFIED_VERSION}-${process.platform}-${process.arch}` &&
        command === join(root, "vendor", target.triple, "bin", "codex")
      )
        return nativeInfo(info, command);
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  throw refused();
}

async function nativeInfo(
  info: CodexRuntimeCommandInfo,
  command: string,
): Promise<CodexRuntimeCommandInfo> {
  const metadata = await lstat(command);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0 ||
    (await realpath(command)) !== command
  )
    throw refused();
  const file = await open(command, "r");
  try {
    const header = Buffer.alloc(4);
    if (
      (await file.read(header, 0, 4, 0)).bytesRead !== 4 ||
      (process.platform === "linux"
        ? !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        : ![0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(header.readUInt32LE()))
    )
      throw refused();
  } finally {
    await file.close();
  }
  return { ...info, command };
}
