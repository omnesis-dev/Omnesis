// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { docHref, isExternalDocHref, isOpenableExternalUrl, loadSourceMeta, sourceIconResolves, sourceIcon, sourceIconUrl } from "./format.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

// loadSourceMeta pulls /portal/source-meta.json (synced map) and
// /admin/source-descriptors (provider descriptors). Route by URL so each
// test seeds the module-private _metaCache deterministically.
function mockMetaFetch(syncedMeta: Record<string, unknown>, descriptorItems: unknown[]) {
  return async (url: string) => {
    if (typeof url === "string" && url.includes("source-meta.json")) {
      return { ok: true, json: async () => syncedMeta };
    }
    if (typeof url === "string" && url.includes("/admin/source-descriptors")) {
      return { ok: true, json: async () => ({ items: descriptorItems }) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

describe("isOpenableExternalUrl", () => {
  it("accepts http(s) and custom deep-link schemes", () => {
    expect(isOpenableExternalUrl("https://example.com/a")).toBe(true);
    expect(isOpenableExternalUrl("http://example.com")).toBe(true);
    expect(isOpenableExternalUrl("things:///show?id=abc")).toBe(true);
    expect(isOpenableExternalUrl("notion://page/123")).toBe(true);
  });

  it("rejects empty, schemeless, and blocked schemes", () => {
    expect(isOpenableExternalUrl("")).toBe(false);
    expect(isOpenableExternalUrl(null)).toBe(false);
    expect(isOpenableExternalUrl(undefined)).toBe(false);
    expect(isOpenableExternalUrl("not a url")).toBe(false);
    expect(isOpenableExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("data:text/html,hi")).toBe(false);
    expect(isOpenableExternalUrl("about:blank")).toBe(false);
  });
});

describe("docHref — indexed documents always resolve to the in-app viewer", () => {
  it("routes an indexed doc to /portal/doc/:id even when it has a source URL", () => {
    expect(docHref({ documentId: "doc-1", sourceUrl: "https://mail.example.com/x" }))
      .toBe("/portal/doc/doc-1");
  });

  it("routes an indexed doc with no URL to /portal/doc/:id", () => {
    expect(docHref({ documentId: "doc-2" })).toBe("/portal/doc/doc-2");
  });

  it("url-encodes the document id", () => {
    expect(docHref({ documentId: "a/b c" })).toBe("/portal/doc/a%2Fb%20c");
  });

  it("falls back to the external URL only for a reference with no documentId", () => {
    expect(docHref({ sourceUrl: "https://example.com/page" })).toBe("https://example.com/page");
    expect(docHref({ url: "https://example.com/ref" })).toBe("https://example.com/ref");
  });

  it("returns null when there is neither a documentId nor an openable URL", () => {
    expect(docHref({})).toBe(null);
    expect(docHref({ sourceUrl: "file:///x" })).toBe(null);
    expect(docHref(null)).toBe(null);
  });
});

describe("isExternalDocHref — true only for non-indexed external references", () => {
  it("is false for any indexed document, regardless of its source URL", () => {
    expect(isExternalDocHref({ documentId: "doc-1", sourceUrl: "https://example.com" })).toBe(false);
    expect(isExternalDocHref({ documentId: "doc-2" })).toBe(false);
  });

  it("is true for an unresolved external reference with an openable URL", () => {
    expect(isExternalDocHref({ sourceUrl: "https://example.com" })).toBe(true);
    expect(isExternalDocHref({ url: "notion://page/1" })).toBe(true);
  });

  it("is false when the reference URL is not openable", () => {
    expect(isExternalDocHref({ sourceUrl: "file:///x" })).toBe(false);
    expect(isExternalDocHref({})).toBe(false);
  });
});

describe("sourceIconResolves — does the meta cache resolve a real icon for this source", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is false for an unknown source (no descriptor, no synced entry)", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch({}, []);
    await loadSourceMeta();
    expect(sourceIconResolves("apple-health:primary")).toBe(false);
  });

  it("is true once a descriptor with an icon is cached (type-level fallback for a full sourceId)", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch({}, [
      { id: "apple-health", name: "Apple Health", icon: { imageDataUri: PNG_DATA_URI } },
    ]);
    await loadSourceMeta();
    expect(sourceIconResolves("apple-health:primary")).toBe(true);
    expect(sourceIconResolves("apple-health")).toBe(true);
  });

  it("is false for an entry that carries only unitName/label but no icon", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch({}, [{ id: "ghost", unitName: "items" }]);
    await loadSourceMeta();
    expect(sourceIconResolves("ghost:acct")).toBe(false);
  });

  it("agrees with sourceIcon's 📄 fallback (resolves ⇒ <img>, otherwise the glyph)", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch({}, [{ id: "withicon", icon: { imageDataUri: PNG_DATA_URI } }]);
    await loadSourceMeta();
    expect(sourceIconResolves("withicon:x")).toBe(true);
    expect(sourceIcon("withicon:x")).not.toBe("📄");
    expect(sourceIconResolves("unknown:y")).toBe(false);
    expect(sourceIcon("unknown:y")).toBe("📄");
  });

  it("ignores a legacy hosted icon and keeps the CSP-safe descriptor fallback", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch(
      { "workspace-pages:account": { icon: "https://assets.example.com/icon.png" } },
      [{ id: "workspace-pages", icon: { imageDataUri: PNG_DATA_URI } }],
    );
    await loadSourceMeta();

    expect(sourceIconResolves("workspace-pages:account")).toBe(true);
    expect(sourceIconUrl("workspace-pages:account")).toBe(PNG_DATA_URI);
  });

  it("rejects protocol-relative and blob icon values from synced metadata", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch(
      {
        "workspace-pages:protocol-relative": { icon: "//assets.example.com/icon.png" },
        "workspace-pages:blob": { icon: "blob:https://example.com/stale" },
      },
      [{ id: "workspace-pages", icon: { imageDataUri: PNG_DATA_URI } }],
    );
    await loadSourceMeta();

    expect(sourceIconUrl("workspace-pages:protocol-relative")).toBe(PNG_DATA_URI);
    expect(sourceIconUrl("workspace-pages:blob")).toBe(PNG_DATA_URI);
  });

  it("rejects descriptor imageDataUri values outside the portal image contract", async () => {
    // @ts-expect-error — minimal fetch stub for the meta loader.
    globalThis.fetch = mockMetaFetch({}, [
      { id: "hosted", icon: { imageDataUri: "https://assets.example.com/icon.png" } },
      { id: "blob", icon: { imageDataUri: "blob:https://example.com/stale" } },
      { id: "svg", icon: { imageDataUri: "data:image/svg+xml;base64,PHN2Zy8+" } },
    ]);
    await loadSourceMeta();

    expect(sourceIconResolves("hosted")).toBe(false);
    expect(sourceIconResolves("blob")).toBe(false);
    expect(sourceIconResolves("svg")).toBe(false);
  });
});
