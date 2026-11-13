// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { X509Certificate } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, networkInterfaces, hostname } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tlsFiles } from "../test/support.js";
import { googleBrowserCallback } from "./google-browser-callback.js";
const path = "/devices/google/callback";
test("callbacks remain on configured direct/cloud origins or certified actual local listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "google-callback-"));
  try {
    const files = tlsFiles(directory, hostname());
    const certificate = new X509Certificate(await readFile(files.certFile));
    const options = {
      origins: [undefined, "https://direct.example.test", "https://cloud.example.test"],
      port: 7600,
      certificates: [certificate],
    };
    expect(googleBrowserCallback("https://direct.example.test", path, options)).toBe(
      `https://direct.example.test${path}`,
    );
    expect(
      googleBrowserCallback(
        "https://cloud.example.test",
        "/admin/cloud-relay/google/callback",
        options,
      ),
    ).toContain("/admin/cloud-relay/google/callback");
    for (const origin of [
      "https://localhost:7600",
      "https://127.0.0.1:7600",
      "https://[::1]:7600",
      `https://${hostname()}:7600`,
    ]) {
      const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      const local = Object.values(networkInterfaces()).some((values) =>
        values?.some((value) => value.address === host),
      );
      if (host === "localhost" || host === hostname() || local)
        expect(googleBrowserCallback(origin, path, options)).toBe(origin + path);
    }
    const localOptions = {
      ...options,
      localAddresses: ["127.0.0.1", "::1"],
      localNames: ["localhost"],
    };
    expect(googleBrowserCallback("https://127.0.0.1:7600", path, localOptions)).toContain(
      "127.0.0.1",
    );
    expect(googleBrowserCallback("https://[::1]:7600", path, localOptions)).toContain("[::1]");
    for (const origin of [
      "https://evil.example.test",
      "https://localhost:7601",
      "https://192.0.2.1:7600",
      "https://direct.example.test/path",
      "http://direct.example.test",
      "https://user@direct.example.test",
      "https://direct.example.test?query",
      "https://direct.example.test#fragment",
      "https://direct.example.test/",
      "x".repeat(2049),
    ])
      expect(() => googleBrowserCallback(origin, path, options)).toThrow();
    expect(() =>
      googleBrowserCallback("https://localhost:7600", path, { ...localOptions, certificates: [] }),
    ).toThrow();
    expect(() =>
      googleBrowserCallback("https://localhost:7600", path, { origins: [], port: 7600 }),
    ).toThrow();
    expect(() =>
      googleBrowserCallback("https://127.0.0.2:7600", path, {
        ...localOptions,
        localAddresses: ["127.0.0.2"],
      }),
    ).toThrow();
    expect(() =>
      googleBrowserCallback("https://other.local:7600", path, {
        ...localOptions,
        localNames: ["other.local"],
      }),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
