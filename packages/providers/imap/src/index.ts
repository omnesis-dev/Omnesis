// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolveAttachmentConfig } from "@omnesis/core";
import { defineProvider, readConnectionState } from "@omnesis/source-sdk";
import { createImapClient } from "./client.js";
import { imapCredentialsSpec } from "./credentials-spec.js";
import { imapDocumentEventProfile } from "./document-event-profile.js";
import { genericImapIcon, imapIconForHost } from "./icons.js";
import {
  authenticate as imapAuthenticate,
  authFlow,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
import { ImapEmailSource, validateImapEmailCursor } from "./source.js";
import { imapStateSpec } from "./state.js";
import type { ImapConnectionCredentials } from "./client.js";

interface ImapContext {
  accountId: string;
  credentials: ImapConnectionCredentials;
  configDir?: string;
}

export { createImapClient, mapImapError } from "./client.js";
export { imapCredentialsSpec } from "./credentials-spec.js";
export { imapDocumentEventProfile } from "./document-event-profile.js";
export { genericImapIcon, imapIconForHost } from "./icons.js";
export {
  authenticate,
  authFlow,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
export { ImapEmailSource, validateImapEmailCursor } from "./source.js";
export type { ImapConnectionCredentials } from "./client.js";
export type {
  ImapAddress,
  ImapAttachmentPart,
  ImapClient,
  ImapClientFactory,
  ImapEmailCursor,
  ImapEmailSourceOptions,
  ImapEnvelope,
  ImapMailbox,
  ImapMailboxState,
  ImapMessage,
  ImapMessageMetadata,
} from "./source.js";

/** A login shaped like a mailbox address: one `@`, a dotted domain, no spaces. */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default defineProvider<ImapContext>({
  provider: { id: "imap", name: "IMAP" },
  authType: "api-key",
  credentials: imapCredentialsSpec,

  // An account is the login the mailbox was connected with. That is almost
  // always the mailbox's address, but a server may accept a bare user name
  // (iCloud takes the part before the `@`), which is a handle and not an
  // address anyone could be mailed at.
  discover(ctx) {
    return Promise.resolve(
      discoverAccounts(ctx?.configDir).map((id) => ({
        id: String(id),
        subject: {
          kind: ADDRESS_SHAPE.test(String(id)) ? ("email" as const) : ("handle" as const),
          value: String(id),
        },
      })),
    );
  },

  authenticate(session) {
    return imapAuthenticate(session);
  },

  async authFlow(params, callbacks, ctx) {
    return String(await authFlow(params, callbacks, ctx));
  },

  async cleanupCredentials(accountId, ctx) {
    await cleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, host }) {
    return {
      accountId,
      credentials: await loadCredentials(accountId, host?.configDir),
      configDir: host?.configDir,
    };
  },

  // A stored credential is the whole answer, and its absence means this
  // account was never connected rather than that something withdrew it — a
  // distinction the remedy depends on: one asks the operator to connect, the
  // other to authenticate again.
  credentialState(ctx) {
    return readConnectionState(async () => {
      if (!hasCredentials(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
      await loadCredentials(ctx.accountId, ctx.configDir);
      return { status: "connected" };
    });
  },

  async disposeContext() {},

  sources: [
    {
      id: "imap",
      name: "IMAP Email",
      description: "Email from any account that offers IMAP over TLS on port 993",
      unitName: "emails",
      icon: genericImapIcon,
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never
        // reaches `sync`.
        state: imapStateSpec,
        apiVersion: 2,
        requires: ["snapshot-sessions"],
      },
      documentEventProfile: imapDocumentEventProfile,
      documentTemporalProjections: [
        {
          slot: "scheduled",
          start: "scheduledAt",
          kind: "event",
          modality: "asserted",
          status: "active",
        },
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "asserted",
          status: "active",
        },
      ],
      create({ sourceId, providerId, dataCutoff, sourceConfig, host }, ctx) {
        // `sourceConfig` is the collector's per-field merge of sources.default
        // and this source's own key — never re-derive it from the raw config.
        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });
        const source = new ImapEmailSource(
          sourceId,
          providerId,
          () => createImapClient(ctx.credentials),
          dataCutoff,
          { attachmentConfig, extractAttachment: host?.extractAttachment },
        );
        return Promise.resolve({
          icon: imapIconForHost(ctx.credentials.host),
          sync: (cursor, opts) => source.sync(validateImapEmailCursor(cursor), opts),
          suspend: () => source.suspend(),
          resume: () => source.resume(),
          dispose: () => source.dispose(),
        });
      },
    },
  ],
});
