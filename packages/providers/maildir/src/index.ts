// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveAttachmentConfig } from "@omnesis/core";
import {
  config as configSchema,
  defineSource,
  expandHostPath,
  type SourceInstance,
} from "@omnesis/source-sdk";
import { safePathSegment } from "@omnesis/types";
import { maildirDocumentEventProfile } from "./document-event-profile.js";
import { maildirIcon } from "./icons.js";
import { probeMaildirReadAccess } from "./probe.js";
import { MaildirSource } from "./source.js";
import { maildirStateSpec } from "./state.js";
import type { MaildirCursor } from "./source.js";

export { maildirDocumentEventProfile } from "./document-event-profile.js";
export type { MaildirCursor } from "./source.js";

/** The local index's file name inside the account's state directory. */
const INDEX_FILE = "maildir-index.sqlite";

// The cursor type is pinned on `create`'s return rather than as a type
// argument to `defineSource`, so the configuration schema's type is still
// inferred and `create` receives it typed.
export default defineSource({
  id: "maildir",
  name: "Maildir",
  description: "Email a mail tool such as mbsync or offlineimap keeps on this machine as a Maildir",
  provider: { id: "maildir", name: "Maildir" },
  authType: "local",
  experimental: true,
  unitName: "emails",
  icon: maildirIcon,
  contract: {
    // The host resolves the stored cursor against this before `sync` runs.
    state: maildirStateSpec,
    apiVersion: 2,
  },
  documentEventProfile: maildirDocumentEventProfile,
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
  /**
   * One account per Maildir root on this machine: the folder's name, for a
   * person to recognise it, and a hash of its resolved path, so two roots
   * with the same name stay apart. A source already configured for the same
   * folder keeps its id however the path was typed.
   */
  resolveAccountId(params, existing) {
    const path = params.path;
    if (!path) throw new Error("A Maildir path is required to name the account");
    const canonical = realpathSync(expandHostPath(path));
    for (const account of existing) {
      const configured = account.params?.path;
      if (!configured) continue;
      let configuredCanonical: string;
      try {
        configuredCanonical = realpathSync(expandHostPath(configured));
      } catch {
        configuredCanonical = expandHostPath(configured);
      }
      if (configuredCanonical === canonical) return account.accountId;
    }
    const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const label = basename(canonical)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 80);
    return `${label || "maildir"}-${suffix}`;
  },
  /**
   * The source keeps no credential, but removing it should not leave its
   * index behind: that file lists the account's folder and file names. This
   * is the hook the collector calls when a source is removed, so it deletes
   * the index there. The directory is the account's state directory, which
   * the collector derives the same way.
   */
  cleanupCredentials(accountId, ctx) {
    if (!ctx?.configDir) return Promise.resolve();
    const dir = join(ctx.configDir, safePathSegment("maildir"), safePathSegment(accountId));
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, `${INDEX_FILE}${suffix}`), { force: true });
    }
    return Promise.resolve();
  },
  config: configSchema.object({
    path: configSchema.path({
      label: "Maildir folder",
      // A folder on one machine; another machine keeps its copy elsewhere.
      scope: "member",
      required: true,
      placeholder: "~/Mail/example",
      mustExist: "directory",
      help: "The folder your mail tool writes one account's mail to. It, or a folder inside it such as INBOX, holds cur and new directories.",
    }),
    exclude: configSchema.list(configSchema.string({ label: "Folder pattern" }), {
      label: "Exclude folders",
      help: "Folder names to leave out, one per line — for example [Gmail]/All Mail. * matches within a folder name and ** across folders. Leave empty to sync every folder except drafts, spam and trash.",
      // Not a setup question: which folders to leave out only becomes clear
      // after a first sync shows what is there.
      advanced: true,
      separator: "newline",
      default: [],
    }),
  }),

  create({
    sourceId,
    providerId,
    dataCutoff,
    config,
    sourceConfig,
    host,
  }): Promise<SourceInstance<MaildirCursor>> {
    const root = config?.path;
    if (!root)
      return Promise.reject(new Error("The Maildir source needs the folder its mail is in"));
    const exclude = config?.exclude ?? [];
    // `sourceConfig` is the collector's per-field merge of sources.default and
    // this source's own key — never re-derive it from the raw config.
    const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
      defaultEnabled: true,
      includeAudioTypes: host?.includeAudioTypes,
    });
    const source = new MaildirSource({
      sourceId,
      providerId,
      root,
      exclude,
      // Without a host there is nowhere durable to keep the index; it then
      // lasts as long as the process, and a restart re-emits every message.
      indexPath: host ? join(host.stateDir, INDEX_FILE) : ":memory:",
      dataCutoff,
      attachmentConfig,
      extractAttachment: host?.extractAttachment,
    });
    return Promise.resolve({
      sync: (cursor, opts) => source.sync(cursor, opts),
      onResync: () => source.onResync(),
      dispose: () => source.dispose(),
      probeReadAccess: ({ signal }) => probeMaildirReadAccess(root, signal),
      // Every change a mail tool makes is a file appearing, moving between
      // `new` and `cur`, or being renamed with new flags, anywhere below the
      // root.
      watchPaths: [root],
      watchDirectoryPaths: [root],
    });
  },
});
