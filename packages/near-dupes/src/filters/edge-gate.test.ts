// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  gatePair,
  isAutomatedSender,
  sourceFamily,
  type PairScores,
  type GateDocMeta,
} from "./edge-gate.js";

const emailDoc = (overrides: Partial<GateDocMeta> = {}): GateDocMeta => ({
  docType: "email",
  senderAddress: null,
  ...overrides,
});
const attachmentDoc: GateDocMeta = { docType: "attachment", senderAddress: null };
const fileDoc: GateDocMeta = { docType: "file", senderAddress: null };

const scoresGoodEmail: PairScores = {
  jaccard: 0.92,
  pairUniqueDf2: 8,
  pairUniqueDf5: 12,
  containmentMin: 0.6,
};
const scoresBadEmail: PairScores = {
  jaccard: 0.85,
  pairUniqueDf2: 0,
  pairUniqueDf5: 5,
  containmentMin: 0.7,
};
const scoresGoodFile: PairScores = {
  jaccard: 0.92,
  pairUniqueDf2: 5,
  pairUniqueDf5: 50,
  containmentMin: 1.0,
};
const scoresContainmentFile: PairScores = {
  jaccard: 0.96,
  pairUniqueDf2: 0,
  pairUniqueDf5: 170,
  containmentMin: 0.98,
};
const scoresBelowThreshold: PairScores = {
  jaccard: 0.6,
  pairUniqueDf2: 1,
  pairUniqueDf5: 1,
  containmentMin: 0.5,
};

describe("sourceFamily", () => {
  it("classifies emails", () => {
    expect(sourceFamily({ docType: "email", senderAddress: null })).toBe("email");
  });
  it("classifies file-like docs", () => {
    expect(sourceFamily({ docType: "attachment", senderAddress: null })).toBe("file-like");
    expect(sourceFamily({ docType: "file", senderAddress: null })).toBe("file-like");
    expect(sourceFamily({ docType: "note", senderAddress: null })).toBe("file-like");
    expect(sourceFamily({ docType: "document", senderAddress: null })).toBe("file-like");
  });
  it("falls back to other for unknown types", () => {
    expect(sourceFamily({ docType: "event", senderAddress: null })).toBe("other");
  });
});

describe("isAutomatedSender", () => {
  it("matches canonical no-reply patterns", () => {
    expect(isAutomatedSender("noreply@example.com")).toBe(true);
    expect(isAutomatedSender("no-reply@example.com")).toBe(true);
    expect(isAutomatedSender("NoReply@Example.COM")).toBe(true);
    expect(isAutomatedSender("DoNotReply@example.com")).toBe(true);
    expect(isAutomatedSender("do-not-reply@example.com")).toBe(true);
  });
  it("matches the gmail mailer-daemon pattern", () => {
    expect(isAutomatedSender("mailer-daemon@googlemail.com")).toBe(true);
  });
  it("matches bounce / postmaster / notification patterns", () => {
    expect(isAutomatedSender("bounce@example.com")).toBe(true);
    expect(isAutomatedSender("bounces@example.com")).toBe(true);
    expect(isAutomatedSender("postmaster@example.com")).toBe(true);
    expect(isAutomatedSender("notifications@github.com")).toBe(true);
    expect(isAutomatedSender("news@uniqlo.eu")).toBe(true);
  });
  it("matches prefixed local-parts (e.g. noreply-uk@uniqlo.eu)", () => {
    expect(isAutomatedSender("noreply-uk@uniqlo.eu")).toBe(true);
    expect(isAutomatedSender("notifications.alerts@example.com")).toBe(true);
  });
  it("does not match human-looking addresses", () => {
    expect(isAutomatedSender("alice@example.com")).toBe(false);
    expect(isAutomatedSender("john.smith@company.com")).toBe(false);
    expect(isAutomatedSender(null)).toBe(false);
  });
  it("does not match prefixes that are merely substrings", () => {
    expect(isAutomatedSender("information@example.com")).toBe(false); // "info" is a substring but the boundary check requires "info." or "info-"
    expect(isAutomatedSender("newsletter-but-personal@example.com")).toBe(true); // legitimately "news"-prefixed
  });
});

describe("gatePair — email ↔ email lane", () => {
  it("accepts a high-quality email pair (J ≥ 0.85, df2 ≥ 5)", () => {
    const d = gatePair(scoresGoodEmail, emailDoc(), emailDoc());
    expect(d.status).toBe("pass");
    expect(d.accept).toBe(true);
    expect(d.family).toBe("email");
  });
  it("rejects when df2 < 5 even at J = 0.85", () => {
    const d = gatePair(scoresBadEmail, emailDoc(), emailDoc());
    expect(d.status).toBe("below-threshold");
    expect(d.accept).toBe(false);
  });
  it("rejects when sender on either side is automated", () => {
    const a = emailDoc({ senderAddress: "noreply@vendor.com" });
    const d = gatePair(scoresGoodEmail, a, emailDoc());
    expect(d.status).toBe("automated-sender");
  });
  it("rejects on a mailer-daemon bounce loop", () => {
    const a = emailDoc({ senderAddress: "mailer-daemon@googlemail.com" });
    const b = emailDoc({ senderAddress: "mailer-daemon@googlemail.com" });
    const d = gatePair(scoresGoodEmail, a, b);
    expect(d.status).toBe("automated-sender");
  });
});

describe("gatePair — file-like ↔ file-like lane", () => {
  it("accepts on df2 ≥ 1 path", () => {
    expect(gatePair(scoresGoodFile, fileDoc, fileDoc).status).toBe("pass");
    expect(gatePair(scoresGoodFile, attachmentDoc, fileDoc).status).toBe("pass");
  });
  it("accepts on containment OR-branch when df2 = 0", () => {
    expect(gatePair(scoresContainmentFile, fileDoc, fileDoc).status).toBe("pass");
  });
  it("rejects when both df2 and containment are below thresholds", () => {
    expect(gatePair(scoresBelowThreshold, fileDoc, fileDoc).status).toBe("below-threshold");
  });
});

describe("gatePair — mixed (email ↔ file-like)", () => {
  it("uses the looser file-like thresholds", () => {
    // Pair would FAIL the strict email-email lane (df2=1) but PASS the looser mixed lane.
    const scoresLooser: PairScores = {
      jaccard: 0.8,
      pairUniqueDf2: 1,
      pairUniqueDf5: 5,
      containmentMin: 0.6,
    };
    const d = gatePair(scoresLooser, emailDoc(), attachmentDoc);
    expect(d.status).toBe("pass");
    expect(d.family).toBe("email"); // dominant family flagged for the consumer
  });
  it("still rejects when the email side has an automated sender", () => {
    const a = emailDoc({ senderAddress: "noreply@vendor.com" });
    const d = gatePair(scoresGoodFile, a, attachmentDoc);
    expect(d.status).toBe("automated-sender");
  });
});

describe("gatePair — gate decision is pure (no I/O)", () => {
  it("yields the same decision twice for the same input", () => {
    const a = emailDoc({ senderAddress: "alice@example.com" });
    const b = emailDoc({ senderAddress: "alice@example.com" });
    const d1 = gatePair(scoresGoodEmail, a, b);
    const d2 = gatePair(scoresGoodEmail, a, b);
    expect(d1).toEqual(d2);
  });
});
