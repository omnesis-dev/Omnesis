// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_POLICY_KEY, PAUSE_ONE_DAY_MS, PAUSE_ONE_HOUR_MS } from "../capture/policy.js";
import { PAIRING_KEY } from "./storage.js";
import { initPopup } from "./popup-page.js";
import {
  FakePageChrome,
  TEST_PAIRING,
  cachedPolicy,
  loadPage,
  pairedStorage,
  policyBody,
} from "./page-test-fakes.js";

/**
 * The popup controller rendered into the shipped `popup.html` under linkedom.
 * `chrome` is installed as the global (the storage and permission helpers read
 * it there) and handed to `initPopup` as well. Every fixture is invented.
 */

/** The wall clock at load; timestamps are placed relative to it so relative times stay stable. */
const T0 = Date.now();

interface Popup {
  document: Document;
  window: { Event: typeof Event };
  chrome: FakePageChrome;
  $: (id: string) => HTMLElement;
  text: (id: string) => string;
  state: () => { state: string | undefined; label: string };
}

function openPopup(
  storage: Record<string, unknown>,
  configure: (chrome: FakePageChrome) => void = () => undefined,
): Popup {
  const { document, window } = loadPage("popup.html");
  const chrome = new FakePageChrome(storage);
  configure(chrome);
  vi.stubGlobal("chrome", chrome.api);
  initPopup(document, chrome.api);
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };
  return {
    document,
    window,
    chrome,
    $,
    text: (id) => $(id).textContent ?? "",
    state: () => ({ state: $("state").dataset.state, label: $("state").textContent ?? "" }),
  };
}

function click(popup: Popup, el: Element): void {
  el.dispatchEvent(new popup.window.Event("click"));
}

async function waitForState(popup: Popup, state: string): Promise<void> {
  await vi.waitFor(() => expect(popup.state().state).toBe(state));
}

function chipButtons(popup: Popup): HTMLButtonElement[] {
  return [...popup.$("controls").querySelectorAll("button")] as HTMLButtonElement[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("popup — summary states", () => {
  it("renders an unpaired browser with every control hidden", async () => {
    const popup = openPopup({});
    await waitForState(popup, "unpaired");
    expect(popup.state().label).toBe("Not paired");
    expect(popup.document.body.dataset.paired).toBe("false");
    expect(popup.text("gateway")).toBe("—");
    expect(popup.text("queue")).toBe("—");
    expect(popup.text("last-checked")).toBe("—");
    expect(popup.text("scope")).toBe("—");
    expect(popup.$("controls").hidden).toBe(true);
    expect(popup.$("exclude-wrap").hidden).toBe(true);
    expect(popup.$("recent-wrap").hidden).toBe(true);
    // A browser that has never paired is not broken. This is the first thing
    // anyone sees after installing, so it carries no warning at all.
    expect(popup.text("warn")).toBe("");
    expect(popup.document.body.dataset.warn).toBe("false");
    await vi.waitFor(() => expect(popup.text("current-page")).toBe("—"));
    // Opening the popup asks the worker for a fresh verdict exactly once.
    expect(popup.chrome.sent("check-now")).toHaveLength(1);
  });

  it("renders a healthy paired browser as ready, with the gateway version line", async () => {
    const popup = openPopup(
      pairedStorage({
        [PAIRING_KEY]: JSON.stringify({ ...TEST_PAIRING, gatewayVersion: "0.4.5" }),
        "omnesis.push.checked.v1": JSON.stringify({ at: T0 - 3 * 60_000 }),
      }),
    );
    await waitForState(popup, "ready");
    expect(popup.state().label).toBe("Ready");
    expect(popup.document.body.dataset.paired).toBe("true");
    expect(popup.document.body.dataset.warn).toBe("false");
    expect(popup.text("gateway")).toBe("https://gateway.example.com · v0.4.5");
    expect(popup.text("queue")).toBe("0");
    expect(popup.text("last-sync")).toBe("—");
    expect(popup.text("last-checked")).toBe("3m ago");
    expect(popup.text("paired-since")).toBe(
      new Date(TEST_PAIRING.pairedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    expect(popup.text("scope")).toBe("Yes");
    expect(popup.text("warn")).toBe("");
    expect(popup.$("ack-warning").hidden).toBe(true);
  });

  it("warns when the gateway is behind the extension's minor version", async () => {
    const popup = openPopup(
      pairedStorage({
        [PAIRING_KEY]: JSON.stringify({ ...TEST_PAIRING, gatewayVersion: "0.4.5" }),
      }),
      (chrome) => {
        chrome.manifestVersion = "0.5.0";
      },
    );
    await waitForState(popup, "ready");
    expect(popup.text("warn")).toBe(
      "This gateway (0.4.5) is behind this extension (0.5.0). Update the gateway.",
    );
    expect(popup.document.body.dataset.warn).toBe("true");
  });

  it("reads not-syncing with a re-pair warning when the gateway rejects pages", async () => {
    const popup = openPopup(
      pairedStorage({
        "omnesis.push.health.v1": JSON.stringify({
          ok: false,
          reason: "token lacks write:web",
          at: T0 - 1000,
        }),
      }),
    );
    await waitForState(popup, "not-syncing");
    expect(popup.state().label).toBe("Not syncing");
    expect(popup.text("warn")).toBe(
      "Pages are being rejected by the gateway: token lacks write:web. Re-pair this browser to refresh its token.",
    );
    expect(popup.document.body.dataset.warn).toBe("true");
    expect(popup.document.body.dataset.notice).toBe("false");
    expect(popup.$("ack-warning").hidden).toBe(true);
  });

  it("reads not-syncing while the capture settings have not been loaded", async () => {
    const popup = openPopup(pairedStorage({ [CAPTURE_POLICY_KEY]: "" }));
    await waitForState(popup, "not-syncing");
    expect(popup.text("warn")).toContain("Capture settings have not been loaded");
  });

  it("reads syncing while uploads are pending", async () => {
    const popup = openPopup(
      pairedStorage({
        "omnesis.push.queue.v1": JSON.stringify([
          {
            id: "doc:1",
            kind: "document",
            attempts: 0,
            notBefore: 0,
            enqueuedAt: T0,
            doc: {
              providerId: "web",
              sourceId: "web",
              externalId: "a".repeat(64),
              title: "Pending page",
              content: "Fictional body",
              contentHash: "b".repeat(64),
              metadata: {},
              sourceCreatedAt: "2026-01-01T00:00:00.000Z",
              sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ]),
      }),
    );
    await waitForState(popup, "syncing");
    expect(popup.text("queue")).toBe("1");
  });

  it("shows a dismissible past-loss notice without claiming sync is broken", async () => {
    const popup = openPopup(
      pairedStorage({
        "omnesis.push.failure.v1": JSON.stringify({
          reason: "page too large",
          status: 413,
          kind: "document",
          at: T0 - 5000,
          count: 2,
        }),
      }),
    );
    await waitForState(popup, "ready");
    expect(popup.document.body.dataset.notice).toBe("true");
    expect(popup.$("ack-warning").hidden).toBe(false);
    expect(popup.text("warn")).toBe("2 page uploads were discarded: page too large.");

    popup.chrome.respond = (message) => {
      if (message.type === "dismiss-diagnostics")
        delete popup.chrome.storage["omnesis.push.failure.v1"];
      return { ok: true };
    };
    click(popup, popup.$("ack-warning"));
    await vi.waitFor(() => expect(popup.chrome.sent("dismiss-diagnostics")).toHaveLength(1));
    await vi.waitFor(() => expect(popup.$("ack-warning").hidden).toBe(true));
    expect(popup.text("warn")).toBe("");
  });

  it("reports a failed background check without hiding the cached state", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      // The worker's verdict lands after the cached render, as a real probe
      // round-trip does.
      chrome.respond = (message) =>
        message.type === "check-now"
          ? new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, reason: "worker asleep" }), 50),
            )
          : { ok: true };
    });
    await waitForState(popup, "check-failed");
    expect(popup.state().label).toBe("Check failed");
    expect(popup.text("warn")).toBe(
      "The extension background check failed. Reload this extension from chrome://extensions.",
    );
    expect(popup.text("gateway")).toBe("https://gateway.example.com");
  });

  it("opens the options page from its button", async () => {
    const popup = openPopup({});
    await waitForState(popup, "unpaired");
    click(popup, popup.$("open-options"));
    expect(popup.chrome.openOptionsPage.calls).toBe(1);
  });
});

describe("popup — shared pause controls", () => {
  it("offers the three pause durations and sends each as a set-pause", async () => {
    const popup = openPopup(pairedStorage());
    await waitForState(popup, "ready");
    expect(popup.$("controls").hidden).toBe(false);
    expect(popup.$("controls").querySelector(".controls-label")?.textContent).toBe(
      "Pause capture in every paired browser",
    );
    const chips = chipButtons(popup);
    expect(chips.map((chip) => chip.textContent)).toEqual(["1 hour", "1 day", "Until I resume"]);

    // The deadline is computed from the clock at render time, so it is checked
    // against the window between load and now rather than one exact instant.
    const withinWindow = (until: unknown, duration: number): void => {
      expect(typeof until).toBe("number");
      expect((until as number) - duration).toBeGreaterThanOrEqual(T0);
      expect((until as number) - duration).toBeLessThanOrEqual(Date.now());
    };
    click(popup, chips[0]);
    click(popup, chips[1]);
    click(popup, chips[2]);
    await vi.waitFor(() => expect(popup.chrome.sent("set-pause")).toHaveLength(3));
    const [hour, day, open] = popup.chrome.sent("set-pause");
    withinWindow(hour.until, PAUSE_ONE_HOUR_MS);
    withinWindow(day.until, PAUSE_ONE_DAY_MS);
    expect(open).toEqual({ type: "set-pause", until: null });
  });

  it("renders a timed pause with its countdown and a resume control", async () => {
    const popup = openPopup(
      pairedStorage({
        [CAPTURE_POLICY_KEY]: cachedPolicy(policyBody({ pause: { until: T0 + 30 * 60_000 } })),
      }),
    );
    await waitForState(popup, "paused");
    expect(popup.state().label).toBe("Paused");
    expect(popup.document.body.dataset.paused).toBe("true");
    expect(popup.$("controls").querySelector(".pause-line")?.textContent).toBe(
      "Capture paused in every paired browser — resumes in 30m",
    );
    const [resume] = chipButtons(popup);
    expect(resume.textContent).toBe("Resume capturing");

    popup.chrome.respond = (message) => {
      if (message.type === "resume") popup.chrome.storage[CAPTURE_POLICY_KEY] = cachedPolicy();
      return { ok: true };
    };
    click(popup, resume);
    await vi.waitFor(() => expect(popup.chrome.sent("resume")).toEqual([{ type: "resume" }]));
    await waitForState(popup, "ready");
  });

  it("renders an open-ended pause without a countdown", async () => {
    const popup = openPopup(
      pairedStorage({ [CAPTURE_POLICY_KEY]: cachedPolicy(policyBody({ pause: { until: null } })) }),
    );
    await waitForState(popup, "paused");
    expect(popup.$("controls").querySelector(".pause-line")?.textContent).toBe(
      "Capture paused in every paired browser",
    );
  });

  it("reports a refused control instead of pretending it applied", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.respond = (message) =>
        message.type === "set-pause" ? { ok: false, reason: "gateway refused" } : { ok: true };
    });
    await waitForState(popup, "ready");
    click(popup, chipButtons(popup)[2]);
    await waitForState(popup, "control-failed");
    expect(popup.state().label).toBe("Control failed");
    expect(popup.text("warn")).toBe(
      "The capture control did not reach the extension background worker. Reload the extension and try again.",
    );
    expect(popup.document.body.dataset.warn).toBe("true");
  });
});

describe("popup — current page and the exclude control", () => {
  it("offers to exclude the watched site and sends the host as plain text", async () => {
    const popup = openPopup(pairedStorage());
    await waitForState(popup, "ready");
    await vi.waitFor(() => expect(popup.text("current-page")).toBe("Attached (5s dwell)"));
    expect(popup.$("current-page").dataset.state).toBe("watching");
    expect(popup.$("exclude-wrap").hidden).toBe(false);
    const button = popup.$("exclude-site") as HTMLButtonElement;
    expect(button.textContent).toBe("Exclude news.example.com");
    expect(button.childElementCount).toBe(0);
    expect(button.disabled).toBe(false);

    let resolveAck: ((ack: unknown) => void) | undefined;
    popup.chrome.respond = (message) =>
      message.type === "add-excluded-domain"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : { ok: true };
    click(popup, button);
    await vi.waitFor(() =>
      expect(popup.chrome.sent("add-excluded-domain")).toEqual([
        { type: "add-excluded-domain", input: "news.example.com" },
      ]),
    );
    // The button stays disabled until the worker answers, so a double click
    // cannot send the exclusion twice.
    expect(button.disabled).toBe(true);
    popup.chrome.tabStatus = { state: "excluded", reason: "excluded-domain" };
    resolveAck?.({ ok: true, purged: 0 });
    // The click keeps a visible result: the button is replaced in place by a
    // line naming the domain, and the page itself names the setting that now
    // applies once it has been judged again.
    await vi.waitFor(() =>
      expect(popup.text("exclude-done")).toBe("news.example.com is excluded."),
    );
    expect(popup.$("exclude-wrap").hidden).toBe(false);
    expect(popup.$("exclude-done").hidden).toBe(false);
    expect(button.hidden).toBe(true);
    await vi.waitFor(() =>
      expect(popup.text("current-page")).toBe("Excluded — this site is on your list"),
    );
  });

  it("offers the new host when the tab moves on before the exclusion is acknowledged", async () => {
    const popup = openPopup(pairedStorage());
    await vi.waitFor(() =>
      expect((popup.$("exclude-site") as HTMLButtonElement).textContent).toBe(
        "Exclude news.example.com",
      ),
    );
    let resolveAck: ((ack: unknown) => void) | undefined;
    popup.chrome.respond = (message) =>
      message.type === "add-excluded-domain"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : { ok: true };
    click(popup, popup.$("exclude-site") as HTMLButtonElement);
    await vi.waitFor(() => expect(popup.chrome.sent("add-excluded-domain")).toHaveLength(1));

    // The tab navigated while the worker was answering; the confirmation names
    // a host this popup is no longer about, so it gives way to the new one.
    popup.chrome.activeTab = { id: 7, url: "https://journal.example.org/entry" };
    popup.chrome.tabStatus = { state: "watching" };
    resolveAck?.({ ok: true, purged: 0 });
    await vi.waitFor(() =>
      expect((popup.$("exclude-site") as HTMLButtonElement).textContent).toBe(
        "Exclude journal.example.org",
      ),
    );
    expect(popup.$("exclude-done").hidden).toBe(true);
    expect((popup.$("exclude-site") as HTMLButtonElement).hidden).toBe(false);
  });

  // The capture settings are shared, so a page can be excluded by a decision
  // made in another browser; the popup names which one rather than leaving it
  // to be guessed.
  it.each([
    ["excluded-domain", "Excluded — this site is on your list"],
    ["owned-domain", "Covered by another source"],
    ["skipped-path", "Sign-in or payment page"],
    ["password-field", "Password field on this page"],
    ["paused", "Capture paused"],
    ["removed-page", "Deleted from your index"],
    ["gateway-host", "This is your Omnesis gateway"],
    ["invalid-url", "Not eligible"],
    ["unpaired", "Not paired"],
  ] as const)("names %s as the setting that excludes the page", async (reason, label) => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.tabStatus = { state: "excluded", reason };
    });
    await vi.waitFor(() => expect(popup.text("current-page")).toBe(label));
    // An excluded page offers no exclude button; there is nothing to add.
    expect(popup.$("exclude-wrap").hidden).toBe(true);
  });

  it("falls back to the general wording for a reason it does not recognize", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      // An older content script left in a tab across an extension update can
      // report a reason this build has no wording for.
      chrome.tabStatus = { state: "excluded", reason: "from-a-later-build" } as never;
    });
    await vi.waitFor(() => expect(popup.text("current-page")).toBe("Excluded by capture settings"));
  });

  it("re-enables the exclude control and names the failure when the worker refuses", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.respond = (message) =>
        message.type === "add-excluded-domain"
          ? { ok: false, reason: "Not a valid domain" }
          : { ok: true };
    });
    await waitForState(popup, "ready");
    await vi.waitFor(() => expect(popup.$("exclude-wrap").hidden).toBe(false));
    const button = popup.$("exclude-site") as HTMLButtonElement;
    click(popup, button);
    await vi.waitFor(() =>
      expect(popup.text("warn")).toBe("Could not exclude news.example.com: Not a valid domain"),
    );
    expect(button.disabled).toBe(false);
    expect(popup.document.body.dataset.warn).toBe("true");
  });

  it("tells the user to reload an open page the extension is not attached to", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.tabStatus = new Error("Could not establish connection. Receiving end does not exist.");
    });
    await waitForState(popup, "not-capturing");
    expect(popup.state().label).toBe("Not capturing");
    expect(popup.text("current-page")).toBe("Not watched — reload page");
    expect(popup.text("warn")).toBe(
      "Omnesis is not watching this already-open page. Reload the page to attach capture.",
    );
    // The reload offer still lets the user exclude the site.
    expect(popup.$("exclude-wrap").hidden).toBe(false);
    expect(popup.$("ack-warning").hidden).toBe(true);
  });

  it("does not offer to exclude a page the extension cannot capture", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.activeTab = { id: 7, url: "chrome://extensions" };
    });
    await waitForState(popup, "ready");
    await vi.waitFor(() => expect(popup.text("current-page")).toBe("Not eligible"));
    expect(popup.$("exclude-wrap").hidden).toBe(true);
  });

  it("names missing HTTPS access instead of judging the page", async () => {
    const popup = openPopup(pairedStorage(), (chrome) => {
      chrome.contentScriptRegistered = false;
    });
    await waitForState(popup, "not-syncing");
    await vi.waitFor(() => expect(popup.text("current-page")).toBe("Access not granted"));
    expect(popup.text("warn")).toMatch(
      /^chrome is not allowing omnesis to watch https pages\. open pairing settings and grant https page access\.$/i,
    );
    expect(popup.$("exclude-wrap").hidden).toBe(true);
  });
});

describe("popup — recently synced pages", () => {
  it("lists documents newest first as plain text, capped at twelve of the total", async () => {
    const recent = Array.from({ length: 15 }, (_, index) => ({
      kind: "document",
      title: index === 0 ? "<b>Fictional</b> & <i>untrusted</i> title" : `Fictional page ${index}`,
      url: `https://news.example.com/story-${index}`,
      at: T0 - (index + 1) * 60_000,
    }));
    const popup = openPopup(pairedStorage({ "omnesis.push.recent.v1": JSON.stringify(recent) }));
    await waitForState(popup, "ready");
    expect(popup.$("recent-wrap").hidden).toBe(false);
    expect(popup.text("recent-count")).toBe("(15)");
    const items = [...popup.$("recent-list").querySelectorAll("li")];
    expect(items).toHaveLength(12);
    const first = items[0].querySelector(".recent-title") as HTMLElement;
    expect(first.textContent).toBe("<b>Fictional</b> & <i>untrusted</i> title");
    expect(first.childElementCount).toBe(0);
    expect(first.getAttribute("title")).toBe("https://news.example.com/story-0");
    expect(items[0].querySelector(".recent-when")?.textContent).toBe("1m ago");
    expect(items[11].querySelector(".recent-when")?.textContent).toBe("12m ago");
    expect(popup.text("last-sync")).toBe("1m ago");
  });

  it("falls back to the URL for an untitled page and hides the list when empty", async () => {
    const popup = openPopup(
      pairedStorage({
        "omnesis.push.recent.v1": JSON.stringify([
          { kind: "document", title: "", url: "https://news.example.com/untitled", at: T0 },
        ]),
      }),
    );
    await waitForState(popup, "ready");
    expect(popup.$("recent-list").querySelector(".recent-title")?.textContent).toBe(
      "https://news.example.com/untitled",
    );
    expect(popup.text("last-sync")).toBe("just now");

    const empty = openPopup(pairedStorage());
    await waitForState(empty, "ready");
    expect(empty.$("recent-wrap").hidden).toBe(true);
  });
});
