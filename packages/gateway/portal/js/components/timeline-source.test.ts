// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — the portal renderer is plain JavaScript.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => ({ navigate: mocks.navigate }));
import { TimelineColumn } from "./timeline.js";

let host;
let originalDocument;
let originalWindow;
const documentRef = {
  documentId: "doc-example",
  title: "Project outline",
  sourceId: "example-files:account",
  sourceUrl: "https://example.org/documents/outline",
};
function mount(doc = documentRef, attachments = []) {
  render(h(TimelineColumn, {
    events: [{ at: "2026-06-05T10:00:00Z", kind: "document", doc, attachments, people: [] }],
  }), host);
}
beforeEach(() => {
  vi.clearAllMocks();
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#host");
});
afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

describe("timeline source action", () => {
  test("keeps the title inside Omnesis and exposes a separate accessible source link", () => {
    mount();
    const title = host.querySelector("a.graph-debug-event-doc");
    const source = host.querySelector("a.graph-debug-event-source");
    expect(title.getAttribute("href")).toBe("/portal/doc/doc-example");
    expect(source.parentNode).toBe(title.parentNode);
    expect(source.getAttribute("href")).toBe(documentRef.sourceUrl);
    expect(source.getAttribute("aria-label")).toBe(`Open ${documentRef.title} in source`);
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toBe("noopener noreferrer");
    title.click();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/portal/doc/doc-example");
    mocks.navigate.mockClear();
    source.click();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test.each([undefined, "", "not a URL", "https://", "https://exa mple.org", "javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/example", "about:blank"])("omits the icon for unavailable or invalid source URL %s", (sourceUrl) => {
    mount({ ...documentRef, sourceUrl });
    expect(host.querySelector(".graph-debug-event-source")).toBeNull();
    expect(host.querySelector("a.graph-debug-event-doc")).not.toBeNull();
  });

  test("accepts provider-declared app schemes and adds an independent attachment action", () => {
    mount({ ...documentRef, sourceUrl: "things:///show?id=example-task" }, [{
      kind: "attachment",
      doc: { ...documentRef, documentId: "doc-attachment", title: "Outline.pdf", documentType: "attachment" },
      people: [],
    }]);
    const links = [...host.querySelectorAll(".graph-debug-event-source")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "things:///show?id=example-task", documentRef.sourceUrl,
    ]);
    expect(host.querySelector(".graph-debug-event-child .graph-debug-event-doc").getAttribute("href")).toBe("/portal/doc/doc-attachment");
  });

  test("leaves record-only citations without a fabricated source action", () => {
    render(h(TimelineColumn, {
      events: [{ at: null, kind: "record", record: { recordKey: "record-example", title: "Activity total", sourceId: "example-activity:account" } }],
    }), host);
    expect(host.querySelector(".graph-debug-event-source")).toBeNull();
  });
});
