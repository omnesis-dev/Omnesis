// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { email, OWNER_EMAIL, at } from "./shared.mjs";

export function addBinaryEvidence({ day, add }, purchaseDay) {
  const symptomAudioText = `Symptom diary recorded ${day(-12)}. I have been waking in the night for about three days and feeling tired in the morning. I want to take this timeline to my GP appointment. I have not received a diagnosis. Yesterday I had coffee late, but I do not know if it made a difference.`;
  add("gmail", "messages.json", {
    externalId: "sb-symptom-voice",
    threadId: "sb-symptom-voice@example.com",
    from: "self",
    fromEmail: email("self"),
    to: ["self"],
    toEmails: [OWNER_EMAIL],
    subject: "Recorded symptom diary",
    body: "My personal voice diary is attached; recorded observations only.",
    sentAt: at(day(-12), "19:00"),
    labels: ["INBOX"],

    attachments: [
      {
        filename: "symptom-diary.wav",
        mimeType: "audio/wav",
        assetPath: "assets/symptom-diary.wav",
      },
    ],
  });
  add(
    "gmail",
    "messages.json",
    {
      externalId: "sb-tenancy-scan",
      threadId: "sb-tenancy-scan@example.com",
      from: "p_landlord",
      fromEmail: email("p_landlord"),
      to: ["self"],
      toEmails: [OWNER_EMAIL],
      subject: "Original scanned tenancy 2016",
      body: "The original signed tenancy scan is attached.",
      sentAt: at("2016-09-01"),
      labels: ["INBOX"],

      attachments: [
        {
          filename: "oldest-tenancy.pdf",
          mimeType: "application/pdf",
          assetPath: "assets/oldest-tenancy.pdf",
        },
      ],
    },
    {
      externalId: "sb-warranty-native-pdf",
      threadId: "sb-warranty-pdf@example.com",
      from: "p_repair",
      fromEmail: email("p_repair"),
      to: ["self"],
      toEmails: [OWNER_EMAIL],
      subject: "Ember Mini warranty document",
      body: "The warranty PDF is attached. Please retain it with purchase proof.",
      sentAt: at(purchaseDay),
      labels: ["INBOX"],

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
