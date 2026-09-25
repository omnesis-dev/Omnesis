// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Descriptor-level icon: Enable Banking's own apple-touch-icon (180×180 PNG,
 * the black cross-and-square mark), hot-linked from enablebanking.com — the
 * asset never ships in the repo. See TRADEMARKS.md for usage notes.
 *
 * The brand mark is black-on-white; the accent is the near-black sampled
 * from it, with a neutral slate wash for dark-mode surfaces. The SF Symbol
 * is the instant-render fallback: a bank building reads "bank connection"
 * at a glance.
 */
export const enableBankingIcon: SourceIcon = {
  sfSymbol: "building.columns.fill",
  color: "#111111",
  bgColor: "#2E2E31",
  url: "https://enablebanking.com/apple-touch-icon.png",
};

/**
 * Build a per-bank instance icon URL hot-linked from Google's public favicon
 * service. The service returns the bank's own favicon as a PNG, fetched
 * server-side by the gateway's icon-normalizer at write time — no brand
 * artifact ever ships in this repo (matches how other hot-linked vendor
 * icons are handled). `sz=128` requests the largest raster the service
 * offers, which the normalizer then downscales to its target size.
 *
 * Hot-linking each bank's own domain directly is unreliable: many banks
 * serve `403` to a default Node `fetch` User-Agent (e.g. revolut.com), or
 * expose only a tiny `.ico`. The favicon service sidesteps both — it is the
 * stable, uniform source every entry below was vetted against.
 */
function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

interface KnownBank {
  /** Official domain whose favicon is the bank's mark (vetted — see icons.test.ts). */
  domain: string;
  /** Brand accent (hex). */
  color: string;
  /** Dark-mode background wash (hex). */
  bgColor: string;
}

/**
 * Per-bank instance branding for ASPSPs we recognize, keyed by the
 * normalized ASPSP name (lowercase, diacritics stripped) from `GET /aspsps`.
 * The instance icon overrides the Enable Banking descriptor icon so the
 * source card shows the actual bank.
 *
 * Every `domain` here has been vetted: its favicon-service URL returns a PNG
 * that is genuinely that bank's logo (the assertions in icons.test.ts pin
 * the vetting). Banks not listed here fall
 * back to `enableBankingIcon` — acceptable per the epic constraints.
 *
 * Keys are the bare brand stem ("societe generale", "sparkasse", "credit
 * agricole"): Enable Banking exposes brand variants and regional sub-brands
 * ("Société Générale Professionnels", "Sparkasse Köln Bonn", regional Crédit
 * Agricole caisses) whose names begin with the stem, and `bankInstanceIcon`
 * resolves those via a longest-prefix match.
 */
const KNOWN_BANKS: Record<string, KnownBank> = {
  // ── France ──────────────────────────────────────────────
  lcl: { domain: "lcl.fr", color: "#003E7E", bgColor: "#16263A" },
  "bnp paribas": { domain: "bnpparibas.fr", color: "#00965E", bgColor: "#10271F" },
  "credit agricole": { domain: "credit-agricole.fr", color: "#007D40", bgColor: "#11261A" },
  "societe generale": { domain: "sg.fr", color: "#E60028", bgColor: "#2B1316" },
  "la banque postale": { domain: "labanquepostale.fr", color: "#003B70", bgColor: "#13243A" },
  "credit mutuel": { domain: "creditmutuel.fr", color: "#E2001A", bgColor: "#2B1315" },
  "banque populaire": { domain: "banquepopulaire.fr", color: "#005DAA", bgColor: "#122A3F" },
  boursobank: { domain: "boursobank.com", color: "#FF5A00", bgColor: "#2B1A11" },
  "hello bank": { domain: "hellobank.fr", color: "#00A3A1", bgColor: "#102726" },
  fortuneo: { domain: "fortuneo.fr", color: "#E2001A", bgColor: "#2B1315" },
  // ── Germany ─────────────────────────────────────────────
  "deutsche bank": { domain: "deutsche-bank.de", color: "#0018A8", bgColor: "#121732" },
  commerzbank: { domain: "commerzbank.de", color: "#FFCC00", bgColor: "#2B2611" },
  dkb: { domain: "dkb.de", color: "#1478C8", bgColor: "#122636" },
  ing: { domain: "ing.de", color: "#FF6200", bgColor: "#2B1A11" },
  sparkasse: { domain: "sparkasse.de", color: "#E2001A", bgColor: "#2B1315" },
  n26: { domain: "n26.com", color: "#1A1A1A", bgColor: "#222222" },
  comdirect: { domain: "comdirect.de", color: "#FFF200", bgColor: "#2B2A11" },
  // ── Spain ───────────────────────────────────────────────
  santander: { domain: "santander.es", color: "#EC0000", bgColor: "#2B1313" },
  bbva: { domain: "bbva.es", color: "#004481", bgColor: "#12243A" },
  caixabank: { domain: "caixabank.es", color: "#007EAE", bgColor: "#122B36" },
  "banco sabadell": { domain: "bancsabadell.com", color: "#0089CF", bgColor: "#122B38" },
  bankinter: { domain: "bankinter.com", color: "#FF5000", bgColor: "#2B1811" },
  // ── Italy ───────────────────────────────────────────────
  "intesa sanpaolo": { domain: "intesasanpaolo.com", color: "#007D40", bgColor: "#11261A" },
  unicredit: { domain: "unicredit.it", color: "#E2001A", bgColor: "#2B1315" },
  // ── Netherlands ─────────────────────────────────────────
  "abn amro": { domain: "abnamro.nl", color: "#1E8C3C", bgColor: "#12281A" },
  rabobank: { domain: "rabobank.nl", color: "#FE6907", bgColor: "#2B1A11" },
  bunq: { domain: "bunq.com", color: "#3394D7", bgColor: "#122B38" },
  // ── United Kingdom & Ireland ────────────────────────────
  barclays: { domain: "barclays.co.uk", color: "#00AEEF", bgColor: "#122B36" },
  hsbc: { domain: "hsbc.co.uk", color: "#DB0011", bgColor: "#2B1314" },
  "lloyds bank": { domain: "lloydsbank.com", color: "#024731", bgColor: "#10261D" },
  natwest: { domain: "natwest.com", color: "#5A287D", bgColor: "#1F1430" },
  monzo: { domain: "monzo.com", color: "#FF4F40", bgColor: "#2B1716" },
  "starling bank": { domain: "starlingbank.com", color: "#6935D3", bgColor: "#1C1430" },
  "santander uk": { domain: "santander.co.uk", color: "#EC0000", bgColor: "#2B1313" },
  nationwide: { domain: "nationwide.co.uk", color: "#000B8C", bgColor: "#12132F" },
  aib: { domain: "aib.ie", color: "#A6228E", bgColor: "#2A1228" },
  "bank of ireland": { domain: "bankofireland.com", color: "#142C57", bgColor: "#121A2E" },
  "permanent tsb": { domain: "permanenttsb.ie", color: "#E8480F", bgColor: "#2B1611" },
  // ── Nordics: Sweden ─────────────────────────────────────
  seb: { domain: "seb.ee", color: "#60CD18", bgColor: "#16261A" },
  swedbank: { domain: "swedbank.com", color: "#FA5005", bgColor: "#2B1811" },
  handelsbanken: { domain: "handelsbanken.se", color: "#005AA0", bgColor: "#12283A" },
  skandiabanken: { domain: "skandia.se", color: "#009A44", bgColor: "#11281C" },
  lansforsakringar: { domain: "lansforsakringar.se", color: "#005AA0", bgColor: "#12283A" },
  // ── Nordics: Norway ─────────────────────────────────────
  dnb: { domain: "dnb.no", color: "#007272", bgColor: "#102626" },
  sbanken: { domain: "sbanken.no", color: "#1A1A2E", bgColor: "#222236" },
  // ── Nordics: Denmark ────────────────────────────────────
  nykredit: { domain: "nykredit.dk", color: "#1B3A6B", bgColor: "#121F33" },
  "jyske bank": { domain: "jyskebank.dk", color: "#003C71", bgColor: "#121F31" },
  // ── Nordics: Finland ────────────────────────────────────
  "s-pankki": { domain: "s-pankki.fi", color: "#0DAB76", bgColor: "#11281F" },
  aktia: { domain: "aktia.fi", color: "#5A2D82", bgColor: "#1D1430" },
  // ── Belgium ─────────────────────────────────────────────
  kbc: { domain: "kbc.be", color: "#003DA5", bgColor: "#121F38" },
  "bnp paribas fortis": { domain: "bnpparibasfortis.be", color: "#00965E", bgColor: "#10271F" },
  // ── Austria ─────────────────────────────────────────────
  "erste bank": { domain: "erstebank.at", color: "#2870ED", bgColor: "#122438" },
  raiffeisen: { domain: "raiffeisen.at", color: "#FFE600", bgColor: "#2B2911" },
  // ── Portugal ────────────────────────────────────────────
  "millennium bcp": { domain: "millenniumbcp.pt", color: "#E2001A", bgColor: "#2B1315" },
  // ── Poland ──────────────────────────────────────────────
  "pko bank polski": { domain: "pkobp.pl", color: "#003574", bgColor: "#121F32" },
  mbank: { domain: "mbank.pl", color: "#E2001A", bgColor: "#2B1315" },
  "bank pekao": { domain: "pekao.com.pl", color: "#E2001A", bgColor: "#2B1315" },
  // ── Pan-European neobanks ───────────────────────────────
  revolut: { domain: "revolut.com", color: "#191C1F", bgColor: "#2A2D31" },
  wise: { domain: "wise.com", color: "#9FE870", bgColor: "#1F2B16" },
};

/**
 * Normalize an ASPSP name to a lookup key: lowercase, strip diacritics
 * (Société → societe), collapse runs of whitespace. Enable Banking's names
 * carry accents and inconsistent spacing across markets, so the map keys are
 * accent-free and we normalize the incoming name the same way.
 */
function normalizeBankKey(bankName: string): string {
  return bankName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function toIcon(bank: KnownBank): SourceIcon {
  return {
    sfSymbol: "building.columns.fill",
    color: bank.color,
    bgColor: bank.bgColor,
    url: faviconUrl(bank.domain),
  };
}

/**
 * Instance icon for a connected bank.
 *
 * Resolution: normalize the ASPSP name, try an exact key match, then fall
 * back to the longest map key that is a whole-word prefix of the name. The
 * prefix step lets brand variants and regional sub-brands ("Société Générale
 * Professionnels", "Sparkasse Köln Bonn") resolve to the parent brand's
 * icon. Whole-word matching (the next char must be a space) prevents a stem
 * from matching an unrelated longer word.
 *
 * Returns the Enable Banking descriptor icon when nothing matches.
 */
export function bankInstanceIcon(bankName: string): SourceIcon {
  const key = normalizeBankKey(bankName);
  if (!key) return enableBankingIcon;

  const exact = KNOWN_BANKS[key];
  if (exact) return toIcon(exact);

  let best: { len: number; bank: KnownBank } | null = null;
  for (const [stem, bank] of Object.entries(KNOWN_BANKS)) {
    if (key.startsWith(`${stem} `) && (!best || stem.length > best.len)) {
      best = { len: stem.length, bank };
    }
  }
  return best ? toIcon(best.bank) : enableBankingIcon;
}

/** Normalized brand stems we ship icons for. Test/introspection only. */
export const KNOWN_BANK_KEYS: readonly string[] = Object.keys(KNOWN_BANKS);
