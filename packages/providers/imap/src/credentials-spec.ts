// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

export const imapCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "imap",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "host",
      label: "IMAP hostname",
      placeholder: "imap.example.com",
      pattern:
        "^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$",
      patternHint: "Enter the TLS IMAP hostname from your mail provider",
    },
    {
      name: "username",
      label: "Email address",
      placeholder: "account@example.com",
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      patternHint: "Use the full email address",
    },
    {
      name: "app_password",
      label: "IMAP password",
      placeholder: "App-specific password when available",
      secret: true,
    },
  ],
  wizard: {
    intro: "Connect an email account through its IMAP provider. Omnesis requires TLS on port 993.",
    why: "Omnesis reads recent mail over encrypted IMAP. Credentials stay on this collector and use the Omnesis secret-file system.",
    estMinutes: 3,
    steps: [
      {
        kind: "instruction",
        title: "Find the IMAP connection settings",
        body:
          "Open your mail provider's IMAP setup instructions. Find the TLS IMAP hostname and username. " +
          "If the provider offers app-specific passwords, create one for Omnesis instead of using your account password.",
      },
      {
        kind: "instruction",
        title: "Enter the secure IMAP credentials",
        body: "Use the exact username from your mail provider. Omnesis connects with TLS on port 993 and does not allow plaintext IMAP.",
      },
    ],
  },
};
