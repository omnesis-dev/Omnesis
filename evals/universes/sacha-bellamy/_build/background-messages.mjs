// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { at, chat, mail, jitter } from "./shared.mjs";
import { pick, id, eligiblePeople, contentFor, topics } from "./background-content.mjs";

export function addCorrespondence(state) {
  const { ctx, historical, put } = state;
  const messages = (count, channel) =>
    Array.from({ length: count }, (_, i) => {
      const day = historical(i, count);
      const eligible = eligiblePeople(ctx, day);
      const peer = eligible[(i + Math.floor(i / eligible.length)) % eligible.length].id;
      return chat(
        id(channel, i),
        peer,
        day,
        contentFor(i + (channel === "imessage" ? 12000 : 0), day).messages,
        {
          chatId: `${channel}-${peer}`,
          chatTitle: ctx.person(peer).name,
        },
      );
    });
  put("whatsapp-messages", "messages.json", messages(8000, "whatsapp"));
  put("apple-imessage", "messages.json", messages(2500, "imessage"));

  const letters = Array.from({ length: 2500 }, (_, i) => {
    const day = historical(i, 2500);
    const { topic, body, quantity } = contentFor(23000 + i, day);
    const peer = pick(eligiblePeople(ctx, day), `mail-peer-${i}`).id;
    const style = i % 5;
    const subjects = [
      `Notes on ${topic[0]}`,
      `Materials list for ${topic[0]}`,
      `Re: ${topic[0]} arrangements`,
      `${topic[0]} session update`,
      `Thanks for helping with ${topic[0]}`,
    ];
    const intros = [
      `Here are the practical notes from our exchange.`,
      `We have ${quantity} usable pieces left in the shared box.`,
      `The earlier message missed a small detail. Please use the version below.`,
      `The original plan has changed; there is no need to wait at the entrance.`,
      `I appreciated the patient help with the tricky part.`,
    ];
    return mail(
      id("gmail", i),
      subjects[style],
      `${intros[style]}\n\n${body}\n\nReference: HOB-${day.replaceAll("-", "")}-${i}.\nPlease keep this with the ordinary club correspondence.`,
      day,
      peer,
      {
        labels: i % 7 === 0 ? ["INBOX", "STARRED"] : ["INBOX"],
        threadId: `sb-correspondence-${Math.floor(i / 3)}`,
      },
    );
  });
  put("gmail", "messages.json", letters);

  return letters;
}

export function addCalls(state) {
  const { ctx, historical, put } = state;
  put(
    "apple-call-log",
    "calls.json",
    Array.from({ length: 300 }, (_, i) => {
      const day = historical(i, 300);
      const peer = pick(eligiblePeople(ctx, day), `call-peer-${i}`).id;
      return {
        externalId: id("call-day", i),
        date: day,
        calls: [
          {
            id: id("call", i),
            time: at(day, "18:15"),
            direction: i % 2 ? "incoming" : "outgoing",
            medium: i % 4 ? "phone" : "facetime",
            durationSeconds: i % 7 === 0 ? 0 : 80 + jitter(`duration-${i}`, 1300),
            connected: i % 7 !== 0,
            counterparty: peer,
          },
        ],
      };
    }),
  );
  put(
    "apple-voicemail",
    "voicemails.json",
    Array.from({ length: 80 }, (_, i) => {
      const day = historical(i, 80);
      const topic = topics[i % topics.length];
      const caller = pick(eligiblePeople(ctx, day), `voicemail-${i}`).id;
      return {
        externalId: id("voicemail-day", i),
        date: day,
        voicemails: [
          {
            id: id("voicemail", i),
            time: at(day, "16:40"),
            durationSeconds: 18 + (i % 25),
            caller,
            transcript: `Hi Sacha, just calling about ${topic[0]}. ${topic[3]}. I think we should ${topic[4]}. No hurry, send me a message when you have a moment.`,
          },
        ],
      };
    }),
  );
}
