// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Regenerate packages/core/src/valid-tlds.ts from the IANA root-zone TLD list.
// Run manually when refreshing the snapshot: node packages/core/scripts/gen-valid-tlds.mjs
// (Kept out of the build so the build never depends on the network.)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "valid-tlds.ts");

const res = await fetch(SRC);
if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
const text = await res.text();
const lines = text.split("\n");
const ver = (lines[0].match(/Version (\d+)/) || [])[1] ?? "unknown";
const date = (lines[0].match(/Last Updated (.+) UTC/) || [])[1] ?? "unknown";
const tlds = lines
  .slice(1)
  .map((l) => l.trim().toLowerCase())
  .filter(Boolean);

let body = "";
for (let i = 0; i < tlds.length; i += 12) {
  body +=
    "  " +
    tlds
      .slice(i, i + 12)
      .map((t) => JSON.stringify(t))
      .join(", ") +
    ",\n";
}

const out = `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Valid top-level domains, from the IANA root-zone database. GENERATED — do not
// hand-edit. Regenerate with: node packages/core/scripts/gen-valid-tlds.mjs
// Source: ${SRC}
// IANA version ${ver} (${date} UTC), ${tlds.length} TLDs.
//
// Used by hasValidEmailTld() to reject extraction artifacts whose domain ends in
// a non-existent TLD (e.g. a parser gluing text onto an address: "gmail.com.vous",
// "gmail.comcourriel"). Internationalized TLDs are stored in their punycode
// ("xn--") form, matching how a normalized domain presents them.
export const VALID_TLDS: ReadonlySet<string> = new Set([
${body}]);
`;

writeFileSync(OUT, out);
console.log(`Wrote ${OUT} with ${tlds.length} TLDs (IANA v${ver}).`);
