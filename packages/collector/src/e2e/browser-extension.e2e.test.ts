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
 * time instead of through the native dialog no automation can click, and the
 * extension id is pinned. The store ZIP is asserted never to carry that
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
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
  permissions: { getAll(): Promise<{ origins?: string[] }> };
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
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
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

      const rows = await visitRows();
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

  test("when the gateway revokes the device the popup says to re-pair", async () => {
    const storage = await extensionStorage();
    const { deviceId } = JSON.parse(String(storage["omnesis.pairing.v1"])) as { deviceId: string };
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
});
