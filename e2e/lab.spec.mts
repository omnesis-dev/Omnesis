// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../packages/collector/src/e2e/synth-env.js";
import { test, expect } from "@playwright/test";
import { SyntheticE2EHarness } from "../packages/collector/src/e2e/synth-harness.js";

test("Lab opt-ins persist and independently control portal navigation", async ({ page }) => {
  test.setTimeout(180_000);
  const harness = new SyntheticE2EHarness({ gatewayMode: "synthetic-experimental" });
  await harness.start();
  try {
    await page.goto(`${harness.gatewayUrl}/portal/?token=${encodeURIComponent(harness.apiKey)}`);
    await expect(page.locator("nav.sidebar-nav")).toBeVisible();
    await page.goto(`${harness.gatewayUrl}/portal/settings/lab`);
    const brain = page.getByRole("switch", { name: "Enable Brain", exact: true });
    const tasks = page.getByRole("switch", { name: "Enable Tasks", exact: true });
    const watches = page.getByRole("switch", { name: "Enable Watches", exact: true });
    for (const toggle of [brain, tasks, watches])
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    const nav = page.locator("nav.sidebar-nav");
    const sweeps = page.getByRole("button", { name: "Sweeps", exact: true });
    await expect(nav.locator('[href="/portal/tasks"]')).toHaveCount(0);
    await expect(nav.locator('[href="/portal/watches"]')).toHaveCount(0);
    await expect(sweeps).toHaveCount(0);
    await tasks.click();
    await expect(tasks).toHaveAttribute("aria-checked", "true");
    await expect(nav.locator('[href="/portal/tasks"]')).toBeVisible();
    await expect(sweeps).toHaveCount(0);
    await expect(watches).toBeEnabled();
    await watches.click();
    await expect(nav.locator('[href="/portal/watches"]')).toBeVisible();
    await expect(brain).toBeEnabled();
    await brain.click();
    await expect(sweeps).toBeVisible();
    await expect(brain).toBeEnabled();
    await brain.click();
    await expect(sweeps).toHaveCount(0);
    await expect(nav.locator('[href="/portal/tasks"]')).toBeVisible();
    await expect(nav.locator('[href="/portal/watches"]')).toBeVisible();
    await page.reload();
    await expect(brain).toHaveAttribute("aria-checked", "false");
    await expect(tasks).toHaveAttribute("aria-checked", "true");
    await expect(watches).toHaveAttribute("aria-checked", "true");
    await page.goto(`${harness.gatewayUrl}/portal/settings/sweeps`);
    await expect(page.locator(".config-tab.active")).toHaveText("Config");
  } finally {
    await harness.destroy();
  }
});

test("a stable gateway does not offer Omnesis Lab", async ({ page }) => {
  test.setTimeout(180_000);
  const harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
  await harness.start();
  try {
    await page.goto(`${harness.gatewayUrl}/portal/?token=${encodeURIComponent(harness.apiKey)}`);
    await expect(page.locator("nav.sidebar-nav")).toBeVisible();
    await page.goto(`${harness.gatewayUrl}/portal/settings/lab`);
    await expect(page.locator(".config-tab.active")).toHaveText("Config");
    await expect(page.getByRole("button", { name: "Omnesis Lab", exact: true })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  } finally {
    await harness.destroy();
  }
});
