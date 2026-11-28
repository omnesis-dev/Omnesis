// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const messages = {
  FRESH_INSTALL_REFUSED:
    "Finish erasing this Mac's managed library and its saved Keychain entries before creating a new installation.",
  FRESH_INSTALL_RECONNECT_REQUIRED:
    "The new installation may be ready. Reopen the app connection before continuing setup.",
} as const;
export class DesktopFreshInstallFailure extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
