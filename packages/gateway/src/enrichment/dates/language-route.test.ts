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

describe("routeDateCulture — languages without a recognizer culture SKIP", () => {
  // The JS build of @microsoft/recognizers-text-date-time registers models
  // for en/fr/es/zh only. A confident detection outside that set must return
  // null — parsing with a wrong culture would produce noise.
  it("returns null for a German invoice", () => {
    expect(
      routeDateCulture(
        "Zahlungserinnerung",
        "Wir erinnern daran, dass die angegebene Rechnung bis zum 30. September fällig ist. " +
          "Bitte überweisen Sie den offenen Betrag auf das genannte Konto.",
      ),
    ).toBeNull();
  });

  it("returns null for Finnish", () => {
    expect(
      routeDateCulture(
        "Kokouskutsu",
        "Kokous on siirretty ensi viikolle, pahoittelut myöhäisestä ilmoituksesta.",
      ),
    ).toBeNull();
  });

  it("returns null for Japanese (the base library exports the culture code, the date-time build has no model)", () => {
    expect(
      routeDateCulture("会議のお知らせ", "会議は9月30日に予定されています。ご確認ください。"),
    ).toBeNull();
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
