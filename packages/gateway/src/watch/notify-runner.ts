// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DeviceId } from "@omnesis/types";
import type { NotificationMessage } from "@omnesis/core/push";
import type { NotificationPublisher } from "../push/broadcast.js";

const NOTIFY_OUTPUT_TAIL_BYTES = 16 * 1024;

export interface NotifyRunOptions {
  watchId: string;
  watchName: string;
  firingKey: string;
  firingId?: string;
  title: string;
  body: string;
  collapseId?: string;
  /**
   * The conversation the agent opened about this firing, where it opened one.
   *
   * What a tap should reach: the thread whose opening sentence the banner is
   * quoting. Absent on a gateway with no agent and on a firing whose thread
   * could not be written, where the tap lands on the firing's ledger line.
   */
  conversationId?: string;
}

export interface NotifyRunResult {
  status: "ok" | "exit-non-zero" | "spawn-error" | "skipped";
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
  attempted: number;
  delivered: number;
}

export class NotifyRunner {
  constructor(private readonly publisher: NotificationPublisher) {}

  async run(
    input: NotifyRunOptions,
    targetDeviceIds?: readonly DeviceId[],
  ): Promise<NotifyRunResult> {
    return this.runMessage(
      {
        kind: "watch",
        title: input.title,
        body: input.body,
        data: {
          watchId: input.watchId,
          firingKey: input.firingKey,
          ...(input.firingId === undefined ? {} : { firingId: input.firingId }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        },
        collapseId: input.collapseId ?? `watch:${input.watchId}:${input.firingKey}`,
      },
      targetDeviceIds,
    );
  }

  async runMessage(
    message: NotificationMessage,
    targetDeviceIds?: readonly DeviceId[],
  ): Promise<NotifyRunResult> {
    const startMs = Date.now();
    try {
      const results = targetDeviceIds
        ? await this.publisher.publish(message, targetDeviceIds)
        : await this.publisher.publish(message);
      if (results.length === 0) {
        return {
          status: "skipped",
          exitCode: null,
          durationMs: Date.now() - startMs,
          stdoutTail: "",
          stderrTail: "",
          error: "no paired phone is available for notifications",
          attempted: 0,
          delivered: 0,
        };
      }
      const delivered = results.filter((result) => result.ok).length;
      const failures = results.filter((result) => !result.ok);
      const stdoutTail = clipTail(`Wake accepted by ${delivered}/${results.length} device(s).`);
      const stderrTail = clipTail(
        failures
          .map((failure) => `[${failure.deviceId}] ${failure.transport}: ${failure.reason}`)
          .join("\n"),
      );
      if (failures.length === 0) {
        return {
          status: "ok",
          exitCode: 0,
          durationMs: Date.now() - startMs,
          stdoutTail,
          stderrTail: "",
          error: null,
          attempted: results.length,
          delivered,
        };
      }
      return {
        status: "exit-non-zero",
        exitCode: 1,
        durationMs: Date.now() - startMs,
        stdoutTail,
        stderrTail,
        error:
          delivered === 0
            ? `notification wake failed for all ${results.length} device(s)`
            : `notification wake failed for ${failures.length}/${results.length} device(s)`,
        attempted: results.length,
        delivered,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "spawn-error",
        exitCode: null,
        durationMs: Date.now() - startMs,
        stdoutTail: "",
        stderrTail: reason,
        error: reason,
        attempted: 0,
        delivered: 0,
      };
    }
  }
}

function clipTail(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= NOTIFY_OUTPUT_TAIL_BYTES) return value;
  return value.slice(0, NOTIFY_OUTPUT_TAIL_BYTES);
}
