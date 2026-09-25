// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotifyRunner, type NotifyRunResult } from "./notify-runner.js";
import type { DeviceId, DeviceRecord } from "@omnesis/types";
import type { NotificationPublisher } from "../push/broadcast.js";

export class PushTransport {
  private readonly runner: NotifyRunner;

  constructor(private readonly publisher: NotificationPublisher) {
    this.runner = new NotifyRunner(publisher);
  }

  /** Kept while the legacy APNs status route remains an alias. */
  setApnsClient(_client?: unknown): void {}

  isConfigured(): boolean {
    return true;
  }

  current(): NotifyRunner {
    return this.runner;
  }

  isDeviceAvailable(device: DeviceRecord): boolean {
    if (this.publisher.isAvailable) return this.publisher.isAvailable(device);
    return (
      device.apnsRegistration !== null ||
      device.fcmRegistration !== null ||
      device.pushTransport !== null
    );
  }

  async sendTest(targetDeviceIds?: readonly DeviceId[]): Promise<NotifyRunResult> {
    return this.runner.runMessage(
      {
        kind: "diagnostic",
        title: "Omnesis",
        body: "Test notification from your gateway.",
        data: {},
        collapseId: "push-test",
      },
      targetDeviceIds,
    );
  }
}
