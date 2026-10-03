// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, jitter } from "./shared.mjs";
import { topics, states } from "./background-topics.mjs";
export { topics } from "./background-topics.mjs";

export const pick = (values, key) => values[jitter(key, values.length)];
export const id = (prefix, index) => `sb-bg-${prefix}-${String(index).padStart(5, "0")}`;
export function dayAt(index, total, first, last) {
  const span = Math.max(0, Math.floor((Date.parse(at(last)) - Date.parse(at(first))) / 86400000));
  return addDays(first, Math.floor((index * span) / Math.max(total - 1, 1)));
}
export function eligiblePeople(ctx, day) {
  const allowed = ctx.cast.people.filter(
    (p) =>
      ![
        "p_sacha",
        "p_mover",
        "p_landlord",
        "p_ceramics",
        "p_repair",
        "p_gp",
        "p_merchant",
        "p_travel",
        "p_running",
      ].includes(p.id),
  );
  return allowed.filter((p) => p.id !== "p_maya" || day >= "2018-05-01");
}
export function contentFor(index, day) {
  const topic = pick(topics, `subject-${index}`);
  const state = pick(states, `state-${index}`);
  const quantity = 2 + jitter(`quantity-${index}`, 6);
  const weather = pick(
    [
      "a little damp",
      "bright but breezy",
      "colder than expected",
      "pleasantly mild",
      "overcast",
      "very sunny",
    ],
    `weather-${index}`,
  );
  const variant = pick(
    [
      "green notebook",
      "folded sheet",
      "small index card",
      "phone note",
      "lined journal",
      "back of the envelope",
    ],
    `variant-${index}`,
  );
  const messages = [
    `About ${topic[0]}: shall we ${topic[1]}?`,
    `Yes. I made a note in the ${variant} after the last attempt.`,
    state[0],
    state[1],
    `At ${topic[2]}, ${topic[3]}.`,
    `We could ${topic[4]}. I wrote that beside the ${variant} notes from ${addDays(day, -(2 + quantity))}.`,
    state[2],
    state[3],
    `It was ${weather} on ${day}. ${topic[5][0].toUpperCase() + topic[5].slice(1)} made the effort worthwhile.`,
    `Keeping the details under ${topic[0]}, ${day}. No need to rush the next attempt.`,
  ];
  // Cancellation threads do not claim the cancelled activity took place.
  if (jitter(`state-${index}`, states.length) === 2)
    messages[8] = `It is ${weather}. I stayed in and sorted the materials instead.`;
  return { topic, messages, body: messages.join("\n"), quantity };
}
