// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { NotificationPublisher } from "../push/broadcast.js";

const log = createLogger("gateway:privacy:push");

export class PrivacyApprovalNotifier {
  constructor(private readonly publisher: NotificationPublisher) {}

  async notify(approvalId: string): Promise<void> {
    const results = await this.publisher.publish({
      kind: "privacy-approval",
      title: "Privacy review needed",
      body: "Open Omnesis to review a response.",
      data: { approvalId },
      collapseId: `privacy:${approvalId}`,
    });
    log.info(
      `privacy approval ${approvalId}: wake accepted by ${results.filter((result) => result.ok).length}/${results.length} device(s)`,
    );
  }
}
