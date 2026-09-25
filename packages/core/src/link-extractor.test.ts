// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { extractLinks } from "./link-extractor.js";
import { buildCanonicalizerRegistry } from "./url-utils.js";
import type { ExtractedLink } from "./link-extractor.js";

describe("extractLinks", () => {
  test("extracts URLs from markdown content", () => {
    const links = extractLinks("See [docs](https://docs.example.com) for more.");
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("url");
    expect(links[0].rawTarget).toBe("https://docs.example.com");
    expect(links[0].normalizedTarget).toBe("https://docs.example.com/");
  });

  test("extracts bare URLs from content", () => {
    const links = extractLinks("Visit https://example.com/page for details.");
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("url");
    expect(links[0].rawTarget).toBe("https://example.com/page");
  });

  test("normalizes URLs (strips tracking params)", () => {
    const links = extractLinks("Link: https://example.com/page?utm_source=test&keep=yes");
    expect(links).toHaveLength(1);
    expect(links[0].normalizedTarget).toContain("keep=yes");
    expect(links[0].normalizedTarget).not.toContain("utm_source");
  });

  test("extracts intra-source links from metadata.extra.links", () => {
    const links = extractLinks("Some content", {
      extra: { links: ["My Note", "Another Note"] },
    });
    expect(links).toHaveLength(2);
    expect(links[0].type).toBe("references");
    expect(links[0].rawTarget).toBe("My Note");
    expect(links[0].normalizedTarget).toBe("my note");
    expect(links[1].rawTarget).toBe("Another Note");
  });

  test("extracts email thread IDs from metadata.extra.threadId", () => {
    const links = extractLinks("Email content", {
      extra: { threadId: "thread-abc123" },
    });
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("part-of-thread");
    expect(links[0].rawTarget).toBe("thread-abc123");
    expect(links[0].normalizedTarget).toBe("thread-abc123");
  });

  test("extracts email thread from conversationId when threadId absent", () => {
    const links = extractLinks("Email content", {
      extra: { conversationId: "conv-456" },
    });
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("part-of-thread");
    expect(links[0].rawTarget).toBe("conv-456");
  });

  test("prefers threadId over conversationId when both present", () => {
    const links = extractLinks("Email content", {
      extra: { threadId: "thread-1", conversationId: "conv-1" },
    });
    const threadLinks = links.filter((l) => l.type === "part-of-thread");
    expect(threadLinks).toHaveLength(1);
    expect(threadLinks[0].rawTarget).toBe("thread-1");
  });

  test("extracts mixed link types", () => {
    const links = extractLinks("See https://example.com for the doc.", {
      extra: {
        links: ["Related Note"],
        threadId: "thread-xyz",
      },
    });
    expect(links).toHaveLength(3);
    const types = links.map((l) => l.type);
    expect(types).toContain("url");
    expect(types).toContain("references");
    expect(types).toContain("part-of-thread");
  });

  test("deduplicates by (type, normalizedTarget)", () => {
    const links = extractLinks("Link: https://example.com/page\nAgain: https://example.com/page");
    expect(links).toHaveLength(1);
  });

  test("deduplicates intra-source links (case insensitive)", () => {
    const links = extractLinks("content", {
      extra: { links: ["My Note", "my note"] },
    });
    expect(links).toHaveLength(1);
  });

  test("handles empty content", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("", {})).toEqual([]);
    expect(extractLinks("", { extra: {} })).toEqual([]);
  });

  test("ignores non-string values in extra.links", () => {
    const links = extractLinks("content", {
      extra: { links: ["valid", 42, null, "", undefined, "also-valid"] as unknown as string[] },
    });
    expect(links).toHaveLength(2);
    expect(links[0].rawTarget).toBe("valid");
    expect(links[1].rawTarget).toBe("also-valid");
  });

  test("ignores non-string threadId", () => {
    const links = extractLinks("content", {
      extra: { threadId: 123 as unknown as string },
    });
    expect(links).toHaveLength(0);
  });

  test("suppresses the self-referential email-thread link when threadId == ownExternalId", () => {
    // First message in a Gmail thread: the messageId IS the threadId. Without
    // suppression this produces a doc linking to itself. The own-id guard
    // must drop it.
    const links = extractLinks(
      "First message in the thread.",
      { extra: { threadId: "msg-and-thread-1" } },
      "msg-and-thread-1",
    );
    expect(links.filter((l) => l.type === "part-of-thread")).toHaveLength(0);
  });

  test("keeps the email-thread link when threadId differs from ownExternalId", () => {
    // A reply: messageId !== threadId, so the link to the thread is real.
    const links = extractLinks("A reply.", { extra: { threadId: "thread-1" } }, "msg-2");
    const threadLinks = links.filter((l) => l.type === "part-of-thread");
    expect(threadLinks).toHaveLength(1);
    expect(threadLinks[0].normalizedTarget).toBe("thread-1");
  });

  test("suppresses the self-referential link when the conversationId fallback == ownExternalId", () => {
    // Same first-in-thread case but the source only supplies conversationId.
    const links = extractLinks(
      "First message, conversationId form.",
      { extra: { conversationId: "conv-self" } },
      "conv-self",
    );
    expect(links.filter((l) => l.type === "part-of-thread")).toHaveLength(0);
  });

  test("handles undefined metadata", () => {
    const links = extractLinks("https://example.com", undefined);
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("url");
  });

  test("extracts attachment parent link from metadata.extra.parentExternalId", () => {
    const links = extractLinks("Attachment text content", {
      extra: { parentExternalId: "msg123" },
    });
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("contains");
    expect(links[0].rawTarget).toBe("msg123");
    expect(links[0].normalizedTarget).toBe("msg123");
    expect(links[0].metadata).toEqual({ role: "attachment" });
  });

  test("ignores non-string parentExternalId", () => {
    const links = extractLinks("content", {
      extra: { parentExternalId: 42 as unknown as string },
    });
    expect(links).toHaveLength(0);
  });

  test("ignores empty parentExternalId", () => {
    const links = extractLinks("content", {
      extra: { parentExternalId: "" },
    });
    expect(links).toHaveLength(0);
  });

  test("emits one calendar-event link per iCalUID in metadata.extra.iCalUIDs", () => {
    const links = extractLinks("content", {
      extra: { iCalUIDs: ["uid-1@google.com", "uid-2@outlook.com"] },
    });
    const calLinks = links.filter((l: ExtractedLink) => l.type === "calendar-event");
    expect(calLinks).toHaveLength(2);
    expect(calLinks.map((l) => l.normalizedTarget)).toEqual([
      "uid-1@google.com",
      "uid-2@outlook.com",
    ]);
  });

  test("skips empty / non-string entries in iCalUIDs array", () => {
    const links = extractLinks("content", {
      extra: { iCalUIDs: ["uid-real", "", null, 42, "uid-other"] as unknown[] },
    });
    const calLinks = links.filter((l: ExtractedLink) => l.type === "calendar-event");
    expect(calLinks.map((l) => l.normalizedTarget)).toEqual(["uid-real", "uid-other"]);
  });

  test("non-array iCalUIDs is silently ignored", () => {
    const links = extractLinks("content", {
      extra: { iCalUIDs: "uid-string-not-array" as unknown },
    });
    expect(links.filter((l: ExtractedLink) => l.type === "calendar-event")).toHaveLength(0);
  });

  // Generic content-based phone-number extraction
  // feeding cross-document `shares-phone` links (e.g. a call-log document
  // and a webpage/email that both mention the same number).
  test("extracts a phone number mentioned in content as a shares-phone link", () => {
    const links = extractLinks("Call the front desk at +1 415 555 2671 for details.");
    const phoneLinks = links.filter((l: ExtractedLink) => l.type === "shares-phone");
    expect(phoneLinks).toHaveLength(1);
    expect(phoneLinks[0].normalizedTarget).toBe("+14155552671");
    expect(phoneLinks[0].rawTarget).toBe("+14155552671");
  });

  test("uses durable ingestion phone region for national-format links", () => {
    const links = extractLinks("Call 07700 000 000", {
      ingestionContext: { phoneRegion: "GB" },
    });
    expect(links).toContainEqual({
      type: "shares-phone",
      rawTarget: "+447700000000",
      normalizedTarget: "+447700000000",
    });
  });

  test("extracts every distinct phone number mentioned, deduplicated", () => {
    const links = extractLinks(
      "Reach sales at +1 415 555 2671 or support at +44 20 7123 4567. " +
        "Sales again: +1 415 555 2671.",
    );
    const phoneLinks = links.filter((l: ExtractedLink) => l.type === "shares-phone");
    expect(phoneLinks.map((l) => l.normalizedTarget).sort()).toEqual(
      ["+14155552671", "+442071234567"].sort(),
    );
  });

  test("does not treat arbitrary digit strings (order numbers, IDs) as phone numbers", () => {
    // No phone-shaped punctuation/prefix — libphonenumber-js's tokenizer
    // should not mistake these for numbers.
    const links = extractLinks("Order #48213908213 was placed on invoice 2026070400001.");
    expect(links.filter((l: ExtractedLink) => l.type === "shares-phone")).toHaveLength(0);
  });

  test("does not extract digit runs inside a URL's query string as a phone number", () => {
    // Confirmed against real browsing-history data: a hotel-listing photo
    // gallery URL's `modalItem=2165168311` and a marketing redirect's
    // `aud-9182458316` (an ad-network click-tracking id) both parse as
    // structurally-valid NANP numbers (216/918 are real US area codes) even
    // though they're not phone numbers — they only exist inside a URL.
    const links = extractLinks(
      "[Listing](https://example.com/rooms/12345?modal=PHOTO_TOUR&modalItem=2165168311&s=76) " +
        "and a bare one: https://ad.example.com/track?aud-9182458316&gacid-21410411210",
    );
    expect(links.filter((l: ExtractedLink) => l.type === "shares-phone")).toHaveLength(0);
    // The URLs themselves are still extracted normally.
    expect(links.filter((l: ExtractedLink) => l.type === "url")).toHaveLength(2);
  });

  test("still extracts a real phone number that appears alongside a URL in the same content", () => {
    const links = extractLinks(
      "See https://example.com/contact for details, or call +1 415 555 2671 directly.",
    );
    const phoneLinks = links.filter((l: ExtractedLink) => l.type === "shares-phone");
    expect(phoneLinks).toHaveLength(1);
    expect(phoneLinks[0].normalizedTarget).toBe("+14155552671");
  });

  test("extracts a phone number used as a tel: link's visible text (click-to-call)", () => {
    // Verified against a real customer-service email whose click-to-call
    // link's visible text was itself the phone number, `tel:`-linked.
    // `tel:` URIs have no `//`, so they're never treated as a stripped URL —
    // the digits inside one are exactly what should reach the phone scanner.
    const links = extractLinks("Call us at [1-415-555-2671](tel:+14155552671) anytime.");
    const phoneLinks = links.filter((l: ExtractedLink) => l.type === "shares-phone");
    expect(phoneLinks).toHaveLength(1);
    expect(phoneLinks[0].normalizedTarget).toBe("+14155552671");
  });

  test("extracts a phone number used as an HTTP markdown link's visible text", () => {
    // A "click to call" link whose target is a tracked HTTP(S) redirect
    // rather than a bare tel: URI — the link's TEXT (not its URL) is the
    // real phone number and must survive stripping the URL. Only the URL
    // portion is dropped, not the whole `[text](url)` construct.
    const links = extractLinks(
      "[+1 415 555 2671](https://example.com/click-to-call?tracking=2165168311) — tap to call.",
    );
    const phoneLinks = links.filter((l: ExtractedLink) => l.type === "shares-phone");
    expect(phoneLinks).toHaveLength(1);
    expect(phoneLinks[0].normalizedTarget).toBe("+14155552671");
    // The URL's own query-string digits must NOT also be extracted as a phone.
    expect(phoneLinks.map((l) => l.normalizedTarget)).not.toContain("+12165168311");
  });

  test("runs over every document's content generically, not gated by document type", () => {
    // No source-specific opt-in — extractLinks doesn't take a documentType
    // argument at all, so this is inherently true for any caller, but the
    // assertion pins the expected behavior for a plain webpage-shaped body.
    const links = extractLinks(
      "# Stellar Sound Studio\n\nBook a session — call us at +1 415 555 2671.",
    );
    expect(links.some((l: ExtractedLink) => l.type === "shares-phone")).toBe(true);
  });
});

describe("extractLinks with canonicalizer registry", () => {
  test("collapses URL variants using a Drive-shaped canonicalizer", () => {
    // Two-rule canonicalizer mirroring how Drive's source declares it:
    // strip `/edit`/`/view`/`/preview` suffixes back to the canonical
    // `/file/d/<id>` form.
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["drive.google.com"],
        rules: [
          {
            match: "^https://drive\\.google\\.com/file/d/([^/]+).*$",
            replacement: "https://drive.google.com/file/d/$1",
          },
        ],
      },
    ]);

    const editLinks = extractLinks(
      "Contract: https://drive.google.com/file/d/116UrX/edit",
      undefined,
      undefined,
      registry,
    );
    const viewLinks = extractLinks(
      "Same file: https://drive.google.com/file/d/116UrX/view?usp=drivesdk",
      undefined,
      undefined,
      registry,
    );

    expect(editLinks).toHaveLength(1);
    expect(viewLinks).toHaveLength(1);
    expect(editLinks[0].normalizedTarget).toBe("https://drive.google.com/file/d/116UrX");
    expect(viewLinks[0].normalizedTarget).toBe(editLinks[0].normalizedTarget);
  });

  test("rawTarget preserves the original URL even after canonicalization", () => {
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["drive.google.com"],
        rules: [
          {
            match: "^https://drive\\.google\\.com/file/d/([^/]+).*$",
            replacement: "https://drive.google.com/file/d/$1",
          },
        ],
      },
    ]);
    const links = extractLinks(
      "Open: https://drive.google.com/file/d/116UrX/edit",
      undefined,
      undefined,
      registry,
    );
    expect(links[0].rawTarget).toBe("https://drive.google.com/file/d/116UrX/edit");
    expect(links[0].normalizedTarget).toBe("https://drive.google.com/file/d/116UrX");
  });

  test("a hostname with no registered canonicalizer falls through generic normalization", () => {
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["drive.google.com"],
        rules: [
          {
            match: "^.*$",
            replacement: "https://rewritten",
          },
        ],
      },
    ]);
    const links = extractLinks(
      "Bare: https://example.com/page#section",
      undefined,
      undefined,
      registry,
    );
    expect(links[0].normalizedTarget).toBe("https://example.com/page");
  });

  test("omitting the registry leaves URL variants distinct under generic normalization", () => {
    const editLinks = extractLinks("https://drive.google.com/file/d/116UrX/edit");
    const noSuffixLinks = extractLinks("https://drive.google.com/file/d/116UrX");
    // Without a registry the generic-only pass keeps `/edit` in the
    // path, so the two variants do NOT collapse. Callers that want
    // them collapsed must pass a host-keyed canonicalizer registry.
    expect(editLinks[0].normalizedTarget).not.toBe(noSuffixLinks[0].normalizedTarget);
  });

  test("undefined canonicalizers + undefined metadata works (defensive)", () => {
    const links = extractLinks("https://example.com", undefined, undefined, undefined);
    expect(links).toHaveLength(1);
  });
});
