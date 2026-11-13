// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

// Invented accounts and content throughout.
const policyId = "00000000-0000-4000-8000-0000000000b1";
const approvalId = "approval-fictional-planner";
const mail = {
  id: "fictional-mail:reader@example.org",
  sourceType: "fictional-mail",
  name: "Fictional mail",
  icon: null,
  available: true,
  scopes: {
    items: [
      { kind: "label", noun: { one: "label", many: "Labels" }, picker: "search", link: "changes" },
    ],
  },
  scopeReadiness: [{ kind: "label", ready: true }],
};
const files = {
  id: "fictional-files:reader@example.org",
  sourceType: "fictional-files",
  name: "Fictional files",
  icon: null,
  available: true,
};
const label = { kind: "label", id: "fictional-planning" };

test("approving a request onto a new access level uses the access-level page's decisions and filter dialog", async ({
  page,
}) => {
  // The test runner creates this isolated directory; never fall back to an installed gateway.
  const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
  if (!configDir) throw new Error("An isolated portal test gateway is required.");
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  expect((await page.request.post("/portal/api/login", { data: { token } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 1000 });

  const request = {
    id: "request-fictional-planner",
    approvalId,
    status: "pending",
    clientId: "client-fictional-planner",
    clientName: "Fictional planner",
    clientUri: "https://planner.example.org",
    redirectOrigin: "https://planner.example.org",
    resource: "https://gateway.example.org/mcp",
    expiresAt: Date.now() + 9 * 60_000,
    requiresAnswer: false,
  };
  let decision: Record<string, unknown> | null = null;
  await page.route("**/admin/access", (route) =>
    route.fulfill({
      json: {
        principals: [],
        pendingAuthorizations: [],
        pendingRequests: [],
        oauth: null,
        policies: [],
        policyFamilies: [{ id: policyId, name: "Fictional everyday policy", isDefault: true }],
        defaultPolicyFamilyId: policyId,
        sourceFilters: { enabled: true },
        sources: [mail, files],
        levels: [],
      },
    }),
  );
  await page.route(`**/portal/api/access/authorizations/${approvalId}`, (route) =>
    route.fulfill({
      json: {
        request,
        reconnect: null,
        connection: {
          defaultName: "Fictional planner",
          defaultLevelName: "Fictional planner",
          match: null,
          recommended: "new-level",
        },
      },
    }),
  );
  await page.route(`**/portal/api/access/authorizations/${approvalId}/decision`, async (route) => {
    decision = route.request().postDataJSON();
    await route.fulfill({ json: { request: { ...request, status: "approved" } } });
  });
  await page.route("**/admin/access/source-filters/*/options?*", (route) =>
    route.fulfill({
      json: {
        sourceId: mail.id,
        scopes: mail.scopes,
        readiness: mail.scopeReadiness,
        items: [{ ref: label, label: "Fictional planning", count: 6 }],
      },
    }),
  );
  await page.route("**/admin/access/source-filters/*/preview", (route) =>
    route.fulfill({
      json: {
        sourceId: mail.id,
        total: 20,
        visible: 6,
        hidden: 14,
        unknown: 0,
        readiness: mail.scopeReadiness,
        items: [{ ref: label, label: "Fictional planning", count: 6 }],
        samples: [],
      },
    }),
  );

  const step = () => page.locator(".access-wizard-steps [aria-current='step']");
  const question = (name: string) => page.getByRole("heading", { name, exact: true });
  const forward = () => page.getByRole("button", { name: "Continue", exact: true }).click();
  const dialog = page.getByRole("dialog");

  await page.goto(`/portal/settings/access/authorizations/${approvalId}`);
  await expect(question("Approve a connection")).toBeVisible();
  await expect(page.locator(".access-wizard-steps button")).toHaveText([
    /Connection$/,
    /Permissions$/,
    /Data$/,
    /Review$/,
  ]);
  await expect(page.getByRole("radio", { name: "New access level", exact: true })).toBeChecked();
  await forward();

  await expect(step()).toContainText("Permissions");
  await expect(question("What should this connection be allowed to do?")).toBeFocused();
  await expect(page.locator(".access-capability-preset").first()).toContainText(
    "Ask questions to the Omnesis agent using allowed sources. A privacy policy can review every answer before it is released.",
  );
  await page
    .locator(".access-capability-preset")
    .filter({ has: page.getByText("Direct", { exact: true }) })
    .locator("input")
    .check();
  await forward();

  // Data: the same account list and filter dialog the access-level page uses.
  await expect(step()).toContainText("Data");
  await expect(question("Which sources can Answer use?")).toBeVisible();
  await forward();
  await expect(page.getByRole("alert")).toHaveText("Select at least one source for Answer.");
  const mailRow = page
    .locator(".guided-source-row")
    .filter({ has: page.getByText("Fictional mail", { exact: true }) });
  await mailRow.getByRole("checkbox").check();
  await mailRow.getByRole("button", { name: "Change Fictional mail content", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "What should be shared?" }).first(),
  ).toBeVisible();
  await dialog.getByLabel("Only matching content", { exact: false }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("searchbox", { name: "Search label", exact: true }).focus();
  await dialog.getByRole("checkbox", { name: /Fictional planning/ }).check();
  await dialog.locator(".modal-title").click();
  await expect(dialog.locator(".source-filter-counts")).toContainText("6 shared");
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(mailRow).toContainText("Only 1 selected match");
  await forward();

  await expect(step()).toContainText("Data");
  await expect(question("Which sources can Direct read?")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Use same sources and filters as Answer mode", exact: true }),
  ).toBeChecked();
  await expect(page.locator(".guided-reuse-summary")).toContainText("Fictional mail");
  await forward();
  await expect(question("What about new sources?")).toBeVisible();
  await forward();
  await expect(question("How should answers be released?")).toBeVisible();
  await forward();

  // Review: the connection, then the new level decision by decision.
  await expect(step()).toContainText("Review");
  await expect(page.locator(".access-review-rows")).toContainText("Fictional planner (new)");
  // A new level names itself on the Access level row; its permissions are a
  // decision below, so the pills are listed there and only there.
  await expect(page.locator(".access-review-rows .capability-pills")).toHaveCount(0);
  await expect(
    page.locator(".access-review-decisions .guided-review-decision .capability-pills"),
  ).toHaveAccessibleName("Answer and Direct allowed, Notes not allowed");
  await expect(page.locator(".access-review-decisions .guided-review-decision h4")).toHaveText([
    "Permissions",
    "Answer data",
    "Direct data",
    "New sources",
    "Answer release",
  ]);
  await page
    .locator(".access-review-decisions .guided-review-decision")
    .filter({ has: page.getByRole("heading", { name: "New sources", exact: true }) })
    .getByRole("button", { name: "Change", exact: true })
    .click();
  await expect(question("What about new sources?")).toBeVisible();
  await forward();
  await expect(step()).toContainText("Review");

  await page.getByRole("button", { name: /^Allow Answer \+ raw Direct access$/ }).click();
  await expect.poll(() => decision).not.toBeNull();
  const filter = (capability: string) => ({
    sourceId: mail.id,
    audience: { accessLevel: "new", capability },
    rules: [{ action: "share", match: [label] }],
    otherwise: "hide",
  });
  const sources = { mode: "allowlist", sourceIds: [mail.id] };
  expect(decision).toEqual({
    decision: "approve",
    selection: {
      kind: "new-connection",
      name: "Fictional planner",
      level: {
        kind: "new",
        name: "Fictional planner",
        rules: [
          {
            capability: "answer",
            sources,
            release: { mode: "reviewed", policyFamilyId: policyId },
            filterRevision: 0,
            scopePolicies: [filter("answer")],
          },
          { capability: "direct", sources, filterRevision: 0, scopePolicies: [filter("direct")] },
        ],
      },
    },
  });
});
