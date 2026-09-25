// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG_DIR, createLogger, resolveAttachmentConfig } from "@omnesis/core";
import { defineSource } from "@omnesis/source-sdk";
import { whatsappStateSpec } from "./state.js";
import { inspectMessageStore } from "./message-store.js";
import { whatsappIconUrl } from "./icons.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { WhatsAppSyncCursor } from "./types.js";

export { WhatsAppProvider, pairFlow as whatsappPairFlow } from "./provider.js";
export { WhatsAppMessagesSource, type WhatsAppMessagesSourceOptions } from "./messages.js";

const log = createLogger("provider:whatsapp");

export default defineSource<WhatsAppSyncCursor>({
  id: "whatsapp-messages",
  name: "WhatsApp Messages",
  description: "Sync WhatsApp conversations via QR code pairing",
  provider: { id: "whatsapp", name: "WhatsApp" },
  authType: "qr",
  unitName: "messages",
  contentRetention: "best-effort",
  // Voice notes are transcribed inline into the conversation rather than
  // emitted as separate attachment child-docs.
  conversational: true,
  // WhatsApp Web — conversations are already ingested here, so the
  // browser-capture source skips the web client.
  ownedWebDomains: ["web.whatsapp.com"],
  icon: { sfSymbol: "message.fill", color: "#25D366", bgColor: "#12251C", url: whatsappIconUrl },
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so a value from a build that could not read it never reaches `sync`.
    state: whatsappStateSpec,
  },

  // What a condition can address on these documents. One `conversation`
  // document covers one chat on one calendar day; each extracted file in that
  // day becomes an `attachment` child document. Everyone in the chat — the
  // group roster plus the day's senders, with the account holder as "You" —
  // is a `participant`; email addresses and phone numbers appearing in the
  // day's text that belong to nobody in the chat become `mentioned`.
  documentEventProfile: {
    documentTypes: ["conversation", "attachment"],
    personRoles: ["participant", "mentioned"],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Carries 'group' on a group conversation and is empty on a one-to-one chat.",
        allowedValues: ["group"],
        valueAliases: { group: ["group chat", "group conversation", "groups"] },
      },
      {
        path: "extra.isGroup",
        type: "boolean",
        description: "True for a group conversation, false for a one-to-one chat.",
      },
      {
        path: "extra.chatName",
        type: "string",
        // A one-to-one chat's name IS the other person, so filtering on it
        // names a human even though a group's name does not.
        identifiesPeople: true,
        description:
          "Name WhatsApp reports for the chat — the group subject, or the saved contact name for a one-to-one chat. Absent when WhatsApp never delivered the chat's metadata.",
      },
      {
        path: "extra.chatJid",
        type: "string",
        // Opaque for a group, but a one-to-one chat's JID is built from the
        // other party's phone number, which the source URL parses back out.
        identifiesPeople: true,
        description:
          "Opaque WhatsApp identifier for the chat. Every day of the same conversation repeats it, so it identifies a conversation across documents.",
      },
      {
        path: "extra.participants",
        type: "string-array",
        identifiesPeople: true,
        description:
          "Display name of everyone in the conversation that day; the account holder appears as 'You'.",
      },
      {
        path: "extra.messageCount",
        type: "number",
        description: "Messages exchanged that day, excluding reactions.",
      },
      {
        path: "extra.mediaCount",
        type: "number",
        description:
          "Messages that day carrying an image, video, audio clip, document, or sticker.",
      },
    ],
  },

  // One-time full-history import from a local encrypted iPhone backup.
  // WhatsApp only streams a companion the recent (~90-day) window; the full
  // archive lives on the phone and is recovered from a backup.
  // Planned variants surface here as a leading `select` field: #29 (Android
  // crypt15 backup), #28 (Tier-2 targeted pull via pymobiledevice3).
  historyImport: {
    label: "Import full history",
    description:
      "Decrypt an encrypted iPhone backup and import your complete WhatsApp message history.",
    fields: [
      {
        key: "backupPath",
        label: "iPhone backup folder",
        type: "directory",
        required: true,
        help: "The folder containing Manifest.plist (an encrypted Finder/iTunes backup).",
      },
      {
        key: "passphrase",
        label: "Backup password",
        type: "secret",
        required: true,
        help: "The password set when the backup was encrypted.",
      },
    ],
  },

  // Every discovered account is the linked phone's own number in E.164 —
  // `+` and the digits of the JID the pairing resolved; staging directories
  // are never discovered. Declaring it lets the self-identity resolver match
  // the operator's number rather than infer what the id means.
  async discover(ctx) {
    const { discoverAccounts } = await import("./provider.js");
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: { kind: "phone" as const, value: String(id) },
    }));
  },

  async authenticate(session) {
    const { pairFlow } = await import("./provider.js");
    const phone = await pairFlow({
      configDir: session.host.configDir,
      expectedAccountId: session.accountId,
      // The instructions travel with the code. They used to live in the
      // portal, which meant a component every source renders named this one.
      // A rotated code replaces the previous challenge rather than joining it.
      onQrCode: (qr) =>
        session.show({
          kind: "qr",
          title: "Scan this code from your phone",
          instructions:
            "On your phone: WhatsApp, then Settings, then Linked devices, then Link a device.",
          data: qr,
        }),
    });
    return { accounts: [{ accountId: String(phone), state: { status: "connected" } }] };
  },

  async cleanupCredentials(accountId, ctx) {
    const authDir = join(ctx?.configDir ?? DEFAULT_CONFIG_DIR, "whatsapp", accountId);
    rmSync(authDir, { recursive: true, force: true });
  },

  async create({ accountId, dataCutoff, sourceConfig, host }) {
    const { WhatsAppProvider } = await import("./provider.js");
    const { WhatsAppMessagesSource } = await import("./messages.js");

    // The config ROOT, not `host.stateDir`. The provider re-joins it with its
    // own `whatsapp/<account>` segments for the durable store and the auth
    // state, and passes it on as the keyring root; handing it the state dir
    // would nest those one level deeper and break every secret lookup.
    const provider = new WhatsAppProvider(accountId, host?.configDir);
    await provider.initialize();

    if (!(await provider.isAuthenticated())) {
      throw new Error(`WhatsApp account ${accountId} has invalid credentials`);
    }

    log.info(`Connecting WhatsApp account: ${accountId}`);
    await provider.authenticate();

    const attachmentConfig = resolveAttachmentConfig(sourceConfig, { defaultEnabled: true });

    const source = new WhatsAppMessagesSource(provider.getStore(), accountId, {
      dataCutoff,
      attachmentConfig,
      extractAttachment: host?.extractAttachment,
      transcribeAudio: host?.transcribeAudio,
      downloadMedia: provider.getMediaDownloader(),
      onConnectionError: (handler) => provider.onConnectionError(handler),
      offConnectionError: (handler) => provider.offConnectionError(handler),
    });

    return {
      // Surface the icon at the runtime instance level. The collector
      // only ships instance-level icons (`SourceInstance.icon`) up to
      // the gateway's `sync_state.icon` column — descriptor-level icons
      // are visible only to the source picker. Same fix shape as
      // `notion-source-icon-missing-in-portal` (commit 0f3849f).
      icon: {
        sfSymbol: "message.fill",
        color: "#25D366",
        bgColor: "#12251C",
        url: whatsappIconUrl,
      },
      sync: (cursor) => source.sync(cursor) as Promise<SyncResult<WhatsAppSyncCursor>>,
      credentialState: () => provider.credentialState(),
      probeLocalStores: async () => [
        inspectMessageStore(join(host?.configDir ?? DEFAULT_CONFIG_DIR, "whatsapp", accountId)),
      ],
      onPushEvent: (cb: () => void) => source.onPushEvent(cb),
      onSourceError: (cb: (error: string) => void) => source.onSourceError(cb),
      onResync: () => source.onResync(),
      importHistory: (values, callbacks) => provider.importHistory(values, callbacks),
      suspend: () => provider.suspend(),
      resume: () => provider.resume(),
      async dispose() {
        await provider.disconnect();
      },
    };
  },
});
