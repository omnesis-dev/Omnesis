// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Plaud sign-in.
 *
 * Plaud signs an account in with a one-time code emailed to its address, the
 * same way its own app does, so the only thing the operator types up front is
 * the address; the code is asked for once Plaud has sent it. What is stored
 * under the account afterwards is the token set Plaud issued, never the code.
 * Accounts created with Google or Apple sign-in have no emailed code and
 * cannot be connected.
 */
export const plaudCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "plaud",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "email",
      label: "Plaud account email",
      placeholder: "maya@example.com",
      pattern: "^[^\\s@]+@[^\\s@]+$",
      patternHint: "The email address you sign in to Plaud with",
    },
  ],
  wizard: {
    intro:
      "Omnesis signs in to your Plaud account with a one-time code Plaud emails to you, " +
      "then reads your recordings, their transcripts and summaries.",
    why:
      "Plaud has no public API: Omnesis uses the one Plaud's own web app uses, which Plaud can " +
      "change at any time. The sign-in stays on this machine. Recordings are downloaded only " +
      "to be transcribed and are not kept.",
    estMinutes: 2,
    steps: [
      {
        kind: "instruction",
        title: "Use your Plaud email address",
        body:
          "Enter the address of your Plaud account. Plaud emails a code to it; enter that code " +
          "on the next screen. Accounts created with Google or Apple sign-in cannot be connected.",
      },
    ],
  },
};
