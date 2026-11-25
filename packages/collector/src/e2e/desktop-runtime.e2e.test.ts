// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isEncryptedSecretFile } from "@omnesis/core";
import { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";
import { E2EHarness } from "./harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

/** Real desktop CLI/daemon/gateway/collector with only the OS Keychain command substituted. */
describe.skipIf(process.platform === "win32")(
  "managed desktop lifecycle beside a headless library",
  { sequential: true },
  () => {
    let desktop: DesktopRuntimeFixture;
    let headless: E2EHarness;
    let port: number;
    beforeAll(async () => {
      headless = new E2EHarness();
      await headless.start();
      desktop = await DesktopRuntimeFixture.create();
    }, gatewayBootBudgetMs() * 2);

    afterAll(async () => {
      try {
        await desktop?.close();
      } finally {
        await headless?.destroy();
      }
    }, 180_000);

    test("account gating observes real encrypted startup without adopting the existing library", async () => {
      const state = await desktop.command("connect", undefined, {
        OMNESIS_CONFIG_DIR: headless.configDir,
        OMNESIS_GATEWAY_URL: headless.gatewayUrl,
        OMNESIS_TOKEN: headless.apiKey,
        OMNESIS_SECRET_SERVICE: "dev.omnesis",
      });
      expect(state).toMatchObject({ phase: "accountRequired", mode: "home", encrypted: true });
      expect(state.connection).toBeUndefined();
      expect(await desktop.request("/health")).toMatchObject({
        status: "ok",
        storageProtection: { version: 1, atRest: "encrypted" },
      });
      const runtime = JSON.parse(
        await readFile(join(desktop.profile.configDir, "runtime.json"), "utf8"),
      );
      port = runtime.port;
      expect(port).not.toBe(Number(new URL(headless.gatewayUrl).port));
      expect(await headless.gatewayJson("/health")).toMatchObject({ status: "ok" });
      const token = await readFile(join(desktop.profile.configDir, "token"), "utf8");
      expect(isEncryptedSecretFile(token)).toBe(true);
      const store = await readFile(join(desktop.profile.configDir, "omnesis.db"));
      expect(store.subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
    }, 180_000);

    test("an exact owned stop and reconnect preserve encrypted state and the independent headless gateway", async () => {
      expect(await desktop.command("stop")).toMatchObject({ phase: "waiting", mode: "home" });
      const before = await readFile(
        join(desktop.profile.configDir, "desktop-install.json"),
        "utf8",
      );
      expect(await desktop.command("connect")).toMatchObject({
        phase: "accountRequired",
        encrypted: true,
      });
      expect(await readFile(join(desktop.profile.configDir, "desktop-install.json"), "utf8")).toBe(
        before,
      );
      expect(
        JSON.parse(await readFile(join(desktop.profile.configDir, "runtime.json"), "utf8")).port,
      ).toBe(port);
      expect(await headless.gatewayJson("/health")).toMatchObject({ status: "ok" });
      expect(
        isEncryptedSecretFile(await readFile(join(desktop.profile.configDir, "token"), "utf8")),
      ).toBe(true);
    }, 180_000);

    test("keep-data removal stops the real runtime until explicit reconnection resumes the same library", async () => {
      const plan = await desktop.command("removePreview");
      expect(plan).toMatchObject({
        available: true,
        mode: "keep-data",
        dataKept: true,
        keyKept: true,
      });
      expect(
        await desktop.command("remove", { confirmationId: plan.confirmationId }),
      ).toMatchObject({ status: "retired", data: "retained", keyring: "retained" });
      expect(await desktop.command("status")).toMatchObject({ retired: true });
      expect(await headless.gatewayJson("/health")).toMatchObject({ status: "ok" });
      expect(await desktop.command("connect")).toMatchObject({
        phase: "accountRequired",
        encrypted: true,
      });
      expect(await desktop.request("/health")).toMatchObject({ status: "ok" });
    }, 180_000);
  },
);
