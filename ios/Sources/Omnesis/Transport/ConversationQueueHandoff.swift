// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Send-now transfers these exact receipts out of the queue presentation before
/// SSE delivers their transcript message. Keep the server snapshot untouched:
/// failures restore the queue, and new receipts (even identical text) stay visible.
struct ConversationQueueHandoff {
    private var transferring: Set<String> = []

    mutating func begin(ids: [String]) -> Set<String> {
        let added = Set(ids).subtracting(transferring)
        transferring.formUnion(ids)
        return added
    }

    mutating func failed(_ attempt: Set<String>) {
        transferring.subtract(attempt)
    }

    func presenting(_ controls: ConversationControls) -> ConversationControls {
        ConversationControls(
            busy: controls.busy,
            pendingClarification: controls.pendingClarification,
            queuedMessages: controls.queuedMessages.filter { $0.status != "queued" || !transferring.contains($0.id) },
            capabilities: controls.capabilities
        )
    }
}
