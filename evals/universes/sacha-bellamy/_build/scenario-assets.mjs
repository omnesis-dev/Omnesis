// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { at } from "./shared.mjs";

export function addBinaryEvidence({ day, add }, purchaseDay) {
  const symptomAudioText = `Symptom diary recorded ${day(-12)}. I have been waking in the night for about three days and feeling tired in the morning. I want to take this timeline to my GP appointment. I have not received a diagnosis. Yesterday I had coffee late, but I do not know if it made a difference.`;
  add("maildir", "messages.json", {
    id: "sb-symptom-voice",
    messageId: "sb-symptom-voice@example.com",
    from: "self",
    to: ["self"],
    subject: "Recorded symptom diary",
    body: "My personal voice diary is attached; recorded observations only.",
    sentAt: at(day(-12), "19:00"),
    folders: ["INBOX"],
    flags: "S",
    attachments: [
      {
        filename: "symptom-diary.wav",
        mimeType: "audio/wav",
        assetPath: "assets/symptom-diary.wav",
      },
    ],
  });
  add(
    "maildir",
    "messages.json",
    {
      id: "sb-tenancy-scan",
      messageId: "sb-tenancy-scan@example.com",
      from: "p_landlord",
      to: ["self"],
      subject: "Original scanned tenancy 2016",
      body: "The original signed tenancy scan is attached.",
      sentAt: at("2016-09-01"),
      folders: ["INBOX"],
      flags: "S",
      attachments: [
        {
          filename: "oldest-tenancy.pdf",
          mimeType: "application/pdf",
          assetPath: "assets/oldest-tenancy.pdf",
        },
      ],
    },
    {
      id: "sb-warranty-native-pdf",
      messageId: "sb-warranty-pdf@example.com",
      from: "p_repair",
      to: ["self"],
      subject: "Ember Mini warranty document",
      body: "The warranty PDF is attached. Please retain it with purchase proof.",
      sentAt: at(purchaseDay),
      folders: ["INBOX"],
      flags: "S",
      attachments: [
        {
          filename: "ember-mini-warranty.pdf",
          mimeType: "application/pdf",
          assetPath: "assets/ember-mini-warranty.pdf",
        },
      ],
    },
  );
  return symptomAudioText;
}
