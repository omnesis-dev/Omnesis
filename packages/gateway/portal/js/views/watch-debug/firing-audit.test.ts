// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api.js", () => ({ listPrivacySubscriptionFirings: vi.fn() }));
// @ts-expect-error — portal modules are plain JS.
import { listPrivacySubscriptionFirings } from "../../api.js";
// @ts-expect-error — portal modules are plain JS.
import { useWatchFiringAuditHref, watchFiringAuditHref } from "./firing-audit.js";

const path = { seq: -2, firings: [{ nodeId: "scheduled", keyHash: "instance" }] };
const watch = { id: "watch-example", disclosure: { subscriptionId: "subscription-example" } };
const sent = { id: "firing-example", watchId: watch.id, seq: path.seq };
const href = "/portal/watches/subscription-example/firings/firing-example";

describe("firing audit identity", () => {
  test("links one runtime firing to one matching egress record, including negative sequences", () => {
    expect(watchFiringAuditHref(watch.id, watch.disclosure.subscriptionId, path, [sent])).toBe(href);
  });

  test("does not guess among multiple runtime or egress firings", () => {
    expect(watchFiringAuditHref(watch.id, watch.disclosure.subscriptionId,
      { ...path, firings: [...path.firings, ...path.firings] }, [sent])).toBeNull();
    expect(watchFiringAuditHref(watch.id, watch.disclosure.subscriptionId,
      path, [sent, { ...sent, id: "firing-other" }])).toBeNull();
  });

  test("does not link another watch, another event, missing identity, or an absent ledger row", () => {
    for (const rows of [[], [{ ...sent, watchId: "watch-other" }], [{ ...sent, seq: 2 }],
      [{ ...sent, id: "" }], [{ id: sent.id }]]) {
      expect(watchFiringAuditHref(watch.id, watch.disclosure.subscriptionId, path, rows)).toBeNull();
    }
    expect(watchFiringAuditHref(watch.id, null, path, [sent])).toBeNull();
    expect(watchFiringAuditHref(watch.id, watch.disclosure.subscriptionId, null, [sent])).toBeNull();
  });
});

describe("optional firing audit read", () => {
  let host: HTMLElement;
  let oldDocument: typeof globalThis.document | undefined;
  let oldWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    oldDocument = globalThis.document;
    oldWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (oldDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = oldWindow;
  });

  function Probe({ value }: { value: typeof watch }) {
    const link = useWatchFiringAuditHref(value, path);
    return h("span", null, link ?? "none");
  }

  async function show(value = watch) {
    await act(async () => { render(h(Probe, { value }), host); });
  }

  test("exposes the known audit after loading and tolerates a failed read", async () => {
    listPrivacySubscriptionFirings.mockResolvedValue({ firings: [sent] });
    await show();
    expect(host.textContent).toBe(href);
    listPrivacySubscriptionFirings.mockRejectedValue(new Error("unavailable"));
    await show({ ...watch, id: "watch-unavailable" });
    expect(host.textContent).toBe("none");
  });

  test("discards a response from a previously selected watch", async () => {
    let finish!: (payload: unknown) => void;
    listPrivacySubscriptionFirings.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await show();
    const other = { id: "watch-other", disclosure: { subscriptionId: "subscription-other" } };
    listPrivacySubscriptionFirings.mockResolvedValue({ firings: [{ ...sent, watchId: other.id, id: "other" }] });
    await show(other);
    expect(host.textContent).toBe("/portal/watches/subscription-other/firings/other");
    await act(async () => { finish({ firings: [sent] }); });
    expect(host.textContent).toBe("/portal/watches/subscription-other/firings/other");
  });

  test("does not read a ledger without a disclosure", async () => {
    await show({ id: watch.id, disclosure: { subscriptionId: "" } });
    expect(listPrivacySubscriptionFirings).not.toHaveBeenCalled();
    expect(host.textContent).toBe("none");
  });
});
