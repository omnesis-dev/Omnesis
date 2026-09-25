// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";

const browser = vi.hoisted(() => ({ baseDir: "", engine: "chromium" }));
vi.mock("./paths.js", () => ({
  getBrowserInfo: () => ({ ...browser, id: "chrome", name: "Fixture browser" }),
  detectInstalledBrowsers: () => [],
}));
import { probeChromiumReadAccess } from "./read-access.js";
import definition from "./index.js";

afterEach(async () => {
  vi.restoreAllMocks();
  if (browser.baseDir) await rm(browser.baseDir, { recursive: true, force: true });
  browser.baseDir = "";
  browser.engine = "chromium";
});

// Optional on the declaration type, because a definition may be a provider
// entry that never instantiates one. This source does.
const createInstance = definition.create!;

async function create() {
  // Exercise the reader's array-valued profile filter; the shared parameter
  // schema is string-only, while this provider's runtime accepts this shape.
  const sourceConfig = {
    enabled: true,
    params: { excludeProfiles: ["Excluded"] },
  } as unknown as NonNullable<Parameters<typeof createInstance>[0]["sourceConfig"]>;
  return createInstance({
    accountId: "chrome",
    sourceId: SourceId("browser-history:chrome"),
    providerId: ProviderId("browser-history:chrome"),
    sourceConfig,
  });
}

test("opens selected History files and Local State afresh, never WAL or excluded profiles", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  for (const profile of ["Default", "Profile 1"]) {
    await mkdir(join(browser.baseDir, profile));
    await writeFile(join(browser.baseDir, profile, "History"), "not a database");
  }
  const statePath = join(browser.baseDir, "Local State");
  await writeFile(
    statePath,
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Selected" }, "Profile 1": { name: "Excluded" } } },
    }),
  );
  const instance = await create();
  const open = vi.spyOn(fs, "open");
  const copy = vi.spyOn(fs, "copyFile");
  const signal = new AbortController().signal;
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  expect(open.mock.calls.map(([path]) => path)).toEqual([
    join(browser.baseDir, "Default", "History"),
  ]);
  expect(copy).not.toHaveBeenCalled();
  open.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    (callback as (error: Error) => void)(
      Object.assign(new Error("private location"), { code: "EACCES" }),
    );
  });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "denied" });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  await rm(join(browser.baseDir, "Default", "History"));
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "unavailable" });
  expect(await instance.probeReadAccess!({ signal: AbortSignal.abort() })).toEqual({
    status: "unavailable",
  });
});

test("no discovered profiles is unavailable, not an empty successful check", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  const instance = await create();
  expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
    status: "unavailable",
  });
});

test("refuses profile metadata that is not a single directory name", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  await mkdir(join(browser.baseDir, "nested", "Default"), { recursive: true });
  await writeFile(join(browser.baseDir, "nested", "Default", "History"), "fixture");
  await writeFile(
    join(browser.baseDir, "Local State"),
    JSON.stringify({ profile: { info_cache: { "nested/Default": { name: "Selected" } } } }),
  );
  const instance = await create();
  expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
    status: "unavailable",
  });
});

test("Safari opens its primary database without querying it", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  browser.engine = "safari";
  await writeFile(join(browser.baseDir, "History.db"), "not a database");
  const instance = await create();
  expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
    status: "readable",
  });
});

test("discovers added profiles and exclusion-name changes without waiting for sync", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  await mkdir(join(browser.baseDir, "Default"));
  await writeFile(join(browser.baseDir, "Default", "History"), "not a database");
  const state = join(browser.baseDir, "Local State");
  await writeFile(
    state,
    JSON.stringify({ profile: { info_cache: { Default: { name: "Selected" } } } }),
  );
  const instance = await create();
  const signal = new AbortController().signal;
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  await mkdir(join(browser.baseDir, "Profile 2"));
  await writeFile(join(browser.baseDir, "Profile 2", "History"), "not a database");
  await writeFile(
    state,
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Selected" }, "Profile 2": { name: "Added" } } },
    }),
  );
  const originalOpen = fs.open;
  const open = vi.spyOn(fs, "open").mockImplementation((...args: unknown[]) => {
    if (args[0] === join(browser.baseDir, "Profile 2", "History")) {
      (args.at(-1) as (error: Error) => void)(
        Object.assign(new Error("private path"), { code: "EACCES" }),
      );
    } else {
      Reflect.apply(originalOpen, fs, args);
    }
  });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "denied" });
  await writeFile(
    state,
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Selected" },
          "Profile 2": { name: "Added", user_name: "Excluded" },
        },
      },
    }),
  );
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  open.mockRestore();
  await writeFile(
    state,
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Selected" }, "Profile 2": { name: "Added" } } },
    }),
  );
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
});

test("missing eligible History remains unverified and is probed when it appears", async () => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  await mkdir(join(browser.baseDir, "Default"));
  await writeFile(
    join(browser.baseDir, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Selected" } } } }),
  );
  const instance = await create();
  const signal = new AbortController().signal;
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "unavailable" });
  await writeFile(join(browser.baseDir, "Default", "History"), "not a database");
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
});

test.each([
  "not JSON",
  JSON.stringify({ profile: { info_cache: [] } }),
  JSON.stringify({ profile: { info_cache: { "../escape": { name: "Selected" } } } }),
  JSON.stringify({ profile: { info_cache: { Default: { name: 42 } } } }),
  JSON.stringify({
    profile: {
      info_cache: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`Profile ${index}`, {}]),
      ),
    },
  }),
  " ".repeat(4 * 1024 * 1024 + 1),
])("invalid or excessive discovery metadata is unverified", async (metadata) => {
  browser.baseDir = await mkdtemp(join(tmpdir(), "browser-access-"));
  await writeFile(join(browser.baseDir, "Local State"), metadata);
  expect(
    await probeChromiumReadAccess(browser.baseDir, [], { signal: new AbortController().signal }),
  ).toEqual({ status: "unavailable" });
});

test.each(["EACCES", "EPERM", "ENOENT"])(
  "classifies metadata open %s without exposing errors",
  async (code) => {
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(
      Object.assign(new Error("private profile metadata"), { code }),
    );
    expect(
      await probeChromiumReadAccess("/example/browser", [], {
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: code === "ENOENT" ? "unavailable" : "denied" });
  },
);

test("abort retains late metadata handle ownership until close, without reading", async () => {
  let finish!: (handle: never) => void;
  vi.spyOn(fsPromises, "open").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = probeChromiumReadAccess("/example/browser", [], { signal: controller.signal });
  controller.abort();
  const handle = { read: vi.fn(), stat: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  finish(handle as never);
  expect(await pending).toEqual({ status: "unavailable" });
  expect(handle.close).toHaveBeenCalledOnce();
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.stat).not.toHaveBeenCalled();
});
