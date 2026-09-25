// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Production-gate predicate. Given a candidate pair's similarity scores
 * and the metadata of its two documents, decides whether the pair
 * qualifies as a "near-duplicate" edge in the product. Pure functions
 * with no I/O so both the study report and the future in-gateway
 * writer can share the same decisions.
 *
 * Two product realities drive the design:
 *
 * 1. **Source-family asymmetry.** Email-email pairs are *much* noisier
 *    than file-file pairs — automated transactional emails, marketing
 *    templates, bounce notifications all share large near-identical
 *    bodies. Attachments / drive files / notion docs have far less
 *    template noise per pair. So we use stricter thresholds for the
 *    email-email family and looser thresholds elsewhere.
 *
 * 2. **Automated senders flood the corpus.** A handful of canonical
 *    "do not reply" sender patterns produce most of the email-template
 *    clusters. Suppressing them upstream of the near-dupe pipeline is
 *    cheap and removes most of the "similar but not interesting" noise
 *    the human reviewer flagged.
 *
 * Every threshold and the automated-sender allowlist is parameterised
 * — the production gateway passes config-resolved values, and the
 * study tool defaults to the values recommended by the study report.
 */

export interface PairScores {
  jaccard: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
  /** intersection_size / min(|A|, |B|) — captures "fully contained". */
  containmentMin: number;
}

export interface GateDocMeta {
  /** Omnesis document type — "email", "attachment", "file", "note", … */
  docType: string;
  /** Lowercased sender address for emails (null otherwise). */
  senderAddress: string | null;
}

export type SourceFamily = "email" | "file-like" | "other";

export function sourceFamily(meta: GateDocMeta): SourceFamily {
  if (meta.docType === "email") return "email";
  if (
    meta.docType === "attachment" ||
    meta.docType === "file" ||
    meta.docType === "document" ||
    meta.docType === "note"
  ) {
    return "file-like";
  }
  return "other";
}

/**
 * Senders whose mail is almost always automated and templated. Match
 * is on the local-part prefix (case-insensitive), not the domain —
 * `noreply@bank.com`, `no-reply@uniqlo.eu`, and
 * `mailer-daemon@googlemail.com` all share the same product reality:
 * a human is not on the other end.
 *
 * The list is intentionally narrow and conservative. New patterns
 * should be added only after observing a class of false-positive
 * clusters dominated by that sender.
 */
export const DEFAULT_AUTOMATED_LOCAL_PREFIXES: ReadonlyArray<string> = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "bounce",
  "bounces",
  "notification",
  "notifications",
  "news",
  "newsletter",
  "alerts",
  "alert",
  "support",
  "info",
  "hello",
  "auto-confirm",
  "automated",
];

export function isAutomatedSender(
  address: string | null,
  prefixes: ReadonlyArray<string> = DEFAULT_AUTOMATED_LOCAL_PREFIXES,
): boolean {
  if (!address) return false;
  const at = address.indexOf("@");
  const local = (at >= 0 ? address.slice(0, at) : address).toLowerCase();
  for (const prefix of prefixes) {
    if (local === prefix || local.startsWith(prefix + ".") || local.startsWith(prefix + "-")) {
      return true;
    }
  }
  return false;
}

export type GateStatus =
  | "pass"
  /** Either side's sender is in the automated allowlist. */
  | "automated-sender"
  /** Below the source-family-specific score thresholds. */
  | "below-threshold";

export interface GateDecision {
  status: GateStatus;
  family: SourceFamily;
  /** True only for the "pass" status — convenience for callers. */
  accept: boolean;
}

/**
 * Per-source-family score thresholds. Production passes values
 * resolved from `omnesis.json -> nearDuplicates.gate`; the study
 * tool falls back to `DEFAULT_GATE_THRESHOLDS` which encodes the
 * study's recommended values.
 */
export interface GateThresholds {
  emailJaccardMin: number;
  emailPairUniqueDf2Min: number;
  fileLikeJaccardMin: number;
  fileLikePairUniqueDf2Min: number;
  fileLikeContainmentMin: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = Object.freeze({
  emailJaccardMin: 0.85,
  emailPairUniqueDf2Min: 5,
  fileLikeJaccardMin: 0.75,
  fileLikePairUniqueDf2Min: 1,
  fileLikeContainmentMin: 0.95,
});

export interface GateOptions {
  thresholds?: Partial<GateThresholds>;
  automatedSenderPrefixes?: ReadonlyArray<string>;
}

/**
 * Score thresholds per source-family pairing. The "email-email" lane
 * is strict because most email-email near-dupes that survive the
 * earlier `same-thread` filter are template-driven. The "file-like"
 * lane is loose because attachments and drive files rarely template
 * at scale, and the containment OR-branch handles legitimate
 * multi-version-of-same-doc cases.
 */
function passesScoreThresholds(
  family: "email-email" | "file-like" | "mixed",
  s: PairScores,
  thresholds: GateThresholds,
): boolean {
  if (family === "email-email") {
    return (
      s.jaccard >= thresholds.emailJaccardMin && s.pairUniqueDf2 >= thresholds.emailPairUniqueDf2Min
    );
  }
  // file-like and mixed: looser gate.
  return (
    s.jaccard >= thresholds.fileLikeJaccardMin &&
    (s.pairUniqueDf2 >= thresholds.fileLikePairUniqueDf2Min ||
      s.containmentMin >= thresholds.fileLikeContainmentMin)
  );
}

function pairFamily(a: SourceFamily, b: SourceFamily): "email-email" | "file-like" | "mixed" {
  if (a === "email" && b === "email") return "email-email";
  if (a === "file-like" && b === "file-like") return "file-like";
  return "mixed";
}

export function gatePair(
  scores: PairScores,
  a: GateDocMeta,
  b: GateDocMeta,
  options: GateOptions = {},
): GateDecision {
  const thresholds = { ...DEFAULT_GATE_THRESHOLDS, ...options.thresholds };
  const prefixes = options.automatedSenderPrefixes ?? DEFAULT_AUTOMATED_LOCAL_PREFIXES;
  const fa = sourceFamily(a);
  const fb = sourceFamily(b);
  const dominant: SourceFamily = fa === "email" || fb === "email" ? "email" : "file-like";

  // Automated-sender suppression applies whenever an email is on the pair.
  if (fa === "email" && isAutomatedSender(a.senderAddress, prefixes)) {
    return { status: "automated-sender", family: dominant, accept: false };
  }
  if (fb === "email" && isAutomatedSender(b.senderAddress, prefixes)) {
    return { status: "automated-sender", family: dominant, accept: false };
  }

  const family = pairFamily(fa, fb);
  if (!passesScoreThresholds(family, scores, thresholds)) {
    return { status: "below-threshold", family: dominant, accept: false };
  }

  return { status: "pass", family: dominant, accept: true };
}
