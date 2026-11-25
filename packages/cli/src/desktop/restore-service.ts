// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKUP_RECOVERY_ENVELOPE_NAME,
  GATEWAY_ANALYTICS_STORE_FILE,
  WATCH_JOURNAL_FILENAME,
  readPackageVersion,
  STORE_COMPANION_SUFFIXES,
} from "@omnesis/core";
import { readDesktopRestoreReview } from "./restore-review.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import {
  DesktopRestoreImports,
  type DesktopRestoreImportSlot,
  type DesktopRestoreFileSelection,
} from "./restore-imports.js";
import { DesktopRestoreEntries } from "./restore-entries.js";
import { DesktopRestoreStoreKeys } from "./restore-store-keys.js";
import {
  DesktopRestoreProtection,
  type DesktopRestoreProtectionIdentity,
} from "./restore-protection.js";
import { runDesktopRestoreOperation, runDesktopRestoreRecovery } from "./restore-operation.js";
import { readDesktopRestoreIntent } from "./restore-intent.js";
import type { DesktopBackupArchive } from "./restore-archive.js";
import type { DesktopProfile } from "./environment.js";
import type {
  DesktopRestoreImportResult,
  DesktopRestorePreview,
  DesktopRestoreResult,
  DesktopRestoreRecoveryResult,
  DesktopRestoreStatus,
} from "./restore-contract.js";

export interface DesktopRestoreServiceOperations {
  apply(
    profile: DesktopProfile,
    input: {
      archive: DesktopBackupArchive;
      entries: DesktopRestoreEntries;
      keys: DesktopRestoreStoreKeys;
      protection: DesktopRestoreProtectionIdentity;
      stagingRoot: string;
    },
    signal: AbortSignal,
  ): Promise<{ operationId: string; sourcesPaused: number; watchesPaused: number }>;
  recover: typeof runDesktopRestoreRecovery;
}
const defaultOperations: DesktopRestoreServiceOperations = {
  apply: runDesktopRestoreOperation,
  recover: runDesktopRestoreRecovery,
};

interface Draft {
  controller: AbortController;
  receipt?: { sha256: string; bytes: number };
  archive?: DesktopBackupArchive;
  entries?: DesktopRestoreEntries;
  keys?: DesktopRestoreStoreKeys;
  directory?: string;
  confirmation?: { id: string; protection: DesktopRestoreProtectionIdentity; expires: number };
}
/** A preview capability belongs to this private bridge and is consumed once. */
export class DesktopBackupRestoreService {
  readonly #drafts = new Map<string, Draft>();
  readonly #imports: DesktopRestoreImports;
  readonly #lifetime = new AbortController();
  readonly #prepares = new Set<Promise<unknown>>();
  #preparing = 0;
  #sessionLease: { release(): void } | undefined;
  constructor(
    private readonly profile: DesktopProfile,
    private readonly operations: DesktopRestoreServiceOperations = defaultOperations,
  ) {
    this.#imports = new DesktopRestoreImports(profile, {
      readRootKey: async () => {
        const protection = await DesktopRestoreProtection.capture(
          profile,
          new AbortController().signal,
        );
        try {
          return protection.key();
        } finally {
          protection.close();
        }
      },
      onRelease: (id) => this.releaseDraft(id),
    });
  }
  async prepare(signal: AbortSignal): Promise<DesktopRestoreImportSlot> {
    const active = AbortSignal.any([signal, this.#lifetime.signal]);
    const operation = this.prepareOwned(active);
    this.#prepares.add(operation);
    try {
      return await operation;
    } finally {
      this.#prepares.delete(operation);
    }
  }
  private async prepareOwned(signal: AbortSignal): Promise<DesktopRestoreImportSlot> {
    this.#preparing++;
    try {
      signal.throwIfAborted();
      this.#sessionLease ??= await acquireDesktopRestoreSessionLease(this.profile, signal);
      const protection = await DesktopRestoreProtection.capture(this.profile, signal);
      protection.close();
      const slot = await this.#imports.prepare(signal);
      this.#drafts.set(slot.importId, { controller: new AbortController() });
      return slot;
    } finally {
      this.#preparing--;
      this.releaseLeaseIfIdle();
    }
  }
  async ingest(
    id: string,
    selection: DesktopRestoreFileSelection,
    signal: AbortSignal,
  ): Promise<DesktopRestoreImportResult> {
    const draft = this.draft(id);
    const receipt = await this.#imports.ingest(id, selection, signal);
    draft.receipt = receipt;
    return { kind: "desktopRestoreImport", importId: id, imported: true, bytes: receipt.bytes };
  }
  async preview(
    id: string,
    options: { recoveryCode?: string; recoveryEnvelope?: unknown },
    signal: AbortSignal,
  ): Promise<DesktopRestorePreview> {
    const draft = this.draft(id);
    draft.confirmation = undefined;
    if (!draft.receipt) throw new Error("Select and import the original backup first");
    if (!draft.archive) {
      const result = await this.#imports.unpack(id, {
        ...draft.receipt,
        currentVersion: readPackageVersion(import.meta.url),
        signal,
      });
      draft.archive = result.archive;
      draft.directory = result.directory;
    }
    return this.#imports.withImport<DesktopRestorePreview>(
      id,
      signal,
      async (directory, activeSignal) => {
        const protection = await DesktopRestoreProtection.capture(this.profile, activeSignal);
        try {
          if (!draft.entries)
            draft.entries = new DesktopRestoreEntries(
              draft.archive!,
              protection.key(),
              draft.controller.signal,
              this.profile,
            );
          const entries = draft.entries;
          return await entries.usingSignal<DesktopRestorePreview>(activeSignal, async () => {
            const unlocked = await entries.unlock(options),
              hasRecoveryEnvelope = entries.has(BACKUP_RECOVERY_ENVELOPE_NAME);
            if (unlocked.needsRecoveryCode)
              return {
                kind: "desktopRestorePreview",
                importId: id,
                status: "needs-recovery-code",
                needsRecoveryCode: true,
                hasRecoveryEnvelope,
              };
            rejectUncheckpointedStores(draft.archive!);
            if (!draft.keys)
              draft.keys = await DesktopRestoreStoreKeys.prepare({
                profile: this.profile,
                entries,
                directory: join(directory, "keys"),
                signal: activeSignal,
              });
            const name = entries.has("omnesis.db.enc") ? "omnesis.db.enc" : "omnesis.db";
            const main = await entries.inspectMain(name, {
              sourceKey: draft.keys.source("main-db"),
              sourceCipherPath: join(directory, "preview-main.enc"),
            });
            const auxiliary = await this.inspectAuxiliary(draft, directory, activeSignal);
            const history = await this.inspectHistory(draft, directory, activeSignal);
            activeSignal.throwIfAborted();
            const confirmationId = randomBytes(32).toString("hex");
            draft.confirmation = {
              id: confirmationId,
              protection: protection.identity(),
              expires: Date.now() + 10 * 60_000,
            };
            const manifest = draft.archive!.manifest;
            return {
              kind: "desktopRestorePreview",
              importId: id,
              status: "ready",
              needsRecoveryCode: false,
              hasRecoveryEnvelope,
              confirmationId,
              protection: archiveProtection(draft.archive!),
              createdAt: manifest.finishedAt,
              version: manifest.version,
              includedData: [
                "Documents and library history",
                ...(draft.archive!.manifest.includesConversationHistory
                  ? ["Conversation history (inert until manually opened)"]
                  : []),
                ...(auxiliary.watches !== undefined ? ["Watch history (paused)"] : []),
                ...(auxiliary.analyticsRows !== undefined ? ["Analytics history"] : []),
                "Source settings and backed-up credentials",
                ...([...draft.archive!.files.keys()].some(
                  (name) =>
                    name.replace(/\.enc$/, "") === "OMNESIS.md" || name.startsWith("sweeps/"),
                )
                  ? ["Standing instructions and sweep prose"]
                  : []),
              ],
              consequences: [
                "This Mac's current library data is replaced after a protected recovery copy is created.",
                "This Mac's account, device identities, access policy, certificates, model connections and root key are preserved.",
                "Restored sources, watches, subscriptions, automated notes and background Lab features remain paused for review.",
                "Model connections are kept; model assignments pause until you review them in Settings.",
                "Automatic deletion is paused; review retention settings before enabling it.",
                manifest.includesConversationHistory
                  ? "Backed-up chats replace this Mac's chat history. Summaries are rebuilt; queued submissions and provider sessions are not restored."
                  : "This older backup does not include chat history. This Mac's existing chats are kept.",
                "Review every source path, credential and device assignment before resuming collection. Derived search indexes are rebuilt.",
                "The original selected backup remains where you chose it; readable originals are not encrypted or deleted by this import.",
              ],
              summary: {
                documents: main.documents,
                sources: main.sources,
                ...auxiliary,
                ...history,
              },
              willCreateRecoveryCopy: true,
              willPauseModelRoles: true,
              willPauseAutomaticDeletion: true,
            };
          });
        } finally {
          protection.close();
        }
      },
    );
  }
  async apply(confirmationId: string, signal: AbortSignal): Promise<DesktopRestoreResult> {
    const pair = [...this.#drafts].find(([, draft]) => draft.confirmation?.id === confirmationId);
    if (!pair)
      throw new Error("Preview the selected backup and confirm replacing this library first");
    const [id, draft] = pair,
      confirmation = draft.confirmation!;
    draft.confirmation = undefined;
    if (
      confirmation.expires < Date.now() ||
      !draft.archive ||
      !draft.receipt ||
      !draft.entries ||
      !draft.keys ||
      !draft.directory
    )
      throw new Error("The restore preview expired; preview the backup again");
    const archive = draft.archive,
      entries = draft.entries,
      keys = draft.keys;
    try {
      const result = await this.#imports.withImport(id, signal, async (directory, activeSignal) =>
        entries.usingSignal(activeSignal, () =>
          this.operations.apply(
            this.profile,
            {
              archive,
              entries,
              keys,
              protection: confirmation.protection,
              stagingRoot: directory,
            },
            activeSignal,
          ),
        ),
      );
      return {
        kind: "desktopRestoreResult",
        status: "committed",
        runtimeStopped: true,
        recoveryCopyRetained: true,
        modelRolesPaused: true,
        automaticDeletionPaused: true,
        sourcesPaused: result.sourcesPaused,
        watchesPaused: result.watchesPaused,
      };
    } finally {
      await this.#imports.cancel(id);
    }
  }
  async cancel(id: string): Promise<null> {
    await this.#imports.cancel(id);
    return null;
  }
  async status(): Promise<DesktopRestoreStatus> {
    const intent = await readDesktopRestoreIntent(this.profile);
    if (!intent)
      return {
        kind: "desktopRestoreStatus",
        status: "idle",
        canRecover: false,
        recoveryCopyRetained: false,
      };
    const status =
      intent.phase === "complete"
        ? "complete"
        : intent.phase === "rolled-back"
          ? "rolled-back"
          : intent.phase === "recovery-required"
            ? "recovery-required"
            : "pending";
    return {
      kind: "desktopRestoreStatus",
      status,
      operationId: intent.operationId,
      ...(await readDesktopRestoreReview(this.profile).then(
        (review) => (review ? { review } : {}),
        () => ({}),
      )),
      canRecover: status === "pending" || status === "recovery-required",
      recoveryCopyRetained: intent.backup !== null,
    };
  }
  async recover(operationId: string, signal: AbortSignal): Promise<DesktopRestoreRecoveryResult> {
    for (const id of [...this.#drafts.keys()]) await this.#imports.cancel(id);
    const result = await this.operations.recover(this.profile, operationId, signal);
    return {
      kind: "desktopRestoreResult",
      status: "rolled-back",
      runtimeStopped: true,
      recoveryCopyRetained: result.recoveryCopyRetained,
    };
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    await this.#imports.close();
    await Promise.allSettled([...this.#prepares]);
    for (const id of [...this.#drafts.keys()]) this.releaseDraft(id);
  }
  private draft(id: string): Draft {
    const draft = this.#drafts.get(id);
    if (!draft) throw new Error("Select the backup again before restoring");
    return draft;
  }
  private releaseDraft(id: string): void {
    const draft = this.#drafts.get(id);
    if (!draft) return;
    draft.controller.abort();
    draft.entries?.close();
    draft.keys?.close();
    draft.confirmation = undefined;
    this.#drafts.delete(id);
    this.releaseLeaseIfIdle();
  }
  private releaseLeaseIfIdle(): void {
    if (this.#drafts.size || this.#preparing) return;
    this.#sessionLease?.release();
    this.#sessionLease = undefined;
  }
  private async inspectHistory(
    draft: Draft,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ conversations?: number; messages?: number }> {
    const files = [...draft.archive!.files.keys()].filter((name) =>
      name.startsWith("conversations/"),
    );
    if (!draft.archive!.manifest.includesConversationHistory) {
      if (files.length) throw new Error("The backup has unowned conversation history");
      return {};
    }
    const stage = join(directory, "preview-history");
    await mkdir(stage, { mode: 0o700 });
    let messages = 0;
    try {
      const seen = new Set<string>();
      for (const name of files) {
        signal.throwIfAborted();
        const base = name.replace(/\.enc$/, "");
        if (!/^conversations\/[A-Za-z0-9_-]{1,128}\.json$/u.test(base) || seen.has(base))
          throw new Error("The conversation identity is not portable or is duplicated");
        seen.add(base);
        const result = await draft.entries!.prepareConversation(
          name,
          join(stage, base.slice("conversations/".length)),
        );
        messages += result.messages;
        if (!Number.isSafeInteger(messages))
          throw new Error("The backup conversation history exceeds safe bounds");
      }
      return { conversations: seen.size, messages };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  private async inspectAuxiliary(
    draft: Draft,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ watches?: number; analyticsRows?: number }> {
    const summary: { watches?: number; analyticsRows?: number } = {};
    const stage = join(directory, "preview-auxiliary");
    await mkdir(stage, { mode: 0o700 });
    try {
      for (const spec of [
        { name: WATCH_JOURNAL_FILENAME, kind: "watch", key: "watch2-db" },
        { name: GATEWAY_ANALYTICS_STORE_FILE, kind: "analytics", key: "analytics-db" },
      ] as const) {
        const name = draft.entries!.has(`${spec.name}.enc`) ? `${spec.name}.enc` : spec.name;
        if (!draft.entries!.has(name)) continue;
        const destinationKey = draft.keys!.source(spec.key) ?? draft.keys!.target(spec.key);
        if (!destinationKey)
          throw new Error("The backup requires an encrypted auxiliary store key");
        const result = await draft.entries!.prepareAuxiliary(name, {
          kind: spec.kind,
          sourceKey: draft.keys!.source(spec.key),
          sourceCipherPath: join(stage, `${spec.kind}-source.enc`),
          destinationPath: join(stage, spec.name),
          destinationKey,
        });
        if (spec.kind === "watch") summary.watches = result.watchesPaused;
        else summary.analyticsRows = result.rowsPreserved;
        signal.throwIfAborted();
      }
      return summary;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
function rejectUncheckpointedStores(archive: DesktopBackupArchive): void {
  for (const name of ["omnesis.db", WATCH_JOURNAL_FILENAME, GATEWAY_ANALYTICS_STORE_FILE])
    for (const suffix of STORE_COMPANION_SUFFIXES) {
      const rel = `${name}${suffix}`;
      if ((archive.files.get(rel) ?? archive.files.get(`${rel}.enc`) ?? 0) > 0)
        throw new Error(
          "This backup contains an uncheckpointed database sidecar; create a completed online backup before restoring it",
        );
    }
}
function archiveProtection(
  archive: DesktopBackupArchive,
): "encrypted-payloads" | "plaintext" | "mixed" {
  const payload = archive.manifest.files.filter(
    (file) => !file.name.includes("backup-manifest") && file.name !== BACKUP_RECOVERY_ENVELOPE_NAME,
  );
  const encrypted = payload.filter((file) => file.encrypted === true).length;
  return encrypted === 0
    ? "plaintext"
    : encrypted === payload.length
      ? "encrypted-payloads"
      : "mixed";
}
