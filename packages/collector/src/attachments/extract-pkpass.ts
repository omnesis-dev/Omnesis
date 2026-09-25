// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import JSZip from "jszip";
import { createLogger } from "@omnesis/core";
import type { Readable } from "node:stream";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:pkpass");

/**
 * A `.pkpass` (Apple Wallet pass) is a signed ZIP whose payload is `pass.json`;
 * a `.pkpasses` bundle is a ZIP of several `.pkpass` files. We parse the JSON
 * payload into readable, searchable text — the images and PKCS#7 signature are
 * ignored (we index passes, not verify them).
 *
 * The bytes come from an email/Drive attachment, i.e. attacker-influenced input,
 * so every decompression is bounded (see the caps below) to defend against zip
 * bombs / decompression amplification; a malformed or oversized archive returns
 * null rather than throwing, per the extractor's non-fatal contract.
 */

/** Reject archives with an implausible number of entries (bundle-bomb guard). */
const MAX_ENTRIES = 256;
/** Decompressed ceiling for a single `pass.json` (normal passes are a few KB). */
const MAX_PASS_JSON_BYTES = 2_000_000;
/** Decompressed ceiling for one inner `.pkpass` inside a bundle. */
const MAX_INNER_PKPASS_BYTES = 5_000_000;
/** Cap how many inner passes we parse from a `.pkpasses` bundle. */
const MAX_BUNDLE_PASSES = 32;

const STYLE_KEYS = ["boardingPass", "eventTicket", "coupon", "storeCard", "generic"] as const;
type PassStyle = (typeof STYLE_KEYS)[number];

const STYLE_LABELS: Record<PassStyle, string> = {
  boardingPass: "Boarding Pass",
  eventTicket: "Event Ticket",
  coupon: "Coupon",
  storeCard: "Store Card",
  generic: "Pass",
};

interface PassField {
  label?: string;
  value?: string | number;
}

interface PassStyleObject {
  transitType?: string;
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
}

interface PassBarcode {
  altText?: string;
}

interface PassLocation {
  latitude?: number;
  longitude?: number;
  relevantText?: string;
}

interface PassJson {
  organizationName?: string;
  description?: string;
  logoText?: string;
  relevantDate?: string;
  expirationDate?: string;
  voided?: boolean;
  barcode?: PassBarcode;
  barcodes?: PassBarcode[];
  locations?: PassLocation[];
  boardingPass?: PassStyleObject;
  eventTicket?: PassStyleObject;
  coupon?: PassStyleObject;
  storeCard?: PassStyleObject;
  generic?: PassStyleObject;
}

/**
 * Extract text from an Apple Wallet pass. `mimeType` selects single-pass
 * (`application/vnd.apple.pkpass`) vs. bundle (`application/vnd.apple.pkpasses`)
 * handling. Returns null when the archive is malformed, oversized, or empty.
 */
export async function extractPkpassText(
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;
  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    const zip = await JSZip.loadAsync(data);
    if (countEntries(zip) > MAX_ENTRIES) {
      log.warn(`pkpass archive has too many entries, skipping (${data.length} bytes)`);
      return null;
    }

    const isBundle = mimeType === "application/vnd.apple.pkpasses";
    const passes = isBundle ? await parseBundle(zip, maxLen) : await parseSinglePass(zip);
    if (passes.length === 0) return null;

    // Join against a running budget so a large bundle never materializes a
    // string far past `maxLen` (mirrors the office extractors' per-part cap).
    const separator = "\n\n---\n\n";
    let body = "";
    let truncated = false;
    for (const block of passes) {
      const piece = body ? separator + block : block;
      if (body.length + piece.length > maxLen) {
        body += piece.slice(0, maxLen - body.length);
        truncated = true;
        break;
      }
      body += piece;
    }
    if (!body.trim()) return null;
    return { text: body, truncated, extra: { pkpass: true } };
  } catch (err) {
    const msg = sanitizeLog(err instanceof Error ? err.message : String(err));
    log.warn(`pkpass extraction failed (${data.length} bytes): ${msg}`);
    return null;
  }
}

function countEntries(zip: JSZip): number {
  let n = 0;
  zip.forEach(() => {
    n++;
  });
  return n;
}

/** Parse a single `.pkpass`: read `pass.json`, format it, return one block. */
async function parseSinglePass(zip: JSZip): Promise<string[]> {
  const entry = zip.file("pass.json");
  if (!entry) return [];
  const bytes = await readBounded(entry, MAX_PASS_JSON_BYTES);
  if (!bytes) return [];

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const block = formatPass(text);
  return block ? [block] : [];
}

/** Parse a `.pkpasses` bundle: format each inner `.pkpass`, skipping bad ones. */
async function parseBundle(zip: JSZip, maxLen: number): Promise<string[]> {
  const inner = zip.filter((path) => path.toLowerCase().endsWith(".pkpass"));
  const blocks: string[] = [];
  let considered = 0;
  let totalChars = 0;

  for (const file of inner) {
    // Cap iterations, not just successes — a bundle of junk inner entries (none
    // yielding output) must not run us through hundreds of inflate passes
    // (CPU-time DoS).
    if (considered >= MAX_BUNDLE_PASSES) break;
    considered++;
    try {
      const bytes = await readBounded(file, MAX_INNER_PKPASS_BYTES);
      if (!bytes) continue;
      const innerZip = await JSZip.loadAsync(bytes);
      if (countEntries(innerZip) > MAX_ENTRIES) continue;
      const parsed = await parseSinglePass(innerZip);
      blocks.push(...parsed);
      totalChars += parsed.reduce((n, b) => n + b.length, 0);
      // Already enough text to fill the output budget — stop before
      // materializing more blocks the caller would only truncate away.
      if (totalChars >= maxLen) break;
    } catch (err) {
      // One malformed inner pass must not sink the whole bundle.
      const msg = sanitizeLog(err instanceof Error ? err.message : String(err));
      log.debug(`skipping malformed inner pass in bundle: ${msg}`);
    }
  }

  return blocks;
}

/**
 * Read a ZIP entry with a hard decompressed-byte ceiling, aborting the inflate
 * once the cap is exceeded (returns null). Consuming JSZip's lazy node stream
 * and destroying it on overflow bounds memory to ~`maxBytes` regardless of the
 * entry's declared/actual uncompressed size — the essential defense against a
 * small compressed entry that inflates to gigabytes.
 */
function readBounded(file: JSZip.JSZipObject, maxBytes: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    // JSZip's node stream is a `readable-stream` Readable at runtime; its public
    // type is the narrower `NodeJS.ReadableStream` (no `destroy`), so narrow it.
    const stream = file.nodeStream("nodebuffer") as unknown as Readable;

    stream
      .on("data", (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
          done = true;
          stream.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (err: Error) => {
        if (done) return;
        done = true;
        reject(err);
      })
      .on("end", () => {
        if (done) return;
        done = true;
        resolve(new Uint8Array(Buffer.concat(chunks)));
      });
  });
}

/** Format one parsed `pass.json` string into labelled markdown. */
function formatPass(json: string): string | null {
  let pass: PassJson;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    pass = parsed as PassJson;
  } catch {
    return null;
  }

  const style = STYLE_KEYS.find((k) => pass[k] && typeof pass[k] === "object");
  const styleObj = style ? pass[style] : undefined;

  // Every field below is read from untrusted `JSON.parse` output, so each is
  // type-guarded: a wrong-typed member is skipped rather than throwing (which
  // would drop the whole, possibly-valid, pass).
  const organizationName = str(pass.organizationName);
  const description = str(pass.description);
  const logoText = str(pass.logoText);

  const lines: string[] = [];

  // Title: the most human-recognizable identifier available.
  const title = organizationName || logoText || description || "Wallet Pass";
  lines.push(`# ${title}`);
  lines.push(styleObj ? STYLE_LABELS[style as PassStyle] : "Pass");
  lines.push("");

  if (organizationName) lines.push(`**Organization:** ${organizationName}`);
  if (description) lines.push(`**Description:** ${description}`);
  if (logoText) lines.push(`**Logo text:** ${logoText}`);

  const transit =
    typeof styleObj?.transitType === "string" ? formatTransit(styleObj.transitType) : "";
  if (transit) lines.push(`**Transit:** ${transit}`);

  if (str(pass.relevantDate)) lines.push(`**Relevant date:** ${str(pass.relevantDate)}`);
  if (str(pass.expirationDate)) lines.push(`**Expires:** ${str(pass.expirationDate)}`);
  if (pass.voided === true) lines.push(`**Voided:** yes`);

  // Fields, in the visual order Wallet renders them.
  const fields = styleObj
    ? [
        styleObj.headerFields,
        styleObj.primaryFields,
        styleObj.secondaryFields,
        styleObj.auxiliaryFields,
        styleObj.backFields,
      ].flatMap((a) => (Array.isArray(a) ? a : []))
    : [];

  const fieldLines = fields.map(formatField).filter((l): l is string => l !== null);
  if (fieldLines.length > 0) {
    lines.push("");
    lines.push(...fieldLines);
  }

  // Barcode alt text is human-readable (e.g. a confirmation code).
  const barcodes = [
    ...(pass.barcode ? [pass.barcode] : []),
    ...(Array.isArray(pass.barcodes) ? pass.barcodes : []),
  ].filter((b): b is PassBarcode => !!b && typeof b === "object");
  const barcodeAlts = dedupe(barcodes.map((b) => str(b.altText).trim()).filter((a) => !!a));
  for (const alt of barcodeAlts) lines.push(`**Barcode:** ${alt}`);

  // Relevant locations (name when present; coordinates otherwise).
  const locationLines: string[] = [];
  for (const loc of Array.isArray(pass.locations) ? pass.locations : []) {
    if (!loc || typeof loc !== "object") continue;
    const parts: string[] = [];
    if (str(loc.relevantText).trim()) parts.push(str(loc.relevantText).trim());
    if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      parts.push(`(${loc.latitude}, ${loc.longitude})`);
    }
    if (parts.length > 0) locationLines.push(`**Location:** ${parts.join(" ")}`);
  }
  lines.push(...locationLines);

  const text = lines.join("\n").trim();
  // Reject a shell whose only content is the title (organization / logo text) —
  // nothing worth indexing.
  return fieldLines.length > 0 || description || barcodeAlts.length > 0 || locationLines.length > 0
    ? text
    : null;
}

function formatField(field: PassField): string | null {
  if (!field || typeof field !== "object") return null;
  const value = field.value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const rendered = typeof value === "number" ? String(value) : value.trim();
  if (!rendered) return null;
  const label = str(field.label).trim();
  return label ? `**${label}:** ${rendered}` : rendered;
}

/** `PKTransitTypeAir` → `Air`; leave anything unexpected as-is. */
function formatTransit(transitType: string): string {
  const stripped = transitType.replace(/^PKTransitType/, "").trim();
  return stripped || transitType;
}

/** Coerce an untrusted value to a string, or "" when it isn't one. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Strip newlines so an attacker-controlled entry name can't forge log lines. */
function sanitizeLog(message: string): string {
  return message.replace(/[\r\n]+/g, " ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
