// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The worth gate's rubric: the one question the decision model answers about
 * an email before the Brain spends a background-agent run on it.
 *
 * A single 4-level score beat every multi-question variant tried on labelled
 * mail: with the first 2,000 characters of the body it separates mail worth a
 * run from mail that is not at AUC ≈ 0.98, and at the threshold below it skips
 * about two thirds of email while keeping 95% of the worthwhile ones. The
 * state carries only generic document fields — subject, sender, body — never
 * a source's own labels, so the gate stays source-agnostic.
 *
 * Bump {@link WORTH_GATE_RUBRIC_VERSION} whenever the question, the state or the
 * threshold changes: stored answers are reused only under the same version.
 */

import type { DecisionQuestion } from "@omnesis/core";

export const WORTH_GATE_RUBRIC_VERSION = "email-worth-v1";

/** Spend mechanism the gate's decision-model tokens are recorded under. */
export const WORTH_GATE_SPEND_MECHANISM = "worth-gate";

/** Pass when the score is at or above this (levels run 0–3). */
export const EMAIL_WORTH_THRESHOLD = 1.08;

/** Body characters sent to the decision model. */
const EMAIL_BODY_CHARS = 2000;

export const EMAIL_WORTH_QUESTION_ID = "worth_score";

export const EMAIL_WORTH_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  [EMAIL_WORTH_QUESTION_ID]: {
    type: "score",
    instructions:
      "How much would a personal assistant that tracks the recipient's life want to record from this email?",
    criteria: [
      "Nothing: marketing, newsletter, generic announcement, platform or social notification, verification code, survey, cold outreach, mailing-list chatter not involving the recipient.",
      "A minor record: an automated message about the recipient's own order, account, statement or delivery.",
      "Worth recording: a dated event in the recipient's life (trip, booking, appointment, payment, deadline) or a request made to them.",
      "Important: correspondence with a person they know, money owed, travel, health, legal or administrative matters, work decisions.",
    ],
  },
};

/** The document type the gate judges; attachments are judged by their parent of this type. */
export const WORTH_GATED_DOCUMENT_TYPE = "email";

export interface EmailWorthState {
  subject: string;
  from: string;
  body: string;
}

interface PersonRef {
  role?: unknown;
  name?: unknown;
  emails?: unknown;
}

/**
 * Build the state for one email from generic document fields. The sender is
 * the `people` entry with role `sender`, rendered as `Name <address>`.
 */
export function emailWorthState(doc: {
  title: string | null;
  content: string | null;
  metadata: Readonly<Record<string, unknown>>;
}): EmailWorthState {
  const people = Array.isArray(doc.metadata.people) ? (doc.metadata.people as PersonRef[]) : [];
  const sender = people.find((p) => p.role === "sender");
  const name = typeof sender?.name === "string" ? sender.name : "";
  const emails = Array.isArray(sender?.emails)
    ? sender.emails.filter((e): e is string => typeof e === "string")
    : [];
  const from = [name, emails.length > 0 ? `<${emails.join(",")}>` : ""].filter(Boolean).join(" ");
  return {
    subject: doc.title ?? "",
    from,
    body: (doc.content ?? "").slice(0, EMAIL_BODY_CHARS),
  };
}
