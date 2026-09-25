// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, resolveAttachmentConfig } from "@omnesis/core";
import { defineProvider } from "@omnesis/source-sdk";
import {
  MicrosoftProvider,
  discoverAccounts,
  authenticate as microsoftAuthenticate,
  authFlow as microsoftAuthFlow,
} from "./provider.js";
import { OutlookEmailSource } from "./outlook-email.js";
import { OneDriveSource } from "./onedrive.js";
import { OutlookCalendarSource } from "./outlook-calendar.js";
import { outlookCalendarDocumentEventProfile } from "./document-event-profiles.js";
import { validateOutlookEmailCursor } from "./outlook-types.js";
import { validateOneDriveCursor } from "./onedrive-types.js";
import { outlookIconUrl, oneDriveIconUrl, outlookCalendarIconDataUri } from "./icons.js";
import { outlookCredentialsSpec } from "./credentials-spec.js";
import { outlookEmailStateSpec, outlookCalendarStateSpec, oneDriveStateSpec } from "./state.js";

export {
  MicrosoftProvider,
  authenticate as microsoftAuthenticate,
  authFlow as microsoftAuthFlow,
} from "./provider.js";
export { OutlookEmailSource } from "./outlook-email.js";
export { OneDriveSource } from "./onedrive.js";
export { OutlookCalendarSource } from "./outlook-calendar.js";
export { OUTLOOK_CALENDAR_EVENTS_TABLE } from "./outlook-calendar-schema.js";
export { outlookCredentialsSpec } from "./credentials-spec.js";
export { GraphClient, DeltaExpiredError, AuthError } from "./graph-client.js";
export {
  validateOneDriveCursor,
  type OneDriveCursor,
  type DriveItem,
  type DriveDeltaResponse,
  type GraphClientLike,
} from "./onedrive-types.js";
export {
  validateOutlookCalendarCursor,
  type OutlookCalendarCursor,
  type GraphEvent,
  type CalendarDeltaResponse,
  type CalendarGraphClientLike,
} from "./outlook-calendar-types.js";

// ── Context ──────────────────────────────────────────────────────────

interface MicrosoftContext {
  provider: MicrosoftProvider;
  accountId: string;
  dataCutoff?: string;
}

// ── Provider Definition ──────────────────────────────────────────────

export default defineProvider<MicrosoftContext>({
  provider: { id: "microsoft", name: "Microsoft" },
  authType: "oauth",
  credentials: outlookCredentialsSpec,

  // Every account here is the address the sign-in resolved (`account.username`
  // under an authority that accepts personal accounts only), and it is what the
  // credential is stored under. Declaring it means the self-identity resolver
  // reads a stated email rather than inferring one because the id has an `@`.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: { kind: "email" as const, value: String(id) },
    }));
  },

  authenticate(session) {
    return microsoftAuthenticate(session);
  },

  async authFlow(_params, callbacks, ctx) {
    const accountId = await microsoftAuthFlow({ callbacks, configDir: ctx?.configDir });
    return String(accountId);
  },

  async cleanupCredentials(accountId: string, ctx) {
    const { rm } = await import("node:fs/promises");
    const accountDir = join(ctx?.configDir ?? DEFAULT_CONFIG_DIR, "outlook", accountId);
    await rm(accountDir, { recursive: true, force: true });
  },

  async createContext({ accountId, dataCutoff, host }) {
    // `host.configDir`, never `host.stateDir`: this package declares the
    // provider id `microsoft` but roots its credentials under `outlook`, so a
    // state-dir substitution would point the token store at a directory that
    // does not exist while discovery kept finding the account under the old
    // one — presenting as a failed sign-in rather than a missing directory.
    const provider = new MicrosoftProvider(accountId, host?.configDir);
    await provider.initialize();
    return {
      provider,
      accountId,
      dataCutoff,
    };
  },

  async credentialState(ctx) {
    return ctx.provider.credentialState();
  },

  async disposeContext(ctx) {
    await ctx.provider.disconnect();
  },

  sources: [
    {
      id: "outlook-email",
      name: "Outlook Email",
      description: "Emails from your Outlook.com / Hotmail account",
      unitName: "emails",
      urlPatterns: [
        { regex: "outlook\\.live\\.com/mail/\\d+/id/([^/]+)" },
        { regex: "outlook\\.office365\\.com/mail/.*?/id/([^/]+)" },
        { regex: "outlook\\.office\\.com/mail/.*?/id/([^/]+)" },
      ],
      // The consumer Outlook web app, which is the only one these sources can
      // ingest — sign-in goes to the consumer authority, so a work mailbox on
      // `outlook.office.com` never reaches this index. Claiming those hosts
      // would make the browser-capture source skip pages nothing else records,
      // which is why only `outlook.live.com` is here even though `urlPatterns`
      // resolves links on all three. Mail and calendar share the host, and this
      // source claims it for both.
      ownedWebDomains: ["outlook.live.com"],
      icon: {
        sfSymbol: "envelope.fill",
        color: "#0078D4",
        bgColor: "#0B2236",
        url: outlookIconUrl,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: outlookEmailStateSpec,
        requires: ["state-envelope"],
      },
      async create({ sourceId, providerId, dataCutoff, sourceConfig, host }, ctx) {
        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });
        const source = new OutlookEmailSource(
          () => ctx.provider.getAccessToken(),
          sourceId,
          providerId,
          dataCutoff,
          { attachmentConfig, extractAttachment: host?.extractAttachment },
        );
        return { sync: (cursor) => source.sync(validateOutlookEmailCursor(cursor)) };
      },
    },
    {
      id: "onedrive",
      name: "OneDrive",
      description: "Files from your personal Microsoft OneDrive",
      unitName: "files",
      urlPatterns: [
        // OneDrive personal web links, e.g.
        // https://onedrive.live.com/?id=<itemId>&cid=<driveId> and the
        // redeem/redir variants. The item id is the externalId we key on.
        { regex: "onedrive\\.live\\.com/.*[?&]id=([^&]+)" },
        { regex: "1drv\\.ms/[a-z]/([^/?]+)" },
      ],
      // The OneDrive web app — already ingested here, so the browser-capture
      // source skips the file browser rather than re-capturing its DOM. The
      // `1drv.ms` shortener is a redirector rather than a site of its own, so
      // it is not claimed: following one lands on a host listed here.
      ownedWebDomains: ["onedrive.live.com"],
      // A file is reachable as `?id=<itemId>&cid=<driveId>`, with the two in
      // either order and share markers (`&e=`, `&migratedtospo=`, `&redeem=`)
      // trailing. The item id is the only part that names the file, so every
      // variant collapses onto it. A `1drv.ms` short link is deliberately left
      // alone: it carries no item id to collapse onto, and only Microsoft can
      // resolve what it points at.
      urlCanonicalizer: {
        hosts: ["onedrive.live.com"],
        rules: [
          {
            match: "^https://onedrive\\.live\\.com/.*[?&]id=([^&]+).*$",
            replacement: "https://onedrive.live.com/?id=$1",
          },
        ],
      },
      icon: {
        sfSymbol: "cloud.fill",
        color: "#0078D4",
        bgColor: "#0B2236",
        url: oneDriveIconUrl,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: oneDriveStateSpec,
        requires: ["state-envelope"],
      },
      async create({ sourceId, providerId, dataCutoff, sourceConfig, host }, ctx) {
        // OCR opt-in lights up image files identically to Drive: the
        // resolved attachment config's allow-list drives `shouldExtractAttachment`
        // at fetch time inside the source.
        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });
        const source = new OneDriveSource(
          () => ctx.provider.getAccessToken(),
          sourceId,
          providerId,
          dataCutoff,
          { attachmentConfig, extractAttachment: host?.extractAttachment },
        );
        return { sync: (cursor) => source.sync(validateOneDriveCursor(cursor)) };
      },
    },
    {
      id: "outlook-calendar",
      name: "Outlook Calendar",
      description: "Events from your Outlook calendar",
      unitName: "events",
      urlPatterns: [
        // Outlook web calendar deep links carry the event in an `itemid` query
        // param, e.g. https://outlook.live.com/calendar/0/view/...?itemid=<id>
        // and the OWA `?itemid=<id>&exvsurl=1&path=/calendar/item` form.
        { regex: "outlook\\.live\\.com/.*[?&]itemid=([^&]+)" },
        { regex: "outlook\\.office365\\.com/.*[?&]itemid=([^&]+)" },
        { regex: "outlook\\.office\\.com/.*[?&]itemid=([^&]+)" },
      ],
      // No `urlCanonicalizer`. Collapsing the several Outlook web URLs for one
      // event would mean choosing a canonical form, and `source_url` is served
      // to clients as the link they follow — so an invented shape hands out a
      // dead link. The OWA variants carry routing (`exvsurl`, `path`) that is
      // not obviously discardable, and Google Calendar declares none either.
      // `urlPatterns` above already resolve an inbound link to its document,
      // which is what a canonicalizer would mostly have bought.
      //
      // What a watch may ask about an event. Without this the watch journal
      // projects every Outlook event with empty metadata, so a condition on an
      // event's location, availability or calendar silently never fires.
      documentEventProfile: outlookCalendarDocumentEventProfile,
      icon: {
        sfSymbol: "calendar",
        color: "#0078D4",
        bgColor: "#0B2236",
        imageDataUri: outlookCalendarIconDataUri,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: outlookCalendarStateSpec,
        apiVersion: 2,
        requires: ["state-envelope", "snapshot-sessions"],
      },
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const source = new OutlookCalendarSource(
          () => ctx.provider.getAccessToken(),
          sourceId,
          providerId,
          dataCutoff,
        );
        // Event documents sync alongside the analytics dual-push: an
        // `outlook_calendar_events` table and the synthesized doc↔row edge.
        return {
          sync: (cursor) => source.sync(cursor),
          syncStructured: (cursor) => source.syncStructured(cursor),
          analyticsSchemas: source.analyticsSchemas,
        };
      },
    },
  ],
});
