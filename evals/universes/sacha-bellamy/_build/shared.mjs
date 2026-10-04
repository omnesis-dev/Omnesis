// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

export const REFERENCE_DAY = "2026-10-03";
export const SELF = "p_sacha";
export const PARTNER = "p_maya";
export const OWNER_EMAIL = "sacha.bellamy@example.com";
export const WORK_EMAIL = "sacha.bellamy@harbour-lantern.example.com";

const identities = [
  ["sacha", "Sacha Bellamy"],
  ["maya", "Maya Bellamy"],
  ["jamie", "Jamie Lopez"],
  ["priya", "Priya Calder"],
  ["elliot", "Elliot Rowan"],
  ["nora", "Nora Finch"],
  ["daniel", "Daniel Mercer"],
  ["celine", "Celine Bellamy"],
  ["marc", "Marc Bellamy"],
  ["ines", "Ines Bellamy"],
  ["hugo", "Hugo Arden"],
  ["leila", "Leila Hartwell"],
  ["owen", "Owen Bramble"],
  ["alice", "Alice Fenwick"],
  ["leo", "Leo Merritt"],
  ["zoe", "Zoe Winslow"],
  ["tariq", "Tariq Fairburn"],
  ["ada", "Ada Westbrook"],
  ["ben", "Ben Ashcombe"],
  ["ruth", "Ruth Elwood"],
  ["mover", "Robin Cartwright"],
  ["landlord", "Paula Wren"],
  ["ceramics", "Amber Holloway"],
  ["repair", "Simon Alder"],
  ["travel", "Harriet Dune"],
  ["merchant", "Felix Moss"],
  ["gp", "Imogen Cedar"],
  ["running", "Miles Brook"],
  ["sophia", "Sophia Lark"],
  ["louis", "Louis Fairchild"],
  ["noemi", "Noemi Vale"],
  ["caleb", "Caleb Finchley"],
  ["ava", "Ava Whitlock"],
  ["emile", "Emile Newbury"],
  ["rosie", "Rosie Kestrel"],
  ["finn", "Finn Meadow"],
  ["clara", "Clara Hawthorn"],
  ["max", "Max Dewberry"],
  ["dina", "Dina Hazell"],
  ["sam", "Sam Redfern"],
  ["gift_orders", "Amazon Orders"],
];

export const cast = {
  self: SELF,
  people: identities.map(([key, name], index) => ({
    id: `p_${key}`,
    name,
    emails: [name.toLowerCase().replaceAll(" ", ".") + "@example.com"],
    phones: [`+${447700900100 + index}`],
    lids: [`${800100000 + index}@lid`],
    extra: {
      notionUserId: `user_${key}`,
      appleContactGuid: `SB-CONTACT-${key}`,
      githubLogin: `fictional-${key}`,
      ...(key === "sacha"
        ? {
            stravaAthleteId: "8800100",
            enableBankingAccountId: "bellamy-eur",
            lunchflowAccountId: "default",
            coinbaseAccountId: "bellamy-crypto",
            plaidItemId: "plaid-bellamy-us",
          }
        : {}),
    },
  })),
  orgs: [
    { id: "org_work", name: "Harbour Lantern Software", domain: "harbour-lantern.example.com" },
    { id: "org_movers", name: "Kindred Cart Movers", domain: "kindred-cart.example.com" },
    { id: "org_ceramics", name: "Willow Kiln Studio", domain: "willow-kiln.example.com" },
    { id: "org_repair", name: "Alder Appliance Workshop", domain: "alder-workshop.example.com" },
  ],
};
cast.people[0].emails.push(WORK_EMAIL, "sacha.bellamy@icloud.example.com");
cast.people[1].emails.push("maya.reeves@example.org", "maya.bellamy@example.org");

export const people = new Map(cast.people.map((person) => [person.id, person]));
export const person = (ref) => people.get(ref === "self" ? SELF : ref);
export const email = (ref) => person(ref).emails[0];
export const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
export const jitter = (key, max = 100) => parseInt(hash(key).slice(0, 8), 16) % max;
export const at = (day, time = "12:00") => `${day}T${time}:00.000Z`;
/** Resolve unambiguous daytime London wall time without inheriting the host timezone. */
export function londonAt(day, time = "12:00") {
  const provisional = new Date(at(day, time));
  const offset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  })
    .formatToParts(provisional)
    .find((part) => part.type === "timeZoneName").value;
  const hours = offset === "GMT" ? 0 : Number(offset.replace("GMT", ""));
  return new Date(provisional.getTime() - hours * 3600000).toISOString();
}
export function anniversary(day, years) {
  const result = new Date(at(day));
  const month = result.getUTCMonth();
  result.setUTCFullYear(result.getUTCFullYear() + years);
  if (result.getUTCMonth() !== month) result.setUTCDate(0);
  return result.toISOString().slice(0, 10);
}
export function addDays(day, count) {
  const date = new Date(at(day));
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Local London date determines the week; generated timestamps remain explicit UTC. */
export function recordingWeek(asOf = REFERENCE_DAY) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    Number.isNaN(Date.parse(at(asOf))) ||
    new Date(at(asOf)).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("asOf must be a real ISO calendar date");
  const weekday = new Date(at(asOf)).getUTCDay();
  return addDays(asOf, -((weekday + 6) % 7));
}
export function londonToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function context(asOf = REFERENCE_DAY) {
  const monday = recordingWeek(asOf);
  return {
    asOf,
    monday,
    day: (offset) => addDays(monday, offset),
    at,
    cast,
    people,
    person,
    email,
    hash,
    jitter,
  };
}

export function mail(id, subject, body, day, from = "p_merchant", extra = {}) {
  return {
    externalId: id,
    subject,
    from,
    fromEmail: email(from),
    to: ["self"],
    toEmails: [OWNER_EMAIL],
    body,
    sentAt: at(day, "10:00"),
    threadId: `thread-${id}`,
    labels: ["INBOX"],
    ...extra,
  };
}
export function chat(id, counterparty, day, messages, extra = {}) {
  return {
    externalId: id,
    chatId: `chat-${counterparty}`,
    chatTitle: person(counterparty).name,
    date: day,
    counterparty,
    messages: messages.map((message, index) => ({
      from: index % 2 ? "self" : counterparty,
      at: at(
        day,
        `${String(18 + Math.floor(index / 50)).padStart(2, "0")}:${String(index % 50).padStart(2, "0")}`,
      ),
      text: message,
    })),
    ...extra,
  };
}
export function calendar(id, title, day, time, minutes, description = "", extra = {}) {
  const startTime = londonAt(day, time);
  return {
    externalId: id,
    title,
    description,
    location: "",
    startTime,
    endTime: new Date(Date.parse(startTime) + minutes * 60000).toISOString(),
    attendees: ["self"],
    attendeeEmails: [OWNER_EMAIL],
    createdAt: at(addDays(day, -10)),
    updatedAt: at(addDays(day, -2)),
    ...extra,
  };
}
export function drive(id, name, content, day, extra = {}) {
  return {
    externalId: id,
    name,
    mimeType: name.endsWith(".pdf") ? "application/pdf" : "text/plain",
    content,
    owner: "self",
    createdAt: at(day),
    modifiedAt: at(day),
    ...extra,
  };
}
