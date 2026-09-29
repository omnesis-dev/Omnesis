// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, resolveAttachmentConfig } from "@omnesis/core";
import { defineProvider } from "@omnesis/source-sdk";
import {
  GoogleProvider,
  discoverAccounts,
  authenticate as googleAuthenticate,
  authFlow as googleAuthFlow,
} from "./provider.js";
import { GmailSource } from "./gmail.js";
import { GoogleCalendarSource } from "./calendar.js";
import { GoogleDriveSource } from "./drive.js";
import { GoogleContactsSource } from "./contacts.js";
import {
  gmailIconUrl,
  googleCalendarIconUrl,
  googleDriveIconUrl,
  googleContactsIconUrl,
} from "./icons.js";
import { googleCredentialsSpec } from "./credentials-spec.js";
import {
  gmailDocumentEventProfile,
  googleCalendarDocumentEventProfile,
} from "./document-event-profiles.js";
import {
  gmailStateSpec,
  googleCalendarStateSpec,
  googleDriveStateSpec,
  googleContactsStateSpec,
} from "./state.js";

export { googleCredentialsSpec } from "./credentials-spec.js";

export {
  GoogleProvider,
  authenticate as googleAuthenticate,
  authFlow as googleAuthFlow,
} from "./provider.js";
export { GmailSource } from "./gmail.js";
export { GoogleCalendarSource } from "./calendar.js";
export { GoogleDriveSource } from "./drive.js";
export { GoogleContactsSource } from "./contacts.js";

// ── Context ──────────────────────────────────────────────────────────

interface GoogleContext {
  provider: GoogleProvider;
  auth: ReturnType<GoogleProvider["getAuth"]>;
  accountId: string;
  dataCutoff?: string;
}

// ── Provider Definition ──────────────────────────────────────────────

export default defineProvider<GoogleContext>({
  provider: { id: "google", name: "Google" },
  authType: "oauth",
  credentials: googleCredentialsSpec,

  // Every account here is an address, because that is what the sign-in
  // resolves and what the credential is stored under. Declaring it means the
  // self-identity resolver reads a stated email instead of deciding an account
  // is one because the id contains an `@`.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: { kind: "email" as const, value: String(id) },
    }));
  },

  authenticate(session) {
    return googleAuthenticate(session);
  },

  async authFlow(_params, callbacks, ctx) {
    const accountId = await googleAuthFlow({ callbacks, configDir: ctx?.configDir });
    return String(accountId);
  },

  async cleanupCredentials(accountId: string, ctx) {
    const { rm } = await import("node:fs/promises");
    const accountDir = join(ctx?.configDir ?? DEFAULT_CONFIG_DIR, "google", accountId);
    await rm(accountDir, { recursive: true, force: true });
  },

  async createContext({ accountId, dataCutoff, host }) {
    const provider = new GoogleProvider(accountId, host?.configDir);
    await provider.initialize();
    return {
      provider,
      auth: provider.getAuth(),
      accountId,
      dataCutoff,
    };
  },

  credentialState(ctx) {
    return ctx.provider.credentialState();
  },

  async disposeContext(ctx) {
    await ctx.provider.disconnect();
  },

  sources: [
    {
      id: "gmail",
      name: "Gmail",
      description: "Emails from your Gmail account",
      unitName: "emails",
      urlPatterns: [{ regex: "mail\\.google\\.com/mail/.*#[^/]*/([a-f0-9]+)$" }],
      // Gmail's web app — already ingested here, so the browser-capture
      // source skips it rather than double-capturing the inbox UI.
      ownedWebDomains: ["mail.google.com"],
      // A Gmail message has many URL flavors in the wild — the API form
      // `https://mail.google.com/mail/#inbox/<id>`, the browser's
      // `https://mail.google.com/mail/u/<acct>/#inbox/<id>` (where `<acct>`
      // is either a digit index or an email address), label variants
      // (`#all/<id>`, `#starred/<id>`, `#label/<name>/<id>`), and the
      // openable form Omnesis itself emits today
      // (`https://mail.google.com/mail/u/<email>/#all/<id>`). All point to
      // the same message. Collapse them onto a stable, dedup-only
      // `https://mail.google.com/mail/#message/<id>` form. This canonical
      // shape is never user-facing — `metadata.sourceUrl` carries the
      // openable URL — but the `documents.source_url` column uses it so
      // `/documents/by-url` resolves regardless of the variant a caller
      // (eval YAML, agent tool, CLI) pasted.
      urlCanonicalizer: {
        hosts: ["mail.google.com"],
        rules: [
          {
            // `(?:/u/[^/]+)?` matches `/u/0`, `/u/foo@example.com`,
            // `/u/foo%40example.com` — anything up to the next slash.
            // `(?:\?[^#]*)?` swallows an `?authuser=<email>` query that the
            // source now emits to pin the message to its account — it
            // sits between the path and the `#` fragment, so it must collapse
            // here too or per-account links would dedup as distinct docs.
            // Hash path segments are `[^/]+` so user-defined label and
            // category names (uppercase, digits, spaces, percent-encoding)
            // all canonicalize. The trailing `[0-9a-fA-F]{6,}` anchors the
            // message id; the slash before it disambiguates segment vs id.
            match:
              "^https://mail\\.google\\.com/mail(?:/u/[^/]+)?/?(?:\\?[^#]*)?#(?:[^#?]{0,200}/)?([0-9a-fA-F]{6,})(?:[?#].*)?$",
            replacement: "https://mail.google.com/mail/#message/$1",
          },
        ],
      },
      icon: { sfSymbol: "envelope.fill", color: "#EA4335", bgColor: "#2D1716", url: gmailIconUrl },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: gmailStateSpec,
      },
      documentEventProfile: gmailDocumentEventProfile,
      documentTemporalProjections: [
        {
          slot: "scheduled",
          start: "scheduledAt",
          // A mail-borne scheduled date may name a span (a stay, a trip); the
          // end is projected when the source resolved one.
          end: "endsAt",
          timeZone: "timeZone",
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
      async create({ accountId, dataCutoff, sourceConfig, host }, ctx) {
        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });
        const source = new GmailSource(ctx.auth, accountId, dataCutoff, {
          attachmentConfig,
          extractAttachment: host?.extractAttachment,
        });
        return { sync: (cursor) => source.sync(cursor) };
      },
    },
    {
      id: "google-calendar",
      name: "Google Calendar",
      description: "Events from your Google Calendar",
      unitName: "events",
      urlPatterns: [{ regex: "calendar\\.google\\.com/calendar/.*[?&]eid=([^&]+)" }],
      // Google Calendar's web app — already ingested here, so the
      // browser-capture source skips the calendar UI.
      ownedWebDomains: ["calendar.google.com"],
      icon: {
        sfSymbol: "calendar",
        color: "#4285F4",
        bgColor: "#16213A",
        url: googleCalendarIconUrl,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: googleCalendarStateSpec,
        // Declared because the migration chain is what carries an install off
        // the pre-expansion shape. A host without envelope support would hand
        // the raw stored value to a decoder that rejects it, which reads as a
        // first run.
        requires: ["state-envelope"],
      },
      documentEventProfile: googleCalendarDocumentEventProfile,
      async create(_options, ctx) {
        const source = new GoogleCalendarSource(ctx.auth, ctx.accountId, ctx.dataCutoff);
        // Event documents sync alongside the analytics dual-push: a
        // `google_calendar_events` table and the synthesized doc↔row edge.
        return {
          sync: (cursor) => source.sync(cursor),
          syncStructured: (cursor) => source.syncStructured(cursor),
          analyticsSchemas: source.analyticsSchemas,
        };
      },
    },
    {
      id: "google-drive",
      name: "Google Drive",
      description: "Files from your Google Drive",
      unitName: "files",
      urlPatterns: [
        { regex: "docs\\.google\\.com/(?:document|spreadsheets|presentation)/d/([^/]+)" },
        { regex: "drive\\.google\\.com/file/d/([^/]+)" },
      ],
      // Drive surfaces files under both hosts (the Drive shell and the
      // Docs/Sheets/Slides editors). Already ingested here, so the
      // browser-capture source skips both rather than re-capturing the
      // rendered editor DOM.
      ownedWebDomains: ["drive.google.com", "docs.google.com"],
      // Drive surfaces a file under several URL paths depending on its
      // type (`docs.google.com/document/d/<id>/edit`,
      // `/spreadsheets/d/<id>/edit`, `/presentation/d/<id>/edit`,
      // `drive.google.com/file/d/<id>/view`) plus optional share
      // markers (`?usp=drivesdk`, `?ouid=…`, `?rtpof=…`, `?sd=…`).
      // The file id is the only thing that identifies the resource —
      // collapse every variant onto `drive.google.com/file/d/<id>` so
      // pasting any URL into an eval suite hits the same row Omnesis
      // stored.
      urlCanonicalizer: {
        hosts: ["drive.google.com", "docs.google.com"],
        rules: [
          {
            match:
              "^https://(?:drive|docs)\\.google\\.com/(?:file|document|spreadsheets|presentation)/d/([\\w-]+).*$",
            replacement: "https://drive.google.com/file/d/$1",
          },
        ],
      },
      icon: {
        sfSymbol: "externaldrive.fill",
        color: "#FBBC04",
        bgColor: "#2D2410",
        url: googleDriveIconUrl,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: googleDriveStateSpec,
      },
      async create({ accountId, dataCutoff, sourceConfig, host }, ctx) {
        // Drive defaults to extracting binary file content (PDFs, Office,
        // …) so a search for "annual report" hits the PDF in your Drive
        // the same way it hits an email attachment of that PDF.
        // Set `extractAttachments: false` per source to opt out.
        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });
        const source = new GoogleDriveSource(ctx.auth, accountId, dataCutoff, {
          attachmentConfig,
          extractAttachment: host?.extractAttachment,
        });
        return { sync: (cursor) => source.sync(cursor) };
      },
    },
    {
      id: "google-contacts",
      name: "Google Contacts",
      description: "Contacts from your Google account",
      unitName: "contacts",
      icon: {
        sfSymbol: "person.crop.circle.fill",
        color: "#4285F4",
        bgColor: "#16213A",
        url: googleContactsIconUrl,
      },
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: googleContactsStateSpec,
      },
      async create(_options, ctx) {
        const source = new GoogleContactsSource(ctx.auth, ctx.accountId);
        return { sync: (cursor) => source.sync(cursor) };
      },
    },
  ],
});
