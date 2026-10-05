// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { DWELL_MS, MUTATION_DEBOUNCE_MS } from "@omnesis/extension/capture/lifecycle";
import { TEST_EXTENSION_ID } from "@omnesis/extension/scripts/test-manifest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * The browser-capture extension, end to end, in a real headless Chromium
 * against a real spawned gateway.
 *
 * The sibling `browser-capture.e2e.test.ts` runs the extension's push module
 * under Node and proves the wire contract. This suite covers what only a
 * browser can: the options page pairing through Chrome's own UI, the content
 * script watching a page and handing the capture to the service worker, the
 * worker surviving eviction with nothing lost, the options page and popup
 * editing the capture settings the gateway holds for every paired browser, a
 * page deleted for good staying gone, the popup reporting truthfully when the
 * gateway revokes the device, and unpair clearing every trace.
 *
 * The extension is built with the TEST manifest (`extension/scripts/
 * test-manifest.mjs`): the wildcard-HTTPS host permission is granted at install
 * time instead of through the native dialog no automation can click. API
 * permissions match the production manifest, and the extension id is pinned.
 * The store ZIP is asserted never to carry that
 * variant. The gateway serves a self-signed certificate; the worker's `fetch`
 * does not honour Playwright's `ignoreHTTPSErrors`, so Chromium runs with
 * `--ignore-certificate-errors` — a test-lane concession the real extension
 * never gets, which is exactly why the docs require a browser-trusted cert.
 *
 * Chromium is a required dependency in CI (the e2e job installs
 * it); on a dev box without it the suite skips with a notice.
 */

/** The slice of the `chrome.*` API the assertions read from inside the worker. */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  commands: { getAll(): Promise<Array<{ name?: string; shortcut?: string }>> };
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
  permissions: { getAll(): Promise<{ origins?: string[] }> };
  windows: { getCurrent(): Promise<{ id?: number }> };
  sidePanel: {
    open(options: { windowId: number }): Promise<void>;
    onClosed: { addListener(listener: () => void): void };
  };
  tabs: {
    query(query: {
      active?: boolean;
    }): Promise<Array<{ id?: number; url?: string; active?: boolean }>>;
  };
};

const require = createRequire(import.meta.url);
// scripts/test-manifest.mjs sits one directory below the extension root.
const extensionRoot = dirname(dirname(require.resolve("@omnesis/extension/scripts/test-manifest")));

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.CI) {
  throw new Error(
    "browser-extension.e2e: the Playwright chromium browser is missing; the e2e job must run `npx playwright install chromium`",
  );
}
if (!browserAvailable) {
  console.warn(
    "browser-extension.e2e: the Playwright chromium browser is not installed — skipping.",
  );
}

const FIXTURE_ORIGIN = "https://fixture.example.test";
/** Dwell (5 s) + mutation-settle debounce, with headroom for a busy box. */
const CAPTURE_WAIT_MS = 45_000;

function fixturePage(ordinal: string): string {
  return `<!doctype html><html><head><title>Field notes ${ordinal} (fictional)</title></head><body><main><h1>Field notes ${ordinal} (fictional)</h1><p>An invented observatory logbook entry with enough readable prose for the extractor to keep: a clear evening, a borrowed notebook, and a quiet walk back along the ridge.</p><p>These additional fictional sentences make extraction stable for the headless browser suite.</p></main></body></html>`;
}

describe.skipIf(!browserAvailable)("Browser-capture extension in headless Chromium", () => {
  let harness: SyntheticE2EHarness;
  let context: BrowserContext;
  let worker: Worker;
  let dist: string;
  let profile: string;
  let baselineDocs = 0;

  const optionsUrl = `chrome-extension://${TEST_EXTENSION_ID}/options.html`;
  const popupUrl = `chrome-extension://${TEST_EXTENSION_ID}/popup.html`;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      embedderBackend: "fake",
    });
    await harness.start();

    dist = await mkdtemp(join(tmpdir(), "omnesis-extension-e2e-dist-"));
    profile = await mkdtemp(join(tmpdir(), "omnesis-extension-e2e-profile-"));
    execFileSync(process.execPath, [join(extensionRoot, "scripts", "build.mjs")], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        OMNESIS_EXTENSION_TEST_BUILD: "1",
        OMNESIS_EXTENSION_DIST_DIR: dist,
      },
      // A failed build must show esbuild's diagnostics, not just "Command failed".
      stdio: ["ignore", "pipe", "inherit"],
    });

    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        "--ignore-certificate-errors",
      ],
    });
    await context.route(`${FIXTURE_ORIGIN}/**`, (route) => {
      const ordinal = new URL(route.request().url()).pathname.replace(/^\/notes-/, "") || "one";
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixturePage(ordinal),
      });
    });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    baselineDocs = await webDocCount();
  }, 240_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await harness?.destroy();
    for (const dir of [dist, profile]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  async function webDocCount(): Promise<number> {
    const res = (await harness.gatewayJson("/documents/count/web")) as { count: number };
    return res.count;
  }

  async function waitForWebDocs(expected: number, label: string): Promise<void> {
    await expect
      .poll(webDocCount, { timeout: CAPTURE_WAIT_MS, interval: 500, message: label })
      .toBeGreaterThanOrEqual(expected);
  }

  async function visitRows(): Promise<unknown[][]> {
    const res = (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT url, dwell_ms, browser_profile_label FROM page_visits ORDER BY visited_at",
      }),
    })) as { rows?: unknown[][] };
    return res.rows ?? [];
  }

  async function waitForVisitRows(url: string): Promise<unknown[][]> {
    const deadline = Date.now() + CAPTURE_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const rows = await visitRows();
        if (rows.some((row) => row[0] === url)) return rows;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("status" in error) ||
          error.status !== 400 ||
          !("body" in error) ||
          typeof error.body !== "string"
        )
          throw error;
        const body = JSON.parse(error.body) as { code?: string; error?: string };
        if (
          body.code !== "BAD_REQUEST" ||
          body.error?.toLowerCase() !==
            "sql queries must be a single statement: catalog error: table with name page_visits does not exist!"
        )
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for page_visits analytics for ${url}`);
  }

  function currentWorker(): Promise<Worker> {
    const live = context.serviceWorkers()[0];
    return live ? Promise.resolve(live) : context.waitForEvent("serviceworker");
  }

  async function extensionStorage(): Promise<Record<string, unknown>> {
    worker = await currentWorker();
    return worker.evaluate(() => chrome.storage.local.get(null));
  }

  function pendingHandoffKeys(storage: Record<string, unknown>): string[] {
    return Object.keys(storage).filter((key) => key.startsWith("omnesis.capture.pending.v1."));
  }

  async function openPage(url: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }

  test("the test build pins the extension id and pre-grants site access", async () => {
    expect(new URL(worker.url()).host).toBe(TEST_EXTENSION_ID);
    const granted = await worker.evaluate(() => chrome.permissions.getAll());
    expect(granted.origins).toContain("https://*/*");
  });

  test("pairing through the real options page stores a write:web credential", async () => {
    const minted = (await harness.gatewayJson("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "Browser extension (headless E2E)", kind: "browser" }),
    })) as { pairingCode: string };
    expect(minted.pairingCode).toBeTruthy();

    const options = await openPage(optionsUrl);
    await options.fill("#profile-label", "Personal");
    await options.fill("#gateway-url", harness.gatewayUrl);
    await options.fill("#pairing-code", minted.pairingCode);
    await options.check("#capture-consent");
    await options.click("#pair-submit");
    await options.locator("#paired").waitFor({ state: "visible", timeout: 30_000 });
    expect(await options.locator("#paired-scopes").textContent()).toContain("write:web");
    await options.close();

    const storage = await extensionStorage();
    const pairing = JSON.parse(String(storage["omnesis.pairing.v1"])) as {
      gatewayUrl: string;
      scopes: string[];
      deviceId: string;
    };
    expect(pairing.gatewayUrl).toBe(harness.gatewayUrl);
    expect(pairing.scopes).toEqual(["write:web"]);
    expect(pairing.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    // The token lives under its own key so the content script never reads it.
    expect(pairing).not.toHaveProperty("token");
    expect(typeof storage["omnesis.token.v1"]).toBe("string");
  }, 60_000);

  test(
    "a page read for the dwell window lands in the gateway as a document and a visit",
    async () => {
      const article = await openPage(`${FIXTURE_ORIGIN}/notes-one`);
      await article.bringToFront();
      await waitForWebDocs(baselineDocs + 1, "first capture must be indexed");

      const search = (await harness.gatewayJson(
        `/documents/search?q=${encodeURIComponent("observatory logbook")}`,
      )) as { results?: Array<{ source_id: string }> };
      expect(
        (search.results ?? []).some((hit) => hit.source_id === "web"),
        "the captured page must be searchable by its extracted text",
      ).toBe(true);

      // Documents and visit analytics arrive through separate push requests.
      const rows = await waitForVisitRows(`${FIXTURE_ORIGIN}/notes-one`);
      expect(rows.length, "one page_visits row per dwell-confirmed visit").toBeGreaterThanOrEqual(
        1,
      );
      expect(String(rows[0]?.[0])).toBe(`${FIXTURE_ORIGIN}/notes-one`);
      expect(Number(rows[0]?.[1])).toBeGreaterThanOrEqual(5_000);
      expect(rows[0]?.[2]).toBe("Personal");
      await article.close();
    },
    CAPTURE_WAIT_MS + 30_000,
  );

  test("the popup reports the capture and a healthy pairing", async () => {
    const popup = await openPage(popupUrl);
    await expect
      .poll(() => popup.locator("#state").getAttribute("data-state"), { timeout: 20_000 })
      .toMatch(/^(ready|syncing)$/);
    expect(await popup.locator("#gateway").textContent()).toContain(
      new URL(harness.gatewayUrl).host,
    );
    expect(await popup.locator("#scope").textContent()).toBe("Yes");
    // The popup is open in its own tab here, so the "current page" is an
    // extension page Chrome reveals no URL for: ineligible, never a warning.
    await expect
      .poll(() => popup.locator("#current-page").getAttribute("data-state"), { timeout: 10_000 })
      .toBe("ineligible");
    await popup.locator("#recent-list > *").first().waitFor({ state: "attached", timeout: 20_000 });
    expect(await popup.locator("#recent-list").textContent()).toContain(
      "Field notes one (fictional)",
    );
    await popup.close();
  }, 60_000);

  test(
    "a service worker evicted mid-life comes back and the next page still lands",
    async () => {
      // Stop the worker the way Chrome does when it idles out. The next event
      // (the content script's capture message) must revive a fresh worker that
      // finds its pairing and queue in storage.
      const bootstrap = await context.newPage();
      const cdp = await context.newCDPSession(bootstrap);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      await cdp.detach();
      await bootstrap.close();

      const article = await openPage(`${FIXTURE_ORIGIN}/notes-two`);
      await article.bringToFront();
      await waitForWebDocs(baselineDocs + 2, "capture after worker eviction must be indexed");
      const storage = await extensionStorage();
      expect(
        pendingHandoffKeys(storage),
        "no staged handoff may be left behind once delivered",
      ).toEqual([]);
      await article.close();
    },
    CAPTURE_WAIT_MS + 30_000,
  );

  test(
    "excluding the open page from the popup says so and stops that page capturing",
    async () => {
      const fixtureHost = new URL(FIXTURE_ORIGIN).hostname;
      const article = await openPage(`${FIXTURE_ORIGIN}/notes-five`);
      await article.bringToFront();
      const popup = await openPage(popupUrl);
      try {
        // A real toolbar popup floats over the page it is about, so the tab
        // under it stays the active one. Here the popup is a tab of its own, so
        // the article is brought back to the front and the popup re-rendered
        // against it; and the exclude control is dispatched rather than clicked
        // so the popup's own tab never takes the focus back.
        await article.bringToFront();
        await popup.reload();
        await expect
          .poll(() => popup.locator("#exclude-site").textContent(), { timeout: 20_000 })
          .toBe(`Exclude ${fixtureHost}`);
        await popup.locator("#exclude-site").dispatchEvent("click");

        // The click has a result the user can see, without reopening anything.
        await expect
          .poll(() => popup.locator("#exclude-done").textContent(), { timeout: 20_000 })
          .toContain(`${fixtureHost} is excluded`);
        expect(await popup.locator("#exclude-site").isVisible()).toBe(false);
        const policy = (await harness.gatewayJson("/web-capture-policy")) as {
          excludedDomains: string[];
        };
        expect(policy.excludedDomains).toEqual([fixtureHost]);

        // The article was never reloaded, so the verdict reported for it is the
        // one its own content script reached when the settings changed under
        // it — named by the setting that applies, not the general wording.
        await article.bringToFront();
        await popup.reload();
        await expect
          .poll(() => popup.locator("#current-page").textContent(), { timeout: 20_000 })
          .toBe("Excluded — this site is on your list");
        expect(await popup.locator("#current-page").getAttribute("data-state")).toBe("excluded");
        await popup.close();

        const before = await webDocCount();
        await article.bringToFront();
        await new Promise((resolve) =>
          setTimeout(resolve, DWELL_MS + MUTATION_DEBOUNCE_MS + 2_000),
        );
        expect(await webDocCount(), "an excluded page must capture nothing").toBe(before);
        const staged = await extensionStorage();
        expect(JSON.parse(String(staged["omnesis.push.queue.v1"] ?? "[]"))).toEqual([]);
        await article.close();
      } finally {
        // The exclusion and the capture are shared state; leave neither behind
        // for the tests that follow, even when an assertion above failed. Both
        // are undone through the gateway rather than the options page, so the
        // cleanup cannot fail for a reason of its own — the page as a copy
        // only, so it names no page in the settings either.
        await harness.gatewayJson(
          `/web-capture-policy/excluded-domains/${encodeURIComponent(fixtureHost)}`,
          { method: "DELETE" },
        );
        const listed = (await harness.gatewayJson("/documents/recent/web?limit=50")) as {
          documents?: Array<{ id: string; title: string }>;
        };
        for (const doc of listed.documents ?? []) {
          if (doc.title.includes("five")) {
            await harness.gatewayJson(`/documents/${doc.id}?tombstone=0`, { method: "DELETE" });
          }
        }
        // The browser holds its own copy of the settings and did not make these
        // edits, so it would keep serving the stale list to the options page.
        // Opening the popup is what makes it read the gateway again.
        const refresher = await openPage(popupUrl);
        await expect
          .poll(
            async () => {
              const raw = (await extensionStorage())["omnesis.capture.policy.v1"];
              if (typeof raw !== "string" || !raw) return [];
              return (JSON.parse(raw) as { policy: { excludedDomains: string[] } }).policy
                .excludedDomains;
            },
            { timeout: 20_000 },
          )
          .not.toContain(fixtureHost);
        await refresher.close();
      }
    },
    CAPTURE_WAIT_MS + 60_000,
  );

  test(
    "an exclusion made on the options page lands on the gateway and blocks capture",
    async () => {
      const fixtureHost = new URL(FIXTURE_ORIGIN).hostname;
      const options = await openPage(optionsUrl);
      await options.locator("#exclusion-form").waitFor({ state: "visible", timeout: 20_000 });
      await options.fill("#exclusion-input", fixtureHost);
      await options.check("#exclusion-purge");
      await options.click("#exclusion-form button[type=submit]");
      await expect
        .poll(() => options.locator("#exclusions").textContent(), { timeout: 20_000 })
        .toContain(fixtureHost);
      expect(await options.locator("#status").textContent()).toMatch(/2 captured pages deleted/);
      await options.close();

      // The gateway holds the setting, and the purge removed both captured pages.
      const policy = (await harness.gatewayJson("/web-capture-policy")) as {
        excludedDomains: string[];
        removedPages: string[];
      };
      expect(policy.excludedDomains).toEqual([fixtureHost]);
      expect(policy.removedPages).toHaveLength(2);
      expect(await webDocCount()).toBe(baselineDocs);

      // A page on the excluded domain read for a full dwell window never leaves
      // the browser: nothing lands, and nothing is even queued.
      const article = await openPage(`${FIXTURE_ORIGIN}/notes-three`);
      await article.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, DWELL_MS + MUTATION_DEBOUNCE_MS + 2_000));
      expect(await webDocCount(), "an excluded domain must capture nothing").toBe(baselineDocs);
      const storage = await extensionStorage();
      expect(JSON.parse(String(storage["omnesis.push.queue.v1"] ?? "[]"))).toEqual([]);
      await article.close();

      // Removing the exclusion is a gateway edit too.
      const again = await openPage(optionsUrl);
      await again.locator("#exclusions button").first().click();
      await expect
        .poll(() => again.locator("#exclusions").textContent(), { timeout: 20_000 })
        .not.toContain(fixtureHost);
      await again.close();
      const cleared = (await harness.gatewayJson("/web-capture-policy")) as {
        excludedDomains: string[];
      };
      expect(cleared.excludedDomains).toEqual([]);
    },
    CAPTURE_WAIT_MS + 60_000,
  );

  test("the popup pauses capture on the gateway for every paired browser, and resumes", async () => {
    const popup = await openPage(popupUrl);
    await popup.locator("#controls button", { hasText: "1 hour" }).click();
    await expect
      .poll(() => popup.locator("#state").getAttribute("data-state"), { timeout: 20_000 })
      .toBe("paused");
    const paused = (await harness.gatewayJson("/web-capture-policy")) as {
      pause: { until: number | null } | null;
    };
    expect(paused.pause?.until).toBeGreaterThan(Date.now());
    expect(await popup.locator("#controls").textContent()).toMatch(/every paired browser/);

    await popup.locator("#controls button", { hasText: "Resume capturing" }).click();
    await expect
      .poll(() => popup.locator("#state").getAttribute("data-state"), { timeout: 20_000 })
      .toMatch(/^(ready|syncing)$/);
    const resumed = (await harness.gatewayJson("/web-capture-policy")) as { pause: unknown };
    expect(resumed.pause).toBeNull();
    await popup.close();
  }, 60_000);

  test(
    "a page deleted for good is never captured again by the browser",
    async () => {
      // Capture a page never seen before (the purge above deleted the earlier
      // ones for good), then delete it the way the portal, CLI or phone does.
      const article = await openPage(`${FIXTURE_ORIGIN}/notes-four`);
      await article.bringToFront();
      await waitForWebDocs(
        baselineDocs + 1,
        "a fresh page is captured once the exclusion is lifted",
      );
      await article.close();
      const listed = (await harness.gatewayJson("/documents/recent/web?limit=50")) as {
        documents?: Array<{ id: string; title: string; externalId: string }>;
      };
      const target = (listed.documents ?? []).find((d) => d.title.includes("four"));
      expect(target, "the captured page is listed").toBeDefined();
      await harness.gatewayJson(`/documents/${target!.id}`, { method: "DELETE" });
      expect(await webDocCount()).toBe(baselineDocs);

      // Opening the popup refreshes the browser's copy of the policy; wait until
      // that copy names the page, then a full dwell on it captures nothing.
      const popup = await openPage(popupUrl);
      await expect
        .poll(
          async () => {
            const raw = (await extensionStorage())["omnesis.capture.policy.v1"];
            if (typeof raw !== "string" || !raw) return [];
            return (JSON.parse(raw) as { policy: { removedPages: string[] } }).policy.removedPages;
          },
          { timeout: 20_000 },
        )
        .toContain(target!.externalId);
      await popup.close();
      const revisit = await openPage(`${FIXTURE_ORIGIN}/notes-four`);
      await revisit.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, DWELL_MS + MUTATION_DEBOUNCE_MS + 2_000));
      expect(await webDocCount(), "a page deleted for good stays gone").toBe(baselineDocs);
      const storage = await extensionStorage();
      expect(JSON.parse(String(storage["omnesis.push.queue.v1"] ?? "[]"))).toEqual([]);
      await revisit.close();
    },
    CAPTURE_WAIT_MS * 2 + 60_000,
  );

  test("Tell Omnesis automatically enables and preserves a selected-page draft through the create-only grant", async () => {
    const options = await openPage(optionsUrl);
    const health = await fetch(`${harness.gatewayUrl}/health`);
    expect(await health.json()).toMatchObject({
      capabilities: { browserNotes: { min: 1, max: 1 } },
    });
    const discovered = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "notes-status" }),
    );
    expect(discovered).toMatchObject({ supported: true, enabled: true });
    await expect
      .poll(
        async () =>
          ((await extensionStorage())["omnesis.notes.token.v1"] as { token?: string } | undefined)
            ?.token,
        { timeout: 20_000 },
      )
      .toBeTruthy();
    expect(await options.locator("#enable-notes").count()).toBe(0);
    expect(await options.locator("#enable-find").count()).toBe(0);
    await options.close();

    const article = await openPage(`${FIXTURE_ORIGIN}/notes-six`);
    const quotation = await article.locator("main p").first().textContent();
    await article.evaluate(() => {
      const paragraph = document.querySelector("main p");
      if (!paragraph) throw new Error("Missing fixture passage");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    const popup = await openPage(popupUrl);
    await article.bringToFront();
    await popup.reload();
    await expect
      .poll(() => popup.locator("#tell-omnesis").isVisible(), { timeout: 20_000 })
      .toBe(true);
    expect(await popup.locator(".brand-title").textContent()).toBe("Omnesis");
    expect(await popup.locator(".brand-actions #tell-omnesis").count()).toBe(1);
    expect(await popup.locator("#find-omnesis").count()).toBe(0);
    expect(await popup.locator("#tell-omnesis").getAttribute("aria-label")).toBe("Tell Omnesis");
    const commands = await popup.evaluate(() => chrome.commands.getAll());
    expect(commands.some((command) => command.name === "find-omnesis")).toBe(false);
    const shortcut = commands.find((command) => command.name === "tell-omnesis")?.shortcut;
    await expect
      .poll(() => popup.locator("#tell-omnesis").getAttribute("title"))
      .toBe(
        shortcut
          ? `Tell Omnesis · ${shortcut}`
          : "Tell Omnesis · Assign a shortcut in chrome://extensions/shortcuts",
      );
    // The popup caches the article before the trusted click gives this test tab focus.
    await popup.locator("#tell-omnesis").click();
    await expect
      .poll(
        async () => {
          const state = (await extensionStorage())["omnesis.notes.state.v1"] as
            | { draft?: { selection: string } }
            | undefined;
          return state?.draft?.selection;
        },
        { timeout: 20_000 },
      )
      .toBe(quotation);
    await expect.poll(() => popup.isClosed(), { timeout: 20_000 }).toBe(true);

    // Open the same extension document as a tab so Playwright can inspect the composer.
    // Chrome's native side panel is outside Playwright's ordinary page target list.
    const notesUrl = `chrome-extension://${TEST_EXTENSION_ID}/notes.html`;
    const panel = await openPage(notesUrl);
    await panel.locator("#notes-form").waitFor({ state: "visible", timeout: 20_000 });
    expect(await panel.locator("#note-selection").textContent()).toBe(quotation);
    expect(await panel.locator("#note-url").getAttribute("href")).toBe(article.url());
    expect(
      await panel.locator("#note-text").evaluate((field) => field === document.activeElement),
    ).toBe(true);
    const thought = "Use this invented logbook structure for the next fictional observation.";
    await panel.fill("#note-text", thought);
    await expect.poll(() => panel.locator("#note-draft-status").textContent()).toBe("Draft saved");
    await panel.setViewportSize({ width: 380, height: 820 });
    await panel.screenshot({
      path: join(tmpdir(), "omnesis-extension-notes-composer.png"),
      fullPage: true,
    });
    // Open a real native panel in this window from a trusted test click. The
    // rendered extension document then exercises its production Escape handler.
    await panel.evaluate(async () => {
      const window = await chrome.windows.getCurrent();
      const windowId = window.id;
      if (windowId === undefined) throw new Error("The browser window ID is unavailable");
      let closed = 0;
      chrome.sidePanel.onClosed.addListener(() => {
        document.body.dataset.nativeClosed = String(++closed);
      });
      const open = document.createElement("button");
      open.id = "e2e-open-native-panel";
      open.textContent = "Open test panel";
      open.addEventListener("click", () => {
        void chrome.sidePanel.open({ windowId }).then(
          () => {
            document.body.dataset.nativeOpened = "true";
          },
          (error: unknown) => {
            document.body.dataset.nativeOpenError = String(error);
          },
        );
      });
      document.body.append(open);
    });
    await panel.locator("#e2e-open-native-panel").click();
    await expect
      .poll(
        async () => {
          const error = await panel.locator("body").getAttribute("data-native-open-error");
          if (error) throw new Error(error);
          return panel.locator("body").getAttribute("data-native-opened");
        },
        { timeout: 10_000 },
      )
      .toBe("true");
    await panel.locator("#note-text").press("Escape");
    await expect
      .poll(() => panel.locator("body").getAttribute("data-native-closed"), { timeout: 10_000 })
      .toBe("1");
    expect(await panel.inputValue("#note-text")).toBe(thought);
    expect((await extensionStorage())["omnesis.notes.state.v1"]).toMatchObject({
      draft: { text: thought },
    });
    await panel.close();

    const other = await openPage(`${FIXTURE_ORIGIN}/notes-seven`);
    const reopened = await openPage(notesUrl);
    await reopened.locator("#notes-form").waitFor({ state: "visible", timeout: 20_000 });
    expect(await reopened.inputValue("#note-text")).toBe(thought);
    expect(await reopened.locator("#note-url").getAttribute("href")).toBe(article.url());
    await reopened.locator("#note-text").press("Control+Enter");
    await expect
      .poll(() => reopened.locator("#notes-status").textContent(), { timeout: 30_000 })
      .toBe("Saved to Omnesis.");
    const notes = await harness.gatewayJson<{
      entries: Array<{
        id: string;
        text: string;
        surface: string;
        page?: { url: string; selection: string };
      }>;
    }>("/notes");
    const saved = notes.entries.filter((note) => note.text.includes(thought));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      surface: "chrome-extension",
      page: { url: article.url(), selection: quotation },
    });
    const savedId = saved[0]!.id;
    const savedButton = reopened.locator(`#saved-notes-list button[data-note-id="${savedId}"]`);
    await savedButton.waitFor({ state: "visible", timeout: 30_000 });
    await savedButton.click();
    await reopened.locator("#saved-note-editor").waitFor({ state: "visible" });
    expect(await reopened.inputValue("#saved-note-text")).toBe(thought);
    expect(await reopened.locator("#saved-note-url").getAttribute("href")).toBe(article.url());
    const revised =
      "Keep this revised fictional observation without changing its selected passage.";
    await reopened.fill("#saved-note-text", revised);
    await reopened.locator("#saved-note-text").press("Control+Enter");
    await expect
      .poll(() => reopened.locator("#saved-notes-status").textContent(), { timeout: 30_000 })
      .toBe("Changes saved to Omnesis.");
    const edited = await harness.gatewayJson<{
      entries: Array<{ id: string; text: string; page?: { url: string; selection: string } }>;
    }>("/notes");
    const entry = edited.entries.find((note) => note.id === savedId);
    expect(entry?.text).toContain(revised);
    expect(entry?.text).not.toContain(thought);
    expect(entry?.page).toMatchObject({ url: article.url(), selection: quotation });
    expect(edited.entries.filter((note) => note.id === savedId)).toHaveLength(1);
    await reopened.close();
    await other.close();
    await article.close();
  }, 120_000);

  test("Find opens browser links in its own tab while preserving notes", async () => {
    const articleUrl = `${FIXTURE_ORIGIN}/find-waypoint`;
    const webTitle = "Waypoint research notebook";
    const notionTitle =
      "Waypoint architecture review with an unusually long fictional title for a compact results panel";
    const gmailUrl =
      "https://mail.google.com/mail/u/0/?authuser=find%40example.org#all/abcdef123456";
    const notionUrl = "https://www.notion.so/123456781234123412341234567890ab";
    const fixtureDocs = [
      {
        sourceId: "web",
        providerId: "web",
        externalId: "find-waypoint",
        title: webTitle,
        url: articleUrl,
      },
      {
        sourceId: "gmail:find@example.org",
        providerId: "google:find@example.org",
        externalId: "find-email",
        title: "Waypoint email guide",
        url: gmailUrl,
      },
      {
        sourceId: "notion-pages:find-workspace",
        providerId: "notion:find-workspace",
        externalId: "find-notion",
        title: notionTitle,
        url: notionUrl,
      },
      {
        sourceId: "apple-notes:find-notebook",
        providerId: "apple:find-notebook",
        externalId: "find-native",
        title: "Waypoint native notebook",
        url: "mobilenotes://showNote?identifier=fictional",
      },
    ];
    await harness.pushDocuments(
      fixtureDocs.map((doc) => ({
        sourceId: doc.sourceId,
        providerId: doc.providerId,
        externalId: doc.externalId,
        title: doc.title,
        content: `${doc.title}. Waypoint observations are entirely invented for this browser test.`,
        metadata: { sourceUrl: doc.url },
      })),
    );
    await expect
      .poll(
        async () => {
          await harness.refreshSearchSnapshot();
          const response = await harness.gatewayJson<{
            results: Array<{ documentId: string; title: string }>;
          }>("/search", { method: "POST", body: JSON.stringify({ text: "Waypoint", limit: 200 }) });
          return fixtureDocs.every((doc) =>
            response.results.some((hit) => hit.title === doc.title),
          );
        },
        { timeout: 120_000, interval: 500 },
      )
      .toBe(true);
    const options = await openPage(optionsUrl);
    const discovered = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "find-status" }),
    );
    expect(discovered).toMatchObject({ supported: true, enabled: true });
    await expect
      .poll(
        async () =>
          ((await extensionStorage())["omnesis.find.token.v1"] as { token?: string } | undefined)
            ?.token,
        { timeout: 20_000, interval: 250 },
      )
      .toBeTruthy();
    expect(await options.locator("#enable-notes").count()).toBe(0);
    expect(await options.locator("#enable-find").count()).toBe(0);
    const storage = await extensionStorage();
    expect(storage["omnesis.notes.token.v1"]).toBeTruthy();
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      scopes: ["write:web"],
    });
    await options.close();
    const article = await openPage(articleUrl);
    const findUrl = `chrome-extension://${TEST_EXTENSION_ID}/find.html?q=Waypoint`;
    const panel = await openPage(findUrl);
    await panel.setViewportSize({ width: 1100, height: 820 });
    await panel.locator("#find-section").waitFor({ state: "visible", timeout: 20_000 });
    // The active fixture page may also be captured under its canonical URL hash.
    // Verify the intended destinations individually rather than counting unrelated captures.
    for (const title of [webTitle, notionTitle, "Waypoint email guide"])
      await expect
        .poll(() => panel.locator(".find-result-title").filter({ hasText: title }).count(), {
          timeout: 30_000,
          interval: 250,
        })
        .toBe(1);
    await expect
      .poll(() => panel.locator("#find-decision").textContent())
      .toContain("Direct search");
    await expect.poll(() => panel.locator("#find-results").textContent()).toContain(notionTitle);
    await expect
      .poll(() => panel.locator("#find-results").textContent())
      .toContain("Waypoint email guide");
    expect(await panel.locator("#find-results").textContent()).not.toContain(
      "Waypoint native notebook",
    );
    const row = panel
      .locator(".find-result")
      .filter({ has: panel.locator(".find-result-title", { hasText: webTitle }) });
    await expect.poll(() => row.locator(".find-open-badge").textContent()).toBe("Open tab");
    expect(await panel.locator("#find-results mark").count()).toBeGreaterThan(0);
    await panel.screenshot({ path: "/tmp/omnesis-extension-find-results.png", fullPage: true });
    expect(await panel.locator(".find-new-copy").count()).toBe(0);
    expect(await row.locator(".find-result-open").getAttribute("href")).toBe(articleUrl);
    const pageCount = context.pages().length;
    // The keyboard modifier still opens another tab without a dedicated button.
    await row.locator(".find-result-open").focus();
    await panel.locator("#find-query").focus();
    const newPage = context.waitForEvent("page");
    await panel.locator("#find-query").press("Control+Enter");
    const copy = await newPage;
    await expect.poll(() => copy.url(), { timeout: 10_000, interval: 100 }).toBe(articleUrl);
    expect(context.pages()).toHaveLength(pageCount + 1);
    expect(panel.url()).toBe(findUrl);
    await copy.close();
    // A normal card click navigates this Find tab even when the destination is already open.
    await row.locator(".find-result-open").click();
    await expect.poll(() => panel.url(), { timeout: 10_000, interval: 100 }).toBe(articleUrl);
    expect(article.url()).toBe(articleUrl);
    expect(context.pages()).toHaveLength(pageCount);
    await panel.close();
    await article.close();
  }, 180_000);

  test("when the gateway revokes the device the popup says to re-pair", async () => {
    const storage = await extensionStorage();
    const { deviceId } = JSON.parse(String(storage["omnesis.pairing.v1"])) as { deviceId: string };
    // A logged-in owner session must not make this browser's revoked capture
    // credential appear authorized.
    const login = await context.request.post(`${harness.gatewayUrl}/portal/api/login`, {
      data: { token: harness.apiKey },
    });
    expect(login.ok()).toBe(true);
    expect(
      (await context.cookies(harness.gatewayUrl)).some((cookie) =>
        cookie.name.startsWith("__omnesis_session"),
      ),
    ).toBe(true);
    await harness.gatewayJson(`/admin/devices/${deviceId}`, { method: "DELETE" });

    // Opening the popup runs an immediate auth probe against the gateway.
    const popup = await openPage(popupUrl);
    await expect
      .poll(() => popup.locator("#warn").textContent(), { timeout: 30_000 })
      .toMatch(/re-pair/i);
    expect(await popup.locator("#state").getAttribute("data-state")).toBe("not-syncing");
    await popup.close();
  }, 60_000);

  test("unpair clears the credential, the queue and every staged capture", async () => {
    const options = await openPage(optionsUrl);
    await options.click("#unpair");
    await options.locator("#pair-form").waitFor({ state: "visible", timeout: 30_000 });
    await options.close();

    const storage = await extensionStorage();
    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
    expect(JSON.parse(String(storage["omnesis.push.queue.v1"] ?? "[]"))).toEqual([]);
    expect(pendingHandoffKeys(storage)).toEqual([]);

    // On a real install unpair also revokes the optional host grant, which
    // unregisters the content script. The test manifest grants that permission
    // unconditionally, so Chrome refuses to remove it and the script stays
    // registered — the observable that matters is that it now fails closed: a
    // page read for a full dwell window after unpair must not reach the
    // gateway.
    const before = await webDocCount();
    const article = await openPage(`${FIXTURE_ORIGIN}/notes-three`);
    await article.bringToFront();
    // The page would have to dwell and settle before a capture could leave it.
    await new Promise((resolve) => setTimeout(resolve, DWELL_MS + MUTATION_DEBOUNCE_MS + 2_000));
    expect(await webDocCount(), "an unpaired browser must capture nothing").toBe(before);
    await article.close();

    // An unpaired browser is not a broken one. This is also what a freshly
    // installed extension shows, so the popup must report it plainly and
    // without a warning telling the user to repair something.
    const popup = await openPage(popupUrl);
    await expect
      .poll(() => popup.locator("#state").getAttribute("data-state"), { timeout: 20_000 })
      .toBe("unpaired");
    expect(await popup.locator("#state").textContent()).toBe("Not paired");
    expect(await popup.locator("#warn").textContent()).toBe("");
    expect(await popup.locator("body").getAttribute("data-warn")).toBe("false");
    await popup.close();
  }, 60_000);
  test("Browser Find and notes stay hidden on a stable gateway while page capture works", async () => {
    const stable = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
    });
    await stable.start();
    try {
      const minted = await stable.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "browser", name: "Stable browser" }),
      });
      const options = await openPage(optionsUrl);
      // This also supports running the stable regression after only selected feature tests.
      if (await options.locator("#unpair").isVisible()) await options.locator("#unpair").click();
      await options.locator("#pair-form").waitFor({ state: "visible" });
      await options.fill("#profile-label", "Stable browser");
      await options.fill("#gateway-url", stable.gatewayUrl);
      await options.fill("#pairing-code", minted.pairingCode);
      await options.check("#capture-consent");
      await options.click("#pair-submit");
      await options.locator("#paired").waitFor({ state: "visible", timeout: 30_000 });
      const support = await options.evaluate(async () => ({
        notes: await chrome.runtime.sendMessage({ type: "notes-status" }),
        find: await chrome.runtime.sendMessage({ type: "find-status" }),
      }));
      expect(support).toMatchObject({ notes: { supported: false }, find: { supported: false } });
      expect(await options.locator("#notes-entry").isVisible()).toBe(false);
      expect(await options.locator("#find-entry").isVisible()).toBe(false);
      const login = await context.request.post(`${stable.gatewayUrl}/portal/api/login`, {
        data: { token: stable.apiKey },
      });
      expect(login.ok()).toBe(true);
      for (const feature of ["notes", "find"]) {
        const approval = await openPage(
          `${stable.gatewayUrl}/portal/browser-${feature}?request=00000000-0000-4000-8000-000000000001`,
        );
        await approval
          .getByRole("heading", { name: "Browser authorization", exact: true })
          .waitFor({ state: "visible", timeout: 20_000 });
        expect(await approval.getByRole("button", { name: /^Enable / }).count()).toBe(0);
        expect(await approval.locator("h1").textContent()).toBe("Browser authorization");
        await approval.close();
      }
      const popup = await openPage(popupUrl);
      await expect
        .poll(() => popup.locator("#state").getAttribute("data-state"), { timeout: 30_000 })
        .toBe("ready");
      expect(await popup.locator("#notes-entry").isVisible()).toBe(false);
      expect(await popup.locator("#find-entry").isVisible()).toBe(false);
      await popup.close();
      const article = await openPage(`${FIXTURE_ORIGIN}/notes-stable`);
      await article.bringToFront();
      await expect
        .poll(
          async () => (await stable.gatewayJson<{ count: number }>("/documents/count/web")).count,
          { timeout: CAPTURE_WAIT_MS, interval: 500 },
        )
        .toBeGreaterThanOrEqual(1);
      const storage = await extensionStorage();
      expect(
        (JSON.parse(String(storage["omnesis.pairing.v1"])) as { scopes: string[] }).scopes,
      ).toEqual(["write:web"]);
      await article.close();
      await options.locator("#unpair").click();
      await options.close();
    } finally {
      await stable.destroy();
    }
  }, 240_000);
});
