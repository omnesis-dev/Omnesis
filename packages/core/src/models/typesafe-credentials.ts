// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * TypeSafe API-key credentials spec — the key the gateway sends to TypeSafe's
 * System One API when the `decision` capability is assigned to a TypeSafe
 * model (Jev). Stored like every model-provider credential: a 0600 JSON file
 * on the gateway host, surfaced through `/admin/model-credentials/typesafe`.
 */
import type { ProviderCredentialsSpec } from "../credentials.js";

export const TYPESAFE_CREDENTIALS_SPEC: ProviderCredentialsSpec = {
  fileKey: "typesafe",
  required: true,
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      placeholder: "apikey_…",
      secret: true,
      pattern: "^[A-Za-z0-9_-]{16,}$",
      patternHint: "Paste the key exactly as the TypeSafe console shows it.",
    },
  ],
  wizard: {
    intro:
      "Configure a TypeSafe API key so the gateway can assign Jev to the Decision model capability.",
    why: "Jev answers typed questions about a document for a fraction of a cent. With the mention worth gate on, it judges whether each email with a date mention is worth recording, so time queries leave out the dates in marketing and newsletters. Each scored email's subject, sender and opening text are sent to TypeSafe.",
    estMinutes: 2,
    steps: [
      {
        kind: "open-url",
        title: "Create an API key",
        body: "Sign in to the TypeSafe console and create a key under API Keys. Copy it — you'll only see it once.",
        url: "https://console.typesafe.ai/keys",
      },
    ],
  },
};
