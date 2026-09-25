// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createLookupDocumentByUrlTool } from "./lookup-document-by-url.js";
import type { DocumentByUrlPort, DocumentByUrlPortResult } from "./types.js";

const ctx = { sessionId: "s", messageId: "m" };

function makePort(over: Partial<DocumentByUrlPort> = {}): DocumentByUrlPort {
  return {
    async lookup(url: string): Promise<DocumentByUrlPortResult> {
      return {
        url,
        durationMs: 9,
        ref: {
          documentId: "doc-1",
          sourceType: "google-drive",
          sourceId: "google-drive:self",
          documentType: "file",
          title: "Vendor evaluation matrix",
          ts: 1_757_237_400_000,
          url,
        },
      };
    },
    ...over,
  };
}

describe("createLookupDocumentByUrlTool", () => {
  it("returns a document.byUrl result with the resolved ref", async () => {
    const tool = createLookupDocumentByUrlTool({ port: makePort() });
    const out = await tool.invoke({ url: "https://drive.google.com/file/d/abc/view" }, ctx);
    expect(out.kind).toBe("document.byUrl");
    if (out.kind === "document.byUrl") {
      expect(out.url).toBe("https://drive.google.com/file/d/abc/view");
      expect(out.durationMs).toBe(9);
      expect(out.ref?.documentId).toBe("doc-1");
      expect(out.ref?.sourceType).toBe("google-drive");
    }
  });

  it("returns document.byUrl with no ref on a miss (not an error)", async () => {
    const tool = createLookupDocumentByUrlTool({
      port: {
        async lookup(url) {
          return { url, durationMs: 3 };
        },
      },
    });
    const out = await tool.invoke({ url: "https://example.com/none" }, ctx);
    expect(out.kind).toBe("document.byUrl");
    if (out.kind === "document.byUrl") {
      expect(out.ref).toBeUndefined();
    }
  });

  it("rejects an empty url with invalid_args", async () => {
    const tool = createLookupDocumentByUrlTool({ port: makePort() });
    const out = await tool.invoke({ url: "" }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("invalid_args");
  });

  it("rejects a whitespace-only url with invalid_args", async () => {
    const tool = createLookupDocumentByUrlTool({ port: makePort() });
    const out = await tool.invoke({ url: "   \t  " }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("invalid_args");
  });

  it("surfaces port failures as lookup_failed errors", async () => {
    const tool = createLookupDocumentByUrlTool({
      port: {
        async lookup() {
          throw new Error("boom");
        },
      },
    });
    const out = await tool.invoke({ url: "https://x.com" }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("lookup_failed");
      expect(out.message).toBe("boom");
    }
  });

  it("passes the url to the port with tracking params intact (gateway canonicalises)", async () => {
    let received = "";
    const tool = createLookupDocumentByUrlTool({
      port: {
        async lookup(url) {
          received = url;
          return { url, durationMs: 0 };
        },
      },
    });
    // Tracking params + fragment kept — the gateway port handles
    // canonicalisation; the tool just relays.
    const raw = "https://docs.google.com/document/d/abc/edit?usp=sharing#heading=h.foo";
    await tool.invoke({ url: raw }, ctx);
    expect(received).toBe(raw);
    // Prove the tracking params survived the tool boundary specifically.
    expect(received).toContain("usp=sharing");
    expect(received).toContain("#heading=h.foo");
  });
});
