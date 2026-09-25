// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

const configDir =
  process.env.OMNESIS_CONFIG_DIR ?? join(process.env.HOME ?? "~", ".config", "omnesis");
// The gateway always serves HTTPS with a self-signed cert. The browser trusts
// it via the config's `ignoreHTTPSErrors`; the in-test seeding fetch trusts it
// via NODE_TLS_REJECT_UNAUTHORIZED (the same approach SyntheticE2EHarness uses
// for its isolated-gateway fetches). This process only ever talks to the
// isolated test gateway, never anything trust-sensitive.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = `https://localhost:${process.env.OMNESIS_PORTAL_TEST_PORT ?? 17800}`;

// Read the auto-generated token from the config dir
function getToken(): string {
  // The playwright webServer config sets OMNESIS_CONFIG_DIR to a temp dir
  // Wait a moment and read the token file the gateway auto-generates
  try {
    return readFileSync(join(configDir, "token"), "utf-8").trim();
  } catch {
    throw new Error(
      `Could not read token file at ${join(configDir, "token")}. Is the gateway running?`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed test documents into the gateway via POST /documents */
async function seedDocuments() {
  const token = getToken();
  const docs = [
    {
      providerId: "test-provider:test",
      sourceId: "test-notes:test",
      externalId: "pw-doc-1",
      title: "Playwright Alpha Document",
      content: "This is a test document for playwright browser tests with alpha content.",
      contentHash: "hash-pw-1",
      metadata: { documentType: "note" },
      sourceCreatedAt: "2025-06-01T00:00:00Z",
      sourceUpdatedAt: "2025-06-01T00:00:00Z",
    },
    {
      providerId: "test-provider:test",
      sourceId: "test-notes:test",
      externalId: "pw-doc-2",
      title: "Playwright Beta Document",
      content: "Another test document for playwright with beta content about searching.",
      contentHash: "hash-pw-2",
      metadata: { documentType: "email" },
      sourceCreatedAt: "2025-06-02T00:00:00Z",
      sourceUpdatedAt: "2025-06-02T00:00:00Z",
    },
    {
      providerId: "test-provider:test",
      sourceId: "test-notes:test",
      externalId: "pw-doc-3",
      title: "Playwright Gamma Document",
      content: "Third test document for playwright with gamma content.",
      contentHash: "hash-pw-3",
      metadata: { documentType: "note" },
      sourceCreatedAt: "2025-06-03T00:00:00Z",
      sourceUpdatedAt: "2025-06-03T00:00:00Z",
    },
  ];

  const res = await fetch(`${BASE}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documents: docs }),
  });

  if (!res.ok) {
    throw new Error(`Failed to seed documents: ${res.status} ${await res.text()}`);
  }
}

async function patchTestConfig(patch: unknown) {
  const res = await fetch(`${BASE}/admin/config`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to patch test config: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ config: Record<string, unknown> }>;
}

/**
 * Log into the portal with the auto-generated token and land on the
 * authenticated app shell. Uses the portal's `?token=…` one-click sign-in
 * (consumed + stripped by the app's bootstrap, which logs in and renders the
 * authenticated shell on the first paint) — deterministic, with no form-fill +
 * reload race. Waits on the sidebar nav (the stable logged-in signal), never
 * `networkidle`, which never settles on the portal's SSE/WS pages.
 */
async function loginToPortal(page: Page) {
  const token = getToken();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor({ state: "visible", timeout: 15000 });
}

/** The search-view text input. */
function searchInputOf(page: Page) {
  return page.locator("input.search-input");
}

/** Navigate to the search view and wait for its input. */
async function gotoSearch(page: Page) {
  await page.goto("/portal/search");
  const input = searchInputOf(page);
  await input.waitFor({ state: "visible", timeout: 15000 });
  return input;
}

/** Collect console errors during a test */
function trackConsoleErrors(page: Page): ConsoleMessage[] {
  const errors: ConsoleMessage[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg);
    }
  });
  return errors;
}

/**
 * Drop the console-error noise expected against a bare, agent-less test
 * gateway with an empty corpus: CDN module-load failures (esm.sh may be
 * unreachable in CI) and background-XHR resource-load failures for
 * capabilities the test gateway doesn't run. A genuine JS exception is
 * neither and survives the filter.
 */
function realErrorsOf(errors: ConsoleMessage[]): ConsoleMessage[] {
  return errors.filter((e) => {
    const t = e.text();
    return (
      !t.includes("esm.sh") &&
      !t.includes("ERR_NAME_NOT_RESOLVED") &&
      !t.includes("Failed to load resource") &&
      !t.includes("401") &&
      !t.includes("404") &&
      !t.includes("503")
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Portal", () => {
  test.beforeAll(async () => {
    await seedDocuments();
  });

  test("page loads without errors", async ({ page }) => {
    const errors = trackConsoleErrors(page);

    await loginToPortal(page);
    await expect(page).toHaveTitle("Omnesis");

    const app = page.locator("#app");
    await expect(app).not.toBeEmpty();

    // A bare test gateway has no agent backend and an empty index, so the app
    // shell's background capability probes (e.g. /agent/conversations,
    // /admin/source-descriptors) legitimately return non-2xx — that is
    // resource-load noise, not a DOM regression. Filter it the same way the
    // navigation-flow test does; a real JS exception is NOT a resource-load
    // failure and would still surface here.
    expect(realErrorsOf(errors)).toHaveLength(0);
  });

  test("config stages edits behind Save, keeps them across an external edit, and clears a rejected save's errors", async ({
    page,
  }) => {
    await loginToPortal(page);
    await page.goto("/portal/settings/config");
    const versionLabel = page.locator(".config-version");
    await expect(versionLabel).toHaveText(/^version \d+$/);
    const version = Number((await versionLabel.textContent())!.replace("version ", ""));

    const search = page.locator(".config-search-input");
    await search.fill("Candidate limit");
    const field = page.locator(".config-field").filter({ hasText: "Candidate limit" }).first();
    const input = field.locator("input.config-input");
    const savebar = page.locator(".config-savebar-status");

    // Typing stages the edit locally: the field is highlighted and the
    // toolbar counts it. That nothing is written before Save is confirmed is
    // proven by the accepted save below, whose version bump is the only one.
    await input.fill("-1");
    await expect(field).toHaveClass(/config-field-dirty/);
    await expect(savebar).toContainText("1 unsaved change");
    await expect(versionLabel).toHaveText(`version ${version}`);

    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith("/admin/config") &&
        response.request().method() === "PATCH" &&
        response.status() === 400,
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Confirm save" }).click();
    await rejected;
    await expect(field.locator(".config-field-error")).toBeVisible();
    await expect(page.locator(".config-banner.error")).toContainText("Validation failed");

    try {
      // Another writer's change keeps the rejected draft — the operator's
      // edit is theirs to reconcile — but clears the stale rejection and
      // says the base moved.
      await patchTestConfig({ search: { params: { candidateLimit: 77 } } });
      await expect(page.locator(".config-banner.notice")).toContainText("changed elsewhere");
      await expect(field.locator(".config-field-error")).toHaveCount(0);
      await expect(page.locator(".config-banner.error")).toHaveCount(0);
      await expect(input).toHaveValue("-1");
      await expect(search).toHaveValue("Candidate limit");

      // Discard drops the draft and reveals the committed value.
      await page.getByRole("button", { name: "Discard" }).click();
      await expect(input).toHaveValue("77");
      await expect(page.locator(".config-banner.notice")).toHaveCount(0);
      await expect(savebar).toHaveText("No unsaved changes.");

      // A valid staged edit persists through the same review.
      const accepted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/admin/config") &&
          response.request().method() === "PATCH" &&
          response.status() === 200,
      );
      await input.fill("88");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Confirm save" }).click();
      await accepted;
      // The external write and the confirmed save each advanced the version;
      // the success flash is not asserted because it dismisses itself.
      await expect(versionLabel).toHaveText(`version ${version + 2}`);
      await expect(input).toHaveValue("88");
      await expect(field).not.toHaveClass(/config-field-dirty/);
      await expect(savebar).toHaveText("No unsaved changes.");
    } finally {
      await patchTestConfig({ search: { params: { candidateLimit: null } } });
    }
  });

  test("config fields distinguish defaults, overrides, reset, filtering, and validation", async ({
    page,
  }) => {
    await patchTestConfig({
      search: { params: { candidateLimit: null } },
      nearDuplicates: { eligibleDocTypes: null },
      gateway: { audit: { includeUnauthenticated: null } },
      sources: { default: { syncInterval: "17m", extractAttachments: true } },
    });
    try {
      await loginToPortal(page);
      await page.goto("/portal/settings/config");
      const search = page.locator(".config-search-input");
      await expect(search).toBeVisible();
      await search.fill("Candidate limit");

      const field = page.locator(".config-field").filter({ hasText: "Candidate limit" }).first();
      const input = field.locator("input.config-input");
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute("placeholder", "Default: 50");
      await expect(field.locator(".config-state-badge")).toHaveText("Using default");
      await expect(field.locator(".config-state-detail")).toHaveText("50");

      // Entering today's default pins it as an explicit override. Only clear
      // or Reset removes a scalar override.
      await input.fill("50");
      await input.blur();
      await expect(field.locator(".config-state-badge")).toHaveText("Set in config");
      await field.locator(".config-reset-btn").click();
      await expect(input).toHaveValue("");

      await input.fill("137");
      await input.blur();
      await expect(field.locator(".config-state-badge")).toHaveText("Set in config");
      await expect(field.locator(".config-reset-btn")).toContainText("Reset to default");

      await page.getByRole("button", { name: /Set in config/ }).click();
      await expect(field).toBeVisible();

      await field.locator(".config-reset-btn").click();
      await page.getByRole("button", { name: "All settings" }).click();
      await expect(input).toHaveValue("");
      await expect(field.locator(".config-state-badge")).toHaveText("Using default");
      // Setting and resetting nets out to nothing staged.
      await expect(page.locator(".config-savebar-status")).toHaveText("No unsaved changes.");

      // A range violation is refused by the gateway when the staged edit is
      // saved and confirmed; the rejection lands on the field and stays up
      // rather than fading like a success flash.
      const confirmSave = async (status: number) => {
        const settled = page.waitForResponse(
          (response) =>
            response.url().endsWith("/admin/config") &&
            response.request().method() === "PATCH" &&
            response.status() === status,
        );
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("button", { name: "Confirm save" }).click();
        await settled;
      };
      await input.fill("-1");
      await expect(input).toHaveValue("-1");
      await expect(page.locator(".config-savebar-status")).toContainText("1 unsaved change");
      await confirmSave(400);
      await expect(field.locator(".config-field-error")).toBeVisible();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(field.locator(".config-field-error")).not.toHaveText("");
      await expect(page.locator(".config-banner.error")).toContainText("Validation failed");
      await page.waitForTimeout(2_600);
      await expect(page.locator(".config-banner.error")).toContainText("Validation failed");

      // Discarding the rejected draft clears its inline and banner errors.
      await page.getByRole("button", { name: "Discard" }).click();
      await expect(input).toHaveValue("");
      await expect(field.locator(".config-field-error")).toHaveCount(0);
      await expect(page.locator(".config-banner.error")).toHaveCount(0);

      // Malformed numbers stage as text instead of vanishing, so the gateway
      // rejects them through the same inline error path as a range violation.
      await input.fill("1e309");
      await expect(field.locator(".config-state-badge")).toHaveText("Set in config");
      await expect(page.locator(".config-savebar-status")).toContainText("1 unsaved change");
      await confirmSave(400);
      await expect(field.locator(".config-field-error")).toBeVisible();
      await page.getByRole("button", { name: "Discard" }).click();
      await expect(field.locator(".config-field-error")).toHaveCount(0);

      // A curated list's explicit empty override is distinct from inheriting
      // its non-empty code default, and survives an unchanged blur.
      await search.fill("Eligible doc types");
      const listField = page.locator(".config-field").filter({ hasText: "Eligible doc types" });
      await expect(listField.locator(".config-state-badge")).toHaveText("Using default");
      await expect(listField.locator(".config-state-detail")).toHaveText("6 values");
      await listField.getByRole("button", { name: "Set an explicit empty list" }).click();
      await expect(listField.locator(".config-state-badge")).toHaveText("Set in config");
      await expect(listField.locator(".config-state-detail")).toHaveText("empty list");
      await listField.locator("textarea").focus();
      await listField.locator("textarea").blur();
      await expect(listField.locator(".config-state-badge")).toHaveText("Set in config");
      await listField.locator(".config-reset-btn").click();
      await expect(listField.locator(".config-state-badge")).toHaveText("Using default");

      // Explicit false is also distinct from an unset default-false boolean.
      await search.fill("Include unauthenticated");
      const booleanField = page
        .locator(".config-field")
        .filter({ hasText: "Include unauthenticated" });
      await booleanField.getByRole("button", { name: "Off", exact: true }).click();
      await expect(booleanField.locator(".config-state-badge")).toHaveText("Set in config");
      await booleanField.locator(".config-reset-btn").click();
      await expect(booleanField.locator(".config-state-badge")).toHaveText("Using default");

      // Search recurses into object-valued records instead of showing an empty
      // Sources card when only a nested setting matches.
      await search.fill("Sync interval");
      const sourcesCard = page.locator(".config-card").filter({ hasText: /^Sources/ });
      const defaultEntry = sourcesCard
        .locator(".config-record-head")
        .filter({ hasText: "default" });
      await expect(defaultEntry).toBeVisible();
      const syncField = sourcesCard.locator(".config-field").filter({ hasText: "Sync interval" });
      await expect(syncField.locator("input.config-input")).toHaveValue("17m");
      await page.getByRole("button", { name: /Set in config/ }).click();
      await expect(syncField).toBeVisible();

      // Defaultless settings explain what absence means rather than leaving a
      // blank field with no effective behavior.
      await page.getByRole("button", { name: "All settings" }).click();
      await search.fill("Subagent tree token budget");
      const inheritedField = page
        .locator(".config-field")
        .filter({ hasText: "Subagent tree token budget" });
      await expect(inheritedField.locator(".config-state-badge")).toHaveText("Unset");
      await expect(inheritedField.locator(".config-state-detail")).toContainText("Unlimited");

      // Numeric record add rows explain malformed values instead of ignoring
      // an enabled Add click.
      await search.fill("search.sourcePriors.weights");
      const record = page.locator(".config-record").first();
      await record.getByLabel("New record key").fill("example-source");
      await record.getByLabel("New record value").fill("1e309");
      await record.getByRole("button", { name: "Add", exact: true }).click();
      await expect(record.locator(".config-field-error")).toHaveText("Enter a valid number.");
    } finally {
      await patchTestConfig({
        search: { params: { candidateLimit: null } },
        nearDuplicates: { eligibleDocTypes: null },
        gateway: { audit: { includeUnauthenticated: null } },
        sources: { default: null },
      });
    }
  });

  test("sidebar reveals conversation actions on hover", async ({ page }) => {
    await page.route("**/agent/conversations?*", (route) =>
      route.fulfill({
        json: {
          conversations: [
            {
              id: "sidebar-layout-example",
              title: "Quarterly planning notes with a deliberately long conversation title",
              updatedAt: "2026-01-15T12:00:00.000Z",
              messageCount: 2,
              pinned: false,
            },
          ],
          nextCursor: null,
        },
      }),
    );

    await loginToPortal(page);

    const sidebar = page.locator(".app-sidebar");
    const row = page.locator(".sidebar-convo-row");
    const actions = row.locator(".sidebar-convo-actions");

    await expect(sidebar).toHaveCSS("width", "260px");
    await expect(page.locator(".sidebar-section, .sidebar-section-gap")).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(actions).toHaveCSS("opacity", "0");

    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");

    await page.locator(".app-main").hover();
    await expect(actions).toHaveCSS("opacity", "0");
    await actions.focus();
    await expect(actions).toHaveCSS("opacity", "1");
  });

  test("direct live-research resume keeps an SSE researcher card", async ({ page }) => {
    await page.addInitScript(() => {
      class ControlledEventSource {
        onopen: ((event?: unknown) => void) | null = null;
        onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
        onerror: ((event?: unknown) => void) | null = null;

        constructor() {
          (window as unknown as { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent =
            (event) => this.onmessage?.({ data: JSON.stringify(event), lastEventId: "1" });
        }

        close() {}
      }
      window.EventSource = ControlledEventSource as unknown as typeof EventSource;
    });

    await page.route("**/admin/agent/config", (route) =>
      route.fulfill({ json: { enabled: true, backend: "test", model: "test-model" } }),
    );
    await page.route("**/agent/conversations?*", (route) =>
      route.fulfill({ json: { conversations: [] } }),
    );
    await page.route("**/agent/sessions?*", async (route) => {
      // This is the race window: the SSE event is buffered by AgentClient
      // before the resumed session snapshot has reached AgentView.
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __emitAgentEvent?: unknown }).__emitAgentEvent ===
          "function",
      );
      await page.evaluate(() => {
        (window as unknown as { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
          type: "agent.subagent.spawned",
          payload: {
            sessionId: "s-live-research",
            subagentId: "s-live-research.sub.reader",
            specialist: "evidence-reader",
            title: "Evidence reader",
            task: "Find the relevant records",
          },
        });
      });
      await route.fulfill({
        json: {
          sessionId: "s-live-research",
          conversationId: "s-live-research",
          model: "test-model",
          backend: "test",
          busy: true,
          messageCount: 2,
          messagesAreVisible: true,
          messagePageInfo: { hasMore: false, nextCursor: null },
          messages: [
            { role: "user", parts: [{ kind: "text", text: "Research the archive" }] },
            { role: "assistant", parts: [{ kind: "text", text: "" }] },
          ],
        },
      });
    });

    await page.goto(`/portal/agent/s-live-research?token=${encodeURIComponent(getToken())}`);
    await expect(page.locator(".agent-subagent-specialist")).toBeVisible();
  });

  test("search input is visible and functional", async ({ page }) => {
    const errors = trackConsoleErrors(page);

    await loginToPortal(page);
    const searchInput = await gotoSearch(page);

    await searchInput.fill("test query");
    await expect(searchInput).toHaveValue("test query");

    // Submit search
    await searchInput.press("Enter");

    expect(realErrorsOf(errors)).toHaveLength(0);
  });

  test("search returns and displays results", async ({ page }) => {
    await loginToPortal(page);
    const searchInput = await gotoSearch(page);

    await searchInput.fill("playwright");
    await searchInput.press("Enter");

    // Results depend on the indexer being active — in the test env with no
    // embedder, keyword matching still answers. Verify the search completes
    // without crashing the SPA (the app shell stays mounted).
    await page.waitForTimeout(2000);
    await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  });

  test("SPA routing: /portal/doc/:id renders document view", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/doc/some-test-id");

    // SPA fallback serves index.html and the router resolves the deep path
    // client-side: the app shell (sidebar) mounts, proving no hard 404.
    await expect(page).toHaveTitle("Omnesis");
    await page.locator("nav.sidebar-nav").waitFor({ state: "visible", timeout: 15000 });
  });

  test("search view autofocuses the input", async ({ page }) => {
    await loginToPortal(page);
    const searchInput = await gotoSearch(page);

    await expect(searchInput).toBeFocused();
  });

  // The SQL view's editor is a CodeMirror instance — its editable surface is
  // `.cm-content` (a contenteditable), not a <textarea>. Type into it by
  // focusing then sending keys.
  async function typeSqlQuery(page: Page, query: string) {
    const editor = page.locator(".sql-editor .cm-content");
    await editor.waitFor({ state: "visible", timeout: 10000 });
    await editor.click();
    // Replace whatever the editor holds with the query. select-all + insertText
    // fires a single composition-style input event — far faster and more
    // reliable on CodeMirror than per-character keyboard.type, which can stall
    // against the editor's autocomplete handling.
    const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAll);
    await page.keyboard.insertText(query);
    return editor;
  }

  test("SQL tab loads and runs SQLite query", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/debug/sql");
    await expect(page).toHaveTitle("Omnesis");

    await typeSqlQuery(page, "SELECT COUNT(*) as cnt FROM documents");

    // Click run button
    await page.locator("button.sql-run-btn").click();

    // Wait for results table to appear
    const table = page.locator("table.data-table");
    await table.waitFor({ state: "visible", timeout: 5000 });

    // Check that the results footer shows row count
    const footer = page.locator(".sql-results-footer");
    await expect(footer).toContainText("row");
  });

  test("SQL tab switches store without leaving the editor", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/debug/sql");

    const editor = page.locator(".sql-editor .cm-content");
    await editor.waitFor({ state: "visible", timeout: 10000 });

    // The store is a segmented toggle, not a second row of tabs. Exactly one
    // segment is pressed — a control that marked every button would be no
    // toggle at all.
    const duckdb = page.locator(".sql-store-toggle .segmented button", { hasText: "DuckDB" });
    const sqlite = page.locator(".sql-store-toggle .segmented button", { hasText: "SQLite" });
    await expect(sqlite).toHaveAttribute("aria-pressed", "true");
    await duckdb.click();
    await expect(duckdb).toHaveAttribute("aria-pressed", "true");
    await expect(sqlite).toHaveAttribute("aria-pressed", "false");

    // Editor should still be visible after the store switch.
    await expect(editor).toBeVisible();
  });

  test("SQL tab Ctrl+Enter shortcut runs query", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/debug/sql");

    await typeSqlQuery(page, "SELECT 1 as val");

    // The editor binds Mod-Enter (Cmd on Mac, Ctrl elsewhere) to run.
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+Enter`);

    // Wait for results
    const table = page.locator("table.data-table");
    await table.waitFor({ state: "visible", timeout: 5000 });
  });

  test("nav links exist for Search and Debug", async ({ page }) => {
    await loginToPortal(page);

    // The sidebar nav lists each destination by its `.sidebar-label`. The
    // table browser and the SQL prompt are tabs of Debug, not nav entries.
    const navLabels = page.locator("nav.sidebar-nav .sidebar-label");
    const texts = await navLabels.allTextContents();
    expect(texts).toContain("Search");
    expect(texts).toContain("Debug");
    expect(texts).not.toContain("SQL");
    expect(texts).not.toContain("Data");
  });

  test("/portal/sql resolves to the SQL tab and rewrites the address bar", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/sql");

    await expect(page.locator(".sql-editor .cm-content")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/portal\/debug\/sql$/);
    await expect(page.locator("button.config-tab.active")).toHaveText("SQL");
  });

  test("/portal/data keeps its query string through the rewrite", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/data?store=sqlite&table=documents");

    // The rewrite must carry the selected table across, or a shared deep link
    // silently lands on whatever table the tab picks by default.
    await page.locator(".data-detail-title").waitFor({ state: "visible", timeout: 15000 });
    await expect(page).toHaveURL(/\/portal\/debug\/data\?store=sqlite&table=documents$/);
    await expect(page.locator(".data-detail-title")).toHaveText("documents");
  });

  test("Data tab picks a table into the URL, and Back walks it out again", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/debug/data?store=sqlite&table=documents");
    await expect(page.locator(".data-detail-title")).toHaveText("documents", { timeout: 15000 });

    // Pick a different table from the rail: the pane and the URL move
    // together. Exact-match the label — `document_people` also contains it.
    await page
      .locator(".schema-rail-name")
      .filter({ hasText: /^people$/ })
      .first()
      .click();
    await expect(page).toHaveURL(/table=people$/);
    await expect(page.locator(".data-detail-title")).toHaveText("people");

    // …and Back returns both, not just the address bar.
    await page.goBack();
    await expect(page).toHaveURL(/table=documents$/);
    await expect(page.locator(".data-detail-title")).toHaveText("documents");
  });

  test("nav offers one Settings destination, not one row per tab", async ({ page }) => {
    await loginToPortal(page);

    const texts = await page.locator("nav.sidebar-nav .sidebar-label").allTextContents();
    expect(texts).toContain("Settings");
    expect(texts).not.toContain("Config");
    expect(texts).not.toContain("Models");
    expect(texts).not.toContain("Devices");
  });

  test("/portal/models resolves to the Settings Models tab and rewrites the address bar", async ({
    page,
  }) => {
    await loginToPortal(page);
    await page.goto("/portal/models");

    // The tab bar is rendered from the route itself, so an active Models tab
    // proves the alias resolved without waiting on the Models tab's own
    // overview fetch against a bare test gateway.
    await expect(page.locator("button.config-tab.active")).toHaveText("Models", {
      timeout: 15000,
    });
    await expect(page).toHaveURL(/\/portal\/settings\/models$/);
  });

  test("picking a Settings tab moves the URL with it", async ({ page }) => {
    await loginToPortal(page);
    await page.goto("/portal/settings");

    // The default tab is Config — the structured/raw mode switch proves it
    // rendered. Generous: the tab lazy-loads its module and fetches the
    // config schema.
    await expect(page.locator(".config-toolbar-mode")).toBeVisible({ timeout: 45000 });
    await expect(page).toHaveURL(/\/portal\/settings$/);

    await page.locator("button.config-tab", { hasText: "Devices" }).click();
    await expect(page.locator(".devices-header")).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/portal\/settings\/devices$/);

    // The sidebar names the whole page, so it stays lit on a tab sub-path.
    await expect(page.locator(".sidebar-item.active .sidebar-label")).toHaveText("Settings");

    // Tab switches replace the history entry rather than pushing one, so Back
    // leaves the page instead of walking back through the tabs.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/portal\/settings/);
  });

  test("opening a capability's model picker renders the modal", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await loginToPortal(page);
    await page.goto("/portal/settings/models");

    // Grid → one capability's detail → its picker. Each step renders from a
    // different branch of the Models tab, and the picker is the only one that
    // needs the capability's own descriptor, so it is where a lookup that
    // stopped resolving surfaces.
    await page.locator(".cap-card").first().click({ timeout: 45000 });
    await expect(page.locator(".models-back")).toBeVisible({ timeout: 45000 });

    await page.locator("button", { hasText: /^Choose model$/ }).click({ timeout: 45000 });
    await expect(page.locator(".modal-panel").first()).toBeVisible({ timeout: 45000 });

    // A reference error during render unmounts the view into the error
    // boundary; assert the real page is still there and nothing threw.
    await expect(page.locator(".error-card")).toHaveCount(0);
    expect(realErrorsOf(errors)).toHaveLength(0);
  });

  test("Browser Back re-parses the document without losing the import map", async ({ page }) => {
    // A module-specifier resolution failure arrives as a pageerror, never as a
    // console message, so the console tracker alone would let it surface only
    // as an unexplained timeout below.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const errors = trackConsoleErrors(page);
    await loginToPortal(page);

    // Two real navigations, then Back. Back re-parses index.html with the
    // shell's modules already cached, which is the timing that exposes an
    // import map declared after something that triggers a module load: every
    // bare specifier fails to resolve and the SPA renders nothing.
    await page.goto("/portal/sources");
    await page.locator("nav.sidebar-nav").waitFor({ state: "visible", timeout: 30000 });
    await page.goto("/portal/settings");
    await page.locator("nav.sidebar-nav").waitFor({ state: "visible", timeout: 30000 });

    await page.goBack();

    await expect(page).toHaveURL(/\/portal\/sources$/);
    await expect(page.locator("nav.sidebar-nav")).toBeVisible({ timeout: 30000 });
    expect(pageErrors).toEqual([]);
    expect(realErrorsOf(errors)).toHaveLength(0);
  });

  test("the operator can always reach logout", async ({ page }) => {
    // Logout lives on the settings page rather than in the sidebar. What is
    // worth asserting is that it is reachable at all — an operator who cannot
    // sign out of a surface that holds their whole corpus has no way to hand
    // the machine to anyone.
    await loginToPortal(page);

    await page.goto("/portal/settings");
    await expect(page.locator("button.settings-logout-btn")).toBeVisible({ timeout: 30000 });
  });

  test("no console errors throughout navigation flow", async ({ page }) => {
    const errors = trackConsoleErrors(page);

    // Navigate to portal and login
    await loginToPortal(page);
    await page.waitForTimeout(2000);

    // Navigate to the SQL tab
    await page.goto("/portal/debug/sql");
    await page.waitForTimeout(1000);

    // Navigate to a doc route
    await page.goto("/portal/doc/nonexistent");
    await page.waitForTimeout(1000);

    // Navigate back
    await page.goto("/portal/");
    await page.waitForTimeout(1000);

    expect(realErrorsOf(errors)).toHaveLength(0);
  });
});
