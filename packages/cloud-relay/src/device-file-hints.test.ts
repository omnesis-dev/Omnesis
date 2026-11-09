// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { saveDirectCandidates } from "./device-file-hints.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-device-hints-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const device = { deviceId: "00000000-0000-4000-8000-000000000001", token: "device-token" };
const fresh = [{ address: "10.0.0.20", port: 7600 }];

test("refreshed home addresses replace the saved ones and nothing else, in a private file", async () => {
  const file = join(directory, "collector-device.json");
  const saved = {
    gatewayUrl: "https://gateway.example.test",
    ...device,
    kind: "collector",
    directCandidates: [{ address: "192.168.1.20", port: 7600 }],
    scopes: ["read"],
  };
  await writeFile(file, JSON.stringify(saved), { mode: 0o644 });
  await saveDirectCandidates(file, device, fresh);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...saved, directCandidates: fresh });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("a file that a newer pairing replaced is left alone, and a missing or damaged one is an error", async () => {
  const file = join(directory, "cli-device.json");
  for (const other of [
    { ...device, token: "token-of-a-newer-pairing" },
    { ...device, deviceId: "00000000-0000-4000-8000-000000000002" },
  ]) {
    const text = JSON.stringify({ ...other, directCandidates: [] });
    await writeFile(file, text);
    await saveDirectCandidates(file, device, fresh);
    expect(await readFile(file, "utf8")).toBe(text);
  }
  await writeFile(file, JSON.stringify({ deviceId: 7 }));
  await expect(saveDirectCandidates(file, device, fresh)).rejects.toThrow();
  await expect(
    saveDirectCandidates(join(directory, "absent.json"), device, fresh),
  ).rejects.toThrow();
});
