// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { buildDesktopAnalytics, verifyDesktopAnalyticsBuild } from "./build-analytics.mjs";
import { collectAnalyticsNotices, validAnalyticsNoticePath } from "./analytics-notices.mjs";

const roots = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-analytics-build-test-")));
  roots.push(root);
  return root;
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = {
  recipeVersion: 1,
  architecture: "arm64",
  sdkVersion: "26.0",
  compilerVersion: "Apple clang version 17.0.0 (fixture)",
  recipeSha256: "a".repeat(64),
  sourcePinsSha256: "b".repeat(64),
  duckdbVersion: "v1.5.6",
  minimumMacOS: "14.0",
};
async function cachedBuild() {
  const root = await directory();
  const library = Buffer.alloc(32);
  library.writeUInt32BE(0xfeedfacf);
  library.writeUInt32BE(0x0100000c, 4);
  await writeFile(join(root, "libduckdb.dylib"), library, { mode: 0o600 });
  const licenseHashes = {};
  for (const name of ["duckdb", "httpfs", "openssl", "curl"]) {
    await mkdir(join(root, "licenses", name), { recursive: true, mode: 0o700 });
    const text = `Invented ${name} notice fixture\n`;
    await writeFile(join(root, "licenses", name, "LICENSE"), text, { mode: 0o600 });
    licenseHashes[`${name}/LICENSE`] = hash(text);
  }
  const record = {
    format: 1,
    owner: "omnesis-desktop-analytics-build",
    ...identity,
    librarySha256: hash(library),
    licenseHashes,
  };
  await writeFile(join(root, "provenance.json"), JSON.stringify(record), { mode: 0o600 });
  return { root, library, record };
}

test("non-Mac builds and unbounded compiler parallelism refuse before invoking tools", async () => {
  const run = vi.fn();
  await expect(buildDesktopAnalytics({}, { platform: "linux", run })).rejects.toThrow("target Mac");
  await expect(buildDesktopAnalytics({ jobs: 3 }, { platform: "darwin", run })).rejects.toThrow(
    "two compiler workers",
  );
  expect(run).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "cached code is bound to toolchain, architecture, source recipe and original notices",
  async () => {
    const f = await cachedBuild();
    expect((await verifyDesktopAnalyticsBuild(f.root, identity)).library).toBe(
      join(f.root, "libduckdb.dylib"),
    );
    await expect(
      verifyDesktopAnalyticsBuild(f.root, { ...identity, sourcePinsSha256: "c".repeat(64) }),
    ).rejects.toThrow("incomplete or changed");
    await expect(verifyDesktopAnalyticsBuild(f.root, {})).rejects.toThrow("identity is incomplete");
    await writeFile(join(f.root, "licenses/httpfs/LICENSE"), "changed notice");
    await expect(verifyDesktopAnalyticsBuild(f.root, identity)).rejects.toThrow(
      "incomplete or changed",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "modified or aliased build artifacts cannot become an install input",
  async () => {
    const f = await cachedBuild();
    await writeFile(join(f.root, "libduckdb.dylib"), "different compiled bytes");
    await expect(verifyDesktopAnalyticsBuild(f.root, identity)).rejects.toThrow(
      "incomplete or changed",
    );
    const linked = await cachedBuild();
    await rm(join(linked.root, "libduckdb.dylib"));
    await symlink(join(f.root, "libduckdb.dylib"), join(linked.root, "libduckdb.dylib"));
    await expect(verifyDesktopAnalyticsBuild(linked.root, identity)).rejects.toThrow(
      "incomplete or changed",
    );
    const incomplete = await directory();
    await expect(verifyDesktopAnalyticsBuild(incomplete, identity)).rejects.toThrow(
      "incomplete or changed",
    );
    const extra = await cachedBuild();
    await writeFile(
      join(extra.root, "provenance.json"),
      JSON.stringify({ ...extra.record, unexpected: "not a build field" }),
    );
    await expect(verifyDesktopAnalyticsBuild(extra.root, identity)).rejects.toThrow(
      "incomplete or changed",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "vendored notices are copied verbatim with integrity hashes and no source code or linked files",
  async () => {
    const root = await directory(),
      source = join(root, "source"),
      output = join(root, "notices");
    await mkdir(join(source, "third_party/example"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, "LICENSE"), "Invented primary notice\n");
    await writeFile(join(source, "third_party/example/NOTICE.txt"), "Invented transitive notice\n");
    await writeFile(join(source, "implementation.cpp"), "// not a notice\n");
    await symlink(join(source, "LICENSE"), join(source, "LICENSE.alias"));
    const notices = await collectAnalyticsNotices({ duckdb: source }, output);
    expect(Object.keys(notices).sort()).toEqual([
      "duckdb/LICENSE",
      "duckdb/third_party/example/NOTICE.txt",
    ]);
    expect(await readFile(join(output, "duckdb/third_party/example/NOTICE.txt"), "utf8")).toBe(
      "Invented transitive notice\n",
    );
    expect(notices["duckdb/LICENSE"]).toBe(hash("Invented primary notice\n"));
    for (const name of [
      "../outside",
      "duckdb/../../outside",
      "other/LICENSE",
      "duckdb/alias\\LICENSE",
    ])
      expect(validAnalyticsNoticePath(name)).toBe(false);
  },
);

test("desktop staging replaces only the reviewed native binding and keeps upstream notices", async () => {
  const { stageDesktopAnalytics } = await import("./stage-analytics.mjs");
  const { readAnalyticsBuildPins } = await import("./analytics-sources.mjs");
  const f = await cachedBuild();
  f.record.sourcePinsSha256 = hash(JSON.stringify(await readAnalyticsBuildPins()));
  await writeFile(join(f.root, "provenance.json"), JSON.stringify(f.record));
  const target = await directory();
  const binding = join(target, "node_modules/@duckdb/node-bindings-darwin-arm64");
  const gateway = join(target, "packages/gateway");
  await mkdir(binding, { recursive: true });
  await mkdir(join(gateway, "duckdb-extensions"), { recursive: true });
  await writeFile(
    join(binding, "package.json"),
    JSON.stringify({
      name: "@duckdb/node-bindings-darwin-arm64",
      version: "1.5.6-r.1",
    }),
  );
  const original = Buffer.from(f.library);
  original[31] = 42;
  await writeFile(join(binding, "libduckdb.dylib"), original);
  await writeFile(join(binding, "LICENSE"), "Original binding license");
  await writeFile(
    join(gateway, "duckdb-extensions/httpfs.duckdb_extension"),
    "unsuitable packaged file",
  );
  const build = { directory: f.root, provenance: f.record };
  await stageDesktopAnalytics({ target, architecture: "arm64", build });
  expect(await readFile(join(binding, "libduckdb.dylib"))).toEqual(f.library);
  expect(await readFile(join(binding, "LICENSE"), "utf8")).toBe("Original binding license");
  expect(
    await readFile(join(gateway, "desktop-analytics-notices/httpfs/LICENSE"), "utf8"),
  ).toContain("Invented httpfs");
  await expect(
    readFile(join(gateway, "duckdb-extensions/httpfs.duckdb_extension")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    JSON.parse(await readFile(join(gateway, "desktop-analytics.json"), "utf8")).librarySha256,
  ).toBe(hash(f.library));
});

test("desktop staging refuses a different N-API engine version before replacing its code", async () => {
  const { stageDesktopAnalytics } = await import("./stage-analytics.mjs");
  const { readAnalyticsBuildPins } = await import("./analytics-sources.mjs");
  const f = await cachedBuild();
  f.record.sourcePinsSha256 = hash(JSON.stringify(await readAnalyticsBuildPins()));
  await writeFile(join(f.root, "provenance.json"), JSON.stringify(f.record));
  const target = await directory();
  const binding = join(target, "node_modules/@duckdb/node-bindings-darwin-arm64");
  await mkdir(binding, { recursive: true });
  await writeFile(
    join(binding, "package.json"),
    JSON.stringify({
      name: "@duckdb/node-bindings-darwin-arm64",
      version: "0.0.0",
    }),
  );
  await writeFile(join(binding, "libduckdb.dylib"), f.library);
  await expect(
    stageDesktopAnalytics({
      target,
      architecture: "arm64",
      build: {
        directory: f.root,
        provenance: f.record,
      },
    }),
  ).rejects.toThrow("does not match");
  expect(await readFile(join(binding, "libduckdb.dylib"))).toEqual(f.library);
});
