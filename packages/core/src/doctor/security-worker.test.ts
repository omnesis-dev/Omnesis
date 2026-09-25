// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectSecurityDataInWorker } from "./security-worker.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collectSecurityDataInWorker", () => {
  test("collects a component-scoped report in a source-mode worker", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-security-worker-"));
    dirs.push(configDir);

    const data = await collectSecurityDataInWorker({
      configDir,
      component: "collector",
      timeoutMs: 10_000,
    });

    expect(data.configDir).toBe(configDir);
    expect(data.fixPermissions).toBe(false);
    expect(data.serviceUnits.every((unit) => unit.component === "collector")).toBe(true);
    expect(data.gatewayIsolation.status).toBe("not-applicable");
    // The collector's own inventory: nothing armed on a fresh directory.
    expect(data.databaseEncryption.status).toBe("off");
    expect(data.databaseEncryption.stores.map((store) => store.keyName)).toEqual([
      "whatsapp-store",
      "imessage-transcripts",
    ]);
  });

  test("rejects a non-positive timeout before spawning", async () => {
    await expect(
      collectSecurityDataInWorker({ configDir: "/fixture", timeoutMs: 0 }),
    ).rejects.toThrow(/positive finite/);
  });
});
