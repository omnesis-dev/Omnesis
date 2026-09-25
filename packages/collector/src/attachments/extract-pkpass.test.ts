// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import JSZip from "jszip";
import { extractPkpassText } from "./extract-pkpass.js";

const PKPASS = "application/vnd.apple.pkpass";
const PKPASSES = "application/vnd.apple.pkpasses";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(fixturesDir, name)));

/** Wrap a pass.json object in a minimal `.pkpass` zip, in-memory. */
async function makePass(
  passJson: unknown,
  extra?: Record<string, Uint8Array | string>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("pass.json", JSON.stringify(passJson));
  for (const [name, data] of Object.entries(extra ?? {})) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array" });
}

// ─── Committed-fixture integration (real .pkpass / .pkpasses bytes) ───────────

describe("extractPkpassText — committed fixtures", () => {
  test("boarding pass: flight / seat / gate / route become searchable", async () => {
    const result = await extractPkpassText(readFixture("boarding-pass.pkpass"), PKPASS);
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain("Stellar Air");
    expect(text).toContain("Boarding Pass");
    expect(text).toContain("**Transit:** Air");
    expect(text).toContain("SFO");
    expect(text).toContain("JFK");
    expect(text).toContain("SA 482");
    expect(text).toContain("14C");
    expect(text).toContain("B22");
    expect(text).toContain("Maya Reeves");
    // Barcode alt text (confirmation-style code) is indexed.
    expect(text).toContain("SA 482 · 14C");
    expect(result!.truncated).toBe(false);
    expect(result!.extra).toEqual({ pkpass: true });
  });

  test("event ticket: event / section / row / seat / venue", async () => {
    const result = await extractPkpassText(readFixture("event-ticket.pkpass"), PKPASS);
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain("Studio Northstar");
    expect(text).toContain("Event Ticket");
    expect(text).toContain("Northern Lights Live");
    expect(text).toContain("Section:");
    expect(text).toContain("112");
    // relevantText location is surfaced.
    expect(text).toContain("Riverside Estate");
  });

  test("store card: numeric point balance renders", async () => {
    const result = await extractPkpassText(readFixture("store-card.pkpass"), PKPASS);
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain("Riverside Coffee");
    expect(text).toContain("Store Card");
    expect(text).toContain("Points:");
    expect(text).toContain("1240");
    expect(text).toContain("Gold");
  });

  test(".pkpasses bundle: both legs extracted and separated", async () => {
    const result = await extractPkpassText(readFixture("trip-bundle.pkpasses"), PKPASSES);
    expect(result).not.toBeNull();
    const text = result!.text;
    // Outbound + return both present.
    expect(text).toContain("SA 482");
    expect(text).toContain("SA 119");
    expect(text).toContain("9A");
    expect(text).toContain("14C");
    // Two passes joined by the block separator.
    expect(text.split("\n---\n").length).toBe(2);
  });
});

// ─── Field / style rendering ─────────────────────────────────────────────────

describe("extractPkpassText — rendering", () => {
  test("uses logoText as title when organizationName is absent", async () => {
    const bytes = await makePass({
      logoText: "Aurora Rail",
      description: "Ticket",
      generic: { primaryFields: [{ key: "ref", label: "Ref", value: "AR-2231" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("# Aurora Rail");
    expect(result!.text).toContain("AR-2231");
  });

  test("fields with no label render their bare value", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      generic: { primaryFields: [{ key: "x", value: "UNLABELLED-VALUE" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("UNLABELLED-VALUE");
  });

  test("supports the legacy single `barcode` key", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      description: "Pass",
      barcode: { format: "PKBarcodeFormatPDF417", message: "X", altText: "LEGACY-CODE" },
      generic: {},
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("LEGACY-CODE");
  });

  test("voided flag is surfaced", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      voided: true,
      generic: { primaryFields: [{ key: "a", label: "A", value: "1" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("**Voided:** yes");
  });

  test("coupon style renders its label and fields", async () => {
    const bytes = await makePass({
      organizationName: "Riverside Coffee",
      coupon: {
        primaryFields: [{ key: "offer", label: "Offer", value: "20% off" }],
        auxiliaryFields: [{ key: "code", label: "Code", value: "SAVE20" }],
      },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Coupon");
    expect(result!.text).toContain("20% off");
    expect(result!.text).toContain("SAVE20");
  });

  test("expirationDate is rendered", async () => {
    const bytes = await makePass({
      organizationName: "Aurora Rail",
      expirationDate: "2026-12-31T23:59:00Z",
      generic: { primaryFields: [{ key: "ref", label: "Ref", value: "AR-9" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("**Expires:** 2026-12-31T23:59:00Z");
  });

  test("location with only coordinates (no relevantText) renders the lat/long", async () => {
    const bytes = await makePass({
      organizationName: "Aurora Rail",
      locations: [{ latitude: 12.3456, longitude: 65.4321 }],
      generic: { primaryFields: [{ key: "ref", label: "Ref", value: "AR-10" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result!.text).toContain("**Location:** (12.3456, 65.4321)");
  });

  test("a location-only pass (no fields/barcode) is still indexed", async () => {
    const bytes = await makePass({
      organizationName: "Aurora Rail",
      generic: {},
      locations: [{ latitude: 12.3456, longitude: 65.4321, relevantText: "Riverside Estate" }],
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Riverside Estate");
  });
});

// ─── Untrusted-JSON resilience (one bad field must not drop the pass) ─────────

describe("extractPkpassText — malformed-field resilience", () => {
  test("a field with a non-scalar value is skipped, not fatal", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      generic: {
        primaryFields: [
          { key: "bad", label: "Bad", value: { nested: "object" } },
          { key: "good", label: "Good", value: "GOOD-VALUE" },
        ],
      },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("GOOD-VALUE");
    expect(result!.text).not.toContain("nested");
  });

  test("a non-array field collection does not throw", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      description: "Pass",
      generic: { primaryFields: "not-an-array", auxiliaryFields: 42 },
    });
    // Guarded to []: no fields, but description keeps it indexable.
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Pass");
  });

  test("non-object barcodes / locations entries are ignored", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      description: "Pass",
      barcodes: ["not-an-object", 5],
      locations: [null, "x"],
      generic: { primaryFields: [{ key: "a", label: "A", value: "1" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("**A:** 1");
  });
});

// ─── Failure modes (non-fatal contract) ──────────────────────────────────────

describe("extractPkpassText — graceful failure", () => {
  test("returns null for empty input", async () => {
    expect(await extractPkpassText(new Uint8Array(0), PKPASS)).toBeNull();
  });

  test("returns null for non-zip bytes", async () => {
    expect(await extractPkpassText(new Uint8Array([1, 2, 3, 4]), PKPASS)).toBeNull();
  });

  test("returns null for a zip with no pass.json (signature-only archive)", async () => {
    const zip = new JSZip();
    zip.file("signature", new Uint8Array([0x30, 0x80]));
    zip.file("icon.png", new Uint8Array([0x89, 0x50]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(bytes, PKPASS)).toBeNull();
  });

  test("returns null for malformed pass.json", async () => {
    const zip = new JSZip();
    zip.file("pass.json", "{ this is : not valid json ]");
    const broken = await zip.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(broken, PKPASS)).toBeNull();
  });

  test("returns null when pass.json is a non-object JSON value", async () => {
    const zip = new JSZip();
    zip.file("pass.json", '"just a string"');
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(bytes, PKPASS)).toBeNull();
  });

  test("returns null for a title-only pass with no indexable content", async () => {
    const bytes = await makePass({ organizationName: "Empty Co", generic: {} });
    expect(await extractPkpassText(bytes, PKPASS)).toBeNull();
  });

  test("bundle with one malformed inner pass still returns the good ones", async () => {
    const good = await makePass({
      organizationName: "Good Air",
      generic: { primaryFields: [{ key: "r", label: "Ref", value: "GOOD-1" }] },
    });
    const badInner = new JSZip();
    badInner.file("pass.json", "}{ broken");
    const bad = await badInner.generateAsync({ type: "uint8array" });

    const bundle = new JSZip();
    bundle.file("a.pkpass", good);
    bundle.file("b.pkpass", bad);
    const bytes = await bundle.generateAsync({ type: "uint8array" });

    const result = await extractPkpassText(bytes, PKPASSES);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("GOOD-1");
  });

  test("empty bundle (no inner passes) returns null", async () => {
    const bundle = new JSZip();
    bundle.file("readme.txt", "nothing here");
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(bytes, PKPASSES)).toBeNull();
  });
});

// ─── Security: decompression-bomb & resource bounds ──────────────────────────

describe("extractPkpassText — zip-safety bounds", () => {
  test("a pass.json that inflates past the ceiling is refused (not OOM)", async () => {
    // ~8MB of highly-compressible JSON — a tiny archive, huge inflated. The
    // 2MB pass.json ceiling must abort the inflate and return null.
    const huge = { organizationName: "Bomb", note: "A".repeat(8_000_000), generic: {} };
    const zip = new JSZip();
    zip.file("pass.json", JSON.stringify(huge));
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    // Compressed archive is small…
    expect(bytes.length).toBeLessThan(200_000);
    // …but extraction refuses it rather than materializing 8MB.
    expect(await extractPkpassText(bytes, PKPASS)).toBeNull();
  });

  test("an archive with too many entries is refused", async () => {
    const zip = new JSZip();
    zip.file("pass.json", JSON.stringify({ organizationName: "X", generic: {} }));
    for (let i = 0; i < 300; i++) zip.file(`pad-${i}.bin`, new Uint8Array([i & 0xff]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(bytes, PKPASS)).toBeNull();
  });

  test("bundle parses at most MAX_BUNDLE_PASSES inner passes", async () => {
    const one = await makePass({
      organizationName: "Air",
      generic: { primaryFields: [{ key: "r", label: "R", value: "REF" }] },
    });
    const bundle = new JSZip();
    // 40 inner passes; only the first 32 are parsed. All under the entry cap
    // (40 < 256) so the archive itself is accepted.
    for (let i = 0; i < 40; i++) bundle.file(`p-${i}.pkpass`, one);
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    const result = await extractPkpassText(bytes, PKPASSES);
    expect(result).not.toBeNull();
    expect(result!.text.split("\n---\n").length).toBe(32);
  });

  test("an inner .pkpass that inflates past the ceiling is skipped, not fatal", async () => {
    // Bundle: one bomb inner pass (huge inflating pass.json) + one small good
    // one. The bomb trips MAX_INNER_PKPASS_BYTES and is skipped; the good pass
    // still comes through.
    const bomb = new JSZip();
    bomb.file(
      "pass.json",
      JSON.stringify({ organizationName: "Bomb", note: "A".repeat(9_000_000) }),
    );
    const bombBytes = await bomb.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const good = await makePass({
      organizationName: "Good Air",
      generic: { primaryFields: [{ key: "r", label: "Ref", value: "GOOD-2" }] },
    });
    const bundle = new JSZip();
    bundle.file("bomb.pkpass", bombBytes);
    bundle.file("good.pkpass", good);
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    const result = await extractPkpassText(bytes, PKPASSES);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("GOOD-2");
    expect(result!.text).not.toContain("Bomb");
  });

  test("a bundle of junk inner passes caps ITERATIONS, not just successes", async () => {
    // Every inner entry yields zero blocks (no pass.json). Without an iteration
    // cap this would inflate all 200 entries; the cap stops the work. We can't
    // observe the internal counter, so assert the tractable outcome: null,
    // fast, no throw. (The cap keeps this from being a CPU-time DoS.)
    const junk = new JSZip();
    junk.file("readme.txt", "no pass here");
    const junkBytes = await junk.generateAsync({ type: "uint8array" });
    const bundle = new JSZip();
    for (let i = 0; i < 200; i++) bundle.file(`j-${i}.pkpass`, junkBytes);
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    expect(await extractPkpassText(bytes, PKPASSES)).toBeNull();
  });

  test("respects maxTextLength (truncation)", async () => {
    const bytes = await makePass({
      organizationName: "Test Org",
      description: "A pass with a long description ".repeat(50),
      generic: { primaryFields: [{ key: "a", label: "A", value: "1" }] },
    });
    const result = await extractPkpassText(bytes, PKPASS, { maxTextLength: 40 });
    expect(result).not.toBeNull();
    expect(result!.text.length).toBe(40);
    expect(result!.truncated).toBe(true);
  });

  test("a bundle stops materializing once the output budget is met", async () => {
    // Many valid inner passes, tiny maxLen. The budget break stops early and
    // the output is bounded to maxLen.
    const one = await makePass({
      organizationName: "Air",
      generic: { primaryFields: [{ key: "r", label: "Ref", value: "REF-VALUE-XYZ" }] },
    });
    const bundle = new JSZip();
    for (let i = 0; i < 20; i++) bundle.file(`p-${i}.pkpass`, one);
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    const result = await extractPkpassText(bytes, PKPASSES, { maxTextLength: 100 });
    expect(result).not.toBeNull();
    expect(result!.text.length).toBe(100);
    expect(result!.truncated).toBe(true);
  });
});
