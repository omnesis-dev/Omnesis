// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DesktopCodeCleanup, type DesktopCodeCleanupSummary } from "./code-cleanup.js";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";
import { readCurrentDesktopMetadata, readDesktopActiveRuntime } from "./update-active.js";
import { desktopUpdateConfirmation, handoffDesktopUpdate } from "./update-handoff.js";
import {
  desktopInstallerAction,
  requestDesktopInstallerReceipt,
  type DesktopInstallerReceipt,
} from "./update-native.js";
import { observeDesktopUpdate } from "./update-observation.js";
import {
  planDesktopCurrentApplicationReplacement,
  planDesktopUpdate,
  type DesktopUpdateMetadata,
} from "./update-plan.js";
import {
  retainDesktopUpdateBeforeReplacement,
  registerVerifiedDesktopSnapshot,
} from "./snapshot-retention.js";
import { recoverDesktopUpdate } from "./update-recovery.js";
import { runDesktopUpdateDataOperation } from "./update-data-operation.js";
import {
  discoverDesktopUpdate,
  downloadDesktopUpdate,
  type DesktopUpdateRelease,
} from "./update-release.js";
import {
  desktopRuntimeEpoch,
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import type { DesktopProtocolContext } from "./protocol.js";
import type { DesktopProfile } from "./environment.js";

export type DesktopUpdateCommand =
  | "updateStatus"
  | "updateCheck"
  | "updateDownload"
  | "updatePrepareCurrent"
  | "updateInstall"
  | "updateResume"
  | "updateRestore"
  | "updateFinish"
  | "updateCleanupPreview"
  | "updateCleanup";
export interface DesktopUpdateResult {
  kind: "desktopUpdate";
  phase: "idle" | "available" | DesktopUpdateState["phase"];
  currentVersion: string;
  targetVersion?: string;
  message: string;
  confirmationId?: string;
  currentApplicationAvailable?: true;
  codeCleanup?: DesktopCodeCleanupSummary;
}
interface UpdateOperations {
  dataOperation: typeof runDesktopUpdateDataOperation;
  metadata: typeof readCurrentDesktopMetadata;
  epoch: typeof desktopRuntimeEpoch;
  discover: typeof discoverDesktopUpdate;
  download: typeof downloadDesktopUpdate;
  observe: typeof observeDesktopUpdate;
  closeTransport(): Promise<void>;
  startCurrent(signal: AbortSignal): Promise<void>;
  ready(signal: AbortSignal): Promise<{ phase: string; encrypted?: boolean }>;
}
const confirmation = z.object({ confirmationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Portable update policy and durable transitions; native callbacks assess/open sealed applications. */
export class DesktopUpdateController {
  private available:
    { release: DesktopUpdateRelease; epoch: string; confirmationId: string } | undefined;
  private receipt: { operationId: string; receipt: DesktopInstallerReceipt } | undefined;
  private readonly deps: UpdateOperations;
  constructor(
    private readonly profile: DesktopProfile,
    operations: Pick<UpdateOperations, "closeTransport" | "startCurrent" | "ready"> &
      Partial<UpdateOperations>,
  ) {
    this.deps = {
      dataOperation: runDesktopUpdateDataOperation,
      metadata: readCurrentDesktopMetadata,
      epoch: desktopRuntimeEpoch,
      discover: discoverDesktopUpdate,
      download: downloadDesktopUpdate,
      observe: observeDesktopUpdate,
      ...operations,
    };
  }
  close(): void {
    this.available = undefined;
    this.receipt = undefined;
  }

  async handle(
    command: DesktopUpdateCommand,
    params: unknown,
    context: DesktopProtocolContext,
  ): Promise<DesktopUpdateResult> {
    context.signal.throwIfAborted();
    if (command === "updateCleanupPreview" || command === "updateCleanup") {
      return new DesktopCodeCleanup(this.profile, {
        ready: this.deps.ready,
        epoch: this.deps.epoch,
      }).handle(command, params, context.signal);
    }
    if (["updateStatus", "updateCheck", "updatePrepareCurrent"].includes(command))
      z.object({})
        .strict()
        .parse(params ?? {});
    if (command === "updateStatus") return this.status();
    if (command === "updateCheck") return this.check(context.signal);
    if (command === "updatePrepareCurrent") return this.prepareCurrent(context);
    const input = confirmation.parse(params);
    if (command === "updateDownload") return this.download(input.confirmationId, context);
    if (command === "updateInstall") return this.install(input.confirmationId, context);
    if (command === "updateResume" || command === "updateRestore") {
      await this.deps.closeTransport();
      const state = await recoverDesktopUpdate(
        this.profile,
        { ...input, signal: context.signal },
        {
          executeRollback: (profile, id, signal) =>
            this.deps.dataOperation(profile, id, "update-rollback", signal),
          verifyPrevious: (state) =>
            desktopInstallerAction(
              context,
              "verifyPreviousDesktopApplication",
              this.previousPayload(state),
              "verified",
            ),
          openPrevious: (state) =>
            desktopInstallerAction(
              context,
              "openPreviousDesktopApplication",
              this.previousPayload(state),
              "opened",
            ),
        },
      );
      return this.result(state);
    }
    return this.finish(input.confirmationId, context.signal);
  }

  private async current() {
    const metadata = await this.deps.metadata(),
      epoch = this.deps.epoch();
    if (!epoch) throw new Error("Application updates require the complete packaged Omnesis app");
    const active = await readDesktopActiveRuntime(this.profile);
    if (!active) throw new Error("Start this library once before preparing an application update");
    return { metadata, epoch, active };
  }
  private async status(): Promise<DesktopUpdateResult> {
    const state = await readDesktopUpdateState(this.profile);
    const selected = await this.current();
    const manual =
      selected.epoch !== selected.active.epoch
        ? { currentApplicationAvailable: true as const }
        : {};
    if (state && (!this.available || !["complete", "resumed"].includes(state.phase)))
      return { ...this.result(state), ...manual };
    const { metadata } = selected;
    if (this.available)
      return {
        kind: "desktopUpdate",
        phase: "available",
        currentVersion: metadata.productVersion,
        targetVersion: this.available.release.version,
        confirmationId: this.available.confirmationId,
        message: "A newer verified-release installer is available to download.",
      };
    return {
      kind: "desktopUpdate",
      phase: "idle",
      currentVersion: metadata.productVersion,
      message: "Check for an Omnesis application update.",
      ...manual,
    };
  }
  private async check(signal: AbortSignal): Promise<DesktopUpdateResult> {
    await assertDesktopMutationAllowed(this.profile, this.deps.epoch());
    const { metadata, epoch, active } = await this.current();
    if (active.epoch !== epoch)
      throw new Error(
        "Prepare the application already installed on this Mac before checking releases",
      );
    const previous = await readDesktopUpdateState(this.profile);
    if (previous && !["complete", "resumed"].includes(previous.phase)) return this.result(previous);
    const release = await this.deps.discover(
      metadata.productVersion,
      metadata.architecture,
      signal,
    );
    this.available = release
      ? {
          release,
          epoch,
          confirmationId: createHash("sha256")
            .update(JSON.stringify({ release, epoch }))
            .digest("hex"),
        }
      : undefined;
    return this.status();
  }

  private async download(
    id: string,
    context: DesktopProtocolContext,
  ): Promise<DesktopUpdateResult> {
    const selected = this.available;
    if (!selected || selected.confirmationId !== id)
      throw new Error("Review the available application update again");
    await withDesktopInstallLease(this.profile, context.signal, async () => {
      await assertDesktopMutationAllowed(this.profile, this.deps.epoch());
      const current = await this.current();
      if (current.epoch !== selected.epoch || current.active.epoch !== selected.epoch)
        throw new Error("The active application changed before downloading");
      try {
        await mkdir(join(`${this.profile.configDir}.bootstrap`, "updates"), { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    });
    let notified = 0,
      time = 0;
    const artifactPath = await this.deps.download(
      selected.release,
      join(`${this.profile.configDir}.bootstrap`, "updates"),
      context.signal,
      {
        progress: async (bytes, totalBytes) => {
          if (bytes !== totalBytes && bytes - notified < 16 * 1024 ** 2 && Date.now() - time < 500)
            return;
          notified = bytes;
          time = Date.now();
          await context.interactions.ask(
            "desktopUpdateProgress",
            { bytes, totalBytes },
            (value) => z.literal("continue").parse(value),
            context.signal,
          );
        },
      },
    );
    const receipt = await requestDesktopInstallerReceipt(context, "verifyDesktopInstaller", {
      artifactPath,
      artifactSha256: selected.release.sha256,
      version: selected.release.version,
      architecture: selected.release.architecture,
      oldEpoch: selected.epoch,
    });
    return this.prepare(receipt, selected.release, context);
  }

  private async prepareCurrent(context: DesktopProtocolContext): Promise<DesktopUpdateResult> {
    const current = await this.current();
    if (current.active.epoch === current.epoch)
      throw new Error("This application's runtime is already active");
    const receipt = await requestDesktopInstallerReceipt(
      context,
      "verifyCurrentDesktopApplication",
      {},
    );
    if (
      !receipt.previousMetadata ||
      receipt.oldEpoch !== current.active.epoch ||
      receipt.candidateEpoch !== current.epoch ||
      receipt.metadata.productVersion !== current.metadata.productVersion ||
      receipt.previousMetadata.productVersion !== current.active.productVersion
    )
      throw new Error("The current and retained application identities do not match this library");
    return this.prepare(receipt, null, context);
  }

  private async prepare(
    receipt: DesktopInstallerReceipt,
    release: DesktopUpdateRelease | null,
    context: DesktopProtocolContext,
  ): Promise<DesktopUpdateResult> {
    const reviewed = await this.current();
    const measuredRoot = await desktopRootIdentity(this.profile);
    if (!measuredRoot) throw new Error("The managed installation is unavailable");
    const oldMetadata: DesktopUpdateMetadata = release
      ? reviewed.metadata
      : receipt.previousMetadata!;
    const observed = await this.deps.observe(this.profile, oldMetadata, context.signal);
    return withDesktopInstallLease(this.profile, context.signal, async () => {
      if (
        (await readDesktopRetirement(this.profile)) ||
        (await desktopRestoreBlocked(this.profile))
      )
        throw new Error(
          "Finish the pending removal or restore before preparing an application update",
        );
      const current = await this.current();
      const prior = await readDesktopUpdateState(this.profile);
      if (prior && !["verified", "complete", "resumed"].includes(prior.phase))
        throw new Error("Finish the pending update recovery first");
      await retainDesktopUpdateBeforeReplacement(this.profile, prior, context.signal);
      if (release && current.active.epoch !== current.epoch)
        throw new Error("The active application changed");
      if (
        current.active.epoch !== reviewed.active.epoch ||
        current.epoch !== reviewed.epoch ||
        !sameDesktopRoot(await desktopRootIdentity(this.profile), measuredRoot)
      )
        throw new Error("The managed library changed during update preparation");
      const measures = {
        current: oldMetadata,
        candidate: receipt.metadata,
        ...observed,
        payloadBytes: receipt.payloadBytes,
        applicationBytes: receipt.applicationBytes,
        oldApplicationBytes: receipt.oldApplicationBytes,
      };
      if (release) planDesktopUpdate({ ...measures, release });
      else
        planDesktopCurrentApplicationReplacement({
          ...measures,
          oldEpoch: current.active.epoch,
          candidateEpoch: receipt.candidateEpoch,
        });
      const install = await readDesktopInstall(this.profile),
        root = await desktopRootIdentity(this.profile);
      if (!install || !root) throw new Error("The managed installation is unavailable");
      const state: DesktopUpdateState = {
        format: 1,
        owner: "omnesis-desktop",
        instance: this.profile.instance,
        secretService: this.profile.secretService,
        operationId: randomUUID(),
        phase: "verified",
        mode: install.mode,
        source: release ? "official-release" : "current-application",
        oldEpoch: current.active.epoch,
        candidateEpoch: receipt.candidateEpoch,
        oldVersion: oldMetadata.productVersion,
        candidateVersion: receipt.metadata.productVersion,
        artifactSha256: release?.sha256 ?? receipt.candidateEpoch,
        root,
        backup: null,
      };
      await desktopInstallerAction(
        context,
        release ? "stageDesktopInstaller" : "stageCurrentDesktopApplication",
        this.receiptPayload(state, receipt),
        "ready",
      );
      context.signal.throwIfAborted();
      if (!sameDesktopRoot(await desktopRootIdentity(this.profile), root))
        throw new Error("The managed library changed while staging code");
      await writeDesktopUpdateState(this.profile, state);
      this.receipt = { operationId: state.operationId, receipt };
      return this.result(state);
    });
  }

  private async install(id: string, context: DesktopProtocolContext): Promise<DesktopUpdateResult> {
    const state = await readDesktopUpdateState(this.profile);
    if (!state || desktopUpdateConfirmation(state) !== id)
      throw new Error("Review the prepared update again");
    let receipt =
      this.receipt?.operationId === state.operationId ? this.receipt.receipt : undefined;
    if (!receipt) {
      receipt = await requestDesktopInstallerReceipt(
        context,
        state.source === "current-application"
          ? "verifyCurrentDesktopApplication"
          : "verifyDesktopInstaller",
        state.source === "current-application"
          ? {}
          : {
              artifactPath: join(
                `${this.profile.configDir}.bootstrap`,
                "updates",
                `${state.artifactSha256}.dmg`,
              ),
              artifactSha256: state.artifactSha256,
              oldEpoch: state.oldEpoch,
              version: state.candidateVersion,
              architecture: (await this.deps.metadata()).architecture,
            },
      );
      if (receipt.candidateEpoch !== state.candidateEpoch)
        throw new Error("The prepared application changed");
    }
    await this.deps.closeTransport();
    const prepared = receipt;
    const result = await handoffDesktopUpdate(
      this.profile,
      { confirmationId: id, currentEpoch: state.oldEpoch, signal: context.signal },
      {
        executeSnapshot: (profile, id, signal) =>
          this.deps.dataOperation(profile, id, "update-snapshot", signal),
        openInstaller: (record) =>
          desktopInstallerAction(
            context,
            state.source === "current-application"
              ? "activateCurrentDesktopApplication"
              : "openDesktopInstaller",
            this.receiptPayload(record, prepared),
            "opened",
          ),
      },
    );
    if (state.source === "current-application") await this.deps.startCurrent(context.signal);
    return this.result(result);
  }
  private async finish(id: string, signal: AbortSignal): Promise<DesktopUpdateResult> {
    await this.deps.observe(this.profile, await this.deps.metadata(), signal);
    const ready = await this.deps.ready(signal);
    if (ready.phase !== "ready" || ready.encrypted !== true)
      throw new Error(
        "The new application must prove a ready protected library before completing the update",
      );
    return withDesktopInstallLease(this.profile, signal, async () => {
      if (
        (await readDesktopRetirement(this.profile)) ||
        (await desktopRestoreBlocked(this.profile))
      )
        throw new Error("The installation entered removal or restore before update completion");
      const state = await readDesktopUpdateState(this.profile),
        active = await readDesktopActiveRuntime(this.profile);
      if (
        !state ||
        desktopUpdateConfirmation(state) !== id ||
        state.phase !== "candidate-started" ||
        this.deps.epoch() !== state.candidateEpoch ||
        active?.epoch !== state.candidateEpoch
      )
        throw new Error("The replacement application has not claimed and opened this library");
      if (!state.backup || !sameDesktopRoot(await desktopRootIdentity(this.profile), state.root))
        throw new Error("The replacement library or its recovery snapshot is unavailable");
      const complete = { ...state, phase: "complete" as const };
      await registerVerifiedDesktopSnapshot(this.profile, complete, signal);
      signal.throwIfAborted();
      await writeDesktopUpdateState(this.profile, complete);
      return this.result(complete);
    });
  }
  private receiptPayload(state: DesktopUpdateState, receipt: DesktopInstallerReceipt) {
    return {
      receiptId: receipt.receiptId,
      oldEpoch: state.oldEpoch,
      candidateEpoch: state.candidateEpoch,
      artifactSha256: state.artifactSha256,
    };
  }
  private previousPayload(state: DesktopUpdateState) {
    return { oldEpoch: state.oldEpoch, expectedVersion: state.oldVersion };
  }
  private result(state: DesktopUpdateState): DesktopUpdateResult {
    return {
      kind: "desktopUpdate",
      phase: state.phase,
      currentVersion: state.oldVersion,
      targetVersion: state.candidateVersion,
      confirmationId: desktopUpdateConfirmation(state),
      message:
        state.phase === "complete"
          ? "The new application opened your protected library. Its verified recovery snapshot is retained. Restoring it replaces changes collected since the update."
          : state.phase === "verified"
            ? "The application is verified. Installing stops collection and creates a recovery snapshot before opening replacement code."
            : state.phase === "resumed"
              ? "The previous application can use its recovered library."
              : "This update has reserved the library. Finish installation or explicitly recover the previous application and backup.",
    };
  }
}
