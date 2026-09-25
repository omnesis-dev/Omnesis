// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  resolveAttachmentConfig,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  formatAttachmentMarkers,
  deriveAttachmentStableId,
  assignAttachmentSeqs,
  buildAttachmentDocument,
  isTrivialExtraction,
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_ATTACHMENT_TYPES,
  STT_AUDIO_TYPES,
  DEFAULT_MAX_TEXT_LENGTH,
} from "./attachments.js";
import { ProviderId, SourceId } from "./ids.js";
import type { DocumentInput } from "./document.js";

describe("resolveEffectiveMimeType", () => {
  const PKPASS = "application/vnd.apple.pkpass";

  test("recovers a .pkpass delivered as application/octet-stream", () => {
    expect(resolveEffectiveMimeType("ticket.pkpass", "application/octet-stream")).toBe(PKPASS);
  });

  test("recovers a .pkpasses bundle delivered as octet-stream", () => {
    expect(resolveEffectiveMimeType("trip.pkpasses", "application/octet-stream")).toBe(
      "application/vnd.apple.pkpasses",
    );
  });

  test("recovers PDF / Office delivered as octet-stream", () => {
    expect(resolveEffectiveMimeType("report.pdf", "application/octet-stream")).toBe(
      "application/pdf",
    );
    expect(resolveEffectiveMimeType("q3.docx", "application/octet-stream")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  test("recovers legacy Office / OpenDocument / RTF delivered as octet-stream", () => {
    expect(resolveEffectiveMimeType("memo.doc", "application/octet-stream")).toBe(
      "application/msword",
    );
    expect(resolveEffectiveMimeType("ledger.xls", "application/octet-stream")).toBe(
      "application/vnd.ms-excel",
    );
    expect(resolveEffectiveMimeType("slides.ppt", "application/octet-stream")).toBe(
      "application/vnd.ms-powerpoint",
    );
    expect(resolveEffectiveMimeType("brief.odt", "application/octet-stream")).toBe(
      "application/vnd.oasis.opendocument.text",
    );
    expect(resolveEffectiveMimeType("budget.ods", "application/octet-stream")).toBe(
      "application/vnd.oasis.opendocument.spreadsheet",
    );
    expect(resolveEffectiveMimeType("deck.odp", "application/octet-stream")).toBe(
      "application/vnd.oasis.opendocument.presentation",
    );
    expect(resolveEffectiveMimeType("notice.rtf", "application/octet-stream")).toBe(
      "application/rtf",
    );
  });

  test("recovers from an empty / missing reported type", () => {
    expect(resolveEffectiveMimeType("ticket.pkpass", "")).toBe(PKPASS);
    expect(resolveEffectiveMimeType("ticket.pkpass", undefined)).toBe(PKPASS);
    expect(resolveEffectiveMimeType("ticket.pkpass", null)).toBe(PKPASS);
  });

  test("treats application/zip variants as generic (pkpass is a zip)", () => {
    expect(resolveEffectiveMimeType("ticket.pkpass", "application/zip")).toBe(PKPASS);
    expect(resolveEffectiveMimeType("ticket.pkpass", "application/x-zip-compressed")).toBe(PKPASS);
  });

  test("strips MIME parameters before the generic check", () => {
    expect(resolveEffectiveMimeType("ticket.pkpass", "application/octet-stream; name=ticket")).toBe(
      PKPASS,
    );
  });

  test("is case-insensitive on the extension", () => {
    expect(resolveEffectiveMimeType("TICKET.PKPASS", "application/octet-stream")).toBe(PKPASS);
  });

  test("uses the last extension of a multi-dot filename", () => {
    expect(resolveEffectiveMimeType("my.boarding.pass.pkpass", "application/octet-stream")).toBe(
      PKPASS,
    );
  });

  test("trusts a specific reported type over the extension", () => {
    // A real PDF that merely has a misleading name keeps its declared type.
    expect(resolveEffectiveMimeType("weird.pkpass", "application/pdf")).toBe("application/pdf");
  });

  test("leaves an unknown extension as the reported generic type", () => {
    expect(resolveEffectiveMimeType("archive.xyz", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });

  test("an adversarial prototype-chain 'extension' does not leak a non-string", () => {
    // A plain object lookup for these inherited keys returns the Object
    // constructor / prototype / a method — all truthy non-strings. The helper
    // must ignore them and keep returning the reported string type.
    for (const ext of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const result = resolveEffectiveMimeType(`evil.${ext}`, "application/octet-stream");
      expect(typeof result).toBe("string");
      expect(result).toBe("application/octet-stream");
    }
  });

  test("leaves a generic type with no extension untouched", () => {
    expect(resolveEffectiveMimeType("noextension", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
    expect(resolveEffectiveMimeType(undefined, "application/octet-stream")).toBe(
      "application/octet-stream",
    );
    expect(resolveEffectiveMimeType(null, "application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });

  test("recovers an octet-stream image (routes to OCR)", () => {
    expect(resolveEffectiveMimeType("scan.jpg", "application/octet-stream")).toBe("image/jpeg");
  });

  test("the recovered type is in the default allow-list (so the gate accepts it)", () => {
    const config = {
      enabled: true,
      maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
      allowedTypes: DEFAULT_ATTACHMENT_TYPES,
      maxTextLength: DEFAULT_MAX_TEXT_LENGTH,
    };
    // The end-to-end contract: octet-stream .pkpass → recovered → gate extracts.
    const effective = resolveEffectiveMimeType("ticket.pkpass", "application/octet-stream");
    expect(shouldExtractAttachment(effective, 31_270, config)).toEqual({ extract: true });
    // …whereas the raw octet-stream would have been excluded (the bug we fixed).
    expect(shouldExtractAttachment("application/octet-stream", 31_270, config)).toEqual({
      extract: false,
      reason: "type-excluded",
    });
  });
});

describe("resolveAttachmentConfig", () => {
  test("default is disabled when no sourceConfig and no defaults", () => {
    expect(resolveAttachmentConfig().enabled).toBe(false);
    expect(resolveAttachmentConfig({}).enabled).toBe(false);
  });

  test("defaults.defaultEnabled flips the default to true when sourceConfig leaves it unset", () => {
    expect(resolveAttachmentConfig(undefined, { defaultEnabled: true }).enabled).toBe(true);
    expect(resolveAttachmentConfig({}, { defaultEnabled: true }).enabled).toBe(true);
  });

  test("explicit extractAttachments wins over defaultEnabled (opt-out works)", () => {
    expect(
      resolveAttachmentConfig({ extractAttachments: false }, { defaultEnabled: true }).enabled,
    ).toBe(false);
  });

  test("explicit extractAttachments: true is preserved when no defaults are passed", () => {
    expect(resolveAttachmentConfig({ extractAttachments: true }).enabled).toBe(true);
  });

  describe("OCR image types (#427)", () => {
    test("image types are included in the default allow-list", () => {
      const types = resolveAttachmentConfig().allowedTypes;
      expect(types).toContain("image/png");
      expect(types).toContain("image/jpeg");
      expect(types).toContain("image/heic");
      // The original document types are still present.
      expect(types).toContain("application/pdf");
    });

    test("an explicit per-source attachmentTypes always wins over the image defaults", () => {
      const types = resolveAttachmentConfig({ attachmentTypes: ["application/pdf"] }).allowedTypes;
      expect(types).toEqual(["application/pdf"]);
    });
  });

  describe("STT audio-type gating (#260)", () => {
    test("audio types are excluded by default (includeAudioTypes unset)", () => {
      const types = resolveAttachmentConfig(undefined, { defaultEnabled: true }).allowedTypes;
      for (const audio of STT_AUDIO_TYPES) expect(types).not.toContain(audio);
    });

    test("audio types join the allow-list when includeAudioTypes is set", () => {
      const types = resolveAttachmentConfig(undefined, {
        defaultEnabled: true,
        includeAudioTypes: true,
      }).allowedTypes;
      expect(types).toContain("audio/mpeg");
      expect(types).toContain("audio/mp4");
      expect(types).toContain("audio/wav");
      // The original document types are still present.
      expect(types).toContain("application/pdf");
    });

    test("audio types compose with the image defaults when includeAudioTypes is set", () => {
      const types = resolveAttachmentConfig(undefined, { includeAudioTypes: true }).allowedTypes;
      expect(types).toContain("audio/ogg");
      expect(types).toContain("image/png");
      expect(types).toContain("application/pdf");
    });

    test("an explicit per-source attachmentTypes always wins, even with includeAudioTypes", () => {
      const types = resolveAttachmentConfig(
        { attachmentTypes: ["application/pdf"] },
        { includeAudioTypes: true },
      ).allowedTypes;
      expect(types).toEqual(["application/pdf"]);
    });
  });
});

describe("shouldExtractAttachment", () => {
  const config = {
    enabled: true,
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    allowedTypes: DEFAULT_ATTACHMENT_TYPES,
    maxTextLength: DEFAULT_MAX_TEXT_LENGTH,
  };

  test("extracts a normal in-bounds PDF", () => {
    expect(shouldExtractAttachment("application/pdf", 12_345, config)).toEqual({ extract: true });
  });

  test("matches allowed types after stripping MIME parameters", () => {
    expect(shouldExtractAttachment("text/rtf; charset=us-ascii", 12_345, config)).toEqual({
      extract: true,
    });
    expect(shouldExtractAttachment("APPLICATION/MSWORD; name=brief.doc", 12_345, config)).toEqual({
      extract: true,
    });
  });

  test("type-excluded wins over size-unknown when both apply", () => {
    expect(shouldExtractAttachment("video/mp4", null, config)).toEqual({
      extract: false,
      reason: "type-excluded",
    });
  });

  test("size === null returns size-unknown (does NOT silently bypass max-size guard)", () => {
    expect(shouldExtractAttachment("application/pdf", null, config)).toEqual({
      extract: false,
      reason: "size-unknown",
    });
  });

  test("size === 0 is treated as a real (zero-byte) attachment, not unknown", () => {
    expect(shouldExtractAttachment("application/pdf", 0, config)).toEqual({ extract: true });
  });

  test("size > maxSizeBytes is too-large", () => {
    expect(shouldExtractAttachment("application/pdf", DEFAULT_MAX_SIZE_BYTES + 1, config)).toEqual({
      extract: false,
      reason: "too-large",
    });
  });

  test("Apple Wallet pass types are in the default allow-list (get downloaded)", () => {
    expect(DEFAULT_ATTACHMENT_TYPES).toContain("application/vnd.apple.pkpass");
    expect(DEFAULT_ATTACHMENT_TYPES).toContain("application/vnd.apple.pkpasses");
    expect(shouldExtractAttachment("application/vnd.apple.pkpass", 4_096, config)).toEqual({
      extract: true,
    });
    expect(shouldExtractAttachment("application/vnd.apple.pkpasses", 8_192, config)).toEqual({
      extract: true,
    });
  });

  test("legacy Office / OpenDocument / RTF types are in the default allow-list", () => {
    for (const type of [
      "application/msword",
      "application/vnd.ms-excel",
      "application/x-msexcel",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/rtf",
      "text/rtf",
    ]) {
      expect(DEFAULT_ATTACHMENT_TYPES).toContain(type);
      expect(shouldExtractAttachment(type, 4_096, config)).toEqual({ extract: true });
    }
  });
});

describe("formatAttachmentMarkers", () => {
  test("renders 'unknown size' for null size", () => {
    const out = formatAttachmentMarkers([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: null,
        extracted: false,
        reason: "size-unknown",
      },
    ]);
    expect(out).toContain("report.pdf");
    expect(out).toContain("unknown size");
  });

  test("renders human-readable byte counts when size is known", () => {
    const out = formatAttachmentMarkers([
      { filename: "tiny.txt", mimeType: "text/plain", size: 500, extracted: true },
      { filename: "huge.pdf", mimeType: "application/pdf", size: 5_242_880, extracted: true },
    ]);
    expect(out).toContain("500B");
    expect(out).toContain("5.0MB");
  });

  test("labels legacy Office / OpenDocument / RTF attachments without raw MIME strings", () => {
    const out = formatAttachmentMarkers([
      { filename: "memo.doc", mimeType: "application/msword", size: 1024, extracted: true },
      {
        filename: "sheet.ods",
        mimeType: "application/vnd.oasis.opendocument.spreadsheet",
        size: 2048,
        extracted: true,
      },
      { filename: "notice.rtf", mimeType: "application/rtf", size: 512, extracted: true },
    ]);

    expect(out).toContain("memo.doc (DOC, 1KB)");
    expect(out).toContain("sheet.ods (ODS, 2KB)");
    expect(out).toContain("notice.rtf (RTF, 512B)");
    expect(out).not.toContain("application/vnd.oasis");
  });
});

describe("deriveAttachmentStableId (#268)", () => {
  test("same inputs produce the same id (stability across re-syncs)", () => {
    const a = deriveAttachmentStableId("report.pdf", 12_345, "application/pdf");
    const b = deriveAttachmentStableId("report.pdf", 12_345, "application/pdf");
    expect(a).toBe(b);
  });

  test("id is independent of source-supplied attachmentId (the whole point of #268)", () => {
    // Old scheme used Gmail's attachmentId in the externalId. New scheme
    // doesn't take it as input at all — so two calls "from different sync
    // runs" return the same id even when the surrounding context changes.
    const id1 = deriveAttachmentStableId("statement.pdf", 100_000, "application/pdf");
    const id2 = deriveAttachmentStableId("statement.pdf", 100_000, "application/pdf");
    expect(id1).toBe(id2);
  });

  test("differs when filename differs", () => {
    const a = deriveAttachmentStableId("a.pdf", 1000, "application/pdf");
    const b = deriveAttachmentStableId("b.pdf", 1000, "application/pdf");
    expect(a).not.toBe(b);
  });

  test("differs when size differs", () => {
    const a = deriveAttachmentStableId("file.pdf", 1000, "application/pdf");
    const b = deriveAttachmentStableId("file.pdf", 1001, "application/pdf");
    expect(a).not.toBe(b);
  });

  test("differs when mimeType differs", () => {
    const a = deriveAttachmentStableId("report", 500, "application/pdf");
    const b = deriveAttachmentStableId("report", 500, "text/plain");
    expect(a).not.toBe(b);
  });

  test("seq=0 is the bare base id (no suffix)", () => {
    const id = deriveAttachmentStableId("a.pdf", 1, "application/pdf", 0);
    expect(id).not.toMatch(/:/);
  });

  test("seq>0 appends ':N' for collision disambiguation", () => {
    const base = deriveAttachmentStableId("a.pdf", 1, "application/pdf", 0);
    const dup1 = deriveAttachmentStableId("a.pdf", 1, "application/pdf", 1);
    const dup2 = deriveAttachmentStableId("a.pdf", 1, "application/pdf", 2);
    expect(dup1).toBe(`${base}:1`);
    expect(dup2).toBe(`${base}:2`);
  });

  test("null size is allowed and is distinct from a numeric size", () => {
    const withSize = deriveAttachmentStableId("a.pdf", 1000, "application/pdf");
    const withoutSize = deriveAttachmentStableId("a.pdf", null, "application/pdf");
    expect(withSize).not.toBe(withoutSize);
  });

  test("output is 16 hex chars (or 16 + ':N' for seq > 0)", () => {
    const base = deriveAttachmentStableId("a.pdf", 1, "application/pdf");
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    const seq3 = deriveAttachmentStableId("a.pdf", 1, "application/pdf", 3);
    expect(seq3).toMatch(/^[0-9a-f]{16}:3$/);
  });
});

describe("assignAttachmentSeqs", () => {
  // Encodes the previously-implicit "deterministic enumeration" contract
  // on `seq` so a future refactor that changes a source's iteration
  // order can't quietly orphan attachment docs by minting new ids.
  const pick = (it: { f: string; s: number | null; m: string }) => ({
    filename: it.f,
    sizeBytes: it.s,
    mimeType: it.m,
  });

  test("identical input order produces identical ids regardless of source iteration order", () => {
    const items = [
      { f: "report.pdf", s: 1000, m: "application/pdf" },
      { f: "scan.pdf", s: 2000, m: "application/pdf" },
    ];
    const fwd = assignAttachmentSeqs(items, pick).map(({ item, seq }) =>
      deriveAttachmentStableId(item.f, item.s, item.m, seq),
    );
    const rev = assignAttachmentSeqs([...items].reverse(), pick).map(({ item, seq }) =>
      deriveAttachmentStableId(item.f, item.s, item.m, seq),
    );
    expect(new Set(fwd)).toEqual(new Set(rev));
  });

  test("ties get incrementing seqs within their group", () => {
    const items = [
      { f: "scan.pdf", s: 1000, m: "application/pdf" },
      { f: "scan.pdf", s: 1000, m: "application/pdf" },
      { f: "report.pdf", s: 500, m: "application/pdf" },
    ];
    const result = assignAttachmentSeqs(items, pick);
    const scans = result.filter((r) => r.item.f === "scan.pdf");
    expect(scans.map((s) => s.seq).sort()).toEqual([0, 1]);
    const reports = result.filter((r) => r.item.f === "report.pdf");
    expect(reports.map((r) => r.seq)).toEqual([0]);
  });

  test("tieBreaker disambiguates within a tie group", () => {
    const items = [
      { f: "scan.pdf", s: 1000, m: "application/pdf", id: "B" },
      { f: "scan.pdf", s: 1000, m: "application/pdf", id: "A" },
    ];
    const fwd = assignAttachmentSeqs(items, pick, (i) => i.id);
    const rev = assignAttachmentSeqs([...items].reverse(), pick, (i) => i.id);
    // Sorted by id → A comes first regardless of insertion order.
    expect(fwd[0].item.id).toBe("A");
    expect(rev[0].item.id).toBe("A");
  });
});

describe("isTrivialExtraction", () => {
  // The case this predicate exists for: a signature logo OCR'd down to a few
  // stray characters, arriving again with every message from a correspondent.
  test.each([
    ["", "empty"],
    ["   \n  ", "whitespace only"],
    ["Q", "one stray character"],
    ["Logo", "one word"],
    ["Stellar Sound", "a two-word wordmark"],
  ])("treats %j as trivial (%s)", (text) => {
    expect(isTrivialExtraction(text)).toBe(true);
  });

  // Anything carrying a number, an address, or a link is the whole reason
  // attachments are indexed — brevity must never override that.
  test.each([
    ["Invoice 4417 due 2026-08-30", "a short invoice line"],
    ["follow us on", "three bare words — given the benefit of the doubt"],
    ["Gate B12", "a boarding-pass fragment"],
    ["contact@example.com", "an email address"],
    ["https://example.com/terms", "a URL"],
    [
      "This agreement is entered into between the parties named below and takes effect on signature.",
      "a sentence of prose",
    ],
  ])("treats %j as content (%s)", (text) => {
    expect(isTrivialExtraction(text)).toBe(false);
  });

  test("a dense unspaced script counts as content despite tokenizing as one word", () => {
    // Scripts that do not space their words would otherwise read as a
    // single-token logo. The letter-count guard is what prevents that.
    expect(
      isTrivialExtraction(
        "\u3053\u308c\u306f\u5951\u7d04\u66f8\u3067\u3059\u3002\u7f72\u540d\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u3053\u306e\u6587\u66f8\u306f\u91cd\u8981\u3067\u3059\u304b\u3089\u5fdd\u305a\u8aad\u3093\u3067\u304f\u3060\u3055\u3044",
      ),
    ).toBe(false);
  });
});

describe("buildAttachmentDocument", () => {
  const parent: DocumentInput = {
    providerId: ProviderId("google:test@example.com"),
    sourceId: SourceId("gmail:test@example.com"),
    externalId: "msg-abc123",
    title: "Test email",
    content: "body",
    contentHash: "deadbeef",
    metadata: {
      sourceUrl: "https://mail.google.com/mail/#inbox/msg-abc123",
      appUrl: "googlegmail:///co?messageId=msg-abc123",
      documentType: "email",
      people: [{ role: "sender", name: "Alice", emails: ["alice@example.com"] }],
    },
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  };
  const result = { text: "extracted PDF text", truncated: false };

  test("a trivially-extracted attachment carries the lowSignal marker", () => {
    const doc = buildAttachmentDocument(
      parent,
      "image001.png",
      { text: "Logo", truncated: false },
      { mimeType: "image/png", sizeBytes: 900 },
    );
    expect(doc.metadata.lowSignal).toBe(true);
  });

  test("an attachment with real content omits the marker entirely", () => {
    // Omitted rather than `false` — the marker's stated contract.
    const doc = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect("lowSignal" in doc.metadata).toBe(false);
  });

  test("externalId follows <parent>/att/<stable-id> shape", () => {
    const doc = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(doc.externalId).toMatch(/^msg-abc123\/att\/[0-9a-f]{16}$/);
  });

  test("re-sync (same attachment, same parent) produces the same externalId — #268 fix", () => {
    // Simulates what would happen when Gmail returns the same parent twice
    // with re-issued attachment IDs. The pre-#268 scheme would create two
    // child docs; under the new scheme, the externalId is stable so the
    // gateway's ON CONFLICT (provider_id, source_id, external_id) upsert
    // collapses them.
    const doc1 = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    const doc2 = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(doc1.externalId).toBe(doc2.externalId);
  });

  test("collision in same parent (seq) produces distinct externalIds", () => {
    const a = buildAttachmentDocument(parent, "scan.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1000,
      seq: 0,
    });
    const b = buildAttachmentDocument(parent, "scan.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1000,
      seq: 1,
    });
    expect(a.externalId).not.toBe(b.externalId);
    expect(b.externalId.endsWith(":1")).toBe(true);
  });

  test("inherits people and sourceUrl from parent", () => {
    const doc = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(doc.metadata.people).toEqual(parent.metadata.people);
    expect(doc.metadata.sourceUrl).toBe(parent.metadata.sourceUrl);
    expect(doc.metadata.appUrl).toBe(parent.metadata.appUrl);
    expect(doc.metadata.documentType).toBe("attachment");
    expect(doc.metadata.extra?.parentExternalId).toBe(parent.externalId);
  });

  test("an address the parent names by kind is not re-added from the text", () => {
    // The inherited-identity set is what stops an attachment listing its
    // parent's own correspondents again as fresh `mentioned` entries. Read
    // through the older spelling alone it sees nothing to dedupe against, and
    // the sender arrives twice — once inherited, once extracted.
    const byKind: DocumentInput = {
      ...parent,
      metadata: {
        ...parent.metadata,
        people: [
          {
            role: "sender",
            name: "Alice",
            identifiers: [{ kind: "email", value: "alice@example.com" }],
          },
        ],
      },
    };

    const doc = buildAttachmentDocument(
      byKind,
      "report.pdf",
      { text: "write back to alice@example.com when ready", truncated: false },
      { mimeType: "application/pdf", sizeBytes: 1234 },
    );

    const mentioned = (doc.metadata.people ?? []).filter((p) => p.role === "mentioned");
    expect(mentioned).toEqual([]);
  });

  test("without occurredAt both timestamps come from the parent", () => {
    // The single-dated-parent case: one email, one send time, and its
    // attachments were sent with it.
    const doc = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(doc.sourceCreatedAt).toBe(parent.sourceCreatedAt);
    expect(doc.sourceUpdatedAt).toBe(parent.sourceUpdatedAt);
  });

  test("occurredAt dates the attachment instead of the parent", () => {
    const dayParent: DocumentInput = {
      ...parent,
      // A chat day-document: its timestamps bound the day, they do not date
      // any one file sent during it.
      sourceCreatedAt: "2026-03-04T07:15:00.000Z",
      sourceUpdatedAt: "2026-03-04T22:40:00.000Z",
    };
    const doc = buildAttachmentDocument(dayParent, "booking.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
      occurredAt: "2026-03-04T17:58:00.000Z",
    });
    expect(doc.sourceCreatedAt).toBe("2026-03-04T17:58:00.000Z");
    // Pinned to the same instant: a sent file is not edited afterwards, so a
    // later message extending the day must not rewrite this attachment.
    expect(doc.sourceUpdatedAt).toBe("2026-03-04T17:58:00.000Z");
  });

  test("two files sent on the same day keep their relative order", () => {
    // The regression this override exists for: without it both attachments
    // collapse onto the day's first-message time, and nothing downstream can
    // tell which piece of evidence superseded the other.
    const dayParent: DocumentInput = {
      ...parent,
      sourceCreatedAt: "2026-03-04T07:15:00.000Z",
      sourceUpdatedAt: "2026-03-04T22:40:00.000Z",
    };
    const morning = buildAttachmentDocument(dayParent, "first.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
      occurredAt: "2026-03-04T09:02:00.000Z",
    });
    const evening = buildAttachmentDocument(dayParent, "second.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 4321,
      occurredAt: "2026-03-04T17:58:00.000Z",
    });
    expect(morning.sourceCreatedAt < evening.sourceCreatedAt).toBe(true);
    expect(morning.sourceCreatedAt).not.toBe(dayParent.sourceCreatedAt);
  });

  test("occurredAt does not affect the externalId", () => {
    // The stable id is derived from (filename, size, mimeType, seq) only, so
    // re-syncing a day whose bounds shifted still collapses onto one document.
    const a = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    const b = buildAttachmentDocument(parent, "report.pdf", result, {
      mimeType: "application/pdf",
      sizeBytes: 1234,
      occurredAt: "2026-03-04T17:58:00.000Z",
    });
    expect(a.externalId).toBe(b.externalId);
  });
});
