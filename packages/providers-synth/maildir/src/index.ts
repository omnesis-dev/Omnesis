// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import realMaildir from "@omnesis/provider-maildir";
import { defineSource } from "@omnesis/source-sdk";
import { fakeLocalFlow, preDiscoveredAccounts } from "@omnesis/providers-synth-common";
import { loadMessages, materializeMaildir } from "./fixtures.js";

const { type: _type, ...rest } = realMaildir;

/**
 * The synthetic Maildir.
 *
 * Unlike most doubles, this one keeps the real sync: it writes the universe's
 * messages into a Maildir tree on disk and runs the real source over it, so a
 * synthetic end-to-end run exercises the real parser, index and snapshot.
 * Only what depends on the operator's machine is replaced — which folder to
 * read, and how the account is discovered.
 */
export default defineSource({
  ...rest,
  // No folder to ask for: the tree is written below from fixtures. Inheriting
  // the real schema would inherit its path check, which asks about this
  // machine's filesystem.
  config: undefined,
  resolveAccountId: undefined,
  authType: "local",
  credentials: undefined,
  discover: () => Promise.resolve(preDiscoveredAccounts("maildir", ["mail-synth-johnsmith"])),
  authFlow: async () => fakeLocalFlow("maildir", "mail-synth-johnsmith"),
  // Every auth entry point the real source declares is overridden, so a demo
  // run never reaches a real mailbox.
  authenticate: undefined,
  cleanupCredentials: undefined,
  async create(options) {
    const root = options.host
      ? join(options.host.stateDir, "synthetic-maildir")
      : mkdtempSync(join(tmpdir(), "omnesis-synthetic-maildir-"));
    materializeMaildir(root, loadMessages());
    return realMaildir.create!({ ...options, config: { path: root, exclude: [] } });
  },
});
