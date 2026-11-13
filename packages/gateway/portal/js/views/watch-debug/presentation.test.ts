// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it } from "vitest";
// @ts-expect-error — portal is plain JavaScript.
import { Delivery } from "./history.js";
// @ts-expect-error — portal is plain JavaScript.
import { WatchRawJson } from "./pane.js";

let host: HTMLElement;
let originalDocument: typeof globalThis.document | undefined;
beforeEach(() => {
  originalDocument = globalThis.document;
  const { document } = parseHTML("<html><body><main></main></body></html>");
  globalThis.document = document as unknown as Document;
  host = globalThis.document.querySelector("main")!;
});
afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else globalThis.document = originalDocument;
});

it("opens raw JSON for inspection and keeps source characters intact", () => {
  const value = { count: 2, ready: true, text: "<script>example</script>" };
  render(h(WatchRawJson, { value }), host);
  expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
  expect(host.querySelector("pre")?.textContent).toBe(JSON.stringify(value, null, 2));
  expect(host.querySelectorAll(".cm-tok-property")).toHaveLength(3);
  expect(host.querySelector("script")).toBeNull();
});

it("presents both successful delivery channels as rows with an optional agent audit link", () => {
  const auditHref = "/portal/watches/sub-example/firings/firing-example";
  for (const [kind, text] of [["agent-wake", "Woke an agent"], ["omnesis-notify", "Notified your devices"]]) {
    render(h(Delivery, { delivery: { kind, attempted: 1, delivered: 1 }, auditHref }), host);
    expect(host.querySelector("dt")?.textContent).toBe("Delivery");
    expect(host.querySelector("dd")?.textContent).toBe(text);
    expect(host.querySelector(".privacy-item-status")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href") ?? null).toBe(kind === "agent-wake" ? auditHref : null);
  }
});

it("keeps missing audit records unlinked and retains delivery errors", () => {
  render(h(Delivery, { delivery: { kind: "agent-wake", delivered: 1 } }), host);
  expect(host.textContent).toContain("Woke an agent");
  expect(host.querySelector("a")).toBeNull();
  render(h(Delivery, { delivery: { kind: "agent-wake", delivered: 0, error: "Connection unavailable" }, auditHref: "/unused" }), host);
  expect(host.textContent).toContain("Not delivered");
  expect(host.textContent).toContain("Connection unavailable");
  expect(host.querySelector("a")).toBeNull();
});
