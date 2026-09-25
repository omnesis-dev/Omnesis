// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The saboteur behavior table — the scorecard's instrument-validation
 * counterpart to the correct arc behaviors (epic #137 S13, criterion 16).
 *
 * The scorecard is only trustworthy if it flags known-bad agent behavior,
 * so this module derives a second behavior table from the same arc set
 * (same documents, same wake pattern, same scripted server) that plants
 * one detectable defect per reconcile-quality metric:
 *
 *  - **duplicate mints** — the invoice resolution, the second concurrent
 *    commitment, the chat re-statement of the marquee commitment, and the
 *    long-horizon contract resolution each `forceCreate` a fresh loop
 *    instead of adopting/closing the tracked one (`duplicate_rate` must
 *    rise);
 *  - **skipped resolutions** — the invoice and long-horizon loops the
 *    duplicate-mints leave open, plus BOTH out-of-order arcs' late
 *    requests treated as fresh open obligations (`resolution_recall`
 *    must fall);
 *  - **silent close of an ambiguous resolution** — the partial lease
 *    fulfilment is treated as unambiguous: the loop is closed and its
 *    briefs deleted instead of attaching a confirmation brief
 *    (`silent_close_violations` must count it);
 *  - **unjustified loop** — the boring no-action email is escalated into
 *    a loop + brief (`loop_precision` must fall);
 *  - **ignored update** — a venue option for the decision thread is read
 *    and dropped, leaving no trace on the loop (`update_recall` must
 *    fall);
 *  - **wrong merges** — the same-vendor same-amount quote is grafted onto
 *    the invoice loop, and the same-person hall-key errand onto the
 *    tile-cutter loop, instead of each getting its own (`loop_recall`
 *    must fall).
 *
 * Behaviors are data (`ArcDocBehavior`), so the saboteur is just a
 * second table keyed by the same document titles — never a second
 * server. `SABOTEUR_DEFECTS` is the machine-readable manifest of what
 * was planted; the instrument-validation e2e derives its expected
 * metric values from it instead of hardcoding magic numbers.
 */

import { arcById, type ArcDocBehavior, type ArcSet } from "./briefs-arcs.js";

/** What the saboteur plants, by metric. Counts are per full arc-set run. */
export const SABOTEUR_DEFECTS = {
  /**
   * Reconcile opportunities answered by minting a fresh loop instead —
   * including the long-horizon resolution, where the saboteur mints a
   * chaser instead of finding the day-old buried loop, and the wording-
   * poor nudge, minted as a fresh loop instead of reconciling onto the
   * tracked commitment it chases.
   */
  duplicateMints: 5,
  /**
   * Arcs whose tracked obligation is never resolved: the invoice loop the
   * duplicate-mint leaves open, the long-horizon contract loop its chaser
   * leaves open, BOTH out-of-order arcs treated as fresh demands (open
   * loops for already-settled obligations), and the already-handled
   * dismissal whose loop the feedback saboteur DELETES instead of closing
   * as done (no done record remains to observe).
   */
  skippedResolutions: 5,
  /** Ambiguous resolutions closed silently instead of confirm-briefed. */
  silentClosures: 1,
  /**
   * Loops left standing for datums/arcs whose gold expects none: the
   * boring no-action email escalated into a loop + brief; the mistaken
   * (retracted) purchase-order loop closed as `done` — the wrong verb
   * fabricates a fulfilment record for an obligation that never belonged
   * to the user; the not-relevant dismissal the feedback saboteur ignores,
   * leaving the unwanted loop open; the wrong dismissal it closes as done
   * (fabricating a fulfilment for a misread); and the acknowledged info
   * brief it answers by minting a follow-up loop nobody asked for.
   */
  unjustifiedLoops: 5,
  /** Relevant later datums whose run leaves no trace on the tracked loop. */
  ignoredUpdates: 1,
  /**
   * Near-dup baits grafted onto the WRONG existing loop (the quote
   * reconciled onto the same-vendor same-amount invoice loop; the
   * same-person hall-key errand folded into the tile-cutter loop), so the
   * bait's own loop is never tracked.
   */
  wrongMerges: 2,
  /**
   * Tracked loops the feedback saboteur ERASES with the wrong verb: the
   * already-handled dismissal deletes its loop instead of marking it done,
   * and the snoozed dismissal deletes its loop ("later" read as "never"),
   * so arcs that expect a tracked loop end with none. Planted by the
   * scripted server's `feedbackPolicy: "saboteur"`, not by this table
   * (feedback runs carry no document title to key on).
   */
  vanishedLoops: 2,
} as const;

/**
 * Derive the saboteur table for an arc set: the correct behaviors with
 * the planted defects swapped in. The arc set itself is not mutated.
 */
export function saboteurBehaviors(set: ArcSet): Map<string, ArcDocBehavior> {
  const behaviors = new Map(set.behaviors);
  const swap = (arcId: string, stepIndex: number, behavior: ArcDocBehavior): void => {
    const step = arcById(set, arcId).steps[stepIndex];
    if (!step) throw new Error(`arc "${arcId}" has no step ${stepIndex}`);
    behaviors.set(step.doc.title, behavior);
  };

  // Defect 1+2: the invoice payment confirmation mints a follow-up loop
  // instead of closing the tracked one (duplicate + skipped resolution).
  const invoice = arcById(set, "invoice");
  const invoiceMarker = invoice.marker!;
  swap("invoice", 1, {
    onCreated: {
      kind: "commit",
      marker: invoiceMarker,
      forceCreate: true,
      loopTitle: `Chase the ${invoiceMarker} payment`,
      briefTitle: `Follow up on ${invoiceMarker}`,
      searchQuery: `invoice ${invoiceMarker}`,
    },
  });

  // Defect 3: the ambiguous lease fulfilment is closed silently — no
  // confirmation brief, attached briefs deleted.
  const lease = arcById(set, "request");
  swap("request", 1, {
    onCreated: {
      kind: "resolve",
      marker: lease.marker!,
      ambiguous: false,
      searchQuery: lease.marker!,
      ledgerNote: "Documents received; closing.",
    },
  });

  // Defect 1 (second mint): both concurrent copies must create, regardless
  // of which runs first. Otherwise the normal copy can adopt the forced
  // copy's loop and the intended duplicate disappears with that ordering.
  const concurrent = arcById(set, "concurrent");
  const depositMarker = concurrent.marker!;
  const originalCommit = concurrent.steps[0]!.doc.behavior.onCreated;
  if (originalCommit.kind !== "commit") throw new Error("concurrent arc must begin with a commit");
  swap("concurrent", 0, { onCreated: { ...originalCommit, forceCreate: true } });
  swap("concurrent", 1, {
    onCreated: {
      kind: "commit",
      marker: depositMarker,
      forceCreate: true,
      loopTitle: `Wire the deposit (${depositMarker})`,
      briefTitle: `Deposit reminder (${depositMarker})`,
      searchQuery: depositMarker,
    },
  });

  // Defect 4: the no-action email becomes a loop + brief.
  const boring = arcById(set, "distractor-boring");
  const boringTitle = boring.steps[0]!.doc.title;
  swap("distractor-boring", 0, {
    onCreated: {
      kind: "commit",
      marker: boringTitle,
      loopTitle: `Reply to: ${boringTitle}`,
      briefTitle: `Reply needed: ${boringTitle}`,
      searchQuery: boringTitle,
    },
  });

  // Defect 1 (third mint): the chat re-statement of the marquee commitment
  // mints its own loop instead of adopting the email-tracked one.
  const restatement = arcById(set, "restatement");
  const rentalMarker = restatement.marker!;
  swap("restatement", 1, {
    onCreated: {
      kind: "commit",
      marker: rentalMarker,
      forceCreate: true,
      loopTitle: `Pick up the marquee (${rentalMarker})`,
      briefTitle: `Marquee (${rentalMarker}) reminder`,
      searchQuery: rentalMarker,
    },
  });

  // Defect 5 (skipped resolution #2): the late-syncing payment request is
  // treated as a fresh obligation — an OPEN loop + brief for an already-
  // settled registration, instead of recognizing the earlier confirmation.
  const outOfOrder = arcById(set, "out-of-order");
  const regMarker = outOfOrder.marker!;
  swap("out-of-order", 1, {
    onCreated: {
      kind: "commit",
      marker: regMarker,
      loopTitle: `Pay registration ${regMarker}`,
      briefTitle: `Registration ${regMarker} needs payment`,
      searchQuery: `registration ${regMarker}`,
    },
  });

  // Defect 5 (skipped resolution #3): the second out-of-order variant —
  // the stern waiver reminder becomes a fresh OPEN obligation instead of
  // being recognized as settled by the earlier chat acknowledgment.
  const outOfOrder2 = arcById(set, "out-of-order-2");
  const waiverMarker = outOfOrder2.marker!;
  swap("out-of-order-2", 1, {
    onCreated: {
      kind: "commit",
      marker: waiverMarker,
      loopTitle: `Send waiver ${waiverMarker}`,
      briefTitle: `Waiver ${waiverMarker} outstanding`,
      searchQuery: `waiver ${waiverMarker}`,
    },
  });

  // Defect 1 (fourth mint) + 5 (skipped resolution #4): the long-horizon
  // resolution mints a chaser instead of closing the day-old buried loop.
  const longHorizon = arcById(set, "long-horizon");
  const contractMarker = longHorizon.marker!;
  swap("long-horizon", 1, {
    onCreated: {
      kind: "commit",
      marker: contractMarker,
      forceCreate: true,
      loopTitle: `Chase the ${contractMarker} signature`,
      briefTitle: `Contract ${contractMarker} follow-up`,
      searchQuery: `contract ${contractMarker}`,
    },
  });

  // Defect 6 (ignored update): the second venue option never reaches the
  // decision loop — the run reads the datum and records nothing.
  swap("decision-thread", 2, { onCreated: { kind: "ignore" } });

  // Defect 7 (wrong merge): the quote — same vendor, same amount, a
  // DIFFERENT obligation — is grafted onto the invoice loop as a mere
  // update, so the quote's own loop is never tracked.
  const invoiceCMarker = arcById(set, "obligation-invoice").marker!;
  const quoteStep = arcById(set, "obligation-quote").steps[0]!;
  behaviors.set(quoteStep.doc.title, {
    onCreated: {
      kind: "note",
      marker: invoiceCMarker,
      searchQuery: `invoice ${invoiceCMarker}`,
      ledgerNote: `Same vendor and amount as ${invoiceCMarker}; assuming it's the same obligation.`,
    },
  });

  // Defect 7 (second wrong merge, people axis): the hall-key errand —
  // same person, same Sunday — is folded into the tile-cutter loop as a
  // mere update, so the key's own loop is never tracked.
  const cutterMarker = arcById(set, "errand-cutter").marker!;
  swap("errand-key", 0, {
    onCreated: {
      kind: "note",
      marker: cutterMarker,
      searchQuery: `tile cutter ${cutterMarker}`,
      ledgerNote: `Same person and same Sunday visit as ${cutterMarker}; assuming one errand.`,
    },
  });

  // Defect 4 (second unjustified loop): the retraction of the mistaken
  // purchase-order request is answered with the WRONG close verb — the
  // loop is marked `done` (fabricating a fulfilment that never happened)
  // instead of deleted, so a loop the gold expects gone stays behind.
  const mistaken = arcById(set, "mistaken-commit");
  const poMarker = mistaken.marker!;
  swap("mistaken-commit", 1, {
    onCreated: {
      kind: "resolve",
      marker: poMarker,
      ambiguous: false,
      searchQuery: `purchase order ${poMarker}`,
      ledgerNote: `${poMarker} handled; closing as done.`,
    },
  });

  // Defect 1 (fifth mint): the wording-poor nudge is treated as a brand-new
  // ask — a fresh loop is minted instead of reconciling the chase onto the
  // tracked headcount commitment it refers to.
  const nudge = arcById(set, "nudge");
  const headcountMarker = nudge.marker!;
  swap("nudge", 1, {
    onCreated: {
      kind: "commit",
      marker: headcountMarker,
      forceCreate: true,
      loopTitle: `Send the number (${headcountMarker}) they are waiting on`,
      briefTitle: `Someone is chasing a number (${headcountMarker})`,
      searchQuery: `headcount ${headcountMarker}`,
    },
  });

  return behaviors;
}
