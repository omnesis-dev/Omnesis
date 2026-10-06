// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { email, OWNER_EMAIL, mail, drive, at, anniversary } from "./shared.mjs";

export function addPurchases({ day, add, fact }) {
  const purchaseDay = day(-91),
    expiry = anniversary(purchaseDay, 2);
  const receipt = `WILLOW APPLIANCE COOPERATIVE\nReceipt WA-8842\nCustomer Sacha Bellamy\nDate ${purchaseDay}\nItem: Ember Mini espresso machine\nSerial: EM-SB-8842\nPaid GBP 249.00 by Lantern Current debit card\nKeep this receipt for warranty claims.`;
  const warranty = `Ember Mini limited warranty. Covers manufacturing faults for two years from original purchase, supported by purchase proof and matching serial number. Accidental damage and consumables excluded. Contact Alder Appliance Workshop. Serial EM-SB-8842. Purchase ${purchaseDay}. Receipt WA-8842. No claim has been submitted.`;
  add("gmail", "messages.json", {
    externalId: "sb-real-scanned-receipt",
    threadId: "sb-receipt-wa8842@example.com",
    from: "p_merchant",
    fromEmail: email("p_merchant"),
    to: ["self"],
    toEmails: [OWNER_EMAIL],
    subject: "Your scanned paper receipt WA-8842",
    body: "The image-only PDF is attached. Keep the original for a claim; this email contains no item or payment details.",
    sentAt: at(purchaseDay),
    labels: ["INBOX"],

    attachments: [
      {
        filename: "receipt-wa8842.pdf",
        mimeType: "application/pdf",
        assetPath: "assets/receipt-wa8842.pdf",
      },
    ],
  });
  add(
    "google-drive",
    "files.json",
    drive("sb-machine-warranty", "ember-mini-warranty.txt", warranty, purchaseDay),
  );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-machine-order",
      "Order WA-8842 delivered",
      `Ember Mini espresso machine, serial EM-SB-8842. £249 paid. Your scanned receipt was separately mailed. Reference https://receipts.example.com/WA-8842`,
      purchaseDay,
    ),
  );
  add("apple-notes", "notes.json", {
    externalId: "sb-machine-serial",
    title: "Espresso machine fault and serial",
    body: `Ember Mini stopped heating on ${day(-2)}. No accidental damage reported. Serial EM-SB-8842. Receipt WA-8842; https://receipts.example.com/WA-8842`,
    folder: "Household",
    createdAt: at(day(-2)),
    modifiedAt: at(day(-2)),
  });
  fact(
    "F06",
    "Is my Ember Mini espresso machine still within its recorded warranty period? Assemble the purchase proof, serial and payment evidence.",
    { purchaseDay, expiry, serial: "EM-SB-8842", receipt: "WA-8842", priceGBP: 249 },
    [
      "sb-real-scanned-receipt",
      "sb-machine-warranty",
      "sb-machine-order",
      "sb-machine-serial",
      "sb-txn-machine",
    ],
    [
      "OCR output must come from image-only PDF; covered fault still subject to provider assessment.",
    ],
  );

  add(
    "gmail",
    "messages.json",
    mail(
      "sb-refund-promise",
      "Climbing course refund RC-8400 confirmed",
      `Refund of £84 for cancelled course RC-8400 approved ${day(-28)}. It will be returned to your Lantern Current card ending 0042 within ten working days. Merchant statement label: ROCKLIGHT LEARNING.`,
      day(-28),
    ),
  );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-refund-control",
      "Book order refund received",
      `Your £18 refund for cancelled order BOOK-1818 reached Lantern Current on ${day(-15)}. This is unrelated to the climbing course.`,
      day(-15),
    ),
  );
  fact(
    "F08",
    "Did the £84 climbing-course refund RC-8400 ever reach my account? Check posted transactions, merchant aliases and the promised window.",
    {
      amountGBP: 84,
      refundPosted: false,
      merchant: "ROCKLIGHT LEARNING",
      coveredAccount: "Lantern Current",
      approvedDay: day(-28),
    },
    ["sb-refund-promise", "sb-refund-control", "sb-txn-climbing", "sb-txn-refund-control"],
    [
      "Only covered accounts and declared through-date; no claim about uncovered accounts or future settlement.",
    ],
  );
  return { purchaseDay, receipt, warranty };
}
