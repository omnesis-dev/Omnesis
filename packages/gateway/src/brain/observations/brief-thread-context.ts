// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The context a reply in the Morning brief conversation runs with: the latest
 * brief's ranked items, so "the second one" resolves without a search, and
 * how to act on what the user says about them — right away, in the
 * conversation, with a receipt for every change.
 */

import { getOpenLoop } from "../storage/open-loops.js";
import { shippedBriefItems } from "./brief-detail.js";
import type Database from "better-sqlite3";

export function renderDailyBriefContext(
  db: Database.Database,
  latest: { day: string; messageId: string },
): string {
  const items = shippedBriefItems(db, latest.messageId).map(({ rank, observation }) => {
    const loops = observation.relatedLoopIds
      .map((id) => {
        const loop = getOpenLoop(db, id);
        return loop ? `${id} "${loop.title}" (${loop.state})` : null;
      })
      .filter((line): line is string => line !== null);
    return (
      `${rank}. [${observation.id}] ${observation.summary}` +
      (loops.length ? ` — tasks: ${loops.join("; ")}` : "")
    );
  });
  return [
    "## The Morning brief conversation",
    `This is the user's Morning brief thread. Your most recent message above is the brief you sent on ${latest.day}; earlier days are not in your context.`,
    items.length
      ? `Its items, in the order you wrote them:\n${items.join("\n")}`
      : "That brief carried no ranked items, only the calendar and due tasks.",
    'When the user refers to an item ("the second one", "the lease form"), resolve it from this list. Act on what they tell you right away, with your tools, and state each change in one short line so they can undo it: done → complete the task; not worth doing → strike it; later → move it; wrong → correct the task, or delete it only when it should never have existed; not interested in this kind of thing → suppress the observation AND call interest_record({ direction: "less", about: the kind of thing in their terms, quote: their words, observationId }) so future briefs leave it out; wants more of something → interest_record with direction "more". When what they say is also a lasting fact about them, record it as a preference fact too (with conversation_memory_evidence, then annotate_person on the self person).',
  ].join("\n\n");
}
