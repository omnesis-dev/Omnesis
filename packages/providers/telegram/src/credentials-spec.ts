// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MissingCredentialsError, readProviderCredentials } from "@omnesis/core";
import type { ProviderCredentialsSpec } from "@omnesis/core";
import type { AppCredentials } from "./client/types.js";

/** Where the app credential lives: `<configDir>/telegram-credentials.json`. */
export const TELEGRAM_FILE_KEY = "telegram";
const TELEGRAM_PROVIDER_NAME = "Telegram";

const API_ID_PATTERN = "^\\d+$";
const API_HASH_PATTERN = "^[0-9a-f]{32}$";

/** Telegram's own terms pages, linked rather than restated so they never drift. */
export const TELEGRAM_TERMS_URL = "https://telegram.org/tos";
export const TELEGRAM_API_TERMS_URL = "https://core.telegram.org/api/terms";

/**
 * The operator's own Telegram API app.
 *
 * Telegram's API terms require every client to use its own `api_id`, so nothing
 * is bundled: the operator registers an app at my.telegram.org once and pastes
 * its `api_id` and `api_hash` here. It is the **app** credential, shared by
 * every Telegram account connected to this host, and distinct from each
 * account's session (stored per account). So it is not `perAccount`: one
 * account's failed sign-in must never remove what every other account uses.
 */
export const telegramCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: TELEGRAM_FILE_KEY,
  required: true,
  fields: [
    {
      name: "api_id",
      label: "API ID",
      placeholder: "The number shown as App api_id",
      pattern: API_ID_PATTERN,
      patternHint: "Digits only, as shown on my.telegram.org.",
    },
    {
      name: "api_hash",
      label: "API hash",
      placeholder: "The 32-character App api_hash",
      secret: true,
      pattern: API_HASH_PATTERN,
      patternHint: "32 lowercase hexadecimal characters, as shown on my.telegram.org.",
    },
  ],
  wizard: {
    intro:
      "Omnesis talks to Telegram through the Telegram API, using a developer app you register " +
      "yourself. Telegram gives every phone number one app, and its api_id and api_hash are " +
      "what Omnesis signs in with.",
    why:
      "Omnesis reads your chats to archive and index them on this host. The app credential " +
      "stays on this machine and is never shared; only requests this host makes reach Telegram.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Read Telegram's terms",
        body:
          "Using this source is subject to the Telegram Terms of Service and the Telegram API " +
          `Terms of Service (${TELEGRAM_API_TERMS_URL}). It is your responsibility to read ` +
          "them and to follow them while you use this source.",
        url: TELEGRAM_TERMS_URL,
      },
      {
        kind: "open-url",
        title: "Sign in at my.telegram.org",
        body:
          "Open the developer site and sign in with your phone number. The login code arrives " +
          "inside the Telegram app, not by SMS.",
        url: "https://my.telegram.org/apps",
      },
      {
        kind: "instruction",
        title: "Create an app",
        body:
          "Fill in the form: a title without the word Telegram (for example `Omnesis archive`), " +
          "a short name of 5 to 32 letters or digits, and **Desktop** as the platform.",
      },
      {
        kind: "instruction",
        title: "If the site only shows ERROR",
        body:
          "Turn off any VPN, proxy or ad blocker; try another browser or network; keep the " +
          "title plain ASCII and free of the word Telegram. A newly registered number is often " +
          "refused for a while, so waiting and retrying later can be the only fix.",
      },
      {
        kind: "instruction",
        title: "One app per phone number",
        body:
          "Telegram allows a single app per number. If you created one before, open it and " +
          "reuse its api_id and api_hash; there is no way to make a second.",
      },
      {
        kind: "instruction",
        title: "Paste the values",
        body: "On the next screen, paste the **App api_id** (digits) and the **App api_hash**.",
      },
    ],
  },
};

/**
 * Read the stored app credential. Throws {@link MissingCredentialsError} — which
 * sends the operator to the wizard — when it is absent or malformed.
 */
export async function loadAppCredentials(configDir: string): Promise<AppCredentials> {
  const fields = await readProviderCredentials(TELEGRAM_FILE_KEY, configDir);
  const apiId = fields?.api_id?.trim();
  const apiHash = fields?.api_hash?.trim();
  if (
    !apiId ||
    !apiHash ||
    !new RegExp(API_ID_PATTERN, "u").test(apiId) ||
    !new RegExp(API_HASH_PATTERN, "u").test(apiHash)
  ) {
    throw new MissingCredentialsError(TELEGRAM_FILE_KEY, TELEGRAM_PROVIDER_NAME);
  }
  return { apiId: Number(apiId), apiHash };
}
