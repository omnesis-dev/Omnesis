// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readInstallRootKey, readInstallRootKeySync } from "./secret-store.js";
import { writeSecureMarker, writeSecureMarkerSync } from "./secure-marker.js";
import {
  clearSecretFileKeyCacheForTests,
  decodeSecretTextFileValue,
  decodeSecretTextFileValueSync,
  primeSecretFileKeyCache,
  writeSecretTextFile,
  writeSecretTextFileSync,
} from "./secret-file.js";

const fixture = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("./secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secret-store.js")>()),
  readInstallRootKey: vi.fn(),
  readInstallRootKeySync: vi.fn(),
}));
vi.mock("./security-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./security-files.js")>()),
  secretPathExists: () => false,
}));
vi.mock("./atomic-write.js", () => ({
  atomicWriteFile: async (path: string, value: string) => {
    fixture.files.set(path, value);
  },
  atomicWriteFileSync: (path: string, value: string) => {
    fixture.files.set(path, value);
  },
}));
vi.mock("./secure-marker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secure-marker.js")>()),
  writeSecureMarker: vi.fn(async () => {}),
  writeSecureMarkerSync: vi.fn(),
}));

const configA = resolve("invented-install-a");
const configB = resolve("invented-install-b");
const keyA = `omn_root_v1_${Buffer.alloc(32, 17).toString("base64url")}`;
const keyB = `omn_root_v1_${Buffer.alloc(32, 29).toString("base64url")}`;
const optionsA = { backend: "file" as const, configDir: configA };
const optionsB = { backend: "file" as const, configDir: configB };
const pathA = resolve(configA, "fixture.secret");
const pathB = resolve(configB, "fixture.secret");

function serialized(path: string): string {
  const value = fixture.files.get(path);
  if (value === undefined) throw new Error("Fixture did not publish an envelope");
  return value;
}

describe("secret-file cached installation identity", () => {
  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    fixture.files.clear();
    vi.clearAllMocks();
    vi.mocked(readInstallRootKey).mockImplementation(async (opts) =>
      opts?.configDir === configA ? keyA : keyB,
    );
    vi.mocked(readInstallRootKeySync).mockImplementation((opts) =>
      opts?.configDir === configA ? keyA : keyB,
    );
  });

  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    vi.unstubAllEnvs();
  });

  for (const sync of [false, true]) {
    const label = sync ? "sync" : "async";

    test(`${label} decoding selects the envelope's installation after another installation is primed`, async () => {
      await writeSecretTextFile(pathA, "invented-value-a", optionsA);
      clearSecretFileKeyCacheForTests();
      await primeSecretFileKeyCache(optionsB);
      const value = sync
        ? decodeSecretTextFileValueSync(pathA, serialized(pathA), optionsA)
        : await decodeSecretTextFileValue(pathA, serialized(pathA), optionsA);
      expect(value).toBe("invented-value-a");
    });

    test(`${label} writes use the destination installation's key and marker`, async () => {
      await primeSecretFileKeyCache(optionsA);
      if (sync) writeSecretTextFileSync(pathB, "invented-value-b", optionsB);
      else await writeSecretTextFile(pathB, "invented-value-b", optionsB);
      const marker = sync ? writeSecureMarkerSync : writeSecureMarker;
      expect(marker).toHaveBeenCalledWith(
        "secret-files",
        expect.objectContaining({ configDir: configB, rootKeyValue: keyB }),
      );
      clearSecretFileKeyCacheForTests();
      expect(await decodeSecretTextFileValue(pathB, serialized(pathB), optionsB)).toBe(
        "invented-value-b",
      );
    });

    test(`${label} same-install writes retain a primed file key with an automatic backend`, async () => {
      vi.stubEnv("OMNESIS_SECRET_STORE", "auto");
      await primeSecretFileKeyCache(optionsA);
      vi.mocked(readInstallRootKey).mockRejectedValue(new Error("Keyring is unreadable"));
      vi.mocked(readInstallRootKeySync).mockImplementation(() => {
        throw new Error("Keyring is unreadable");
      });
      const opts = { configDir: configA };
      if (sync) writeSecretTextFileSync(pathA, "invented-value-a", opts);
      else await writeSecretTextFile(pathA, "invented-value-a", opts);
      expect(decodeSecretTextFileValueSync(pathA, serialized(pathA), opts)).toBe(
        "invented-value-a",
      );
      expect(readInstallRootKey).toHaveBeenCalledTimes(1);
      expect(readInstallRootKeySync).not.toHaveBeenCalled();
    });
  }
});
