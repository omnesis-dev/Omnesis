// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";

import {
  anchorFromIso,
  extractDatesForDocs,
  extractDatesFromText,
  neutralizeDenseSpans,
  scanDatesFromText,
} from "./extractor.js";

/** Emission date used across the anchored cases: 2022-01-21 (a Friday). */
const ANCHOR_ISO = "2022-01-21T10:00:00.000Z";
const anchor = anchorFromIso(ANCHOR_ISO)!;

function extract(text: string) {
  return extractDatesFromText(text, anchor);
}

describe("extractDatesFromText — anchored, canonical, year-resolved", () => {
  it("resolves 'tomorrow' against the emission date to a canonical day", () => {
    const dates = extract("we should meet up again tomorrow");
    expect(dates).toHaveLength(1);
    expect(dates[0].kind).toBe("date");
    expect(dates[0].resolvedStart).toBe("2022-01-22");
    expect(dates[0].relative).toBe(true);
  });

  it("resolves 'next tuesday' to the upcoming Tuesday", () => {
    expect(extract("Let's meet next tuesday")[0].resolvedStart).toBe("2022-01-25");
  });

  it("keeps a bare year at YEAR granularity", () => {
    const dates = extract("our target is 2026");
    expect(dates).toHaveLength(1);
    expect(dates[0].resolvedStart).toBe("2026");
  });

  it("keeps a month+year at MONTH granularity", () => {
    const dates = extract("the launch is in August 2024");
    expect(dates.map((d) => d.resolvedStart)).toContain("2024-08");
  });

  it("resolves a forward duration to a YEAR ('expires in 3 years')", () => {
    const dates = extract("Your warranty expires in 3 years");
    expect(dates.map((d) => d.resolvedStart)).toContain("2025");
  });

  it("captures an open-ended deadline as a range with a mod", () => {
    const dates = extract("You must cancel the subscription before 8/04/2024");
    expect(dates).toHaveLength(1);
    expect(dates[0].kind).toBe("range");
    expect(dates[0].mod).toBe("before");
    expect(dates[0].resolvedEnd).toBe("2024-08-04");
    expect(dates[0].resolvedStart).toBeNull();
  });

  // ── the precision rules ────────────────────────────────────────────────
  it("resolves a month-day with no year forward from the anchor ('August 29')", () => {
    const dates = extract("let's meet August 29");
    expect(dates.map((d) => d.resolvedStart)).toContain("2022-08-29");
    // The adopted year is an anchor resolution — flagged like "tomorrow".
    expect(dates[0].relative).toBe(true);
  });

  it("resolves a bare month name to a MONTH point, forward from the anchor", () => {
    // Same shape as a concrete "May 2022" — the two spellings of one month
    // share a representation (and so a dedupe key).
    const dates = extract("see you in May");
    expect(dates).toHaveLength(1);
    expect(dates[0].kind).toBe("date");
    expect(dates[0].resolvedStart).toBe("2022-05");
    expect(dates[0].resolvedEnd).toBeNull();
    expect(dates[0].relative).toBe(true);
  });

  it("a year-less date already past this year resolves to the NEXT occurrence", () => {
    // Anchored in June: "March 3" has passed, so the nearest forward
    // occurrence is next year's.
    const june = anchorFromIso("2026-06-08T09:00:00.000Z")!;
    const dates = extractDatesFromText("the reunion is on March 3", june);
    expect(dates.map((d) => d.resolvedStart)).toContain("2027-03-03");
  });

  it("DROPS a bare day-of-month with no month ('on the 23rd')", () => {
    // XXXX-XX-23: month unknown too — nothing concrete to anchor.
    expect(extract("payment lands on the 23rd")).toEqual([]);
  });

  it("DROPS a recurrence ('every Monday')", () => {
    expect(extract("standup every monday")).toEqual([]);
  });

  it("DROPS an ambient duration with no direction ('took 3 years')", () => {
    expect(extract("the project took 3 years to finish")).toEqual([]);
  });

  it("every stored date carries a year (YYYY | YYYY-MM | YYYY-MM-DD)", () => {
    const dates = extract(
      "meet tomorrow, target 2026, launch August 2024, cancel before 8/04/2024, and August 29 with no year",
    );
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) {
      for (const v of [d.resolvedStart, d.resolvedEnd]) {
        if (v !== null) expect(v).toMatch(/^\d{4}(-\d{2}(-\d{2})?)?$/);
      }
    }
  });
});

describe("extractDatesFromText — emission-day drop + dedupe", () => {
  it("drops the document's own emission-day date (email header), keeps future refs", () => {
    // A rendered email header line carries the emission date; "tomorrow" is the
    // real signal.
    const dates = extract("Date: Fri, 21 Jan 2022 16:00:00 +0000\nLet's meet tomorrow.");
    expect(dates.map((d) => d.resolvedStart)).toEqual(["2022-01-22"]);
  });

  it("dedupes the same resolved date mentioned twice", () => {
    const dates = extract("let's do it next tuesday — yes, next tuesday works");
    expect(dates).toHaveLength(1);
    expect(dates[0].resolvedStart).toBe("2022-01-25");
  });

  it("returns nothing for text with no dates", () => {
    expect(extract("no dates here at all, just some ordinary words")).toEqual([]);
    expect(extract("")).toEqual([]);
  });
});

describe("anchor independence", () => {
  it("resolves the same relative phrase differently per anchor", () => {
    const a1 = anchorFromIso("2022-01-21T00:00:00Z")!;
    const a2 = anchorFromIso("2030-06-01T00:00:00Z")!;
    expect(extractDatesFromText("see you tomorrow", a1)[0].resolvedStart).toBe("2022-01-22");
    expect(extractDatesFromText("see you tomorrow", a2)[0].resolvedStart).toBe("2030-06-02");
  });
});

describe("anchorFromIso", () => {
  it("pins to the UTC calendar day regardless of clock time", () => {
    const a = anchorFromIso("2022-01-21T23:59:59.000Z")!;
    expect([a.getFullYear(), a.getMonth(), a.getDate()]).toEqual([2022, 0, 21]);
  });
  it("returns null for an unparseable timestamp", () => {
    expect(anchorFromIso("not-a-date")).toBeNull();
  });
});

describe("extractDatesForDocs — batch handler", () => {
  it("extracts per row against each row's own emission date", () => {
    const out = extractDatesForDocs([
      { id: "a", title: "msg", content: "meet tomorrow", anchorAt: "2022-01-21T10:00:00Z" },
      { id: "b", title: "msg", content: "meet tomorrow", anchorAt: "2030-06-01T10:00:00Z" },
      {
        id: "c",
        title: "msg",
        content: "just words, nothing temporal",
        anchorAt: "2022-01-21T10:00:00Z",
      },
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out[0].dates[0].resolvedStart).toBe("2022-01-22");
    expect(out[1].dates[0].resolvedStart).toBe("2030-06-02");
    expect(out[2].dates).toEqual([]);
  });

  it("yields an empty list for an unparseable emission date rather than throwing", () => {
    expect(
      extractDatesForDocs([
        { id: "x", title: "msg", content: "meet tomorrow", anchorAt: "garbage" },
      ]),
    ).toEqual([{ id: "x", dates: [], truncated: false }]);
  });
});

// ── language-routed extraction ─────────────────────────────────────────────
// All snippets are invented — never corpus-derived (per the repo privacy
// rules). Emission anchor for the routed cases: 2024-06-15 (a Saturday).
const ROUTED_ANCHOR_ISO = "2024-06-15T10:00:00.000Z";
const routedAnchor = anchorFromIso(ROUTED_ANCHOR_ISO)!;

describe("extractDatesFromText — routed cultures", () => {
  it("French: extracts a day-precision date English-only misses", () => {
    const text = "Votre réservation est confirmée pour le 30 septembre 2027.";
    const fr = extractDatesFromText(text, routedAnchor, {}, "fr-fr");
    expect(fr.map((d) => d.resolvedStart)).toContain("2027-09-30");
    // English-only sees only the bare "2027" — no day precision.
    const en = extractDatesFromText(text, routedAnchor);
    expect(en.map((d) => d.resolvedStart)).not.toContain("2027-09-30");
  });

  it("French: resolves a forward duration ('expire dans 3 ans') English-only misses entirely", () => {
    const text = "Le contrat expire dans 3 ans.";
    const fr = extractDatesFromText(text, routedAnchor, {}, "fr-fr");
    expect(fr.map((d) => d.resolvedStart)).toContain("2027"); // anchor + P3Y, year granularity
    expect(extractDatesFromText(text, routedAnchor)).toEqual([]);
  });

  it("French: resolves a backward duration ('il y a 3 ans')", () => {
    const fr = extractDatesFromText("On s'était vus il y a 3 ans.", routedAnchor, {}, "fr-fr");
    expect(fr.map((d) => d.resolvedStart)).toContain("2021");
  });

  it("French: marks anchored expressions relative and extracts without any digit in the text", () => {
    const fr = extractDatesFromText("On se voit mardi prochain ?", routedAnchor, {}, "fr-fr");
    expect(fr).toHaveLength(1);
    expect(fr[0].resolvedStart).toBe("2024-06-18");
    expect(fr[0].relative).toBe(true);
  });

  it("Spanish: extracts absolute dates and forward durations", () => {
    const es = extractDatesFromText(
      "La cita es el 30 de septiembre de 2027. El contrato expira en 3 años.",
      routedAnchor,
      {},
      "es-es",
    );
    expect(es.map((d) => d.resolvedStart)).toContain("2027-09-30");
    expect(es.map((d) => d.resolvedStart)).toContain("2027");
  });

  it("Spanish: resolves a backward duration ('hace 3 años')", () => {
    const es = extractDatesFromText("Nos mudamos hace 3 años.", routedAnchor, {}, "es-es");
    expect(es.map((d) => d.resolvedStart)).toContain("2021");
  });

  it("Chinese: extracts absolute and anchored-relative dates", () => {
    const zh = extractDatesFromText("项目会议定于2027年9月30日举行。", routedAnchor, {}, "zh-cn");
    expect(zh.map((d) => d.resolvedStart)).toContain("2027-09-30");
    const rel = extractDatesFromText("我们3年后再见。", routedAnchor, {}, "zh-cn");
    expect(rel.map((d) => d.resolvedStart)).toContain("2027-06-15");
  });

  it("routed cultures resolve a year-less month-day against the anchor too", () => {
    const dates = extractDatesFromText("on se voit le 29 août", routedAnchor, {}, "fr-fr");
    expect(dates.map((d) => d.resolvedStart)).toContain("2024-08-29");
  });
});

describe("extractDatesForDocs — routes each row by its detected language", () => {
  it("French rows extract under the French culture; unsupported languages record zero dates", () => {
    const out = extractDatesForDocs([
      {
        id: "fr",
        title: "Confirmation de réservation",
        content:
          "Bonjour, votre séjour est confirmé pour le 30 septembre 2027. Le contrat expire dans 3 ans. À bientôt.",
        anchorAt: ROUTED_ANCHOR_ISO,
      },
      {
        id: "de",
        title: "Zahlungserinnerung",
        content:
          "Wir erinnern daran, dass die angegebene Rechnung bis zum 30. September fällig ist. " +
          "Bitte überweisen Sie den offenen Betrag auf das genannte Konto.",
        anchorAt: ROUTED_ANCHOR_ISO,
      },
      {
        id: "en",
        title: "Meeting",
        content: "let us meet tomorrow to review the quarterly numbers",
        anchorAt: ROUTED_ANCHOR_ISO,
      },
    ]);
    expect(out.map((r) => r.id)).toEqual(["fr", "de", "en"]);
    expect(out[0].dates.map((d) => d.resolvedStart)).toEqual(
      expect.arrayContaining(["2027-09-30", "2027"]),
    );
    // German is confidently detected but has no JS recognizer culture: the
    // row is skipped — zero dates, yet still present in the results so the
    // writer stamps dates_extracted_at and never rescans it.
    expect(out[1].dates).toEqual([]);
    expect(out[2].dates.map((d) => d.resolvedStart)).toEqual(["2024-06-16"]);
  });
});

/**
 * The year-less human convention. People write planning documents without
 * years: "Sunday 16/08", "16 au 23 août". The recognizer resolves those to
 * an `XXXX`-year TIMEX alongside concrete candidate dates anchored on the
 * document's own timestamp; the extractor adopts the nearest-forward
 * candidate's year instead of dropping the phrase. The year-ful controls
 * beside each case prove the recognizer parses the construction at all, so
 * a failure here means the year rule broke, not the parser.
 */
describe("year-less dates resolve against the anchor", () => {
  const FRENCH_CULTURE = "fr-fr" as const;
  const anchor = anchorFromIso("2026-06-08T09:00:00Z")!;

  it("control: the same French range WITH a year is recognized", () => {
    const dates = extractDatesFromText("Séjour du 16 au 23 août 2026", anchor, {}, FRENCH_CULTURE);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
  });

  it("a French day-month range without a year is kept, not dropped", () => {
    const dates = extractDatesFromText("Séjour du 16 au 23 août", anchor, {}, FRENCH_CULTURE);
    const starts = dates.map((d) => d.resolvedStart);
    expect(starts).toContain("2026-08-16");
  });

  it("control: the same numeric form WITH a year is recognized", () => {
    const dates = extractDatesFromText("Départ le 16/08/2026 au matin", anchor, {}, FRENCH_CULTURE);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
  });

  it("a French numeric day/month without a year is kept, not dropped", () => {
    const dates = extractDatesFromText("Départ le 16/08 au matin", anchor, {}, FRENCH_CULTURE);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
  });

  it("an English month-day without a year is kept, not dropped", () => {
    const dates = extractDatesFromText("The workshop moved to August 16.", anchor);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
  });
});

describe("dense-span neutralization and the scan budget", () => {
  const anchor = anchorFromIso("2026-06-08T09:00:00.000Z")!;

  it("blanks long digit tables and URLs, preserving length and real dates", () => {
    const statementRows = Array.from(
      { length: 8 },
      (_, i) => `4321 0098 7654 12${i}0   -42.${i}0   1 002.${i}5   0.0${i}`,
    ).join("\n");
    const text = `Statement of account\n${statementRows}\nReview due on August 16.\nSee https://example.org/statements/2024/01?id=99887766 for detail.`;
    const neutral = neutralizeDenseSpans(text);
    expect(neutral).toHaveLength(text.length);
    // The table's digits are gone; the prose date and its offsets survive.
    expect(neutral).not.toContain("4321 0098");
    expect(neutral).toContain("Review due on August 16.");
    expect(neutral).not.toContain("https://example.org");
    // Newlines survive blanking (chunking splits on them).
    expect(neutral.split("\n")).toHaveLength(text.split("\n").length);

    const dates = extractDatesFromText(text, anchor);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
    // The card-number soup produced no date rows.
    expect(dates.every((d) => !d.text.includes("4321"))).toBe(true);
  });

  it("keeps a short date phrase that sits inside punctuation-heavy prose", () => {
    const text = "Le séjour (du 16 au 23 août 2026, réf. 00-1122) est confirmé.";
    const dates = extractDatesFromText(text, anchor, {}, "fr-fr");
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-08-16");
  });

  it("finds a date far past the first chunk (chunked scan covers the whole cap)", () => {
    const filler = "The workshop notes continue with plain prose. ".repeat(200); // ~9k chars
    const text = `${filler}The retreat is confirmed for 2026-09-14.`;
    const dates = extractDatesFromText(text, anchor);
    expect(dates.map((d) => d.resolvedStart)).toContain("2026-09-14");
  });

  it("a French day-plan finds dates in every chunk of a multi-chunk doc", () => {
    // Date-dense French prose is the recognizer's slowest input; the chunked
    // scan must still cover a day-plan style doc end to end. Build ~6.2k
    // chars of invented itinerary whose last entry sits past char 6000.
    const day =
      "Départ 9h30 du gîte, visite du marché de la place, déjeuner à 12h30 au café du pont, randonnée l'après-midi vers le lac, dîner 19h30. ";
    const filler = day.repeat(46); // ~6.2k chars, time-of-day only — no date rows
    const text = `Réunion le 3 mars 2027 pour préparer.\n${filler}\nRetour prévu le 12 avril 2027 au soir.`;
    const scan = scanDatesFromText(text, anchor, { scanBudgetMs: 60_000 }, "fr-fr");
    expect(scan.dates.map((d) => d.resolvedStart)).toContain("2027-03-03");
    expect(scan.dates.map((d) => d.resolvedStart)).toContain("2027-04-12");
  });

  it("a date inside the overlap window is matched by both chunks and stored once", () => {
    // Chunk 1 covers [0,2000), chunk 2 starts at 1872: a date placed at
    // ~1952 sits whole in BOTH windows, so only value-keyed dedup keeps the
    // row count at one. Trailing filler pushes the total length past 2000
    // so a second chunk actually exists.
    const pad = "x".repeat(1940) + "\n";
    const text = `${pad}meeting on 2026-10-05 confirmed ${"x".repeat(60)}`;
    const dates = extractDatesFromText(text, anchor);
    expect(dates.filter((d) => d.resolvedStart === "2026-10-05")).toHaveLength(1);
  });

  it("a date split by a hard chunk cut yields the real date and no phantom coarse one", () => {
    // Place the date across char 2000 so chunk 1's view ends mid-phrase
    // ("…on 2026-10" — the date starts at char 1993). The partial match
    // touches the cut edge and is dropped; chunk 2 re-covers the region
    // whole and supplies the genuine day — so no October month row the
    // document never asserts is stored, as point or as range.
    const pad = "x".repeat(1981) + "\n";
    const text = `${pad}meeting on 2026-10-05 confirmed`;
    const dates = extractDatesFromText(text, anchor);
    expect(dates.filter((d) => d.resolvedStart === "2026-10-05")).toHaveLength(1);
    expect(dates.filter((d) => d.resolvedStart?.startsWith("2026-10"))).toHaveLength(1);
  });

  it("an exhausted budget keeps the early dates and reports itself", () => {
    const filler = "Plain prose without any dated content in this sentence. ".repeat(400); // ~22k
    const text = `Kickoff on 2026-07-01.\n${filler}\nFinale on 2026-12-24.`;
    const scan = scanDatesFromText(text, anchor, { scanBudgetMs: 0 });
    // Only the first chunk ran: the early date is kept, the late one unseen.
    expect(scan.budgetExhausted).toBe(true);
    expect(scan.dates.map((d) => d.resolvedStart)).toContain("2026-07-01");
    expect(scan.dates.map((d) => d.resolvedStart)).not.toContain("2026-12-24");

    const full = scanDatesFromText(text, anchor, {});
    expect(full.budgetExhausted).toBe(false);
    expect(full.dates.map((d) => d.resolvedStart)).toContain("2026-12-24");
  });

  it("extractDatesForDocs folds budget exhaustion into the truncated flag", () => {
    const filler = "Plain prose without any dated content in this sentence. ".repeat(400);
    const out = extractDatesForDocs(
      [
        {
          id: "budgeted",
          title: "notes",
          content: `Kickoff on 2026-07-01.\n${filler}`,
          anchorAt: "2026-06-08T09:00:00.000Z",
        },
      ],
      { scanBudgetMs: 0 },
    );
    expect(out[0].truncated).toBe(true);
    expect(out[0].dates.map((d) => d.resolvedStart)).toContain("2026-07-01");
  });
});
