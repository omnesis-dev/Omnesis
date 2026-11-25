// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  discoverDesktopUpdate,
  downloadDesktopUpdate,
  parseDesktopUpdateRelease,
} from "./update-release.js";

const contents = Buffer.from("invented inert installer fixture");
const hash = createHash("sha256").update(contents).digest("hex");
const asset = {
  name: "Omnesis-1.2.3-macos-arm64.dmg",
  size: contents.length,
  digest: `sha256:${hash}`,
  browser_download_url:
    "https://github.com/omnesis-dev/Omnesis/releases/download/v1.2.3/Omnesis-1.2.3-macos-arm64.dmg",
};
const feed = { tag_name: "v1.2.3", draft: false, prerelease: false, assets: [asset] };
const release = () => parseDesktopUpdateRelease(feed, "1.2.2", "arm64")!;
const signal = () => new AbortController().signal;
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-fixture-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("selects only a strictly newer stable official installer for the exact architecture", () => {
  expect(release()).toMatchObject({ version: "1.2.3", architecture: "arm64", sha256: hash });
  expect(parseDesktopUpdateRelease(feed, "1.2.3", "arm64")).toBeNull();
  expect(parseDesktopUpdateRelease(feed, "1.2.4", "arm64")).toBeNull();
  expect(() => parseDesktopUpdateRelease(feed, "1.2.2", "x64")).toThrow("unique installer");
  expect(() =>
    parseDesktopUpdateRelease({ ...feed, prerelease: true }, "1.2.2", "arm64"),
  ).toThrow();
  expect(() =>
    parseDesktopUpdateRelease({ ...feed, tag_name: "v1.2.3-beta.1" }, "1.2.2", "arm64"),
  ).toThrow();
});
test("refuses duplicate, substituted-origin and unsigned-digest descriptors", () => {
  for (const assets of [
    [asset, asset],
    [{ ...asset, browser_download_url: "https://installer.example.test/app.dmg" }],
    [{ ...asset, digest: null }],
  ]) {
    expect(() => parseDesktopUpdateRelease({ ...feed, assets }, "1.2.2", "arm64")).toThrow();
  }
});
test("discovery uses a fixed official API with a bounded response and injected transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(feed)));
  expect(await discoverDesktopUpdate("1.2.2", "arm64", signal(), fetcher)).toEqual(release());
  expect(fetcher.mock.calls[0]![0]).toBe(
    "https://api.github.com/repos/omnesis-dev/Omnesis/releases/latest",
  );
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  fetcher.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
  await expect(discoverDesktopUpdate("1.2.2", "arm64", signal(), fetcher)).rejects.toThrow(
    "too large",
  );
});
test.skipIf(process.platform === "win32")(
  "download writes only a verified private inert artifact with measured progress",
  async () => {
    const progress = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(contents));
    const path = await downloadDesktopUpdate(release(), directory, signal(), {
      fetch: fetcher,
      progress,
    });
    expect(await readFile(path)).toEqual(contents);
    expect(progress).toHaveBeenLastCalledWith(contents.length, contents.length);
    expect(await readdir(directory)).toEqual([`${hash}.dmg`]);
  },
);
test.skipIf(process.platform === "win32")(
  "only HTTPS official asset CDN redirects are accepted",
  async () => {
    const allowed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/example?temporary=fixture",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(contents));
    await downloadDesktopUpdate(release(), directory, signal(), { fetch: allowed });
    expect(allowed).toHaveBeenCalledTimes(2);
    const userInfo = new URL("https://github.com/file");
    userInfo.username = "fixture";
    for (const location of [
      "http://github.com/file",
      "https://malware.example.test/file",
      "file:///tmp/file",
      userInfo.href,
      "https://github.com:444/file",
    ]) {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(
        downloadDesktopUpdate(release(), directory, signal(), { fetch: fetcher }),
      ).rejects.toThrow("official host");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  },
);
test.skipIf(process.platform === "win32")(
  "size, digest and truncated-body failures remove all partial downloads",
  async () => {
    for (const content of [
      Buffer.from("wrong"),
      Buffer.alloc(contents.length + 1),
      Buffer.alloc(contents.length),
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(content));
      await expect(
        downloadDesktopUpdate(release(), directory, signal(), { fetch: fetcher }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    }
  },
);
test.skipIf(process.platform === "win32")(
  "download failure and cancellation leave no partial file",
  async () => {
    const failure = new Error("fixture transport failed");
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        ),
    );
    await expect(
      downloadDesktopUpdate(release(), directory, signal(), { fetch: fetcher }),
    ).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(
      downloadDesktopUpdate(release(), directory, abort.signal, { fetch: fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
test.skipIf(process.platform === "win32")(
  "an unsafe destination or forged public descriptor never triggers a download",
  async () => {
    const fetcher = vi.fn<typeof fetch>();
    await chmod(directory, 0o755);
    await expect(
      downloadDesktopUpdate(release(), directory, signal(), { fetch: fetcher }),
    ).rejects.toThrow("private");
    await chmod(directory, 0o700);
    await expect(
      downloadDesktopUpdate(
        { ...release(), url: "https://other.example.test/app.dmg" },
        directory,
        signal(),
        { fetch: fetcher },
      ),
    ).rejects.toThrow("descriptor");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
