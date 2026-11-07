// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { scopeContracts } from "@omnesis/provider-google/src/scope-contracts";

// Real provider declarations, independently invented account and content data.
const levelId = "00000000-0000-4000-8000-000000000093";
const policyId = "00000000-0000-4000-8000-000000000094";
const sources = [
  {
    id: "gmail:owner@example.com",
    sourceType: "gmail",
    displayName: "Gmail",
    available: true,
    scopes: scopeContracts.gmail,
    scopeReadiness: [
      { kind: "participant", ready: true },
      { kind: "label", ready: true },
    ],
  },
  {
    id: "google-drive:owner@example.com",
    sourceType: "google-drive",
    displayName: "Google Drive",
    available: true,
    scopes: scopeContracts["google-drive"],
    scopeReadiness: [{ kind: "folder", ready: true }],
  },
];
const savedPolicy = {
  sourceId: sources[0]!.id,
  audience: { accessLevel: levelId, capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "label", id: "planning" }] }],
  otherwise: "hide",
};
const answer = {
  capability: "answer",
  sources: { mode: "allowlist", sourceIds: sources.map((source) => source.id) },
  release: { mode: "reviewed", policyFamilyId: policyId },
  filterRevision: 3,
  scopePolicies: [savedPolicy],
};
const direct = {
  capability: "direct",
  sources: { mode: "allowlist", sourceIds: sources.map((source) => source.id) },
  filterRevision: 5,
  scopePolicies: [],
};
const nameFor = (ref: { kind: string; id?: string }) =>
  ref.kind === "label" ? "Planning" : ref.kind === "folder" ? "Comet notes" : "Maya Reeves";
async function capture(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string,
) {
  const root = process.env.OMNESIS_ACCESS_FLOW_CAPTURE_DIR;
  if (root) mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = root ? join(root, name + ".png") : testInfo.outputPath(name + ".png");
  await page.screenshot({ path });
  if (root) chmodSync(path, 0o600);
}
for (const width of [1440, 390])
  test(`guided create and targeted edit preserve exact permissions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
    if (!configDir) throw new Error("An isolated Portal test gateway is required.");
    const token = readFileSync(join(configDir, "token"), "utf8").trim();
    expect((await page.request.post("/portal/api/login", { data: { token } })).ok()).toBe(true);
    let levels = [
      {
        id: levelId,
        name: "Research assistant",
        revision: 1,
        connectionCount: 0,
        createdAt: 1,
        updatedAt: 1,
        rules: [answer, direct],
      },
    ];
    let active = 0,
      maximum = 0,
      conflict = true;
    const writes: Array<Record<string, unknown>> = [];
    const overview = () => ({
      principals: [],
      pendingAuthorizations: [],
      pendingRequests: [],
      oauth: null,
      policies: [],
      policyFamilies: [{ id: policyId, name: "Project policy", isDefault: true }],
      defaultPolicyFamilyId: policyId,
      sourceFilters: { enabled: true },
      sources,
      levels,
    });
    await page.route("**/admin/access", (route) => route.fulfill({ json: overview() }));
    await page.route("**/admin/access/source-filters/*/options?*", async (route) => {
      const url = new URL(route.request().url()),
        kind = url.searchParams.get("kind"),
        parent = url.searchParams.get("parentId");
      const sourceId = decodeURIComponent(url.pathname.split("/").at(-2)!);
      const ref =
        kind === "participant"
          ? {
              kind,
              label: "Maya Reeves",
              identifiers: [{ type: "email", value: "maya@example.com" }],
            }
          : { kind, id: kind === "label" ? "planning" : parent ? "folder-child" : "folder-root" };
      await route.fulfill({
        json: {
          sourceId,
          scopes: sources.find((source) => source.id === sourceId)!.scopes,
          readiness: sources.find((source) => source.id === sourceId)!.scopeReadiness,
          items: [
            {
              ref,
              label:
                kind === "folder"
                  ? parent
                    ? "Comet notes"
                    : "Dawn archive"
                  : kind === "label"
                    ? "Planning"
                    : "Maya Reeves",
              count: 6,
              hasChildren: kind === "folder" && !parent,
            },
          ],
        },
      });
    });
    await page.route("**/admin/access/source-filters/*/preview", async (route) => {
      active++;
      maximum = Math.max(maximum, active);
      if (active > 4) {
        active--;
        await route.fulfill({
          status: 503,
          json: { error: "Filter previews are busy. Try again shortly." },
        });
        return;
      }
      const body = route.request().postDataJSON(),
        sourceId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const only = body.policy.rules[0].action === "share";
      active--;
      await route.fulfill({
        json: {
          sourceId,
          total: 20,
          visible: only ? 6 : 12,
          hidden: only ? 14 : 8,
          unknown: 2,
          readiness: sources.find((source) => source.id === sourceId)!.scopeReadiness,
          items: body.policy.rules.flatMap(
            (rule: { match: Array<{ kind: string; id?: string }> }) =>
              rule.match.map((ref) => ({ ref, label: nameFor(ref), count: 6 })),
          ),
          samples: [
            {
              documentId: "invented-sample",
              title: "Project outline",
              visible: true,
              unknown: false,
            },
          ],
        },
      });
    });
    await page.route("**/admin/access/levels", async (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      levels.push({
        id: "00000000-0000-4000-8000-000000000095",
        name: body.name,
        revision: 1,
        connectionCount: 0,
        createdAt: 2,
        updatedAt: 2,
        rules: body.rules,
      });
      await route.fulfill({ json: { level: levels.at(-1) } });
    });
    await page.route(`**/admin/access/levels/${levelId}`, async (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (conflict) {
        conflict = false;
        levels = levels.map((level) => (level.id === levelId ? { ...level, revision: 2 } : level));
        await route.fulfill({ status: 409, json: { error: "stale-revision" } });
        return;
      }
      levels = levels.map((level) =>
        level.id === levelId
          ? { ...level, rules: body.rules, revision: level.revision + 1 }
          : level,
      );
      await route.fulfill({ json: { level: levels.find((level) => level.id === levelId) } });
    });
    const shot = (name: string) => capture(page, testInfo, `${width}-${name}`);
    const forward = () => page.getByRole("button", { name: "Continue", exact: true }).click();
    const sourceRow = (name: string) =>
      page.locator(".guided-source-row").filter({ has: page.getByText(name, { exact: true }) });
    const modal = () => page.getByRole("dialog");
    await page.goto("/portal/settings/access");
    await expect(page.getByRole("heading", { name: "Agent access", exact: true })).toBeInViewport();
    await shot("00-access-entry");
    await page.getByRole("button", { name: "New access level", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "What may this connection do?", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("heading", { name: "What may this connection do?", exact: true }),
    ).toBeFocused();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
    await expect(page.getByLabel("Access level name", { exact: true })).toHaveCount(0);
    await shot("new-01-permissions");
    await page
      .locator(".access-capability-preset")
      .filter({ has: page.getByText("Direct", { exact: true }) })
      .locator("input")
      .check();
    await forward();
    await expect(
      page.getByRole("heading", { name: "Which data may Answer use?", exact: true }),
    ).toBeInViewport();
    await sourceRow("Gmail").getByRole("checkbox").check();
    await sourceRow("Google Drive").getByRole("checkbox").check();
    await shot("new-02-answer-data");
    await sourceRow("Gmail")
      .getByRole("button", { name: "Change Gmail content", exact: true })
      .click();
    await shot("filter-01-mode");
    await modal().getByRole("button", { name: "Continue", exact: true }).click();
    await modal().getByRole("button", { name: "labels", exact: true }).click();
    await modal()
      .getByRole("checkbox", { name: /Planning/ })
      .check();
    await shot("filter-02-label-picker");
    await modal().getByRole("button", { name: "Review filter", exact: true }).click();
    await expect(modal().getByRole("button", { name: "Apply filter", exact: true })).toBeEnabled();
    await shot("filter-03-label-review");
    await modal().getByRole("button", { name: "Back", exact: true }).click();
    await expect(modal().getByRole("checkbox", { name: /Planning/ })).toBeChecked();
    await modal().getByRole("button", { name: "Review filter", exact: true }).click();
    await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
    await sourceRow("Google Drive")
      .getByRole("button", { name: "Change Google Drive content", exact: true })
      .click();
    await modal().getByLabel("Everything except matches", { exact: false }).check();
    await modal().getByRole("button", { name: "Continue", exact: true }).click();
    await modal().getByRole("button", { name: "Open Dawn archive", exact: true }).click();
    await modal()
      .getByRole("checkbox", { name: /Comet notes/ })
      .check();
    await shot("filter-04-folder-picker");
    await modal().getByRole("button", { name: "Review filter", exact: true }).click();
    await expect(modal().getByRole("button", { name: "Apply filter", exact: true })).toBeEnabled();
    await shot("filter-05-except-review");
    await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
    await forward();
    await expect(
      page.getByRole("heading", { name: "What may Direct read?", exact: true }),
    ).toBeInViewport();
    await shot("new-03-direct-choice");
    await page.getByLabel("Choose Direct data separately", { exact: false }).check();
    await forward();
    await shot("new-04-direct-data");
    await sourceRow("Google Drive")
      .getByRole("button", { name: "Change Google Drive content", exact: true })
      .click();
    await modal().getByLabel("All content", { exact: false }).check();
    await modal().getByRole("button", { name: "Continue", exact: true }).click();
    await shot("filter-06-all-content-expansion");
    await modal().getByRole("button", { name: "Share all content", exact: true }).click();
    await forward();
    await expect(
      page.getByRole("heading", { name: "What about new sources?", exact: true }),
    ).toBeInViewport();
    await shot("new-05-future");
    await forward();
    await expect(
      page.getByRole("heading", { name: "How should answers be released?", exact: true }),
    ).toBeInViewport();
    await shot("new-06-release");
    await forward();
    await page.getByLabel("Access level name", { exact: true }).fill("Project assistant");
    await shot("new-07-review");
    await page.getByRole("button", { name: "Create access level", exact: true }).click();
    await expect(page.locator(".access-notice")).toBeInViewport();
    await expect(page.locator(".access-notice")).toContainText("Project assistant");
    await shot("new-08-success");
    const created = writes[0] as {
      rules: Array<{ capability: string; scopePolicies?: unknown[] }>;
    };
    expect(created.rules.find((rule) => rule.capability === "answer")!.scopePolicies).toHaveLength(
      2,
    );
    expect(created.rules.find((rule) => rule.capability === "direct")!.scopePolicies).toHaveLength(
      1,
    );
    await expect(page.getByText(/restricted content/).first()).toBeVisible();
    await page.goto(`/portal/settings/access/levels/${levelId}`);
    await expect(
      page.getByRole("heading", { name: "What would you like to change?", exact: true }),
    ).toBeInViewport();
    await shot("edit-01-overview");
    const change = async (title: string) =>
      page
        .locator(".guided-overview-decision")
        .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
        .getByRole("button", { name: "Change", exact: true })
        .click();
    await change("Answer data");
    await shot("edit-02-targeted-data");
    await sourceRow("Gmail")
      .getByRole("button", { name: "Change Gmail content", exact: true })
      .click();
    await modal().getByLabel("Everything except matches", { exact: false }).check();
    await modal().getByRole("button", { name: "Continue", exact: true }).click();
    await modal().getByRole("button", { name: "Review filter", exact: true }).click();
    await expect(modal().getByRole("button", { name: "Apply filter", exact: true })).toBeEnabled();
    await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(page.locator(".guided-review-decision")).toHaveCount(1);
    await shot("edit-03-data-delta");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Your draft is retained");
    await expect(page.getByRole("alert")).toBeInViewport();
    await shot("edit-04-conflict");
    await page
      .getByRole("button", { name: "Reload latest and discard draft", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "What would you like to change?", exact: true }),
    ).toBeVisible();
    await change("Answer privacy");
    await page.getByLabel("Release answers automatically", { exact: false }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(page.locator(".guided-review-decision")).toHaveCount(1);
    await expect(page.locator(".guided-review-decision")).toContainText("Answer privacy");
    await shot("edit-05-release-delta");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.locator(".access-notice")).toBeInViewport();
    await shot("edit-06-success");
    const last = writes.at(-1)!;
    expect(last.expectedRevision).toBe(2);
    expect(last.expectedFilterRevisions).toEqual({ answer: 3, direct: 5 });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(
      await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  });
