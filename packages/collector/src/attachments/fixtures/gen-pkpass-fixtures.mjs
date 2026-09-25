// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Generates the committed `.pkpass` / `.pkpasses` test fixtures used by
// extract-pkpass.test.ts. Re-run with:
//   node packages/collector/src/attachments/fixtures/gen-pkpass-fixtures.mjs
//
// All data is invented (fictional names / vendors / codes) per the repo's
// privacy rule — never sourced from the corpus.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));

// Fixed epoch so regenerated archives are byte-stable (no timestamp churn).
const DATE = new Date(0);

/** Build a single `.pkpass` (zip with pass.json + a manifest/signature stub). */
async function buildPass(passJson) {
  const zip = new JSZip();
  zip.file("pass.json", JSON.stringify(passJson, null, 2), { date: DATE });
  // A real pass carries these; we ignore them when parsing but include stubs so
  // the fixture resembles a genuine archive (extra entries the parser skips).
  zip.file("manifest.json", JSON.stringify({ "pass.json": "0".repeat(40) }), { date: DATE });
  zip.file("signature", new Uint8Array([0x30, 0x80]), { date: DATE });
  zip.file("icon.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { date: DATE });
  return zip.generateAsync({ type: "uint8array", platform: "UNIX" });
}

const boardingPass = {
  formatVersion: 1,
  passTypeIdentifier: "pass.com.example.air",
  serialNumber: "SA482-14C",
  teamIdentifier: "EXAMPLE00",
  organizationName: "Stellar Air",
  description: "Stellar Air Boarding Pass",
  logoText: "Stellar Air",
  relevantDate: "2026-08-14T18:35:00-07:00",
  boardingPass: {
    transitType: "PKTransitTypeAir",
    headerFields: [{ key: "date", label: "Date", value: "2026-08-14" }],
    primaryFields: [
      { key: "origin", label: "San Francisco", value: "SFO" },
      { key: "destination", label: "New York", value: "JFK" },
    ],
    secondaryFields: [
      { key: "passenger", label: "Passenger", value: "Maya Reeves" },
      { key: "seat", label: "Seat", value: "14C" },
    ],
    auxiliaryFields: [
      { key: "boarding", label: "Boarding", value: "18:05" },
      { key: "flight", label: "Flight", value: "SA 482" },
      { key: "gate", label: "Gate", value: "B22" },
    ],
  },
  barcodes: [
    { format: "PKBarcodeFormatQR", message: "SA482MAYAREEVES14C", altText: "SA 482 · 14C" },
  ],
};

const returnPass = {
  ...boardingPass,
  serialNumber: "SA119-9A",
  description: "Stellar Air Boarding Pass",
  relevantDate: "2026-08-21T09:10:00-04:00",
  boardingPass: {
    transitType: "PKTransitTypeAir",
    headerFields: [{ key: "date", label: "Date", value: "2026-08-21" }],
    primaryFields: [
      { key: "origin", label: "New York", value: "JFK" },
      { key: "destination", label: "San Francisco", value: "SFO" },
    ],
    secondaryFields: [
      { key: "passenger", label: "Passenger", value: "Maya Reeves" },
      { key: "seat", label: "Seat", value: "9A" },
    ],
    auxiliaryFields: [
      { key: "boarding", label: "Boarding", value: "08:40" },
      { key: "flight", label: "Flight", value: "SA 119" },
      { key: "gate", label: "Gate", value: "C7" },
    ],
  },
  barcodes: [{ format: "PKBarcodeFormatQR", message: "SA119MAYAREEVES9A", altText: "SA 119 · 9A" }],
};

const eventTicket = {
  formatVersion: 1,
  passTypeIdentifier: "pass.com.example.events",
  serialNumber: "NS-A7-112",
  teamIdentifier: "EXAMPLE00",
  organizationName: "Studio Northstar",
  description: "Northern Lights Live — Concert Ticket",
  relevantDate: "2026-09-02T19:00:00-04:00",
  eventTicket: {
    primaryFields: [{ key: "event", label: "Event", value: "Northern Lights Live" }],
    secondaryFields: [
      { key: "date", label: "Date", value: "2026-09-02" },
      { key: "doors", label: "Doors", value: "19:00" },
    ],
    auxiliaryFields: [
      { key: "section", label: "Section", value: "A" },
      { key: "row", label: "Row", value: "7" },
      { key: "seat", label: "Seat", value: "112" },
    ],
  },
  locations: [{ latitude: 40.7128, longitude: -74.006, relevantText: "Riverside Estate" }],
  barcodes: [{ format: "PKBarcodeFormatQR", message: "NORTHSTAR-A7-112", altText: "A / 7 / 112" }],
};

const storeCard = {
  formatVersion: 1,
  passTypeIdentifier: "pass.com.example.loyalty",
  serialNumber: "RC-88231",
  teamIdentifier: "EXAMPLE00",
  organizationName: "Riverside Coffee",
  description: "Riverside Coffee Loyalty Card",
  storeCard: {
    primaryFields: [{ key: "balance", label: "Points", value: 1240 }],
    secondaryFields: [{ key: "member", label: "Member", value: "Jamie Lopez" }],
    auxiliaryFields: [{ key: "tier", label: "Tier", value: "Gold" }],
  },
};

async function main() {
  const write = (name, bytes) => {
    writeFileSync(join(here, name), bytes);
    console.log(`wrote ${name} (${bytes.length} bytes)`);
  };

  write("boarding-pass.pkpass", await buildPass(boardingPass));
  write("event-ticket.pkpass", await buildPass(eventTicket));
  write("store-card.pkpass", await buildPass(storeCard));

  // A `.pkpasses` bundle is a zip of several `.pkpass` files.
  const bundle = new JSZip();
  bundle.file("outbound.pkpass", await buildPass(boardingPass), { date: DATE });
  bundle.file("return.pkpass", await buildPass(returnPass), { date: DATE });
  write(
    "trip-bundle.pkpasses",
    await bundle.generateAsync({ type: "uint8array", platform: "UNIX" }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
