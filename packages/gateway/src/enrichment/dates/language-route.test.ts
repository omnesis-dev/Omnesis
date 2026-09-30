// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Language routing for date extraction. All snippets are invented — never
 * corpus-derived (per the repo privacy rules).
 */

import { describe, it, expect } from "vitest";
import { Culture } from "@microsoft/recognizers-text-date-time";

import { routeDateCulture, ENGLISH_CULTURE } from "./language-route.js";

describe("routeDateCulture — supported languages route to their culture", () => {
  it("routes a French booking email to the French culture", () => {
    expect(
      routeDateCulture(
        "Confirmation de réservation",
        "Bonjour, votre séjour est confirmé pour le 30 septembre 2027. Le contrat expire dans 3 ans. À bientôt.",
      ),
    ).toBe("fr-fr");
  });

  it("routes a Spanish appointment reminder to the Spanish culture", () => {
    expect(
      routeDateCulture(
        "Recordatorio de cita",
        "Le recordamos su cita el martes 30 de septiembre de 2027 a las 10:30. El contrato expira en 3 años.",
      ),
    ).toBe("es-es");
  });

  it("routes a Chinese meeting notice to the Chinese culture", () => {
    expect(routeDateCulture("会议通知", "项目会议定于2027年9月30日举行，请准时参加。")).toBe(
      "zh-cn",
    );
  });

  it("routes English to the English culture", () => {
    expect(
      routeDateCulture("Meeting", "let us meet tomorrow to review the quarterly numbers"),
    ).toBe("en-us");
  });
});

describe("routeDateCulture — every document reaches a culture", () => {
  // Detection chooses only among the languages with a date-time model, so no
  // document is skipped. English mail thick with tracking links and markup —
  // which unrestricted detection reads as Klingon, Berber or Latin — stays
  // English.
  it("reads a link-heavy English notification as English", () => {
    const links = Array.from(
      { length: 12 },
      (_, index) =>
        `https://links.example.com/ls/click?upn=${"u001".repeat(20)}${index}&amp;utm_source=digest`,
    ).join("\n");
    expect(
      routeDateCulture(
        "Your weekly digest",
        `${links}\nYou have 5 new invitations waiting. See who viewed your profile this week.\n${links}`,
      ),
    ).toBe("en-us");
  });

  it("routes a language without a model to a supported culture rather than skipping it", () => {
    expect(
      routeDateCulture(
        "Zahlungserinnerung",
        "Wir erinnern daran, dass die angegebene Rechnung bis zum 30. September fällig ist. " +
          "Bitte überweisen Sie den offenen Betrag auf das genannte Konto.",
      ),
    ).not.toBeNull();
  });

  it("reads English numeric dates day-first when asked", () => {
    expect(
      routeDateCulture("Meeting", "let us meet tomorrow to review the numbers", "day-first"),
    ).toBe("en-*");
    expect(
      routeDateCulture(
        "Réunion",
        "Bonjour, la réunion est confirmée pour le 30 septembre.",
        "day-first",
      ),
    ).toBe("fr-fr");
  });
});

describe("routeDateCulture — uncertain / short text defaults to English", () => {
  it.each([
    ["Re: quick question", ""],
    ["ok", ""],
    ["FYI", "fwd"],
    ["", ""],
  ])("defaults %j to English", (title, content) => {
    expect(routeDateCulture(title, content)).toBe(ENGLISH_CULTURE);
  });

  it("defaults a low-confidence mixed-language subject to English", () => {
    expect(routeDateCulture("Invoice due in 3 days", "")).toBe(ENGLISH_CULTURE);
  });
});

describe("routeDateCulture — detection is bounded to the text head", () => {
  it("routes on the first ~2000 chars even when a long tail is in another language", () => {
    const frenchHead =
      "Bonjour, votre séjour est confirmé pour le 30 septembre 2027. Merci de votre confiance. ".repeat(
        30,
      );
    const germanTail = "Die angegebene Rechnung ist fällig bis zum 30. September. ".repeat(200);
    expect(routeDateCulture("Confirmation", frenchHead + germanTail)).toBe("fr-fr");
  });
});

describe("culture codes match the recognizers-text constants (drift guard)", () => {
  it("pins the literal codes to the library's supported cultures", () => {
    // The package's declaration omits these runtime fields from its Culture subtype.
    const cultures = Culture.supportedCultures as unknown as readonly {
      cultureName: string;
      cultureCode: string;
    }[];
    const codes = new Map(cultures.map((culture) => [culture.cultureName, culture.cultureCode]));
    expect(ENGLISH_CULTURE).toBe(codes.get("English"));
    expect<string>("fr-fr").toBe(codes.get("French"));
    expect<string>("es-es").toBe(codes.get("Spanish"));
    expect<string>("zh-cn").toBe(codes.get("Chinese"));
  });
});
