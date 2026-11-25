// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareAnalyticsNativeFixture } from "./analytics-native-fixture.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-analytics-input-")));
  roots.push(root);
  const bytes = Buffer.from("Invented reviewed compiler source archive");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const archive = join(root, "source.tar.gz");
  await writeFile(archive, bytes, { mode: 0o600 });
  const acquire = vi.fn(async () => archive);
  const readPins = async () => ({ sources: { fixture: { sha256 } } });
  return {
    root,
    bytes,
    sha256,
    archive,
    acquire,
    options: { output: join(root, "output"), cache: join(root, "cache") },
    dependencies: { acquire, readPins },
  };
}

test("stages verified sources and helper closure, reuses intact inputs and repairs owned changes", async () => {
  const f = await fixture();
  const output = await prepareAnalyticsNativeFixture(f.options, f.dependencies);
  expect(await readFile(join(output, "sources", `${f.sha256}.tar.gz`))).toEqual(f.bytes);
  const helper = join(output, "scripts/desktop/build-analytics.mjs");
  expect(await readFile(helper, "utf8")).toContain("buildDesktopAnalytics");
  await prepareAnalyticsNativeFixture(f.options, f.dependencies);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  await writeFile(helper, "modified compiler recipe");
  await prepareAnalyticsNativeFixture(f.options, f.dependencies);
  expect(f.acquire).toHaveBeenCalledTimes(2);
  expect(await readFile(helper, "utf8")).toContain("buildDesktopAnalytics");
});

test("unclaimed directories, aliases and public metadata never authorize replacement", async () => {
  const f = await fixture();
  await mkdir(f.options.output, { mode: 0o700 });
  await writeFile(join(f.options.output, "keep.txt"), "unrelated contents");
  await expect(prepareAnalyticsNativeFixture(f.options, f.dependencies)).rejects.toThrow(
    "unclaimed",
  );
  expect(await readFile(join(f.options.output, "keep.txt"), "utf8")).toBe("unrelated contents");
  const linked = { ...f.options, output: join(f.root, "alias") };
  await symlink(f.options.output, linked.output);
  await expect(prepareAnalyticsNativeFixture(linked, f.dependencies)).rejects.toThrow("canonical");
  await rm(f.options.output, { recursive: true });
  await prepareAnalyticsNativeFixture(f.options, f.dependencies);
  await chmod(join(f.options.output, "native-input.json"), 0o644);
  await expect(prepareAnalyticsNativeFixture(f.options, f.dependencies)).rejects.toThrow(
    "not owned",
  );
});

test("a changed source refuses without publishing or replacing the previous compiler inputs", async () => {
  const f = await fixture();
  await prepareAnalyticsNativeFixture(f.options, f.dependencies);
  const helper = join(f.options.output, "scripts/desktop/build-analytics.mjs");
  await writeFile(helper, "old modified helper");
  await writeFile(f.archive, "changed after review");
  await expect(prepareAnalyticsNativeFixture(f.options, f.dependencies)).rejects.toThrow("changed");
  expect(await readFile(helper, "utf8")).toBe("old modified helper");
});
