// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure domain logic for fuzzy merge-candidate detection.
 *
 * Tokenization, IDF weighting, and the score formula live here so the
 * algorithm can be exercised without a database. Persistence and the
 * orchestration that ties scoring to SQL stay in `../merge-candidates.ts`.
 *
 * See `../merge-candidates.ts` header comment for the design notes that
 * govern the detector — substring fallback rationale, attenuator anchor,
 * cross-type penalty, etc.
 */

import { isNonIdentifyingEmail, isPlaceholderPersonName } from "@omnesis/core";
import type { MergeRuleAliasType } from "./MergeService.js";

// ─── Tokenization ────────────────────────────────────────────────────

/** Honorifics dropped from name tokens regardless of position. */
const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "madam",
  "lord",
  "lady",
]);

/**
 * Local-part tokens dropped — generic mailbox names that carry no
 * person signal. Applied AFTER splitting, so `team.jamesbond@x.com`
 * still yields `["jamesbond"]`.
 */
const EMAIL_STOPWORDS = new Set([
  "noreply",
  "no",
  "reply",
  "donotreply",
  "mail",
  "mailer",
  "info",
  "hello",
  "hi",
  "hey",
  "contact",
  "support",
  "team",
  "admin",
  "postmaster",
  "webmaster",
  "office",
  "sales",
  "billing",
  "help",
  // Newsletter / system / commerce mailboxes — observed false-positive
  // sources on the live DB (`bookings`, `listings` matching across
  // unrelated businesses).
  "bookings",
  "listings",
  "events",
  "alerts",
  "newsletter",
  "newsletters",
  "communications",
  "communication",
  "marketing",
  "promo",
  "promotions",
  "service",
  "services",
  "notify",
  "notifications",
  "notification",
  "messaging",
  "messages",
  "system",
  "do",
  "donot",
  "noreplies",
  "robot",
  "robots",
  "bot",
  "bots",
  "auto",
  "automated",
  "feedback",
  // Inline-image / CID artifacts: emails like
  // `image001.png@01dccc25.ebf` are CID references from MIME emails
  // that get misidentified as person addresses upstream.
  "image",
  "img",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "icon",
  "logo",
  "thumbnail",
  "cid",
  "attachment",
]);

/**
 * Maximum length for a token to be considered a "name-like" string.
 * Anything longer is almost always a random ID / hash / encoded
 * payload. Applied at tokenize time for both names and emails so
 * the IDF + scorer never sees these.
 */
const MAX_TOKEN_LEN = 16;

/**
 * Strip diacritics (NFKD) and lowercase. `naïve` → `naive`,
 * `Sándor` → `sandor`, `Brévaux` → `brevaux`.
 */
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks
    .toLowerCase();
}

/**
 * Strip channel / provenance annotations from a display name — the part that
 * says where the mention came from, not who the person is:
 *   "Teodor QUILLON (Google Drive)"    → "Teodor QUILLON"
 *   "Carla Vance (via Google Sheets)" → "Carla Vance"
 *   "Orla Tavener via RT"               → "Orla Tavener"
 *   "Anne Heery on behalf of Bambridge" → "Anne Heery"
 * Left in, these inject shared tokens (`google`, `drive`, `via`, `rt`) that
 * match across unrelated people and bridge whole identity clusters together.
 */
function stripProvenance(name: string): string {
  return name
    .replace(
      /\([^)]*\b(?:via|google|microsoft|outlook|drive|docs|sheets|slides|forms|sent|splitwise)\b[^)]*\)/gi,
      " ",
    )
    .replace(/\bvia\s+[A-Z][^,]*$/, " ")
    .replace(/\bon behalf of\b.*$/i, " ");
}

/**
 * Tokenize a name into its constituent words, with provenance stripping,
 * diacritic folding, honorific stripping and aggressive splitting. Single-char
 * tokens (initials) are kept — the scorer's initial-expansion path uses them.
 */
export function tokenizeName(name: string): string[] {
  if (!name) return [];
  const folded = fold(stripProvenance(name));
  // Split on whitespace + common punctuation. Apostrophes inside names
  // ("d'Aramitz") are kept as separators — both halves become tokens.
  const raw = folded.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return raw.filter((t) => {
    if (HONORIFICS.has(t)) return false;
    if (t.length > MAX_TOKEN_LEN) return false;
    // Drop all-digit tokens (length ≥3). These come from upstream
    // sources that wrote a phone number into a name field — they're
    // not name-like signal and they inflate the IDF denominator.
    if (t.length >= 3 && /^\d+$/.test(t)) return false;
    return true;
  });
}

/**
 * Tokenize an email. The local-part is split on `.`, `_`, `-`, `+`,
 * digit boundaries, AND camelCase transitions. Generic mailbox words
 * (`info`, `noreply`, `team`, …) are dropped. The domain is ignored.
 *
 * `bondeve@gmail.com` → `["bondeve"]` (no separator —
 * scorer falls back to substring containment to recover the underlying
 * name tokens).
 *
 * `nora.bond92@gmail.com` → `["nora","bond"]`.
 *
 * `team.jamesbond@x.com` → `["jamesbond"]`.
 */
export function tokenizeEmail(email: string): string[] {
  if (!email) return [];
  // URL-encoded "emails" (e.g. `%2f%2fincastleraceseries...`) are
  // extraction artifacts, not real addresses. They confuse IDF and
  // shadow-expand against everything. Drop entirely.
  if (email.includes("%")) return [];
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const folded = fold(local);
  // First split on non-alpha (digits, `.`, `_`, `-`, `+`).
  const splits = folded.split(/[^a-z]+/).filter((t) => t.length > 0);
  // Then split each chunk on camelCase boundaries — useful when the
  // folded form preserved camelCase from the source (rare since fold
  // lowercases — but the regex is harmless on already-lowered input).
  const tokens: string[] = [];
  for (const chunk of splits) {
    if (EMAIL_STOPWORDS.has(chunk)) continue;
    // Drop single-char tokens from emails — too noisy. Initials in
    // email locals (`m.smith@`) are rare in practice but generate a
    // lot of false-positive matches against random local-part chunks
    // ("c", "e", "ee" common in service-account / GUID-ish addresses).
    // Names still keep initials — see `tokenizeName`.
    if (chunk.length < 2) continue;
    if (chunk.length > MAX_TOKEN_LEN) continue;
    tokens.push(chunk);
  }
  return tokens;
}

/** Generic dispatch: tokenize an alias by its type. */
export function tokenizeAlias(aliasType: MergeRuleAliasType, alias: string): string[] {
  if (aliasType === "name") return tokenizeName(alias);
  if (aliasType === "email") return tokenizeEmail(alias);
  // phone / lid carry no name signal — return empty so they contribute
  // nothing to the scorer. They're still legitimate strong identifiers
  // (autoDetect handles exact shares); fuzzy matching on phones is too
  // noisy.
  return [];
}

// ─── IDF + scoring ───────────────────────────────────────────────────

/**
 * Document frequency map: token → number of distinct people whose
 * combined alias bag contains this token. Built once per detection
 * cycle and consumed by the scorer.
 */
export type TokenIdf = Map<string, number>;

/** Total distinct people the IDF was built over (used for log smoothing). */
export interface IdfContext {
  df: TokenIdf;
  totalPeople: number;
}

/**
 * IDF weight with Laplace smoothing. Hits 0 on tokens shared by every
 * person; max ≈ log(N) on tokens unique to one person.
 */
export function tokenWeight(token: string, ctx: IdfContext): number {
  const df = ctx.df.get(token) ?? 0;
  // (N+1) / (df+1) keeps weight defined when a token wasn't seen
  // during IDF building (caller may pass tokens from the OTHER side
  // not yet indexed — rare but happens).
  return Math.log((ctx.totalPeople + 1) / (df + 1));
}

/**
 * Score the similarity between two token bags. Returns a value in
 * [0, 1] where ≥0.7 indicates a probable identity match.
 *
 * Algorithm:
 *   1. Compute "matched weight" — tokens that appear (or substring-
 *      match, or initial-expand) in the other bag, weighted by IDF.
 *   2. If one bag is a token-superset of the other (containment),
 *      use `matched / weight(smaller_bag)` — captures the
 *      "Nora" ⊆ "Nora Bond" case where the smaller side is
 *      fully accounted for.
 *   3. Otherwise weighted Jaccard on `max(weight(A), weight(B))`.
 *   4. Apply an attenuator that suppresses pairs whose matched
 *      weight is too small to be informative (squashes
 *      common-token-only matches like "John" ↔ "John Doe").
 *   5. Apply confidence multipliers — both bags single-token gets a
 *      mild penalty; cross-type (email↔name) gets a small penalty.
 *
 * The matched-tokens list (with which side they came from) is
 * returned for UI explainability.
 */
export interface ScoreResult {
  score: number;
  /** Tokens that contributed to the matched weight, lex-sorted, deduped. */
  matchedTokens: string[];
}

export function scoreTokenBags(
  bagA: readonly string[],
  bagB: readonly string[],
  ctx: IdfContext,
  opts: { crossType: boolean },
): ScoreResult {
  if (bagA.length === 0 || bagB.length === 0) {
    return { score: 0, matchedTokens: [] };
  }
  const setA = new Set(bagA);
  const setB = new Set(bagB);
  // For containment / Jaccard we work on deduped sets, but keep the
  // matched-token discovery transparent: a token matches "for B" if
  // B has it (exact), or if any B-token contains it as a substring of
  // length ≥ 4 (substring fallback for unsplit emails like
  // "bondeve"), or if it's a 1-char initial that prefixes a
  // unique B token.

  function matchInto(target: Set<string>, token: string): boolean {
    if (target.has(token)) return true;
    // Substring fallback — ≥5 chars. Catches both "eve" ⊂
    // "bondeve" (8 chars) AND "nora" ⊂ "norabond"
    // (5 chars). 4 was too lax ("king" ⊂ "bookings" gave false
    // positives on business mailboxes); 5 is the empirical sweet
    // spot — common 4-letter false positives are killed but
    // genuine first-name prefixes survive.
    if (token.length >= 5) {
      for (const t of target) {
        if (t.length > token.length && t.includes(token)) return true;
      }
    }
    // Initial-expansion — single-char token matches the unique target
    // token starting with it. Captures "m" ↔ "milo" when there's
    // no ambiguity (more than one starts-with-m would be ignored).
    if (token.length === 1) {
      let firstHit: string | null = null;
      for (const t of target) {
        if (t.startsWith(token) && t.length > 1) {
          if (firstHit !== null) return false; // ambiguous
          firstHit = t;
        }
      }
      if (firstHit) return true;
    }
    return false;
  }

  // First pass: full discovery of matched tokens.
  const matched = new Set<string>();
  for (const t of setA) {
    if (matchInto(setB, t)) matched.add(t);
  }
  for (const t of setB) {
    if (matchInto(setA, t)) matched.add(t);
  }

  // Initial-expansion gating: a single-char token matching only via
  // the initial path doesn't make a strong identity claim on its own
  // (lots of people share "first letter of given name + last name").
  // Require at least one longer (≥3) matched token. Single-char
  // tokens then contribute partial weight (50%) — they're real
  // signal when a name match already vouches, but not strong enough
  // on their own.
  let hasLongMatch = false;
  for (const t of matched) {
    if (t.length >= 3) {
      hasLongMatch = true;
      break;
    }
  }
  if (!hasLongMatch) {
    return { score: 0, matchedTokens: [] };
  }

  const SINGLE_CHAR_DAMPER = 0.5;
  function dampedBagWeight(tokens: readonly string[]): number {
    let sum = 0;
    for (const t of tokens) {
      const w = tokenWeight(t, ctx);
      sum += t.length === 1 ? w * SINGLE_CHAR_DAMPER : w;
    }
    return sum;
  }

  const wA = dampedBagWeight([...setA]);
  const wB = dampedBagWeight([...setB]);
  const wMatched = dampedBagWeight([...matched]);

  // Containment branch — one side's tokens are all matched into the
  // other. Used when one bag is a subset (after fuzzy match) of the
  // other. Anchored to the smaller side: if every token in the smaller
  // side has a peer in the larger side, treat it as a strong signal.
  let allASubset = true;
  for (const t of setA) {
    if (!matchInto(setB, t)) {
      allASubset = false;
      break;
    }
  }
  let allBSubset = true;
  for (const t of setB) {
    if (!matchInto(setA, t)) {
      allBSubset = false;
      break;
    }
  }

  let raw: number;
  if (allASubset || allBSubset) {
    // Containment: smaller side's tokens are all matched. Anchor
    // the score to the smaller side's weight — extras on the larger
    // side don't penalize.
    const wSmaller = allASubset ? wA : wB;
    raw = wSmaller > 0 ? wMatched / wSmaller : 0;
  } else {
    // Partial overlap. Use a lenient denominator that gives the
    // matched portion most of the weight even when each side has
    // unmatched extras. Empirically calibrated on the live DB:
    // strict `wMatched / max(wA, wB)` killed the Nora-vs-Nora-Bond
    // case (one side has a husband-shared email, the other has a
    // compound `norabond` form) by treating the unmatched
    // tokens as fully disqualifying. Weighting matched at 0.4 (vs
    // 0.3 for unmatched) lifts genuine 2-token-overlap pairs above
    // threshold while still suppressing thin matches (a single
    // common token on noisy bags scores near 0).
    const wUnmatchedTotal = wA - wMatched + (wB - wMatched);
    const denom = 0.4 * wMatched + 0.3 * wUnmatchedTotal;
    raw = denom > 0 ? wMatched / denom : 0;
  }

  // Attenuator: dampen pairs whose matched weight is small relative to
  // the corpus's typical informative-token weight. Anchored to half
  // of log(N) — tokens with df ≤ √N pass through nearly unchanged;
  // tokens shared by hundreds of people get squashed.
  const scaleAnchor = Math.max(0.5, Math.log(ctx.totalPeople + 1) * 0.3);
  const attenuator = 1 - Math.exp(-wMatched / scaleAnchor);

  // Confidence multiplier:
  //   - both single-token: 0.7 (the noisiest case — e.g. "Pablo" both sides)
  //   - cross-type: 0.95 (mild penalty — when one side is an email
  //     address, the storage representative is less semantically
  //     loaded than a name; but the actual scoring already weighted
  //     name-tokens via IDF so we don't double-discount)
  //   - else: 1.0
  let multiplier = 1.0;
  if (setA.size === 1 && setB.size === 1) multiplier *= 0.7;
  if (opts.crossType) multiplier *= 0.95;

  const score = Math.min(1, raw * attenuator * multiplier);

  return {
    score,
    matchedTokens: [...matched].sort(),
  };
}

// ─── Proposal type ───────────────────────────────────────────────────

/** One candidate emitted by `computeFuzzyMergeCandidates`. */
export interface MergeCandidateProposal {
  /** Stable representative alias on side A. Picked by ranking
   *  email > phone > lid > name; lex-smallest within type. */
  sideA: { aliasType: MergeRuleAliasType; alias: string };
  sideB: { aliasType: MergeRuleAliasType; alias: string };
  score: number;
  /** Lex-sorted tokens that contributed to the score. Stored for UI. */
  matchedTokens: string[];
  /** Name-match strength multiplier for the portal rank (see
   *  {@link nameMatchStrength}). Computed at detection from corpus token
   *  frequencies; the portal multiplies it into the queue rank. Optional —
   *  persisted as NULL when a detector doesn't compute it. */
  matchStrength?: number;
  /** Always "name_token_overlap" today — kept open for future detectors. */
  detectionKind: string;
  /** Resolved (already merged_into-followed) person ids. */
  personA: string;
  personB: string;
}

// ─── Tunables ────────────────────────────────────────────────────────

/**
 * Score threshold above which a pair is proposed. Tunable via opts.
 * 0.7 was chosen against the test corpus (see merge-candidates.test.ts)
 * to fire "Maya" ↔ "Maya Hadley" but suppress generic "Pablo" ↔
 * "Pablo" between unrelated people.
 */
export const DEFAULT_SCORE_THRESHOLD = 0.7;

/**
 * Default cap on proposals emitted per detection run. Comfortable for a
 * ~3k-people graph — the lenient scorer surfaces many high-confidence
 * containment pairs, so the cap needs headroom to still reach lower-scoring
 * family-name matches. Reconcile (pending → latest output) must skip when a run
 * hits this cap: the surfaced set would be incomplete and reconcile would
 * delete the uncapped tail.
 */
export const DEFAULT_MERGE_CANDIDATE_MAX_RESULTS = 2000;

// ─── Role-mailbox suppression ─────────────────────────────────────────
//
// A whole class of false positives comes from generic functional mailbox
// words: `reservation@harborbistro.example` ↔ `reservations@swiftcar.example`,
// `ne-pas-repondre@…` ↔ `ne-pas-repondre@…`, `accounts@a.com` ↔
// `accounts@b.com`. These are distinct organizations whose only commonality
// is a role word; the scorer happily matches `reservation` ⊂ `reservations`
// and proposes a merge.
//
// Two signals decide suppression. (1) A token's domain-spread — how many
// distinct email domains it appears in across the corpus — is a prior for
// "generic": role words span dozens of unrelated domains. But a family
// surname spreads just as wide (`bond` rides ~20 relatives' addresses),
// so spread alone is unsafe. (2) A per-token identity label
// (`token_identity_labels`, produced by the classifier task) is the verdict:
// a token confirmed `personal_name` can never trigger suppression.
//
// The rule (validated against the live corpus to fire on the role clusters
// with zero collateral on real-person matches): suppress an email↔email
// candidate iff it is cross-domain, every matched token is high-spread and
// classified, none is `personal_name`, and at least one is `role_generic`.

/** Identity verdict for a high-spread token. */
export type TokenLabel = "personal_name" | "role_generic" | "ambiguous";

/**
 * Generic functional-mailbox / role words — language-generic dictionary terms
 * (NOT corpus-derived) that name a function rather than a person. A match
 * resting only on these across different organizations is a role-mailbox false
 * positive, not an identity. Two uses:
 *   1. {@link shouldSuppressCandidate} treats a matched role word as generic
 *      without waiting on the spread/label classifier — catching fused handles
 *      (`customerservice`, `serviceclient`) that the per-token classifier and
 *      `EMAIL_STOPWORDS` (which only filters email-local tokens, not the
 *      name-derived or fused tokens that drive these matches) both miss.
 *   2. The first-name-conflict veto and {@link isPersonEntity} ignore these, so
 *      a role-word handle (`queries@…`, `welcome@…`) never reads as a personal
 *      given name and never lets a same-org pair look like a name conflict.
 *
 * Deliberately excludes domain-functional words that the per-token classifier
 * already gates (`reservation(s)`, `enquir*`, `booking(s)`, `order(s)`): those
 * can legitimately be a rare org name / surname in some corpora, so they stay
 * protected by the spread/label path rather than the static dictionary.
 */
const ROLE_WORDS = new Set([
  "service",
  "services",
  "client",
  "clients",
  "customer",
  "customers",
  "customerservice",
  "customercare",
  "serviceclient",
  "serviceclients",
  "clientservice",
  "support",
  "helpdesk",
  "help",
  "contact",
  "contacts",
  "contactus",
  "info",
  "information",
  "sales",
  "billing",
  "accounts",
  "account",
  "invoicing",
  "payments",
  "payment",
  "admin",
  "office",
  "reception",
  "hello",
  "team",
  "newsletter",
  "marketing",
  "noreply",
  "donotreply",
  "notifications",
  "notification",
  "feedback",
  // Department / handle words seen merging unrelated organisations on the live
  // corpus (`customerrelations@` across four firms, `customersupport@`, `verify@`).
  "relations",
  "customerrelations",
  "customersupport",
  "clientsupport",
  "verify",
  "verification",
  "intern",
  "interns",
  "internship",
  "program",
  "programme",
  "department",
  "departments",
  "recruitment",
  "careers",
  "jobs",
  "press",
  "media",
  "communications",
  "communication",
]);

/**
 * Universally-generic organisation-name words (geographic position, org-type, and
 * venue/commerce descriptors). NOT brand-specific and NOT place names — purely
 * structural words that recur across unrelated organisations, so a match resting
 * only on these (with no distinctive brand token) doesn't identify one org. Place
 * names and platform brands are caught separately via corpus token-frequency; this
 * is the low-frequency backstop for the generic structural words.
 */
const GENERIC_ORG_TOKENS = new Set([
  // geographic position / direction
  "north",
  "south",
  "east",
  "west",
  "central",
  "upper",
  "lower",
  "greater",
  "nord",
  "sud",
  "est",
  "ouest",
  "centre",
  "rive",
  "gauche",
  "droite",
  "haute",
  "basse",
  // organisation type / structure
  "group",
  "groupe",
  "holdings",
  "international",
  "global",
  "national",
  "regional",
  "solutions",
  "systems",
  "technologies",
  "industries",
  "enterprises",
  "agency",
  "agence",
  "studio",
  "studios",
  "associates",
  "partners",
  "consulting",
  "foundation",
  "trust",
  "society",
  "association",
  "federation",
  "institute",
  "council",
  // venue / commerce / event descriptors
  "hotel",
  "hotels",
  "restaurant",
  "cafe",
  "bar",
  "club",
  "store",
  "shop",
  "boutique",
  "market",
  "markets",
  "marketplace",
  "mall",
  "center",
  "park",
  "garden",
  "series",
  "race",
  "races",
  "marathon",
  "triathlon",
  "running",
  "events",
  "event",
  "tickets",
  "theatre",
  "theatres",
  "cinema",
  "gallery",
  "museum",
  "network",
]);

/**
 * A token in more than this many people is "common" for org matching — a place
 * name, a platform, a generic word — not a distinctive brand. Only used by the
 * generic-org veto, which the caller supplies via an `isCommon` predicate.
 */
export const ORG_COMMON_TOKEN_DF_MAX = 8;

/**
 * Minimum distinct-domain spread for a token to participate in the role rule.
 * Below this, a token is discriminative (a rare surname / unique handle) and
 * protects its pair regardless of label. The classifier uses the same floor,
 * so a high-spread token is either labeled or transiently awaiting the next
 * classifier pass — in which case suppression holds off (safe default).
 */
export const ROLE_TOKEN_MIN_SPREAD = 8;

/** Corpus-derived inputs to {@link shouldSuppressCandidate}. */
export interface SuppressionContext {
  /** token → number of distinct email domains it appears in. */
  domainSpread: Map<string, number>;
  /** token → identity label, from `token_identity_labels`. */
  tokenLabels: Map<string, TokenLabel>;
  /** Lowercased emails flagged non-identifying by people-resolution. */
  blockedEmails: Set<string>;
}

/** Lowercased domain of an email-shaped string; "" if it has no `@`. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase();
}

/**
 * Build the token → distinct-domain-count map from raw alias rows. Only email
 * aliases contribute; the local-part is tokenized exactly as the scorer sees
 * it so spread aligns with the tokens that drive matches.
 */
export function buildDomainSpread(
  aliasRows: ReadonlyArray<{ alias_type: string; alias: string }>,
): Map<string, number> {
  const domainsByToken = new Map<string, Set<string>>();
  for (const row of aliasRows) {
    if (row.alias_type !== "email") continue;
    const domain = emailDomain(row.alias);
    if (!domain) continue;
    for (const t of tokenizeEmail(row.alias)) {
      let set = domainsByToken.get(t);
      if (!set) {
        set = new Set();
        domainsByToken.set(t, set);
      }
      set.add(domain);
    }
  }
  const spread = new Map<string, number>();
  for (const [t, doms] of domainsByToken) spread.set(t, doms.size);
  return spread;
}

/**
 * Decide whether a scored candidate is a role-mailbox false positive that
 * should be suppressed. Pure — shared by the in-process detector and the CPU
 * worker so both paths agree. See the section header for the rationale.
 */
export function shouldSuppressCandidate(
  repA: { aliasType: MergeRuleAliasType; alias: string },
  repB: { aliasType: MergeRuleAliasType; alias: string },
  matchedTokens: readonly string[],
  ctx: SuppressionContext,
): boolean {
  // A non-identifying / firehose mailbox on either side: never a person merge.
  // Union of the learned blocklist (`non_identifying_emails`) and the static
  // `isNonIdentifyingEmail` heuristic — the same two layers people-resolution
  // consults. The static layer is essential: addresses it already names
  // (`invitations@linkedin.com`, `*-reply@…`) are demoted without being
  // written to the table, so they would otherwise slip the table-only check.
  const blockedEmail = (alias: string): boolean =>
    ctx.blockedEmails.has(alias.toLowerCase()) || isNonIdentifyingEmail(alias);
  if (repA.aliasType === "email" && blockedEmail(repA.alias)) return true;
  if (repB.aliasType === "email" && blockedEmail(repB.alias)) return true;

  // The role rule is for email↔email matches across DIFFERENT organizations.
  // Same-domain desks may be one org; cross-type (name) matches are a
  // different false-positive class not addressed here.
  if (repA.aliasType !== "email" || repB.aliasType !== "email") return false;
  const domA = emailDomain(repA.alias);
  const domB = emailDomain(repB.alias);
  if (!domA || !domB || domA === domB) return false;

  if (matchedTokens.length === 0) return false;

  let sawRole = false;
  for (const t of matchedTokens) {
    // A dictionary role word is generic regardless of spread/label — it neither
    // protects the pair nor needs the classifier (catches fused `customerservice`
    // / `serviceclient` handles whose per-token spread stays low or unclassified).
    if (ROLE_WORDS.has(t)) {
      sawRole = true;
      continue;
    }
    const spread = ctx.domainSpread.get(t) ?? 0;
    if (spread < ROLE_TOKEN_MIN_SPREAD) return false; // discriminative token protects the pair
    const label = ctx.tokenLabels.get(t);
    if (label === undefined) return false; // high-spread but not yet classified → hold off
    if (label === "personal_name") return false; // name veto
    if (label === "role_generic") sawRole = true;
    // 'ambiguous' neither blocks nor satisfies the rule.
  }
  return sawRole;
}

// ─── Generic-org veto ─────────────────────────────────────────────────
//
// Two ORGANISATIONS (neither side a person) on different domains, whose match
// rests only on generic words, are different orgs — not one entity. The shared
// tokens have no distinctive brand: they are role/handle words (`customerrelations`),
// structural org words (`group`, `series`, `marketplace`), geographic descriptors
// (`rive`, `north`), or high-frequency tokens (a city, a platform). A single
// distinctive token — a rare brand the caller marks as not-common — protects the
// pair (`Acme Paris` ↔ `Acme London` keeps `acme`). Gated on org↔org so it never
// touches a person merge.

/**
 * True when an org↔org cross-domain candidate has no distinctive (brand) token —
 * its match is entirely generic. `isCommon(token)` reports corpus-frequent tokens
 * (places, platforms) the caller derives from token frequency; role/structural
 * words are recognised here. Returns false the moment either side is a person.
 */
export function isGenericOrgPair(
  repA: { aliasType: string; alias: string },
  repB: { aliasType: string; alias: string },
  matchedTokens: readonly string[],
  isPersonA: boolean,
  isPersonB: boolean,
  isCommon: (token: string) => boolean,
): boolean {
  if (isPersonA || isPersonB) return false; // only org↔org
  if (repA.aliasType !== "email" || repB.aliasType !== "email") return false;
  const domA = emailDomain(repA.alias);
  const domB = emailDomain(repB.alias);
  if (!domA || !domB || domA === domB) return false; // cross-domain only
  if (matchedTokens.length === 0) return false;
  const generic = (t: string): boolean =>
    ROLE_WORDS.has(t) || GENERIC_ORG_TOKENS.has(t) || isCommon(t);
  // A distinctive token (a rare, non-generic brand) makes this a real same-org
  // match — protect it. Suppress only when every matched token is generic.
  return matchedTokens.every(generic);
}

// ─── First-name-conflict veto ─────────────────────────────────────────
//
// Two records that share a surname (or other rare token) but carry DIFFERENT
// personal given names are different people — siblings, parents, namesakes —
// not a merge. The token scorer can't see this: it matches on the shared surname
// and the two-name-concept gate passes (each side = a distinct given + the
// shared surname). This veto restores the missing negative signal.
//
// Precision-first, tuned against the live corpus:
//   - A "given name" only counts from a STRUCTURED name ("Given … Surname", where
//     Surname is one of the shared/matched tokens) or a "given.surname"-shaped
//     email local whose tokens include the shared surname. Role-word handles
//     (`queries@`, `welcome@`) and bare org names carry no such structure, so a
//     same-org pair never reads as a name conflict.
//   - Only a FULL given (≥4 chars) DRIVES a conflict — bare initials (`jp`) are
//     ambiguous (`jp` = Jean-Paul) and route to human review instead.
//   - Givens "agree" if equal or one prefixes the other (`maya` ~ `mayareeves`,
//     initial `m` ~ `maya`), so a person's own handle variants never self-conflict.

const FIRST_NAME_FULL_GIVEN_MIN_LEN = 4;

function givenNamesFromAliases(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
  matched: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  const consider = (tokens: string[]): void => {
    if (tokens.length < 2) return; // need given + surname
    if (!tokens.some((t) => matched.has(t))) return; // must carry the shared surname
    const lead = tokens[0];
    if (matched.has(lead) || lead.length < 2 || ROLE_WORDS.has(lead)) return;
    out.add(lead);
  };
  for (const al of aliases) {
    if (al.aliasType === "name") consider(tokenizeName(al.alias));
    else if (al.aliasType === "email") consider(tokenizeEmail(al.alias));
  }
  return [...out];
}

/** Two given-name tokens are consistent if equal or one prefixes the other. */
function givensAgree(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * True when the two alias bags carry a shared surname but conflicting personal
 * given names — i.e. they are different people who merely share a family name.
 * Pure; shared by the generation gate and the view-layer filter so both agree.
 */
export function hasFirstNameConflict(
  aliasesA: ReadonlyArray<{ aliasType: string; alias: string }>,
  aliasesB: ReadonlyArray<{ aliasType: string; alias: string }>,
  matchedTokens: readonly string[],
): boolean {
  const matched = new Set(matchedTokens);
  // Need a real shared surname (a non-role token), not just role-word overlap.
  if (!matchedTokens.some((t) => !ROLE_WORDS.has(t) && t.length >= 3)) return false;
  const gA = givenNamesFromAliases(aliasesA, matched);
  const gB = givenNamesFromAliases(aliasesB, matched);
  const hasFullA = gA.some((g) => g.length >= FIRST_NAME_FULL_GIVEN_MIN_LEN);
  const hasFullB = gB.some((g) => g.length >= FIRST_NAME_FULL_GIVEN_MIN_LEN);
  if (!hasFullA || !hasFullB) return false; // an initial-only side is ambiguous → review
  // Conflict unless SOME given on each side agrees (handles own-handle variants).
  return !gA.some((a) => gB.some((b) => givensAgree(a, b)));
}

/** Shortest a trailing token must be to be treated as a real surname (not an initial). */
const SURNAME_CONFLICT_MIN_LEN = 3;

/**
 * True when `token` is two or more matched tokens concatenated — a fused compound
 * given name like `jeanmarc` for {jean, marc}, as it appears in an email local
 * (`jeanmarc.roussel@…`). Such a token IS the given name, not a surname.
 */
function isFusedGiven(token: string, matched: ReadonlySet<string>): boolean {
  if (matched.size === 0 || matched.has(token)) return false;
  let rest = token;
  let parts = 0;
  while (rest.length > 0) {
    let advanced = false;
    for (const m of matched) {
      if (m.length > 0 && rest.startsWith(m)) {
        rest = rest.slice(m.length);
        parts += 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) return false;
  }
  return parts >= 2;
}

function surnamesFromAliases(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
  matched: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  // A token belongs to the shared given if it's a matched token or a fused form
  // of them (`jeanmarc`). Everything else of name length is a candidate surname.
  const givenish = (t: string): boolean => matched.has(t) || isFusedGiven(t, matched);
  const consider = (tokens: string[]): void => {
    if (tokens.length < 2) return; // need given + surname
    if (!tokens.some(givenish)) return; // must carry the shared given name
    // The surname is the name token(s) NOT in the shared given — wherever it sits.
    // Both "Given Surname" and the formal "SURNAME Given" order work (the latter is
    // common in French address books), and a middle name just adds another token.
    for (const t of tokens) {
      if (!givenish(t) && t.length >= SURNAME_CONFLICT_MIN_LEN && !ROLE_WORDS.has(t)) out.add(t);
    }
  };
  for (const al of aliases) {
    if (al.aliasType === "name") consider(tokenizeName(al.alias));
    else if (al.aliasType === "email") consider(tokenizeEmail(al.alias));
  }
  return [...out];
}

/**
 * The mirror of {@link hasFirstNameConflict}: true when the two alias bags share
 * a (compound) given name but carry conflicting SURNAMES — different people who
 * merely share a first name. This is the namesake class the two-concept gate
 * lets through: a compound given like "Jean-Marc" is two tokens, so "Jean-Marc
 * Roussel" and "Jean-Marc Varenne" clear the gate on `jean`+`marc` even though
 * their surnames disagree. The first-name veto can't fire (the givens agree);
 * this catches it on the differing trailing surname. Pure; shared by the
 * generation gate and the view-layer filter.
 */
export function hasSurnameConflict(
  aliasesA: ReadonlyArray<{ aliasType: string; alias: string }>,
  aliasesB: ReadonlyArray<{ aliasType: string; alias: string }>,
  matchedTokens: readonly string[],
): boolean {
  const matched = new Set(matchedTokens);
  // The shared part must be ≥2 real name tokens — a compound given name. A single
  // shared token can never carry a surname conflict (and single-concept matches are
  // already blocked by the two-concept gate); role-word overlap doesn't count.
  if (matchedTokens.filter((t) => !ROLE_WORDS.has(t) && t.length >= 3).length < 2) return false;
  const sA = surnamesFromAliases(aliasesA, matched);
  const sB = surnamesFromAliases(aliasesB, matched);
  if (sA.length === 0 || sB.length === 0) return false; // a surname-less side is ambiguous → review
  // Conflict unless SOME surname on each side agrees (a compound/married-name
  // variant of the same person counts as agreement via the prefix rule).
  return !sA.some((a) => sB.some((b) => givensAgree(a, b)));
}

/**
 * Whether a SINGLE person's own name aliases carry ≥2 conflicting given names —
 * an internally-inconsistent identity blob. A shared email account can accrete
 * several family members' sender display names onto one person ("Maya Bond",
 * "David Bond", "Nora Bond" on one row). Such a person is
 * already corrupt, and auto-approval must never grow it: it matches a clean
 * record on whichever of its names happens to agree, dragging more identities in.
 *
 * Conservative by construction — only a structured `Given Surname` lead counts,
 * a short or role/org lead is skipped, and variants that prefix-agree ("Maya" ⊂
 * "Mayara") are not a conflict. False positives only cost an auto-approval (the
 * pair routes to manual review); they never cause a wrong merge.
 *
 * Aliases are first grouped by sorted-token key, so the SAME name written in
 * different token orders ("Reeves Maya" / "Maya REEVES" — the formal
 * surname-first convention next to the given-first one) is ONE name whose lead
 * is merely order-ambiguous, not a pair of conflicting given names. Two
 * distinct names conflict unless some READING of one agrees with a reading of
 * the other — a reading being (lead-as-given, remaining tokens), so agreement
 * requires both an agreeing given AND compatible remaining tokens. Comparing
 * bare leads is not enough: two family members both written in both orders
 * would "agree" on the shared surname lead while their actual given names
 * differ.
 */
export function hasInternalNameConflict(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  // sorted-token name key → the group's tokens + the lead tokens seen across
  // that name's spellings (each lead is one of the key's tokens).
  const groupsByKey = new Map<string, { tokens: string[]; leads: Set<string> }>();
  for (const al of aliases) {
    if (al.aliasType !== "name") continue;
    const tokens = tokenizeName(al.alias);
    if (tokens.length < 2) continue; // need a structured "Given Surname"
    const lead = tokens[0];
    if (
      lead.length < FIRST_NAME_FULL_GIVEN_MIN_LEN ||
      ROLE_WORDS.has(lead) ||
      GENERIC_ORG_TOKENS.has(lead)
    ) {
      continue;
    }
    // Initials are dropped from the key (as in structuredNameKey), so
    // "Maya REEVES" and "REEVES Maya J" still group as one name.
    const keyTokens = tokens.filter((t) => t.length >= 2).sort();
    const key = keyTokens.join(" ");
    let group = groupsByKey.get(key);
    if (!group) {
      group = { tokens: keyTokens, leads: new Set() };
      groupsByKey.set(key, group);
    }
    group.leads.add(lead);
  }

  // The group's tokens minus one occurrence of the reading's lead.
  const restOf = (tokens: readonly string[], lead: string): string[] => {
    const out = [...tokens];
    const i = out.indexOf(lead);
    if (i >= 0) out.splice(i, 1);
    return out;
  };
  // Rests are compatible when every token of the smaller has an agreeing
  // partner in the larger — so a middle name or married-name extension never
  // reads as a conflict ("Marie Vance" ⊂ "Marie Dupont Vance").
  const restsCompatible = (a: string[], b: string[]): boolean => {
    const [small, large] = a.length <= b.length ? [a, b] : [b, a];
    return small.every((t) => large.some((u) => givensAgree(t, u)));
  };
  const groupsAgree = (
    g1: { tokens: string[]; leads: Set<string> },
    g2: { tokens: string[]; leads: Set<string> },
  ): boolean => {
    for (const a of g1.leads) {
      for (const b of g2.leads) {
        if (!givensAgree(a, b)) continue;
        if (restsCompatible(restOf(g1.tokens, a), restOf(g2.tokens, b))) return true;
      }
    }
    return false;
  };

  const groups = [...groupsByKey.values()];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!groupsAgree(groups[i], groups[j])) return true;
    }
  }
  return false;
}

/**
 * Whether a person's aliases include a structured personal name — a multi-token
 * "Given Surname" whose leading token is neither a generic role word nor an
 * org-structural word. Org/role mailboxes (`customerservice@…`, "Customer
 * Service") and descriptively-named organisations ("Hotels Paris Rive Gauche",
 * "Central Group") have no such name. Used to rank person↔person candidates above
 * org noise and to gate the generic-org veto.
 */
export function isPersonEntity(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  for (const al of aliases) {
    if (al.aliasType !== "name") continue;
    const t = tokenizeName(al.alias);
    if (
      t.length >= 2 &&
      t[0].length >= 2 &&
      !ROLE_WORDS.has(t[0]) &&
      !GENERIC_ORG_TOKENS.has(t[0])
    ) {
      return true;
    }
  }
  return false;
}

// ─── High-confidence auto-approve tier ────────────────────────────────
//
// A surviving candidate is structurally near-certain — it can be auto-applied as
// a reversible `kind:"system"` rule, sparing the operator a click. Two
// deterministic signals, no model:
//   1. A DISTINCTIVE email handle shared across DIFFERENT domains
//      (`mayareeves@example.com` ↔ `mayareeves@northstar.example`) — the same
//      non-role local part on two providers is almost always one identity.
//   2. A DISTINCTIVE full personal name — both sides persons, the score at
//      containment strength, and a rare/distinctive token in the match (a high
//      `matchStrength`), so it isn't two common-name namesakes.
// The caller excludes any candidate touching `is_self`: a wrong self-merge is the
// one failure that silently corrupts first-person answers, so self stays manual.

const HIGH_CONFIDENCE_MATCH_STRENGTH = 1.7;
// The token-bag scorer attenuates short matches, so even a byte-identical two-token
// name ("Maya Reeves" ↔ "Maya Reeves") tops out around 0.947 — a 0.95
// floor was effectively unreachable for full-name matches and silently blocked them.
// Distinctiveness (matchStrength) is the real confidence signal here; the score floor
// only needs to exclude loose/partial matches (the org/blob guards handle the rest).
const HIGH_CONFIDENCE_MIN_SCORE = 0.9;
const HIGH_CONFIDENCE_MIN_HANDLE_LEN = 4;

/** Lowercased `{ local, domain }` of an email-shaped alias, or null. */
function emailLocalDomain(alias: string): { local: string; domain: string } | null {
  const at = alias.lastIndexOf("@");
  if (at <= 0 || at === alias.length - 1) return null;
  return {
    local: alias.slice(0, at).toLowerCase(),
    domain: alias.slice(at + 1).toLowerCase(),
  };
}

/**
 * True when the two alias bags share a DISTINCTIVE email handle on DIFFERENT
 * domains — the same handle at two providers, a strong same-identity signal. The
 * shared handle must be specific (not a short or generic role word like `info`).
 *
 * Handles are compared with separators (`. _ -`) removed, so a structured
 * `given.surname` matches its dotless / underscored / hyphenated variants across
 * providers — `maya.reeves@school.example` ↔ `mayareeves@gmail.example` is one
 * person (a work/school address and a personal one). The length + role-word
 * guards run on the normalized form (and the raw, so a hyphenated role word is
 * still caught).
 */
export function sharesDistinctiveEmailHandle(
  aliasesA: ReadonlyArray<{ aliasType: string; alias: string }>,
  aliasesB: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  const normalizeHandle = (local: string): string => local.replace(/[._-]+/g, "");
  const distinctive = (local: string): boolean => {
    const norm = normalizeHandle(local);
    return (
      norm.length >= HIGH_CONFIDENCE_MIN_HANDLE_LEN &&
      !ROLE_WORDS.has(norm) &&
      !ROLE_WORDS.has(local)
    );
  };
  const aDomainsByHandle = new Map<string, Set<string>>();
  for (const al of aliasesA) {
    if (al.aliasType !== "email") continue;
    const ld = emailLocalDomain(al.alias);
    if (!ld || !distinctive(ld.local)) continue;
    const handle = normalizeHandle(ld.local);
    let set = aDomainsByHandle.get(handle);
    if (!set) {
      set = new Set();
      aDomainsByHandle.set(handle, set);
    }
    set.add(ld.domain);
  }
  for (const al of aliasesB) {
    if (al.aliasType !== "email") continue;
    const ld = emailLocalDomain(al.alias);
    if (!ld || !distinctive(ld.local)) continue;
    const aDomains = aDomainsByHandle.get(normalizeHandle(ld.local));
    if (aDomains && [...aDomains].some((d) => d !== ld.domain)) return true;
  }
  return false;
}

const PLACEHOLDER_NAME_KEYS = new Set(["no name", "noname", "unknown", "n a", "na", "me"]);

/**
 * A normalized key for a structured name, or null if the name isn't a usable
 * structured identity. The key folds diacritics/case, strips provenance ("(Google+)",
 * "via X") via tokenizeName, drops single-char initials, and SORTS the tokens — so
 * "Maya Reeves", "maya reeves", "Reeves, Maya", and "Maya Reeves (Google+)" all map
 * to the same key. Returns null for placeholders ("No Name"), single-token names,
 * and all-generic names (only role/org-structural words), so those never match.
 */
function structuredNameKey(name: string): string | null {
  if (isPlaceholderPersonName(name)) return null;
  const tokens = tokenizeName(name).filter((t) => t.length >= 2); // drop initials
  if (tokens.length < 2) return null; // need a real Given + Surname
  if (!tokens.some((t) => !ROLE_WORDS.has(t) && !GENERIC_ORG_TOKENS.has(t))) return null;
  const joined = tokens.join(" ");
  if (PLACEHOLDER_NAME_KEYS.has(joined)) return null;
  return [...tokens].sort().join(" ");
}

/**
 * True when the two alias bags carry the SAME structured name under DIFFERENT raw
 * spellings — case, diacritics, token order, or a provenance suffix ("Renée
 * Vance" ↔ "Renee Vance", "Reeves, Maya" ↔ "Maya Reeves", "Maya Reeves" ↔
 * "Maya Reeves (Google+)"). A spelling *variant* is a
 * strong cross-source one-identity signal.
 *
 * Two deliberate exclusions: a **byte-identical** name is NOT counted (two people
 * can share the exact same common name — the matchStrength path auto-approves only
 * the distinctive ones); and a genuine **subset** with an extra distinctive word
 * ("Acme Group" vs "Acme Group Holdings") never matches, because the normalized
 * keys differ.
 */
export function sharesExactStructuredName(
  aliasesA: ReadonlyArray<{ aliasType: string; alias: string }>,
  aliasesB: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  const rawsByKey = new Map<string, Set<string>>(); // normalized key → raw spellings (side A)
  for (const al of aliasesA) {
    if (al.aliasType !== "name") continue;
    const k = structuredNameKey(al.alias);
    if (!k) continue;
    let raws = rawsByKey.get(k);
    if (!raws) {
      raws = new Set();
      rawsByKey.set(k, raws);
    }
    raws.add(al.alias.trim());
  }
  for (const al of aliasesB) {
    if (al.aliasType !== "name") continue;
    const k = structuredNameKey(al.alias);
    if (!k) continue;
    const aRaws = rawsByKey.get(k);
    // Match only when B's raw spelling DIFFERS from a side-A spelling of the same
    // normalized name — a variant, not a byte-identical (possibly-two-people) name.
    if (aRaws && [...aRaws].some((r) => r !== al.alias.trim())) return true;
  }
  return false;
}

/**
 * Heuristic: is this side an ORGANISATION named after its own email domain?
 * An org's identifying name tends to appear in its domain (`Northwind Health` →
 * northwindhealth.example); a person's surname does not (`Maya Reeves` →
 * gmail.example / school.example).
 * Used to keep org-vs-org and seller-vs-platform matches out of the person
 * auto-merge path, where a side may be an email-only record with no display name.
 *
 * A surname-only domain hit on a person-shaped name is NOT org evidence: a
 * personal vanity domain (`david@lin.example` for "David Lin") and an employee
 * whose display name embeds the employer ("Maya Reeves | Northstar" at
 * northstar.example) both put a trailing name token in the domain while the
 * GIVEN name stays out of it. The org pattern is the whole identifying name in
 * the domain, so the hit counts only when the name isn't person-shaped or the
 * domain carries the lead (given) token too.
 */
function isOrgNamedAfterDomain(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  const domains: string[] = [];
  for (const al of aliases) {
    if (al.aliasType !== "email") continue;
    const ld = emailLocalDomain(al.alias);
    if (ld) domains.push(ld.domain.replace(/[^a-z0-9]/g, ""));
  }
  if (domains.length === 0) return false;
  for (const al of aliases) {
    if (al.aliasType !== "name") continue;
    const tokens = tokenizeName(al.alias);
    const nameTokens = tokens.filter((t) => t.length >= 3);
    if (nameTokens.length === 0) continue;
    const lead = tokens[0];
    const personShaped =
      tokens.length >= 2 &&
      lead.length >= 3 &&
      !ROLE_WORDS.has(lead) &&
      !GENERIC_ORG_TOKENS.has(lead);
    for (const domain of domains) {
      if (!nameTokens.some((t) => domain.includes(t))) continue;
      if (!personShaped || domain.includes(lead)) return true;
    }
  }
  return false;
}

/**
 * Whether a side carries an email whose local-part is a structured personal name
 * — two or more separator-delimited tokens (`maya.reeves`, `david_lin`). This
 * is a person signal even when the record has no display name, and it distinguishes
 * an email-only person from a name-only organisation (`Central Group`), which has
 * no such handle.
 */
function hasStructuredPersonHandle(
  aliases: ReadonlyArray<{ aliasType: string; alias: string }>,
): boolean {
  for (const al of aliases) {
    if (al.aliasType !== "email") continue;
    const ld = emailLocalDomain(al.alias);
    if (!ld) continue;
    if (ld.local.split(/[._-]+/).filter((t) => t.length >= 2).length >= 2) return true;
  }
  return false;
}

/**
 * Whether a surviving candidate is a structurally high-confidence merge that may
 * be auto-approved (reversibly). Pure; the caller supplies the stored candidate's
 * score + matchStrength and the resolved alias bags + per-side person flags.
 */
export function isHighConfidenceMerge(opts: {
  aliasesA: ReadonlyArray<{ aliasType: string; alias: string }>;
  aliasesB: ReadonlyArray<{ aliasType: string; alias: string }>;
  score: number;
  matchStrength: number;
  isPersonA: boolean;
  isPersonB: boolean;
}): boolean {
  if (sharesDistinctiveEmailHandle(opts.aliasesA, opts.aliasesB)) return true;
  // Same structured name (modulo spelling/order/provenance) — one identity seen
  // under variant spellings; the genuine-subset and placeholder cases are excluded.
  if (sharesExactStructuredName(opts.aliasesA, opts.aliasesB)) return true;
  const distinctive =
    opts.score >= HIGH_CONFIDENCE_MIN_SCORE && opts.matchStrength >= HIGH_CONFIDENCE_MATCH_STRENGTH;
  // A distinctive full-name match — whether the names are display names, live only
  // in email handles (`Maya Reeves` ↔ `maya.reeves@school.example`), or are encoded
  // in handles on both sides in different forms. Requires a person signal (a
  // structured personal name or a `given.surname` handle) so two name-only
  // organisations don't merge, and that NEITHER side is an organisation named after
  // its own domain — which excludes brand, sub-brand, and seller-vs-platform matches
  // (`Acme Group` ↔ an agent at it; `Riverside Florist` ↔ `riverideflorist.example`).
  const personish =
    opts.isPersonA ||
    opts.isPersonB ||
    hasStructuredPersonHandle(opts.aliasesA) ||
    hasStructuredPersonHandle(opts.aliasesB);
  if (
    personish &&
    distinctive &&
    !isOrgNamedAfterDomain(opts.aliasesA) &&
    !isOrgNamedAfterDomain(opts.aliasesB)
  ) {
    return true;
  }
  return false;
}

// ─── Candidate rank strength ──────────────────────────────────────────

/**
 * Number of leading initials an `<initials><surname>` email local may carry
 * before it stops reading as one person's handle. `abond` = `a` + `bond`,
 * `jpdupont` = `jp` + `dupont`.
 */
const SURNAME_INITIAL_PREFIX_MAX = 2;

/**
 * The shortest a suffix must be to be treated as a surname an email local was
 * built from. Keeps the initials-prefix collapse off short tokens (`ba` ⊅ `a`).
 */
const SURNAME_SUFFIX_MIN_LEN = 4;

/**
 * Collapse matched tokens that name the SAME concept as a longer matched token,
 * so a name spelled different ways — abbreviated to an initial, or folded into
 * an email handle — counts as ONE shared concept rather than inflating the
 * match. Two collapses apply:
 *
 * - Prefix-variant: a token that prefixes a longer kept token (`chris` →
 *   `christophe`, `c` → `christophe`, `christophe` → `christopher`). Prefix, not
 *   substring: an initial `m` prefixes `mike` (same given name → collapse) but
 *   is only a mid-substring of `smith` (a different surname → keep both), so
 *   `[m, smith]` stays two concepts (first initial + last name).
 * - Initials+surname handle: a surname token whose longer kept token is that
 *   surname with ≤2 leading initials (`bond` → `abond`, `dupont` →
 *   `jpdupont`). An email local like `abond@…` is the surname concept, not a
 *   second one — so `[abond, bond]` is ONE concept (a family handle), and
 *   two relatives who only share the surname (`abond` for Nora, the same
 *   handle shape for James) no longer pass the two-concept merge gate.
 */
export function distinctNameConcepts(matchedTokens: readonly string[]): string[] {
  const sorted = [...new Set(matchedTokens)].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  const collapses = (longer: string, t: string): boolean =>
    longer.startsWith(t) ||
    (longer.endsWith(t) &&
      t.length >= SURNAME_SUFFIX_MIN_LEN &&
      longer.length - t.length <= SURNAME_INITIAL_PREFIX_MAX);
  for (const t of sorted) {
    if (!kept.some((k) => collapses(k, t))) kept.push(t);
  }
  return kept;
}

/**
 * Provenance / channel tokens that ride along in display names (`Orla
 * Tavener via RT`, `Carla Vance (via Google Docs)`) but say nothing about
 * who the person is. Ignored when grouping a bucket's names into distinct
 * people, so they don't falsely link two unrelated names that merely share the
 * same channel suffix.
 */
const PROVENANCE_TOKENS = new Set([
  "via",
  "rt",
  "google",
  "docs",
  "doc",
  "sheets",
  "drive",
  "slides",
  "forms",
  "behalf",
  "sent",
  "notification",
  "notifications",
]);

/**
 * Count how many distinct-person name groups a person's name aliases form,
 * ignoring provenance tokens and treating prefix-variants as the same token.
 *
 * Two aliases are the SAME person only when one's tokens are a (prefix-aware)
 * SUBSET of the other's — i.e. variants/abbreviations of one name ("Carla
 * Vance" ⊇ "Car", "vance carla" = "Carla Vance"). Merely sharing one token
 * is NOT enough: "Nora Bond" and "Felix Bond" share only the family
 * surname yet are different people, and "Air France for JAMES BOND" vs
 * "… for CARLA VANCE" share only the channel prefix — both must count as 2
 * groups so the bucket is recognised as a multi-person hub.
 */
export function distinctNameGroups(nameAliases: readonly string[]): number {
  const sets = nameAliases
    .map((n) => tokenizeName(n).filter((t) => !PROVENANCE_TOKENS.has(t)))
    .filter((toks) => toks.length > 0)
    .map((toks) => [...new Set(toks)]);
  if (sets.length <= 1) return sets.length;
  const parent = sets.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  // Every token of `a` prefix-matches some token of `b` → `a` is a variant of
  // (a subset of) `b`'s name.
  const subsetOf = (a: string[], b: string[]): boolean =>
    a.every((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (subsetOf(sets[i], sets[j]) || subsetOf(sets[j], sets[i])) parent[find(i)] = find(j);
    }
  }
  return new Set(sets.map((_, i) => find(i))).size;
}

/**
 * A bucket carrying ≥2 distinct people's names is a shared / non-identifying
 * queue (RT ticket queue, notification relay), not a person. Such buckets are
 * hubs that would otherwise bridge unrelated identity clusters together.
 */
export function isHubPerson(nameAliases: readonly string[]): boolean {
  return distinctNameGroups(nameAliases) >= 2;
}

// ─── Identity-bridge guard ────────────────────────────────────────────
//
// A single record can match different neighbours on DISJOINT token sets —
// e.g. a record whose handle is two surnames glued together matches one
// family on surname X and another, unrelated family on surname Y, sharing no
// token between the two. In the candidate graph that record is an articulation
// point: it fuses two otherwise-separate identity clusters into one giant
// component. The hub gate misses it (it has a single display name, so it isn't
// a multi-name queue); the signal here is purely structural — its incident
// edges partition into ≥2 groups with no token in common.
//
// A genuine person never trips this: a real alternate carries the full name, so
// at least one edge spans (overlaps) every token group and keeps them one group.
// Only a record that is *only ever* a partial, disjoint match to each side — the
// ambiguous bridge — splits. We drop all of its candidate edges: it is too
// ambiguous to auto-cluster, and read paths / the contact card still let the
// operator merge it by hand.

/** Edge shape the bridge detector consumes (person ids + the tokens that matched). */
export interface CandidateEdge {
  a: string;
  b: string;
  matchedTokens: readonly string[];
}

/**
 * Return the set of person ids that are identity bridges: a node whose incident
 * candidate edges partition into ≥2 token-disjoint groups (it matches different
 * neighbours on token sets that share nothing). Pure; shared by the generation
 * pass and the view layer so both drop the same edges.
 */
export function findIdentityBridges(edges: readonly CandidateEdge[]): Set<string> {
  // person id → its incident edges' matched-token sets
  const incident = new Map<string, Set<string>[]>();
  const add = (pid: string, tokens: readonly string[]): void => {
    const list = incident.get(pid) ?? [];
    list.push(new Set(tokens));
    incident.set(pid, list);
  };
  for (const e of edges) {
    add(e.a, e.matchedTokens);
    add(e.b, e.matchedTokens);
  }

  const bridges = new Set<string>();
  for (const [pid, tokenSets] of incident) {
    if (tokenSets.length < 2) continue;
    // Union-find over the incident edges: connect two edges that share a token.
    const parent = tokenSets.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        let shares = false;
        for (const t of tokenSets[i]) {
          if (tokenSets[j].has(t)) {
            shares = true;
            break;
          }
        }
        if (shares) parent[find(i)] = find(j);
      }
    }
    const groups = new Set(tokenSets.map((_, i) => find(i))).size;
    if (groups >= 2) bridges.add(pid);
  }
  return bridges;
}

/**
 * A token carried by more than this many people is "common" (a popular given
 * name like `christophe`); at or below it the token is rare/discriminative (a
 * surname or unique handle like `douineau`). Mirrors the family-name gate's
 * df>2 notion of "common surname".
 */
export const COMMON_TOKEN_DF_MAX = 3;

/**
 * Rank multiplier for the portal candidate queue, capturing how strong a name
 * match is. A pair sharing two independent concepts (first + last name) or any
 * rare/discriminative token ranks strong; a pair sharing only a single COMMON
 * given name (`chris` ↔ `christophe`, two unrelated people) is demoted to the
 * bottom — but never to zero, so it stays visible (operator preference).
 *
 * `isCommon(token)` reports whether a token is carried by many people. Built
 * from the corpus token frequencies at detection time (where they are known),
 * so the verdict doesn't depend on the coarser high-spread label set.
 */
export function nameMatchStrength(
  matchedTokens: readonly string[],
  isCommon: (token: string) => boolean,
): number {
  const concepts = distinctNameConcepts(matchedTokens);
  if (concepts.length === 0) return 1;
  const hasRare = concepts.some((t) => !isCommon(t));
  // Single shared concept that is a common given name → weak (bottom of queue).
  if (concepts.length <= 1 && !hasRare) return 0.15;
  return 1 + 0.4 * (concepts.length - 1) + (hasRare ? 0.3 : 0);
}

// ─── Cluster-aware queue ranking ──────────────────────────────────────
//
// Candidates form a graph: each pair is an edge between two people, and the
// connected components are "clusters" — all the entities that are (transitively)
// proposed as the same person. Ranking each pair only by its own two endpoints
// buries a whole cluster when most of its members are low-interaction, even if
// one member is important. So: a candidate's interaction score is the MAX across
// its entire cluster, every candidate in a cluster takes the cluster's best rank,
// and the sort keeps a cluster's candidates contiguous (ordered within by their
// own per-pair rank). One important member lifts and groups the whole cluster.

/** Minimal candidate shape the cluster ranker needs. */
export interface ClusterRankInput {
  id: string;
  /** Resolved person ids on both sides (the graph nodes this edge connects). */
  personIds: string[];
  /** Base name-overlap score in [0,1]. */
  score: number;
  /** Name-match strength multiplier; null/undefined → neutral 1. */
  matchStrength?: number | null;
}

export type ClusterRanked<T extends ClusterRankInput> = T & {
  rankScore: number;
  /** Cluster (connected-component) id this candidate belongs to. */
  clusterId: string;
  /** Max interaction score across the cluster (propagated to every member). */
  clusterInteraction: number;
  importanceBoost: number;
};

/**
 * Rank candidates cluster-aware and return them in display order: clusters
 * ordered by their strongest member, candidates within a cluster contiguous and
 * ordered by their own per-pair rank.
 *
 * `interactionOf(personId)` supplies each person's interaction score. A
 * candidate whose sides resolve to no person forms its own singleton cluster.
 *
 * `isPersonOf(personId)` (optional) reports whether a node is a real person (vs
 * an org/role mailbox). When supplied, person↔person candidates rank above
 * org-mailbox noise: a candidate whose nodes are all persons keeps full weight,
 * a mixed person/org candidate is damped, and an org-only candidate is damped
 * hardest — so the genuine-person review queue floats to the top.
 */
export function rankCandidateClusters<T extends ClusterRankInput>(
  cands: readonly T[],
  interactionOf: (personId: string) => number,
  isPersonOf?: (personId: string) => boolean,
): ClusterRanked<T>[] {
  // Union-find over person ids (path-halving + union-by-nothing; sets are tiny).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      // The component id is the lexicographically smallest node, independent
      // of candidate SELECT order. Cursor paging binds to this id, so the same
      // graph must produce the same cluster identity on every worker.
      const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
      parent.set(child, root);
    }
  };

  // Each candidate contributes its person nodes; a side-less candidate gets a
  // synthetic node so it still forms a (singleton) cluster.
  const candNode = new Map<string, string>();
  for (const c of cands) {
    const nodes = c.personIds.length > 0 ? c.personIds : [`cand:${c.id}`];
    nodes.forEach((n) => find(n));
    for (let i = 1; i < nodes.length; i++) union(nodes[0], nodes[i]);
    candNode.set(c.id, nodes[0]);
  }

  // Cluster max interaction, propagated from every person node.
  const clusterInteraction = new Map<string, number>();
  for (const c of cands) {
    for (const pid of c.personIds) {
      const root = find(pid);
      clusterInteraction.set(root, Math.max(clusterInteraction.get(root) ?? 0, interactionOf(pid)));
    }
  }

  const ranked: ClusterRanked<T>[] = cands.map((c) => {
    const root = find(candNode.get(c.id)!);
    const ci = clusterInteraction.get(root) ?? 0;
    const importanceBoost = Math.log(1 + 1000 * ci);
    // Person-vs-org kind factor: all-person → 1, mixed → 0.4, org-only → 0.15.
    let kindFactor = 1;
    if (isPersonOf && c.personIds.length > 0) {
      const nPerson = c.personIds.filter(isPersonOf).length;
      kindFactor = nPerson === c.personIds.length ? 1 : nPerson > 0 ? 0.4 : 0.15;
    }
    const rankScore = c.score * importanceBoost * (c.matchStrength ?? 1) * kindFactor;
    return { ...c, rankScore, clusterId: root, clusterInteraction: ci, importanceBoost };
  });

  // Cluster rank = its strongest candidate's rankScore.
  const clusterRank = new Map<string, number>();
  for (const r of ranked) {
    clusterRank.set(r.clusterId, Math.max(clusterRank.get(r.clusterId) ?? 0, r.rankScore));
  }

  ranked.sort((a, b) => {
    const ca = clusterRank.get(a.clusterId)!;
    const cb = clusterRank.get(b.clusterId)!;
    if (cb !== ca) return cb - ca; // stronger clusters first
    if (a.clusterId !== b.clusterId) return a.clusterId < b.clusterId ? -1 : 1; // keep clusters contiguous
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    return a.id.localeCompare(b.id); // total order within an exact-rank tie
  });
  return ranked;
}
