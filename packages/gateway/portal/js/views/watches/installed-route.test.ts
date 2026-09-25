// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// One watch's screen mounted, with its effects and state running, rather than
// as an expanded VNode tree. What is under test here is what only a real mount
// can show: that the screen's two independent reads — what the runtime caught,
// and what the record that authorises its egress actually sent — each settle on
// their own, in any order, and that neither can leave the other waiting.
//
// All fixture data is invented.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api.js", () => ({
  deleteWatchV2Watch: vi.fn(),
  getWatchV2Watch: vi.fn(),
  listPrivacySubscriptionFirings: vi.fn(),
  listWatchV2Firings: vi.fn(),
  purgePrivacySubscription: vi.fn(),
  revokePrivacySubscription: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { listPrivacySubscriptionFirings, listWatchV2Firings } from "../../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { InstalledWatchRoute } from "./installed.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DISCLOSURE = {
  authoredBy: "integration",
  subscriptionId: "subscription-example",
  status: "active",
  integrationName: "Fictional OpenClaw integration",
  revision: 1,
  interpretation: "A supplier says a shipment will be late",
  instruction: "Draft a reply asking for a revised date",
  approval: { status: "approved" },
  expiresAt: 1_800_000_000_000,
  revokedAt: null,
  policyRevision: "policy-revision-example",
  firingCount: 1,
};

const WATCH = {
  id: "watch-shipment-example",
  name: "shipment-delay",
  status: "active",
  request: "tell me when a supplier says a shipment will be late",
  firings: 1,
  addedAt: "2026-05-01T09:00:00.000Z",
  fromSeq: 4210,
  disclosure: DISCLOSURE,
};

const CAUGHT = {
  seq: 41,
  firedAt: "2026-05-04T09:15:00.000Z",
  noticedAt: "2026-05-04T09:15:01.000Z",
  documents: [],
  delivery: { kind: "agent-wake", delivered: 1 },
};

const SENT = {
  id: "sf-41",
  subscriptionId: "subscription-example",
  seq: 41,
  createdAt: 1_777_000_000_000,
  deliveryStatus: "delivered",
};

/** A promise plus the handle that settles it, so a test can choose the order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("one watch's screen, mounted", () => {
  let host: HTMLElement;
  let doc: Document;
  let win: Window;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    doc = parsed.document as unknown as Document;
    win = parsed.window as unknown as Window;
    Object.assign(globalThis, { document: doc, window: win });
    host = doc.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

  /**
   * Drain the microtask queue and let preact re-render. A read settles through
   * a `then`/`catch`/`finally` chain, so its loading flag clears a tick after
   * its data lands — flushing once would sample the screen in between.
   */
  async function settle() {
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  }

  async function mount(watch: unknown = WATCH) {
    await act(async () => {
      render(h(InstalledWatchRoute as any, { watch }), host);
    });
    await settle();
  }

  /**
   * The two reads start together on mount. Each has to be able to settle
   * without the other's start discarding its result — a guard that discarded a
   * read it did not belong to would leave this screen waiting on a response it
   * had already thrown away, for as long as it stayed open.
   */
  test("both reads settle whichever order they land in", async () => {
    for (const egressFirst of [true, false]) {
      const caught = deferred<unknown>();
      const sent = deferred<unknown>();
      (listWatchV2Firings as any).mockReturnValue(caught.promise);
      (listPrivacySubscriptionFirings as any).mockReturnValue(sent.promise);

      await mount();
      expect(text()).toContain("Loading firings…");

      const order = egressFirst
        ? [() => sent.resolve({ firings: [SENT] }), () => caught.resolve({ firings: [CAUGHT] })]
        : [() => caught.resolve({ firings: [CAUGHT] }), () => sent.resolve({ firings: [SENT] })];
      for (const step of order) {
        step();
        await settle();
      }

      expect(text(), `egress first: ${egressFirst}`).not.toContain("Loading firings…");
      // One firing, both halves: the runtime's own link and the egress record's.
      expect(host.querySelectorAll(".privacy-subscription-firing-row")).toHaveLength(1);
      const links = [...host.querySelectorAll("a")].map((node) => node.textContent?.trim());
      expect(links).toContain("debug");
      expect(links).toContain("audit");

      render(null, host);
    }
  });

  /**
   * A failed read of one half may never be reported as the other half being
   * empty: a short ledger presented as a whole one, with a count that agrees
   * with it, is the one way this screen can lie.
   */
  test("a failed egress read is stated rather than shown as nothing sent", async () => {
    (listWatchV2Firings as any).mockResolvedValue({ firings: [] });
    (listPrivacySubscriptionFirings as any).mockRejectedValue(
      new Error("Firing history is unavailable."),
    );

    await mount();

    expect(text()).toContain("Firing history is unavailable.");
    expect(text()).not.toContain("This watch has not fired.");
  });

  test("a failed runtime read is stated rather than hidden behind what was sent", async () => {
    (listWatchV2Firings as any).mockRejectedValue(new Error("The runtime is not up."));
    (listPrivacySubscriptionFirings as any).mockResolvedValue({ firings: [SENT] });

    await mount();

    expect(text()).toContain("The runtime is not up.");
    // The half that did arrive still renders beside the error.
    expect(host.querySelectorAll(".privacy-subscription-firing-row")).toHaveLength(1);
  });

  /**
   * A wake's instruction names things the agent cannot resolve on its own, and
   * the referents are what resolve them. They belong on the screen that says
   * what this watch discloses — the operator approved a wake at *these* things,
   * and the instruction alone does not say which.
   */
  test("shows the referents a wake hands over, where it says what it discloses", async () => {
    (listWatchV2Firings as any).mockResolvedValue({ firings: [] });
    (listPrivacySubscriptionFirings as any).mockResolvedValue({ firings: [] });

    await mount({
      ...WATCH,
      dsl: {
        watch: {
          name: "shipment-delay",
          delivery: {
            kind: "agent-wake",
            integration: "openclaw",
            instruction: "Draft a reply asking for a revised date",
            bindings: { conversation: "thread-8821" },
          },
        },
      },
    });

    expect(text()).toContain("What it tells an integration");
    expect(text()).toContain("conversation");
    expect(text()).toContain("thread-8821");
  });

  /**
   * A watch that wakes nobody has no second read to make, and must not wait on
   * one that never starts.
   */
  test("a watch with no record settles on the runtime read alone", async () => {
    (listWatchV2Firings as any).mockResolvedValue({ firings: [CAUGHT] });

    await mount({ ...WATCH, disclosure: null });

    expect(listPrivacySubscriptionFirings).not.toHaveBeenCalled();
    expect(text()).not.toContain("Loading firings…");
    expect(host.querySelectorAll(".privacy-subscription-firing-row")).toHaveLength(1);
  });
});
