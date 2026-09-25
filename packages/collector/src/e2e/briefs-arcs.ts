// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs "test life" arc kit — seeded generation of the planted
 * commitment→resolution arcs the reconcile-quality instrument delivers
 * over time.
 *
 * An **arc** is an ordered set of documents (steps) plus, per document,
 * the behavior a *correct* Cognition Steward takes when its data run processes
 * that document. The scripted fake model (`fake-loop-model.ts`) executes
 * those behaviors through the REAL tool layer; the reconcile e2e (and
 * later the scorecard) asserts the resulting loop/brief state against
 * each arc's gold expectations.
 *
 * Arc STRUCTURE is fixed; SURFACE details (names, vendors, invoice
 * numbers, subjects) derive from a seed:
 *   - the frozen seed (`FROZEN_ARC_SEED`) gives comparable numbers
 *     across runs/commits;
 *   - a fresh seed (the scorecard's overfitting detector) re-skins the
 *     same structures.
 *
 * Everything here is INVENTED (privacy rule): fictional people on
 * RFC-2606 reserved domains, fictional vendors, no corpus-derived
 * anything. Delivery timestamps are NOT baked in — the driver assigns
 * them at push time so the waker's recency gate sees live data (except
 * steps that explicitly model stale/backfill data via `sourceAgeDays`).
 */

// ── seeded PRNG (mulberry32 — tiny, deterministic, dependency-free) ────────

export const FROZEN_ARC_SEED = 137;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── invented surface pools (fictional by construction) ─────────────────────

const FIRST_NAMES = ["Maya", "Jamie", "Priya", "Marcus", "Elena", "Tobias", "Nadia", "Felix"];
const LAST_NAMES = ["Reeves", "Lopez", "Nair", "Holt", "Vasquez", "Brandt", "Okafor", "Marsh"];
const VENDORS = [
  "Cedar Grove Supplies",
  "Stellar Sound",
  "Studio Northstar",
  "Riverside Estate",
  "Bluepine Rentals",
];
const CAMP_SITES = ["Silver Lake", "Pinecrest", "Eagle Ridge", "Foxglove Hollow"];
const DOC_TOPICS = [
  "Q4 budget review",
  "workshop agenda",
  "renovation punch list",
  "trip packing plan",
];
const DECISION_TOPICS = [
  "autumn offsite",
  "spring workshop",
  "harvest fair stand",
  "launch picnic",
];

interface Person {
  name: string;
  email: string;
}

// ── arc model ───────────────────────────────────────────────────────────────

/** What a CORRECT agent does with one processed document. */
export type ArcAction =
  | {
      /** Reconcile-first commitment: search the marker; adopt an existing
       * loop (ledger append) or create loop + awareness brief. */
      kind: "commit";
      marker: string;
      loopTitle: string;
      briefTitle: string;
      searchQuery: string;
      /**
       * Skip the reconcile step and always create, even when the search
       * found a matching loop. Only saboteur behavior tables set this —
       * it models the duplicate-minting failure the scorecard must flag.
       */
      forceCreate?: boolean;
    }
  | {
      /** Resolution datum: search the marker; unambiguous → close the loop
       * silently (state done + attached-brief cleanup); ambiguous → attach
       * a confirmation brief and leave the loop open. */
      kind: "resolve";
      marker: string;
      ambiguous: boolean;
      searchQuery: string;
      ledgerNote: string;
      /** Present when `ambiguous` — the confirm brief's title. */
      confirmBriefTitle?: string;
    }
  | {
      /** New information on an existing loop: search + ledger append only. */
      kind: "note";
      marker: string;
      searchQuery: string;
      ledgerNote: string;
    }
  | {
      /**
       * A commitment datum whose fulfilment ALREADY happened — the
       * resolution synced before the request (out-of-order delivery).
       * Reconcile; if a matching open loop somehow exists, close it;
       * otherwise track the obligation as a loop created and immediately
       * closed, with a ledger note. No brief either way — nothing needs
       * the user. */
      kind: "resolvedCommit";
      marker: string;
      loopTitle: string;
      searchQuery: string;
      ledgerNote: string;
    }
  | {
      /**
       * A dated actionable to-do (a scheduled/due date in the prose AND
       * `metadata.extra.scheduled`): reconcile, then create a tracked loop
       * plus a brief that stays HIDDEN until the morning of the scheduled
       * day (`nextShow`) with `eventAt` on the day, and a re-verify
       * `schedule_agent_run` for that day tied to the loop (`loopId`) so it
       * auto-retracts if the task completes first. Dated items only — an
       * undated to-do gets `ignore`. */
      kind: "schedule";
      marker: string;
      loopTitle: string;
      briefTitle: string;
      searchQuery: string;
      /** ISO 8601: the morning of the scheduled day → the brief's nextShow. */
      nextShow: string;
      /** ISO 8601: the scheduled day → the brief's eventAt. */
      eventAt: string;
      /** ISO 8601: when the re-verify run fires (the scheduled day). */
      scheduleWhen: string;
    }
  | {
      /**
       * A correction reveals the tracked obligation never belonged to the
       * user (a misdirected request, a misread): search the marker and
       * DELETE the matched loop — attached briefs cascade. Marking it
       * `done` would be the wrong verb: nothing was fulfilled, so there
       * is no history to preserve; the record itself was the mistake.
       * No-op when no loop matches. */
      kind: "retract";
      marker: string;
      searchQuery: string;
    }
  | {
      /** Awareness-only datum: create a standalone `info` brief (no loop) —
       * interesting context worth surfacing, nothing to act on. */
      kind: "inform";
      marker: string;
      briefTitle: string;
    }
  | {
      /** Eligible but unimportant: fetch, decide it doesn't matter, finish. */
      kind: "ignore";
    };

/** Per-document behavior: what the agent does on the created event, and
 * (for updatable documents) on subsequent updated events. */
export interface ArcDocBehavior {
  onCreated: ArcAction;
  onUpdated?: ArcAction;
}

export interface ArcDocument {
  /** Stable per-set key, also the pushed document's externalId. */
  externalId: string;
  documentType: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** When set, the driver dates the datum this many days in the past
   * (models stale/backfill data the recency gate must skip). */
  sourceAgeDays?: number;
  behavior: ArcDocBehavior;
}

interface ArcStep {
  doc: ArcDocument;
  /** Waker-level expectation for this datum. */
  expectRun: boolean;
  /**
   * Deliver this step AFTER every arc's regular steps — the long-horizon
   * probe: the whole rest of the day's traffic lands between the arc's
   * earlier steps and this one, so reconcile must find a loop that is no
   * longer recent context.
   */
  late?: boolean;
}

export interface Arc {
  id: string;
  kind:
    | "invoice"
    | "invoice-twin"
    | "request"
    | "doc-edit"
    | "concurrent"
    | "quote-bait"
    | "restatement"
    | "out-of-order"
    | "long-horizon"
    | "shared-person"
    | "decision"
    | "mistaken"
    | "nudge"
    | "feedback-handled"
    | "feedback-noise"
    | "feedback-snooze"
    | "feedback-ack"
    | "feedback-wrong"
    | "distractor-bulk"
    | "distractor-stale"
    | "distractor-boring";
  /** The stable token gold matching keys on (never title strings). */
  marker: string | null;
  steps: ArcStep[];
  gold: ArcGold;
  /**
   * Post-steps user reaction the driver simulates: dismiss the arc's brief
   * with this reason through the REAL dismissal endpoint, then wait for the
   * feedback run it enqueues. All five dismiss-modal reactions are modelled
   * (already_handled -> related loops close as done; not_relevant and wrong
   * -> related loops are deleted; snoozed -> loops stay open, the brief
   * re-surfaces at the picked time; acknowledged -> the info brief is
   * deleted, no loop changes); the gold asserts the post-feedback state.
   */
  dismissal?: {
    reason: "already_handled" | "not_relevant" | "snoozed" | "acknowledged" | "wrong";
    /** For `snoozed`: the user-picked re-surface time, hours from dismissal. */
    snoozeHours?: number;
  };
}

/** Fuzzy gold: expected end-state, keyed by marker (cited docs / states),
 * never by exact title strings. */
interface ArcGold {
  /** Loops whose title carries the marker, at arc end. */
  loopsWithMarker: number;
  /** Final state of the arc's principal loop (when one exists). */
  finalLoopState?: "open" | "done";
  /** Active (unread/read) briefs attached to the arc's loop at arc end. */
  activeAttachedBriefs?: number;
  /**
   * The agent may also legitimately leave ZERO attributed loops (e.g. the
   * out-of-order arc: deciding an already-fulfilled obligation needs no
   * tracking is correct) — but any loop that DOES exist must satisfy
   * `finalLoopState`. Such arcs are excluded from loop-tracking recall,
   * and their resolution check demands no attributed loop is left `open`.
   */
  zeroLoopsAcceptable?: boolean;
}

export interface ArcSet {
  seed: number;
  people: Person[];
  arcs: Arc[];
  /** title → behavior lookup the scripted model keys on. */
  behaviors: Map<string, ArcDocBehavior>;
  /** The two content revisions the doc-edit arc applies (same externalId). */
  docEditRevisions: [string, string];
}

// ── generation ──────────────────────────────────────────────────────────────

function pick<T>(rand: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rand() * pool.length)]!;
}

function invoiceNumber(rand: () => number): string {
  return `INV-${1000 + Math.floor(rand() * 9000)}`;
}

function emailFor(name: string, domain: string): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`;
}

function vendorDomain(vendor: string): string {
  return `${vendor.toLowerCase().replace(/[^a-z]+/g, "")}.example`;
}

/**
 * Generate the arc set for a seed. Structure is FIXED (same arcs, same
 * step counts, same expectations); only surface details vary.
 */
export function generateArcSet(seed: number): ArcSet {
  const rand = mulberry32(seed);

  const people: Person[] = [];
  const usedNames = new Set<string>();
  while (people.length < 4) {
    const name = `${pick(rand, FIRST_NAMES)} ${pick(rand, LAST_NAMES)}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    people.push({
      name,
      email: emailFor(name, people.length % 2 === 0 ? "example.com" : "example.org"),
    });
  }
  const [contact1, contact2, contact3, contact4] = people as [Person, Person, Person, Person];

  const vendor = pick(rand, VENDORS);
  const vendorBilling = `billing@${vendorDomain(vendor)}`;
  const invoiceA = invoiceNumber(rand);
  let invoiceB = invoiceNumber(rand);
  while (invoiceB === invoiceA) invoiceB = invoiceNumber(rand);
  const site = pick(rand, CAMP_SITES);
  const topic = pick(rand, DOC_TOPICS);
  const concurrentMarker = `${site.replace(/\s+/g, "-")}-deposit`;

  // Surfaces for the cruel-trap arcs — drawn AFTER every earlier draw so
  // seed-derived surfaces stay a pure function of the draw sequence.
  let vendor2 = pick(rand, VENDORS);
  while (vendor2 === vendor) vendor2 = pick(rand, VENDORS);
  const vendor2Billing = `billing@${vendorDomain(vendor2)}`;
  let invoiceC = invoiceNumber(rand);
  while (invoiceC === invoiceA || invoiceC === invoiceB) invoiceC = invoiceNumber(rand);
  const quoteC = `QT-${1000 + Math.floor(rand() * 9000)}`;
  const rentalMarker = `rental-${100 + Math.floor(rand() * 900)}`;
  const regMarker = `REG-${1000 + Math.floor(rand() * 9000)}`;
  const decisionTopic = pick(rand, DECISION_TOPICS);
  const decisionMarker = `${decisionTopic.replace(/\s+/g, "-")}-venue`;
  // The near-dup bait's shared surface: vendor2 bills the SAME amount on
  // two DIFFERENT obligations (an invoice to pay vs. a quote to decide on).
  const sameAmount = "$250.00";
  // Round-2 trap surfaces — again drawn AFTER every earlier draw, so the
  // pre-existing arcs keep byte-identical surfaces for a given seed.
  const waiverMarker = `WVR-${1000 + Math.floor(rand() * 9000)}`;
  const contractMarker = `CT-${1000 + Math.floor(rand() * 9000)}`;
  const cutterMarker = `TL-${100 + Math.floor(rand() * 900)}`;
  const keyMarker = `KEY-${100 + Math.floor(rand() * 900)}`;
  // Round-3 trap surfaces — drawn AFTER every earlier draw, so all
  // pre-existing arcs keep byte-identical surfaces for a given seed.
  const poMarker = `PO-${1000 + Math.floor(rand() * 9000)}`;
  const headcountMarker = `HC-${100 + Math.floor(rand() * 900)}`;
  // Round-4 (feedback) surfaces — drawn AFTER every earlier draw.
  const gymMarker = `GM-${1000 + Math.floor(rand() * 9000)}`;
  const fairMarker = `EB-${100 + Math.floor(rand() * 900)}`;
  const concertMarker = `SN-${1000 + Math.floor(rand() * 9000)}`;
  const outageMarker = `WO-${100 + Math.floor(rand() * 900)}`;
  const orderMarker = `DP-${1000 + Math.floor(rand() * 9000)}`;

  const arcs: Arc[] = [];

  // 1. invoice → payment (unambiguous resolution → silent close).
  arcs.push({
    id: "invoice",
    kind: "invoice",
    marker: invoiceA,
    gold: { loopsWithMarker: 1, finalLoopState: "done", activeAttachedBriefs: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-invoice-${invoiceA}-1`,
          documentType: "email",
          title: `Invoice ${invoiceA} from ${vendor}`,
          content: [
            `Hi, please find attached invoice ${invoiceA} for the recent order.`,
            `Amount due: $184.00, payable within 14 days.`,
            `Thanks, ${vendor} billing (${vendorBilling})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: invoiceA,
              loopTitle: `Pay invoice ${invoiceA} from ${vendor}`,
              briefTitle: `Invoice ${invoiceA} needs payment`,
              searchQuery: `invoice ${invoiceA} ${vendor}`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-invoice-${invoiceA}-2`,
          documentType: "email",
          title: `Payment received for invoice ${invoiceA}`,
          content: [
            `We confirm receipt of your payment of $184.00 for invoice ${invoiceA}.`,
            `No further action is needed. — ${vendor}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "resolve",
              marker: invoiceA,
              ambiguous: false,
              searchQuery: `invoice ${invoiceA}`,
              ledgerNote: `Payment for ${invoiceA} confirmed by ${vendor}; closing.`,
            },
          },
        },
      },
    ],
  });

  // 1b. cross-day long-horizon resolution: the commitment is DAYS old (a
  //     still-live datum dated in the past) and delivered first; its
  //     resolution is a `late` step, delivered only after every other
  //     arc's traffic — so by resolution time the loop is buried under a
  //     full day of intervening datums and the commitment datum itself is
  //     days stale. Probes that reconcile still fires on an OLD loop
  //     instead of leaning on recent context.
  arcs.push({
    id: "long-horizon",
    kind: "long-horizon",
    marker: contractMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "done", activeAttachedBriefs: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-longhorizon-${contractMarker}-1`,
          documentType: "email",
          title: `Venue contract ${contractMarker} needs your signature`,
          content: [
            `Please sign and return the venue contract ${contractMarker} — the`,
            `venue is only holding our date until the end of the month.`,
            `— ${contact4.name} (${contact4.email})`,
          ].join("\n"),
          sourceAgeDays: 3,
          behavior: {
            onCreated: {
              kind: "commit",
              marker: contractMarker,
              loopTitle: `Return the signed venue contract ${contractMarker}`,
              briefTitle: `Venue contract ${contractMarker} needs your signature`,
              searchQuery: `venue contract ${contractMarker}`,
            },
          },
        },
      },
      {
        expectRun: true,
        late: true,
        doc: {
          externalId: `arc-longhorizon-${contractMarker}-2`,
          documentType: "email",
          title: `Contract ${contractMarker} fully executed`,
          content: [
            `We received your signed copy of contract ${contractMarker} — it is`,
            `now fully executed. Nothing further is needed from you.`,
            `— the venue office`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "resolve",
              marker: contractMarker,
              ambiguous: false,
              searchQuery: `venue contract ${contractMarker}`,
              ledgerNote: `Countersigned copy of ${contractMarker} received; closing.`,
            },
          },
        },
      },
    ],
  });

  // 2. near-duplicate bait: a SECOND invoice from the same vendor. Must
  //    become its own loop and stay open (no resolution is delivered).
  arcs.push({
    id: "invoice-twin",
    kind: "invoice-twin",
    marker: invoiceB,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-invoice-${invoiceB}-1`,
          documentType: "email",
          title: `Invoice ${invoiceB} from ${vendor}`,
          content: [
            `Hi, invoice ${invoiceB} covers the follow-up order from last week.`,
            `Amount due: $92.50, payable within 14 days.`,
            `Thanks, ${vendor} billing (${vendorBilling})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: invoiceB,
              loopTitle: `Pay invoice ${invoiceB} from ${vendor}`,
              briefTitle: `Invoice ${invoiceB} needs payment`,
              searchQuery: `invoice ${invoiceB} ${vendor}`,
            },
          },
        },
      },
    ],
  });

  // 3. request → ambiguous fulfilment (confirm brief, loop stays open).
  // The ambiguity refreshes the commit-time awareness card into the
  // confirmation card: one obligation remains one active card.
  const leaseMarker = "Harborview-lease";
  arcs.push({
    id: "request",
    kind: "request",
    marker: leaseMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open", activeAttachedBriefs: 1 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: "arc-request-1",
          documentType: "email",
          title: `${contact1.name} needs the ${leaseMarker} paperwork`,
          content: [
            `Hi — for the ${leaseMarker} signing we still need two documents from you:`,
            `the signed disclosure and the insurance certificate.`,
            `Could you send them this week? ${contact1.name} (${contact1.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: leaseMarker,
              loopTitle: `Send ${leaseMarker} documents to ${contact1.name}`,
              briefTitle: `${contact1.name} is waiting on the ${leaseMarker} documents`,
              searchQuery: leaseMarker,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: "arc-request-2",
          documentType: "email",
          title: `Re: ${leaseMarker} — got one attachment`,
          content: [
            `Thanks, the disclosure came through. I don't see the insurance`,
            `certificate yet — maybe it didn't attach? ${contact1.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "resolve",
              marker: leaseMarker,
              ambiguous: true,
              searchQuery: leaseMarker,
              ledgerNote: `Partial fulfilment: disclosure received, certificate still missing.`,
              confirmBriefTitle: `Is the ${leaseMarker} paperwork fully sent?`,
            },
          },
        },
      },
    ],
  });

  // 4. updatable document edited twice (diff-engine arc). The created event
  //    is unimportant; the folded update warrants a ledger note on the
  //    concurrent-arc loop? No — it stands alone: the correct behavior for
  //    the update is to record nothing loop-worthy (ignore) — the arc's
  //    value is exercising the fold+diff plumbing, asserted by the e2e via
  //    the model-server transcript, not via loop state.
  const docEditMarkers = { first: `${topic} rev-alpha`, second: `${topic} rev-beta` };
  arcs.push({
    id: "doc-edit",
    kind: "doc-edit",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: "arc-doc-edit",
          documentType: "document",
          title: `Shared notes: ${topic}`,
          content: `Draft outline for the ${topic}. Nothing actionable yet.`,
          behavior: {
            onCreated: { kind: "ignore" },
            onUpdated: { kind: "ignore" },
          },
        },
      },
    ],
  });
  // Edits the driver applies to arc-doc-edit (same externalId, new content).
  // Shared through the set so the diff-spans-both-edits assert and the
  // pushes use identical strings.
  const docEditRevisions: [string, string] = [
    `Draft outline for the ${topic}. Added section: ${docEditMarkers.first}.`,
    `Draft outline for the ${topic}. Added section: ${docEditMarkers.first}. Final pass: ${docEditMarkers.second}.`,
  ];

  // 5. concurrent arrival (criterion 4's N>=2 case): the same commitment
  //    reaches the corpus twice at once (original + forwarded copy). A
  //    correct serialized agent mints ONE loop; the second run adopts it.
  const concurrentCommit = (suffix: string, title: string, from: Person): ArcDocument => ({
    externalId: `arc-concurrent-${suffix}`,
    documentType: "email",
    title,
    content: [
      `Reminder: the ${site} campsite deposit (${concurrentMarker}) is due by Friday.`,
      `Can you wire the $60 deposit and confirm? — ${from.name} (${from.email})`,
    ].join("\n"),
    behavior: {
      onCreated: {
        kind: "commit",
        marker: concurrentMarker,
        loopTitle: `Wire the ${site} deposit (${concurrentMarker})`,
        briefTitle: `${site} deposit due Friday`,
        searchQuery: concurrentMarker,
      },
    },
  });
  arcs.push({
    id: "concurrent",
    kind: "concurrent",
    marker: concurrentMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: concurrentCommit("a", `${site} deposit due Friday (${concurrentMarker})`, contact2),
      },
      {
        expectRun: true,
        doc: concurrentCommit(
          "b",
          `Fwd: ${site} deposit due Friday (${concurrentMarker})`,
          contact3,
        ),
      },
    ],
  });

  // 6. distractors: bulk mail (waker skips), stale/backfill (recency gate
  //    skips), and an eligible-but-boring email (agent reads, does nothing).
  arcs.push({
    id: "distractor-bulk",
    kind: "distractor-bulk",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: false,
        doc: {
          externalId: "arc-distractor-bulk",
          documentType: "email",
          title: "Weekly gear digest — new arrivals",
          content: "Top picks this week from the gear shop. Unsubscribe any time.",
          metadata: { bulkMail: true },
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  });
  arcs.push({
    id: "distractor-stale",
    kind: "distractor-stale",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: false,
        doc: {
          externalId: "arc-distractor-stale",
          documentType: "email",
          title: `Old thread about the ${topic}`,
          content: "This one is from a month ago and must not wake anything.",
          sourceAgeDays: 30,
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  });
  arcs.push({
    id: "distractor-boring",
    kind: "distractor-boring",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: "arc-distractor-boring",
          documentType: "email",
          title: `${contact4.name} says hi`,
          content: `Nothing needed — just saying the weekend was fun. ${contact4.name}`,
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  });

  // 7. near-dup bait pair: the SAME vendor bills the SAME amount on two
  //    DIFFERENT obligations. The invoice is a payment obligation; the
  //    quote (arc 8) is a decision. A wrong-merge reconciles the quote
  //    onto the invoice loop — caught as a missing quote loop.
  arcs.push({
    id: "obligation-invoice",
    kind: "invoice",
    marker: invoiceC,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-invoice-${invoiceC}-1`,
          documentType: "email",
          title: `Invoice ${invoiceC} from ${vendor2}`,
          content: [
            `Please find invoice ${invoiceC} for the stage lighting install.`,
            `Amount due: ${sameAmount}, payable within 30 days.`,
            `Thanks, ${vendor2} billing (${vendor2Billing})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: invoiceC,
              loopTitle: `Pay invoice ${invoiceC} from ${vendor2}`,
              briefTitle: `Invoice ${invoiceC} needs payment`,
              searchQuery: `invoice ${invoiceC} ${vendor2}`,
            },
          },
        },
      },
    ],
  });

  // 8. the bait itself: same vendor, same amount, a DIFFERENT obligation
  //    (accept/decline a quote, not pay an invoice). Must become its own
  //    loop — reconciling it onto the invoice loop is the planted trap.
  arcs.push({
    id: "obligation-quote",
    kind: "quote-bait",
    marker: quoteC,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-quote-${quoteC}-1`,
          documentType: "email",
          title: `Quote ${quoteC} from ${vendor2}`,
          content: [
            `Quote ${quoteC}: ${sameAmount} for the spring maintenance contract —`,
            `a separate job from the lighting install. Reply to accept before the`,
            `end of the month. — ${vendor2} (${vendor2Billing})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: quoteC,
              loopTitle: `Decide on quote ${quoteC} from ${vendor2}`,
              briefTitle: `Quote ${quoteC} awaits your decision`,
              searchQuery: `quote ${quoteC} ${vendor2}`,
            },
          },
        },
      },
    ],
  });

  // 9. cross-source re-statement: one commitment stated in an email, then
  //    re-stated in a chat message with different wording. Both must
  //    reconcile to ONE loop (the second datum adopts, never mints).
  arcs.push({
    id: "restatement",
    kind: "restatement",
    marker: rentalMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-restatement-${rentalMarker}-1`,
          documentType: "email",
          title: `Marquee rental ${rentalMarker} needs collecting`,
          content: [
            `The marquee rental ${rentalMarker} is booked — someone needs to collect`,
            `it from the rental yard on Thursday morning. Can you take it?`,
            `— ${contact2.name} (${contact2.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: rentalMarker,
              loopTitle: `Collect the marquee rental ${rentalMarker}`,
              briefTitle: `Marquee rental ${rentalMarker} pickup on Thursday`,
              searchQuery: `marquee rental ${rentalMarker}`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-restatement-${rentalMarker}-2`,
          documentType: "message",
          title: `About the marquee (${rentalMarker})`,
          content: [
            `Flagging here too since not everyone reads email: the marquee`,
            `(${rentalMarker}) still needs collecting on Thursday — don't forget!`,
            `— ${contact3.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: rentalMarker,
              loopTitle: `Collect the marquee rental ${rentalMarker}`,
              briefTitle: `Marquee rental ${rentalMarker} pickup on Thursday`,
              searchQuery: `marquee ${rentalMarker}`,
            },
          },
        },
      },
    ],
  });

  // 10. out-of-order resolution: the fulfilment confirmation syncs BEFORE
  //     the request that created the obligation. Correct: the confirmation
  //     alone tracks nothing, and the late request must be recognized as
  //     already settled — zero loops or a done loop are both right; an OPEN
  //     loop demanding the payment is the failure (resolution recall).
  arcs.push({
    id: "out-of-order",
    kind: "out-of-order",
    marker: regMarker,
    gold: {
      loopsWithMarker: 1,
      finalLoopState: "done",
      activeAttachedBriefs: 0,
      zeroLoopsAcceptable: true,
    },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-ooo-${regMarker}-1`,
          documentType: "email",
          title: `Payment received for registration ${regMarker}`,
          content: [
            `We confirm your $95.00 payment for registration ${regMarker}.`,
            `You're all set — no further action needed.`,
          ].join("\n"),
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-ooo-${regMarker}-2`,
          documentType: "email",
          title: `Registration ${regMarker} — payment required`,
          content: [
            `Please pay $95.00 to complete registration ${regMarker} within 10 days.`,
            `— the registrations desk`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "resolvedCommit",
              marker: regMarker,
              loopTitle: `Registration ${regMarker} payment (already settled)`,
              searchQuery: `registration ${regMarker}`,
              ledgerNote: `The ${regMarker} payment was already confirmed before this request synced; tracked as done.`,
            },
          },
        },
      },
    ],
  });

  // 10b. second out-of-order variant — a DIFFERENT obligation type (a
  //      document to return, not a payment) whose settlement evidence has a
  //      DIFFERENT shape: an informal chat acknowledgment from a person,
  //      not a transactional receipt email. The stern "action needed"
  //      request syncs after the casual all-set message; treating it as a
  //      fresh open obligation is the failure. Together with the first
  //      variant and the long-horizon arc this puts four resolutions in
  //      the denominator (recall granularity 0.25, was 0.5).
  arcs.push({
    id: "out-of-order-2",
    kind: "out-of-order",
    marker: waiverMarker,
    gold: {
      loopsWithMarker: 1,
      finalLoopState: "done",
      activeAttachedBriefs: 0,
      zeroLoopsAcceptable: true,
    },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-ooo2-${waiverMarker}-1`,
          documentType: "message",
          title: `Waiver ${waiverMarker} received — all set`,
          content: [
            `Just confirming I got your signed waiver ${waiverMarker} for the`,
            `${site} weekend — you're all set, nothing more needed from you.`,
            `— ${contact4.name}`,
          ].join("\n"),
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-ooo2-${waiverMarker}-2`,
          documentType: "email",
          title: `Action needed: waiver ${waiverMarker} outstanding`,
          content: [
            `Our records show the liability waiver ${waiverMarker} for the`,
            `${site} weekend has not been returned. Please send the signed form`,
            `within 7 days or your spot is released. — the bookings desk`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "resolvedCommit",
              marker: waiverMarker,
              loopTitle: `Waiver ${waiverMarker} (already returned)`,
              searchQuery: `waiver ${waiverMarker}`,
              ledgerNote: `${contact4.name} confirmed receipt of ${waiverMarker} before this reminder synced; tracked as done.`,
            },
          },
        },
      },
    ],
  });

  // 11. multi-datum decision thread: one decision loop, then three updates
  //     across sources that must ALL land on it (ledger appends). Ignoring
  //     any of them is the update-quality failure the gold now measures.
  arcs.push({
    id: "decision-thread",
    kind: "decision",
    marker: decisionMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open", activeAttachedBriefs: 1 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-decision-${decisionMarker}-1`,
          documentType: "email",
          title: `Venue decision for the ${decisionTopic} (${decisionMarker})`,
          content: [
            `We need to lock the venue for the ${decisionTopic} — tracking it as`,
            `${decisionMarker}. Can you own this decision?`,
            `— ${contact2.name} (${contact2.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: decisionMarker,
              loopTitle: `Decide the venue for the ${decisionTopic} (${decisionMarker})`,
              briefTitle: `Venue decision pending for the ${decisionTopic}`,
              searchQuery: decisionMarker,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-decision-${decisionMarker}-2`,
          documentType: "message",
          title: `Rivergate Hall quote (${decisionMarker})`,
          content: [
            `Update for ${decisionMarker}: Rivergate Hall quoted $900 for the`,
            `${decisionTopic}, catering not included. — ${contact3.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "note",
              marker: decisionMarker,
              searchQuery: decisionMarker,
              ledgerNote: `Option: Rivergate Hall quoted $900 (catering excluded).`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-decision-${decisionMarker}-3`,
          documentType: "email",
          title: `The Beacon Room is free (${decisionMarker})`,
          content: [
            `More input on ${decisionMarker}: The Beacon Room is available on our`,
            `preferred date at $750 all-in. — ${contact1.name} (${contact1.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "note",
              marker: decisionMarker,
              searchQuery: decisionMarker,
              ledgerNote: `Option: The Beacon Room available on the preferred date, $750 all-in.`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-decision-${decisionMarker}-4`,
          documentType: "message",
          title: `Where we stand on ${decisionMarker}`,
          content: [
            `Most of us lean toward The Beacon Room for the ${decisionTopic};`,
            `waiting on ${contact1.name}'s dates before locking ${decisionMarker}.`,
            `— ${contact4.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "note",
              marker: decisionMarker,
              searchQuery: decisionMarker,
              ledgerNote: `Group leans Beacon Room; blocked on ${contact1.name}'s dates.`,
            },
          },
        },
      },
    ],
  });

  // 11b. wrong-merge bait on the PEOPLE axis: the SAME person, the SAME
  //      day, two look-alike physical-handoff errands that must stay TWO
  //      loops. The second message's "one more thing for Sunday" is the
  //      bait — a sloppy reconciler sees the person + day match and folds
  //      it into the existing errand loop as an update.
  arcs.push({
    id: "errand-cutter",
    kind: "shared-person",
    marker: cutterMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-errand-${cutterMarker}-1`,
          documentType: "email",
          title: `Bring back the tile cutter (${cutterMarker}) on Sunday`,
          content: [
            `Hey — could you bring back the tile cutter (${cutterMarker}) you`,
            `borrowed when you come over on Sunday? I need it Monday morning.`,
            `— ${contact3.name} (${contact3.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: cutterMarker,
              loopTitle: `Return the tile cutter (${cutterMarker}) to ${contact3.name}`,
              briefTitle: `Tile cutter (${cutterMarker}) goes back on Sunday`,
              searchQuery: `tile cutter ${cutterMarker}`,
            },
          },
        },
      },
    ],
  });
  arcs.push({
    id: "errand-key",
    kind: "shared-person",
    marker: keyMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-errand-${keyMarker}-1`,
          documentType: "message",
          title: `Also for Sunday: the hall key (${keyMarker})`,
          content: [
            `One more thing for Sunday — can you also drop off the spare hall`,
            `key (${keyMarker})? I need to open the annex Monday morning.`,
            `— ${contact3.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: keyMarker,
              loopTitle: `Drop off the hall key (${keyMarker}) to ${contact3.name}`,
              briefTitle: `Hall key (${keyMarker}) drop-off on Sunday`,
              searchQuery: `hall key ${keyMarker}`,
            },
          },
        },
      },
    ],
  });

  // 12. distractor: an informational email from the FIRST vendor — the one
  //     with tracked invoice loops — that carries no obligation at all.
  //     Eligible (no bulk marker); the trap is escalating it into a loop or
  //     grafting it onto the open invoice loop.
  arcs.push({
    id: "distractor-vendor-info",
    kind: "distractor-boring",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: "arc-distractor-vendor-info",
          documentType: "email",
          title: `${vendor} — new opening hours`,
          content: [
            `We're now open Saturdays too. No action needed — just letting our`,
            `regulars know. — the ${vendor} team`,
          ].join("\n"),
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  });

  // 13. distractor: a vague social intention with no concrete commitment —
  //     "sometime" is not a loop.
  arcs.push({
    id: "distractor-social",
    kind: "distractor-boring",
    marker: null,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: "arc-distractor-social",
          documentType: "message",
          title: "Coffee sometime?",
          content: `We should get coffee sometime soon — no rush, whenever works. ${contact1.name}`,
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  });

  // 14. mistaken commit → retraction: the request reads as a real
  //     obligation and is correctly tracked, then a follow-up reveals it
  //     was never the user's ("sent to you by mistake"). The correct verb
  //     is open_loop_delete — the loop should never have existed, so there
  //     is no history to preserve. Marking it done instead fabricates a
  //     fulfilment that never happened. Probes the REVERSE direction of
  //     the done-vs-delete rule (the settled-obligation arcs probe the
  //     other: never delete what actually got done).
  arcs.push({
    id: "mistaken-commit",
    kind: "mistaken",
    marker: poMarker,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-mistaken-${poMarker}-1`,
          documentType: "email",
          title: `Purchase order ${poMarker} — approval needed by Thursday`,
          content: [
            `Hi, purchase order ${poMarker} is waiting on an approval before`,
            `Thursday — can you take care of it?`,
            `— ${contact2.name} (${contact2.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: poMarker,
              loopTitle: `Approve purchase order ${poMarker}`,
              briefTitle: `Purchase order ${poMarker} needs your approval`,
              searchQuery: `purchase order ${poMarker}`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-mistaken-${poMarker}-2`,
          documentType: "email",
          title: `Re: ${poMarker} — please disregard, wrong person`,
          content: [
            `Sorry — ${poMarker} went to you by mistake; the approval is`,
            `${contact4.name}'s, not yours. Nothing is needed from you,`,
            `please disregard my earlier email. — ${contact2.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "retract",
              marker: poMarker,
              searchQuery: `purchase order ${poMarker}`,
            },
          },
        },
      },
    ],
  });

  // 15. wording-poor nudge: the same person chases a tracked commitment in
  //     words that share NO distinctive token with the request (no marker,
  //     none of the original nouns). The correct move is reconciling onto
  //     the EXISTING loop — via the shared person and the surrounding
  //     context — and recording the nudge as a ledger note, not minting a
  //     fresh loop. The granularity rule's converse guard: separate asks
  //     are separate loops, but the SAME obligation stays ONE loop no
  //     matter how the reminder is phrased.
  arcs.push({
    id: "nudge",
    kind: "nudge",
    marker: headcountMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-nudge-${headcountMarker}-1`,
          documentType: "email",
          title: `Headcount confirmation ${headcountMarker} for the team dinner`,
          content: [
            `Could you confirm the final headcount (${headcountMarker}) for`,
            `the team dinner by Friday? The caterer needs the number.`,
            `— ${contact4.name} (${contact4.email})`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: headcountMarker,
              loopTitle: `Confirm the team-dinner headcount (${headcountMarker})`,
              briefTitle: `Headcount ${headcountMarker} needed by Friday`,
              searchQuery: `headcount ${headcountMarker}`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-nudge-${headcountMarker}-2`,
          documentType: "message",
          // Deliberately shares no distinctive token with the request:
          // no marker, no "headcount", no "team dinner".
          title: "Sorry to chase!",
          content: [
            `Gentle nudge — still waiting on that final number for the`,
            `caterer. Need it before Friday, sorry to chase!`,
            `— ${contact4.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "note",
              marker: headcountMarker,
              searchQuery: `headcount ${headcountMarker}`,
              ledgerNote: `Nudge from ${contact4.name}: the caterer still needs the final number (${headcountMarker}).`,
            },
          },
        },
      },
    ],
  });

  // 16. feedback: already-handled dismissal. A real commitment is tracked
  //     and briefed; the user dismisses the brief as ALREADY HANDLED. The
  //     feedback run must close the related loop as done (the thing got
  //     handled outside the corpus' view — that is a fulfilment, and the
  //     record stays), never delete it.
  arcs.push({
    id: "feedback-handled",
    kind: "feedback-handled",
    marker: gymMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "done", activeAttachedBriefs: 0 },
    dismissal: { reason: "already_handled" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-fb-handled-${gymMarker}-1`,
          documentType: "email",
          title: `Membership ${gymMarker} lapses next week — renew now`,
          content: [
            `Your studio membership ${gymMarker} lapses at the end of next`,
            `week. Renew online any time before then to keep your rate.`,
            `— the front desk`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: gymMarker,
              loopTitle: `Renew membership ${gymMarker} before it lapses`,
              briefTitle: `Membership ${gymMarker} lapses next week`,
              searchQuery: `membership ${gymMarker}`,
            },
          },
        },
      },
    ],
  });

  // 17. feedback: not-relevant dismissal. A direct personal ask — real
  //     enough that a correct agent tracks and briefs it — turns out to be
  //     something the user does not care about: they dismiss the brief as
  //     NOT RELEVANT. The feedback run must delete the related loop
  //     (tracking it was the mistake, per the user), not keep it open and
  //     not mark it done. The ask is deliberately commitment-shaped (a
  //     named contact, a question needing an answer, a deadline) so the
  //     importance gate reliably tracks it — the arc probes the feedback
  //     reaction, not the gate.
  arcs.push({
    id: "feedback-not-relevant",
    kind: "feedback-noise",
    marker: fairMarker,
    gold: { loopsWithMarker: 0 },
    dismissal: { reason: "not_relevant" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-fb-noise-${fairMarker}-1`,
          documentType: "message",
          title: `Stand ${fairMarker} at the harvest fair — want one this year?`,
          content: [
            `Are you taking a stand (${fairMarker}) at the harvest fair`,
            `again this year? Early-bird pricing ends Friday — tell me by`,
            `then and I'll book yours alongside ours. — ${contact1.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: fairMarker,
              loopTitle: `Answer ${contact1.name} about the stand (${fairMarker}) by Friday`,
              briefTitle: `Stand ${fairMarker}: answer needed before Friday's early-bird deadline`,
              searchQuery: `stand ${fairMarker}`,
            },
          },
        },
      },
    ],
  });

  // 18. feedback: snoozed dismissal. A dated commitment is tracked and
  //     briefed; the user snoozes the brief ("show me later", with a
  //     picked time). The feedback run must honour the time on the brief
  //     and KEEP the loop open — snooze means later, never never.
  arcs.push({
    id: "feedback-snooze",
    kind: "feedback-snooze",
    marker: concertMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "open" },
    dismissal: { reason: "snoozed", snoozeHours: 24 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-fb-snooze-${concertMarker}-1`,
          documentType: "message",
          title: `Winter concert tickets (${concertMarker}) go on sale Monday`,
          content: [
            `Tickets for the winter concert (${concertMarker}) go on sale`,
            `Monday morning — they sold out fast last year, grab ours early?`,
            `— ${contact2.name}`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: concertMarker,
              loopTitle: `Buy winter concert tickets (${concertMarker}) when sales open Monday`,
              briefTitle: `Winter concert tickets (${concertMarker}) on sale Monday`,
              searchQuery: `concert tickets ${concertMarker}`,
            },
          },
        },
      },
    ],
  });

  // 19. feedback: acknowledged dismissal. A no-action awareness datum is
  //     surfaced as a standalone info brief; the user acknowledges it.
  //     The feedback run must just delete the brief — no loop mutations
  //     (there is no loop, and inventing one now would be noise).
  arcs.push({
    id: "feedback-ack",
    kind: "feedback-ack",
    marker: outageMarker,
    gold: { loopsWithMarker: 0 },
    dismissal: { reason: "acknowledged" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-fb-ack-${outageMarker}-1`,
          documentType: "email",
          title: `Water shut-off ${outageMarker}: Thursday 8am-12pm`,
          content: [
            `Notice ${outageMarker} from the building manager: water will be`,
            `shut off this Thursday 8am-12pm for pipe maintenance. No action`,
            `needed — just so you can plan around it.`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "inform",
              marker: outageMarker,
              briefTitle: `Water shut-off ${outageMarker} Thursday morning (8am-12pm)`,
            },
          },
        },
      },
    ],
  });

  // 20. feedback: wrong dismissal. A payment demand is tracked as an
  //     obligation; the user dismisses the brief as WRONG — the agent's
  //     understanding was incorrect (nothing is owed). The feedback run
  //     must delete the related loop; marking it done would fabricate a
  //     payment that never happened, and keeping it open ignores the user.
  arcs.push({
    id: "feedback-wrong",
    kind: "feedback-wrong",
    marker: orderMarker,
    gold: { loopsWithMarker: 0 },
    dismissal: { reason: "wrong" },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-fb-wrong-${orderMarker}-1`,
          documentType: "email",
          title: `Payment failed for order ${orderMarker} — settle within 48 hours`,
          content: [
            `Your payment for order ${orderMarker} could not be processed.`,
            `Please settle the outstanding balance of $49.00 within 48 hours`,
            `to avoid cancellation. — billing team`,
          ].join("\n"),
          behavior: {
            onCreated: {
              kind: "commit",
              marker: orderMarker,
              loopTitle: `Settle failed payment for order ${orderMarker} ($49)`,
              briefTitle: `Order ${orderMarker}: payment failed — settle within 48h`,
              searchQuery: `order ${orderMarker} payment`,
            },
          },
        },
      },
    ],
  });

  const behaviors = new Map<string, ArcDocBehavior>();
  for (const arc of arcs) {
    for (const step of arc.steps) behaviors.set(step.doc.title, step.doc.behavior);
  }

  return { seed, people, arcs, behaviors, docEditRevisions };
}

/** Find an arc by id (throws — a missing arc is a broken fixture). */
export function arcById(set: ArcSet, id: string): Arc {
  const arc = set.arcs.find((a) => a.id === id);
  if (!arc) throw new Error(`no arc with id "${id}" in seed ${set.seed}`);
  return arc;
}

// ── same-thread reconcile arc (identity-based reconcile candidates) ─────────

/**
 * A two-message email THREAD that exercises graph-based reconcile: message 1
 * is a booking request that a correct agent tracks as a loop; message 2 is a
 * bare confirmation in the SAME thread whose wording shares nothing with the
 * loop (no marker, no booking/studio/confirm tokens). Lexical and semantic
 * reconcile both miss such a reply — only the shared-thread identity signal
 * links it back, so the confirmation must reconcile onto the existing loop
 * and close it rather than mint a duplicate.
 *
 * Both messages carry the same `metadata.extra.threadId`, from which link
 * extraction derives the resolved `part-of-thread` edge the identity search
 * walks. Standalone (not part of the frozen scorecard arc set) so the
 * daily-mix baseline stays untouched — the reconcile e2e drives it directly.
 * Surface details are INVENTED (privacy rule).
 */
export interface ThreadReconcileArc {
  marker: string;
  threadId: string;
  /** Step 0 opens the loop; step 1 is the same-thread confirmation. */
  arc: Arc;
  /** title → behavior for the scripted model (merge into its behavior map). */
  behaviors: Map<string, ArcDocBehavior>;
}

export function generateThreadReconcileArc(): ThreadReconcileArc {
  const marker = "BK-7788";
  const threadId = "thread-booking-reconcile";
  const requestTitle = `Booking confirmation needed (${marker})`;
  // Deliberately shares no token with the loop the request opens.
  const confirmTitle = "Re: sounds good";

  const arc: Arc = {
    id: "thread-reconcile",
    kind: "request",
    marker,
    gold: { loopsWithMarker: 1, finalLoopState: "done", activeAttachedBriefs: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-thread-${marker}-1`,
          documentType: "email",
          title: requestTitle,
          content: [
            `Hi — can you confirm the studio booking ${marker} for next Saturday?`,
            `Let me know and I'll hold the slot. — Studio Northstar`,
          ].join("\n"),
          metadata: { extra: { threadId } },
          behavior: {
            onCreated: {
              kind: "commit",
              marker,
              loopTitle: `Confirm the studio booking ${marker}`,
              briefTitle: `Studio booking ${marker} needs confirmation`,
              searchQuery: `booking ${marker} studio`,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-thread-${marker}-2`,
          documentType: "email",
          // A bare confirmation — no marker, no booking/studio/confirm words.
          title: confirmTitle,
          content: `Great, that works for me — looking forward to it. Thanks!`,
          metadata: { extra: { threadId } },
          behavior: {
            onCreated: {
              kind: "resolve",
              marker,
              ambiguous: false,
              // A query drawn from the reply's own words — it lexically and
              // semantically misses the loop, so only identity can reconcile.
              searchQuery: "great works looking forward thanks",
              ledgerNote: `Confirmation received in the same thread; closing ${marker}.`,
            },
          },
        },
      },
    ],
  };

  const behaviors = new Map<string, ArcDocBehavior>();
  for (const step of arc.steps) behaviors.set(step.doc.title, step.doc.behavior);
  return { marker, threadId, arc, behaviors };
}

// ── dated-reminder arcs (point-in-time surfacing) ──────────────────────────

/**
 * The dated / undated to-do arcs the reconcile e2e uses to exercise the
 * point-in-time surfacing behavior — separate from the frozen scorecard
 * arc set (`generateArcSet`) so the "day of life" mix and its committed
 * `daily-mix.json` baseline stay untouched.
 *
 * The DATED arc: an actionable to-do carrying a scheduled/due date arrives,
 * a correct agent tracks it as a loop and creates a brief that stays hidden
 * until the scheduled day (`nextShow`), with `eventAt` on the day and a
 * re-verify `schedule_agent_run` tied to the loop; a later completion datum
 * resolves the loop, whose cascade retracts the never-fired scheduled run.
 * The UNDATED arc: an equally-actionable to-do with NO scheduled date is
 * read and left untouched — no natural moment to resurface, so no brief.
 *
 * Times are computed relative to a passed `now` so the scheduled day is
 * genuinely in the future (the brief is hidden today). Surface details are
 * INVENTED (privacy rule) — fictional tasks on RFC-2606 reserved domains.
 */
export interface DatedReminderArcs {
  /** Step 0 schedules the reminder; step 1 completes it (cascade retract). */
  dated: Arc;
  /** One step: an undated to-do that must NOT be auto-briefed. */
  undated: Arc;
  /** title → behavior for the scripted model (merge into its behavior map). */
  behaviors: Map<string, ArcDocBehavior>;
  /** ISO 8601 morning of the scheduled day — the dated brief's nextShow. */
  nextShowIso: string;
  /** ISO 8601 scheduled day — the dated brief's eventAt + the re-verify run. */
  eventAtIso: string;
}

/** UTC ISO 8601 at `hour:00` on the day `dayOffset` days after `now`. */
function isoAtHourDaysFromNow(now: number, dayOffset: number, hour: number): string {
  const day = new Date(now + dayOffset * 86_400_000);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0),
  ).toISOString();
}

export function generateDatedReminderArcs(now: number): DatedReminderArcs {
  // Tomorrow: nextShow at 08:00, eventAt at 09:00, re-verify run at 07:00.
  // All strictly after `now` (tomorrow's date is always later than today),
  // so the brief is hidden until its day.
  const nextShowIso = isoAtHourDaysFromNow(now, 1, 8);
  const eventAtIso = isoAtHourDaysFromNow(now, 1, 9);
  const scheduleWhenIso = isoAtHourDaysFromNow(now, 1, 7);
  const scheduledDay = nextShowIso.slice(0, 10); // YYYY-MM-DD for prose + metadata

  const datedMarker = "library-books";
  const datedTaskTitle = `Return the library books (${datedMarker})`;
  const datedDoneTitle = `Library books returned (${datedMarker})`;

  const dated: Arc = {
    id: "dated-todo",
    kind: "request",
    marker: datedMarker,
    gold: { loopsWithMarker: 1, finalLoopState: "done", activeAttachedBriefs: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-dated-${datedMarker}-1`,
          documentType: "task",
          title: datedTaskTitle,
          content: [
            `Reminder to self: return the library books.`,
            `Scheduled: ${scheduledDay}.`,
          ].join("\n"),
          // The scheduled date also rides as a generic typed-ish metadata
          // field, mirroring how a dated source exposes it alongside prose.
          metadata: { extra: { scheduled: scheduledDay } },
          behavior: {
            onCreated: {
              kind: "schedule",
              marker: datedMarker,
              loopTitle: datedTaskTitle,
              briefTitle: `Return the library books (${datedMarker}) — due today`,
              searchQuery: datedMarker,
              nextShow: nextShowIso,
              eventAt: eventAtIso,
              scheduleWhen: scheduleWhenIso,
            },
          },
        },
      },
      {
        expectRun: true,
        doc: {
          externalId: `arc-dated-${datedMarker}-2`,
          documentType: "task",
          title: datedDoneTitle,
          content: `The library books were returned. Done — no further action needed.`,
          behavior: {
            onCreated: {
              kind: "resolve",
              marker: datedMarker,
              ambiguous: false,
              searchQuery: datedMarker,
              ledgerNote: `${datedMarker} completed early; closing and retracting the scheduled check.`,
            },
          },
        },
      },
    ],
  };

  const undatedMarker = "parking-permit";
  const undatedTaskTitle = `Renew the parking permit (${undatedMarker})`;
  const undated: Arc = {
    id: "undated-todo",
    kind: "distractor-boring",
    marker: undatedMarker,
    gold: { loopsWithMarker: 0 },
    steps: [
      {
        expectRun: true,
        doc: {
          externalId: `arc-undated-${undatedMarker}-1`,
          documentType: "task",
          title: undatedTaskTitle,
          content: `Someday I should renew the parking permit. No deadline set.`,
          behavior: { onCreated: { kind: "ignore" } },
        },
      },
    ],
  };

  const behaviors = new Map<string, ArcDocBehavior>();
  for (const arc of [dated, undated]) {
    for (const step of arc.steps) behaviors.set(step.doc.title, step.doc.behavior);
  }

  return { dated, undated, behaviors, nextShowIso, eventAtIso };
}
