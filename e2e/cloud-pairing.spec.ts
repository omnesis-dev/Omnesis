// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const fingerprint = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () =>
  readFileSync(join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"), "utf8").trim();
function challenge() {
  const value = {
    requestId: randomUUID(),
    name: "Fictional test browser",
    secret: randomBytes(32).toString("hex"),
    gatewayFingerprint: fingerprint,
    expiresAt: Date.now() + 600_000,
  };
  const verificationCode = digest(
    JSON.stringify(["omnesis-pairing-sas-v2", fingerprint, value.requestId, digest(value.secret)]),
  )
    .slice(0, 20)
    .toUpperCase()
    .match(/.{4}/g)!
    .join("-");
  return { value, verificationCode };
}
async function configured(page: Page) {
  await page.route("**/devices/google/config", (route) =>
    route.fulfill({
      json: {
        clientId: "fictional-web-client",
        gatewayFingerprint: fingerprint,
        webSignIn: true,
      },
    }),
  );
}
async function pendingBrowser(page: Page, pairingCode: string, replaceCode = false) {
  await configured(page);
  const { value, verificationCode } = challenge();
  await page.addInitScript((pending) => {
    if (new URL(location.href).searchParams.get("googlePairing") === pending.requestId)
      sessionStorage.setItem("omnesis.google-pairing", JSON.stringify(pending));
  }, value);
  await page.route("**/devices/google/poll", (route) =>
    route.fulfill({
      json: {
        status: "approved",
        verificationCode: replaceCode ? "FFFF-FFFF-FFFF-FFFF-FFFF" : verificationCode,
        expiresAt: Date.now() + 60_000,
        pairingCode,
      },
    }),
  );
  await page.goto(`/portal/?googlePairing=${value.requestId}`);
  return { value, verificationCode };
}

test("optional Google sign-in stays hidden when configuration is absent", async ({ page }) => {
  await page.route("**/devices/google/config", (route) =>
    route.fulfill({ status: 404, body: "Not Found" }),
  );
  await page.goto("/portal/");
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
});

test("device approval requires comparison and renders long names and the complete verification code", async ({
  page,
}) => {
  await configured(page);
  const { value, verificationCode } = challenge();
  let decided = false;
  await page.route("**/admin/cloud-pairing/requests", (route) =>
    route.fulfill({
      json: {
        items: decided
          ? []
          : [
              {
                requestId: value.requestId,
                name: "Fictional phone with a long device name for comparison",
                kind: "android",
                status: "pending",
                verificationCode,
                expiresAt: value.expiresAt,
              },
            ],
      },
    }),
  );
  await page.route("**/admin/cloud-pairing/decision", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: value.requestId, approve: true });
    decided = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  const section = page.getByRole("region", { name: "Google device pairing" });
  await expect(section.getByText(verificationCode, { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Approve device" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await section.screenshot({ path: "/tmp/omnesis-cloud-pairing-owner.png" });
  await section.getByRole("checkbox").check();
  await section.getByRole("button", { name: "Approve device" }).click();
  await expect(section.getByText("No device pairing requests.")).toBeVisible();
});

test("remote approval cannot pair a browser until its user confirms the locally calculated code", async ({
  page,
  request,
}) => {
  const response = await request.post("/admin/devices/pair", {
    headers: { Authorization: `Bearer ${token()}` },
    data: { kind: "portal", name: "Fictional Google browser" },
  });
  expect(response.ok()).toBe(true);
  const pairing = await response.json();
  const { verificationCode } = await pendingBrowser(page, pairing.pairingCode);
  await expect(page.getByText("Approved by your gateway.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pair this browser" })).toBeDisabled();
  await expect(page.getByText(verificationCode, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/omnesis-cloud-pairing-browser.png", fullPage: true });
  await page
    .getByRole("checkbox", { name: "I compared the code on my trusted device and it matches." })
    .check();
  await page.getByRole("button", { name: "Pair this browser" }).click();
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("omnesis.google-pairing"))).toBeNull();
});

test("a substituted gateway code fails closed even when a remote response says approved", async ({
  page,
}) => {
  await pendingBrowser(page, "UNTRUSTED-CODE", true);
  await expect(page.getByRole("alert")).toContainText("gateway or pairing request changed");
  await page.getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "Pair this browser" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("omnesis.google-pairing"))).toBeNull();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});
