// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  cleanPersonName,
  countryNameToISO2,
  deriveAuthor,
  extractEmailsAndPhonesFromText,
  normalizeEmail,
  isNonIdentifyingEmail,
  isAutomatedSenderAddress,
  hasValidEmailTld,
  normalizePhone,
  looksLikePhone,
  isPlaceholderPersonName,
  parseEmailHeader,
  splitEmailList,
  extractEmailsFromText,
  extractPhonesFromText,
  setDefaultPhoneRegion,
} from "./people-utils.js";
import type { PersonMention } from "./document.js";

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  John@Example.COM  ")).toBe("john@example.com");
  });

  test("strips angle brackets", () => {
    expect(normalizeEmail("<john@example.com>")).toBe("john@example.com");
  });

  test("already clean email passes through", () => {
    expect(normalizeEmail("user@test.org")).toBe("user@test.org");
  });

  test("strips dots from Gmail local part", () => {
    expect(normalizeEmail("vance.car.75@gmail.com")).toBe("vancecar75@gmail.com");
    expect(normalizeEmail("va.nce.car.75@gmail.com")).toBe("vancecar75@gmail.com");
  });

  test("strips +suffix from Gmail", () => {
    expect(normalizeEmail("user+tag@gmail.com")).toBe("user@gmail.com");
  });

  test("strips dots and +suffix combined for Gmail", () => {
    expect(normalizeEmail("a.b.c+test@gmail.com")).toBe("abc@gmail.com");
  });

  test("does not strip dots for non-Gmail domains", () => {
    expect(normalizeEmail("first.last@company.com")).toBe("first.last@company.com");
  });

  test("handles googlemail.com the same as gmail.com", () => {
    expect(normalizeEmail("a.b@googlemail.com")).toBe("ab@googlemail.com");
  });
});

describe("isNonIdentifyingEmail", () => {
  test("flags bare noreply local part", () => {
    expect(isNonIdentifyingEmail("noreply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("NoReply@Example.com")).toBe(true);
  });

  test("flags donotreply / do-not-reply variants", () => {
    expect(isNonIdentifyingEmail("donotreply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("do-not-reply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("do.not.reply@example.com")).toBe(true);
  });

  test("flags no-reply / no.reply (separated reply chunk)", () => {
    expect(isNonIdentifyingEmail("no-reply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("no.reply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("no_reply@example.com")).toBe(true);
  });

  test("flags reply-routing firehose addresses (hit-reply, auto-reply, bare reply)", () => {
    expect(isNonIdentifyingEmail("hit-reply@linkedin.com")).toBe(true);
    expect(isNonIdentifyingEmail("auto-reply@example.com")).toBe(true);
    expect(isNonIdentifyingEmail("reply@example.com")).toBe(true);
  });

  test("flags invitation-fanout senders", () => {
    expect(isNonIdentifyingEmail("invitations@linkedin.com")).toBe(true);
    expect(isNonIdentifyingEmail("invitation@example.com")).toBe(true);
  });

  test("flags prefixed firehose addresses (Google Docs, LinkedIn, etc.)", () => {
    expect(isNonIdentifyingEmail("comments-noreply@docs.google.com")).toBe(true);
    expect(isNonIdentifyingEmail("notifications-noreply@linkedin.com")).toBe(true);
    expect(isNonIdentifyingEmail("calendar-noreply@google.com")).toBe(true);
    expect(isNonIdentifyingEmail("docs.no-reply@google.com")).toBe(true);
  });

  test("does not flag look-alikes that lack an isolated reply/noreply chunk", () => {
    expect(isNonIdentifyingEmail("replytojamesbond@example.com")).toBe(false);
    expect(isNonIdentifyingEmail("marco.replyman@example.com")).toBe(false);
    expect(isNonIdentifyingEmail("noreplay@example.com")).toBe(false);
    expect(isNonIdentifyingEmail("repliesnow@example.com")).toBe(false);
  });

  test("does not flag normal personal addresses", () => {
    expect(isNonIdentifyingEmail("james.bond@example.com")).toBe(false);
    expect(isNonIdentifyingEmail("first.last@company.com")).toBe(false);
    expect(isNonIdentifyingEmail("a@b.com")).toBe(false);
  });

  test("returns false for malformed input", () => {
    expect(isNonIdentifyingEmail("")).toBe(false);
    expect(isNonIdentifyingEmail("no-at-sign")).toBe(false);
    expect(isNonIdentifyingEmail("@no-local-part.com")).toBe(false);
  });

  test("ignores domain-only matches (local part is identifying)", () => {
    expect(isNonIdentifyingEmail("jamesbond@noreply.example.com")).toBe(false);
  });
});

describe("isAutomatedSenderAddress", () => {
  test("flags no-reply sender local parts", () => {
    expect(isAutomatedSenderAddress("noreply@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("no-reply@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("do-not-reply@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("NoReply@Example.com")).toBe(true);
  });

  test("flags notification-fanout senders (the CI/build-notification case)", () => {
    expect(isAutomatedSenderAddress("notifications@github.example.com")).toBe(true);
    expect(isAutomatedSenderAddress("notification@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("notify@example.com")).toBe(true);
  });

  test("flags delivery-daemon / bounce senders", () => {
    expect(isAutomatedSenderAddress("mailer-daemon@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("postmaster@example.com")).toBe(true);
    expect(isAutomatedSenderAddress("bounces+abc@example.com")).toBe(true);
  });

  test("does not flag genuine personal or monitored role addresses", () => {
    expect(isAutomatedSenderAddress("maya@example.com")).toBe(false);
    expect(isAutomatedSenderAddress("bob.smith@example.com")).toBe(false);
    expect(isAutomatedSenderAddress("sales@example.com")).toBe(false);
    expect(isAutomatedSenderAddress("notifyme.now@example.com")).toBe(false);
  });

  test("returns false for malformed input", () => {
    expect(isAutomatedSenderAddress("")).toBe(false);
    expect(isAutomatedSenderAddress("no-at-sign")).toBe(false);
    expect(isAutomatedSenderAddress("@no-local-part.com")).toBe(false);
  });
});

describe("hasValidEmailTld", () => {
  test("accepts real TLDs (gTLD, ccTLD, multi-label, newer gTLD)", () => {
    expect(hasValidEmailTld("maya@example.com")).toBe(true);
    expect(hasValidEmailTld("maya@example.org")).toBe(true);
    expect(hasValidEmailTld("maya@example.co.uk")).toBe(true);
    expect(hasValidEmailTld("maya@host.example.io")).toBe(true);
    expect(hasValidEmailTld("maya@example.photography")).toBe(true);
  });

  test("rejects extraction artifacts: text glued onto a real address", () => {
    // The live failure mode — a parser appending a French word to the address.
    expect(hasValidEmailTld("maya@example.com.vous")).toBe(false);
    expect(hasValidEmailTld("maya@example.comcourriel")).toBe(false);
    expect(hasValidEmailTld("maya@example.comdetails")).toBe(false);
    expect(hasValidEmailTld("maya@example.zzgibberish")).toBe(false);
  });

  test("rejects malformed inputs (no @, no dot, empty TLD)", () => {
    expect(hasValidEmailTld("noatsign")).toBe(false);
    expect(hasValidEmailTld("maya@localhost")).toBe(false);
    expect(hasValidEmailTld("maya@example.")).toBe(false);
    expect(hasValidEmailTld("")).toBe(false);
  });

  test("is case-insensitive on the TLD", () => {
    expect(hasValidEmailTld("maya@EXAMPLE.COM")).toBe(true);
  });
});

describe("normalizePhone", () => {
  test("uses the collector-configured default ahead of the runtime locale", () => {
    setDefaultPhoneRegion("GB");
    try {
      expect(normalizePhone("07700 000000")).toBe("+447700000000");
      expect(normalizePhone("020 7123 4567")).toBe("+442071234567");
    } finally {
      setDefaultPhoneRegion(undefined);
    }
  });

  test("US number with dashes", () => {
    expect(normalizePhone("212-555-1234")).toBe("+12125551234");
  });

  test("US number with parens", () => {
    expect(normalizePhone("(212) 555-1234")).toBe("+12125551234");
  });

  test("number with country code", () => {
    expect(normalizePhone("+44 7700 000000")).toBe("+447700000000");
  });

  test("E.164 already formatted", () => {
    expect(normalizePhone("+12125551234")).toBe("+12125551234");
  });

  test("invalid string returns null", () => {
    expect(normalizePhone("not a phone number")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(normalizePhone("")).toBeNull();
  });

  test("UK number with country override", () => {
    expect(normalizePhone("07700 000000", "GB")).toBe("+447700000000");
  });

  test("region hints array — first hint that parses wins", () => {
    // 07700 000000 is a UK national number (not US-valid). With ["GB"]
    // it parses; with ["US"] alone it would fail.
    expect(normalizePhone("07700 000000", ["GB"])).toBe("+447700000000");
    // Multiple hints — try in order. The first valid one wins.
    expect(normalizePhone("07700 000000", ["FR", "GB", "US"])).toBe("+447700000000");
  });

  test("E.164 input still works when hints are passed (ignores region)", () => {
    expect(normalizePhone("+447700000000", ["US"])).toBe("+447700000000");
    expect(normalizePhone("+12125551234", ["GB"])).toBe("+12125551234");
  });

  test("US number falls back to system locale / US default when no hints given", () => {
    // 408-555-0173 is a valid US number (Bay Area). Pre-fix this was
    // hardcoded to "GB" in the apple-contacts caller and dropped to
    // null. Without args now, the US fallback should pick it up
    // (assuming Intl reports a non-conflicting locale).
    expect(normalizePhone("408-555-0173")).toBe("+14085550173");
  });

  test("invalid number returns null even after exhausting all fallbacks", () => {
    expect(normalizePhone("not-a-number-at-all")).toBeNull();
    expect(normalizePhone("12", ["GB", "US"])).toBeNull();
  });

  // "00" international gateway prefix (E.123) should be treated
  // as equivalent to "+". Pre-fix, numbers stored with the IDD-style "00"
  // prefix fell through to region-hint parsing and either dropped to null
  // or got mis-attributed (e.g. a +33 number parsed as US-national).
  describe("00 international prefix", () => {
    test("French number with 00 prefix and spaces", () => {
      expect(normalizePhone("00 33 6 39 98 00 33")).toBe("+33639980033");
    });

    test("UK number with 00 prefix, no spaces", () => {
      expect(normalizePhone("00447700000000")).toBe("+447700000000");
    });

    test("Russian number with 00 prefix is rewritten to + and parsed by libphonenumber", () => {
      // A malformed "00 7 <9-digit>" number. After rewriting "00 " to "+"
      // this is "+7 700 000 258" — only 9 digits after +7,
      // which libphonenumber considers invalid (Russian/KZ E.164 wants
      // 10 digits). We trust libphonenumber's verdict and return null.
      // The fix itself (rewriting "00 " to "+") is exercised by the FR
      // and UK cases above; this test pins behavior for malformed inputs
      // so we don't accidentally start fabricating bad E.164.
      expect(normalizePhone("00 7 700 000 258")).toBeNull();
    });

    test("E.164 input still works (regression — already-international path)", () => {
      expect(normalizePhone("+33639980033")).toBe("+33639980033");
    });

    test("French national format alone returns null (region inference is out of scope)", () => {
      // "06 39 98 00 33" is a bare French national-format number with a
      // single leading "0". The "00" rewrite must NOT touch this. With
      // explicit GB+US hints (so we aren't dependent on the test
      // machine's system locale being a non-FR one), libphonenumber
      // can't validate and returns null. Region inference is a
      // follow-up.
      expect(normalizePhone("06 39 98 00 33", ["GB", "US"])).toBeNull();
    });

    test("empty / whitespace-only inputs return null", () => {
      expect(normalizePhone("")).toBeNull();
      expect(normalizePhone("   ")).toBeNull();
    });
  });
});

describe("looksLikePhone", () => {
  test("E.164 number", () => {
    expect(looksLikePhone("+447700000002")).toBe(true);
    expect(looksLikePhone("+12125551234")).toBe(true);
  });

  test("national format with separators", () => {
    expect(looksLikePhone("(408) 555-0173")).toBe(true);
    expect(looksLikePhone("06 86 77 85 46")).toBe(true);
  });

  test("regular names are NOT phones", () => {
    expect(looksLikePhone("John Smith")).toBe(false);
    expect(looksLikePhone("Maya Reeves")).toBe(false);
  });

  test("emails are NOT phones", () => {
    expect(looksLikePhone("alice@example.com")).toBe(false);
  });

  test("strings with no digits are NOT phones", () => {
    expect(looksLikePhone("()-+ ")).toBe(false);
    expect(looksLikePhone("")).toBe(false);
  });
});

describe("isPlaceholderPersonName", () => {
  test("phone-shaped headlines are placeholders", () => {
    expect(isPlaceholderPersonName("+447700000001")).toBe(true);
    expect(isPlaceholderPersonName("(408) 555-0173")).toBe(true);
    expect(isPlaceholderPersonName(" +1 555 010 0123 ")).toBe(true);
  });

  test("bare email addresses are placeholders", () => {
    expect(isPlaceholderPersonName("jamie@example.com")).toBe(true);
    expect(isPlaceholderPersonName("jamie.lopez@example.org")).toBe(true);
  });

  test("the Unknown sentinel and empty strings are placeholders", () => {
    expect(isPlaceholderPersonName("Unknown")).toBe(true);
    expect(isPlaceholderPersonName("")).toBe(true);
    expect(isPlaceholderPersonName("   ")).toBe(true);
  });

  test("real human names are NOT placeholders", () => {
    expect(isPlaceholderPersonName("Jamie Lopez")).toBe(false);
    expect(isPlaceholderPersonName("Maya Reeves")).toBe(false);
    expect(isPlaceholderPersonName("Cher")).toBe(false);
  });

  test("a name containing @ but with a space is NOT a placeholder", () => {
    // e.g. an org-style display name; mirrors cleanPersonName accepting it.
    expect(isPlaceholderPersonName("Studio Northstar @ Riverside")).toBe(false);
  });
});

describe("parseEmailHeader", () => {
  test("quoted name with angle brackets", () => {
    const result = parseEmailHeader('"John Smith" <john@example.com>');
    expect(result).toEqual({ name: "John Smith", email: "john@example.com" });
  });

  test("unquoted name with angle brackets", () => {
    const result = parseEmailHeader("John Smith <john@example.com>");
    expect(result).toEqual({ name: "John Smith", email: "john@example.com" });
  });

  test("email with parenthesized name", () => {
    const result = parseEmailHeader("john@example.com (John Smith)");
    expect(result).toEqual({ name: "John Smith", email: "john@example.com" });
  });

  test("bare email", () => {
    const result = parseEmailHeader("john@example.com");
    expect(result).toEqual({ email: "john@example.com" });
  });

  test("angle-bracketed email only", () => {
    const result = parseEmailHeader("<john@example.com>");
    expect(result).toEqual({ email: "john@example.com" });
  });

  test("normalizes email case", () => {
    const result = parseEmailHeader("John <JOHN@Example.COM>");
    expect(result).toEqual({ name: "John", email: "john@example.com" });
  });

  test("name-only input (no email)", () => {
    const result = parseEmailHeader("John Smith");
    expect(result).toEqual({ name: "John Smith" });
  });

  test("quoted name glued to email with no whitespace", () => {
    // Gmail has been seen emitting headers like `"Stellar Society Lead"<…>`
    // without a space before the `<`. Previously this fell through to the
    // bare-email branch and shoved the whole string into person_aliases.
    const result = parseEmailHeader('"Stellar Society Lead"<stellar-society@example.com>');
    expect(result).toEqual({ name: "Stellar Society Lead", email: "stellar-society@example.com" });
  });

  test("unquoted name glued to email with no whitespace", () => {
    const result = parseEmailHeader("james bond<jamesbond@example.com>");
    expect(result).toEqual({ name: "james bond", email: "jamesbond@example.com" });
  });

  test("name with empty angle brackets returns name-only (no fake email)", () => {
    const result = parseEmailHeader("James Bond <>");
    expect(result).toEqual({ name: "James Bond" });
  });

  test("name with whitespace-only angle brackets returns name-only", () => {
    const result = parseEmailHeader("James Bond <   >");
    expect(result).toEqual({ name: "James Bond" });
  });

  test("angle brackets without an @-sign fall back to name-only", () => {
    // `Name<random>` with no `@` in the inner part: not an email. Keep the
    // name, drop the junk.
    const result = parseEmailHeader("John<no-at-sign>");
    expect(result).toEqual({ name: "John" });
  });

  test("empty input returns empty object", () => {
    expect(parseEmailHeader("")).toEqual({});
    expect(parseEmailHeader("   ")).toEqual({});
  });

  test("single-quoted name with angle brackets", () => {
    const result = parseEmailHeader("'John Smith' <john@example.com>");
    expect(result).toEqual({ name: "John Smith", email: "john@example.com" });
  });

  test("single-quoted email-as-name is dropped", () => {
    const result = parseEmailHeader("'jamesbond@example.com' <jamesbond@example.com>");
    // Name is really an email — cleanPersonName will strip it; but at parse time
    // the name we return is the quote-stripped string. Upstream code runs
    // cleanPersonName, which drops email-shaped names.
    expect(result.email).toBe("jamesbond@example.com");
    expect(result.name).toBe("jamesbond@example.com");
  });

  test("backtick-quoted name", () => {
    const result = parseEmailHeader("`John Smith` <john@example.com>");
    expect(result).toEqual({ name: "John Smith", email: "john@example.com" });
  });
});

describe("cleanPersonName", () => {
  test("returns a normal name unchanged", () => {
    expect(cleanPersonName("John Smith")).toBe("John Smith");
  });

  test("strips surrounding double quotes", () => {
    expect(cleanPersonName('"John Smith"')).toBe("John Smith");
  });

  test("strips surrounding single quotes", () => {
    expect(cleanPersonName("'John Smith'")).toBe("John Smith");
  });

  test("drops email-shaped name (no space)", () => {
    expect(cleanPersonName("user@example.com")).toBeUndefined();
  });

  test("drops email-shaped name inside quotes", () => {
    expect(cleanPersonName("'user@example.com'")).toBeUndefined();
    expect(cleanPersonName('"user@example.com"')).toBeUndefined();
  });

  test("keeps multi-word name even if it contains @", () => {
    // e.g., "John @ Acme Corp"
    expect(cleanPersonName("John @ Acme Corp")).toBe("John @ Acme Corp");
  });

  test("returns undefined for empty/whitespace", () => {
    expect(cleanPersonName("")).toBeUndefined();
    expect(cleanPersonName("   ")).toBeUndefined();
    expect(cleanPersonName(undefined)).toBeUndefined();
  });

  test("collapses internal whitespace", () => {
    expect(cleanPersonName("John    Smith")).toBe("John Smith");
  });
});

describe("splitEmailList", () => {
  test("simple comma-separated list", () => {
    expect(splitEmailList("a@x.com, b@x.com, c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  test("quoted names with commas", () => {
    expect(splitEmailList('"Smith, John" <j@x.com>, other@x.com')).toEqual([
      '"Smith, John" <j@x.com>',
      "other@x.com",
    ]);
  });

  test("single entry", () => {
    expect(splitEmailList("user@test.com")).toEqual(["user@test.com"]);
  });

  test("empty string", () => {
    expect(splitEmailList("")).toEqual([]);
  });

  test("mixed formats", () => {
    expect(splitEmailList('John <john@x.com>, "Doe, Jane" <jane@x.com>, bob@x.com')).toEqual([
      "John <john@x.com>",
      '"Doe, Jane" <jane@x.com>',
      "bob@x.com",
    ]);
  });
});

describe("extractEmailsFromText", () => {
  test("finds emails in text", () => {
    const text = "Contact john@example.com or jane@test.org for info.";
    expect(extractEmailsFromText(text)).toEqual(["john@example.com", "jane@test.org"]);
  });

  test("deduplicates emails", () => {
    const text = "Email john@x.com and also John@X.COM again.";
    expect(extractEmailsFromText(text)).toEqual(["john@x.com"]);
  });

  test("no emails returns empty array", () => {
    expect(extractEmailsFromText("no emails here")).toEqual([]);
  });

  test("handles emails with plus signs", () => {
    const text = "user+tag@example.com";
    expect(extractEmailsFromText(text)).toEqual(["user+tag@example.com"]);
  });

  test("unescapes Turndown markdown backslashes (e.g. lopez\\_c@example.org)", () => {
    // Reproduces the Outlook bug from a forwarded mailing-list email.
    // Turndown converts the HTML body to markdown and escapes the
    // underscores so they don't get parsed as italic — but our regex
    // doesn't handle the escapes, so lopez\_c@example.org was being
    // extracted as _c@example.org.
    const text = "From: lopez\\_c@example.org\nTo: nguyen\\_m@example.org; okafor@example.org";
    expect(extractEmailsFromText(text)).toEqual([
      "lopez_c@example.org",
      "nguyen_m@example.org",
      "okafor@example.org",
    ]);
  });

  test("unescapes other markdown punctuation Turndown might escape", () => {
    // \. \- \+ \! all happen rarely in real Turndown output but could
    // appear in adversarial / hand-crafted inputs. The pre-pass handles
    // any backslash followed by a markdown-meaningful char.
    const text = "Contact alice\\.bob@example\\.com or 123\\+456@test.com";
    const result = extractEmailsFromText(text);
    expect(result).toContain("alice.bob@example.com");
    expect(result).toContain("123+456@test.com");
  });

  test("does NOT unescape backslash before alphanumeric (preserves real text)", () => {
    // Backslashes followed by a letter or digit are not markdown escapes
    // (Turndown doesn't insert them). Most commonly: `\n` line breaks,
    // Windows paths like `C:\Users\foo`. Don't touch them.
    const text = "see C:\\Users\\foo and bare bob@example.com";
    expect(extractEmailsFromText(text)).toEqual(["bob@example.com"]);
  });

  test("cuts a capitalised label glued onto the domain (form-PDF artifact)", () => {
    // Text extracted from form-style PDFs concatenates a field value with
    // the next field's label with no whitespace, so the email regex
    // swallows the label into the TLD: `example.comWhat` → `example.comwhat`.
    // The lowercase→uppercase boundary in the domain marks the word-join.
    expect(extractEmailsFromText("jlopez@example.comWhat is their email address?")).toEqual([
      "jlopez@example.com",
    ]);
    expect(extractEmailsFromText("jdoe@example.comEmail address")).toEqual(["jdoe@example.com"]);
  });

  test("leaves mixed-case local parts untouched when cutting glued domains", () => {
    // Only the domain is inspected for the word-join boundary; the local
    // part legitimately carries mixed case.
    expect(extractEmailsFromText("John.Smith@example.comNext field")).toEqual([
      "john.smith@example.com",
    ]);
  });

  test("does NOT cut a mixed-case domain when the kept part has no TLD", () => {
    // Real addresses written with a capital inside the domain — the
    // uppercase falls before any TLD-shaped label, so cutting would destroy
    // the address. The domain is case-insensitive; normalize lowercases it.
    expect(extractEmailsFromText("Maya.Reeves@bookHarbor.com")).toEqual([
      "maya.reeves@bookharbor.com",
    ]);
    expect(extractEmailsFromText("members2026@northVale.fr")).toEqual(["members2026@northvale.fr"]);
  });

  test("cuts a word glued onto a country-code TLD", () => {
    expect(extractEmailsFromText("bookings@riverside.frTel: 0102")).toEqual([
      "bookings@riverside.fr",
    ]);
  });
});

describe("extractPhonesFromText", () => {
  test("extracts national mobile and landline numbers with explicit region context", () => {
    expect(extractPhonesFromText("M: 07700 000 000 T: 020 7123 4567", "GB")).toEqual([
      "+447700000000",
      "+442071234567",
    ]);
    expect(extractPhonesFromText("M: 07700 000 000", "US")).toEqual([]);
  });

  test("finds US phone numbers", () => {
    // Pin the default region: national US numbers don't parse under the
    // runtime-locale fallback on a non-US machine.
    setDefaultPhoneRegion("US");
    try {
      const text = "Call me at (212) 555-1234 or 310-555-6789.";
      const result = extractPhonesFromText(text);
      expect(result).toContain("+12125551234");
      expect(result).toContain("+13105556789");
    } finally {
      setDefaultPhoneRegion(undefined);
    }
  });

  test("finds international numbers with +", () => {
    const text = "My UK number is +44 7700 000000.";
    expect(extractPhonesFromText(text)).toContain("+447700000000");
  });

  test("deduplicates phone numbers", () => {
    setDefaultPhoneRegion("US");
    try {
      const text = "Call 212-555-1234 or (212) 555-1234.";
      const result = extractPhonesFromText(text);
      expect(result.length).toBe(1);
      expect(result[0]).toBe("+12125551234");
    } finally {
      setDefaultPhoneRegion(undefined);
    }
  });

  test("no phones returns empty array", () => {
    expect(extractPhonesFromText("no phones here")).toEqual([]);
  });
});

describe("countryNameToISO2", () => {
  test("maps common country display names to ISO-2 codes", () => {
    expect(countryNameToISO2("France")).toBe("FR");
    expect(countryNameToISO2("United Kingdom")).toBe("GB");
    expect(countryNameToISO2("United States")).toBe("US");
    expect(countryNameToISO2("Germany")).toBe("DE");
    expect(countryNameToISO2("Japan")).toBe("JP");
  });

  test("is case-insensitive", () => {
    expect(countryNameToISO2("france")).toBe("FR");
    expect(countryNameToISO2("FRANCE")).toBe("FR");
    expect(countryNameToISO2("  France  ")).toBe("FR");
    expect(countryNameToISO2("UnItEd KiNgDoM")).toBe("GB");
  });

  test("supports common alternate spellings / synonyms", () => {
    // UK has multiple display names; map them all to GB.
    expect(countryNameToISO2("UK")).toBe("GB");
    expect(countryNameToISO2("Great Britain")).toBe("GB");
    expect(countryNameToISO2("England")).toBe("GB");
    // USA variants.
    expect(countryNameToISO2("USA")).toBe("US");
    expect(countryNameToISO2("U.S.A.")).toBe("US");
    // Native-language names.
    expect(countryNameToISO2("Deutschland")).toBe("DE");
    expect(countryNameToISO2("España")).toBe("ES");
    expect(countryNameToISO2("Brasil")).toBe("BR");
  });

  test("round-trips already-ISO-2 input (Google's countryCode field)", () => {
    expect(countryNameToISO2("FR")).toBe("FR");
    expect(countryNameToISO2("gb")).toBe("GB");
    expect(countryNameToISO2("US")).toBe("US");
  });

  test("returns undefined for unknown / empty / nullish input", () => {
    expect(countryNameToISO2(undefined)).toBeUndefined();
    expect(countryNameToISO2(null)).toBeUndefined();
    expect(countryNameToISO2("")).toBeUndefined();
    expect(countryNameToISO2("   ")).toBeUndefined();
    expect(countryNameToISO2("Atlantis")).toBeUndefined();
    // Non-ISO-2 letter strings of other lengths fall through to the map
    // (which doesn't have them) — not silently treated as a code.
    expect(countryNameToISO2("FRA")).toBeUndefined();
  });
});

describe("deriveAuthor", () => {
  test("picks the first author-role person (sender) and returns their name", () => {
    const people: PersonMention[] = [
      { role: "recipient", name: "Maya Reeves", emails: ["maya@example.com"] },
      { role: "sender", name: "Jamie Lopez", emails: ["jamie@example.org"] },
    ];
    expect(deriveAuthor(people)).toBe("Jamie Lopez");
  });

  test("treats author and owner as author-roles too", () => {
    expect(deriveAuthor([{ role: "author", name: "David Lin" }])).toBe("David Lin");
    expect(deriveAuthor([{ role: "owner", name: "Sarah Mendez" }])).toBe("Sarah Mendez");
  });

  test("prefers the name over the email when both are present", () => {
    const people: PersonMention[] = [
      { role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] },
    ];
    expect(deriveAuthor(people)).toBe("Maya Reeves");
  });

  test("falls back to the first email when the author-role person has no name", () => {
    const people: PersonMention[] = [
      { role: "sender", emails: ["maya@example.com", "maya.alt@example.org"] },
    ];
    expect(deriveAuthor(people)).toBe("maya@example.com");
  });

  test("falls back to an address named by kind, the same way", () => {
    const people: PersonMention[] = [
      { role: "sender", identifiers: [{ kind: "email", value: "maya@example.com" }] },
    ];
    expect(deriveAuthor(people)).toBe("maya@example.com");
  });

  test("does not fall back to a platform id, which is not a byline", () => {
    // A lid is opaque. Reading the first identifier of any kind would put a
    // string of digits where a reader expects a person.
    const people: PersonMention[] = [
      { role: "sender", identifiers: [{ kind: "lid", value: "whatsapp:44770090111" }] },
    ];
    expect(deriveAuthor(people)).toBeUndefined();
  });

  test("returns undefined when no author-role person exists (recipients only)", () => {
    const people: PersonMention[] = [
      { role: "recipient", name: "Maya Reeves" },
      { role: "participant", name: "Jamie Lopez" },
      { role: "mentioned", name: "David Lin" },
    ];
    expect(deriveAuthor(people)).toBeUndefined();
  });

  test("returns undefined when the author-role person has neither name nor email", () => {
    expect(deriveAuthor([{ role: "sender" }])).toBeUndefined();
    // Empty emails array is not a usable author either.
    expect(deriveAuthor([{ role: "author", emails: [] }])).toBeUndefined();
  });

  test("returns undefined for an undefined or empty people array", () => {
    expect(deriveAuthor(undefined)).toBeUndefined();
    expect(deriveAuthor([])).toBeUndefined();
  });

  test("scans past leading non-author roles to find the first author-role", () => {
    // The author isn't first in the array — the role filter must still find it.
    const people: PersonMention[] = [
      { role: "attendee", name: "David Lin" },
      { role: "recipient", name: "Sarah Mendez" },
      { role: "author", name: "Maya Reeves" },
    ];
    expect(deriveAuthor(people)).toBe("Maya Reeves");
  });
});

describe("extractEmailsAndPhonesFromText", () => {
  test("returns the same emails and phones the single-pass extractors would", () => {
    // The one-pass extractor must stay byte-for-byte consistent with the two
    // standalone extractors — it exists purely to avoid running the
    // Turndown-unescape pass twice, not to change results.
    setDefaultPhoneRegion("US");
    try {
      const text =
        "Reach Maya at maya@example.com or call (212) 555-1234. Backup: jamie@example.org.";
      const combined = extractEmailsAndPhonesFromText(text);
      expect(combined.emails).toEqual(extractEmailsFromText(text));
      expect(combined.phones).toEqual(extractPhonesFromText(text));
      // And the concrete values, so a regression in either half is caught here.
      expect(combined.emails).toEqual(["maya@example.com", "jamie@example.org"]);
      expect(combined.phones).toEqual(["+12125551234"]);
    } finally {
      setDefaultPhoneRegion(undefined);
    }
  });

  test("applies the Turndown-unescape pass to both halves", () => {
    // Backslash-escaped underscores in the local part must be unescaped
    // before extraction, exactly like the standalone email extractor does.
    const text = "From: lopez\\_c@example.org — phone +44 7700 000000";
    const combined = extractEmailsAndPhonesFromText(text, "GB");
    expect(combined.emails).toEqual(["lopez_c@example.org"]);
    expect(combined.phones).toEqual(["+447700000000"]);
  });

  test("honors the defaultCountry hint for phone parsing", () => {
    // A bare national-format UK number only validates with a GB default.
    const text = "Ring 07700 000000 when you land.";
    expect(extractEmailsAndPhonesFromText(text, "GB").phones).toEqual(["+447700000000"]);
    // Same text, US default: not a valid UK-national number → no phone extracted.
    expect(extractEmailsAndPhonesFromText(text, "US").phones).toEqual([]);
  });

  test("returns empty arrays when the text has neither emails nor phones", () => {
    expect(extractEmailsAndPhonesFromText("just some prose with no contacts")).toEqual({
      emails: [],
      phones: [],
    });
  });
});
