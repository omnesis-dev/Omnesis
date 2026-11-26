// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_NOTICE_SOURCE = Object.freeze({
  version: "0.171.0",
  commit: "ccf9be8cc458bd6b8336fe84d68d8893f2691a5e",
  LICENSE: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  NOTICE: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
});
const licenseRoot = join(dirname(fileURLToPath(import.meta.url)), "licenses/codex");
export const CODEX_VOICE_NOTICES = Object.freeze([
  "NOTICE.md",
  "manifest.json",
  "sources.json",
  "licenses/PCRE2.md",
  "licenses/LGPL-2.1.txt",
  "licenses/libffi.txt",
  "licenses/Opus.txt",
  "licenses/proxy-libintl.txt",
  "licenses/sljit.txt",
  "licenses/zlib.txt",
]);

function regularBytes(root, name) {
  const path = join(root, name);
  for (let current = path; current !== root; current = dirname(current)) {
    if (relative(root, current).startsWith("..")) throw new Error("SDK notice escaped its package");
    const metadata = lstatSync(current);
    if (
      metadata.isSymbolicLink() ||
      (current === path ? !metadata.isFile() : !metadata.isDirectory())
    )
      throw new Error("SDK notices must be regular package files without directory aliases");
    if (current === path && metadata.size > 1024 * 1024)
      throw new Error("SDK notice exceeds its bounded size");
  }
  return readFileSync(path);
}

/** Upstream text is retained verbatim; an SDK version bump requires an explicit notice audit. */
export function verifyCodexNoticeInputs(directory = licenseRoot) {
  return Object.fromEntries(
    ["LICENSE", "NOTICE"].map((name) => {
      const bytes = regularBytes(directory, name);
      if (createHash("sha256").update(bytes).digest("hex") !== CODEX_NOTICE_SOURCE[name])
        throw new Error(
          "Pinned SDK license or notice integrity does not match the reviewed source",
        );
      return [name, bytes];
    }),
  );
}

/** Collects the selected architecture's unmodified upstream source and resource notices. */
export function stageCodexNotices({ target, architecture, dependencyRoots }) {
  if (!["arm64", "x64"].includes(architecture))
    throw new Error("Unsupported SDK notice architecture");
  const output = realpathSync(target);
  const roots = [
    ...new Set(
      dependencyRoots.map((root) => join(output, relative(resolve(target), resolve(root)))),
    ),
  ];
  if (roots.some((root) => relative(output, root).startsWith("..")))
    throw new Error("SDK dependency notices must come from the staged runtime");
  const source = verifyCodexNoticeInputs();
  let wrappers = 0;
  let native = 0;
  const files = new Map(Object.entries(source));
  const triple = architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  for (const root of roots) {
    for (const [name, expected, isNative] of [
      ["codex", CODEX_NOTICE_SOURCE.version, false],
      [
        `codex-darwin-${architecture}`,
        `${CODEX_NOTICE_SOURCE.version}-darwin-${architecture}`,
        true,
      ],
    ]) {
      const directory = join(root, "@openai", name);
      if (!existsSync(directory)) continue;
      const manifest = JSON.parse(
        regularBytes(output, relative(output, join(directory, "package.json"))),
      );
      if (manifest.name !== "@openai/codex" || manifest.version !== expected)
        throw new Error("SDK package version requires a new license and resource notice audit");
      if (!isNative) {
        wrappers++;
        continue;
      }
      native++;
      const voice = join(directory, "vendor", triple, "codex-resources/voice");
      for (const path of CODEX_VOICE_NOTICES) {
        const bytes = regularBytes(output, relative(output, join(voice, path)));
        const key = `resources/voice/${path}`;
        if (files.has(key) && !files.get(key).equals(bytes))
          throw new Error("Staged SDK resource notices disagree");
        files.set(key, bytes);
      }
    }
  }
  if (!wrappers || !native)
    throw new Error("The staged SDK wrapper and native resource notices are required");
  const parent = join(output, "licenses");
  try {
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("SDK notice destination is an unsafe alias");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const destination = join(output, "licenses/codex");
  if (existsSync(destination))
    throw new Error("SDK notices must publish into a new staged directory");
  for (const [name, bytes] of files) {
    const path = join(destination, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, bytes, { mode: 0o644, flag: "wx" });
  }
  return { files: files.size, sourceCommit: CODEX_NOTICE_SOURCE.commit };
}
