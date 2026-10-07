// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../packages/collector/src/e2e/synth-env.js";
import Database from "better-sqlite3";
import { test, expect } from "@playwright/test";
import { SyntheticE2EHarness } from "../packages/collector/src/e2e/synth-harness.js";
import {
  createOpenLoop,
  appendOpenLoopLedger,
} from "../packages/gateway/src/brain/storage/open-loops.js";
import { createBrief } from "../packages/gateway/src/brain/storage/briefs.js";
import {
  recordSettledCognitionRun,
  enqueueCognitionRun,
} from "../packages/gateway/src/brain/storage/run-queue.js";
import { saveKnowledgeNode } from "../packages/gateway/src/brain/knowledge/storage.js";
import {
  enqueueKnowledgeWork,
  createKnowledgeBatch,
  setKnowledgeFrontierOutcome,
  finishKnowledgeBatch,
} from "../packages/gateway/src/brain/knowledge/work.js";

// This spec owns its experimental gateway; the shared portal gateway stays stable.
let harness: SyntheticE2EHarness;
const route = "/portal/debug/cognition/knowledge";
test.beforeEach(async () => {
  test.setTimeout(180_000);
  harness = new SyntheticE2EHarness({ gatewayMode: "synthetic-experimental" });
  await harness.start();
});
test.afterEach(async () => {
  await harness?.destroy();
});
const url = (path: string) => `${harness.gatewayUrl}${path}`;
const token = () => harness.apiKey;

test("knowledge library, readable page, evidence, history and mobile navigation", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url(`/portal/?token=${encodeURIComponent(token())}`));
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  await page.goto(url(route));
  await expect(page.getByText("Your knowledge starts here", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-empty.png"),
    fullPage: true,
    animations: "disabled",
  });

  const descriptors = await request.get(url("/admin/source-descriptors"), {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const registeredSource = (await descriptors.json()).items.find(
    (item: { icon?: { imageDataUri?: string } }) => item.icon?.imageDataUri,
  );
  expect(registeredSource).toBeTruthy();
  const response = await request.post(url("/documents"), {
    headers: { Authorization: `Bearer ${token()}` },
    data: {
      documents: [
        {
          providerId: "fixture",
          sourceId: `${registeredSource.id}:knowledge-browser`,
          externalId: "workshop-plan",
          title: "Workshop planning note",
          content: "The workshop begins at ten. Bring paper and pencils.",
          contentHash: "knowledge-browser-v1",
          metadata: {},
          sourceCreatedAt: "2026-01-01T00:00:00Z",
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  const db = new Database(harness.getDbPath());
  let documentId: string;
  try {
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      documentId = db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id=?")
        .get("workshop-plan")!.id;
      const ref = `source:${documentId}`;
      saveKnowledgeNode(
        db,
        {
          id: "browser-supplies",
          kind: "wiki",
          title: "Workshop supplies",
          expectedRevision: 0,
          markdown: `<claim id="opening" refs="${ref}">Paper and pencils are workshop supplies.</claim>\n\n<img src="missing-fixture-image" onerror="window.knowledgeXss = true">`,
          inputVersions: { [ref]: "knowledge-browser-v1" },
        },
        Date.now(),
      );
      createOpenLoop(
        db,
        {
          id: "browser-materials",
          createdByRun: "browser-fixture",
          title: "Prepare workshop materials",
          description: "Gather paper and pencils for the workshop.",
          confidence: 0.9,
          importance: 0.5,
        },
        Date.now(),
      );
      saveKnowledgeNode(
        db,
        {
          id: "browser-materials",
          ownerId: "browser-materials",
          kind: "loop",
          title: "Prepare workshop materials",
          canonicalFields: { state: "open" },
          expectedRevision: 0,
          markdown: `<claim id="outcome" refs="${ref}">Gather paper and pencils for the workshop.</claim>`,
          inputVersions: { [ref]: "knowledge-browser-v1" },
        },
        Date.now(),
      );
      saveKnowledgeNode(
        db,
        {
          id: "browser-context",
          kind: "wiki",
          title: "Workshop context",
          expectedRevision: 0,
          markdown: "# Workshop context\n\nThis page has no retained claims.",
          inputVersions: {},
        },
        Date.now(),
      );
      const node = {
        id: "browser-workshop",
        kind: "wiki" as const,
        title: "Paper workshop",
        expectedRevision: 0,
        markdown: `# Paper workshop\n\n<claim id="time" refs="${ref}">The workshop begins at ten.</claim>`,
        inputVersions: { [ref]: "knowledge-browser-v1" },
      };
      saveKnowledgeNode(db, node, Date.now());
      saveKnowledgeNode(
        db,
        {
          ...node,
          expectedRevision: 1,
          markdown: `${node.markdown}\n\n## Preparation\n\n<claim id="materials" refs="${ref}">Bring paper and <claim id="pencils" refs="${ref}">pencils</claim>.</claim>\n\nRead [Opening time](wiki:browser-workshop#claim:time). See [Workshop supplies](wiki:browser-supplies), [Opening](wiki:browser-supplies#claim:opening), and [State](loop:browser-materials#field:state). Read the [Source note](${ref}).\n\n<claim id="planning" refs="wiki:browser-supplies loop:browser-materials">Workshop supplies provide context for preparing the materials.</claim>`,
          inputVersions: {
            ...node.inputVersions,
            "wiki:browser-supplies": 1,
            "loop:browser-materials": 1,
          },
          claims: [
            {
              id: "planning",
              relations: {
                "wiki:browser-supplies": "context",
                "loop:browser-materials": "depends_on",
              },
            },
          ],
        },
        Date.now() + 1,
      );
      saveKnowledgeNode(
        db,
        {
          id: "browser-root",
          kind: "root",
          title: "Current focus",
          expectedRevision: 0,
          markdown:
            '<claim id="focus" refs="wiki:browser-workshop">A paper workshop is being prepared.</claim>',
          inputVersions: { "wiki:browser-workshop": 2 },
        },
        Date.now() + 2,
      );
      const now = Date.now();
      const completed = enqueueKnowledgeWork(
        db,
        {
          id: "browser-source-work",
          subjectKind: "source",
          subjectId: documentId,
          reason: "change",
          inputRevision: "knowledge-browser-v1",
          tier: "immediate",
          dueAt: now,
        },
        now,
      );
      createKnowledgeBatch(
        db,
        {
          id: "browser-completed",
          runId: "browser-completed-run",
          tier: "immediate",
          work: [completed],
          regionNodeIds: [],
          frontier: [
            {
              nodeId: `source:${documentId}`,
              inputFingerprint: "browser-source-v1",
              inputVersions: { [`source:${documentId}`]: "knowledge-browser-v1" },
              depth: 0,
            },
          ],
        },
        now,
      );
      setKnowledgeFrontierOutcome(
        db,
        {
          batchId: "browser-completed",
          nodeId: `source:${documentId}`,
          inputFingerprint: "browser-source-v1",
          status: "skipped",
        },
        now,
      );
      finishKnowledgeBatch(db, "browser-completed", now);
      const pending = enqueueKnowledgeWork(
        db,
        {
          id: "browser-page-work",
          subjectKind: "node",
          subjectId: "browser-workshop",
          reason: "review",
          inputRevision: "2",
          tier: "soon",
          dueAt: now,
        },
        now,
      );
      createKnowledgeBatch(
        db,
        {
          id: "browser-pending",
          runId: "browser-pending-run",
          tier: "soon",
          work: [pending],
          regionNodeIds: ["browser-workshop"],
          frontier: [
            {
              nodeId: "browser-workshop",
              inputFingerprint: "browser-page-v2",
              inputVersions: { "node:browser-workshop": 2 },
              depth: 0,
            },
          ],
        },
        now,
      );
      enqueueKnowledgeWork(
        db,
        {
          id: "browser-upcoming",
          subjectKind: "node",
          subjectId: "browser-root",
          reason: "root",
          inputRevision: "1",
          tier: "routine",
          dueAt: now + 6 * 3600000,
        },
        now,
      );
    }).immediate();
  } finally {
    db.close();
  }
  await page.reload();
  await expect(page.getByText(/Your life at a glance/i).first()).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-desktop-library.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(url("/portal/debug/cognition/maintenance"));
  await expect(page.getByRole("heading", { name: "Recent maintenance batches" })).toBeVisible();
  await page.getByRole("button", { name: /soon maintenance/i }).click();
  await expect(page).toHaveURL(/maintenance\/browser-pending$/);
  await page.reload();
  await expect(page.locator(".kn-batch-detail")).toContainText("Paper workshop");
  await page.screenshot({
    path: info.outputPath("knowledge-maintenance.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: /immediate maintenance/i }).click();
  await page.screenshot({
    path: info.outputPath("knowledge-maintenance-completed.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.locator(".kn-maintenance > summary").click();
  await expect(page.getByRole("heading", { name: "Work queue" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-upcoming-work.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.locator(".kn-maintenance > summary").click();
  await page.goto(url(route));
  const search = page.getByRole("searchbox", { name: "Search knowledge" });
  await search.fill("no-such-subject");
  await expect(page.getByText("No matching pages", { exact: true })).toBeVisible();
  await search.fill("workshop");
  await expect(page.locator(".kn-card-list")).toContainText("Prepare workshop materials");
  await page.evaluate(() => {
    (window as Window & { libraryNavigationSentinel?: string }).libraryNavigationSentinel =
      "preserved";
  });
  const libraryRequests: string[] = [];
  const trackLibraryRequests = (request: import("@playwright/test").Request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/admin/brain/knowledge" || path === "/admin/brain/knowledge/status")
      libraryRequests.push(request.url());
  };
  page.on("request", trackLibraryRequests);
  const library = page.getByRole("navigation", { name: "Knowledge pages" });
  await library.getByRole("link", { name: /Prepare workshop materials/ }).click();
  await expect(page).toHaveURL(/knowledge\/browser-materials$/);
  await expect(page.getByRole("region", { name: "Loop details" })).toBeVisible();
  await expect(page.locator(".kn-reader .kn-loop-context")).toHaveCount(1);
  await expect(page.locator(".kn-reading-pane > .kn-loop-context")).toHaveCount(0);
  await expect(page.locator(".kn-loop-activity")).toBeVisible();
  await expect(page.locator(".kn-loop-activity details")).toHaveCount(0);
  await expect(page.locator(".kn-loop-activity")).toContainText("Confidence");
  await expect(page.locator('option[value="current"]')).toHaveText(
    "Up to date with linked evidence",
  );
  await expect(search).toHaveValue("workshop");
  await expect(page.getByRole("combobox", { name: "Knowledge type" })).toHaveValue("");
  await expect(library).toContainText("Workshop supplies");
  await library.locator('a[href="/portal/debug/cognition/knowledge/browser-supplies"]').click();
  await expect(page.locator(".kn-reader")).toContainText(
    "Paper and pencils are workshop supplies.",
  );
  await page.goBack();
  await expect(page).toHaveURL(/knowledge\/browser-materials$/);
  await expect(page.getByRole("region", { name: "Loop details" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/knowledge\/browser-supplies$/);
  await expect(page.locator(".kn-reader")).toContainText(
    "Paper and pencils are workshop supplies.",
  );
  await expect(search).toHaveValue("workshop");
  expect(
    await page.evaluate(
      () => (window as Window & { libraryNavigationSentinel?: string }).libraryNavigationSentinel,
    ),
  ).toBe("preserved");
  expect(libraryRequests).toEqual([]);
  page.off("request", trackLibraryRequests);
  await search.fill("Paper workshop");
  await page
    .getByRole("link", { name: /Paper workshop/ })
    .first()
    .click();
  await expect(page).toHaveURL(/knowledge\/browser-workshop/);
  await expect(page.getByRole("heading", { name: "Preparation", exact: true })).toBeVisible();
  await expect(page.locator(".kn-reader")).toContainText("Bring paper and pencils.");
  await expect(page.getByRole("heading", { name: "Connected pages", exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("knowledge-desktop-reader.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(
    page.locator('.kn-prose a[href*="browser-supplies"] svg.kn-link-icon--wiki').first(),
  ).toBeVisible();
  await expect(
    page.locator('.kn-prose a[href*="browser-materials"] svg.kn-link-icon--loop'),
  ).toBeVisible();
  await expect(
    page.locator('.kn-prose a[href^="/portal/doc/"] img.kn-link-icon--source'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect claim 3", exact: true }).click();
  await expect(page.locator(".kn-selected-claim")).toContainText("pencils");
  await page.screenshot({
    path: info.outputPath("knowledge-nested-claim.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Inspect enclosing claim", exact: true }).click();
  await expect(page.locator(".kn-selected-claim")).toContainText("Bring paper and pencils.");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .locator(".kn-prose")
    .getByRole("link", { name: "Workshop supplies", exact: true })
    .click();
  await expect(page).toHaveURL(/knowledge\/browser-supplies$/);
  await expect(page.locator(".kn-reader")).toContainText(
    "Paper and pencils are workshop supplies.",
  );
  await expect(page.locator(".kn-reader [onerror]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as Window & { knowledgeXss?: boolean }).knowledgeXss),
  ).toBeUndefined();
  await page.goBack();
  await page.locator(".kn-prose").getByRole("link", { name: "Opening time", exact: true }).click();
  await expect(page).toHaveURL(/browser-workshop\?claim=time$/);
  await expect(page.locator(".kn-selected-claim")).toContainText("The workshop begins at ten.");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".kn-prose").getByRole("link", { name: "Opening", exact: true }).click();
  await expect(page).toHaveURL(/browser-supplies\?claim=opening$/);
  await expect(page.locator(".kn-selected-claim")).toContainText(
    "Paper and pencils are workshop supplies.",
  );
  await page.goBack();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".kn-prose").getByRole("link", { name: "State", exact: true }).click();
  await expect(page).toHaveURL(/browser-materials\?kind=loop&field=state$/);
  await expect(page.getByRole("region", { name: "Referenced field" })).toContainText('"open"');
  await page.screenshot({
    path: info.outputPath("knowledge-field-reference.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goBack();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Filter connections by claim" }).selectOption("");
  await expect(page.locator(".kn-reader")).toContainText("Workshop supplies");
  await expect(page.locator(".kn-reader")).toContainText("Prepare workshop materials");
  await expect(page.locator(".kn-connections svg.kn-link-icon--loop").first()).toBeVisible();
  await expect(page.locator(".kn-connections svg.kn-link-icon--wiki").first()).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-connections.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.getByRole("button", { name: /^Evidence/ })).toHaveCount(0);
  const source = page.getByRole("link", { name: /Workshop planning note/ });
  await expect(source).toHaveCount(1);
  await expect(source.locator("img.kn-link-icon--source")).toBeVisible();
  await expect(source.locator("img.kn-link-icon--source")).toHaveJSProperty("complete", true);
  expect(
    await source
      .locator("img.kn-link-icon--source")
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(source).toHaveAttribute("href", `/portal/doc/${encodeURIComponent(documentId!)}`);
  await page.screenshot({
    path: info.outputPath("knowledge-relationships-sources.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({
    path: info.outputPath("knowledge-relationships-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await source.click();
  await expect(page).toHaveURL(new RegExp(`/portal/doc/${documentId}`));
  await expect(
    page.getByRole("heading", { name: "Workshop planning note", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText(/Edit 1|Version 1|Revision 1/).first()).toBeVisible();
  await page.getByText("Version 1", { exact: true }).click();
  await page.screenshot({
    path: info.outputPath("knowledge-history.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.locator(".kn-reader-body details")).toHaveCount(0);
  await expect(page.locator(".kn-reader-body pre")).toHaveCount(3);
  for (const block of await page.locator(".kn-reader-body pre").all())
    await expect(block).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-advanced.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(navigation).toBeFocused();
  await expect(navigation).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: /Back to library/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath("knowledge-mobile-reader.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Inspect claim 3", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".kn-selected-claim")).toContainText("pencils");
  await page.screenshot({
    path: info.outputPath("knowledge-nested-claim-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter connections by claim" }).selectOption("");
  await expect(page.locator(".kn-connections")).toContainText("Workshop supplies");
  await page.screenshot({
    path: info.outputPath("knowledge-connections-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: /Back to library/ }).click();
  await expect(page.getByRole("searchbox", { name: "Search knowledge" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-mobile-library.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(url(`${route}/browser-context?claim=removed`));
  await expect(page.locator(".kn-selected-claim").getByRole("status")).toContainText(
    "The referenced claim is not present in this version of the page.",
  );
  await page.screenshot({
    path: info.outputPath("knowledge-missing-claim.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("knowledge network failure offers a working retry", async ({ page }, info) => {
  await page.goto(url(`/portal/?token=${encodeURIComponent(token())}`));
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  await page.route("**/admin/brain/knowledge?*", (request) => request.abort());
  await page.goto(url(route));
  await expect(page.getByText("Knowledge could not be loaded", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("knowledge-error.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.unroute("**/admin/brain/knowledge?*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search knowledge" })).toBeVisible();
  await expect(page.getByText("Knowledge could not be loaded", { exact: true })).toHaveCount(0);
});

test("brain navigation remains usable across its existing sections", async ({ page }, info) => {
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url(`/portal/?token=${encodeURIComponent(token())}`));
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  for (const section of ["overview", "runs", "briefs", "memory", "calibration", "bootstrap"]) {
    await page.goto(url(`/portal/debug/cognition/${section}`));
    await expect(page.locator(".cognition-content")).toBeVisible();
    await expect
      .poll(() => page.locator(".debug-workspace").evaluate((el) => getComputedStyle(el).width))
      .not.toBe("auto");
    await expect
      .poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily))
      .not.toContain("Times New Roman");
    await expect
      .soft(
        page.locator(".cognition-content").getByText(/^Loading/),
        `${section} should finish loading`,
      )
      .toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`brain-${section}-desktop.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect
      .soft(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${section} should fit the mobile viewport`,
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`brain-${section}-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  for (const section of [
    "data",
    "sql",
    "graph",
    "metrics",
    "background-jobs",
    "calendar",
    "watch",
    "doctor",
  ]) {
    await page.goto(url(`/portal/debug/${section}`));
    await expect(page.locator(".debug-workspace")).toBeVisible();
    await expect(page.locator(".debug-workspace").getByText(/^Loading/)).toHaveCount(0);
    if (section === "data") await expect(page.locator(".data-detail table").first()).toBeVisible();
    if (section === "doctor")
      await expect(page.getByRole("button", { name: "Run again", exact: true })).toBeEnabled({
        timeout: 30000,
      });
    await page.screenshot({
      path: info.outputPath(`debug-${section}-desktop.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect
      .soft(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${section} should fit the mobile viewport`,
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`debug-${section}-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  expect(errors).toEqual([]);
});

test("populated operational readers preserve mobile navigation", async ({ page }, info) => {
  const db = new Database(harness.getDbPath());
  try {
    db.transaction(() => {
      const now = Date.now();
      recordSettledCognitionRun(db, {
        runId: "browser-review-run",
        kind: "synthesis",
        payload: { focus: "knowledge-maintenance", batchId: "browser-review" },
        startedAt: now - 12000,
        now,
        day: new Date(now).toISOString().slice(0, 10),
        mechanism: "knowledge-maintenance",
        modelId: "scripted-fixture",
        usage: null,
        outcome: { kind: "completed" },
      });
      createOpenLoop(
        db,
        {
          id: "browser-materials-loop",
          createdByRun: "browser-review-run",
          title: "Prepare workshop materials",
          description: "Gather paper and pencils before the workshop.",
          deadline: { kind: "by", date: "2027-01-15" },
          confidence: 0.9,
          importance: 0.6,
        },
        now,
      );
      saveKnowledgeNode(
        db,
        {
          id: "browser-materials-loop",
          ownerId: "browser-materials-loop",
          kind: "loop",
          title: "Prepare workshop materials",
          expectedRevision: 0,
          markdown: "Gather paper and pencils before the workshop.",
          inputVersions: {},
          canonicalFields: { state: "open" },
        },
        now,
      );
      createOpenLoop(
        db,
        {
          id: "browser-finished-loop",
          createdByRun: "browser-review-run",
          title: "Reserve workshop room",
          description: "The room reservation is complete.",
          state: "done",
          confidence: 0.9,
          importance: 0.5,
        },
        now,
      );
      saveKnowledgeNode(
        db,
        {
          id: "browser-finished-loop",
          ownerId: "browser-finished-loop",
          kind: "loop",
          title: "Reserve workshop room",
          expectedRevision: 0,
          markdown: "The room reservation is complete.",
          inputVersions: {},
          canonicalFields: { state: "done" },
        },
        now,
      );
      appendOpenLoopLedger(
        db,
        "browser-materials-loop",
        { runId: "browser-review-run", note: "Materials remain to be gathered." },
        now,
      );
      enqueueCognitionRun(
        db,
        {
          id: "browser-scheduled-check",
          kind: "time_based",
          payload: { loopId: "browser-materials-loop", instruction: "Check preparation progress." },
          notBefore: now + 3600000,
        },
        now,
      );
      createOpenLoop(
        db,
        {
          id: "browser-legacy-loop",
          createdByRun: "browser-review-run",
          title: "Prepare name cards",
          description: "Write the workshop name cards.",
          confidence: 0.8,
          importance: 0.4,
        },
        now,
      );
      createBrief(
        db,
        {
          id: "browser-workshop-brief",
          createdByRun: "browser-review-run",
          kind: "loop",
          title: "Workshop preparation",
          description: "Materials are the remaining preparation step.",
          body: "## Next step\n\nGather paper and pencils for the workshop.",
          confidence: 0.9,
          urgency: 0.5,
          relatedLoopIds: ["browser-materials-loop"],
        },
        now,
      );
    }).immediate();
  } finally {
    db.close();
  }
  await page.goto(url(`/portal/?token=${encodeURIComponent(token())}`));
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  for (const [section, id] of [
    ["loops", "browser-materials-loop"],
    ["briefs", "browser-workshop-brief"],
    ["runs", "browser-review-run"],
  ]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url(`/portal/debug/cognition/${section}/${id}`));
    await expect(page.locator(".cognition-content")).toBeVisible();
    await expect
      .poll(() => page.locator(".debug-workspace").evaluate((el) => getComputedStyle(el).width))
      .not.toBe("auto");
    await expect
      .poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily))
      .not.toContain("Times New Roman");
    await expect(page.locator(".cognition-content").getByText(/^Loading/)).toHaveCount(0);
    if (section === "loops") {
      await expect(page).toHaveURL(/knowledge\/browser-materials-loop\?kind=loop$/);
      await expect(page.getByRole("region", { name: "Loop details" })).toContainText("2027-01-15");
      await expect(
        page
          .getByRole("region", { name: "Loop details" })
          .getByRole("heading", { name: "Prepare workshop materials", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".kn-reader h2")).toHaveCount(1);
      await expect(page.locator(".kn-loop-activity")).toContainText(
        "Materials remain to be gathered.",
      );
      await expect(page.locator(".kn-loop-activity")).toContainText("Workshop preparation");
      await expect(page.locator(".kn-loop-activity")).toContainText("Scheduled checks (1)");
    }
    if (section === "briefs")
      await expect(page.locator(".cognition-content")).toContainText(
        "Materials are the remaining preparation step.",
      );
    if (section === "runs")
      await expect(page.locator(".cognition-content")).toContainText("synthesis run");
    await page.screenshot({
      path: info.outputPath(`brain-${section}-populated-desktop.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("link", {
        name: new RegExp(`Back to ${section === "loops" ? "library" : section}$`),
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`brain-${section}-populated-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("link", {
        name: new RegExp(`Back to ${section === "loops" ? "library" : section}$`),
      })
      .click();
    await expect(page).toHaveURL(
      section === "loops"
        ? /cognition\/knowledge(?:\?kind=loop)?$/
        : new RegExp(`/cognition/${section}$`),
    );
    if (section === "loops") {
      await page.getByRole("combobox", { name: "Knowledge type" }).selectOption("loop");
      await page.getByRole("combobox", { name: "Loop status" }).selectOption("active");
      await expect(page.locator(".kn-card-list")).toContainText("Prepare workshop materials");
      await expect(page.locator(".kn-card-list")).not.toContainText("Reserve workshop room");
      await page.getByRole("combobox", { name: "Loop status" }).selectOption("resolved");
      await expect(page.locator(".kn-card-list")).toContainText("Reserve workshop room");
      await expect(page.locator(".kn-card-list")).not.toContainText("Prepare workshop materials");
      await page.getByRole("combobox", { name: "Sort loops" }).selectOption("importance");
      await page.goto(url("/portal/debug/cognition/loops/browser-legacy-loop"));
      await expect(page).toHaveURL(/knowledge\/browser-legacy-loop\?kind=loop$/);
      await expect(page.getByRole("region", { name: "Loop details" })).toContainText(
        "Prepare name cards",
      );
      await expect(page.getByRole("heading", { name: "No synthesis available" })).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Loop details" })
          .getByRole("heading", { name: "Prepare name cards", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".kn-loop-activity")).toContainText(
        "Write the workshop name cards.",
      );
      await page.screenshot({
        path: info.outputPath("library-legacy-loop-mobile.png"),
        fullPage: true,
        animations: "disabled",
      });

      await page.screenshot({
        path: info.outputPath("library-loop-filters-mobile.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});
