// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { KNOWN_BANK_KEYS, bankInstanceIcon, enableBankingIcon } from "./icons.js";

const FAVICON_PREFIX = "https://www.google.com/s2/favicons?domain=";

describe("bankInstanceIcon", () => {
  it("resolves the motivating example (LCL) to a bank-specific icon", () => {
    const icon = bankInstanceIcon("LCL");
    expect(icon.url).toBe(`${FAVICON_PREFIX}lcl.fr&sz=128`);
    expect(icon).not.toEqual(enableBankingIcon);
  });

  it("matches the ASPSP name case-insensitively", () => {
    expect(bankInstanceIcon("revolut")).toEqual(bankInstanceIcon("Revolut"));
    expect(bankInstanceIcon("REVOLUT").url).toBe(`${FAVICON_PREFIX}revolut.com&sz=128`);
  });

  it("strips diacritics so accented ASPSP names resolve", () => {
    // "Société Générale" → key "societe generale".
    const icon = bankInstanceIcon("Société Générale");
    expect(icon.url).toBe(`${FAVICON_PREFIX}sg.fr&sz=128`);
  });

  it("collapses irregular whitespace in the ASPSP name", () => {
    const icon = bankInstanceIcon("  BNP   Paribas  ");
    expect(icon.url).toBe(`${FAVICON_PREFIX}bnpparibas.fr&sz=128`);
  });

  it("resolves brand variants via a whole-word prefix match", () => {
    // Enable Banking exposes "Société Générale Professionnels" as a distinct
    // ASPSP; it should inherit the Société Générale icon.
    const variant = bankInstanceIcon("Société Générale Professionnels");
    expect(variant.url).toBe(`${FAVICON_PREFIX}sg.fr&sz=128`);
  });

  it("resolves regional sub-brands via prefix (Sparkasse, Crédit Agricole)", () => {
    expect(bankInstanceIcon("Sparkasse Köln Bonn").url).toBe(
      `${FAVICON_PREFIX}sparkasse.de&sz=128`,
    );
    expect(bankInstanceIcon("Crédit Agricole Centre-est").url).toBe(
      `${FAVICON_PREFIX}credit-agricole.fr&sz=128`,
    );
  });

  it("prefers the longest matching stem when several prefix-match", () => {
    // "banco sabadell …" must win over a hypothetical shorter "banco" stem;
    // here it confirms the exact two-word stem resolves, not a partial.
    expect(bankInstanceIcon("Banco Sabadell").url).toBe(`${FAVICON_PREFIX}bancsabadell.com&sz=128`);
  });

  it("does not match a stem that is only a partial word", () => {
    // "wiser-bank" must NOT match the "wise" stem (no word boundary).
    const icon = bankInstanceIcon("Wiser Investment Bank");
    expect(icon).toEqual(enableBankingIcon);
  });

  it("resolves Nordic ASPSPs added in the coverage widening", () => {
    expect(bankInstanceIcon("SEB").url).toBe(`${FAVICON_PREFIX}seb.ee&sz=128`);
    expect(bankInstanceIcon("Swedbank").url).toBe(`${FAVICON_PREFIX}swedbank.com&sz=128`);
    expect(bankInstanceIcon("Handelsbanken").url).toBe(`${FAVICON_PREFIX}handelsbanken.se&sz=128`);
    expect(bankInstanceIcon("DNB").url).toBe(`${FAVICON_PREFIX}dnb.no&sz=128`);
    expect(bankInstanceIcon("Jyske Bank").url).toBe(`${FAVICON_PREFIX}jyskebank.dk&sz=128`);
  });

  it("uses logo-bearing domains for banks whose primary domain returns the favicon-service globe", () => {
    // Regression guard (#732): the favicon service returns its generic globe
    // placeholder (HTTP 404, identical 16×16 PNG) for `societegenerale.fr`
    // and `sebgroup.com`. The vetted logo-bearing domains are `sg.fr`
    // (Société Générale red/black square) and `seb.ee` (SEB "S|E|B" mark —
    // the Baltic site serves the group logo at 128×128). Do not revert these
    // to the bare French/group domains.
    expect(bankInstanceIcon("Société Générale").url).toBe(`${FAVICON_PREFIX}sg.fr&sz=128`);
    expect(bankInstanceIcon("SEB").url).toBe(`${FAVICON_PREFIX}seb.ee&sz=128`);
  });

  it("resolves a hyphenated stem key (S-Pankki) exactly", () => {
    // The normalizer does not split on hyphens, so the key must match the
    // hyphenated brand stem verbatim.
    expect(bankInstanceIcon("S-Pankki").url).toBe(`${FAVICON_PREFIX}s-pankki.fi&sz=128`);
  });

  it("resolves Ireland / Belgium / Austria / Portugal / Poland retail banks", () => {
    expect(bankInstanceIcon("Bank of Ireland").url).toBe(
      `${FAVICON_PREFIX}bankofireland.com&sz=128`,
    );
    expect(bankInstanceIcon("KBC").url).toBe(`${FAVICON_PREFIX}kbc.be&sz=128`);
    expect(bankInstanceIcon("Erste Bank").url).toBe(`${FAVICON_PREFIX}erstebank.at&sz=128`);
    expect(bankInstanceIcon("Millennium BCP").url).toBe(`${FAVICON_PREFIX}millenniumbcp.pt&sz=128`);
    expect(bankInstanceIcon("PKO Bank Polski").url).toBe(`${FAVICON_PREFIX}pkobp.pl&sz=128`);
  });

  it("distinguishes Santander UK from Santander (Spain) by the whole-word prefix", () => {
    // "santander uk" is an exact key; bare "Santander" stays the Spanish entry.
    expect(bankInstanceIcon("Santander UK").url).toBe(`${FAVICON_PREFIX}santander.co.uk&sz=128`);
    expect(bankInstanceIcon("Santander").url).toBe(`${FAVICON_PREFIX}santander.es&sz=128`);
  });

  it("resolves a Nordic regional sub-brand via the whole-word prefix match", () => {
    // Enable Banking exposes regional Sparkasse-style sub-brands; a Handelsbanken
    // regional name should inherit the parent icon.
    expect(bankInstanceIcon("Handelsbanken Sverige").url).toBe(
      `${FAVICON_PREFIX}handelsbanken.se&sz=128`,
    );
  });

  it("falls back to the Enable Banking icon for an unknown bank", () => {
    expect(bankInstanceIcon("Example Bank")).toEqual(enableBankingIcon);
  });

  it("falls back to the Enable Banking icon for empty / whitespace input", () => {
    expect(bankInstanceIcon("")).toEqual(enableBankingIcon);
    expect(bankInstanceIcon("   ")).toEqual(enableBankingIcon);
  });

  it("returns a complete SourceIcon for every known bank", () => {
    for (const key of KNOWN_BANK_KEYS) {
      const icon = bankInstanceIcon(key);
      expect(icon.sfSymbol, key).toBeTruthy();
      expect(icon.color, key).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(icon.bgColor, key).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(icon.url, key).toMatch(/^https:\/\/www\.google\.com\/s2\/favicons\?domain=.+&sz=128$/);
    }
  });

  it("ships a non-trivial catalogue of vetted banks", () => {
    // Guards against an accidental truncation of the map.
    expect(KNOWN_BANK_KEYS.length).toBeGreaterThanOrEqual(55);
  });
});
