// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realProvider, { ImapEmailSource, validateImapEmailCursor } from "@omnesis/provider-imap";
import { defineProvider } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  preDiscoveredAccounts,
  sha256Hex,
  universeAccounts,
} from "@omnesis/providers-synth-common";
import { resolveAttachmentConfig } from "@omnesis/core";
import type { ImapClient, ImapMessage } from "@omnesis/provider-imap";
const messageSchema = z
  .object({
    uid: z.number().int().positive(),
    subject: z.string(),
    from: z.email(),
    to: z.array(z.email()),
    body: z.string(),
    sentAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    mailbox: z.string().default("INBOX"),
    messageId: z.string().optional(),
  })
  .strict();
export type ImapFixtureMessage = z.infer<typeof messageSchema>;
export function loadMessages(): ImapFixtureMessage[] {
  const messages = z
    .array(messageSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "imap", "messages.json"));
  const keys = messages.map((message) => `${message.mailbox}:${message.uid}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("Synthetic IMAP fixture repeats a mailbox UID");
  return messages;
}
/** The network seam alone is replaced; the real IMAP source owns parsing and cursor semantics. */
export function fixtureClient(entries: ImapFixtureMessage[], identity = "synthetic"): ImapClient {
  let mailbox = "INBOX";
  const rows = () => entries.filter((entry) => entry.mailbox === mailbox);
  const toMessage = (entry: ImapFixtureMessage): ImapMessage => ({
    uid: entry.uid,
    envelope: {
      subject: entry.subject,
      date: new Date(entry.sentAt),
      from: [{ address: entry.from }],
      to: entry.to.map((address) => ({ address })),
      messageId:
        entry.messageId ??
        `<synthetic-${sha256Hex(JSON.stringify([identity, entry.mailbox, entry.uid]))}@example.com>`,
    },
    internalDate: new Date(entry.sentAt),
    text: entry.body,
  });
  return {
    connect: async () => {},
    list: async () =>
      [...new Set(["INBOX", ...entries.map((entry) => entry.mailbox)])].map((path) => ({
        path,
        flags: new Set<string>(),
      })),
    open: async (path) => {
      mailbox = path;
      return { uidValidity: "1", uidNext: Math.max(0, ...rows().map((entry) => entry.uid)) + 1 };
    },
    search: async (query) =>
      rows()
        .filter(
          (entry) =>
            (!query.since || Date.parse(entry.sentAt) >= query.since.getTime()) &&
            entry.uid >= Number(query.uid?.split(":")[0] ?? 1),
        )
        .map((entry) => entry.uid),
    fetch: async (uids) =>
      rows()
        .filter((entry) => uids.includes(entry.uid))
        .map(toMessage),
    fetchMetadata: async (uids) =>
      rows()
        .filter((entry) => uids.includes(entry.uid))
        .map((entry) => ({ uid: entry.uid, date: new Date(entry.sentAt) })),
    fetchAttachment: async () => {
      throw new Error("Synthetic IMAP fixture has no binary attachment part");
    },
    close: async () => {},
  };
}
const { type: _type, ...rest } = realProvider;
export default defineProvider<Record<string, never>>({
  ...rest,
  credentials: undefined,
  supportedPlatforms: undefined,
  authenticate: undefined,
  cleanupCredentials: undefined,
  discover: async () => preDiscoveredAccounts("imap", universeAccounts("imap")),
  authFlow: async () =>
    fakeLocalFlow("imap", universeAccounts("imap")[0] ?? "synthetic@example.com"),
  createContext: async () => ({}),
  credentialState: async () => ({ status: "connected" }),
  disposeContext: async () => {},
  sources: rest.sources.map((source) => ({
    ...source,
    async create(options) {
      const entries = loadMessages();
      const instance = new ImapEmailSource(
        options.sourceId,
        options.providerId,
        () => fixtureClient(entries, options.sourceId),
        options.dataCutoff,
        {
          attachmentConfig: resolveAttachmentConfig(options.sourceConfig, { defaultEnabled: true }),
          extractAttachment: options.host?.extractAttachment,
        },
      );
      return {
        sync: (cursor, opts) => instance.sync(validateImapEmailCursor(cursor), opts),
        suspend: () => instance.suspend(),
        resume: () => instance.resume(),
        dispose: () => instance.dispose(),
      };
    },
  })),
});
