// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  CODEX_NOTICE_SOURCE,
  CODEX_VOICE_NOTICES,
  stageCodexNotices,
  verifyCodexNoticeInputs,
} from "./codex-notices.mjs";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const target = mkdtempSync(join(tmpdir(), "omnesis-sdk-notice-fixture-"));
  roots.push(target);
  const dependencies = join(target, "node_modules");
  const wrapper = join(dependencies, "@openai/codex");
  const native = join(dependencies, "@openai/codex-darwin-arm64");
  for (const [path, version] of [
    [wrapper, CODEX_NOTICE_SOURCE.version],
    [native, `${CODEX_NOTICE_SOURCE.version}-darwin-arm64`],
  ]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
  }
  const voice = join(native, "vendor/aarch64-apple-darwin/codex-resources/voice");
  for (const name of CODEX_VOICE_NOTICES) {
    mkdirSync(dirname(join(voice, name)), { recursive: true });
    writeFileSync(join(voice, name), `Invented resource notice: ${name}`);
  }
  return {
    target,
    wrapper,
    native,
    voice,
    options: { target, architecture: "arm64", dependencyRoots: [dependencies] },
  };
}
test("retains verified upstream text and every selected resource notice byte for byte", () => {
  const f = fixture();
  const source = verifyCodexNoticeInputs();
  expect(stageCodexNotices(f.options)).toEqual({
    files: 2 + CODEX_VOICE_NOTICES.length,
    sourceCommit: CODEX_NOTICE_SOURCE.commit,
  });
  for (const [name, bytes] of Object.entries(source))
    expect(readFileSync(join(f.target, "licenses/codex", name))).toEqual(bytes);
  for (const name of CODEX_VOICE_NOTICES)
    expect(readFileSync(join(f.target, "licenses/codex/resources/voice", name))).toEqual(
      readFileSync(join(f.voice, name)),
    );
});
test("a changed pinned license refuses integrity verification", () => {
  const f = fixture();
  writeFileSync(join(f.target, "LICENSE"), "invented changed text");
  writeFileSync(join(f.target, "NOTICE"), "invented notice");
  expect(() => verifyCodexNoticeInputs(f.target)).toThrow(/integrity/);
});
test("a different dependency version requires a new notice audit", () => {
  const f = fixture();
  writeFileSync(
    join(f.wrapper, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: "99.0.0" }),
  );
  expect(() => stageCodexNotices(f.options)).toThrow(/version/);
});
test("a missing selected resource license refuses publication", () => {
  const f = fixture();
  rmSync(join(f.voice, "licenses/LGPL-2.1.txt"));
  expect(() => stageCodexNotices(f.options)).toThrow();
  expect(() => readFileSync(join(f.target, "licenses/codex/LICENSE"))).toThrow();
});
test("missing wrapper or selected native package cannot produce incomplete notices", () => {
  for (const selected of ["wrapper", "native"]) {
    const f = fixture();
    rmSync(f[selected], { recursive: true });
    expect(() => stageCodexNotices(f.options)).toThrow(/required/);
  }
});
test.skipIf(process.platform === "win32")(
  "aliased resource notices are refused without reading their target",
  () => {
    const f = fixture();
    const path = join(f.voice, "licenses/Opus.txt");
    rmSync(path);
    symlinkSync(join(f.target, "outside.txt"), path);
    writeFileSync(join(f.target, "outside.txt"), "unchanged fixture");
    expect(() => stageCodexNotices(f.options)).toThrow(/aliases/);
    expect(readFileSync(join(f.target, "outside.txt"), "utf8")).toBe("unchanged fixture");
  },
);
test("dependency roots outside the staged runtime are refused", () => {
  const f = fixture();
  expect(() => stageCodexNotices({ ...f.options, dependencyRoots: [tmpdir()] })).toThrow(
    /staged runtime/,
  );
});

test.skipIf(process.platform === "win32")(
  "publication never follows a destination directory alias",
  () => {
    const f = fixture();
    const outside = join(f.target, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.target, "licenses"));
    expect(() => stageCodexNotices(f.options)).toThrow(/alias/);
    expect(() => readFileSync(join(outside, "codex/LICENSE"))).toThrow();
  },
);
